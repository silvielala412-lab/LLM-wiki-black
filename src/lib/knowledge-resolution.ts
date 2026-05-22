import {
  getInsuranceFieldImportance,
  getInsuranceFieldMergePolicy,
  inferSourceTypeFromSourceName,
  inferStableInsuranceDedupKey,
  normalizeInsuranceAttributes,
  sourceTypeWeight,
} from "@/lib/insurance-schema-registry"
import type { ReviewItem } from "@/stores/review-store"

export interface ResolutionResult {
  content: string
  reviewItems: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]
  hasBlockingConflict: boolean
  action: "new" | "duplicate" | "conflict"
}

interface FieldConflict {
  field: string
  importance: string
  existingValue: unknown
  incomingValue: unknown
  existingSourceType: string
  incomingSourceType: string
}

export function resolveIncomingKnowledgePage(
  relativePath: string,
  incomingContent: string,
  existingContent: string | null,
): ResolutionResult {
  const incoming = parseKnowledgePage(incomingContent)
  const incomingSourceType = inferPageSourceType(incomingContent)
  let nextContent = upsertFrontmatterScalar(incomingContent, "source_type", incomingSourceType)

  if (!existingContent || !isKnowledgeEntityPath(relativePath)) {
    return { content: nextContent, reviewItems: [], hasBlockingConflict: false, action: "new" }
  }

  const existing = parseKnowledgePage(existingContent)
  const existingSourceType = inferPageSourceType(existingContent)
  const existingDedup = stableDedupFor(existing, relativePath)
  const incomingDedup = stableDedupFor(incoming, relativePath)
  const resolvedDedup = incomingDedup || existingDedup

  const { mergedAttributes, conflicts } = mergeAttributesByPolicy(
    existing.attributes,
    incoming.attributes,
    incoming.entityType || existing.entityType,
    existingSourceType,
    incomingSourceType,
  )

  if (conflicts.length > 0) {
    const reviewItem = buildFieldConflictReviewItem(relativePath, existing.title || incoming.title, resolvedDedup, conflicts)
    return {
      content: existingContent,
      reviewItems: [reviewItem],
      hasBlockingConflict: true,
      action: "conflict",
    }
  }

  const mergedContent = mergeDuplicateKnowledgeContent(
    existingContent,
    nextContent,
    mergedAttributes,
    resolvedDedup,
    chooseBetterSourceType(existingSourceType, incomingSourceType),
  )
  return { content: mergedContent, reviewItems: [], hasBlockingConflict: false, action: "duplicate" }
}

function mergeAttributesByPolicy(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  entityType: string,
  existingSourceType: string,
  incomingSourceType: string,
): { mergedAttributes: Record<string, unknown>; conflicts: FieldConflict[] } {
  const merged: Record<string, unknown> = { ...existing }
  const conflicts: FieldConflict[] = []

  for (const [field, incomingValue] of Object.entries(incoming)) {
    if (isEmptyValue(incomingValue)) continue
    const existingValue = existing[field]
    if (isEmptyValue(existingValue)) {
      merged[field] = incomingValue
      continue
    }
    if (sameValue(existingValue, incomingValue)) continue

    const policy = getInsuranceFieldMergePolicy(entityType, field)
    if (policy === "append") {
      merged[field] = mergeAppendValues(existingValue, incomingValue)
      continue
    }
    if (policy === "keep_best") {
      merged[field] = chooseBestValue(existingValue, incomingValue, existingSourceType, incomingSourceType)
      continue
    }
    if (policy === "ignore_empty") continue

    conflicts.push({
      field,
      importance: getInsuranceFieldImportance(entityType, field) ?? "unknown",
      existingValue,
      incomingValue,
      existingSourceType,
      incomingSourceType,
    })
  }

  return { mergedAttributes: merged, conflicts }
}

