/**
 * knowledge-postprocess.ts
 *
 * Strong-constraint post-generation pass. Runs after all wiki pages have been
 * written to disk. Enforces the schema contract regardless of LLM output quality.
 *
 * Three hard guarantees after this pass:
 *
 * 1. SCHEMA MATERIALIZATION (hard constraint)
 *    Every entity page's `attributes` contains the fields defined in the
 *    Insurance Schema Registry for its entity_type, plus a reserved
 *    `extra_attributes` object for non-standard fields:
 *    - Non-standard fields are remapped via FIELD_ALIASES or quarantined into
 *      `extra_attributes` (never silently dropped).
 *    - Missing standard fields are added as null.
 *    - `knowledge_gaps` is recomputed deterministically from null fields.
 *    - `raw_attributes` is eliminated: values are salvaged then the key is removed.
 *
 * 2. RELATION INFERENCE (hard constraint)
 *    Service-benefit and other child entity pages that have `relations: []` but
 *    have a known parent (via `attributes.related_product`, `attributes.related_scenario`,
 *    etc.) will have the correct `part_of` relation inferred and written.
 *
 * 3. RELATION RECONCILIATION (best-effort)
 *    Relation targets that don't match any existing page title are rewritten to
 *    their canonical title using normalized fuzzy matching.
 */

import { deleteFile, listDirectory, readFile, writeFile } from "@/commands/fs"
import { INSURANCE_SCHEMA_REGISTRY } from "@/lib/insurance-schema-registry"
import { cleanupKnowledgeFrontmatter } from "@/lib/knowledge-frontmatter-cleanup"
import { normalizeEntityTitle } from "@/lib/service-benefit-enrichment"

// ─── Types ───────────────────────────────────────────────────────────────────

interface PageIndex {
  title: string
  relativePath: string
  entityType: string
  normalizedForms: string[]
}

export interface PostProcessResult {
  reconciled: number
  materialized: number
  relationsInferred: number
  titlesNormalized: number
  lintWarnings: string[]
  errors: string[]
}

// ─── Field alias map ──────────────────────────────────────────────────────────
// Maps entity_type → { canonical_field_name → [alias names] }
// Inverted at runtime to: nonStandardKey → canonicalKey
const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  service_benefit: {
    service_name: ["name", "title", "服务名称", "权益名称", "服务项目名称"],
    related_product: ["product", "适用产品", "关联产品"],
    service_category: ["category", "scene", "服务场景", "service_scene", "service_stage", "服务阶段", "service_team"],
    service_frequency: ["frequency", "次数", "服务次数", "使用次数", "times"],
    eligible_customers: ["target_customer", "target_users", "适用对象", "服务对象", "适用客户", "适用人群"],
    application_process: ["process", "流程", "申请流程", "服务流程", "service_process"],
    service_provider: ["provider", "提供方", "服务提供方", "服务方", "service_team"],
    coverage_scope: ["coverage", "覆盖范围", "服务范围"],
    service_limits: ["limits", "限制", "使用限制", "服务限制", "service_content", "service_limits"],
    time_limits: ["time_limit", "时效", "时限", "response_timeliness", "response_time", "完成时效", "响应时效"],
    compliance_notes: ["disclaimer", "免责", "合规提示", "合规说明", "compliance"],
    core_value: ["value", "核心价值", "权益价值"],
  },
  product: {
    product_name: ["official_product_name", "name", "产品名称", "官方完整名称"],
    product_code: ["code", "product_id", "产品代码", "产品编号"],
    product_status: ["status_business", "sale_status", "销售状态", "在售状态"],
    waiting_period_days: ["waiting_period", "等待期", "等待期天数"],
    core_responsibilities: ["coverage", "responsibilities", "核心保障", "保险责任"],
    exclusions_official: ["exclusions", "责任免除", "免责条款"],
  },
  persona: {
    persona_name: ["name", "画像名称", "客户画像"],
    age_band: ["age_range", "年龄", "年龄段"],
    purchase_signals: ["signals", "购买信号", "客户信号"],
    typical_pain_points: ["pain_points", "痛点", "客户痛点"],
    typical_objections: ["objections", "异议", "典型异议"],
    matching_products: ["recommended_products", "适配产品", "匹配产品"],
  },
  objection_handling: {
    objection_raw: ["raw_objection", "客户原话", "异议原话"],
    objection_category: ["category", "异议类别"],
    response_strategy: ["strategy", "应对策略"],
    response_script: ["script", "应对话术"],
  },
}

