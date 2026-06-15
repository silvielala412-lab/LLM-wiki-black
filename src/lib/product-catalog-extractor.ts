/**
 * Product Catalog Extraction Pipeline — Section-Scan + Merge Architecture
 *
 * V2: Full-markdown extraction (not JSON field-value).
 *
 * For each section of the document, the LLM outputs FULL MARKDOWN content
 * for each matching module using ---MODULE: name--- / ---END--- delimiters.
 * This preserves clause text, numbered lists, tables, conditions — everything
 * that JSON field-value format would lose.
 *
 * Cross-section merge simply concatenates markdown fragments per module.
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

/**
 * Clean the product name by stripping source file name suffixes.
 * e.g. "平安e生保（尊享版）医疗保险(保险条款)" → "平安e生保（尊享版）医疗保险"
 */
function cleanProductName(name: string): string {
  // Strip common source document type suffixes in parentheses
  return name
    .replace(/[（(](?:保险条款|产品条款|产品说明书|投保须知|费率表|核保手册|理赔指南|服务手册|条款)[）)]/g, "")
    .trim()
}

// ── Types ─────────────────────────────────────────────────────────────────

/** Markdown content extracted for a module from one section. */
interface ModuleFragment {
  moduleName: string
  markdown: string
  sectionIndex: number
}

/** Per-section extraction result. */
interface SectionExtractionResult {
  sectionIndex: number
  fragments: ModuleFragment[]
}

/** Final merged module with all content across sections. */
interface MergedModule {
  moduleName: string
  /** Concatenated markdown from all sections. */
  content: string
  /** How many sections contributed data. */
  sectionCount: number
  found: boolean
}

// ── Section splitting ─────────────────────────────────────────────────────

/**
 * Split source content into semantic sections for parallel extraction.
 * Chapter-level splits (~15-30K chars).
 */
export function splitIntoSections(sourceContent: string): Chunk[] {
  return chunkMarkdown(sourceContent, {
    targetChars: 25000,   // ~5000 tokens per section
    maxChars: 40000,      // up to 8K tokens for large sections
    minChars: 3000,       // don't emit tiny fragments
    overlapChars: 500,    // small overlap to catch boundary info
  })
}

// ── Per-section LLM extraction (full markdown output) ─────────────────────

