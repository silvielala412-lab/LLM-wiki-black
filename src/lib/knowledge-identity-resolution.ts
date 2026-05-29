/**
 * knowledge-identity-resolution.ts
 *
 * LLM Identity Pass — detects cross-document entity identity collisions.
 *
 * Four phases (parallel to knowledge-global-relation.ts):
 *   Phase 1  buildIdentityCatalog()       — read all wiki/entities/*.md
 *   Phase 2  generateIdentityCandidates() — rule-based N-reduction (not N²)
 *   Phase 3  llmJudgeIdentityPairs()      — LLM batch classification
 *   Phase 4  applyIdentityJudgments()     — merge / alias-edge / sibling-edge
 *
 * Identity judgment types:
 *   same_entity   — confirmed duplicate → merge (postprocess dedup path)
 *   alias_of      — different names, same real service → alias_of relation edge
 *   sibling_of    — same family, different sub-service → sibling_of relation edge
 *   parent_child  — one contains the other → has_part / part_of edge
 *   distinct      — genuinely different → no action
 *
 * Discriminator protection: pairs where both entities share discriminator words
 * (门诊/住院/首访/随访) are never sent to LLM as same_entity candidates.
 *
 * Provenance of written edges: "identity_inferred" (scored 0.75).
 */

import { listDirectory, readFile, writeFile } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import {
  canonicalServiceIdentityName,
  inferStableInsuranceDedupKey,
} from "@/lib/insurance-schema-registry"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdentityEntry {
  title: string
  canonicalTitle: string
  dedupKey: string
  entityType: string
  summary: string
  serviceScene: string
  serviceStage: string
  sourceFiles: string[]
  filePath: string
  /** Existing relation targets — prevents creating duplicate edges. */
  existingTargets: Set<string>
}

export type IdentityVerdict =
  | "same_entity"
  | "alias_of"
  | "sibling_of"
  | "parent_child"
  | "distinct"

export interface IdentityJudgment {
  title_a: string
  title_b: string
  verdict: IdentityVerdict
  /** a_is_parent means A contains B (has_part/part_of direction). */
  direction?: "a_is_parent" | "b_is_parent"
  confidence: number
  reason: string
  evidence: string
}

export interface IdentityPassResult {
  catalogSize: number
  candidatePairs: number
  llmCallCount: number
  merged: number
  aliasEdges: number
  siblingEdges: number
  parentChildEdges: number
  discarded: number
  errors: string[]
}

export interface IdentityPassOptions {
  /** Only consider pairs involving at least one of these titles. */
  newEntityTitles?: ReadonlySet<string>
  /** Minimum confidence to act on a judgment. Default: 0.82 */
  writeThreshold?: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 15
const WRITE_THRESHOLD = 0.82
const DISCARD_THRESHOLD = 0.65

/**
 * Words that discriminate between sibling services.
 * If both titles share the same discriminator, they MAY be the same entity.
 * If they have DIFFERENT discriminators, they are siblings — never merge.
 */
const DISCRIMINATORS: string[] = [
  "门诊", "住院", "急诊", "手术", "术后",
  "首访", "随访", "问诊", "康复", "安置",
  "国内", "海外", "境外", "基础", "高级",
  "解读", "训练", "护理", "陪诊",
]

function extractDiscriminators(title: string): string[] {
  return DISCRIMINATORS.filter(d => title.includes(d))
}

/** Returns true if a and b have incompatible discriminators (sibling services). */
function hasSiblingDiscriminators(a: string, b: string): boolean {
  const da = new Set(extractDiscriminators(a))
  const db = new Set(extractDiscriminators(b))
  if (da.size === 0 && db.size === 0) return false
  // Any discriminator present in one but not the other = sibling
  for (const d of da) { if (!db.has(d)) return true }
  for (const d of db) { if (!da.has(d)) return true }
  return false
}

// ─── Phase 1: Build Identity Catalog ─────────────────────────────────────────

export async function buildIdentityCatalog(
  projectPath: string,
): Promise<IdentityEntry[]> {
  const catalog: IdentityEntry[] = []
  const dirs = [
    `${projectPath}/wiki/entities`,
    `${projectPath}/wiki/concepts`,
  ]

  for (const dir of dirs) {
    let files: { name: string; is_dir?: boolean }[] = []
    try { files = await listDirectory(dir) } catch { continue }

    for (const file of files) {
      if (file.is_dir || !file.name.endsWith(".md") || file.name.endsWith(".md.md")) continue
      const filePath = `${dir}/${file.name}`
      try {
        const content = await readFile(filePath)
        const entry = parseIdentityEntry(content, filePath)
        if (entry) catalog.push(entry)
      } catch { /* skip unreadable */ }
    }
  }
  return catalog
}

function parseIdentityEntry(content: string, filePath: string): IdentityEntry | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  if (!fm) return null

