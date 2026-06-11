/**
 * knowledge-global-relation.ts
 *
 * Global Relation Pass: cross-document semantic relation inference.
 *
 * Problem this solves
 * ─────────────────────────────────────────────────────────────────
 * When multiple documents are ingested, each document's LLM call
 * only sees its own content + wiki/index.md (title list). It cannot
 * build horizontal relations to entities from other documents.
 *
 * This pass runs AFTER all pages are generated and postprocessed.
 * It reads every entity page, builds a global EntityCatalog, generates
 * cross-entity candidate pairs using structural rules, then calls LLM
 * once per batch (20 pairs) to classify the relation type.
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────────
 * Phase 1  buildEntityCatalog()        — read all wiki/entities/*.md
 * Phase 2  generateCandidatePairs()    — rule-based N-reduction (not N²)
 * Phase 3  llmJudgeCandidatePairs()    — LLM batch classification (fixed JSON)
 * Phase 4  applyRelationJudgments()    — write to relation_edges (llm_inferred)
 *
 * Provenance: "llm_inferred" — scored at 0.70 in RELATION_SOURCE_CONFIDENCE.
 * Confidence thresholds:
 *   >= 0.82 → written directly to relation_edges
 *   0.65-0.82 → written to review queue (future: ReviewStore)
 *   < 0.65  → discarded
 *
 * Embedding integration (future)
 * ─────────────────────────────────────────────────────────────────
 * Phase 2 currently uses structural rules for candidate generation.
 * When embedding is available, replace/augment with:
 *   embedAll() → cosine similarity → top-K pairs per entity
 * The Phase 3 + Phase 4 code is identical regardless of candidate source.
 */

import { listDirectory, readFile, writeFile } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"

// ─── Types ────────────────────────────────────────────────────────────────────

/** Extracted metadata for one entity page, used for candidate generation. */
interface EntityEntry {
  title: string
  entityType: string
  summary: string
  serviceScene: string
  serviceStage: string
  serviceCategory: string
  domain: string
  sourceFiles: string[]
  /** Existing relation targets (any direction) — prevents duplicates. */
  existingTargets: Set<string>
  filePath: string
}

/** A candidate pair nominated for LLM classification. */
interface CandidatePair {
  a: EntityEntry
  b: EntityEntry
  /** Rule(s) that nominated this pair. */
  reasons: string[]
}

/** LLM classification result for one candidate pair. */
interface RelationJudgment {
  source_title: string
  target_title: string
  related: boolean
  relation_type: string
  direction: "a→b" | "b→a" | "bidirectional"
  confidence: number
  reason: string
  evidence: string
}

/** Summary returned by runGlobalRelationPass(). */
export interface GlobalRelationPassResult {
  catalogSize: number
  candidatePairs: number
  llmCallCount: number
  written: number      // edges written to disk
  queued: number       // below threshold, queued for review
  discarded: number    // below 0.65, dropped
  errors: string[]
}

/**
 * Options for runGlobalRelationPass.
 * @param newEntityTitles - When provided, only pairs that include at least one
 *   new entity are generated. This prevents re-processing all N² pairs on every
 *   subsequent ingest call (the primary cause of duplicate edge accumulation).
 */
