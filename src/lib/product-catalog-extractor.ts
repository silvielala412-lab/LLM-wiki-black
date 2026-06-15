/**
 * Product Catalog Extraction Pipeline — V3 (Business Field Schema)
 *
 * Generates a SINGLE main .md file per product containing:
 * 1. Structured field table (short fields: 投保年龄, 犹豫期, 免赔额...)
 * 2. Detailed content sections (long fields: 保什么, 通用责任免除, 健康告知...)
 *
 * Fields are aligned with the business Excel: 产品知识库字段标签维度-20240205.xlsx
 */

import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"
import { streamChat } from "@/lib/llm-client"
import { createDirectory, writeFile } from "@/commands/fs"
import { getLogger } from "@/lib/logger"
import { useActivityStore } from "@/stores/activity-store"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  type InsuranceCategoryType,
  type ProductField,
  PRODUCT_FIELDS,
  BASE_FIELDS,
  getExtractableFields,
} from "@/lib/product-catalog-modules"

const log = getLogger("product-catalog-extractor")

/**
 * Clean the product name by stripping source file name suffixes.
 * e.g. "平安e生保（尊享版）医疗保险(保险条款)" → "平安e生保（尊享版）医疗保险"
 */
function cleanProductName(name: string): string {
  return name
    .replace(/[（(](?:保险条款|产品条款|产品说明书|投保须知|费率表|核保手册|理赔指南|服务手册|条款)[）)]/g, "")
    .trim()
}

// ── Types ─────────────────────────────────────────────────────────────────

interface FieldExtraction {
  fieldName: string
  value: string
  sectionIndex: number
}

interface SectionResult {
  sectionIndex: number
  fields: FieldExtraction[]
}

// ── Section splitting ─────────────────────────────────────────────────────

