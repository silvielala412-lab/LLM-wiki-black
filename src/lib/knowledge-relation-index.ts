import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import {
  ENTITY_TYPE_DOMAIN,
  RELATION_INVERSE_LABELS,
  RELATION_QUERY_AFFINITY,
  RELATION_TYPE_SCORES,
  RELATION_SOURCE_CONFIDENCE,
  type BusinessPhase,
  type KnowledgeDomain,
  type KnowledgeEntityType,
  type KnowledgeRelation,
  type RelationProvenance,
  type RelationType,
} from "@/lib/knowledge-schema"
import {
  frontmatterList,
  frontmatterString,
  parseMarkdownFrontmatter,
} from "@/lib/knowledge-frontmatter"

export interface KnowledgeIndexPage {
  id: string
  path: string
  title: string
  type: string
  domain: KnowledgeDomain
  entityType: KnowledgeEntityType
  businessPhase: BusinessPhase
  related: string[]
}

export interface KnowledgeRelationView extends KnowledgeRelation {
  direction: "outbound" | "inbound"
  display_title: string
  display_path?: string
  display_id: string
  display_type: string
}

export interface KnowledgeRelationIndex {
  pages: KnowledgeIndexPage[]
  relations: KnowledgeRelation[]
}

export type RelationQueryIntent = keyof typeof RELATION_QUERY_AFFINITY

export interface GraphExpansionOptions {
  /** Minimum composite score. Edges below this are dropped. Default: 0.25. */
  minScore?: number
  /** Include outbound edges (entity → target). Default: true. */
  includeOutbound?: boolean
  /** Include inbound edges (other → entity). Default: false. */
  includeInbound?: boolean
  /** Fall back to 'general' intent when no intent-specific edges found. Default: true. */
  fallbackToGeneral?: boolean
  /** Restrict expansion to these entity types. Empty = no restriction. */
  allowedEntityTypes?: string[]
}

export interface GraphExpansionResult {
  /** Resolved peer page (null if target not in index). */
  targetPage: KnowledgeIndexPage | null
  /** The scored relation edge. */
  relation: KnowledgeRelation
  /** Direction from the seed entity's perspective. */
  direction: "outbound" | "inbound"
}

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