export interface GlobalRelationPassOptions {
  /** Titles of entities written during the current ingest. When omitted, all entities are candidates. */
  newEntityTitles?: ReadonlySet<string>
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Whitelist of relation types the LLM is allowed to output. */
const ALLOWED_RELATION_TYPES = new Set([
  "same_scene", "same_stage", "same_category",
  "complements", "next_step", "prerequisite",
  "part_of", "has_part",
  "supports", "supported_by",
  "bundled_with",
  "related_to",
])

/** Business vocabulary clusters for semantic name-based candidate generation. */
const VOCAB_CLUSTERS: string[][] = [
  ["音视频", "视频", "问诊", "随访"],
  ["门诊", "预约", "陪诊", "协助"],
  ["住院", "安排", "照护", "出院"],
  ["康复", "训练", "管理"],
  ["慢病", "管理", "随访"],
  ["家庭医生", "家医", "健康管理"],
  ["检查", "检验", "化验", "影像"],
  ["心理", "健康", "咨询"],
  ["紧急", "急救", "救援", "援助"],
  ["导医", "就医", "医疗"],
]

const WRITE_THRESHOLD = 0.82    // write directly to relation_edges
const QUEUE_THRESHOLD = 0.65    // enter review queue
const BATCH_SIZE = 20           // candidate pairs per LLM call

// ─── Phase 1: Build Entity Catalog ───────────────────────────────────────────

export async function buildEntityCatalog(projectPath: string): Promise<EntityEntry[]> {
  const catalog: EntityEntry[] = []

  const dirs = [
    `${projectPath}/wiki/entities`,
    `${projectPath}/wiki/concepts`,
  ]

  /** Recursively collect all .md files (supports hierarchy subdirectories). */
  async function scanDir(dir: string): Promise<void> {
    let files: { name: string; path?: string; is_dir?: boolean }[] = []
    try { files = await listDirectory(dir) } catch { return }

    for (const file of files) {
      if (file.is_dir) {
        // Recurse into line/version subdirectories
        const subPath = file.path ?? `${dir}/${file.name}`
        await scanDir(subPath)
      } else if (file.name.endsWith(".md") && !file.name.endsWith(".md.md")) {
        const filePath = file.path ?? `${dir}/${file.name}`
        try {
          const content = await readFile(filePath)
          const entry = parseEntityEntry(content, filePath)
          if (entry) catalog.push(entry)
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  for (const dir of dirs) {
    await scanDir(dir)
  }

  return catalog
}

function parseEntityEntry(content: string, filePath: string): EntityEntry | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  if (!fm) return null

  const title = scalar(fm, "title")
  if (!title) return null

  const entityType  = scalar(fm, "entity_type")
  const summary     = scalar(fm, "summary")
  const domain      = scalar(fm, "knowledge_domain") || scalar(fm, "domain")

  // attributes JSON or YAML
  const attrsRaw = scalar(fm, "attributes")
  let attrs: Record<string, string> = {}
  if (attrsRaw) {
    try { attrs = JSON.parse(attrsRaw) } catch { /* yaml fallback */ }
  }
  if (!attrs.service_scene) {
    attrs.service_scene  = scalarBlock(fm, "service_scene")  || ""
    attrs.service_stage  = scalarBlock(fm, "service_stage")  || ""
    attrs.service_category = scalarBlock(fm, "service_category") || ""
  }

  // existing relation targets — parse BOTH compact-list and YAML-block formats
  const existingTargets = new Set<string>()

  // Format A: compact list  `  - "complements: 音视频随访"`
  const relBlock = fm.match(/^relations:\s*\n((?:[ \t]+-[ \t]+.+(?:\r?\n)?)*)/m)?.[1] ?? ""
  for (const line of relBlock.split(/\r?\n/)) {
    // matches `  - "reltype: target"` or `  - reltype: target`
    const m = line.match(/^[ \t]+-[ \t]+"?[a-z_]+:\s*([^"\r\n]+)"?\s*$/i)
    if (m) existingTargets.add(m[1].trim())
  }

  // Format B: YAML object block  `  - target: "音视频随访"\n    type: complements`
  // Scan the entire frontmatter for `target:` keys inside relation_edges
  const edgeBlockM = fm.match(/^relation_edges:[ \t]*\n((?:[ \t]+.*(?:\r?\n)?)*)/m)
  const edgeBlock = edgeBlockM ? edgeBlockM[1] : ""
  for (const m of edgeBlock.matchAll(/^[ \t]+-?[ \t]*target:[ \t]*"?([^"\r\n]+)"?/gm)) {
    existingTargets.add(m[1].trim())
  }

  // source_files
  const sfMatch = fm.match(/^source_files:\s*\[([^\]]*)\]/m)
  const sourceFiles = sfMatch
    ? sfMatch[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
    : []

  return {
    title,
    entityType: entityType || "",
    summary:    summary    || "",
    serviceScene:    String(attrs.service_scene    ?? ""),
    serviceStage:    String(attrs.service_stage    ?? ""),
    serviceCategory: String(attrs.service_category ?? ""),
    domain: domain || "",
    sourceFiles,
    existingTargets,
    filePath,
  }
}

// ─── Phase 2: Generate Candidate Pairs ───────────────────────────────────────
//
// Rules (ordered by signal strength):
//  R1  Same service_scene (strong structural signal)
//  R2  Same service_category first segment
//  R3  Title shares a business vocabulary cluster
//  R4  Same source_file (co-occurrence)
//  R5  Island node (no existing relations) × any same-domain entity
//
// Each entity is capped to MAX_CANDIDATES_PER_ENTITY to avoid explosion.

const MAX_CANDIDATES_PER_ENTITY = 8

export function generateCandidatePairs(
  catalog: EntityEntry[],
  newEntityTitles?: ReadonlySet<string>,
): CandidatePair[] {
  // Exclude only source/query/synthesis types that don't have lateral relations
  const LATERAL_EXCLUDE = new Set(["source", "query", "synthesis", "compliance_rule", "regulatory_doc"])
  const candidates = catalog.filter(e => !LATERAL_EXCLUDE.has(e.entityType))


  const seen = new Set<string>()
  const pairs: CandidatePair[] = []

  // Track how many candidates each entity has accumulated
  const countMap = new Map<string, number>()
  const getCount  = (t: string) => countMap.get(t) ?? 0
  const incCount  = (a: string, b: string) => {
    countMap.set(a, getCount(a) + 1)
    countMap.set(b, getCount(b) + 1)
  }

  function tryAdd(a: EntityEntry, b: EntityEntry, reason: string) {
    if (a.title === b.title) return
    // Skip if neither is a new entity (avoid re-processing stable pairs on every ingest)
    if (newEntityTitles && newEntityTitles.size > 0) {
      if (!newEntityTitles.has(a.title) && !newEntityTitles.has(b.title)) return
    }
    if (a.existingTargets.has(b.title) || b.existingTargets.has(a.title)) return
    if (getCount(a.title) >= MAX_CANDIDATES_PER_ENTITY) return
    if (getCount(b.title) >= MAX_CANDIDATES_PER_ENTITY) return

    const key = [a.title, b.title].sort().join("|||")
    if (seen.has(key)) {
      // Append reason to existing pair
      const existing = pairs.find(p => [p.a.title, p.b.title].sort().join("|||") === key)
      if (existing && !existing.reasons.includes(reason)) existing.reasons.push(reason)
      return
    }
    seen.add(key)
    pairs.push({ a, b, reasons: [reason] })
    incCount(a.title, b.title)
  }

  // Group by scene
  const byScene = new Map<string, EntityEntry[]>()
  for (const e of candidates) {
    if (!e.serviceScene) continue
    const bucket = byScene.get(e.serviceScene) ?? []
    bucket.push(e)
    byScene.set(e.serviceScene, bucket)
  }
  for (const group of byScene.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        tryAdd(group[i], group[j], `R1:same_scene(${group[i].serviceScene})`)
      }
    }
  }