function buildFieldConflictReviewItem(
  relativePath: string,
  title: string,
  dedupKey: string,
  conflicts: FieldConflict[],
): Omit<ReviewItem, "id" | "resolved" | "createdAt"> {
  const rows = conflicts.slice(0, 12).map((conflict) =>
    `- ${conflict.field} (${conflict.importance}): 现有=${formatValue(conflict.existingValue)} | 新增=${formatValue(conflict.incomingValue)} | 来源类型=${conflict.existingSourceType} -> ${conflict.incomingSourceType}`,
  )
  return {
    type: "contradiction",
    title: `字段冲突：${title || dedupKey}`,
    description: [
      `系统识别到相同 dedup_key 的知识页，但关键字段值不同，已阻止自动覆盖。`,
      "",
      `dedup_key: ${dedupKey}`,
      `页面: ${relativePath}`,
      "",
      ...rows,
      "",
      "请人工判断采用新值、保留旧值、追加为多值，或标记旧值失效。",
    ].join("\n"),
    affectedPages: [relativePath],
    options: [
      { label: "保留旧值", action: "keep-existing" },
      { label: "采用新值", action: "accept-incoming" },
      { label: "追加为多值", action: "append-values" },
      { label: "标记旧值失效", action: "supersede-existing" },
    ],
  }
}

function parseKnowledgePage(content: string): {
  frontmatter: string
  title: string
  entityType: string
  dedupKey: string
  attributes: Record<string, unknown>
} {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  return {
    frontmatter,
    title: getScalar(frontmatter, "title"),
    entityType: getScalar(frontmatter, "entity_type"),
    dedupKey: getScalar(frontmatter, "dedup_key"),
    attributes: normalizeInsuranceAttributes(getScalar(frontmatter, "entity_type"), parseAttributes(getScalar(frontmatter, "attributes"))),
  }
}

function stableDedupFor(page: ReturnType<typeof parseKnowledgePage>, relativePath: string): string {
  return page.dedupKey || inferStableInsuranceDedupKey({
    entityType: page.entityType,
    title: page.title || relativePath.split("/").pop()?.replace(/\.md$/i, "") || "untitled",
    attributes: page.attributes,
    fallback: relativePath,
  })
}

function inferPageSourceType(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const explicit = getScalar(fm, "source_type")
  if (explicit) return explicit
  const source = firstListValue(fm, "source_files") || firstListValue(fm, "sources")
  return inferSourceTypeFromSourceName(source)
}

function chooseBetterSourceType(a: string, b: string): string {
  return sourceTypeWeight(b) > sourceTypeWeight(a) ? b : a
}

function chooseBestValue(existing: unknown, incoming: unknown, existingSourceType: string, incomingSourceType: string): unknown {
  const existingWeight = sourceTypeWeight(existingSourceType)
  const incomingWeight = sourceTypeWeight(incomingSourceType)
  if (incomingWeight > existingWeight) return incoming
  if (incomingWeight < existingWeight) return existing
  return valueCompleteness(incoming) > valueCompleteness(existing) ? incoming : existing
}

function mergeDuplicateKnowledgeContent(
  existingContent: string,
  incomingContent: string,
  mergedAttributes: Record<string, unknown>,
  dedupKey: string,
  sourceType: string,
): string {
  let merged = upsertFrontmatterScalar(existingContent, "dedup_key", dedupKey)
  merged = upsertFrontmatterJson(merged, "attributes", mergedAttributes)
  merged = upsertFrontmatterScalar(merged, "source_type", sourceType)
  merged = upsertFrontmatterList(merged, "sources", mergeStringLists(parseYamlList(existingContent, "sources"), parseYamlList(incomingContent, "sources")))
  merged = upsertFrontmatterList(merged, "source_files", mergeStringLists(parseYamlList(existingContent, "source_files"), parseYamlList(incomingContent, "source_files")))

  const existingBody = extractBody(existingContent)
  const incomingBody = extractBody(incomingContent)
  if (!incomingBody || bodyEquivalent(existingBody, incomingBody)) return merged

  const incomingTitle = parseKnowledgePage(incomingContent).title || "新增来源补充"
  const section = [
    "",
    `## 来源补充：${incomingTitle}`,
    "",
    incomingBody,
  ].join("\n")
  return `${merged.trimEnd()}\n\n${section.trim()}\n`
}