export function splitIntoSections(sourceContent: string): Chunk[] {
  return chunkMarkdown(sourceContent, {
    targetChars: 25000,
    maxChars: 40000,
    minChars: 3000,
    overlapChars: 500,
  })
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(
  fields: ProductField[],
  category: InsuranceCategoryType,
  productName: string,
  sectionIndex: number,
  totalSections: number,
): string {
  const baseFieldNames = new Set(BASE_FIELDS.map(f => f.fieldName))

  const shortFields = fields.filter(f => f.valueType === "short")
  const longFields = fields.filter(f => f.valueType === "long")

  const shortList = shortFields.map(f => {
    const hint = f.valueHint ? ` (示例: ${f.valueHint})` : ""
    const desc = f.description ? ` — ${f.description}` : ""
    const tag = baseFieldNames.has(f.fieldName) ? "[基础]" : `[${category}专属]`
    return `  - 「${f.fieldName}」${tag}${hint}${desc}`
  }).join("\n")

  const longList = longFields.map(f => {
    const tag = baseFieldNames.has(f.fieldName) ? "[基础]" : `[${category}专属]`
    return `  - 「${f.fieldName}」${tag}`
  }).join("\n")

  return [
    `你是保险产品知识库抽取专家。你将收到「${category}」类产品「${productName}」文档的第 ${sectionIndex + 1}/${totalSections} 个章节。`,
    "",
    "## 任务",
    "从本章节中抽取以下字段的信息。一个字段可能在文档的多个章节中出现，每个章节只输出本章节找到的内容。",
    "",
    "## 短值字段（输出简短值）",
    shortList,
    "",
    "## 长内容字段（输出完整原文）",
    longList,
    "",
    "## 输出格式",
    "使用 ---FIELD: 字段名--- / ---END--- 分隔符：",
    "",
    "```",
    "---FIELD: 投保年龄---",
    "0周岁（须出生满28日）至70周岁",
    "---END---",
    "",
    "---FIELD: 保什么---",
    "（输出完整的保障责任原文，保留所有编号、金额、条件）",
    "---END---",
    "```",
    "",
    "## 规则",
    "1. **短值字段**：输出简洁的值（一句话或几个关键词），如\"0-70周岁\"、\"30天\"、\"是\"、\"百万医疗\"",
    "2. **长内容字段**：保留完整原文，包括编号列表、表格、条件细则。不要摘要，不要压缩。",
    "3. 本章节没有的字段直接跳过，不输出空的 ---FIELD--- 块",
    "4. 不要编造信息，只抽取本章节中明确出现的内容",
    "5. 保留原文措辞，使用 markdown 格式组织",
  ].join("\n")
}

// ── LLM streaming ─────────────────────────────────────────────────────────

async function streamText(
  config: LlmConfig,
  messages: Parameters<typeof streamChat>[1],
  signal?: AbortSignal,
  overrides?: Parameters<typeof streamChat>[4],
): Promise<string> {
  let out = ""
  let streamError: Error | null = null
  await streamChat(
    config,
    messages,
    {
      onToken: (chunk) => { out += chunk },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
    signal,
    overrides,
  )
  if (streamError) throw streamError
  return out.trim()
}

// ── Parse response ────────────────────────────────────────────────────────

function parseFieldBlocks(response: string, validFieldNames: Set<string>): FieldExtraction[] {
  const results: FieldExtraction[] = []
  const regex = /---FIELD:\s*(.+?)\s*---\n([\s\S]*?)---END---/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    const fieldName = match[1].trim()
    const value = match[2].trim()
    if (!value) continue

    // Fuzzy match
    let matchedName: string | null = null
    if (validFieldNames.has(fieldName)) {
      matchedName = fieldName
    } else {
      for (const valid of validFieldNames) {
        if (fieldName.includes(valid) || valid.includes(fieldName)) {
          matchedName = valid
          break
        }
      }
    }

    if (matchedName) {
      results.push({ fieldName: matchedName, value, sectionIndex: 0 })
    } else {
      log.warn("unrecognized field in LLM output", { fieldName })
    }
  }
  return results
}

// ── Per-section extraction ────────────────────────────────────────────────

async function extractFieldsFromSection(
  sectionText: string,
  sectionIndex: number,
  sectionHeading: string,
  totalSections: number,
  fields: ProductField[],
  category: InsuranceCategoryType,
  productName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<SectionResult> {
  const prompt = buildPrompt(fields, category, productName, sectionIndex, totalSections)
  const activity = useActivityStore.getState()
  activity.updateItem(activityId, {
    detail: `章节 ${sectionIndex + 1}/${totalSections}: 正在抽取字段...`,
  })

  let rawResponse: string
  try {
    rawResponse = await streamText(
      llmConfig,
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            `## 章节 ${sectionIndex + 1}/${totalSections}`,
            sectionHeading ? `章节标题: ${sectionHeading}` : "",
            "",
            sectionText,
          ].filter(Boolean).join("\n"),
        },
      ],
      signal,
      { temperature: 0.05, max_tokens: 8192 },
    )
  } catch (err) {
    log.warn("section extraction failed", { section: sectionIndex, error: String(err) })
    return { sectionIndex, fields: [] }
  }

  const validNames = new Set(fields.map(f => f.fieldName))
  const extractions = parseFieldBlocks(rawResponse, validNames)
  for (const e of extractions) e.sectionIndex = sectionIndex

  log.info("section done", {
    section: sectionIndex + 1,
    fields: extractions.map(e => e.fieldName),
  })

  return { sectionIndex, fields: extractions }
}

// ── Cross-section merge ───────────────────────────────────────────────────

interface MergedField {
  fieldName: string
  values: string[]            // deduplicated values from all sections
  sectionIndices: number[]    // which sections contributed
}

function mergeFields(
  sectionResults: SectionResult[],
  allFields: ProductField[],
): Map<string, MergedField> {
  const merged = new Map<string, MergedField>()
  for (const f of allFields) {
    merged.set(f.fieldName, { fieldName: f.fieldName, values: [], sectionIndices: [] })
  }

  const sorted = [...sectionResults].sort((a, b) => a.sectionIndex - b.sectionIndex)
  for (const section of sorted) {
    for (const ext of section.fields) {
      const m = merged.get(ext.fieldName)
      if (!m) continue
      // Dedup identical values
      const normalized = ext.value.replace(/\s+/g, " ").trim()
      const isDuplicate = m.values.some(v => v.replace(/\s+/g, " ").trim() === normalized)
      if (!isDuplicate) {
        m.values.push(ext.value)
        m.sectionIndices.push(ext.sectionIndex)
      }
    }
  }

  return merged
}

// ── Main file generation ──────────────────────────────────────────────────