export async function buildKnowledgeRelationIndex(projectPath: string): Promise<KnowledgeRelationIndex> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot) as FileNode[]
  } catch {
    return { pages: [], relations: [] }
  }

  const mdFiles = flattenMdFiles(tree)
  const pages: KnowledgeIndexPage[] = []
  const pageContent = new Map<string, string>()

  for (const file of mdFiles) {
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    const parsed = parseMarkdownFrontmatter(content)
    const entityType = normalizeEntityType(frontmatterString(parsed.frontmatter, "entity_type"))
    const domain = normalizeDomain(
      frontmatterString(parsed.frontmatter, "knowledge_domain") ||
      frontmatterString(parsed.frontmatter, "domain") ||
      ENTITY_TYPE_DOMAIN[entityType] ||
      "general",
    )
    const page: KnowledgeIndexPage = {
      id: pageIdFromPath(file.path),
      path: normalizePath(file.path),
      title: extractTitle(content, file.name),
      type: frontmatterString(parsed.frontmatter, "type") || "concept",
      domain,
      entityType,
      businessPhase: normalizeBusinessPhase(frontmatterString(parsed.frontmatter, "business_phase")),
      related: frontmatterList(parsed.frontmatter, "related"),
    }
    pages.push(page)
    pageContent.set(page.path, content)
  }

  const byId = new Map(pages.map((page) => [page.id, page]))
  const byTitle = new Map<string, KnowledgeIndexPage>()
  for (const page of pages) {
    byTitle.set(normalizeLookup(page.title), page)
    byTitle.set(normalizeLookup(page.id), page)
  }

  const relations: KnowledgeRelation[] = []
  const seen = new Set<string>()

  for (const page of pages) {
    const content = pageContent.get(page.path) ?? ""
    const parsed = parseMarkdownFrontmatter(content)

    // Page-level confidence for quality weighting
    const pageConf = parseFloat(frontmatterString(parsed.frontmatter, "confidence") ?? "0.75") || 0.75

    for (const related of page.related) {
      const target = resolveTarget(related, byId, byTitle)
      const scores = computeRelationScore("related_to", "llm", false, pageConf)
      pushRelation(relations, seen, page, target, related, "related_to", scores, "llm", [])
    }

    const parent = frontmatterString(parsed.frontmatter, "parent")
    if (parent) {
      const target = resolveTarget(parent, byId, byTitle)
      const scores = computeRelationScore("child_of", "llm", false, pageConf)
      pushRelation(relations, seen, page, target, parent, "child_of", scores, "llm", [])
    }

    for (const child of frontmatterList(parsed.frontmatter, "children")) {
      const target = resolveTarget(child, byId, byTitle)
      const scores = computeRelationScore("parent_of", "llm", false, pageConf)
      pushRelation(relations, seen, page, target, child, "parent_of", scores, "llm", [])
    }

    for (const link of extractWikilinks(parsed.body)) {
      const target = resolveTarget(link, byId, byTitle)
      const scores = computeRelationScore("mentions", "system", false, pageConf)
      pushRelation(relations, seen, page, target, link, "mentions", scores, "system", [])
    }

    for (const relationLine of frontmatterList(parsed.frontmatter, "relations")) {
      const parsedRelation = parseCompactRelation(relationLine)
      if (!parsedRelation) continue
      const target = resolveTarget(parsedRelation.target, byId, byTitle)
      const hasEvidence = frontmatterList(parsed.frontmatter, "claims").length > 0
      const scores = computeRelationScore(parsedRelation.type, "llm", hasEvidence, pageConf)
      pushRelation(
        relations, seen, page, target, parsedRelation.target,
        parsedRelation.type, scores, "llm",
        hasEvidence ? frontmatterList(parsed.frontmatter, "source_files") : [],
      )
    }

    // Read relation_edges: structured YAML block (written by postprocess harvestRelationCandidates).
    // These have full provenance metadata and supersede compact relations: entries of the same edge.
    // Priority: user_confirmed > explicit_ingest > postprocess_inferred (all higher than wikilink).
    for (const edge of parseRelationEdgesBlock(parsed.frontmatter)) {
      const target = resolveTarget(edge.target, byId, byTitle)
      const prov: RelationProvenance =
        edge.provenance === "user_confirmed"      ? "user_confirmed"      :
        edge.provenance === "explicit_ingest"     ? "explicit_ingest"     :
        edge.provenance === "postprocess_inferred"? "explicit"            :
        "explicit"
      const scores = computeRelationScoreByProvenance(
        edge.type as RelationType, prov, edge.confidence > 0.8, pageConf,
      )
      // Override score with the stored confidence directly for user_confirmed / explicit_ingest
      const finalScore = { ...scores, confidence: Math.min(1, edge.confidence), score: Math.min(1, edge.confidence) * scores.strength }
      pushRelationWithProvenance(
        relations, seen, page, target, edge.target,
        edge.type as RelationType, finalScore, "system",
        edge.source_files ?? [],
        prov,
      )
    }
  }

  // ── FIELD_DERIVED inference pass ───────────────────────────────────────────────────────
  // Infer lateral relations from structural fields (service_category, service_scene,
  // business_phase). Avoids full-clique noise by applying topK per source node.
  // Only connects pages of the same domain + entity_type to prevent cross-domain leakage.
  const FIELD_DERIVED_TOP_K = 5 // max lateral edges per source node per field

  interface FieldGroupConfig {
    field: string
    relationType: RelationType
    topK: number
  }
  const fieldGroups: FieldGroupConfig[] = [
    { field: "service_category",  relationType: "same_category",        topK: FIELD_DERIVED_TOP_K },
    { field: "service_scene",     relationType: "same_scene",           topK: FIELD_DERIVED_TOP_K },
    { field: "business_phase",    relationType: "adjacent_in_process",  topK: 3 },
  ]

  for (const { field, relationType, topK } of fieldGroups) {
    // Build groups: fieldValue → pages that have this value
    const groups = new Map<string, KnowledgeIndexPage[]>()
    for (const page of pages) {
      const content = pageContent.get(page.path) ?? ""
      const parsed = parseMarkdownFrontmatter(content)
      // Read from attributes JSON blob first, then frontmatter scalar
      let fieldVal = ""
      const attrsRaw = frontmatterString(parsed.frontmatter, "attributes")
      if (attrsRaw) {
        try {
          const attrs = JSON.parse(attrsRaw) as Record<string, unknown>
          fieldVal = (attrs[field] as string | undefined) ?? ""
        } catch { /* ignore */ }
      }
      if (!fieldVal) fieldVal = frontmatterString(parsed.frontmatter, field)
      if (!fieldVal || fieldVal === "null") continue
      const groupKey = `${page.domain}:::${page.entityType}:::${fieldVal.trim()}`
      if (!groups.has(groupKey)) groups.set(groupKey, [])
      groups.get(groupKey)!.push(page)
    }

    // For each group, emit topK lateral edges per source node
    for (const group of groups.values()) {
      if (group.length < 2) continue // singleton groups produce no edges
      for (const source of group) {
        const sourcePageConf = parseFloat(
          frontmatterString(
            parseMarkdownFrontmatter(pageContent.get(source.path) ?? "").frontmatter,
            "confidence",
          ) ?? "0.6"
        ) || 0.6
        const candidates = group
          .filter(p => p.id !== source.id)
          // Sort candidates: prefer higher-confidence pages as neighbors
          .sort((a, b) => {
            const confA = parseFloat(frontmatterString(parseMarkdownFrontmatter(pageContent.get(a.path) ?? "").frontmatter, "confidence") ?? "0.6") || 0.6
            const confB = parseFloat(frontmatterString(parseMarkdownFrontmatter(pageContent.get(b.path) ?? "").frontmatter, "confidence") ?? "0.6") || 0.6
            return confB - confA
          })
          .slice(0, topK)

        for (const target of candidates) {
          const scores = computeRelationScoreByProvenance(relationType, "field_derived", false, sourcePageConf)
          pushRelationWithProvenance(
            relations, seen, source, target, target.title,
            relationType, scores, "system", [], "field_derived",
          )
        }
      }
    }
  }

  // Sort by score descending so RAG/Agent always gets highest-priority edges first
  relations.sort((a, b) => b.score - a.score)

  return { pages, relations }
}

