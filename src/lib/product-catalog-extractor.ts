/**
 * Product Catalog Extraction Pipeline — Section-Scan + Merge Architecture
 *
 * Instead of sending the full 200K document 7 times (once per module batch),
 * this pipeline:
 *   1. Splits the document into semantic sections (~15-30K chars each)
 *   2. Sends each section to the LLM ONCE, extracting ALL matching modules
 *   3. Merges per-module data fragments across sections
 *   4. Writes final .md files
 *
 * Benefits vs batch-of-modules:
 *   - Token cost: ~116K total vs ~1.4M (12× savings)
 *   - Latency: ~30s (parallel sections) vs ~3.5min (serial batches)
 *   - Quality: scattered info (e.g. 投保年龄 on page 1, 40, 95) is
 *     naturally aggregated because the merge step collects across sections
 *   - No compression: each section is small enough to fit in context raw
 */

import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"
import { streamChat } from "@/lib/llm-client"
import { createDirectory, writeFile } from "@/commands/fs"
import { getLogger } from "@/lib/logger"
import { useActivityStore } from "@/stores/activity-store"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  type InsuranceCategoryType,
  PRODUCT_CATALOG_MODULES,
  type ProductModule,
} from "@/lib/product-catalog-modules"

const log = getLogger("product-catalog-extractor")

// ── Types ─────────────────────────────────────────────────────────────────

/** One data point extracted from a section for a specific module. */
export interface ModuleField {
  field: string
  value: string
  confidence: number
  /** Direct quote from source text. */
  quote: string
  /** Which section this data came from. */
  sectionIndex: number
}

/** All data extracted for a single module, aggregated across sections. */
export interface ModuleExtraction {
  moduleName: string
  fields: ModuleField[]
  /** Whether any section had data for this module. */
  found: boolean
}

/** Per-section extraction result: which modules had data in this section. */
interface SectionExtractionResult {
  sectionIndex: number
  sectionHeading: string
  modules: Record<string, ModuleField[]>
}

// ── Section splitting ─────────────────────────────────────────────────────

/**
 * Split source content into semantic sections for parallel extraction.
 * Uses larger chunks than the embedding chunker — we want "chapter-level"
 * splits that correspond to logical document sections (产品概述, 投保规则, etc.)
 */
export function splitIntoSections(sourceContent: string): Chunk[] {
  return chunkMarkdown(sourceContent, {
    targetChars: 25000,   // ~5000 tokens per section
    maxChars: 40000,      // allow up to 8K tokens for large sections
    minChars: 3000,       // don't emit tiny fragments
    overlapChars: 500,    // small overlap to catch boundary info
  })
}

// ── Per-section LLM extraction ────────────────────────────────────────────