  // Group by service_category first segment
  const byCat = new Map<string, EntityEntry[]>()
  for (const e of candidates) {
    if (!e.serviceCategory) continue
    const seg = e.serviceCategory.split(/[/／,，]/)[0].trim()
    if (!seg) continue
    const bucket = byCat.get(seg) ?? []
    bucket.push(e)
    byCat.set(seg, bucket)
  }
  for (const [seg, group] of byCat.entries()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        tryAdd(group[i], group[j], `R2:same_category_segment(${seg})`)
      }
    }
  }

  // Vocab cluster matching
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j]
      for (const cluster of VOCAB_CLUSTERS) {
        const aMatch = cluster.filter(w => a.title.includes(w) || a.summary.includes(w))
        const bMatch = cluster.filter(w => b.title.includes(w) || b.summary.includes(w))
        if (aMatch.length > 0 && bMatch.length > 0) {
          const sharedWords = aMatch.filter(w => bMatch.includes(w))
          if (sharedWords.length > 0) {
            tryAdd(a, b, `R3:vocab_cluster(${sharedWords.join(",")})`)
            break
          }
        }
      }
    }
  }

  // Same source_file
  const bySource = new Map<string, EntityEntry[]>()
  for (const e of candidates) {
    for (const sf of e.sourceFiles) {
      const bucket = bySource.get(sf) ?? []
      bucket.push(e)
      bySource.set(sf, bucket)
    }
  }
  for (const group of bySource.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        tryAdd(group[i], group[j], `R4:same_source_file`)
      }
    }
  }

  // Island nodes: entities with 0 existing relations, paired with same-domain entities
  const islands = candidates.filter(e => e.existingTargets.size === 0)
  const byDomain = new Map<string, EntityEntry[]>()
  for (const e of candidates) {
    const d = e.domain || "unknown"
    const bucket = byDomain.get(d) ?? []
    bucket.push(e)
    byDomain.set(d, bucket)
  }
  for (const island of islands) {
    const domain = island.domain || "unknown"
    const peers = byDomain.get(domain) ?? []
    for (const peer of peers) {
      if (peer.title !== island.title) {
        tryAdd(island, peer, `R5:island_node`)
      }
    }
  }

  return pairs
}

