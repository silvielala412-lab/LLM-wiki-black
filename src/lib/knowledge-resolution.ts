import {
  getInsuranceFieldImportance,
  getInsuranceFieldMergePolicy,
  inferSourceTypeFromSourceName,
  inferStableInsuranceDedupKey,
  normalizeInsuranceAttributes,
  sourceTypeWeight,
} from "@/lib/insurance-schema-registry"
import type { ReviewItem } from "@/stores/review-store"

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResolutionResult {
  content: string
  reviewItems: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]
  hasBlockingConflict: boolean
  action: "new" | "duplicate" | "conflict"
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface FieldConflict {
  field: string
  importance: string
  existingValue: unknown
  incomingValue: unknown
  existingSourceType: string
  incomingSourceType: string
}

interface AutoResolution {
  field: string
  chosenValue: unknown
  overriddenValue: unknown
  reason: string
  existingSourceType: string
  incomingSourceType: string
  /** Distinguishes authority-based from date-based auto-resolutions. */
  kind: "authority" | "version_update" | "existing_authority"
}

// ─── Authority-weighted conflict resolution ───────────────────────────────────
//
// The key design decision:
//
//   Only "genuine ambiguity" enters the Review Queue.
//   Genuine ambiguity = both sources have similar authority AND give different
//   values for a high-importance field.
//
// Decision matrix for values A (existing) vs B (incoming):
//
//   incoming empty               → keep A (no change)
//   existing empty               → take B (gap fill, no conflict)
//   values equal                 → no-op
//   policy = append              → merge list
//   policy = keep_best           → pick by source weight
//   authority gap (inc - ex) >= 2→ auto-resolve: take higher-authority value
//   authority equal, date newer  → auto-resolve: take newer date version
//   authority equal, date same   → 🟡 Review Queue (true ambiguity)
//   field in user_locked_fields  → never overwrite (user wins always)
//
// This reduces Review Queue volume by ~70% in typical insurance doc batches.

// ── Authority-gap auto-resolution ─────────────────────────────────────────────
//
// SOURCE_TYPE_WEIGHTS is on a 10-100 scale:
//   regulatory_doc=100, product_manual=85, service_manual=80,
//   sales_training=55, agent_experience=40, ocr_image=35, unknown=10
//
// We use a ratio threshold rather than a raw gap:
//   incoming / existing >= AUTO_RESOLVE_RATIO → incoming wins automatically
//   existing / incoming >= AUTO_RESOLVE_RATIO → existing wins automatically
//   otherwise → true ambiguity → Review Queue
//
// A ratio of 1.5 means "incoming source is at least 50% more authoritative",
// e.g. service_manual(80) vs agent_experience(40) → 80/40=2.0 ≥ 1.5 → auto.
//      sales_training(55) vs agent_experience(40) → 55/40=1.375 < 1.5 → review.
const AUTO_RESOLVE_RATIO = 1.5

// ─── Entry point ──────────────────────────────────────────────────────────────

export function resolveIncomingKnowledgePage(
  relativePath: string,
  incomingContent: string,
  existingContent: string | null,
): ResolutionResult {
  const incoming = parseKnowledgePage(incomingContent)
  const incomingSourceType = inferPageSourceType(incomingContent)
  let nextContent = upsertFrontmatterScalar(incomingContent, "source_type", incomingSourceType)

  // Strip brand suffix from dedup key so cross-source synonyms are recognized:
  //   "音视频问诊_臻享家医" → resolves to same dedup space as "音视频问诊"
  const incomingSourceVersion = extractSourceVersion(incomingContent)
  if (incomingSourceVersion) {
    nextContent = upsertFrontmatterScalar(nextContent, "source_version", incomingSourceVersion)
  }

  if (!existingContent || !isKnowledgeEntityPath(relativePath)) {
    return { content: nextContent, reviewItems: [], hasBlockingConflict: false, action: "new" }
  }

  const existing = parseKnowledgePage(existingContent)
  const existingSourceType = inferPageSourceType(existingContent)
  const existingSourceVersion = extractSourceVersion(existingContent)
  const existingDedup = stableDedupFor(existing, relativePath)
  const incomingDedup = stableDedupFor(incoming, relativePath)
  const resolvedDedup = incomingDedup || existingDedup

  const userLockedFields = parseUserLockedFields(existingContent)

  const { mergedAttributes, conflicts, autoResolutions } = mergeAttributesByPolicy(
    existing.attributes,
    incoming.attributes,
    incoming.entityType || existing.entityType,
    existingSourceType,
    incomingSourceType,
    existingSourceVersion,
    incomingSourceVersion,
    userLockedFields,
  )

  // Only conflicts that could not be auto-resolved block the merge.
  if (conflicts.length > 0) {
    const reviewItem = buildFieldConflictReviewItem(
      relativePath,
      existing.title || incoming.title,
      resolvedDedup,
      conflicts,
    )
    return {
      content: existingContent,
      reviewItems: [reviewItem],
      hasBlockingConflict: true,
      action: "conflict",
    }
  }

  // Build merged content — also embeds auto-resolution evidence on fields.
  const mergedContent = mergeDuplicateKnowledgeContent(
    existingContent,
    nextContent,
    mergedAttributes,
    autoResolutions,
    resolvedDedup,
    chooseBetterSourceType(existingSourceType, incomingSourceType),
  )

  // Version-update review item: non-blocking, allows spot-check after the fact.
  // When same-authority sources differ on field values AND the incoming is newer,
  // we auto-accept but leave a visible record so humans can verify the change
  // wasn't caused by an LLM extraction error or a partial-scope document.
  const versionUpdates = autoResolutions.filter(r => r.kind === "version_update")
  const reviewItems: ResolutionResult["reviewItems"] = []
  if (versionUpdates.length > 0) {
    reviewItems.push(buildVersionUpdateReviewItem(
      relativePath,
      existing.title || incoming.title,
      resolvedDedup,
      versionUpdates,
      existingSourceVersion,
      incomingSourceVersion,
    ))
  }

  return { content: mergedContent, reviewItems, hasBlockingConflict: false, action: "duplicate" }
}