export function relationsForPage(
  index: KnowledgeRelationIndex,
  pagePath: string,
): KnowledgeRelationView[] {
  const page = index.pages.find((item) => normalizePath(item.path) === normalizePath(pagePath))
  if (!page) return []

  const byId = new Map(index.pages.map((item) => [item.id, item]))
  const views: KnowledgeRelationView[] = []

  for (const relation of index.relations) {
    if (relation.source_id === page.id) {
      const target = byId.get(relation.target_id)
      views.push({
        ...relation,
        direction: "outbound",
        display_id: relation.target_id,
        display_title: target?.title ?? relation.target_title ?? relation.target_id,
        display_path: target?.path ?? relation.target_path,
        display_type: relation.type,
      })
    } else if (relation.target_id === page.id || (relation.bidirectional && relation.source_id !== page.id && relation.target_id === page.id)) {
      const source = byId.get(relation.source_id)
      views.push({
        ...relation,
        direction: "inbound",
        display_id: relation.source_id,
        display_title: source?.title ?? relation.source_title ?? relation.source_id,
        display_path: source?.path ?? relation.source_path,
        display_type: relation.inverse_type ?? RELATION_INVERSE_LABELS[relation.type] ?? "related_from",
      })
    }
  }

  // P0: Sort by score desc, then confidence, then title for stable ordering.
  return dedupeRelationViews(views).sort((a, b) =>
    (b.score - a.score) ||
    (b.confidence - a.confidence) ||
    a.display_title.localeCompare(b.display_title, "zh-CN"),
  )
}