// ─── Phase 3: LLM Batch Classification ───────────────────────────────────────

function buildJudgmentPrompt(pairs: CandidatePair[]): string {
  const pairDescriptions = pairs.map((pair, i) => {
    const { a, b } = pair
    return [
      `Pair ${i + 1}:`,
      `  A: title="${a.title}" entity_type="${a.entityType}" service_scene="${a.serviceScene}" service_category="${a.serviceCategory}" summary="${a.summary.slice(0, 120)}"`,
      `  B: title="${b.title}" entity_type="${b.entityType}" service_scene="${b.serviceScene}" service_category="${b.serviceCategory}" summary="${b.summary.slice(0, 120)}"`,
      `  nomination_reasons: ${pair.reasons.join("; ")}`,
    ].join("\n")
  }).join("\n\n")

  return [
    "You are a knowledge graph relation classifier for an insurance service knowledge base.",
    "For each entity pair below, decide if they have a meaningful relation.",
    "",
    "Output a JSON array with exactly one object per pair. Use ONLY these relation_type values:",
    `same_scene | same_stage | same_category | complements | next_step | prerequisite | part_of | has_part | supports | supported_by | bundled_with | related_to`,
    "",
    "For direction:",
    "  a→b means 'A [relation_type] B' (e.g. A is next_step of B means A follows B)",
    "  b→a means 'B [relation_type] A'",
    "  bidirectional means both directions apply equally",
    "",
    "Be conservative. If unsure, set related=false.",
    "Confidence scale: 0.9+=very confident, 0.82+=confident, 0.65+=plausible, <0.65=uncertain",
    "",
    "Respond ONLY with a JSON array, no prose. Each object must have exactly these keys:",
    "source_title, target_title, related, relation_type, direction, confidence, reason, evidence",
    "",
    "Entity pairs to classify:",
    "",
    pairDescriptions,
    "",
    "JSON output:",
  ].join("\n")
}

async function llmJudgeCandidatePairs(
  pairs: CandidatePair[],
  llmConfig: LlmConfig,
): Promise<{ judgments: RelationJudgment[]; errors: string[] }> {
  const judgments: RelationJudgment[] = []
  const errors: string[] = []

  // Split into batches
  for (let offset = 0; offset < pairs.length; offset += BATCH_SIZE) {
    const batch = pairs.slice(offset, offset + BATCH_SIZE)
    const prompt = buildJudgmentPrompt(batch)

    let rawText = ""
    try {
      await streamChat(
        [{ role: "user", content: prompt }],
        llmConfig,
        (chunk) => { rawText += chunk },
      )
    } catch (err) {
      errors.push(`LLM call failed for batch at offset ${offset}: ${String(err)}`)
      continue
    }

    // Parse JSON from response
    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      errors.push(`No JSON array in LLM response for batch at offset ${offset}. Raw: ${rawText.slice(0, 200)}`)
      continue
    }

    let parsed: unknown[]
    try {
      parsed = JSON.parse(jsonMatch[0]) as unknown[]
    } catch {
      errors.push(`JSON parse failed for batch at offset ${offset}`)
      continue
    }

    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue
      const j = item as Record<string, unknown>

      const judgment: RelationJudgment = {
        source_title:  String(j.source_title  ?? ""),
        target_title:  String(j.target_title  ?? ""),
        related:       Boolean(j.related),
        relation_type: String(j.relation_type ?? "related_to"),
        direction:     (j.direction as RelationJudgment["direction"]) ?? "bidirectional",
        confidence:    typeof j.confidence === "number" ? j.confidence : 0,
        reason:        String(j.reason   ?? ""),
        evidence:      String(j.evidence ?? ""),
      }

      // Enforce whitelist
      if (!ALLOWED_RELATION_TYPES.has(judgment.relation_type)) {
        judgment.relation_type = "related_to"
      }

      if (judgment.source_title && judgment.target_title) {
        judgments.push(judgment)
      }
    }
  }

  return { judgments, errors }
}