// ─── Parent field inference ───────────────────────────────────────────────────
// Maps entity_type → which attribute field holds the parent entity title
const PARENT_ATTR_FIELD: Record<string, string> = {
  service_benefit: "related_product",
  product_clause: "related_product",
  selling_point: "related_product",
  regulatory_doc: "related_product",
  pitch: "related_scenario",
  objection_handling: "related_scenario",
  success_case: "product_or_combo_sold",
  failure_case: "product_or_service_involved",
  referral_case: "referral_method",
  agent_feedback: "related_topic",
  competitive_insight: "compared_product",
  asset: "campaign_or_scenario",
  incentive: "campaign_or_scenario",
  event: "related_campaign",
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runKnowledgePostProcess(projectPath: string): Promise<PostProcessResult> {
  const errors: string[] = []
  const lintWarnings: string[] = []
  let reconciled = 0
  let materialized = 0
  let relationsInferred = 0
  let titlesNormalized = 0

  try {
    // Pass 0: Fix .md.md double-extension filenames before processing
    // This happens when the LLM generates an entity title ending in ".md"
    // and the page creation code appends another ".md".
    const entityDirPath = `${projectPath}/wiki/entities`
    const rawEntityFiles = await safeList(entityDirPath)
    for (const file of rawEntityFiles) {
      if (file.is_dir || !file.name.endsWith(".md.md")) continue
      try {
        const badPath  = `${entityDirPath}/${file.name}`
        const goodName = file.name.replace(/\.md\.md$/, ".md")
        const goodPath = `${entityDirPath}/${goodName}`
        const content  = await readFile(badPath)
        await writeFile(goodPath, content)
        await deleteFile(badPath)
        lintWarnings.push(`renamed .md.md -> ${goodName}`)
      } catch (err) {
        errors.push(`rename ${file.name}: ${String(err)}`)
      }
    }

    const index = await buildPageIndex(projectPath)

    const entityFiles = await safeList(entityDirPath)
    for (const file of entityFiles) {
      if (file.is_dir || !file.name.endsWith(".md") || file.name.endsWith(".md.md")) continue
      const filePath = `${entityDirPath}/${file.name}`
      try {
        const original = await readFile(filePath)

        // Step 0: Normalize the page title (strip HTML, OCR errors, suffix noise)
        let updated = normalizeFrontmatterTitle(original, file.name)
        if (updated !== original) titlesNormalized++

        // First pass: normalize domain/format
        updated = cleanupKnowledgeFrontmatter(updated)

        // Schema materialization (hard constraint)
        const [materialized_content, matChanged, matWarnings] = materializeAttributes(updated, file.name)
        updated = materialized_content
        lintWarnings.push(...matWarnings)

        // Relation inference: generate missing part_of / applies_to
        const [inferred_content, inferChanged] = inferMissingRelations(updated, index)
        updated = inferred_content

        // Relation reconciliation: fix broken target names
        const [reconciled_content, recoChanged] = reconcileRelations(updated, index)
        updated = reconciled_content

        // Second cleanup to normalize format after all mutations
        updated = cleanupKnowledgeFrontmatter(updated)

        if (updated !== original) {
          await writeFile(filePath, updated)
          if (matChanged) materialized++
          if (inferChanged) relationsInferred++
          if (recoChanged) reconciled++
        }
      } catch (err) {
        errors.push(`${file.name}: ${String(err)}`)
      }
    }
  } catch (err) {
    errors.push(`post-process init: ${String(err)}`)
  }

  return { reconciled, materialized, relationsInferred, titlesNormalized, lintWarnings, errors }
}
// ─── Title Normalization ─────────────────────────────────────────────────────────────────────

function normalizeFrontmatterTitle(content: string, fileName: string): string {
  const titleMatch = content.match(/^(title:\s*)([^\n]+)(\n)/m)
  if (!titleMatch) return content
  const rawTitle = titleMatch[2].replace(/^"|"$/g, "").trim()
  const normalized = normalizeEntityTitle(rawTitle)
  if (normalized === rawTitle) return content
  // Preserve quoting style: use quotes if normalized value contains special chars
  const needsQuotes = /[:#|]/.test(normalized)
  const replacement = needsQuotes ? `"${normalized}"` : normalized
  return content.replace(
    /^(title:\s*)([^\n]+)(\n)/m,
    `${titleMatch[1]}${replacement}${titleMatch[3]}`,
  )
}

// ─── Schema Materialization ───────────────────────────────────────────────────

function materializeAttributes(content: string, fileName: string): [string, boolean, string[]] {
  const warnings: string[] = []
  const entityType = extractScalar(content, "entity_type")
  if (!entityType) return [content, false, warnings]

  const spec = INSURANCE_SCHEMA_REGISTRY.find((s) => s.entityType === entityType)
  if (!spec) return [content, false, warnings]

  // Build inverse alias map: nonStandardName → canonicalName
  const aliasMap = buildInverseAliasMap(entityType)

  // Parse attributes — supports both JSON ({...}) and YAML (key: value) formats.
  // The LLM produces YAML-format attributes in most pages; the JSON regex
  // `^attributes:\s*(\{.*\})\s*$` silently misses them entirely.
  const parsedAttrs = parseYamlAttributes(content)
  const { attrs, originalFormat } = parsedAttrs
  let rawAttrsText = parsedAttrs.rawAttrsText

  // Salvage values from raw_attributes if present
  if ("raw_attributes" in attrs && typeof attrs["raw_attributes"] === "string") {
    rawAttrsText = attrs["raw_attributes"] as string
    delete attrs["raw_attributes"]
  }
  if (rawAttrsText) {
    const salvaged = salvageFromRawText(rawAttrsText, spec.fields.map((f) => f.name), aliasMap)
    for (const [k, v] of Object.entries(salvaged)) {
      if (!(k in attrs) || attrs[k] === null) attrs[k] = v
    }
    warnings.push(`${fileName}: salvaged raw_attributes`)
  }

  // Remap non-standard field names to canonical names
  const standardNames = new Set(spec.fields.map((f) => f.name))
  const extraAttrs: Record<string, unknown> = {}
  const keysToProcess = Object.keys(attrs).filter((k) => k !== "knowledge_gaps" && k !== "extra_attributes")

  for (const key of keysToProcess) {
    if (standardNames.has(key)) continue // already canonical
    const canonical = aliasMap[key.toLowerCase()] ?? aliasMap[key]
    if (canonical && !(canonical in attrs)) {
      // Remap: copy value to canonical name
      attrs[canonical] = attrs[key]
      delete attrs[key]
      warnings.push(`${fileName}: remapped ${key} → ${canonical}`)
    } else if (canonical && attrs[canonical] === null) {
      // Canonical exists as null: fill it
      attrs[canonical] = attrs[key]
      delete attrs[key]
    } else if (!canonical && key !== "knowledge_gaps" && key !== "extra_attributes") {
      // Unknown field: quarantine to extra_attributes
      extraAttrs[key] = attrs[key]
      delete attrs[key]
    }
  }

  const previousExtra = attrs["extra_attributes"]
  attrs["extra_attributes"] = extraAttrs
  if (Object.keys(extraAttrs).length > 0) {
    warnings.push(`${fileName}: quarantined non-standard fields: ${Object.keys(extraAttrs).join(", ")}`)
  }

  // Add null for every missing standard field (skip auto_derived)
  let changed = previousExtra === undefined || Object.keys(extraAttrs).length > 0 || rawAttrsText.length > 0 || JSON.stringify(previousExtra ?? {}) !== JSON.stringify(extraAttrs)
  for (const field of spec.fields) {
    if (field.importance === "auto_derived") continue
    if (!(field.name in attrs)) {
      attrs[field.name] = null
      changed = true
    }
  }

  if (!changed && !keysToProcess.some((k) => !standardNames.has(k) && k !== "knowledge_gaps")) {
    // Check if we need to update knowledge_gaps
    const currentGaps = Array.isArray(attrs["knowledge_gaps"]) ? attrs["knowledge_gaps"] : null
    const expectedGaps = spec.fields
      .filter((f) => f.importance !== "auto_derived" && attrs[f.name] === null)
      .map((f) => f.name)
    if (JSON.stringify(currentGaps) === JSON.stringify(expectedGaps)) {
      return [content, false, warnings]
    }
  }

  // Recompute knowledge_gaps deterministically
  attrs["knowledge_gaps"] = spec.fields
    .filter((f) => f.importance !== "auto_derived" && attrs[f.name] === null)
    .map((f) => f.name)

  // Write back: always use JSON inline format for machine-readability.
  // This canonicalizes pages that were previously YAML-format attributes.
  const newAttrs = JSON.stringify(attrs)
  const newContent = writeBackAttributes(content, newAttrs, originalFormat)
  return [newContent, newContent !== content, warnings]
}

/**
 * Parse attributes from a page, supporting both:
 *   JSON inline:  attributes: {"key": "val"}
 *   YAML block:   attributes:\n  key: val\n  key2: val2
 */
function parseYamlAttributes(content: string): {
  attrs: Record<string, unknown>
  rawAttrsText: string
  originalFormat: "json" | "yaml" | "none"
} {
  // Try JSON inline first (single line)
  const jsonMatch = content.match(/^attributes:\s*(\{[^\n]*\})\s*$/m)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      if (typeof parsed === "object" && !Array.isArray(parsed) && parsed !== null) {
        return { attrs: parsed as Record<string, unknown>, rawAttrsText: "", originalFormat: "json" }
      }
    } catch {
      // Fall through to YAML parse
    }
    return { attrs: {}, rawAttrsText: jsonMatch[1], originalFormat: "json" }
  }

  // Try YAML block: attributes:\n  key: value\n  key2: value2
  // The block ends at the next top-level YAML key (unindented line with ":")
  // or the frontmatter closing "---".
  const yamlBlockMatch = content.match(/^attributes:\s*\n((?:[ \t]+[^\n]+\n?)*)/m)
  if (yamlBlockMatch) {
    const block = yamlBlockMatch[1]
    const attrs: Record<string, unknown> = {}
    for (const line of block.split("\n")) {
      const stripped = line.trim()
      if (!stripped || stripped.startsWith("#")) continue
      const colonIdx = stripped.indexOf(":")
      if (colonIdx < 1) continue
      const key = stripped.slice(0, colonIdx).trim()
      let val: string = stripped.slice(colonIdx + 1).trim()
      // Strip YAML quotes
      val = val.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
      // Convert null/empty to null
      attrs[key] = (val === "" || val === "null" || val === "~") ? null : val
    }
    return { attrs, rawAttrsText: "", originalFormat: "yaml" }
  }

  return { attrs: {}, rawAttrsText: "", originalFormat: "none" }
}