  const title = scalar(fm, "title")
  if (!title) return null

  const entityType = scalar(fm, "entity_type")
  const summary = scalar(fm, "summary")
  const domain = scalar(fm, "knowledge_domain") || scalar(fm, "domain")

  // Attributes — JSON inline or YAML block
  let attrs: Record<string, string> = {}
  const attrsRaw = scalar(fm, "attributes")
  if (attrsRaw) {
    try { attrs = JSON.parse(attrsRaw) } catch { /* yaml fallback */ }
  }
  if (!attrs.service_scene) {
    attrs.service_scene  = scalarBlock(fm, "service_scene")  || ""
    attrs.service_stage  = scalarBlock(fm, "service_stage")  || ""
  }

  // Existing relation targets (both compact-list and YAML-block formats)
  const existingTargets = new Set<string>()
  const relBlock = fm.match(/^relations:\s*\n((?:[ \t]+-[ \t]+.+(?:\r?\n)?)*)/m)?.[1] ?? ""
  for (const line of relBlock.split(/\r?\n/)) {
    const m = line.match(/^[ \t]+-[ \t]+"?[a-z_]+:\s*([^"\r\n]+"?)\s*$/i)
    if (m) existingTargets.add(m[1].replace(/^"|"$/g, "").trim())
  }
  const edgeBlock = fm.match(/^relation_edges:[ \t]*\n((?:[ \t]+.*(?:\r?\n)?)*)/m)?.[1] ?? ""
  for (const m of edgeBlock.matchAll(/^[ \t]+-?[ \t]*target:[ \t]*"?([^"\r\n]+)"?/gm)) {
    existingTargets.add(m[1].trim())
  }

  // source_files
  const sfMatch = fm.match(/^source_files:\s*\[([^\]]*)\]/m)
  const sourceFiles = sfMatch
    ? sfMatch[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
    : []

  const canonicalTitle = canonicalServiceIdentityName(title)
  const dedupKey = inferStableInsuranceDedupKey({
    entityType: entityType || "general",
    title: canonicalTitle,
    attributes: attrs,
    fallback: filePath,
  })

  return {
    title,
    canonicalTitle,
    dedupKey,
    entityType: entityType || "",
    summary: summary || "",
    serviceScene: String(attrs.service_scene ?? ""),
    serviceStage: String(attrs.service_stage ?? ""),
    sourceFiles,
    filePath,
    existingTargets,
  }
}

// ─── Phase 2: Generate Identity Candidate Pairs ───────────────────────────────
//
// Rules:
//   R1  Same canonical dedup_key (strongest signal — likely same entity)
//   R2  Same canonical title (after brand-suffix stripping)
//   R3  Very similar canonical title (one is prefix/suffix of the other)
//   R4  Same source_file + same entity_type (co-occurrence)
//   R5  Island node × same entity_type in same domain
//
// Discriminator guard: if titles have incompatible discriminators → skip R1-R3.

const MAX_PER_ENTITY = 6