function extractBody(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\s*/m)
  return (match ? content.slice(match[0].length) : content).trim()
}

function bodyEquivalent(a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, "")
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return na === nb
  if (na.includes(nb) || nb.includes(na)) return true
  return na.slice(0, 800) === nb.slice(0, 800)
}

function parseYamlList(content: string, key: string): string[] {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? content
  const inline = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)]`, "m"))
  if (inline) return inline[1].split(",").map((item) => stripQuotes(item.trim())).filter(Boolean)
  const block = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"))
  if (!block) return []
  return block[1].split(/\r?\n/)
    .map((line) => line.match(/^\s+-\s+(.+?)\s*$/)?.[1] ?? "")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean)
}

function mergeStringLists(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const item of [...existing, ...incoming]) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

function mergeAppendValues(existing: unknown, incoming: unknown): unknown[] {
  const values = [...toArray(existing), ...toArray(incoming)]
  const seen = new Set<string>()
  const merged: unknown[] = []
  for (const value of values) {
    const key = JSON.stringify(value)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(value)
  }
  return merged
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return isEmptyValue(value) ? [] : [value]
}

function sameValue(a: unknown, b: unknown): boolean {
  return normalizeComparable(a) === normalizeComparable(b)
}

function normalizeComparable(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeComparable).sort().join("|")
  return String(value ?? "").trim().replace(/\s+/g, "")
}

function isEmptyValue(value: unknown): boolean {
  if (value == null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "string") return value.trim() === "" || value.trim().toLowerCase() === "null"
  return false
}

function valueCompleteness(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return String(value ?? "").length
}

function parseAttributes(raw: string): Record<string, unknown> {
  if (!raw || raw === "{}") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function getScalar(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`, "m"))
  return match ? stripQuotes(match[1].trim()) : ""
}

function firstListValue(frontmatter: string, key: string): string {
  const inline = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)]`, "m"))
  if (inline) return inline[1].split(",").map((item) => stripQuotes(item.trim())).find(Boolean) ?? ""
  const multi = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"))
  if (!multi) return ""
  for (const line of multi[1].split(/\r?\n/)) {
    const match = line.match(/^\s+-\s+(.+?)\s*$/)
    if (match) return stripQuotes(match[1].trim())
  }
  return ""
}

function upsertFrontmatterScalar(content: string, key: string, value: string): string {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!match) return content
  const [, open, body, close] = match
  const line = `${key}: "${escapeYaml(value)}"`
  const nextBody = new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, "m").test(body)
    ? body.replace(new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, "m"), line)
    : `${body}\n${line}`
  return `${open}${nextBody}${close}${content.slice(match[0].length)}`
}

function upsertFrontmatterJson(content: string, key: string, value: Record<string, unknown>): string {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!match) return content
  const [, open, body, close] = match
  const line = `${key}: ${JSON.stringify(value)}`
  const nextBody = new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, "m").test(body)
    ? body.replace(new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, "m"), line)
    : `${body}\n${line}`
  return `${open}${nextBody}${close}${content.slice(match[0].length)}`
}

function upsertFrontmatterList(content: string, key: string, values: string[]): string {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!match || values.length === 0) return content
  const [, open, body, close] = match
  const line = `${key}: [${values.map((value) => `"${escapeYaml(value)}"`).join(", ")}]`
  let nextBody = body
  if (new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[[^\\]]*]`, "m").test(nextBody)) {
    nextBody = nextBody.replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[[^\\]]*]`, "m"), line)
  } else if (new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m").test(nextBody)) {
    nextBody = nextBody.replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"), line)
  } else {
    nextBody = `${nextBody}\n${line}`
  }
  return `${open}${nextBody}${close}${content.slice(match[0].length)}`
}

function isKnowledgeEntityPath(relativePath: string): boolean {
  return relativePath.startsWith("wiki/entities/") || relativePath.startsWith("wiki/concepts/")
}

function formatValue(value: unknown): string {
  return JSON.stringify(value)
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim()
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