function buildSectionExtractionPrompt(
  moduleNames: string[],
  category: InsuranceCategoryType,
  productName: string,
  sectionIndex: number,
  totalSections: number,
): string {
  const moduleList = moduleNames.map((m) => `  - "${m}"`).join("\n")
  return [
    "You are a precise insurance policy data extractor.",
    "You will receive ONE SECTION of an insurance product document.",
    "Your job: scan this section and extract STRUCTURED DATA for any of the target modules listed below.",
    "",
    `Insurance category: ${category}`,
    `Product: ${productName}`,
    `Section: ${sectionIndex + 1} / ${totalSections}`,
    "",
    "## Target modules (extract data ONLY for modules that have relevant content in this section):",
    moduleList,
    "",
    "## Output format: VALID JSON only. No markdown, no explanation.",
    "Return a JSON object where each key is a module name from the list above.",
    "Only include modules that have ACTUAL DATA in this section. Omit modules with no relevant content.",
    "",
    "Each module's value is an array of field objects:",
    "```json",
    "{",
    '  "投保年龄": [',
    '    { "field": "投保年龄范围", "value": "18-55周岁", "confidence": 1.0, "quote": "被保险人投保时须年满18周岁且不超过55周岁" },',
    '    { "field": "续保年龄上限", "value": "80周岁", "confidence": 1.0, "quote": "续保可至80周岁" }',
    "  ],",
    '  "疾病等待期": [',
    '    { "field": "等待期天数", "value": "90天", "confidence": 1.0, "quote": "自合同生效之日起90日内..." }',
    "  ]",
    "}",
    "```",
    "",
    "Rules:",
    "- `field`: descriptive field name in Chinese",
    "- `value`: the EXACT value from the source text (numbers, percentages, dates, conditions)",
    "- `confidence`: 1.0 if explicitly stated; 0.7 if inferred; 0.5 if uncertain",
    "- `quote`: verbatim quote from source text (keep original wording, max 200 chars)",
    "- If this section has NO data for any target module, return an empty object: {}",
    "- Do NOT invent data. Only extract what is explicitly present in this section.",
    "- Preserve tables, lists, and structured data as-is in the value field",
    "- For health declaration questions (健康告知), extract EACH question as a separate field",
    "- For exclusion clauses (责任免除), extract EACH clause as a separate field",
    "- For claim materials (理赔材料), extract EACH item as a separate field",
  ].join("\n")
}

/**
 * Stream text from the LLM and return the raw response.
 */
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
    (chunk) => { out += chunk },
    (err) => { streamError = err },
    signal,
    overrides,
  )
  if (streamError) throw streamError
  return out.trim()
}

/**
 * Extract all matching module data from a single section.
 */
async function extractModulesFromSection(
  sectionText: string,
  sectionIndex: number,
  sectionHeading: string,
  totalSections: number,
  moduleNames: string[],
  category: InsuranceCategoryType,
  productName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<SectionExtractionResult> {
  const prompt = buildSectionExtractionPrompt(
    moduleNames, category, productName, sectionIndex, totalSections,
  )

  const activity = useActivityStore.getState()
  activity.updateItem(activityId, {
    detail: `Section ${sectionIndex + 1}/${totalSections}: extracting modules...`,
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
            `## Section ${sectionIndex + 1}/${totalSections}`,
            sectionHeading ? `Heading context: ${sectionHeading}` : "",
            "",
            sectionText,
          ].filter(Boolean).join("\n"),
        },
      ],
      signal,
      { temperature: 0.05, max_tokens: 4096 },
    )
  } catch (err) {
    log.warn("section extraction failed", {
      section: sectionIndex,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sectionIndex, sectionHeading, modules: {} }
  }

  // Parse JSON response
  const modules: Record<string, ModuleField[]> = {}
  try {
    // Strip markdown code fences if LLM wrapped the JSON
    let jsonStr = rawResponse
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    if (fenceMatch) jsonStr = fenceMatch[1]

    // Also try to find the outermost { ... }
    const braceStart = jsonStr.indexOf("{")
    const braceEnd = jsonStr.lastIndexOf("}")
    if (braceStart >= 0 && braceEnd > braceStart) {
      jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
    }

    const parsed = JSON.parse(jsonStr) as Record<string, Array<{
      field?: string
      value?: string
      confidence?: number
      quote?: string
    }>>

    for (const [moduleName, fields] of Object.entries(parsed)) {
      if (!Array.isArray(fields)) continue
      if (!moduleNames.includes(moduleName)) continue // skip unknown modules
      modules[moduleName] = fields
        .filter((f) => f.field && f.value)
        .map((f) => ({
          field: String(f.field),
          value: String(f.value),
          confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
          quote: String(f.quote || ""),
          sectionIndex,
        }))
    }
  } catch (parseErr) {
    log.warn("section JSON parse failed", {
      section: sectionIndex,
      responseLength: rawResponse.length,
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      responsePreview: rawResponse.slice(0, 300),
    })
  }

  const foundModules = Object.keys(modules).filter((k) => modules[k].length > 0)
  if (foundModules.length > 0) {
    log.info("section extraction done", {
      section: sectionIndex + 1,
      heading: sectionHeading.slice(0, 60),
      modules: foundModules,
      totalFields: Object.values(modules).reduce((sum, fields) => sum + fields.length, 0),
    })
  }

  return { sectionIndex, sectionHeading, modules }
}