function writeBackAttributes(content: string, newAttrsJson: string, originalFormat: "json" | "yaml" | "none"): string {
  if (originalFormat === "json") {
    return content.replace(/^attributes:\s*\{[^\n]*\}\s*$/m, `attributes: ${newAttrsJson}`)
  }
  if (originalFormat === "yaml") {
    // Replace the YAML block with JSON inline
    return content.replace(/^attributes:\s*\n(?:[ \t]+[^\n]+\n?)*/m, `attributes: ${newAttrsJson}\n`)
  }
  // No existing attributes block — append before closing ---
  return content.replace(/(\n---\s*)$/, `\nattributes: ${newAttrsJson}$1`)
}

function buildInverseAliasMap(entityType: string): Record<string, string> {
  const aliases = FIELD_ALIASES[entityType] ?? {}
  const inverse: Record<string, string> = {}
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      inverse[alias.toLowerCase()] = canonical
      inverse[alias] = canonical
    }
  }
  return inverse
}

function salvageFromRawText(raw: string, standardFields: string[], aliasMap: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  // Try to extract key: value pairs from malformed JSON/text
  const pairs = Array.from(raw.matchAll(/([A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*)\s*[:：]\s*([^,}\n]+)/g))
  for (const match of pairs) {
    const rawKey = match[1].trim()
    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (!value || /^null$/i.test(value)) continue
    const canonical = aliasMap[rawKey.toLowerCase()] ?? aliasMap[rawKey] ?? (standardFields.includes(rawKey) ? rawKey : null)
    if (canonical) result[canonical] = value
  }
  return result
}