function buildSectionExtractionPrompt(
  modules: ProductModule[],
  category: InsuranceCategoryType,
  productName: string,
  sectionIndex: number,
  totalSections: number,
): string {
  // Build module list with descriptions for better matching
  const moduleList = modules.map((m) =>
    `  - 「${m.moduleName}」(${m.entityType})`
  ).join("\n")

  return [
    `你是一个保险条款信息抽取专家。你将收到一份「${category}」类保险产品「${productName}」文档的第 ${sectionIndex + 1}/${totalSections} 个章节。`,
    "",
    "## 你的任务",
    "仔细阅读本章节内容，将其中的信息归类到以下目标模块中。",
    "**对于每个在本章节中有相关内容的模块，输出该模块的完整 markdown 内容。**",
    "",
    "## 目标模块列表",
    moduleList,
    "",
    "## 输出格式",
    "使用以下分隔符格式输出，每个模块一个块：",
    "",
    "```",
    "---MODULE: 投保年龄---",
    "（这里输出该模块的完整内容，保持原文的信息量）",
    "---END---",
    "",
    "---MODULE: 疾病等待期---",
    "（这里输出该模块的完整内容）",
    "---END---",
    "```",
    "",
    "## 关键规则",
    "1. **保留完整信息**：不要摘要、不要压缩。原文写了什么就保留什么。条款原文、编号、金额、百分比、条件清单全部保留。",
    "2. **保留表格和列表**：如果原文有表格，完整复制；如果有编号列表（1. 2. 3.），完整复制。",
    "3. **保留原文措辞**：使用原文的用词，不要改写或简化。",
    "4. **适当组织结构**：可以加 markdown 标题（##、###）来组织信息，但内容必须是原文。",
    "5. **一个信息可以归属多个模块**：如果某段内容同时涉及「保障责任」和「赔付规则」，两个模块都输出。",
    "6. **空模块不输出**：如果本章节没有某个模块的信息，不要输出该模块的 ---MODULE--- 块。",
    "7. **健康告知要逐条列出**：每个告知问题单独一行。",
    "8. **责任免除要逐条列出**：每个免责条款单独列出，保留编号。",
    "9. **费率表要保留完整表格数据**。",
    "10. 对于本章节完全没有涉及的模块，直接跳过不输出。",
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

/**
 * Parse ---MODULE: name--- / ---END--- blocks from LLM response.
 */
function parseModuleBlocks(response: string, validModuleNames: Set<string>): ModuleFragment[] {
  const fragments: ModuleFragment[] = []
  // Match all ---MODULE: xxx--- ... ---END--- blocks
  const regex = /---MODULE:\s*(.+?)\s*---\n([\s\S]*?)---END---/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    const moduleName = match[1].trim()
    const markdown = match[2].trim()

    if (!markdown) continue

    // Fuzzy match: try exact first, then check if any valid name contains/is contained by the output
    let matchedName: string | null = null
    if (validModuleNames.has(moduleName)) {
      matchedName = moduleName
    } else {
      // Fuzzy: find the closest valid module name
      for (const valid of validModuleNames) {
        if (moduleName.includes(valid) || valid.includes(moduleName)) {
          matchedName = valid
          break
        }
      }
    }

    if (matchedName) {
      fragments.push({ moduleName: matchedName, markdown, sectionIndex: 0 })
    } else {
      log.warn("unrecognized module name in LLM output", { moduleName, preview: markdown.slice(0, 100) })
    }
  }

  return fragments
}

/**
 * Extract all matching module data from a single section.
 */
async function extractModulesFromSection(
  sectionText: string,
  sectionIndex: number,
  sectionHeading: string,
  totalSections: number,
  modules: ProductModule[],
  category: InsuranceCategoryType,
  productName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<SectionExtractionResult> {
  const prompt = buildSectionExtractionPrompt(
    modules, category, productName, sectionIndex, totalSections,
  )

  const activity = useActivityStore.getState()
  activity.updateItem(activityId, {
    detail: `章节 ${sectionIndex + 1}/${totalSections}: 正在抽取模块...`,
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
            sectionHeading ? `章节标题上下文: ${sectionHeading}` : "",
            "",
            sectionText,
          ].filter(Boolean).join("\n"),
        },
      ],
      signal,
      { temperature: 0.05, max_tokens: 8192 },
    )
  } catch (err) {
    log.warn("section extraction failed", {
      section: sectionIndex,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sectionIndex, fragments: [] }
  }

  // Parse ---MODULE--- blocks
  const validNames = new Set(modules.map((m) => m.moduleName))
  const fragments = parseModuleBlocks(rawResponse, validNames)

  // Tag each fragment with the section index
  for (const f of fragments) {
    f.sectionIndex = sectionIndex
  }

  if (fragments.length > 0) {
    log.info("section extraction done", {
      section: sectionIndex + 1,
      heading: sectionHeading.slice(0, 60),
      modules: fragments.map((f) => f.moduleName),
      totalChars: fragments.reduce((sum, f) => sum + f.markdown.length, 0),
    })
  } else {
    log.info("section extraction: no modules found", {
      section: sectionIndex + 1,
      responseLength: rawResponse.length,
      responsePreview: rawResponse.slice(0, 200),
    })
  }

  return { sectionIndex, fragments }
}

// ── Cross-section merge ───────────────────────────────────────────────────

/**
 * Merge per-module markdown from all sections. Concatenates content per module.
 * Deduplicates identical paragraphs that might appear due to section overlap.
 */
