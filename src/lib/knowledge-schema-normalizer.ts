import {
  ENTITY_TYPE_DOMAIN,
  ENTITY_TYPE_TO_UNIVERSAL_TYPE,
  type KnowledgeEntityType,
  type UniversalEntityType,
} from "@/lib/knowledge-schema"
import {
  inferSourceTypeFromSourceName,
  inferStableInsuranceDedupKey,
} from "@/lib/insurance-schema-registry"
import type { KnowledgeStatus } from "@/lib/knowledge-governance"

interface NormalizeOptions {
  relativePath?: string
  sourceFileName?: string
  defaultStatus?: KnowledgeStatus
  defaultCreatedBy?: string
}

type FieldValue = string | number | boolean | string[]

const STRUCTURAL_PAGE_NAMES = new Set(["index.md", "log.md", "overview.md"])

export function shouldNormalizeKnowledgePage(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/")
  const fileName = normalized.split("/").pop() ?? ""
  return normalized.startsWith("wiki/") &&
    normalized.endsWith(".md") &&
    !normalized.includes("/media/") &&
    !STRUCTURAL_PAGE_NAMES.has(fileName)
}

export function normalizeSchemaFrontmatter(content: string, options: NormalizeOptions = {}): string {
  const body = extractBody(content)
  const existing = extractFrontmatter(content)
  const title = getField(existing, "title") || extractTitle(body, options.relativePath)
  const entityType = inferEntityType(existing, options.relativePath)
  const knowledgeDomain = getField(existing, "knowledge_domain") ||
    getField(existing, "domain") ||
    ENTITY_TYPE_DOMAIN[entityType] ||
    "general"
  const universalType = inferUniversalType(existing, entityType)
  const status = getField(existing, "status") || options.defaultStatus || "candidate"
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const createdBy = getField(existing, "created_by") ||
    getField(existing, "ingested_by_user") ||
    options.defaultCreatedBy ||
    "system"

  const defaults: Record<string, FieldValue> = {
    schema_version: "2.1",
    industry: getField(existing, "industry") || "insurance",
    knowledge_domain: knowledgeDomain,
    domain: knowledgeDomain,
    taxonomy_path: inferTaxonomyPath(existing, knowledgeDomain, entityType),
    type: universalType,
    entity_type: entityType,
    business_phase: "general",
    dedup_key: inferDedupKey(existing, title, entityType, options.relativePath),
    title,
    summary: "",
    created_at: getField(existing, "created") || date,
    updated_at: getField(existing, "updated") || date,
    created: date,
    updated: date,
    tags: [],
    keywords: [],
    related: [],
    relations: [],
    parent: "",
    children: [],
    source_files: options.sourceFileName ? [options.sourceFileName] : [],
    source_chunks: [],
    sources: options.sourceFileName ? [options.sourceFileName] : [],
    source_type: getField(existing, "source_type") || inferSourceTypeFromSourceName(options.sourceFileName || firstYamlListValue(existing, "source_files") || firstYamlListValue(existing, "sources")),
    confidence: 0.7,
    status,
    needs_review: status !== "active",
    created_by: createdBy,
    attributes: "{}",
    claims: [],
  }

  const normalizedFrontmatter = upsertMissingFrontmatterFields(content, defaults)
  return normalizedFrontmatter
}

function extractFrontmatter(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
}

function extractBody(content: string): string {
  return content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/m)?.[1] ?? content
}

function upsertMissingFrontmatterFields(content: string, defaults: Record<string, FieldValue>): string {
  const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/m.test(content)
  const lines = Object.entries(defaults)
    .filter(([key]) => !hasYamlKey(content, key))
    .map(([key, value]) => `${key}: ${formatYamlValue(value)}`)

  if (lines.length === 0) return content

  if (!hasFrontmatter) {
    return ["---", ...lines, "---", "", content].join("\n")
  }

  return content.replace(/^(---\r?\n)/, `$1${lines.join("\n")}\n`)
}

function hasYamlKey(content: string, key: string): boolean {
  const frontmatter = extractFrontmatter(content)
  return new RegExp(`^${escapeRegExp(key)}\\s*:`, "m").test(frontmatter)
}