// ─── Phase 4: Apply Judgments ─────────────────────────────────────────────────

async function applyRelationJudgments(
  judgments: RelationJudgment[],
  catalogMap: Map<string, EntityEntry>,
): Promise<{ written: number; queued: number; discarded: number; errors: string[] }> {
  let written = 0, queued = 0, discarded = 0
  const errors: string[] = []

  for (const j of judgments) {
    if (!j.related || j.confidence < QUEUE_THRESHOLD) {
      discarded++
      continue
    }
    if (j.confidence < WRITE_THRESHOLD) {
      // TODO: push to review queue when ReviewStore is accessible from lib
      queued++
      continue
    }

    // Determine which entity gets the edge written (based on direction)
    const entries: Array<{ entry: EntityEntry; relType: string; targetTitle: string }> = []

    if (j.direction === "a→b" || j.direction === "bidirectional") {
      const src = catalogMap.get(j.source_title)
      if (src) entries.push({ entry: src, relType: j.relation_type, targetTitle: j.target_title })
    }
    if (j.direction === "b→a" || j.direction === "bidirectional") {
      const tgt = catalogMap.get(j.target_title)
      if (tgt) {
        // Invert relation type for reverse direction
        const inverseType = inverseRelationType(j.relation_type)
        entries.push({ entry: tgt, relType: inverseType, targetTitle: j.source_title })
      }
    }

    for (const { entry, relType, targetTitle } of entries) {
      try {
        const content = await readFile(entry.filePath)
        const updated = injectRelationEdge(content, {
          target:       targetTitle,
          type:         relType,
          provenance:   "llm_inferred",
          confidence:   j.confidence,
          evidence:     j.evidence || j.reason,
          source_files: [],
        })
        if (updated !== content) {
          await writeFile(entry.filePath, updated)
          written++
        }
      } catch (err) {
        errors.push(`Failed to write relation to ${entry.filePath}: ${String(err)}`)
      }
    }
  }

  return { written, queued, discarded, errors }
}

// ─── Edge Injection ───────────────────────────────────────────────────────────

interface RelationEdge {
  target: string
  type: string
  provenance: string
  confidence: number
  evidence: string
  source_files: string[]
}

/**
 * Check whether a (type, target) edge already exists in the content,
 * regardless of whether it was written as a compact list item or a YAML block.
 *
 * Compact:  `  - "complements: 音视频随访"`
 * YAML:     `  - target: "音视频随访"\n    type: complements`
 */
export function hasRelationEdge(content: string, type: string, target: string): boolean {
  // Compact format: the string "type: target" appears somewhere in the content
  if (content.includes(`${type}: ${target}`)) return true
  // YAML block format: target appears on a target: line AND type appears nearby
  const targetRe = new RegExp(`target:\\s*"?${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`, "m")
  if (targetRe.test(content)) {
    // Verify the type field is also present adjacent to this target block
    const typeRe = new RegExp(`type:\\s*${type}\\b`, "m")
    if (typeRe.test(content)) return true
  }
  return false
}