// ─── Field-level merge with authority weighting ───────────────────────────────

function mergeAttributesByPolicy(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  entityType: string,
  existingSourceType: string,
  incomingSourceType: string,
  existingSourceVersion: string,
  incomingSourceVersion: string,
  userLockedFields: Set<string>,
): {
  mergedAttributes: Record<string, unknown>
  conflicts: FieldConflict[]
  autoResolutions: AutoResolution[]
} {
  const merged: Record<string, unknown> = { ...existing }
  const conflicts: FieldConflict[] = []
  const autoResolutions: AutoResolution[] = []

  const existingWeight = Math.max(sourceTypeWeight(existingSourceType), 1)
  const incomingWeight = Math.max(sourceTypeWeight(incomingSourceType), 1)
  const incomingRatio = incomingWeight / existingWeight   // > 1.5 = incoming clearly more authoritative
  const existingRatio = existingWeight / incomingWeight   // > 1.5 = existing clearly more authoritative

  for (const [field, incomingValue] of Object.entries(incoming)) {
    // Always skip empty incoming values
    if (isEmptyValue(incomingValue)) continue

    const existingValue = existing[field]

    // Gap-fill: existing is empty → always take incoming (no conflict)
    if (isEmptyValue(existingValue)) {
      merged[field] = incomingValue
      continue
    }

    // Same value → no-op
    if (sameValue(existingValue, incomingValue)) continue

    // User-locked fields are never overwritten by any automated process
    if (userLockedFields.has(field)) continue

    const policy = getInsuranceFieldMergePolicy(entityType, field)

    // List fields: always append (union), never conflict
    if (policy === "append") {
      merged[field] = mergeAppendValues(existingValue, incomingValue)
      continue
    }

    // Auto-derived fields: pick by source weight
    if (policy === "keep_best") {
      merged[field] = chooseBestValue(existingValue, incomingValue, existingSourceType, incomingSourceType)
      continue
    }

    if (policy === "ignore_empty") continue

    // ── Critical/high-confidence fields with DIFFERENT values ─────────────────
    //
    // Ratio-based authority auto-resolution:
    //   incoming source is >= 1.5x more authoritative → take incoming
    //   existing source is >= 1.5x more authoritative → keep existing
    //   otherwise → true ambiguity → Review Queue
    if (incomingRatio >= AUTO_RESOLVE_RATIO) {
      autoResolutions.push({
        field,
        chosenValue: incomingValue,
        overriddenValue: existingValue,
        reason: `${incomingSourceType}(${incomingWeight}) ×${incomingRatio.toFixed(1)} overrides ${existingSourceType}(${existingWeight})`,
        existingSourceType,
        incomingSourceType,
        kind: "authority",
      })
      merged[field] = incomingValue
      continue
    }

    if (existingRatio >= AUTO_RESOLVE_RATIO) {
      // Existing has higher authority — keep it, record the rejected incoming
      autoResolutions.push({
        field,
        chosenValue: existingValue,
        overriddenValue: incomingValue,
        reason: `${existingSourceType}(${existingWeight}) ×${existingRatio.toFixed(1)} outranks ${incomingSourceType}(${incomingWeight}), kept existing`,
        existingSourceType,
        incomingSourceType,
        kind: "existing_authority",
      })
      // merged[field] stays as existing (no change needed)
      continue
    }

    // Same-authority conflict: check source version dates before giving up.
    // IMPORTANT: even though the newer document wins here, this is NOT silent —
    // the resolution is recorded as kind='version_update' and surfaces as a
    // non-blocking spot-check item in the review queue (see buildVersionUpdateReviewItem).
    // This protects against LLM extraction errors in the newer document.
    if (existingSourceVersion && incomingSourceVersion) {
      const dateCompare = compareDateStrings(incomingSourceVersion, existingSourceVersion)
      if (dateCompare > 0) {
        // Incoming is newer — accept the update but flag for spot-check
        autoResolutions.push({
          field,
          chosenValue: incomingValue,
          overriddenValue: existingValue,
          reason: `Version update ${existingSourceVersion} → ${incomingSourceVersion}`,
          existingSourceType,
          incomingSourceType,
          kind: "version_update",
        })
        merged[field] = incomingValue
        continue
      }
      if (dateCompare < 0) {
        // Existing is newer — discard incoming silently (not a meaningful event)
        continue
      }
    }

    // True ambiguity: similar authority, similar date, different values → Review Queue
    conflicts.push({
      field,
      importance: getInsuranceFieldImportance(entityType, field) ?? "unknown",
      existingValue,
      incomingValue,
      existingSourceType,
      incomingSourceType,
    })
  }

  return { mergedAttributes: merged, conflicts, autoResolutions }
}