/**
 * Core RAG/Agent graph expansion API.
 *
 * Returns the top-K most relevant relation edges for a seed entity,
 * filtered by query intent and scored by confidence × strength.
 *
 * @param index       Pre-built index from buildKnowledgeRelationIndex().
 * @param entityId    Page ID as returned by index.pages[n].id.
 * @param queryIntent Intent key from RELATION_QUERY_AFFINITY.
 * @param topK        Maximum edges to return.
 * @param options     Expansion constraints.
 */
export function expandGraphFromEntity(
  index: KnowledgeRelationIndex,
  entityId: string,
  queryIntent: string,
  topK: number,
  options: GraphExpansionOptions = {},
): GraphExpansionResult[] {
  const {
    minScore = 0.25,
    includeOutbound = true,
    includeInbound = false,
    fallbackToGeneral = true,
    allowedEntityTypes = [],
  } = options

  const byId = new Map(index.pages.map((p) => [p.id, p]))
  if (!byId.has(entityId) || topK <= 0) return []

  const preferredTypes = new Set(RELATION_QUERY_AFFINITY[queryIntent] ?? [])
  const generalTypes   = new Set(RELATION_QUERY_AFFINITY["general"] ?? [])

  // Collect candidates — try preferred types first, fall back to general if empty
  let rawCandidates = collectExpansionCandidates(
    index, entityId, preferredTypes, includeInbound, includeOutbound, minScore,
  )
  if (rawCandidates.length === 0 && fallbackToGeneral) {
    rawCandidates = collectExpansionCandidates(
      index, entityId, generalTypes, includeInbound, includeOutbound, minScore,
    )
  }

  // Build GraphExpansionResult[] with resolved peer page and direction
  const results: GraphExpansionResult[] = rawCandidates
    .filter((relation) => {
      if (allowedEntityTypes.length === 0) return true
      const isOutbound = relation.source_id === entityId
      const peerId = isOutbound ? relation.target_id : relation.source_id
      const peer = byId.get(peerId)
      return !peer || allowedEntityTypes.includes(peer.entityType)
    })
    .map((relation) => {
      const isOutbound = relation.source_id === entityId
      const peerId = isOutbound ? relation.target_id : relation.source_id
      return {
        targetPage: byId.get(peerId) ?? null,
        relation,
        direction: (isOutbound ? "outbound" : "inbound") as "outbound" | "inbound",
      }
    })

  return results
    .sort((a, b) =>
      (b.relation.score - a.relation.score) ||
      (b.relation.confidence - a.relation.confidence) ||
      (a.targetPage?.title ?? "").localeCompare(b.targetPage?.title ?? "", "zh-CN"),
    )
    .slice(0, topK)
}