function mergeModuleFragments(
  sectionResults: SectionExtractionResult[],
  allModuleNames: string[],
): MergedModule[] {
  const byModule = new Map<string, ModuleFragment[]>()

  for (const name of allModuleNames) {
    byModule.set(name, [])
  }

  // Sort by section index to maintain document order
  const sortedResults = [...sectionResults].sort((a, b) => a.sectionIndex - b.sectionIndex)

  for (const section of sortedResults) {
    for (const fragment of section.fragments) {
      const existing = byModule.get(fragment.moduleName)
      if (existing) {
        existing.push(fragment)
      }
    }
  }

  const results: MergedModule[] = []
  for (const [moduleName, fragments] of byModule) {
    if (fragments.length === 0) {
      results.push({ moduleName, content: "", sectionCount: 0, found: false })
      continue
    }

    // Deduplicate identical fragments (from overlapping sections)
    const uniqueFragments: ModuleFragment[] = []
    const seen = new Set<string>()
    for (const f of fragments) {
      const normalized = f.markdown.replace(/\s+/g, " ").trim()
      if (!seen.has(normalized)) {
        seen.add(normalized)
        uniqueFragments.push(f)
      }
    }

    // If only one source section, output clean content.
    // If multiple sections contribute, add source context markers.
    let content: string
    if (uniqueFragments.length === 1) {
      content = uniqueFragments[0].markdown
    } else {
      // Multiple sections → merge with section markers for traceability
      const parts: string[] = []
      for (let idx = 0; idx < uniqueFragments.length; idx++) {
        const f = uniqueFragments[idx]
        if (idx > 0) {
          parts.push("")
          parts.push(`---`)
          parts.push(`<!-- 以下内容来自文档第 ${f.sectionIndex + 1} 部分 -->`)
          parts.push("")
        }
        parts.push(f.markdown)
      }
      content = parts.join("\n")
    }
    results.push({
      moduleName,
      content,
      sectionCount: fragments.length,
      found: true,
    })
  }

  return results
}

// ── Final .md file generation ─────────────────────────────────────────────