// ─── Relation Inference ───────────────────────────────────────────────────────

function inferMissingRelations(content: string, index: PageIndex[]): [string, boolean] {
  const entityType = extractScalar(content, "entity_type")
  if (!entityType) return [content, false]

  // Only infer for entity types that have a known parent field
  const parentAttrField = PARENT_ATTR_FIELD[entityType]
  if (!parentAttrField) return [content, false]

  // Check if this page already has a part_of or applies_to relation
  const fm = extractFrontmatter(content)
  if (!fm) return [content, false]

  const hasPartOf = /\bpart_of\b/.test(fm)
  const hasAppliesTo = entityType !== "service_benefit" && /\bapplies_to\b/.test(fm)
  if (hasPartOf || hasAppliesTo) return [content, false]

  // Read the parent value from attributes — supports both JSON and YAML format
  const { attrs } = parseYamlAttributes(content)
  const parentValue = attrs[parentAttrField]
  const parentTitle = (typeof parentValue === "string" && parentValue.trim()) ? parentValue.trim() : ""

  if (!parentTitle) return [content, false]

  // Verify the parent page exists in the index
  const canonicalParent = entityType === "service_benefit"
    ? resolveServiceBenefitParent(parentTitle, index)
    : (resolveTarget(parentTitle, index) ?? parentTitle)

  const relationType = entityType === "service_benefit" ? "part_of" :
    entityType === "selling_point" ? "part_of" :
    entityType === "product_clause" ? "part_of" :
    entityType === "regulatory_doc" ? "governed_by" :
    "applies_to"

  // Inject the inferred relation
  const newRelLine = `  - "${relationType}: ${canonicalParent}"`
  const relationsEmptyMatch = content.match(/^relations:\s*\[\]\s*$/m)
  const relationsListMatch = content.match(/^(relations:\s*\n)((?:\s+-\s+.*\n?)*)/m)

  let newContent = content
  if (relationsEmptyMatch) {
    newContent = content.replace(
      /^relations:\s*\[\]\s*$/m,
      `relations:\n${newRelLine}`
    )
  } else if (relationsListMatch) {
    newContent = content.replace(
      relationsListMatch[0],
      `${relationsListMatch[1]}${newRelLine}\n${relationsListMatch[2]}`
    )
  } else {
    return [content, false]
  }

  return [newContent, newContent !== content]
}

