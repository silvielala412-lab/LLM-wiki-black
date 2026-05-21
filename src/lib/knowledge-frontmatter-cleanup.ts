import {
  ENTITY_TYPE_DOMAIN,
  ENTITY_TYPE_TO_UNIVERSAL_TYPE,
  type RelationType,
} from "@/lib/knowledge-schema"

interface YamlBlock {
  key: string
  lines: string[]
}

const LIST_FIELDS = new Set([
  "tags",
  "keywords",
  "related",
  "relations",
  "children",
  "source_files",
  "source_chunks",
  "sources",
  "claims",
])

const SCALAR_KEEP_FIRST = new Set([
  "status",
  "confidence",
  "needs_review",
])

const RELATION_TYPES = new Set<RelationType>([
  "related_to",
  "mentions",
  "applies_to",
  "recommended_for",
  "supports",
  "conflicts_with",
  "updates",
  "supersedes",
  "governed_by",
  "derived_from",
  "uses_asset",
  "has_evidence",
  "parent_of",
  "child_of",
  "refines",
  "maps_to",
  "fills_gap_for",
  "describes",
  "described_by",
  "part_of",
  "has_part",
  "mitigated_by",
  "mitigates",
  "governs",
  "not_recommended_for",
  "defines",
  "defined_by",
  "supported_by",
  "has_recommendation",
  "uses_pitch",
  "used_by_pitch",
  "uses_objection_handling",
  "used_by_objection_handling",
  "targets_persona",
  "targeted_by",
  "requires_review",
  "review_required_by",
  "bundled_with",
  "complements",
])

const CANONICAL_TARGETS: Record<string, string> = {
  "家庭支柱": "家庭经济支柱",
  "服务权益合规审查": "服务权益合规边界",
  "体检异常后的健康风险沟通": "健康风险沟通",
}

export function cleanupKnowledgeFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m)
  if (!match) return content

  const yaml = match[1]
  const body = match[2] ?? ""
  const blocks = parseYamlBlocks(yaml)
  if (blocks.length === 0) return content

  const listValues = new Map<string, string[]>()
  const scalarValues = new Map<string, string>()
  const objectValues = new Map<string, string>()

  for (const block of blocks) {
    if (LIST_FIELDS.has(block.key)) {
      const merged = [...(listValues.get(block.key) ?? []), ...extractListValues(block)]
      listValues.set(block.key, dedupe(merged))
      continue
    }

    const value = blockValue(block)
    if (block.key === "attributes") {
      objectValues.set(block.key, normalizeAttributesValue(value))
      continue
    }

    if (!value && scalarValues.has(block.key)) continue
    if (SCALAR_KEEP_FIRST.has(block.key) && scalarValues.has(block.key)) continue
    scalarValues.set(block.key, value)
  }

  const corrected = applyBusinessCorrections(scalarValues, listValues, objectValues, body)
  const orderedKeys = [
    "schema_version",
    "industry",
    "knowledge_domain",
    "domain",
    "taxonomy_path",
    "type",
    "entity_type",
    "business_phase",
    "dedup_key",
    "title",
    "summary",
    "created",
    "updated",
    "created_at",
    "updated_at",
    "created_by",
    "tags",
    "keywords",
    "related",
    "relations",
    "parent",
    "children",
    "source_files",
    "source_chunks",
    "sources",
    "confidence",
    "status",
    "needs_review",
    "attributes",
    "claims",
    "ingested_at",
    "ingested_by",
    "ingested_by_user",
    "ingest_processing_mode",
    "ingest_source_chars",
    "ingest_context_chars",
    "ingest_chunk_count",
    "ingest_quality_confidence",
  ]

  const allKeys = new Set([
    ...scalarValues.keys(),
    ...listValues.keys(),
    ...objectValues.keys(),
  ])
  const keys = [
    ...orderedKeys.filter((key) => allKeys.has(key)),
    ...Array.from(allKeys).filter((key) => !orderedKeys.includes(key)).sort(),
  ]

  const lines: string[] = []
  for (const key of keys) {
    if (LIST_FIELDS.has(key)) {
      const values = key === "relations"
        ? normalizeRelationLines(listValues.get(key) ?? [])
        : dedupe(listValues.get(key) ?? [])
      lines.push(...formatList(key, values))
    } else if (objectValues.has(key)) {
      lines.push(`${key}: ${objectValues.get(key)}`)
    } else {
      const value = scalarValues.get(key) ?? ""
      lines.push(`${key}: ${formatScalar(value)}`)
    }
  }

  return ["---", ...lines, "---", ensureVisibleKnowledgeGaps(body, objectValues.get("attributes") ?? "")].join("\n")

  function applyBusinessCorrections(
    scalars: Map<string, string>,
    lists: Map<string, string[]>,
    objects: Map<string, string>,
    pageBody: string,
  ): void {
    let entityType = normalizeToken(scalars.get("entity_type") ?? "")
    const title = scalars.get("title") ?? ""
    const text = `${title}\n${pageBody}\n${objects.get("attributes") ?? ""}`

    if (entityType === "selling_point" && /家庭医生|绿通|健康档案|服务权益/.test(text)) {
      entityType = "service_benefit"
    } else if (entityType === "selling_point" && /预算|异议|话术|方案设计|回应|保费太贵/.test(text)) {
      entityType = "objection_handling"
    } else if (
      entityType === "objection_handling" &&
      /家庭现金流保护|健康风险备用金|卖点|核心卖点/.test(text) &&
      !/objection_raw|客户原话|异议原话|我已经有医保|保费太贵/.test(text)
    ) {
      entityType = "selling_point"
    }

    if (entityType) scalars.set("entity_type", entityType)
    const domain = ENTITY_TYPE_DOMAIN[entityType] ?? normalizeToken(scalars.get("knowledge_domain") ?? "") ?? "general"
    scalars.set("knowledge_domain", domain)
    scalars.set("domain", domain)
    scalars.set("type", ENTITY_TYPE_TO_UNIVERSAL_TYPE[entityType] ?? normalizeToken(scalars.get("type") ?? "") ?? "concept")

    const ingestedBy = scalars.get("ingested_by")
    const hasIngestMetadata = Array.from(scalars.keys()).some((key) => key.startsWith("ingest_"))
    if (ingestedBy === "file-upload" || ingestedBy === "deep-research" || hasIngestMetadata) {
      scalars.set("status", "candidate")
      if (!scalars.get("needs_review")) scalars.set("needs_review", "true")
    }

    const sourceFiles = lists.get("source_files") ?? []
    const sources = lists.get("sources") ?? []
    if (sources.length === 0 && sourceFiles.length > 0) lists.set("sources", sourceFiles)
    if (sourceFiles.length === 0 && sources.length > 0) lists.set("source_files", sources)

    const related = canonicalizeTargets(lists.get("related") ?? [])
    const relations = lists.get("relations") ?? []
    lists.set("related", related)
    lists.set("relations", normalizeBusinessRelations(relations, entityType, related))
  }
}