function collectExpansionCandidates(
  index: KnowledgeRelationIndex,
  pageId: string,
  allowedTypes: Set<RelationType>,
  includeInbound: boolean,
  includeOutbound: boolean,
  minScore: number,
): KnowledgeRelation[] {
  return index.relations.filter((relation) => {
    if (relation.score < minScore) return false
    if (allowedTypes.size > 0 && !allowedTypes.has(relation.type)) return false
    const outbound = relation.source_id === pageId
    const inbound  = relation.target_id === pageId
    return (includeOutbound && outbound) || (includeInbound && inbound)
  })
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (
      !node.is_dir &&
      node.name.endsWith(".md") &&
      !node.name.endsWith(".md.md") &&
      !normalizePath(node.path).includes("/wiki/media/")
    ) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  const parsed = parseMarkdownFrontmatter(content)
  const frontmatterTitle = frontmatterString(parsed.frontmatter, "title")
  if (frontmatterTitle) return frontmatterTitle
  const headingMatch = parsed.body.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function computeRelationScore(
  type: RelationType,
  createdBy: "llm" | "system" | "user",
  hasEvidence: boolean,
  pageConfidence: number,
): { confidence: number; strength: number; score: number } {
  return computeRelationScoreByProvenance(type,
    createdBy === "system" ? "explicit" : createdBy === "user" ? "user_confirmed" : "explicit",
    hasEvidence, pageConfidence
  )
}

function computeRelationScoreByProvenance(
  type: RelationType,
  provenance: RelationProvenance,
  hasEvidence: boolean,
  pageConfidence: number,
): { confidence: number; strength: number; score: number } {
  const typeScore = RELATION_TYPE_SCORES[type] ?? { confidence_base: 0.60, strength: 0.45 }
  const sourceFactor = RELATION_SOURCE_CONFIDENCE[provenance] ?? RELATION_SOURCE_CONFIDENCE["explicit"]
  const evidenceFactor = hasEvidence ? 1.08 : 1.0
  const pageQualityFactor = pageConfidence >= 0.85 ? 1.05 : pageConfidence < 0.6 ? 0.90 : 1.0
  const confidence = Math.min(1, typeScore.confidence_base * sourceFactor * evidenceFactor * pageQualityFactor)
  const strength = typeScore.strength
  return { confidence, strength, score: confidence * strength }
}

function pushRelation(
  relations: KnowledgeRelation[],
  seen: Set<string>,
  source: KnowledgeIndexPage,
  target: KnowledgeIndexPage | null,
  targetLabel: string,
  type: RelationType,
  scores: { confidence: number; strength: number; score: number },
  createdBy: "llm" | "system" | "user",
  evidenceRefs: string[],
): void {
  pushRelationWithProvenance(relations, seen, source, target, targetLabel, type, scores, createdBy, evidenceRefs,
    createdBy === "system" ? "explicit" : createdBy === "user" ? "user_confirmed" : "explicit"
  )
}

/**
 * Extended push with explicit provenance tagging.
 * All new code should call this; the untyped pushRelation is kept for backward compat.
 */
function pushRelationWithProvenance(
  relations: KnowledgeRelation[],
  seen: Set<string>,
  source: KnowledgeIndexPage,
  target: KnowledgeIndexPage | null,
  targetLabel: string,
  type: RelationType,
  scores: { confidence: number; strength: number; score: number },
  createdBy: "llm" | "system" | "user",
  evidenceRefs: string[],
  provenance: RelationProvenance,
): void {
  const targetId = target?.id ?? slugId(targetLabel)
  if (!targetId || targetId === source.id) return

  const key = `${source.id}:::${targetId}:::${type}`
  if (seen.has(key)) return
  seen.add(key)

  relations.push({
    id: key,
    source_id: source.id,
    target_id: targetId,
    source_path: source.path,
    target_path: target?.path,
    source_title: source.title,
    target_title: target?.title ?? targetLabel,
    type,
    inverse_type: RELATION_INVERSE_LABELS[type],
    bidirectional: true,
    confidence: scores.confidence,
    strength: scores.strength,
    score: scores.score,
    evidence_refs: evidenceRefs,
    created_at: new Date().toISOString(),
    created_by: createdBy,
    provenance,
  })
}

function parseCompactRelation(raw: string): { type: RelationType; target: string; confidence: number } | null {
  const compact = raw.match(/^([a-z_]+)\s*:\s*(.+)$/i)
  if (compact) {
    return {
      type: normalizeRelationType(compact[1]),
      target: compact[2].trim(),
      confidence: 0.8,
    }
  }

  const arrow = raw.match(/^(.+?)\s*->\s*([a-z_]+)\s*->\s*(.+)$/i)
  if (arrow) {
    return {
      type: normalizeRelationType(arrow[2]),
      target: arrow[3].trim(),
      confidence: 0.8,
    }
  }

  return null
}

function resolveTarget(
  raw: string,
  byId: Map<string, KnowledgeIndexPage>,
  byTitle: Map<string, KnowledgeIndexPage>,
): KnowledgeIndexPage | null {
  const direct = byId.get(raw)
  if (direct) return direct
  return byTitle.get(normalizeLookup(raw)) ?? null
}

function pageIdFromPath(path: string): string {
  return normalizePath(path).split("/wiki/").pop()?.replace(/\.md$/, "") ?? slugId(path)
}

function slugId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "")
}