// ─── Relation Reconciliation ──────────────────────────────────────────────────

function reconcileRelations(content: string, index: PageIndex[]): [string, boolean] {
  const fm = extractFrontmatter(content)
  if (!fm) return [content, false]

  const relationsMatch = fm.match(/^relations:\s*\n((?:\s+-\s+.*\n?)*)/m)
  if (!relationsMatch) return [content, false]

  const originalBlock = relationsMatch[0]
  const lines = relationsMatch[1].split("\n").filter(Boolean)

  const reconciledLines = lines.map((line) => {
    const item = line.match(/^(\s+-\s+)"?([a-z_]+)\s*:\s*([^"]+)"?\s*$/i)
    if (!item) return line
    const indent = item[1]
    const relType = item[2]
    const rawTarget = item[3].trim().replace(/^["']|["']$/g, "")

    // Don't touch file references
    if (rawTarget.endsWith(".md") || rawTarget.endsWith(".pdf")) return line

    const resolved = resolveTarget(rawTarget, index)
    if (resolved && resolved !== rawTarget) {
      return `${indent}"${relType}: ${resolved}"`
    }
    return line
  })

  const newBlock = `relations:\n${reconciledLines.join("\n")}\n`
  if (newBlock === originalBlock) return [content, false]
  return [content.replace(originalBlock, newBlock), true]
}

// ─── Page Index ───────────────────────────────────────────────────────────────

async function buildPageIndex(projectPath: string): Promise<PageIndex[]> {
  const index: PageIndex[] = []
  const dirs = [
    `${projectPath}/wiki/entities`,
    `${projectPath}/wiki/concepts`,
  ]
  for (const dir of dirs) {
    const files = await safeList(dir)
    for (const file of files) {
      if (file.is_dir || !file.name.endsWith(".md") || file.name.endsWith(".md.md")) continue
      try {
        const content = await readFile(`${dir}/${file.name}`)
        const title = extractScalar(content, "title")
        if (!title) continue
        const relativePath = dir.replace(projectPath + "/", "") + "/" + file.name
        index.push({
          title,
          relativePath,
          entityType: extractScalar(content, "entity_type"),
          normalizedForms: buildNormalizedForms(title),
        })
      } catch {
        // ignore unreadable files
      }
    }
  }
  return index
}

function buildNormalizedForms(title: string): string[] {
  const forms = new Set<string>()
  const clean = title.trim()
  forms.add(normalizeTitle(clean))
  forms.add(normalizeTitle(clean.replace(/[_\s]*(服务计划|健康服务计划|服务手册|健康服务|服务权益|权益|服务)$/, "")))
  forms.add(normalizeTitle(clean.replace(/[（(][^）)]+[）)]/g, "")))
  forms.add(normalizeTitle(clean.replace(/_[^_]+$/, "")))
  return Array.from(forms).filter(Boolean)
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-·•]+/g, "").replace(/[（()）]/g, "")
}