function buildMainProductFile(
  mergedFields: Map<string, MergedField>,
  allFields: ProductField[],
  category: InsuranceCategoryType,
  productName: string,
  sections: number,
): string {
  const lines: string[] = []
  const baseFieldNames = new Set(BASE_FIELDS.map(f => f.fieldName))

  // Frontmatter
  lines.push("---")
  lines.push(`title: "${category}-${productName}"`)
  lines.push(`knowledge_domain: product_catalog`)
  lines.push(`insurance_category: "${category}"`)
  lines.push(`product_name: "${productName}"`)
  lines.push(`entity_type: product_profile`)
  lines.push(`status: candidate`)
  lines.push(`created_by: auto-extract`)
  lines.push(`extraction_method: field-scan-merge-v3`)
  lines.push(`source_sections: ${sections}`)
  lines.push("---")
  lines.push("")

  // Title
  lines.push(`# ${productName}`)
  lines.push("")

  // ── Short fields: structured table ──────────────────────────
  const shortBaseFields = allFields.filter(f => f.valueType === "short" && baseFieldNames.has(f.fieldName))
  const shortCategoryFields = allFields.filter(f => f.valueType === "short" && !baseFieldNames.has(f.fieldName))

  lines.push("## 基础信息")
  lines.push("")
  lines.push("| 字段 | 值 |")
  lines.push("|---|---|")
  for (const f of shortBaseFields) {
    const m = mergedFields.get(f.fieldName)
    const val = m && m.values.length > 0 ? m.values.join("；") : "（待填写）"
    lines.push(`| ${f.fieldName} | ${val.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`)
  }
  lines.push("")

  if (shortCategoryFields.length > 0) {
    lines.push(`## ${category}专属信息`)
    lines.push("")
    lines.push("| 字段 | 值 |")
    lines.push("|---|---|")
    for (const f of shortCategoryFields) {
      const m = mergedFields.get(f.fieldName)
      const val = m && m.values.length > 0 ? m.values.join("；") : "（待填写）"
      lines.push(`| ${f.fieldName} | ${val.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`)
    }
    lines.push("")
  }

  // ── Long fields: detailed sections ──────────────────────────
  const longFields = allFields.filter(f => f.valueType === "long")
  for (const f of longFields) {
    const m = mergedFields.get(f.fieldName)
    if (!m || m.values.length === 0) continue

    const tag = baseFieldNames.has(f.fieldName) ? "" : ` [${category}专属]`
    lines.push(`## ${f.fieldName}${tag}`)
    lines.push("")

    if (m.values.length === 1) {
      lines.push(m.values[0])
    } else {
      // Multiple sections contributed — join with source markers
      for (let i = 0; i < m.values.length; i++) {
        if (i > 0) {
          lines.push("")
          lines.push("---")
          lines.push(`<!-- 以下内容来自文档第 ${m.sectionIndices[i] + 1} 部分 -->`)
          lines.push("")
        }
        lines.push(m.values[i])
      }
    }
    lines.push("")
  }

  // ── Missing fields summary ──────────────────────────────────
  const missing = allFields.filter(f => {
    if (!f.extractable) return false
    const m = mergedFields.get(f.fieldName)
    return !m || m.values.length === 0
  })
  if (missing.length > 0) {
    lines.push("## 待补全字段")
    lines.push("")
    for (const f of missing) {
      lines.push(`- [ ] ${f.fieldName}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ── Top-level orchestrator ────────────────────────────────────────────────

const MAX_SECTION_PARALLEL = 4

export async function runProductCatalogExtraction(
  projectPath: string,
  sourceContent: string,
  fileName: string,
  category: InsuranceCategoryType,
  rawProductName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const productName = cleanProductName(rawProductName)
  log.info("product name cleaned", { raw: rawProductName, clean: productName })

  const activity = useActivityStore.getState()
  const allFields = PRODUCT_FIELDS[category] ?? []
  const extractableFields = getExtractableFields(category)

  if (extractableFields.length === 0) {
    log.warn("no extractable fields for category", { category })
    return []
  }

  // ── Phase 1: Split ─────────────────────────────────────────
  activity.updateItem(activityId, { detail: "正在按章节切分文档..." })
  const sections = splitIntoSections(sourceContent)
  log.info("document split", { file: fileName, sections: sections.length })

  if (sections.length === 0) return []

  activity.updateItem(activityId, {
    detail: `切分为 ${sections.length} 个章节，开始并行抽取 ${extractableFields.length} 个字段...`,
  })

  // ── Phase 2: Parallel extraction ───────────────────────────
  const sectionResults: SectionResult[] = []
  for (let i = 0; i < sections.length; i += MAX_SECTION_PARALLEL) {
    if (signal?.aborted) break
    const batch = sections.slice(i, i + MAX_SECTION_PARALLEL)
    const promises = batch.map((section, offset) =>
      extractFieldsFromSection(
        section.text, i + offset, section.headingPath,
        sections.length, extractableFields,
        category, productName, llmConfig, activityId, signal,
      ),
    )
    const results = await Promise.allSettled(promises)
    for (const r of results) {
      if (r.status === "fulfilled") sectionResults.push(r.value)
    }
    activity.updateItem(activityId, {
      detail: `已抽取 ${Math.min(i + MAX_SECTION_PARALLEL, sections.length)}/${sections.length} 个章节...`,
    })
  }

  // ── Phase 3: Merge ─────────────────────────────────────────
  activity.updateItem(activityId, { detail: "正在跨章节合并字段..." })
  const mergedFields = mergeFields(sectionResults, allFields)

  const filledCount = [...mergedFields.values()].filter(m => m.values.length > 0).length
  log.info("merge complete", {
    file: fileName,
    totalFields: allFields.length,
    filledFields: filledCount,
  })

  if (filledCount === 0) {
    activity.updateItem(activityId, { detail: "未能从文档中提取到任何字段。" })
    return []
  }

  // ── Phase 4: Write main file ───────────────────────────────
  activity.updateItem(activityId, { detail: `正在生成产品主文件 + 模块文件...` })
  const catalogDir = `${projectPath}/wiki/product_catalog`
  await createDirectory(catalogDir)

  const mainContent = buildMainProductFile(
    mergedFields, allFields, category, productName, sections.length,
  )
  const mainFileName = `${category}-${productName}.md`
  const mainPath = `${catalogDir}/${mainFileName}`
  const mainRelative = `wiki/product_catalog/${mainFileName}`

  const writtenPaths: string[] = []
  try {
    await writeFile(mainPath, mainContent)
    writtenPaths.push(mainRelative)
    log.info("main product file written", {
      path: mainRelative,
      chars: mainContent.length,
      fields: filledCount,
    })
  } catch (err) {
    log.error("failed to write main file", { error: String(err) })
  }

  // ── Phase 5: Write individual module files for long fields ──
  const baseFieldNames = new Set(BASE_FIELDS.map(f => f.fieldName))
  const longFields = allFields.filter(f => f.valueType === "long")

  for (const f of longFields) {
    const m = mergedFields.get(f.fieldName)
    if (!m || m.values.length === 0) continue

    // Build module file content
    const moduleLines: string[] = []
    moduleLines.push("---")
    moduleLines.push(`title: "${category}-${productName}-${f.fieldName}"`)
    moduleLines.push(`knowledge_domain: product_catalog`)
    moduleLines.push(`insurance_category: "${category}"`)
    moduleLines.push(`product_name: "${productName}"`)
    moduleLines.push(`field_name: "${f.fieldName}"`)
    moduleLines.push(`field_type: long`)
    moduleLines.push(`status: candidate`)
    moduleLines.push(`created_by: auto-extract`)
    moduleLines.push(`source_sections: ${m.sectionIndices.length}`)
    moduleLines.push("---")
    moduleLines.push("")
    moduleLines.push(`# ${f.fieldName}`)
    moduleLines.push("")

    if (m.values.length === 1) {
      moduleLines.push(m.values[0])
    } else {
      for (let i = 0; i < m.values.length; i++) {
        if (i > 0) {
          moduleLines.push("")
          moduleLines.push("---")
          moduleLines.push(`<!-- 以下内容来自文档第 ${m.sectionIndices[i] + 1} 部分 -->`)
          moduleLines.push("")
        }
        moduleLines.push(m.values[i])
      }
    }

    const moduleFileName = `${category}-${productName}-${f.fieldName}.md`
    const modulePath = `${catalogDir}/${moduleFileName}`
    const moduleRelative = `wiki/product_catalog/${moduleFileName}`

    try {
      await writeFile(modulePath, moduleLines.join("\n"))
      writtenPaths.push(moduleRelative)
    } catch (err) {
      log.error("failed to write module file", { path: moduleRelative, error: String(err) })
    }
  }

  log.info("all files written", {
    total: writtenPaths.length,
    mainFile: mainRelative,
    moduleFiles: writtenPaths.length - 1,
  })

  activity.updateItem(activityId, {
    detail: `完成：${filledCount}/${allFields.length} 个字段，${writtenPaths.length} 个文件已写入（1 主文件 + ${writtenPaths.length - 1} 模块文件）。`,
  })

  return writtenPaths
}