export function generateIdentityCandidates(
  catalog: IdentityEntry[],
  newEntityTitles?: ReadonlySet<string>,
): Array<{ a: IdentityEntry; b: IdentityEntry; reasons: string[] }> {
  type Pair = { a: IdentityEntry; b: IdentityEntry; reasons: string[] }

  const seen = new Set<string>()
  const pairs: Pair[] = []
  const countMap = new Map<string, number>()

  function count(t: string) { return countMap.get(t) ?? 0 }
  function inc(a: string, b: string) {
    countMap.set(a, count(a) + 1)
    countMap.set(b, count(b) + 1)
  }

  function tryAdd(a: IdentityEntry, b: IdentityEntry, reason: string) {
    if (a.title === b.title) return
    if (newEntityTitles && newEntityTitles.size > 0) {
      if (!newEntityTitles.has(a.title) && !newEntityTitles.has(b.title)) return
    }
    if (count(a.title) >= MAX_PER_ENTITY || count(b.title) >= MAX_PER_ENTITY) return
    const key = [a.title, b.title].sort().join("|||")
    if (seen.has(key)) {
      const ex = pairs.find(p => [p.a.title, p.b.title].sort().join("|||") === key)
      if (ex && !ex.reasons.includes(reason)) ex.reasons.push(reason)
      return
    }
    seen.add(key)
    pairs.push({ a, b, reasons: [reason] })
    inc(a.title, b.title)
  }

  // R1: same dedup_key
  const byDedup = new Map<string, IdentityEntry[]>()
  for (const e of catalog) {
    if (!e.dedupKey) continue
    const bucket = byDedup.get(e.dedupKey) ?? []
    bucket.push(e)
    byDedup.set(e.dedupKey, bucket)
  }
  for (const group of byDedup.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        tryAdd(group[i], group[j], "R1:same_dedup_key")
      }
    }
  }

  // R2: same canonical title
  const byCanon = new Map<string, IdentityEntry[]>()
  for (const e of catalog) {
    if (!e.canonicalTitle) continue
    const bucket = byCanon.get(e.canonicalTitle) ?? []
    bucket.push(e)
    byCanon.set(e.canonicalTitle, bucket)
  }
  for (const group of byCanon.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!hasSiblingDiscriminators(group[i].title, group[j].title)) {
          tryAdd(group[i], group[j], "R2:same_canonical_title")
        }
      }
    }
  }

  // R3: one canonical title is a prefix/suffix of the other (min 4 chars)
  const candidates = catalog.filter(e =>
    ["service_benefit", "service_plan", "product", "process"].includes(e.entityType) || !e.entityType
  )
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j]
      if (hasSiblingDiscriminators(a.canonicalTitle, b.canonicalTitle)) continue
      const ca = a.canonicalTitle, cb = b.canonicalTitle
      if (ca.length < 4 || cb.length < 4) continue
      if ((ca.startsWith(cb) || cb.startsWith(ca) || ca.endsWith(cb) || cb.endsWith(ca))
          && Math.abs(ca.length - cb.length) <= 6) {
        tryAdd(a, b, "R3:title_prefix_suffix")
      }
    }
  }

  // R4: same source_file + same entity_type
  const bySource = new Map<string, IdentityEntry[]>()
  for (const e of catalog) {
    for (const sf of e.sourceFiles) {
      const key = `${sf}::${e.entityType}`
      const bucket = bySource.get(key) ?? []
      bucket.push(e)
      bySource.set(key, bucket)
    }
  }
  for (const group of bySource.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (hasSiblingDiscriminators(group[i].canonicalTitle, group[j].canonicalTitle)) continue
        tryAdd(group[i], group[j], "R4:same_source_entity_type")
      }
    }
  }

  return pairs
}

// ─── Phase 3: LLM Batch Judgment ─────────────────────────────────────────────

function buildIdentityPrompt(
  pairs: Array<{ a: IdentityEntry; b: IdentityEntry; reasons: string[] }>,
): string {
  const desc = pairs.map((pair, i) => {
    const { a, b } = pair
    return [
      `Pair ${i + 1}:`,
      `  A: title="${a.title}" canonical="${a.canonicalTitle}" entity_type="${a.entityType}" service_scene="${a.serviceScene}" summary="${a.summary.slice(0, 100)}"`,
      `  B: title="${b.title}" canonical="${b.canonicalTitle}" entity_type="${b.entityType}" service_scene="${b.serviceScene}" summary="${b.summary.slice(0, 100)}"`,
      `  candidate_rules: ${pair.reasons.join("; ")}`,
    ].join("\n")
  }).join("\n\n")

  return [
    "You are an expert knowledge graph identity resolver for an insurance service knowledge base.",
    "For each entity pair, classify their identity relationship.",
    "",
    "VERDICT options (choose exactly one per pair):",
    "  same_entity   — Both refer to the EXACT same real-world service/concept.",
    "                  They should be merged into one entity page.",
    "                  ONLY use this if you are highly confident. Prefer alias_of when unsure.",
    "  alias_of      — Different names, same underlying service.",
    "                  Keep both pages, add alias_of edge.",
    "  sibling_of    — Same service family, but distinct variants",
    "                  (e.g. 门诊 vs 住院 versions of the same service).",
    "                  Keep both, add sibling_of edge.",
    "  parent_child  — One entity contains the other (A has B as a sub-service).",
    "                  Add has_part / part_of edges. Set direction: a_is_parent or b_is_parent.",
    "  distinct      — Genuinely different entities. No action needed.",
    "",
    "RULES:",
    "  1. If entities have DIFFERENT discriminator words (门诊 vs 住院, 首访 vs 随访), verdict MUST be sibling_of or distinct.",
    "  2. Brand suffix differences alone (臻享家医, 平安健康) are NOT enough for distinct — consider alias_of.",
    "  3. same_entity requires confidence >= 0.90. Do NOT use same_entity if you are unsure.",
    "  4. Be conservative: alias_of > same_entity when uncertain.",
    "",
    "Output a JSON array — one object per pair with exactly these keys:",
    "title_a, title_b, verdict, direction (only for parent_child), confidence (0-1), reason, evidence",
    "",
    "Pairs to classify:",
    "",
    desc,
    "",
    "JSON output:",
  ].join("\n")
}

