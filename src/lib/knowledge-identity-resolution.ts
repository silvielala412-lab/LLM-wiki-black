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
import type { LlmConfig, EmbeddingConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import { fetchEmbedding } from "@/lib/embedding"
import {
  canonicalServiceIdentityName,
  inferStableInsuranceDedupKey,
  INSURANCE_SCHEMA_REGISTRY,
} from "@/lib/insurance-schema-registry"
import type { FieldMergePolicy } from "@/lib/insurance-schema-registry"

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
  /** Parsed confidence score from frontmatter [0,1]. Default 0.75 if absent. */
  confidence: number
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
  /** Structured audit log: one entry per acted-on candidate pair. */
  auditLog: IdentityAuditEntry[]
}

/** Structured audit entry for one identity judgment action. */
export interface IdentityAuditEntry {
  entity_a: string
  entity_b: string
  source: string          // e.g. "R1:dedup_key", "R5:vector_similarity"
  similarity?: number
  llm_verdict: IdentityVerdict
  confidence: number
  action: string          // e.g. "merge_fields", "write_alias_edge", "discarded"
  fields_merged?: string[]
  conflicts?: string[]
}

export interface IdentityPassOptions {
  /** Only consider pairs involving at least one of these titles. */
  newEntityTitles?: ReadonlySet<string>
  /** Minimum confidence to act on a judgment. Default: 0.82 */
  writeThreshold?: number
  /**
   * If provided and enabled, adds vector-similarity candidates (R5).
   * Entities with cosine similarity >= vectorThreshold are sent to LLM for judgment.
   */
  embeddingConfig?: EmbeddingConfig
  /** Cosine similarity threshold for R5 vector candidates. Default: 0.82 */
  vectorThreshold?: number
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
        // Skip pages already merged into a canonical entity
        if (/^redirect_to:\s*".+"/m.test(content)) continue
        // Skip non-entity pages (audit reports, query summaries, source pages)
        // These must not participate in identity comparison.
        const entityTypeInFile = content.match(/^entity_type:\s*(\S+)/m)?.[1]?.trim() ?? ""
        const SKIP_TYPES = new Set(["audit_report","source_summary","query","audit","report","source"])
        if (SKIP_TYPES.has(entityTypeInFile)) continue
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

  // Parse confidence score — default 0.75 if absent
  const confidence = parseFloat(fm.match(/^confidence:\s*([\d.]+)/m)?.[1] ?? "0.75")