function ensureVisibleKnowledgeGaps(body: string, attributes: string): string {
  const gaps = extractKnowledgeGaps(attributes)
  if (gaps.length === 0) return body
  if (/^##\s*(知识缺口|缺失知识|待补全|待补全信息|待补充信息)\s*$/m.test(body)) return body

  const section = [
    "",
    "## 缺失知识 / 待补全信息",
    "",
    "以下字段或知识点未从当前材料中确认，建议进入审核或补充资料流程：",
    "",
    ...gaps.map((gap) => `- ${gap}`),
    "",
  ].join("\n")

  return body.trimEnd() + "\n" + section
}

function extractKnowledgeGaps(attributes: string): string[] {
  if (!attributes) return []
  try {
    const parsed = JSON.parse(attributes)
    const gaps = parsed?.knowledge_gaps
    if (Array.isArray(gaps)) return gaps.map((gap) => String(gap).trim()).filter(Boolean)
    if (typeof gaps === "string" && gaps.trim()) return [gaps.trim()]
  } catch {
    const match = attributes.match(/"knowledge_gaps"\s*:\s*\[([^\]]*)]/)
    if (!match) return []
    return match[1]
      .split(",")
      .map((item) => trimQuotes(item.trim()))
      .filter(Boolean)
  }
  return []
}

function parseYamlBlocks(yaml: string): YamlBlock[] {
  const blocks: YamlBlock[] = []
  let current: YamlBlock | null = null

  for (const line of yaml.split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/)
    if (top) {
      current = { key: top[1], lines: [line] }
      blocks.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return blocks
}

function blockValue(block: YamlBlock): string {
  const first = block.lines[0].replace(new RegExp(`^${escapeRegExp(block.key)}:\\s*`), "").trim()
  const rest = block.lines.slice(1).join("\n").trim()
  return [first, rest].filter(Boolean).join("\n").trim()
}

function extractListValues(block: YamlBlock): string[] {
  const value = blockValue(block)
  if (!value) return []
  const inline = value.match(/^\[(.*)]$/s)
  if (inline) return splitCsvish(inline[1])
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-\s*/, ""))
    .flatMap((line) => line.includes(",") && !line.includes(":") ? splitCsvish(line) : [trimQuotes(line)])
    .filter(Boolean)
}