async function llmJudgeIdentityPairs(
  pairs: Array<{ a: IdentityEntry; b: IdentityEntry; reasons: string[] }>,
  llmConfig: LlmConfig,
): Promise<{ judgments: IdentityJudgment[]; errors: string[] }> {
  const judgments: IdentityJudgment[] = []
  const errors: string[] = []

  const ALLOWED_VERDICTS: ReadonlySet<string> = new Set([
    "same_entity", "alias_of", "sibling_of", "parent_child", "distinct",
  ])

  for (let offset = 0; offset < pairs.length; offset += BATCH_SIZE) {
    const batch = pairs.slice(offset, offset + BATCH_SIZE)
    const prompt = buildIdentityPrompt(batch)

    let rawText = ""
    try {
      await streamChat(
        [{ role: "user", content: prompt }],
        llmConfig,
        (chunk) => { rawText += chunk },
      )
    } catch (err) {
      errors.push(`LLM call failed at offset ${offset}: ${String(err)}`)
      continue
    }

    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      errors.push(`No JSON array in response at offset ${offset}. Raw: ${rawText.slice(0, 200)}`)
      continue
    }

    let parsed: unknown[]
    try { parsed = JSON.parse(jsonMatch[0]) as unknown[] }
    catch { errors.push(`JSON parse failed at offset ${offset}`); continue }

    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue
      const j = item as Record<string, unknown>

      const verdict = String(j.verdict ?? "distinct")
      const judgment: IdentityJudgment = {
        title_a:    String(j.title_a   ?? ""),
        title_b:    String(j.title_b   ?? ""),
        verdict:    ALLOWED_VERDICTS.has(verdict) ? (verdict as IdentityVerdict) : "distinct",
        direction:  (j.direction as IdentityJudgment["direction"]) ?? undefined,
        confidence: typeof j.confidence === "number" ? j.confidence : 0,
        reason:     String(j.reason   ?? ""),
        evidence:   String(j.evidence ?? ""),
      }

      // Extra safety: same_entity requires confidence >= 0.90
      if (judgment.verdict === "same_entity" && judgment.confidence < 0.90) {
        judgment.verdict = "alias_of"
      }

      if (judgment.title_a && judgment.title_b) {
        judgments.push(judgment)
      }
    }
  }

  return { judgments, errors }
}

// ─── Phase 4: Apply Judgments ─────────────────────────────────────────────────

interface ApplyResult {
  merged: number
  aliasEdges: number
  siblingEdges: number
  parentChildEdges: number
  discarded: number
  errors: string[]
}

