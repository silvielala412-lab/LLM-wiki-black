import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import {
  ENTITY_TYPE_DOMAIN,
  RELATION_INVERSE_LABELS,
  type BusinessPhase,
  type KnowledgeDomain,
  type KnowledgeEntityType,
  type KnowledgeRelation,
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

    for (const related of page.related) {
      const target = resolveTarget(related, byId, byTitle)
      pushRelation(relations, seen, page, target, related, "related_to", 0.8, "llm")
    }

    const parent = frontmatterString(parsed.frontmatter, "parent")
    if (parent) {
      const target = resolveTarget(parent, byId, byTitle)
      pushRelation(relations, seen, page, target, parent, "child_of", 0.9, "llm")
    }

    for (const child of frontmatterList(parsed.frontmatter, "children")) {
      const target = resolveTarget(child, byId, byTitle)
      pushRelation(relations, seen, page, target, child, "parent_of", 0.9, "llm")
    }

    for (const link of extractWikilinks(parsed.body)) {
      const target = resolveTarget(link, byId, byTitle)
      pushRelation(relations, seen, page, target, link, "mentions", 0.7, "system")
    }

    for (const relationLine of frontmatterList(parsed.frontmatter, "relations")) {
      const parsedRelation = parseCompactRelation(relationLine)
      if (!parsedRelation) continue
      const target = resolveTarget(parsedRelation.target, byId, byTitle)
      pushRelation(
        relations,
        seen,
        page,
        target,
        parsedRelation.target,
        parsedRelation.type,
        parsedRelation.confidence,
        "llm",
      )
    }
  }

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

  return dedupeRelationViews(views).sort((a, b) =>
    a.display_title.localeCompare(b.display_title, "zh-CN"),
  )
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md") && !normalizePath(node.path).includes("/wiki/media/")) {
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

function pushRelation(
  relations: KnowledgeRelation[],
  seen: Set<string>,
  source: KnowledgeIndexPage,
  target: KnowledgeIndexPage | null,
  targetLabel: string,
  type: RelationType,
  confidence: number,
  createdBy: "llm" | "system" | "user",
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
    confidence,
    evidence_refs: [],
    created_at: new Date().toISOString(),
    created_by: createdBy,
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