// ── Cross-section merge ───────────────────────────────────────────────────

/**
 * Merge per-module data from all sections. Deduplicates identical field+value
 * pairs; keeps both when values differ for the same field.
 */
export function mergeModuleFragments(
  sectionResults: SectionExtractionResult[],
  allModuleNames: string[],
): ModuleExtraction[] {
  const byModule = new Map<string, ModuleField[]>()

  // Initialize all modules
  for (const name of allModuleNames) {
    byModule.set(name, [])
  }

  // Collect fields from all sections
  for (const section of sectionResults) {
    for (const [moduleName, fields] of Object.entries(section.modules)) {
      const existing = byModule.get(moduleName)
      if (existing) {
        existing.push(...fields)
      }
    }
  }

  // Deduplicate: same field + same value → keep only the higher confidence one
  const results: ModuleExtraction[] = []
  for (const [moduleName, allFields] of byModule) {
    const deduped = deduplicateFields(allFields)
    results.push({
      moduleName,
      fields: deduped,
      found: deduped.length > 0,
    })
  }

  return results
}

function deduplicateFields(fields: ModuleField[]): ModuleField[] {
  const seen = new Map<string, ModuleField>()
  for (const f of fields) {
    const key = `${f.field}|||${f.value}`
    const existing = seen.get(key)
    if (!existing || f.confidence > existing.confidence) {
      seen.set(key, f)
    }
  }
  return [...seen.values()]
}

// ── Final .md file generation ─────────────────────────────────────────────

/**
 * Generate the markdown content for a single module file.
 */
export function buildModuleMarkdownFile(
  extraction: ModuleExtraction,
  category: InsuranceCategoryType,
  productName: string,
  moduleDef: ProductModule | undefined,
): string {
  const lines: string[] = []

  // Frontmatter
  lines.push("---")
  lines.push(`title: "${category}-${productName}-${extraction.moduleName}"`)
  lines.push(`knowledge_domain: product_catalog`)
  lines.push(`insurance_category: "${category}"`)
  lines.push(`product_name: "${productName}"`)
  lines.push(`entity_type: "${moduleDef?.entityType || "product_detail"}"`)
  lines.push(`dedup_key: "${category}-${productName}-${extraction.moduleName}"`)
  lines.push(`status: candidate`)
  lines.push(`created_by: auto-extract`)
  lines.push(`extraction_method: section-scan-merge`)
  const inferred = extraction.fields.filter((f) => f.confidence < 1.0)
  if (inferred.length > 0) {
    lines.push(`inferred_fields: [${inferred.map((f) => `"${f.field}"`).join(", ")}]`)
  }
  lines.push("---")
  lines.push("")

  // Title
  lines.push(`# ${extraction.moduleName}`)
  lines.push("")

  // One-sentence summary
  lines.push("## 一句话摘要")
  lines.push("")
  const topFields = extraction.fields.slice(0, 3)
  if (topFields.length > 0) {
    lines.push(
      topFields.map((f) => `${f.field}：${f.value}`).join("；") + "。",
    )
  } else {
    lines.push("（此模块在源文档中未发现明确数据）")
  }
  lines.push("")

  // Structured content table
  lines.push("## 结构化内容")
  lines.push("")
  if (extraction.fields.length > 0) {
    lines.push("| 字段 | 值 | 置信度 |")
    lines.push("|---|---|---|")
    for (const f of extraction.fields) {
      // Escape pipes in values for table safety
      const safeValue = f.value.replace(/\|/g, "\\|").replace(/\n/g, " ")
      lines.push(`| ${f.field} | ${safeValue} | ${f.confidence} |`)
    }
  } else {
    lines.push("（无结构化数据）")
  }
  lines.push("")

  // Source quotes
  const quotes = extraction.fields
    .filter((f) => f.quote && f.quote.trim())
    .map((f) => f.quote)
  const uniqueQuotes = [...new Set(quotes)]
  lines.push("## 原文依据")
  lines.push("")
  if (uniqueQuotes.length > 0) {
    for (const q of uniqueQuotes.slice(0, 10)) {
      lines.push(`> ${q.replace(/\n/g, "\n> ")}`)
      lines.push("")
    }
  } else {
    lines.push("（无原文引用）")
  }
  lines.push("")

  // Missing info
  lines.push("## 待补全信息")
  lines.push("")
  if (moduleDef) {
    const expectedFields = getExpectedFieldsForModule(moduleDef)
    const extractedFieldNames = new Set(extraction.fields.map((f) => f.field))
    const missing = expectedFields.filter((f) => !extractedFieldNames.has(f))
    if (missing.length > 0) {
      for (const m of missing) {
        lines.push(`- [ ] ${m}`)
      }
    } else {
      lines.push("（暂无）")
    }
  } else {
    lines.push("（暂无）")
  }

  return lines.join("\n")
}