async function applyIdentityJudgments(
  judgments: IdentityJudgment[],
  catalogMap: Map<string, IdentityEntry>,
  writeThreshold: number,
): Promise<ApplyResult> {
  let merged = 0, aliasEdges = 0, siblingEdges = 0, parentChildEdges = 0, discarded = 0
  const errors: string[] = []

  for (const j of judgments) {
    if (j.confidence < DISCARD_THRESHOLD || j.verdict === "distinct") {
      discarded++
      continue
    }
    if (j.confidence < writeThreshold) {
      // Below write threshold — skip (future: ReviewStore)
      discarded++
      continue
    }

    const entA = catalogMap.get(j.title_a)
    const entB = catalogMap.get(j.title_b)
    if (!entA || !entB) {
      errors.push(`Catalog miss: ${j.title_a} or ${j.title_b}`)
      continue
    }

    try {
      switch (j.verdict) {
        case "same_entity": {
          // Write a merge marker to A's page (postprocess will dedup on next ingest).
          // We do NOT delete B here — that is a destructive operation requiring human review.
          // Instead, we write an alias_of edge so the graph connects them, and add a
          // merge_suggestion comment in A's frontmatter for human audit.
          await writeMergeSuggestion(entA, entB, j)
          // Also write alias edge so RAG can traverse
          await writeIdentityEdge(entA, "alias_of", entB.title, j, "identity_inferred")
          merged++
          break
        }
        case "alias_of": {
          // Bidirectional alias edges
          await writeIdentityEdge(entA, "alias_of", entB.title, j, "identity_inferred")
          await writeIdentityEdge(entB, "alias_of", entA.title, j, "identity_inferred")
          aliasEdges++
          break
        }
        case "sibling_of": {
          await writeIdentityEdge(entA, "sibling_of", entB.title, j, "identity_inferred")
          await writeIdentityEdge(entB, "sibling_of", entA.title, j, "identity_inferred")
          siblingEdges++
          break
        }
        case "parent_child": {
          const parent = j.direction === "b_is_parent" ? entB : entA
          const child  = j.direction === "b_is_parent" ? entA : entB
          await writeIdentityEdge(parent, "has_part", child.title, j, "identity_inferred")
          await writeIdentityEdge(child,  "part_of", parent.title, j, "identity_inferred")
          parentChildEdges++
          break
        }
      }
    } catch (err) {
      errors.push(`Failed to apply judgment (${j.verdict}) for ${j.title_a}↔${j.title_b}: ${String(err)}`)
    }
  }

  return { merged, aliasEdges, siblingEdges, parentChildEdges, discarded, errors }
}

// ─── Edge Writers ─────────────────────────────────────────────────────────────

async function writeIdentityEdge(
  entry: IdentityEntry,
  relType: string,
  targetTitle: string,
  j: IdentityJudgment,
  provenance: string,
): Promise<void> {
  if (entry.existingTargets.has(targetTitle)) return

  const content = await readFile(entry.filePath)

  // Guard: already has this (type, target) edge
  if (hasIdentityEdge(content, relType, targetTitle)) return

  const edgeYaml = [
    `  - target: "${targetTitle}"`,
    `    type: ${relType}`,
    `    provenance: ${provenance}`,
    `    confidence: ${j.confidence.toFixed(2)}`,
    `    evidence: "${(j.evidence || j.reason).replace(/"/g, "'")}"`,
    `    source_files: []`,
  ].join("\n")

  const compactLine = `  - "${relType}: ${targetTitle}"`

  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!fmMatch) return

  const [, open, fm, close] = fmMatch
  let newFm = fm

  // Append to compact relations list
  const relBlockRe = /^(relations:\s*\n(?:\s+-\s+.+\n?)*)/m
  if (relBlockRe.test(fm)) {
    newFm = fm.replace(relBlockRe, (m) => m.trimEnd() + "\n" + compactLine + "\n")
  } else if (/^relations:\s*\[\]$/m.test(fm)) {
    newFm = fm.replace(/^relations:\s*\[\]$/m, `relations:\n${compactLine}`)
  } else {
    newFm = fm.trimEnd() + `\nrelations:\n${compactLine}`
  }

  // Append to relation_edges block
  const edgeBlockRe = /^(relation_edges:[ \t]*\n(?:[ \t]+-[ \t][\s\S]*?\n?)+)/m
  if (edgeBlockRe.test(newFm)) {
    newFm = newFm.replace(edgeBlockRe, (m) => m.trimEnd() + "\n" + edgeYaml + "\n")
  } else {
    newFm = newFm.trimEnd() + `\nrelation_edges:\n${edgeYaml}`
  }

  const updated = content.replace(fmMatch[0], open + newFm + close)
  if (updated !== content) {
    await writeFile(entry.filePath, updated)
    // Update in-memory set to prevent duplicate writes in same pass
    entry.existingTargets.add(targetTitle)
  }
}