function injectRelationEdge(content: string, edge: RelationEdge): string {
  // Guard: skip if this (type, target) edge already exists in any format
  if (hasRelationEdge(content, edge.type, edge.target)) return content

  // Append compact relation line
  const compactLine = `  - "${edge.type}: ${edge.target}"`

  const edgeYaml = [
    `  - target: "${edge.target}"`,
    `    type: ${edge.type}`,
    `    provenance: ${edge.provenance}`,
    `    confidence: ${edge.confidence.toFixed(2)}`,
    `    evidence: "${edge.evidence.replace(/"/g, "'")}"`,
    `    source_files: []`,
  ].join("\n")

  // Use frontmatter-scoped extraction (same pattern as appendRelationEdges in postprocess)
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!fmMatch) return content

  const [fullFmBlock, open, fm, close] = fmMatch

  // Append to compact relations list
  let newFm = fm
  const relBlockRe = /^(relations:\s*\n(?:\s+-\s+.+\n?)*)/m
  if (relBlockRe.test(fm)) {
    newFm = fm.replace(relBlockRe, (match) => match.trimEnd() + "\n" + compactLine + "\n")
  } else if (/^relations:\s*\[\]$/m.test(fm)) {
    newFm = fm.replace(/^relations:\s*\[\]$/m, `relations:\n${compactLine}`)
  } else {
    newFm = fm.trimEnd() + `\nrelations:\n${compactLine}`
  }

  // Append to relation_edges block
  const existingEdgeRe = /^(relation_edges:[ \t]*\n(?:[ \t]+-[ \t][\s\S]*?\n?)+)/m
  if (existingEdgeRe.test(newFm)) {
    newFm = newFm.replace(existingEdgeRe, (match) => match.trimEnd() + "\n" + edgeYaml + "\n")
  } else {
    newFm = newFm.trimEnd() + `\nrelation_edges:\n${edgeYaml}`
  }

  return content.replace(fullFmBlock, open + newFm + close)
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Run the full Global Relation Pass on a project.
 *
 * Call this AFTER runKnowledgePostProcess() and BEFORE writeExtractionQualityAudit().
 * It is safe to call with signal.aborted — it returns early.
 */
export async function runGlobalRelationPass(
  projectPath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  options?: GlobalRelationPassOptions,
): Promise<GlobalRelationPassResult> {
  const errors: string[] = []

  if (signal?.aborted) {
    return { catalogSize: 0, candidatePairs: 0, llmCallCount: 0, written: 0, queued: 0, discarded: 0, errors }
  }

  // Phase 1
  let catalog: EntityEntry[]
  try {
    catalog = await buildEntityCatalog(projectPath)
  } catch (err) {
    return { catalogSize: 0, candidatePairs: 0, llmCallCount: 0, written: 0, queued: 0, discarded: 0, errors: [String(err)] }
  }

  if (catalog.length < 2) {
    return { catalogSize: catalog.length, candidatePairs: 0, llmCallCount: 0, written: 0, queued: 0, discarded: 0, errors }
  }

  // Phase 2 — only generate pairs involving new entities (if provided)
  // This prevents the exponential re-processing of already-judged pairs on
  // every subsequent ingest call, which was the primary cause of duplicate edges.
  const candidatePairs = generateCandidatePairs(catalog, options?.newEntityTitles)
  if (candidatePairs.length === 0) {
    return { catalogSize: catalog.length, candidatePairs: 0, llmCallCount: 0, written: 0, queued: 0, discarded: 0, errors }
  }

  if (signal?.aborted) {
    return { catalogSize: catalog.length, candidatePairs: candidatePairs.length, llmCallCount: 0, written: 0, queued: 0, discarded: 0, errors }
  }

  // Phase 3
  const { judgments, errors: llmErrors } = await llmJudgeCandidatePairs(candidatePairs, llmConfig)
  errors.push(...llmErrors)

  const llmCallCount = Math.ceil(candidatePairs.length / BATCH_SIZE)

  // Phase 4
  const catalogMap = new Map(catalog.map(e => [e.title, e]))
  const { written, queued, discarded, errors: applyErrors } = await applyRelationJudgments(judgments, catalogMap)
  errors.push(...applyErrors)

  console.log(`[global-relation-pass] catalog=${catalog.length} pairs=${candidatePairs.length} calls=${llmCallCount} written=${written} queued=${queued} discarded=${discarded}`)

  return { catalogSize: catalog.length, candidatePairs: candidatePairs.length, llmCallCount, written, queued, discarded, errors }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scalar(text: string, key: string): string {
  const m = text.match(new RegExp(`^${escRe(key)}:\\s*"?([^"\\n]+)"?\\s*$`, "m"))
  return m ? m[1].trim() : ""
}

function scalarBlock(text: string, key: string): string {
  // For attributes written as YAML block
  const m = text.match(new RegExp(`^${escRe(key)}:\\s*(.+)$`, "m"))
  return m ? m[1].trim().replace(/^"|"$/g, "") : ""
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function inverseRelationType(type: string): string {
  const inverses: Record<string, string> = {
    part_of: "has_part",
    has_part: "part_of",
    next_step: "prerequisite",
    prerequisite: "next_step",
    supports: "supported_by",
    supported_by: "supports",
  }
  return inverses[type] ?? type
}