/** Heuristic: expected fields for common module types. */
function getExpectedFieldsForModule(moduleDef: ProductModule): string[] {
  const name = moduleDef.moduleName
  const map: Record<string, string[]> = {
    "产品基础信息": ["产品名称", "保险公司", "保险期间", "交费方式", "保额范围"],
    "投保年龄": ["投保年龄范围", "续保年龄上限"],
    "投保职业": ["职业类别限制", "特殊职业限制"],
    "投保人群": ["适用人群", "不适用人群"],
    "疾病等待期": ["等待期天数", "适用范围", "等待期内出险处理"],
    "犹豫期": ["犹豫期天数", "退费规则"],
    "专属健康告知": ["健康告知问题列表"],
    "责任免除": ["免责条款列表"],
    "费率表": ["费率数据"],
  }
  return map[name] || []
}

// ── Top-level orchestrator ────────────────────────────────────────────────

/** Max parallel section extractions. Respects LLM rate limits. */
const MAX_SECTION_PARALLEL = 4

/**
 * Main entry point: run the full section-scan + merge extraction pipeline.
 *
 * @returns List of written file paths (relative to project root).
 */
export async function runProductCatalogExtraction(
  projectPath: string,
  sourceContent: string,
  fileName: string,
  category: InsuranceCategoryType,
  productName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const activity = useActivityStore.getState()
  const allModules = PRODUCT_CATALOG_MODULES[category] ?? []
  const allModuleNames = allModules.map((m) => m.moduleName)

  if (allModuleNames.length === 0) {
    log.warn("no modules defined for category", { category })
    return []
  }

  // ── Phase 1: Split into sections ───────────────────────────────────
  activity.updateItem(activityId, {
    detail: `Splitting document into sections...`,
  })

  const sections = splitIntoSections(sourceContent)
  log.info("document split", {
    file: fileName,
    sections: sections.length,
    totalChars: sourceContent.length,
    sectionSizes: sections.map((s) => s.text.length),
  })

  if (sections.length === 0) {
    log.warn("no sections produced", { file: fileName })
    return []
  }

  activity.updateItem(activityId, {
    detail: `${sections.length} sections found. Starting parallel extraction...`,
  })

  // ── Phase 2: Parallel per-section extraction ───────────────────────
  const sectionResults: SectionExtractionResult[] = []

  // Process sections in parallel batches
  for (let i = 0; i < sections.length; i += MAX_SECTION_PARALLEL) {
    if (signal?.aborted) break
    const batch = sections.slice(i, i + MAX_SECTION_PARALLEL)
    const batchPromises = batch.map((section, batchOffset) =>
      extractModulesFromSection(
        section.text,
        i + batchOffset,
        section.headingPath,
        sections.length,
        allModuleNames,
        category,
        productName,
        llmConfig,
        activityId,
        signal,
      ),
    )
    const batchResults = await Promise.allSettled(batchPromises)

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        sectionResults.push(result.value)
      } else {
        log.warn("section extraction rejected", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }

    activity.updateItem(activityId, {
      detail: `Extracted ${Math.min(i + MAX_SECTION_PARALLEL, sections.length)}/${sections.length} sections...`,
    })
  }

  // ── Phase 3: Cross-section merge ───────────────────────────────────
  activity.updateItem(activityId, {
    detail: `Merging data across ${sectionResults.length} sections...`,
  })

  const mergedModules = mergeModuleFragments(sectionResults, allModuleNames)
  const foundModules = mergedModules.filter((m) => m.found)

  log.info("merge complete", {
    file: fileName,
    totalModules: allModuleNames.length,
    foundModules: foundModules.length,
    totalFields: foundModules.reduce((sum, m) => sum + m.fields.length, 0),
    moduleNames: foundModules.map((m) => m.moduleName),
  })

  if (foundModules.length === 0) {
    log.warn("no modules found in any section", { file: fileName })
    activity.updateItem(activityId, {
      detail: `No module data found in ${sections.length} sections.`,
    })
    return []
  }

  // ── Phase 4: Write .md files ───────────────────────────────────────
  activity.updateItem(activityId, {
    detail: `Writing ${foundModules.length} module files...`,
  })

  const writtenPaths: string[] = []
  const catalogDir = `${projectPath}/wiki/product_catalog`
  await createDirectory(catalogDir)

  for (const extraction of foundModules) {
    const moduleDef = allModules.find((m) => m.moduleName === extraction.moduleName)
    const mdContent = buildModuleMarkdownFile(extraction, category, productName, moduleDef)
    const mdFileName = `${category}-${productName}-${extraction.moduleName}.md`
    const mdPath = `${catalogDir}/${mdFileName}`
    const relativePath = `wiki/product_catalog/${mdFileName}`

    try {
      await writeFile(mdPath, mdContent)
      writtenPaths.push(relativePath)
      log.info("module file written", {
        path: relativePath,
        fields: extraction.fields.length,
      })
    } catch (err) {
      log.error("failed to write module file", {
        path: relativePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Also write source summary ──────────────────────────────────────
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const sourceSummaryFullPath = `${projectPath}/${sourceSummaryPath}`
  try {
    const summaryContent = [
      "---",
      `title: "${fileName}"`,
      `entity_type: source`,
      `knowledge_domain: product_catalog`,
      `insurance_category: "${category}"`,
      `product_name: "${productName}"`,
      `status: candidate`,
      "---",
      "",
      `# ${fileName}`,
      "",
      `**Insurance category:** ${category}`,
      `**Product:** ${productName}`,
      `**Extraction method:** section-scan-merge (${sections.length} sections)`,
      `**Modules extracted:** ${foundModules.length}/${allModuleNames.length}`,
      "",
      "## Extracted modules",
      "",
      ...foundModules.map(
        (m) => `- **${m.moduleName}** (${m.fields.length} fields)`,
      ),
      "",
      "## Missing modules",
      "",
      ...mergedModules
        .filter((m) => !m.found)
        .map((m) => `- [ ] ${m.moduleName}`),
    ].join("\n")

    await createDirectory(`${projectPath}/wiki/sources`)
    await writeFile(sourceSummaryFullPath, summaryContent)
    writtenPaths.push(sourceSummaryPath)
  } catch (err) {
    log.warn("failed to write source summary", {
      path: sourceSummaryPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  activity.updateItem(activityId, {
    detail: `Done: ${foundModules.length} modules, ${writtenPaths.length} files written.`,
  })

  return writtenPaths
}