function getField(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`, "m"))
  return match ? stripQuotes(match[1]) : ""
}

function inferEntityType(frontmatter: string, relativePath?: string): KnowledgeEntityType {
  const explicit = normalizeEntityType(getField(frontmatter, "entity_type"))
  if (explicit) return explicit

  const legacyType = normalizeLegacyEntityType(getField(frontmatter, "type"))
  if (legacyType) return legacyType

  const path = relativePath?.replace(/\\/g, "/") ?? ""
  if (path.includes("/sources/")) return "source"
  if (path.includes("/concepts/")) return "concept"
  if (path.includes("/entities/")) return "entity"
  if (path.includes("/products/")) return "product"
  if (path.includes("/customers/")) return "persona"
  if (path.includes("/methods/")) return "selling_scenario"
  return "general"
}

function inferUniversalType(frontmatter: string, entityType: KnowledgeEntityType): UniversalEntityType {
  const explicit = normalizeUniversalType(getField(frontmatter, "type"))
  if (explicit) return explicit
  return ENTITY_TYPE_TO_UNIVERSAL_TYPE[entityType] || "concept"
}

function normalizeEntityType(value: string): KnowledgeEntityType | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  return normalized || null
}

function normalizeLegacyEntityType(value: string): KnowledgeEntityType | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const known: KnowledgeEntityType[] = [
    "product", "product_combo", "selling_point", "persona", "life_stage", "customer_signal",
    "selling_scenario", "pitch", "objection_handling", "sales_path", "sales_playbook",
    "referral_method", "asset", "asset_collection", "campaign", "success_case", "failure_case",
    "customer_voice", "referral_case", "agent_feedback", "competitive_insight", "compliance_rule",
    "regulatory_doc", "needs_discovery", "customer_relationship", "content_template",
    "presentation_kit", "incentive", "source", "concept", "entity", "general",
  ]
  return known.includes(normalized as KnowledgeEntityType) ? normalized as KnowledgeEntityType : null
}

function normalizeUniversalType(value: string): UniversalEntityType | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const known: UniversalEntityType[] = [
    "concept", "entity", "event", "process", "rule", "data", "comparison", "timeline",
    "case", "source", "query", "synthesis", "general",
  ]
  return known.includes(normalized as UniversalEntityType) ? normalized as UniversalEntityType : null
}

function inferTaxonomyPath(frontmatter: string, knowledgeDomain: string, entityType: string): string[] {
  const existing = getField(frontmatter, "taxonomy_path")
  if (existing) return []
  const path = [knowledgeDomain, entityType]
    .map((item) => item.trim())
    .filter((item, index, arr) => item && arr.indexOf(item) === index && item !== "general")
  return path.length > 0 ? path : ["general"]
}

function inferDedupKey(frontmatter: string, title: string, entityType: string, relativePath?: string): string {
  const existing = getField(frontmatter, "dedup_key")
  if (existing) return existing
  const fromPath = relativePath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/, "")
  const attributes = parseAttributes(frontmatter)
  return inferStableInsuranceDedupKey({
    entityType,
    title,
    attributes,
    fallback: fromPath || title || "untitled",
  })
}

function parseAttributes(frontmatter: string): Record<string, unknown> {
  const raw = getField(frontmatter, "attributes")
  if (!raw || raw === "{}") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function firstYamlListValue(frontmatter: string, key: string): string {
  const inline = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)]`, "m"))
  if (inline) {
    return inline[1].split(",").map((item) => stripQuotes(item.trim())).find(Boolean) ?? ""
  }
  const block = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"))
  if (!block) return ""
  for (const line of block[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/)
    if (item) return stripQuotes(item[1].trim())
  }
  return ""
}

function extractTitle(body: string, relativePath?: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading
  const fileName = relativePath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/, "")
  return fileName ? fileName.replace(/-/g, " ") : "Untitled"
}

function formatYamlValue(value: FieldValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => quoteYaml(item)).join(", ")}]`
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === "{}") return "{}"
  return quoteYaml(value)
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim()
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || "untitled"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