function normalizeAttributesValue(raw: string): string {
  const cleaned = raw.trim()
  if (!cleaned) return "{}"
  try {
    return JSON.stringify(JSON.parse(cleaned))
  } catch {
    return cleaned.replace(/\s+/g, " ")
  }
}

function normalizeBusinessRelations(relations: string[], entityType: string, related: string[]): string[] {
  const normalized = relations.map((line) => normalizeRelationLine(line, entityType)).filter(Boolean)
  const inferred = related
    .filter((item) => item && item.length < 80)
    .map((target) => inferRelationForTarget(entityType, target))
    .filter(Boolean)
  return dedupe([...normalized, ...inferred])
}

function inferRelationForTarget(entityType: string, target: string): string {
  const canonicalTarget = canonicalizeTarget(target)
  if (/医保|医疗险|意外险|年金险|终身寿险|重疾险|产品|组合/.test(target)) {
    return entityType === "product" ? `complements: ${canonicalTarget}` : `applies_to: ${canonicalTarget}`
  }
  if (/画像|客户|家庭支柱|高净值|体检异常|父母|育儿|购房/.test(target)) {
    return entityType === "persona" ? `applies_to: ${canonicalTarget}` : `recommended_for: ${canonicalTarget}`
  }
  if (/异议|话术|场景|方案|方法|沟通/.test(target)) return `supports: ${canonicalTarget}`
  if (/合规|禁止|承诺|免责/.test(target)) return `governed_by: ${canonicalTarget}`
  if (/风险|压力|痛点/.test(target)) return `supported_by: ${canonicalTarget}`
  return `related_to: ${canonicalTarget}`
}

function normalizeRelationLine(raw: string, entityType = ""): string {
  const compact = raw.match(/^([a-z_]+)\s*:\s*(.+)$/i)
  if (!compact) return raw.trim()
  let type = normalizeToken(compact[1])
  const target = canonicalizeTarget(compact[2].trim())

  if (type === "recommended_for" && (entityType === "persona" || entityType === "life_stage" || entityType === "customer_signal")) {
    type = "has_recommendation"
  } else if (type === "recommended_for" && /医保|医疗险|意外险|年金险|终身寿险|重疾险|产品|组合/.test(target)) {
    type = "complements"
  } else if (type === "applies_to" && /异议|话术|方法|方案/.test(target)) {
    type = "supports"
  } else if (type === "governed_by" && !/合规|禁止|承诺|免责|监管|规则|红线|边界/.test(target)) {
    type = "supported_by"
  }

  if (!RELATION_TYPES.has(type as RelationType)) type = "related_to"
  return `${type}: ${target}`
}

function normalizeRelationLines(values: string[]): string[] {
  return dedupe(values.map((value) => normalizeRelationLine(value)).filter(Boolean))
}

function canonicalizeTargets(values: string[]): string[] {
  return values.map(canonicalizeTarget)
}

function canonicalizeTarget(value: string): string {
  const trimmed = trimQuotes(value)
  return CANONICAL_TARGETS[trimmed] ?? trimmed
}

function formatList(key: string, values: string[]): string[] {
  if (values.length === 0) return [`${key}: []`]
  if (key === "relations" || key === "claims") {
    return [`${key}:`, ...values.map((value) => `  - ${quoteIfNeeded(value)}`)]
  }
  return [`${key}: [${values.map(quoteIfNeeded).join(", ")}]`]
}

function formatScalar(value: string): string {
  const trimmed = trimQuotes(value)
  if (!trimmed) return '""'
  if (/^(true|false|null|\d+(?:\.\d+)?)$/i.test(trimmed)) return trimmed
  if (/^\[.*]$/.test(trimmed) || /^\{.*}$/.test(trimmed)) return trimmed
  if (/^[a-z0-9_.:/-]+$/i.test(trimmed)) return trimmed
  return quoteIfNeeded(trimmed)
}

function quoteIfNeeded(value: string): string {
  const trimmed = trimQuotes(value)
  if (!trimmed) return '""'
  if (/^[a-z0-9_.:/-]+$/i.test(trimmed)) return trimmed
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function splitCsvish(raw: string): string[] {
  return raw.split(",").map((item) => trimQuotes(item.trim())).filter(Boolean)
}

function trimQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim()
}

function normalizeToken(value: string): string {
  return trimQuotes(value).trim().toLowerCase().replace(/[\s-]+/g, "_")
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