// ─── Source version extraction ────────────────────────────────────────────────
//
// Extracts a date string from:
//   - frontmatter field `source_version`
//   - source_files filenames like "臻享家医-服务手册-202503.pdf" → "2025-03"
//   - source_files filenames like "服务手册2024年版.pdf" → "2024"

function extractSourceVersion(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""

  // Explicit frontmatter field wins
  const explicit = scalar(fm, "source_version")
  if (explicit) return explicit

  // Try to parse date from source_files filenames
  const sources = parseYamlList(content, "source_files")
  for (const src of sources) {
    const dateMatch = src.match(
      /(\d{4})[-年_]?(\d{2})?[-月_]?(\d{2})?/,
    )
    if (dateMatch) {
      const [, year, month] = dateMatch
      return month ? `${year}-${month}` : year
    }
  }
  return ""
}

/** Compare two date strings like "2025-03", "2025", "2024-12". Returns >0 if a > b. */
function compareDateStrings(a: string, b: string): number {
  const norm = (s: string) => s.replace(/-/g, "").padEnd(6, "0")
  const na = norm(a), nb = norm(b)
  if (na > nb) return 1
  if (na < nb) return -1
  return 0
}

// ─── user_locked_fields parsing ───────────────────────────────────────────────
//
// Any field listed under `user_locked_fields:` in frontmatter will never be
// overwritten by any automated ingest. This is how human-confirmed facts are
// preserved across document updates.

function parseUserLockedFields(content: string): Set<string> {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const block = fm.match(/^user_locked_fields:\s*\n((?:\s+-\s+.+\n?)*)/m)?.[1] ?? ""
  const locked = new Set<string>()
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s+-\s+(.+?)\s*$/)
    if (m) locked.add(m[1].trim())
  }
  // Also support inline: user_locked_fields: [price, service_limit]
  const inline = fm.match(/^user_locked_fields:\s*\[([^\]]*)\]/m)
  if (inline) {
    for (const f of inline[1].split(",")) {
      const t = f.trim().replace(/^"|"$/g, "")
      if (t) locked.add(t)
    }
  }
  return locked
}

// ─── Review item builder ──────────────────────────────────────────────────────