function normalizeLookup(value: string): string {
  return slugId(value).replace(/-/g, "")
}

function normalizeDomain(value: string): KnowledgeDomain {
  const normalized = value.trim().toLowerCase()
  return normalized || "general"
}

function normalizeEntityType(value: string): KnowledgeEntityType {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  return normalized || "general"
}

function normalizeBusinessPhase(value: string): BusinessPhase {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const known: BusinessPhase[] = ["lead_generation", "first_touch", "appointment", "conversion", "signing", "service", "referral", "general"]
  return known.includes(normalized as BusinessPhase) ? normalized as BusinessPhase : "general"
}

function normalizeRelationType(value: string): RelationType {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const known: RelationType[] = [
    "related_to", "mentions", "applies_to", "recommended_for", "supports", "conflicts_with",
    "updates", "supersedes", "governed_by", "derived_from", "uses_asset", "has_evidence",
    "parent_of", "child_of", "refines", "maps_to", "fills_gap_for", "describes", "described_by",
    "part_of", "has_part", "mitigated_by", "mitigates", "governs", "not_recommended_for",
    "defines", "defined_by", "supported_by", "has_recommendation", "uses_pitch", "used_by_pitch",
    "uses_objection_handling", "used_by_objection_handling", "targets_persona", "targeted_by",
    "requires_review", "review_required_by", "bundled_with", "complements",
  ]
  return known.includes(normalized as RelationType) ? normalized as RelationType : "related_to"
}

function dedupeRelationViews(items: KnowledgeRelationView[]): KnowledgeRelationView[] {
  const seen = new Set<string>()
  const result: KnowledgeRelationView[] = []
  for (const item of items) {
    const key = `${item.display_id}:::${item.display_type}:::${item.direction}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function resolvePageForExpansion(index: KnowledgeRelationIndex, entityId: string): KnowledgeIndexPage | null {
  const normalizedId = normalizeLookup(entityId)
  return index.pages.find((page) =>
    page.id === entityId ||
    page.path === normalizePath(entityId) ||
    normalizeLookup(page.id) === normalizedId ||
    normalizeLookup(page.title) === normalizedId
  ) ?? null
}

/**
 * Parse the structured `relation_edges:` YAML block from a page's frontmatter.
 * Returns typed edge objects with provenance, confidence, evidence, and source_files.
 * Written by postprocess harvestRelationCandidates; read here to build the relation index
 * with accurate confidence values instead of re-deriving them from the compact string form.
 */
function parseRelationEdgesBlock(frontmatter: string): Array<{
  target: string
  type: string
  provenance: string
  confidence: number
  evidence: string
  source_files: string[]
}> {
  // Match the relation_edges: block (multi-line YAML list)
  const block = frontmatter.match(/^relation_edges:\s*\n((?:\s+-[\s\S]*?(?=\n\S|\n*$))+)/m)?.[1]
  if (!block) return []

  const results: ReturnType<typeof parseRelationEdgesBlock> = []

  // Split into individual list entries (each starts with "  - ")
  const rawEntries = block.split(/\n(?=\s+-)/)
  for (const entry of rawEntries) {
    const target = entry.match(/target:\s*['""]?([^'""\n]+)['""]?/)?.[1]?.trim().replace(/^"|"$/g, "")
    const type   = entry.match(/\btype:\s*([^\n]+)/)?.[1]?.trim()
    if (!target || !type) continue

    const provenance = entry.match(/provenance:\s*([^\n]+)/)?.[1]?.trim() ?? "explicit_ingest"
    const confidenceRaw = entry.match(/confidence:\s*([\d.]+)/)?.[1]
    const confidence = confidenceRaw ? parseFloat(confidenceRaw) : 0.75
    const evidence = entry.match(/evidence:\s*['""]?([^'""\n]*)['""]?/)?.[1]?.trim() ?? ""
    const sfRaw = entry.match(/source_files:\s*\[([^\]]*)\]/)?.[1] ?? ""
    const source_files = sfRaw ? sfRaw.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : []

    results.push({ target, type, provenance, confidence, evidence, source_files })
  }
  return results
}