  return {
    title,
    canonicalTitle,
    dedupKey,
    entityType: entityType || "",
    summary: summary || "",
    serviceScene: String(attrs.service_scene ?? ""),
    serviceStage: String(attrs.service_stage ?? ""),
    sourceFiles,
    confidence: isNaN(confidence) ? 0.75 : Math.min(1, Math.max(0, confidence)),
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

  function tryAdd(a: IdentityEntry, b: IdentityEntry, reason: string, forceInclude = false) {
    if (a.title === b.title) return
    // newEntityTitles is an incremental optimization: only compare entities
    // involved in this ingest batch. R1 (same dedup_key) bypasses this filter
    // because identical dedup_keys are a deterministic fact — we must always
    // merge them regardless of which batch created them.
    if (!forceInclude && newEntityTitles && newEntityTitles.size > 0) {
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

  // R1: same dedup_key — deterministic signal, forceInclude bypasses newEntityTitles
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
        tryAdd(group[i], group[j], "R1:same_dedup_key", true)  // always compare same-dedup-key pairs
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

// ─── Phase 2b: Vector Similarity Candidates (R5) ─────────────────────────────
//
// For entities whose names are completely different (e.g. "在线问诊" vs "音视频问诊"),
// rules R1-R4 produce no candidates. R5 uses embedding cosine similarity to surface
// semantically equivalent entities that naming rules miss.
//
// Embed text = title + entity_type + summary (richer than title alone).
// Pairs with cosine >= vectorThreshold and no discriminator conflict enter the LLM pool.

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export async function generateVectorCandidates(
  catalog: IdentityEntry[],
  embeddingConfig: EmbeddingConfig,
  existingPairKeys: ReadonlySet<string>,
  newEntityTitles?: ReadonlySet<string>,
  threshold = 0.82,
): Promise<Array<{ a: IdentityEntry; b: IdentityEntry; reasons: string[] }>> {
  if (!embeddingConfig.enabled || !embeddingConfig.model) return []

  console.log(`[identity-pass/R5] Embedding ${catalog.length} entities for vector similarity…`)

  // Build embed text: title + entity_type + summary
  const embedTexts = catalog.map(e =>
    [e.title, e.entityType, e.summary].filter(Boolean).join("\n")
  )

  // Fetch embeddings concurrently in batches of 8 to avoid API rate limits
  const EMBED_CONCURRENCY = 8
  const embeddings: (number[] | null)[] = new Array(catalog.length).fill(null)
  for (let i = 0; i < embedTexts.length; i += EMBED_CONCURRENCY) {
    const batch = embedTexts.slice(i, i + EMBED_CONCURRENCY)
    const results = await Promise.all(batch.map(t => fetchEmbedding(t, embeddingConfig)))
    results.forEach((emb, j) => { embeddings[i + j] = emb })
  }

  const indexed = embeddings.filter(Boolean).length
  console.log(`[identity-pass/R5] Indexed ${indexed}/${catalog.length} entities`)
  if (indexed === 0) return []

  // Build set of new entity indices
  const newIndices = newEntityTitles && newEntityTitles.size > 0
    ? new Set(catalog.map((e, i) => newEntityTitles.has(e.title) ? i : -1).filter(i => i >= 0))
    : null

  const pairs: Array<{ a: IdentityEntry; b: IdentityEntry; reasons: string[] }> = []
  const seen = new Set<string>()

  for (let i = 0; i < catalog.length; i++) {
    if (!embeddings[i]) continue
    for (let j = i + 1; j < catalog.length; j++) {
      if (!embeddings[j]) continue
      // Incremental: at least one entity must be new
      if (newIndices && !newIndices.has(i) && !newIndices.has(j)) continue
      // Skip sibling discriminator conflicts
      if (hasSiblingDiscriminators(catalog[i].title, catalog[j].title)) continue

      const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!)
      if (sim < threshold) continue

      const key = [catalog[i].title, catalog[j].title].sort().join("|||")
      // Skip if rule-based pass already has this pair
      if (existingPairKeys.has(key) || seen.has(key)) continue

      seen.add(key)
      pairs.push({
        a: catalog[i],
        b: catalog[j],
        reasons: [`R5:vector_similarity(${sim.toFixed(3)})`],
      })
    }
  }

  console.log(`[identity-pass/R5] Found ${pairs.length} vector candidates (threshold=${threshold})`)
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
  auditLog: IdentityAuditEntry[]
}

async function applyIdentityJudgments(
  judgments: IdentityJudgment[],
  catalogMap: Map<string, IdentityEntry>,
  writeThreshold: number,
): Promise<ApplyResult> {
  let merged = 0, aliasEdges = 0, siblingEdges = 0, parentChildEdges = 0, discarded = 0
  const errors: string[] = []
  const auditLog: IdentityAuditEntry[] = []

  for (const j of judgments) {
    if (j.confidence < DISCARD_THRESHOLD || j.verdict === "distinct") {
      discarded++
      auditLog.push({ entity_a: j.title_a, entity_b: j.title_b, source: "llm", llm_verdict: j.verdict, confidence: j.confidence, action: "discarded" })
      continue
    }
    if (j.confidence < writeThreshold) {
      discarded++
      auditLog.push({ entity_a: j.title_a, entity_b: j.title_b, source: "llm", llm_verdict: j.verdict, confidence: j.confidence, action: "below_threshold" })
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
          // Determine canonical entity: prefer whichever has more source_files;
          // fall back to lexicographic order for stability.
          const primary   = entA.sourceFiles.length >= entB.sourceFiles.length ? entA : entB
          const duplicate = primary === entA ? entB : entA

          const { fieldsMerged, conflicts, mergeErrors } = await mergeEntityFields(primary, duplicate, j)
          errors.push(...mergeErrors)

          // Also write the alias edge so RAG can traverse during transition period
          await writeIdentityEdge(primary, "alias_of", duplicate.title, j, "identity_inferred")

          auditLog.push({
            entity_a: primary.title,
            entity_b: duplicate.title,
            source: "llm",
            llm_verdict: "same_entity",
            confidence: j.confidence,
            action: "merge_fields",
            fields_merged: fieldsMerged,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
          })
          merged++
          break
        }
        case "alias_of": {
          await writeIdentityEdge(entA, "alias_of", entB.title, j, "identity_inferred")
          await writeIdentityEdge(entB, "alias_of", entA.title, j, "identity_inferred")
          auditLog.push({ entity_a: entA.title, entity_b: entB.title, source: "llm", llm_verdict: "alias_of", confidence: j.confidence, action: "write_alias_edge" })
          aliasEdges++
          break
        }
        case "sibling_of": {
          await writeIdentityEdge(entA, "sibling_of", entB.title, j, "identity_inferred")
          await writeIdentityEdge(entB, "sibling_of", entA.title, j, "identity_inferred")
          auditLog.push({ entity_a: entA.title, entity_b: entB.title, source: "llm", llm_verdict: "sibling_of", confidence: j.confidence, action: "write_sibling_edge" })
          siblingEdges++
          break
        }
        case "parent_child": {
          const parent = j.direction === "b_is_parent" ? entB : entA
          const child  = j.direction === "b_is_parent" ? entA : entB
          await writeIdentityEdge(parent, "has_part", child.title, j, "identity_inferred")
          await writeIdentityEdge(child,  "part_of", parent.title, j, "identity_inferred")
          auditLog.push({ entity_a: parent.title, entity_b: child.title, source: "llm", llm_verdict: "parent_child", confidence: j.confidence, action: "write_parent_child_edge" })
          parentChildEdges++
          break
        }
      }
    } catch (err) {
      errors.push(`Failed to apply judgment (${j.verdict}) for ${j.title_a}↔${j.title_b}: ${String(err)}`)
    }
  }

  return { merged, aliasEdges, siblingEdges, parentChildEdges, discarded, errors, auditLog }
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

// ─── Real Field-Level Entity Merge ────────────────────────────────────────────────
//
// Merge strategy per field category:
//   source_files  — union (append + dedup all file references)
//   claims        — append all from duplicate (multi-source evidence is additive)
//   attributes.*  — fill-null only (never overwrite existing non-null primary data)
//   confidence    — keep max of both
//
// Fields that would conflict (both non-null, semantically different) are logged
// as conflicts for human review. They are NOT auto-overwritten.
//
// The duplicate page receives a redirect_to: marker so the system knows it has
// been absorbed. It is NOT deleted (human audit trail).

async function mergeEntityFields(
  primary: IdentityEntry,
  duplicate: IdentityEntry,
  j: IdentityJudgment,
): Promise<{ fieldsMerged: string[]; conflicts: string[]; mergeErrors: string[] }> {
  const fieldsMerged: string[] = []
  const conflicts: string[] = []
  const mergeErrors: string[] = []

  let primaryContent: string
  let dupContent: string
  try {
    primaryContent = await readFile(primary.filePath)
    dupContent     = await readFile(duplicate.filePath)
  } catch (err) {
    mergeErrors.push(`mergeEntityFields: readFile failed: ${String(err)}`)
    return { fieldsMerged, conflicts, mergeErrors }
  }

  let updated = primaryContent

  // ── 1. Merge source_files (union + dedup) ───────────────────────────
  const dupSfMatch = dupContent.match(/^source_files:\s*\[([^\]]*)\]/m)
  const dupSourceFiles = dupSfMatch
    ? dupSfMatch[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
    : []
  if (dupSourceFiles.length > 0) {
    const primSfMatch = updated.match(/^source_files:\s*\[([^\]]*)\]/m)
    const primSourceFiles = primSfMatch
      ? primSfMatch[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
      : []
    const unionFiles = [...new Set([...primSourceFiles, ...dupSourceFiles])]
    const newSfLine = `source_files: [${unionFiles.map(f => `"${f}"`).join(", ")}]`
    if (primSfMatch) {
      updated = updated.replace(/^source_files:\s*\[[^\]]*\]/m, newSfLine)
    } else {
      // Insert before closing ---
      updated = updated.replace(/(\n---\s*)$/, `\n${newSfLine}$1`)
    }
    fieldsMerged.push(`source_files (+${dupSourceFiles.length})`)
  }

  // ── 2. Merge claims (append new, dedup by trimmed text) ───────────────
  const dupClaims = extractFrontmatterList(dupContent, "claims")
  if (dupClaims.length > 0) {
    const primClaimsSet = new Set(extractFrontmatterList(updated, "claims").map(c => c.trim()))
    const newClaims = dupClaims.filter(c => !primClaimsSet.has(c.trim()))
    if (newClaims.length > 0) {
      const newLines = newClaims.map(c => `  - "${c.replace(/"/g, "'")}"`).join("\n")
      const claimsBlockRe = /^(claims:\s*\n(?:\s+-\s+.+\n?)*)/m
      if (claimsBlockRe.test(updated)) {
        updated = updated.replace(claimsBlockRe, m => m.trimEnd() + "\n" + newLines + "\n")
      } else if (/^claims:\s*\[\]/m.test(updated)) {
        updated = updated.replace(/^claims:\s*\[\]/m, `claims:\n${newLines}`)
      } else {
        updated = updated.replace(/(\n---\s*)$/, `\nclaims:\n${newLines}$1`)
      }
      fieldsMerged.push(`claims (+${newClaims.length})`)
    }
  }

  // ── 3. Merge attributes: schema-driven field-level policy ─────────────────
  //
  //  Policy lookup:
  //    compliance_notes / knowledge_gaps  → append   (always multi-source)
  //    importance: critical / high_confidence → conflict  (flag for human review)
  //    importance: recommended               → ignore_empty (fill-null only)
  //    importance: auto_derived              → keep_best   (take longer/more-complete)
  //    unknown field                         → ignore_empty (safe default)
  //
  const primAttrMatch = updated.match(/^attributes:\s*(\{[^\n]*\})\s*$/m)
  const dupAttrMatch  = dupContent.match(/^attributes:\s*(\{[^\n]*\})\s*$/m)
  if (primAttrMatch && dupAttrMatch) {
    try {
      const primAttrs = JSON.parse(primAttrMatch[1]) as Record<string, unknown>
      const dupAttrs  = JSON.parse(dupAttrMatch[1])  as Record<string, unknown>
      let attrChanged = false

      // Build field-importance lookup for this entity type
      const schemaSpec = INSURANCE_SCHEMA_REGISTRY.find(s => s.entityType === primary.entityType)
      const importanceMap = new Map<string, string>()
      for (const field of schemaSpec?.fields ?? []) {
        importanceMap.set(field.name, field.importance)
      }

      function fieldPolicy(key: string): FieldMergePolicy {
        // These fields always append regardless of entity type
        if (["compliance_notes", "knowledge_gaps"].includes(key)) return "append"
        // extra_attributes is a catch-all — skip
        if (key === "extra_attributes") return "ignore_empty"
        const imp = importanceMap.get(key)
        if (!imp) return "ignore_empty"           // unknown field → safe default
        if (imp === "critical" || imp === "high_confidence") return "conflict"
        if (imp === "auto_derived") return "keep_best"
        return "ignore_empty"                     // recommended → fill-null only
      }

      for (const [key, dupVal] of Object.entries(dupAttrs)) {
        if (dupVal === null || dupVal === undefined) continue
        const primVal = primAttrs[key]
        const policy  = fieldPolicy(key)

        if (primVal === null || primVal === undefined) {
          // Always fill null regardless of policy — no existing data to protect
          primAttrs[key] = dupVal
          attrChanged = true
          fieldsMerged.push(`attributes.${key} (null→filled)`)
        } else if (JSON.stringify(primVal) !== JSON.stringify(dupVal)) {
          switch (policy) {
            case "conflict": {
              // Source Authority resolution: higher-confidence source wins.
              // Only flag for human review when confidences are too close to call
              // (gap <= 0.05 — treated as a genuine ambiguity).
              const AUTHORITY_GAP = 0.05
              const primConf = primary.confidence
              const dupConf  = duplicate.confidence

              if (primConf > dupConf + AUTHORITY_GAP) {
                // Primary has meaningfully higher authority — keep primary silently
                fieldsMerged.push(`attributes.${key} (authority: primary conf=${primConf.toFixed(2)}>${dupConf.toFixed(2)})`)
              } else if (dupConf > primConf + AUTHORITY_GAP) {
                // Duplicate has higher authority — overwrite primary
                primAttrs[key] = dupVal
                attrChanged = true
                fieldsMerged.push(`attributes.${key} (authority: dup overwrite conf=${dupConf.toFixed(2)}>${primConf.toFixed(2)})`)
              } else {
                // True tie — cannot auto-resolve, flag for human review
                conflicts.push(`${key}[${importanceMap.get(key) ?? "?"}] tie(${primConf.toFixed(2)}): primary="${String(primVal).slice(0, 60)}" vs dup="${String(dupVal).slice(0, 60)}"`)
              }
              break
            }
            case "keep_best":
              // Auto-derived: take whichever string is longer/more complete
              if (typeof dupVal === "string" && typeof primVal === "string" && dupVal.length > primVal.length) {
                primAttrs[key] = dupVal
                attrChanged = true
                fieldsMerged.push(`attributes.${key} (keep_best: dup richer)`)
              }
              break
            case "append":
              // Multi-source fields: concatenate with separator
              if (typeof dupVal === "string" && typeof primVal === "string" && !primVal.includes(dupVal)) {
                primAttrs[key] = `${primVal} | ${dupVal}`
                attrChanged = true
                fieldsMerged.push(`attributes.${key} (appended)`)
              }
              break
            case "ignore_empty":
              // Recommended field — keep primary, don't overwrite
              break
          }
        }
      }

      if (attrChanged) {
        updated = updated.replace(/^attributes:\s*\{[^\n]*\}\s*$/m, `attributes: ${JSON.stringify(primAttrs)}`)
      }
      if (conflicts.length > 0) {
        // Write conflict note into primary frontmatter for human reviewer
        const conflictNote = `# MERGE_CONFLICT: ${conflicts.slice(0, 3).join(" | ")}`.replace(/\n/g, " ")
        const fmMatch = updated.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
        if (fmMatch && !updated.includes("MERGE_CONFLICT:")) {
          const [, open, fm, close] = fmMatch
          updated = updated.replace(fmMatch[0], `${open}${fm.trimEnd()}\n${conflictNote}${close}`)
        }
      }
    } catch (err) {
      mergeErrors.push(`attributes merge parse error: ${String(err)}`)
    }
  }

  // ── 4. Confidence: keep max ───────────────────────────────────
  const primConf = parseFloat(updated.match(/^confidence:\s*([\d.]+)/m)?.[1] ?? "0.75")
  const dupConf  = parseFloat(dupContent.match(/^confidence:\s*([\d.]+)/m)?.[1] ?? "0.75")
  if (dupConf > primConf) {
    updated = updated.replace(/^(confidence:\s*)[\d.]+/m, `$1${dupConf.toFixed(2)}`)
    fieldsMerged.push(`confidence (${primConf.toFixed(2)}→${dupConf.toFixed(2)})`)
  }

  // ── 5. Write merged primary ───────────────────────────────────
  if (updated !== primaryContent) {
    try { await writeFile(primary.filePath, updated) }
    catch (err) { mergeErrors.push(`writeFile primary failed: ${String(err)}`) }
  }

  // ── 6. Mark duplicate as redirect (do NOT delete — keep audit trail) ───
  const fmMatch = dupContent.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (fmMatch && !dupContent.includes("redirect_to:")) {
    const [, open, fm, close] = fmMatch
    const redirectNote = [
      `redirect_to: "${primary.title}"`,
      `# IDENTITY_PASS: merged into "${primary.title}" on ${new Date().toISOString().slice(0, 10)}`,
      `#   confidence: ${j.confidence.toFixed(2)} | reason: ${j.reason.replace(/"/g, "'").slice(0, 120)}`,
    ].join("\n")
    const newDupContent = dupContent.replace(fmMatch[0], `${open}${fm.trimEnd()}\n${redirectNote}${close}`)
    try { await writeFile(duplicate.filePath, newDupContent) }
    catch (err) { mergeErrors.push(`writeFile duplicate failed: ${String(err)}`) }
  }

  return { fieldsMerged, conflicts, mergeErrors }
}

/** Extract a YAML list from frontmatter (handles both inline [] and block list formats). */
function extractFrontmatterList(content: string, key: string): string[] {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Inline: key: ["a", "b"]
  const inline = fm.match(new RegExp(`^${escKey}:\\s*\\[([^\\]]*)\\]`, "m"))
  if (inline) return inline[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
  // Block list: key:\n  - item
  const block = fm.match(new RegExp(`^${escKey}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, "m"))
  if (!block) return []
  return block[1].split(/\r?\n/)
    .map(l => l.match(/^\s+-\s+"?([^"\n]+?)"?\s*$/)?.[1]?.trim() ?? "")
    .filter(Boolean)
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
    return { catalogSize: 0, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors, auditLog: [] }
  }

  // Phase 1
  let catalog: IdentityEntry[]
  try {
    catalog = await buildIdentityCatalog(projectPath)
  } catch (err) {
    return { catalogSize: 0, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors: [String(err)], auditLog: [] }
  }

  if (catalog.length < 2) {
    return { catalogSize: catalog.length, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors, auditLog: [] }
  }

  // Phase 2a: Rule-based candidates (R1–R4)
  const pairs = generateIdentityCandidates(catalog, options?.newEntityTitles)

  // Phase 2b: Vector similarity candidates (R5) — only when embedding is configured
  if (options?.embeddingConfig?.enabled && options.embeddingConfig.model) {
    const rulePairKeys = new Set(pairs.map(p => [p.a.title, p.b.title].sort().join("|||")))
    const vectorThreshold = options.vectorThreshold ?? 0.82
    try {
      const vectorPairs = await generateVectorCandidates(
        catalog,
        options.embeddingConfig,
        rulePairKeys,
        options.newEntityTitles,
        vectorThreshold,
      )
      pairs.push(...vectorPairs)
    } catch (err) {
      const msg = `R5 vector candidates failed: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[identity-pass] ${msg}`)
      errors.push(msg)
    }
  }

  if (pairs.length === 0) {
    return { catalogSize: catalog.length, candidatePairs: 0, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors, auditLog: [] }
  }

  if (signal?.aborted) {
    return { catalogSize: catalog.length, candidatePairs: pairs.length, llmCallCount: 0, merged: 0, aliasEdges: 0, siblingEdges: 0, parentChildEdges: 0, discarded: 0, errors, auditLog: [] }
  }

  // Phase 2.5: Deterministic merge — same-dedup-key pairs skip LLM entirely.
  // Confidence = 1.0: identical dedup_key is a schema-level fact, not a probabilistic signal.
  const deterministicPairs = pairs.filter(p => p.reasons.length === 1 && p.reasons[0] === "R1:same_dedup_key")
  const ambiguousPairs    = pairs.filter(p => !(p.reasons.length === 1 && p.reasons[0] === "R1:same_dedup_key"))

  const deterministicJudgments: IdentityJudgment[] = deterministicPairs.map(p => ({
    title_a: p.a.title,
    title_b: p.b.title,
    verdict: "same_entity" as const,
    confidence: 1.0,
    reason: `Identical canonical dedup_key (${p.a.dedupKey}) — deterministic merge, no LLM needed`,
    evidence: `dedup_key: ${p.a.dedupKey}`,
  }))
  if (deterministicJudgments.length > 0) {
    console.log(`[identity-pass] deterministic merges (R1): ${deterministicJudgments.length} pair(s)`)
  }

  // Phase 3: LLM judgment for ambiguous pairs only
  const { judgments: llmJudgments, errors: llmErrors } = ambiguousPairs.length > 0
    ? await llmJudgeIdentityPairs(ambiguousPairs, llmConfig)
    : { judgments: [], errors: [] }
  errors.push(...llmErrors)
  const llmCallCount = Math.ceil(ambiguousPairs.length / BATCH_SIZE)
  const judgments = [...deterministicJudgments, ...llmJudgments]

  // Phase 4
  const catalogMap = new Map(catalog.map(e => [e.title, e]))
  const { merged, aliasEdges, siblingEdges, parentChildEdges, discarded, errors: applyErrors, auditLog } =
    await applyIdentityJudgments(judgments, catalogMap, threshold)
  errors.push(...applyErrors)

  console.log(
    `[identity-pass] catalog=${catalog.length} pairs=${pairs.length} (det=${deterministicJudgments.length} llm=${ambiguousPairs.length}) calls=${llmCallCount}` +
    ` merged=${merged} alias=${aliasEdges} sibling=${siblingEdges} parent_child=${parentChildEdges} discarded=${discarded}`,
  )
  if (auditLog.length > 0) {
    console.log("[identity-pass] audit:\n" + auditLog.map(e =>
      `  ${e.entity_a} ↔ ${e.entity_b} → ${e.action} (${e.llm_verdict} conf=${e.confidence.toFixed(2)})`
    ).join("\n"))

    // Persist auditLog to disk so it survives process restart.
    // Written to wiki/.identity-audit/{timestamp}.json — non-critical, never throws.
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const auditDir = `${projectPath}/wiki/.identity-audit`
      await writeFile(`${auditDir}/${timestamp}.json`, JSON.stringify(auditLog, null, 2))
    } catch { /* non-critical — do not fail the ingest */ }
  }

  return { catalogSize: catalog.length, candidatePairs: pairs.length, llmCallCount, merged, aliasEdges, siblingEdges, parentChildEdges, discarded, errors, auditLog }
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