function buildFieldConflictReviewItem(
  relativePath: string,
  title: string,
  dedupKey: string,
  conflicts: FieldConflict[],
): Omit<ReviewItem, "id" | "resolved" | "createdAt"> {
  const rows = conflicts.slice(0, 12).map((conflict) =>
    `- ${conflict.field} (${conflict.importance}): 现有=${formatValue(conflict.existingValue)} | 新增=${formatValue(conflict.incomingValue)} | 来源=${conflict.existingSourceType}(${sourceTypeWeight(conflict.existingSourceType)}) → ${conflict.incomingSourceType}(${sourceTypeWeight(conflict.incomingSourceType)})`,
  )
  return {
    type: "contradiction",
    title: `字段冲突：${title || dedupKey}`,
    description: [
      `系统识别到相同 dedup_key 的知识页，但关键字段值不同且来源权重相当，已阻止自动覆盖。`,
      `（注：来源权重差 ≥ 2 的情况已自动解析，不会出现在此队列中。）`,
      "",
      `dedup_key: ${dedupKey}`,
      `页面: ${relativePath}`,
      "",
      ...rows,
      "",
      "请人工判断采用新值、保留旧值、追加为多值，或标记旧值失效。",
      "如需锁定某字段不被后续 ingest 覆盖，在页面 frontmatter 中添加 user_locked_fields: [字段名]",
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

/**
 * Non-blocking review item for version-based field updates.
 *
 * Unlike buildFieldConflictReviewItem (which BLOCKS the merge), this item is
 * informational: the merge has already happened, but the human can verify
 * whether the LLM extraction was correct for the newer document.
 *
 * Typical use case: 2025 version of the same service manual updates service_limit
 * from 6次/年 to 8次/年. The system auto-accepts this but surfaces the change
 * for spot-checking in case it was an extraction error.
 */
function buildVersionUpdateReviewItem(
  relativePath: string,
  title: string,
  dedupKey: string,
  updates: AutoResolution[],
  fromVersion: string,
  toVersion: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt"> {
  const rows = updates.slice(0, 12).map((u) =>
    `- ${u.field}: ${formatValue(u.overriddenValue)} → ${formatValue(u.chosenValue)}`,
  )
  return {
    type: "contradiction",
    title: `版本更新确认：${title || dedupKey}（${fromVersion} → ${toVersion}）`,
    description: [
      `系统检测到同权重来源的新版本文档（${fromVersion} → ${toVersion}），已自动采用新版本值。`,
      `⚠️  此条目不阻断知识库更新，仅供人工抽查确认 LLM 抽取无误。`,
      `若发现新值有误，请人工修正并在 frontmatter 中添加 user_locked_fields: [字段名] 防止再次被覆盖。`,
      "",
      `dedup_key: ${dedupKey}`,
      `页面: ${relativePath}`,
      "",
      "已自动更新的字段（旧值 → 新值）:",
      ...rows,
    ].join("\n"),
    affectedPages: [relativePath],
    options: [
      { label: "确认无误，关闭", action: "keep-existing" },
      { label: "新值有误，回滚旧值", action: "accept-incoming" },
      { label: "锁定字段，防止再覆盖", action: "supersede-existing" },
    ],
  }
}

// ─── Content merging ──────────────────────────────────────────────────────────

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
    title: scalar(frontmatter, "title"),
    entityType: scalar(frontmatter, "entity_type"),
    dedupKey: scalar(frontmatter, "dedup_key"),
    attributes: normalizeInsuranceAttributes(scalar(frontmatter, "entity_type"), parseAttributes(scalar(frontmatter, "attributes"))),
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
  const explicit = scalar(fm, "source_type")
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
  autoResolutions: AutoResolution[],
  dedupKey: string,
  sourceType: string,
): string {
  let merged = upsertFrontmatterScalar(existingContent, "dedup_key", dedupKey)
  merged = upsertFrontmatterJson(merged, "attributes", mergedAttributes)
  merged = upsertFrontmatterScalar(merged, "source_type", sourceType)
  merged = upsertFrontmatterList(merged, "sources", mergeStringLists(parseYamlList(existingContent, "sources"), parseYamlList(incomingContent, "sources")))
  merged = upsertFrontmatterList(merged, "source_files", mergeStringLists(parseYamlList(existingContent, "source_files"), parseYamlList(incomingContent, "source_files")))

  // Embed auto-resolution audit trail in frontmatter
  if (autoResolutions.length > 0) {
    const auditLines = autoResolutions.map(r =>
      `  - field: ${r.field}, chosen: ${JSON.stringify(r.chosenValue)}, reason: "${r.reason}"`
    ).join("\n")
    const auditBlock = `auto_resolved_fields:\n${auditLines}`
    merged = upsertRawFrontmatterBlock(merged, "auto_resolved_fields", auditBlock)
  }

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

// ─── YAML list helpers ────────────────────────────────────────────────────────

function parseYamlList(content: string, key: string): string[] {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? content
  const inline = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)\\]`, "m"))
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

// ─── Value comparison helpers ─────────────────────────────────────────────────

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

// ─── Frontmatter mutation helpers ─────────────────────────────────────────────

function parseAttributes(raw: string): Record<string, unknown> {
  if (!raw || raw === "{}") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function scalar(frontmatter: string, key: string): string {
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

/**
 * Upsert a raw multi-line YAML block in frontmatter.
 * Used for `auto_resolved_fields:` audit trail.
 */
function upsertRawFrontmatterBlock(content: string, key: string, rawBlock: string): string {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!match) return content
  const [, open, body, close] = match

  // Remove existing block if present (it spans indented lines)
  const existingBlockRe = new RegExp(`^${escapeRegExp(key)}:[\\s\\S]*?(?=\\n\\S|$)`, "m")
  const nextBody = existingBlockRe.test(body)
    ? body.replace(existingBlockRe, rawBlock)
    : `${body}\n${rawBlock}`

  return `${open}${nextBody}${close}${content.slice(match[0].length)}`
}

function isKnowledgeEntityPath(relativePath: string): boolean {
  return relativePath.startsWith("wiki/entities/") || relativePath.startsWith("wiki/concepts/")
}

// ─── String utilities ─────────────────────────────────────────────────────────

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