async function writeMergeSuggestion(
  primary: IdentityEntry,
  duplicate: IdentityEntry,
  j: IdentityJudgment,
): Promise<void> {
  const content = await readFile(primary.filePath)
  const marker = `merge_suggestion: "${duplicate.title}"`
  if (content.includes(marker)) return

  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!fmMatch) return

  const [, open, fm, close] = fmMatch
  const annotation = [
    `# IDENTITY_PASS: possible duplicate of "${duplicate.title}"`,
    `# confidence: ${j.confidence.toFixed(2)}  reason: ${j.reason}`,
    `# Review and manually merge if confirmed. Run ingest to re-deduplicate.`,
    `${marker}`,
  ].join("\n")

  const newFm = fm.trimEnd() + "\n" + annotation
  const updated = content.replace(fmMatch[0], open + newFm + close)
  if (updated !== content) await writeFile(primary.filePath, updated)
}

function hasIdentityEdge(content: string, relType: string, target: string): boolean {
  if (content.includes(`${relType}: ${target}`)) return true
  const targetRe = new RegExp(`target:\\s*"?${escRe(target)}"?`, "m")
  if (targetRe.test(content)) {
    if (new RegExp(`type:\\s*${relType}\\b`, "m").test(content)) return true
  }
  return false
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run the full Identity Pass on a project.
 *
 * Call this AFTER runKnowledgePostProcess() and BEFORE runGlobalRelationPass().
 * It resolves entity identity collisions before lateral relations are built,
 * ensuring the relation graph is built on clean, deduplicated entities.
 *
 * @param projectPath  Absolute path to the wiki project root.
 * @param llmConfig    LLM provider config (model, temperature, etc).
 * @param signal       Optional AbortSignal for cancellation.
 * @param options      newEntityTitles narrows candidates to save LLM calls.
 */
export async function runIdentityPass(
  projectPath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  options?: IdentityPassOptions,
): Promise<IdentityPassResult> {
  const errors: string[] = []
  const threshold = options?.writeThreshold ?? WRITE_THRESHOLD

  if (signal?.aborted) {
    return { catalogSize: 0, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors }
  }

  // Phase 1
  let catalog: IdentityEntry[]
  try {
    catalog = await buildIdentityCatalog(projectPath)
  } catch (err) {
    return { catalogSize: 0, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors: [String(err)] }
  }

  if (catalog.length < 2) {
    return { catalogSize: catalog.length, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors }
  }

  // Phase 2
  const pairs = generateIdentityCandidates(catalog, options?.newEntityTitles)
  if (pairs.length === 0) {
    return { catalogSize: catalog.length, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors }
  }

  if (signal?.aborted) {
    return { catalogSize: catalog.length, candidatePairs: pairs.length, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors }
  }

  // Phase 3
  const { judgments, errors: llmErrors } = await llmJudgeIdentityPairs(pairs, llmConfig)
  errors.push(...llmErrors)
  const llmCallCount = Math.ceil(pairs.length / BATCH_SIZE)

  // Phase 4
  const catalogMap = new Map(catalog.map(e => [e.title, e]))
  const { merged, aliasEdges, siblingEdges, parentChildEdges, discarded, errors: applyErrors } =
    await applyIdentityJudgments(judgments, catalogMap, threshold)
  errors.push(...applyErrors)

  console.log(
    `[identity-pass] catalog=${catalog.length} pairs=${pairs.length} calls=${llmCallCount}` +
    ` merged=${merged} alias=${aliasEdges} sibling=${siblingEdges} parent_child=${parentChildEdges} discarded=${discarded}`,
  )

  return { catalogSize: catalog.length, candidatePairs: pairs.length, llmCallCount, merged, aliasEdges, siblingEdges, parentChildEdges, discarded, errors }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scalar(text: string, key: string): string {
  const m = text.match(new RegExp(`^${escRe(key)}:\\s*"?([^"\\n]+)"?\\s*$`, "m"))
  return m ? m[1].trim() : ""
}

function scalarBlock(text: string, key: string): string {
  const m = text.match(new RegExp(`^${escRe(key)}:\\s*(.+)$`, "m"))
  return m ? m[1].trim().replace(/^"|"$/g, "") : ""
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