function resolveServiceBenefitParent(rawTarget: string, index: PageIndex[]): string {
  const resolved = resolveTargetPage(rawTarget, index)
  if (resolved?.entityType === "product") return resolved.title

  const productPages = index.filter((page) => page.entityType === "product")
  if (productPages.length === 1 && /服务手册|手册|source|\.pdf$/i.test(rawTarget)) {
    return productPages[0].title
  }

  const normalized = normalizeTitle(rawTarget)
  const productMatch = productPages.find((page) =>
    page.normalizedForms.some((form) => normalized.startsWith(form) || form.startsWith(normalized))
  )
  return productMatch?.title ?? resolved?.title ?? rawTarget
}

function resolveTarget(rawTarget: string, index: PageIndex[]): string | null {
  return resolveTargetPage(rawTarget, index)?.title ?? null
}

function resolveTargetPage(rawTarget: string, index: PageIndex[]): PageIndex | null {
  const exact = index.find((p) => p.title === rawTarget)
  if (exact) return exact
  const normalized = normalizeTitle(rawTarget)
  if (!normalized) return null
  const fuzzy = index.find((p) => p.normalizedForms.includes(normalized))
  if (fuzzy) return fuzzy
  const prefix = index.find((p) =>
    p.normalizedForms.some((form) => normalized.startsWith(form) || form.startsWith(normalized))
  )
  if (prefix) return prefix
  return null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFrontmatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1] : null
}

function extractScalar(content: string, key: string): string {
  const m = content.match(new RegExp(`^${escapeRe(key)}:\\s*"?([^"\\n]+)"?\\s*$`, "m"))
  return m ? m[1].trim() : ""
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function safeList(path: string): Promise<{ name: string; is_dir?: boolean }[]> {
  try {
    return await listDirectory(path)
  } catch {
    return []
  }
}