function buildModuleMarkdownFile(
  merged: MergedModule,
  category: InsuranceCategoryType,
  productName: string,
  moduleDef: ProductModule | undefined,
): string {
  const lines: string[] = []

  // Frontmatter
  lines.push("---")
  lines.push(`title: "${category}-${productName}-${merged.moduleName}"`)
  lines.push(`knowledge_domain: product_catalog`)
  lines.push(`insurance_category: "${category}"`)
  lines.push(`product_name: "${productName}"`)
  lines.push(`entity_type: "${moduleDef?.entityType || "product_detail"}"`)
  lines.push(`dedup_key: "${category}-${productName}-${merged.moduleName}"`)
  lines.push(`status: candidate`)
  lines.push(`created_by: auto-extract`)
  lines.push(`extraction_method: section-scan-merge-v2`)
  lines.push(`source_sections: ${merged.sectionCount}`)
  lines.push("---")
  lines.push("")

  // Title
  lines.push(`# ${merged.moduleName}`)
  lines.push("")

  // Full content — this is the real value: complete clause text, tables, lists
  lines.push(merged.content)

  return lines.join("\n")
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
  rawProductName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // Clean productName: strip source file name suffixes like (保险条款)
  const productName = cleanProductName(rawProductName)
  log.info("product name cleaned", { raw: rawProductName, clean: productName })

  const activity = useActivityStore.getState()
  const allModules = PRODUCT_CATALOG_MODULES[category] ?? []

  if (allModules.length === 0) {
    log.warn("no modules defined for category", { category })
    return []
  }

  // ── Phase 1: Split into sections ───────────────────────────────────
  activity.updateItem(activityId, {
    detail: `正在按章节切分文档...`,
  })

  const sections = splitIntoSections(sourceContent)
  log.info("document split", {
    file: fileName,
    sections: sections.length,
    totalChars: sourceContent.length,
    sectionSizes: sections.map((s) => s.text.length),
  })

  if (sections.length === 0) {
    log.warn("no sections produced", { file: fileName, contentLength: sourceContent.length })
    return []
  }

  activity.updateItem(activityId, {
    detail: `切分为 ${sections.length} 个章节，开始并行抽取...`,
  })

  // ── Phase 2: Parallel per-section extraction ───────────────────────
  const sectionResults: SectionExtractionResult[] = []

  for (let i = 0; i < sections.length; i += MAX_SECTION_PARALLEL) {
    if (signal?.aborted) break
    const batch = sections.slice(i, i + MAX_SECTION_PARALLEL)
    const batchPromises = batch.map((section, batchOffset) =>
      extractModulesFromSection(
        section.text,
        i + batchOffset,
        section.headingPath,
        sections.length,
        allModules,
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
      detail: `已抽取 ${Math.min(i + MAX_SECTION_PARALLEL, sections.length)}/${sections.length} 个章节...`,
    })
  }

  // ── Phase 3: Cross-section merge ───────────────────────────────────
  activity.updateItem(activityId, {
    detail: `正在跨章节合并 ${sectionResults.length} 个章节的数据...`,
  })

  const allModuleNames = allModules.map((m) => m.moduleName)
  const mergedModules = mergeModuleFragments(sectionResults, allModuleNames)
  const foundModules = mergedModules.filter((m) => m.found)

  log.info("merge complete", {
    file: fileName,
    totalModules: allModuleNames.length,
    foundModules: foundModules.length,
    totalChars: foundModules.reduce((sum, m) => sum + m.content.length, 0),
    moduleNames: foundModules.map((m) => m.moduleName),
  })

  if (foundModules.length === 0) {
    log.warn("no modules found in any section", { file: fileName })
    activity.updateItem(activityId, {
      detail: `在 ${sections.length} 个章节中未发现模块数据。`,
    })
    return []
  }

  // ── Phase 4: Write .md files ───────────────────────────────────────
  activity.updateItem(activityId, {
    detail: `正在写入 ${foundModules.length} 个模块文件...`,
  })

  const writtenPaths: string[] = []
  const catalogDir = `${projectPath}/wiki/product_catalog`
  await createDirectory(catalogDir)

  for (const merged of foundModules) {
    const moduleDef = allModules.find((m) => m.moduleName === merged.moduleName)
    const mdContent = buildModuleMarkdownFile(merged, category, productName, moduleDef)
    const mdFileName = `${category}-${productName}-${merged.moduleName}.md`
    const mdPath = `${catalogDir}/${mdFileName}`
    const relativePath = `wiki/product_catalog/${mdFileName}`

    try {
      await writeFile(mdPath, mdContent)
      writtenPaths.push(relativePath)
      log.info("module file written", {
        path: relativePath,
        chars: merged.content.length,
        sections: merged.sectionCount,
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
    const summaryLines = [
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
      `**险种类别：** ${category}`,
      `**产品名称：** ${productName}`,
      `**抽取方式：** 章节扫描-合并 (${sections.length} 个章节)`,
      `**已抽取模块：** ${foundModules.length}/${allModuleNames.length}`,
      "",
      "## 已抽取模块",
      "",
      ...foundModules.map(
        (m) => `- **${m.moduleName}** (${m.content.length} 字, 来自 ${m.sectionCount} 个章节)`,
      ),
      "",
      "## 未抽取模块",
      "",
      ...mergedModules
        .filter((m) => !m.found)
        .map((m) => `- [ ] ${m.moduleName}`),
    ]

    await createDirectory(`${projectPath}/wiki/sources`)
    await writeFile(sourceSummaryFullPath, summaryLines.join("\n"))
    writtenPaths.push(sourceSummaryPath)
  } catch (err) {
    log.warn("failed to write source summary", {
      path: sourceSummaryPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  activity.updateItem(activityId, {
    detail: `完成：${foundModules.length} 个模块，${writtenPaths.length} 个文件已写入。`,
  })

  return writtenPaths
}
