/**
 * Product Catalog Extraction Pipeline — V4
 *
 * Hybrid approach:
 * 1. Uses PRODUCT_CATALOG_MODULES module names as extraction targets (maps to document sections)
 * 2. Generates individual .md files per module (产品基础信息.md, 投保年龄.md, ...)
 * 3. Also generates a main product summary file with business Excel fields
 */

import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"
import { streamChat } from "@/lib/llm-client"
import { createDirectory, writeFile, readFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { getLogger } from "@/lib/logger"
import { useActivityStore } from "@/stores/activity-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { preprocessOcrText } from "@/lib/ocr-text-repair"
import {
  type InsuranceCategoryType,
  type ModuleGroup,
  PRODUCT_CATALOG_MODULES,
  type ProductModule,
  PRODUCT_FIELDS,
  BASE_FIELDS,
} from "@/lib/product-catalog-modules"

const log = getLogger("product-catalog-extractor")

function cleanProductName(name: string): string {
  return name
    .replace(/[（(](?:保险条款|产品条款|产品说明书|投保须知|费率表|核保手册|理赔指南|服务手册|条款)[）)]/g, "")
    .trim()
}

// ── Types ─────────────────────────────────────────────────────────────────

interface ModuleFragment {
  moduleName: string
  markdown: string
  sectionIndex: number
}

interface SectionResult {
  sectionIndex: number
  fragments: ModuleFragment[]
}

// ── Section splitting ─────────────────────────────────────────────────────
// 将 OCR 全文按标题结构切分成多个「文本块」(sections)。
// ⚠️ sections ≠ 页数。一个 39 页的 PDF 经 OCR 后约 47000 字，
// 按 targetChars=25000 切分后通常得到 ~55-65 个 sections。
// 每个 section 约 700-900 字（带 500 字重叠）。

export function splitIntoSections(sourceContent: string): Chunk[] {
  return chunkMarkdown(sourceContent, {
    targetChars: 25000,   // 目标每块字符数
    maxChars: 40000,      // 单块最大字符数
    minChars: 3000,       // 单块最小字符数（过小则合并上块）
    overlapChars: 500,    // 相邻块重叠字符数（防止跨界信息丢失）
  })
}

// ── Per-module key fields (tell LLM what to extract as structured summary) ──

// Maps module name → list of key fields that should appear in the summary table
const MODULE_KEY_FIELDS: Record<string, string[]> = {
  "产品基础信息": ["险种名称", "险种简称", "险种代码", "备案号", "产品类别", "产品类型", "主附加险", "保障期间", "交费方式", "交费期限", "保险期限", "发行公司"],
  "投保年龄": ["最低投保年龄", "最高投保年龄", "续保年龄上限", "特殊情形说明"],
  "投保职业": ["可投职业类别", "拒保职业类别", "职业分类标准"],
  "投保人群": ["目标人群", "投保人与被保人关系要求", "特殊限制"],
  "未成年人保额限制": ["保额上限", "适用年龄范围", "法规依据"],
  "孕妇投保限制": ["是否可投", "限制条件", "特殊约定"],
  "专属健康告知": ["告知问题数量", "主要告知项目", "核保决定类型"],
  "标体承保": ["适用条件", "标准费率"],
  "加费承保": ["加费比例范围", "常见加费原因"],
  "除外承保": ["常见除外部位/疾病", "除外期限"],
  "延期承保": ["延期条件", "延期时长"],
  "拒保判定": ["拒保常见原因"],
  "疾病等待期": ["等待期天数", "适用疾病范围", "意外豁免", "等待期内发生理赔处理"],
  "犹豫期": ["犹豫期天数", "起算时间", "犹豫期退保处理"],
  "一般住院医疗": ["给付限额", "适用医院范围", "免赔额", "给付比例", "报销费用范围"],
  "特殊门诊医疗": ["适用病种", "给付限额", "免赔额", "给付比例"],
  "住院前后门急诊": ["前后天数范围", "给付限额", "给付比例"],
  "门诊手术医疗": ["给付限额", "适用手术范围", "给付比例"],
  "重大疾病医疗": ["给付限额", "适用疾病范围", "给付比例", "医院范围"],
  "院外特定药品": ["药品范围", "给付限额", "给付比例"],
  "质子重离子医疗": ["给付限额", "适用医院", "适用病种", "给付比例"],
  "恶性肿瘤赴日医疗": ["给付限额", "适用条件", "覆盖费用"],
  "年度免赔额": ["免赔额金额（有社保）", "免赔额金额（无社保）", "免赔额类型", "计划选项"],
  "有社保费率": ["保费区间", "费率表摘要"],
  "无社保费率上浮": ["上浮比例", "适用条件"],
  "6年保证续保": ["续保年限", "续保条件", "续保保证内容", "不续保情形"],
  "通用责任免除": ["免责条款数量", "主要免责类型"],
  "既往症免责": ["既往症定义", "观察期", "可豁免情形"],
  "投保人变更": ["变更条件", "变更流程"],
  "受益人变更": ["变更条件", "默认受益人"],
  "退保": ["退保时间节点", "退保费用", "退保金计算"],
  "保单复效": ["复效条件", "复效时限", "复效流程"],
  "理赔报案": ["报案时限", "报案方式", "所需材料概述"],
  "住院理赔材料": ["必要材料清单", "特殊情形材料"],
  "重疾理赔材料": ["必要材料清单", "特殊情形材料"],
  "社保后赔付比例": ["赔付比例", "适用条件", "结算顺序"],
  "无社保赔付比例": ["赔付比例", "适用条件"],
  "第三方报销分摊": ["分摊规则", "优先级"],
  "常见拒赔原因": ["常见原因列表"],
  "住院垫付": ["垫付条件", "垫付金额上限", "适用医院范围", "申请流程"],
  "重疾就医绿通": ["服务内容", "适用条件", "申请方式"],
  "异地就医医院限制": ["认可医院级别", "特殊限制", "昂贵医院范围"],
  "分年龄保费费率表": ["保费单位", "费率表数据", "计划说明"],
  // 疾病释义
  "重大疾病释义": ["覆盖疾病种数", "主要疾病列表（前5种）", "诊断标准依据"],
  "中症疾病释义": ["覆盖疾病种数", "主要疾病列表（前5种）", "赔付比例"],
  "轻度疾病释义": ["覆盖疾病种数", "主要疾病列表（前5种）", "赔付比例"],
}

// ── Prompt (module-based, not field-based) ─────────────────────────────────

function buildPrompt(
  modules: ProductModule[],
  category: InsuranceCategoryType,
  productName: string,
  sectionIndex: number,
  totalSections: number,
): string {
  const moduleList = modules.map(m => {
    const keyFields = MODULE_KEY_FIELDS[m.moduleName]
    const keyFieldStr = keyFields ? `\n     关键字段: ${keyFields.join("、")}` : ""
    return `  - 「${m.moduleName}」${keyFieldStr}`
  }).join("\n")

  const exampleModule = `---MODULE: 年度免赔额---
## 关键字段

| 字段 | 值 |
|---|---|
| 免赔额金额（有社保） | 1万元/年 |
| 免赔额金额（无社保） | 1万元/年 |
| 免赔额类型 | 绝对免赔 |
| 计划选项 | 计划一（1万元）、计划二（0元） |

## 详细条款原文

1.6 保险金计算方法

1.6.1 年度累计免赔额
被保险人在一个保险年度内，发生的合理且必要的医疗费用应先扣除年度累计免赔额（见附录2）后，我们再依据本合同约定计算给付保险金。

年度累计免赔额分为两部分：第一部分为您在投保时选择确定的基础免赔额（见附录2），第二部分为我们根据您上一年度的理赔记录确定的追加免赔额。

（原文完整内容继续...）
---END---`

  return [
    `你是保险产品知识库抽取专家。你将收到「${category}」类产品「${productName}」文档的第 ${sectionIndex + 1}/${totalSections} 个章节。`,
    "",
    "## 任务",
    "仔细阅读本章节，将其中的信息归类到以下目标模块。",
    "**本章节中有相关内容的每个模块，都必须按照指定格式输出。**",
    "",
    "## 目标模块（含关键字段提示）",
    moduleList,
    "",
    "## 输出格式（每个模块必须包含两部分）",
    "",
    "```",
    exampleModule,
    "```",
    "",
    "## 关键规则",
    "1. **每个模块必须有两部分**：`## 关键字段` 表格 + `## 详细条款原文`",
    "2. **关键字段**：从文档中找到对应值填入表格，找不到的字段填「未明确」。",
    "3. **详细条款原文**：完整复制原文，包括所有编号（如1.6.1、(7)等）、金额、百分比、条件。",
    "4. **不压缩不改写**：原文有多少就写多少，绝对不能摘要或省略。",
    "5. **表格完整复制**：原文中的表格（如费率表、给付限额表）必须完整保留为markdown表格格式。",
    "6. **编号列表保留**：原文中的(1)(2)(3)或一二三的编号列表必须完整保留。",
    "7. **多模块归属**：同一段内容可以同时归属多个模块（各模块都输出）。",
    "8. **空模块不输出**：本章节完全没有相关内容的模块直接跳过，不要输出空块。",
    "9. **关键字段表格只提炼核心值**，详细说明放在原文部分，不要在表格里写长文本。",
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
  await streamChat(config, messages, {
    onToken: (chunk) => { out += chunk },
    onDone: () => {},
    onError: (err) => { streamError = err },
  }, signal, overrides)
  if (streamError) throw streamError
  return out.trim()
}

// ── Parse ---MODULE--- blocks ─────────────────────────────────────────────

function parseModuleBlocks(response: string, validNames: Set<string>): ModuleFragment[] {
  const fragments: ModuleFragment[] = []
  const regex = /---MODULE:\s*(.+?)\s*---\n([\s\S]*?)---END---/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    const name = match[1].trim()
    const md = match[2].trim()
    if (!md) continue

    let matchedName: string | null = null
    if (validNames.has(name)) {
      matchedName = name
    } else {
      for (const valid of validNames) {
        if (name.includes(valid) || valid.includes(name)) {
          matchedName = valid
          break
        }
      }
    }

    if (matchedName) {
      fragments.push({ moduleName: matchedName, markdown: md, sectionIndex: 0 })
    } else {
      log.warn("unrecognized module", { name })
    }
  }
  return fragments
}

// ── Per-section extraction ────────────────────────────────────────────────

async function extractFromSection(
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
  llmOverrides?: Parameters<typeof streamChat>[4],
): Promise<SectionResult> {
  const prompt = buildPrompt(modules, category, productName, sectionIndex, totalSections)
  const activity = useActivityStore.getState()
  activity.updateItem(activityId, {
    detail: `章节 ${sectionIndex + 1}/${totalSections}: 正在抽取...`,
  })

  let rawResponse: string
  try {
    rawResponse = await streamText(llmConfig, [
      { role: "system", content: prompt },
      {
        role: "user",
        content: [
          `## 章节 ${sectionIndex + 1}/${totalSections}`,
          sectionHeading ? `章节标题: ${sectionHeading}` : "",
          "", sectionText,
        ].filter(Boolean).join("\n"),
      },
    ], signal, llmOverrides ?? { temperature: 0.1, max_tokens: 16000 })
  } catch (err) {
    log.warn("section failed", { section: sectionIndex, error: String(err) })
    return { sectionIndex, fragments: [] }
  }

  const validNames = new Set(modules.map(m => m.moduleName))
  const fragments = parseModuleBlocks(rawResponse, validNames)
  for (const f of fragments) f.sectionIndex = sectionIndex

  log.info("section done", {
    section: sectionIndex + 1,
    modules: fragments.map(f => f.moduleName),
  })

  return { sectionIndex, fragments }
}

// ── Cross-section merge ───────────────────────────────────────────────────

interface MergedModule {
  moduleName: string
  contents: string[]
  sectionIndices: number[]
  found: boolean
}

function mergeModules(
  results: SectionResult[],
  allModuleNames: string[],
): Map<string, MergedModule> {
  const merged = new Map<string, MergedModule>()
  for (const name of allModuleNames) {
    merged.set(name, { moduleName: name, contents: [], sectionIndices: [], found: false })
  }

  const sorted = [...results].sort((a, b) => a.sectionIndex - b.sectionIndex)
  for (const section of sorted) {
    for (const frag of section.fragments) {
      const m = merged.get(frag.moduleName)
      if (!m) continue
      // Dedup
      const normalized = frag.markdown.replace(/\s+/g, " ").trim()
      const isDup = m.contents.some(c => c.replace(/\s+/g, " ").trim() === normalized)
      if (!isDup) {
        m.contents.push(frag.markdown)
        m.sectionIndices.push(frag.sectionIndex)
        m.found = true
      }
    }
  }
  return merged
}

// ── Field-level best-value merge helpers ──────────────────────────────────

/**
 * Parse a Markdown table from a fragment's "## 关键字段" section.
 * Returns Map<fieldName, value>.
 */
function parseKeyFieldsTable(markdown: string): Map<string, string> {
  const fields = new Map<string, string>()
  // Find the "## 关键字段" section
  const keyFieldsMatch = markdown.match(/## 关键字段[\s\S]*?(?=\n## |\n---|\n$|$)/)
  if (!keyFieldsMatch) return fields

  const tableBlock = keyFieldsMatch[0]
  // Parse each table row: | fieldName | value |
  const rowRegex = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm
  let row: RegExpExecArray | null
  while ((row = rowRegex.exec(tableBlock)) !== null) {
    const field = row[1].trim()
    const value = row[2].trim()
    // Skip header separators and header row
    if (field === "---" || field === "字段" || field.startsWith("--")) continue
    fields.set(field, value)
  }
  return fields
}

/**
 * Extract the "## 详细条款原文" (or "## 详细原文") section from a fragment.
 */
function extractDetailContent(markdown: string): string {
  const match = markdown.match(/## 详细(?:条款)?原文\s*\n([\s\S]*)$/)
  return match ? match[1].trim() : ""
}

/**
 * Merge multiple fragments' key-fields tables:
 * for each field, take the first non-"未明确" value.
 * Returns a single merged Markdown table + concatenated detail content.
 */
function mergeFragmentContents(contents: string[], sectionIndices: number[]): string {
  // 1. Collect all field tables and merge
  const mergedFields = new Map<string, string>()
  const fieldOrder: string[] = []

  for (const content of contents) {
    const fields = parseKeyFieldsTable(content)
    for (const [field, value] of fields) {
      if (!mergedFields.has(field)) {
        mergedFields.set(field, value)
        fieldOrder.push(field)
      } else if (mergedFields.get(field) === "未明确" && value !== "未明确") {
        // Upgrade from "未明确" to a real value
        mergedFields.set(field, value)
      }
    }
  }

  // 2. Collect unique detail contents
  const detailParts: { text: string; sectionIndex: number }[] = []
  const seenDetails = new Set<string>()

  for (let i = 0; i < contents.length; i++) {
    const detail = extractDetailContent(contents[i])
    if (!detail) continue
    const normalized = detail.replace(/\s+/g, " ").trim()
    if (seenDetails.has(normalized)) continue
    seenDetails.add(normalized)
    detailParts.push({ text: detail, sectionIndex: sectionIndices[i] })
  }

  // 3. Build output
  const lines: string[] = []

  if (fieldOrder.length > 0) {
    lines.push("## 关键字段")
    lines.push("")
    lines.push("| 字段 | 值 |")
    lines.push("|---|---|")
    for (const field of fieldOrder) {
      lines.push(`| ${field} | ${mergedFields.get(field) ?? "未明确"} |`)
    }
    lines.push("")
  }

  if (detailParts.length > 0) {
    lines.push("## 详细条款原文")
    lines.push("")
    for (let i = 0; i < detailParts.length; i++) {
      if (i > 0) {
        lines.push("")
        lines.push("---")
        lines.push(`<!-- 以下内容来自文档第 ${detailParts[i].sectionIndex + 1} 部分 -->`)
        lines.push("")
      }
      lines.push(detailParts[i].text)
    }
  }

  return lines.join("\n")
}

// ── Module .md file builder ───────────────────────────────────────────────

function buildModuleFile(
  m: MergedModule,
  moduleDef: ProductModule,
  category: InsuranceCategoryType,
  productName: string,
): string {
  const lines: string[] = []
  lines.push("---")
  lines.push(`title: "${category}-${productName}-${m.moduleName}"`)
  lines.push(`knowledge_domain: product_catalog`)
  lines.push(`insurance_category: "${category}"`)
  lines.push(`product_name: "${productName}"`)
  lines.push(`module_name: "${m.moduleName}"`)
  lines.push(`entity_type: "${moduleDef.entityType}"`)
  lines.push(`status: candidate`)
  lines.push(`created_by: auto-extract`)
  lines.push(`source_sections: ${m.sectionIndices.length}`)
  lines.push("---")
  lines.push("")
  lines.push(`# ${m.moduleName}`)
  lines.push("")

  // Use field-level merge instead of raw concatenation
  lines.push(mergeFragmentContents(m.contents, m.sectionIndices))

  return lines.join("\n")
}


// ── Main product summary file ─────────────────────────────────────────────
// Generates the master entity file with:
//   - Frontmatter with all base fields
//   - Section 1: 基础信息 table (short base fields)
//   - Section 2: {险种}专属信息 table (short category fields)
//   - Section 3+: long fields that were extracted (inline content)
//   - Section N: 模块索引 (which modules were written as separate files)

function buildMainFile(
  mergedModules: Map<string, MergedModule>,
  category: InsuranceCategoryType,
  productName: string,
  sectionCount: number,
  allModules: ProductModule[],
): string {
  const lines: string[] = []

  // ── Frontmatter ────────────────────────────────────────────
  lines.push("---")
  lines.push(`title: "${category}-${productName}"`)
  lines.push(`knowledge_domain: product_catalog`)
  lines.push(`insurance_category: "${category}"`)
  lines.push(`product_name: "${productName}"`)
  lines.push(`entity_type: product_profile`)
  lines.push(`status: candidate`)
  lines.push(`created_by: auto-extract`)
  lines.push(`source_sections: ${sectionCount}`)
  lines.push("---")
  lines.push("")
  lines.push(`# ${productName}`)
  lines.push("")

  // ── Gather extracted data from modules ──────────────────────
  // Pull short-field values from all modules using best-value merge logic

  // Build a lookup: fieldName → best extracted value
  // Uses the same best-value logic as mergeFragmentContents: take first non-"未明确" value
  const basicInfoModule = mergedModules.get("产品基础信息")
  const shortFieldLookup = new Map<string, string>()
  if (basicInfoModule && basicInfoModule.found) {
    for (const content of basicInfoModule.contents) {
      const fields = parseKeyFieldsTable(content)
      for (const [field, value] of fields) {
        if (!shortFieldLookup.has(field) || (shortFieldLookup.get(field) === "未明确" && value !== "未明确")) {
          shortFieldLookup.set(field, value)
        }
      }
    }
  }
  // Also pull from ALL other modules' key fields (cross-module field aggregation)
  for (const [, m] of mergedModules) {
    if (!m.found) continue
    for (const content of m.contents) {
      const fields = parseKeyFieldsTable(content)
      for (const [field, value] of fields) {
        if (value !== "未明确" && (!shortFieldLookup.has(field) || shortFieldLookup.get(field) === "未明确")) {
          shortFieldLookup.set(field, value)
        }
      }
    }
  }

  // Fuzzy match: MODULE_KEY_FIELDS uses names like "犹豫期天数" but PRODUCT_FIELDS
  // has "犹豫期". Bridge the gap by matching extracted field names that contain
  // a schema field name as a substring.
  const schemaFields = PRODUCT_FIELDS[category] ?? []
  for (const sf of schemaFields) {
    if (sf.valueType !== "short") continue
    if (shortFieldLookup.has(sf.fieldName) && shortFieldLookup.get(sf.fieldName) !== "未明确") continue
    // Try to find a match in shortFieldLookup where the extracted name contains this schema name
    for (const [extractedName, extractedValue] of shortFieldLookup) {
      if (extractedValue === "未明确") continue
      if (extractedName.includes(sf.fieldName) || sf.fieldName.includes(extractedName)) {
        shortFieldLookup.set(sf.fieldName, extractedValue)
        break
      }
    }
  }



  // ── Section 1: 基础信息 table (固定 schema，业务必填字段) ─────────
  const allFields = PRODUCT_FIELDS[category] ?? []
  const baseFieldNames = new Set(BASE_FIELDS.map(f => f.fieldName))
  const shortBaseFields = allFields.filter(f => f.valueType === "short" && baseFieldNames.has(f.fieldName))
  lines.push("## 基础信息")
  lines.push("")
  lines.push("| 字段 | 值 |")
  lines.push("|---|---|")
  for (const f of shortBaseFields) {
    const val = shortFieldLookup.get(f.fieldName) ?? "未明确"
    lines.push(`| ${f.fieldName} | ${val.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`)
  }
  lines.push("")

  // ── Section 2: 险种专属信息 table ────────────────────────────
  const shortCatFields = allFields.filter(f => f.valueType === "short" && !baseFieldNames.has(f.fieldName))
  if (shortCatFields.length > 0) {
    lines.push(`## ${category}专属信息`)
    lines.push("")
    lines.push("| 字段 | 值 |")
    lines.push("|---|---|")
    for (const f of shortCatFields) {
      const val = shortFieldLookup.get(f.fieldName) ?? "未明确"
      lines.push(`| ${f.fieldName} | ${val.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`)
    }
    lines.push("")
  }


  // ── Section 3+: long fields inline ──────────────────────────
  // Fields like 产品简介、产品特色、保单权益 are rendered inline in the main file
  // because they're short enough to include directly. Long clause texts (责任免除 etc)
  // are referenced by link to their dedicated module file.
  const inlineLongFields = ["产品简介", "产品特色", "保单权益"]
  for (const fieldName of inlineLongFields) {
    const m = mergedModules.get(fieldName)
    if (!m || !m.found) continue
    lines.push(`## ${fieldName}`)
    lines.push("")
    lines.push(m.contents.join("\n\n---\n\n"))
    lines.push("")
  }

  // ── Section: 疾病释义 (if found) ────────────────────────────
  const diseaseFields = ["重大疾病释义", "中症疾病释义", "轻度疾病释义"]
  const hasDiseaseContent = diseaseFields.some(name => mergedModules.get(name)?.found)
  if (hasDiseaseContent) {
    lines.push("## 疾病释义")
    lines.push("")
    for (const fieldName of diseaseFields) {
      const m = mergedModules.get(fieldName)
      if (!m || !m.found) continue
      lines.push(`### ${fieldName}`)
      lines.push("")
      lines.push(m.contents.join("\n\n---\n\n"))
      lines.push("")
    }
  }

  // ── Section: 模块索引 ─────────────────────────────────────────
  const found = allModules.filter(m => mergedModules.get(m.moduleName)?.found)
  const missing = allModules.filter(m => !mergedModules.get(m.moduleName)?.found)

  lines.push("## 已抽取模块")
  lines.push("")
  for (const m of found) {
    const merged = mergedModules.get(m.moduleName)!
    const totalChars = merged.contents.reduce((s, c) => s + c.length, 0)
    lines.push(`- ✅ **${m.moduleName}** — ${totalChars} 字 · ${merged.sectionIndices.length} 个章节 → [\`${category}-${productName}-${m.moduleName}.md\`]`)
  }
  lines.push("")

  if (missing.length > 0) {
    lines.push("## 待补全模块")
    lines.push("")
    for (const m of missing) {
      lines.push(`- [ ] **${m.moduleName}** (${m.required ? "必填" : "选填"})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ── Top-level orchestrator ────────────────────────────────────────────────

// 每批并发发送给 LLM 的 section 数量。
// 设太高会导致内网模型过载/超时，设太低会拖慢总耗时。
// 当前值 8 = 每批 8 个 section 同时调用 LLM，等全部返回后发下一批。
const MAX_SECTION_PARALLEL = 8

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
  const allModules = PRODUCT_CATALOG_MODULES[category] ?? []

  if (allModules.length === 0) {
    log.warn("no modules for category", { category })
    return []
  }

  // ── Phase 1: Pre-process + Split ───────────────────────────
  // 清洗 OCR 文本（去除代码围栏、重复页眉等），然后按标题结构切分成 sections。
  activity.updateItem(activityId, { detail: "正在预处理文本并切分章节..." })
  const cleanedContent = preprocessOcrText(sourceContent, productName)
  const sections = splitIntoSections(cleanedContent)
  log.info("文本切分完成", {
    file: fileName,
    sections: sections.length,                      // 切块数（非页数）
    originalChars: sourceContent.length,             // OCR 原文字符数
    cleanedChars: cleanedContent.length,             // 清洗后字符数
    avgCharsPerSection: Math.round(cleanedContent.length / Math.max(sections.length, 1)),
  })
  if (sections.length === 0) return []

  activity.updateItem(activityId, {
    detail: `切分为 ${sections.length} 个文本块（非页数），按 7 组分轮抽取 ${allModules.length} 个模块...`,
  })

  // ── Phase 2: Group-Round Extraction ────────────────────────────────────
  // Modules are split into semantic groups. Each round processes ONE group
  // across ALL chunks concurrently. This gives the LLM focused attention
  // (5-8 modules per call) while each chunk still sees the full group context.
  // Rounds run sequentially; chunks within a round run in parallel.
  // ──────────────────────────────────────────────────────────────────────

  // Group ordering: basic_info first (most likely to be in first section),
  // disease_definition last (longest content, gets extra token budget).
  const GROUP_ORDER: ModuleGroup[] = [
    "basic_info",
    "coverage",
    "cost_rules",
    "exclusion_uw",
    "claim_service",
    "contract_admin",
    "disease_definition",
  ]

  // ── Content routing: keyword sets per group ──────────────────
  // Only send sections to a group if the section text contains
  // relevant keywords. This avoids wasting LLM calls on sections
  // with no relevant content for that group.
  const GROUP_KEYWORDS: Record<ModuleGroup, RegExp | null> = {
    basic_info: /险种|产品|保险期|交费|保障期|投保|承保|年龄|简称|代码|主险|附加|公司|计划/,
    coverage: null,  // coverage scans ALL sections (main content, most widely distributed)
    cost_rules: /免赔|费率|保费|费用|赔付|比例|限额|给付|计算|上浮|社保/,
    exclusion_uw: /免除|免责|除外|既往|告知|核保|拒保|加费|延期|健康/,
    claim_service: /理赔|报案|材料|垫付|绿通|就医|服务|赔付|给付|申请/,
    contract_admin: /退保|复效|变更|受益人|投保人|解除|犹豫|终止|中止/,
    disease_definition: /疾病|释义|定义|恶性|肿瘤|心肌|脑|重大|中症|轻度|轻症/,
  }

  // Build group → modules map for this category
  const groupMap = new Map<string, ProductModule[]>()
  for (const g of GROUP_ORDER) {
    const members = allModules.filter(m => m.group === g)
    if (members.length > 0) groupMap.set(g, members)
  }

  const sectionResults: SectionResult[] = []
  let totalCalls = 0

  for (const groupKey of GROUP_ORDER) {
    if (signal?.aborted) break
    const groupModules = groupMap.get(groupKey)
    if (!groupModules || groupModules.length === 0) continue

    const isDiseaseGroup = groupKey === "disease_definition"
    const keywordFilter = GROUP_KEYWORDS[groupKey]

    // Filter sections by keyword relevance for this group
    const relevantSections = keywordFilter
      ? sections
          .map((s, idx) => ({ ...s, originalIndex: idx }))
          .filter(s => keywordFilter.test(s.text))
      : sections.map((s, idx) => ({ ...s, originalIndex: idx }))

    if (relevantSections.length === 0) {
      log.info("group skipped (no relevant sections)", { group: groupKey })
      continue
    }

    activity.updateItem(activityId, {
      detail: `[${groupKey}] ${relevantSections.length}/${sections.length} 个相关章节，${groupModules.length} 个模块...`,
    })

    // Process chunks in batches to avoid overwhelming the internal model.
    for (let i = 0; i < relevantSections.length; i += MAX_SECTION_PARALLEL) {
      if (signal?.aborted) break
      const batch = relevantSections.slice(i, i + MAX_SECTION_PARALLEL)
      activity.updateItem(activityId, {
        detail: `[${groupKey}] 章节 ${Math.min(i + MAX_SECTION_PARALLEL, relevantSections.length)}/${relevantSections.length}（总${sections.length}），模块数 ${groupModules.length}...`,
      })
      const batchPromises = batch.map((section) =>
        extractFromSection(
          section.text, section.originalIndex, section.headingPath,
          sections.length, groupModules,
          category, productName, llmConfig, activityId, signal,
          isDiseaseGroup ? { temperature: 0.1, max_tokens: 16000 } : undefined,
        )
      )
      totalCalls += batch.length
      const batchResults = await Promise.allSettled(batchPromises)
      for (const r of batchResults) {
        if (r.status === "fulfilled") sectionResults.push(r.value)
      }
    }
  }

  // totalCalls     = 实际发送给 LLM 的请求总数
  // savedCalls     = 被关键词路由跳过的请求数（节省的调用）
  // maxPossible    = 如果不做路由的最大请求数 = sections × groups
  const maxPossibleCalls = sections.length * GROUP_ORDER.length
  log.info("抽取轮次完成", {
    totalCalls,                                     // 实际 LLM 调用次数
    totalSections: sections.length,                  // 文本块数（非页数）
    groups: GROUP_ORDER.length,                      // 模块组数
    maxPossibleCalls,                                // 不做路由的最大调用数
    savedCalls: maxPossibleCalls - totalCalls,        // 关键词路由节省的调用数
    savingRate: `${Math.round((1 - totalCalls / maxPossibleCalls) * 100)}%`,
    concurrency: MAX_SECTION_PARALLEL,               // 每批并发数
  })


  // ── Phase 3: Merge ─────────────────────────────────────────
  activity.updateItem(activityId, { detail: "正在跨章节合并..." })
  const moduleNames = allModules.map(m => m.moduleName)
  const mergedModules = mergeModules(sectionResults, moduleNames)

  const foundModules = [...mergedModules.values()].filter(m => m.found)
  log.info("merge complete", {
    total: allModules.length,
    found: foundModules.length,
    names: foundModules.map(m => m.moduleName),
  })

  if (foundModules.length === 0) {
    activity.updateItem(activityId, { detail: "未能提取到任何模块。" })
    return []
  }

  // ── Phase 4: Write files ───────────────────────────────────
  activity.updateItem(activityId, {
    detail: `正在写入 ${foundModules.length} 个模块文件 + 主文件...`,
  })
  const catalogDir = `${projectPath}/wiki/product_catalog`
  await createDirectory(catalogDir)
  const writtenPaths: string[] = []

  // 4a: Main product summary file
  const mainContent = buildMainFile(mergedModules, category, productName, sections.length, allModules)
  const mainFileName = `${category}-${productName}.md`
  const mainPath = `${catalogDir}/${mainFileName}`
  try {
    await writeFile(mainPath, mainContent)
    writtenPaths.push(`wiki/product_catalog/${mainFileName}`)
  } catch (err) {
    log.error("failed to write main file", { error: String(err) })
  }

  // 4b: Individual module files
  for (const m of foundModules) {
    const moduleDef = allModules.find(mod => mod.moduleName === m.moduleName)
    if (!moduleDef) continue
    const content = buildModuleFile(m, moduleDef, category, productName)
    const moduleFileName = `${category}-${productName}-${m.moduleName}.md`
    const modulePath = `${catalogDir}/${moduleFileName}`
    const moduleRelative = `wiki/product_catalog/${moduleFileName}`
    try {
      await writeFile(modulePath, content)
      writtenPaths.push(moduleRelative)
    } catch (err) {
      log.error("failed to write module file", { path: moduleRelative, error: String(err) })
    }
  }

  log.info("all files written", { total: writtenPaths.length })

  // 4c: Save OCR source text for reference
  try {
    const sourceDir = `${projectPath}/wiki/source_text`
    await createDirectory(sourceDir)
    const ocrFileName = `${category}-${productName}-OCR原文.md`
    const ocrPath = `${sourceDir}/${ocrFileName}`
    const ocrLines: string[] = [
      "---",
      `title: "${category}-${productName}-OCR原文"`,
      `knowledge_domain: source_text`,
      `insurance_category: "${category}"`,
      `product_name: "${productName}"`,
      `source_file: "${fileName}"`,
      `total_chars: ${cleanedContent.length}`,
      `total_sections: ${sections.length}`,
      `created_by: auto-extract`,
      "---",
      "",
      `# ${productName} OCR 原文`,
      "",
      cleanedContent,
    ]
    await writeFile(ocrPath, ocrLines.join("\n"))
    writtenPaths.push(`wiki/source_text/${ocrFileName}`)
    log.info("OCR source text saved", { path: ocrPath, chars: cleanedContent.length })
  } catch (err) {
    log.warn("failed to save OCR source text", { error: String(err) })
  }

  // ── Phase 5: Module Refinement ────────────────────────────────────────
  // 对每个模块的「详细条款原文」做二次精炼，补充关键字段中的「未明确」值。
  activity.updateItem(activityId, { detail: "Phase 5: 正在精炼模块关键字段..." })
  try {
    const refineResult = await refineModuleFiles(
      projectPath, category, productName, llmConfig, activityId, signal,
    )
    log.info("模块精炼完成", refineResult)
  } catch (err) {
    log.warn("模块精炼失败，不影响已有结果", { error: String(err) })
  }

  activity.updateItem(activityId, {
    detail: `完成：${foundModules.length}/${allModules.length} 个模块，${writtenPaths.length} 个文件。`,
  })

  return writtenPaths
}

// ════════════════════════════════════════════════════════════════
// Phase 5 — Module Refinement (二次精炼)
//
// 对每个模块文件的「详细条款原文」做聚焦式 LLM 调用，
// 补充首次抽取中遗漏（标记为「未明确」）的关键字段。
// 并发数 10，每次只发几百字原文 + 字段列表。
// ════════════════════════════════════════════════════════════════

const REFINE_PARALLEL = 10

interface RefineResult {
  totalModules: number
  refined: number
  fieldsUpdated: number
  skipped: number
}

/**
 * 从模块 md 文件中提取「详细条款原文」部分。
 */
function extractSourceText(content: string): string {
  const match = content.match(/## 详细条款原文\s*\n([\s\S]*?)$/)
  return match ? match[1].trim() : ""
}

/**
 * 对单个模块文件做精炼：读原文 -> LLM 抽关键字段 -> 合并回文件。
 * 返回更新的字段数（0 = 无更新）。
 */
async function refineSingleModule(
  filePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<number> {
  const fileName = filePath.split("/").pop() ?? filePath
  const content = await readFile(filePath)

  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    log.info("refine skip", { file: fileName, reason: "no frontmatter", contentStart: content.substring(0, 50) })
    return 0
  }
  const fm = fmMatch[1]
  const moduleNameMatch = fm.match(/^module_name:\s*"?([^"\n]+?)"?\s*$/m)
  if (!moduleNameMatch) {
    log.info("refine skip", { file: fileName, reason: "no module_name in frontmatter" })
    return 0
  }
  const moduleName = moduleNameMatch[1].trim()

  // Get key fields definition for this module.
  let keyFields = MODULE_KEY_FIELDS[moduleName]
  if (!keyFields || keyFields.length === 0) {
    const existingPairs = parseKeyFieldsTable(content)
    if (existingPairs.size === 0) {
      log.info("refine skip", { file: fileName, reason: "no key fields in table", moduleName })
      return 0
    }
    keyFields = [...existingPairs.keys()]
  }

  // Check if there are any "未明确" fields to fill
  const existingFields = parseKeyFieldsTable(content)
  let needsRefinement = false
  const unmingqueFields: string[] = []
  for (const [k, v] of existingFields) {
    if (v === "未明确") { needsRefinement = true; unmingqueFields.push(k) }
  }
  if (!needsRefinement) {
    log.info("refine skip", { file: fileName, reason: "no 未明确 fields", moduleName, fieldsCount: existingFields.size })
    return 0
  }

  // Extract source text
  const sourceText = extractSourceText(content)
  if (!sourceText || sourceText.length < 20) {
    log.info("refine skip", { file: fileName, reason: "no source text", moduleName, srcLen: sourceText?.length ?? 0 })
    return 0
  }

  log.info("refine calling LLM", { file: fileName, moduleName, unmingqueCount: unmingqueFields.length, srcLen: sourceText.length })

  // Build focused prompt
  const fieldList = keyFields.map(f => `- ${f}`).join("\n")
  const prompt = `你是保险条款分析专家。请从以下原文中提取关键字段。

## 需要提取的字段
${fieldList}

## 原文
${sourceText.substring(0, 8000)}

## 输出要求
请输出 Markdown 表格，格式如下：
| 字段 | 值 |
|---|---|
| 字段名 | 提取到的值 |

规则：
- 只输出在原文中明确找到的字段
- 如果原文没有提到某字段，不要输出该行
- 不要输出"未明确"，只输出有实际值的行
- 值要简洁准确`

  // Call LLM
  let response = ""
  try {
    const stream = streamChat({
      model: llmConfig.model ?? "internal",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    })
    for await (const chunk of stream) {
      if (signal?.aborted) break
      if (chunk.type === "text") response += chunk.text
    }
  } catch {
    return 0
  }

  if (!response || signal?.aborted) return 0

  // Parse response for new field values
  const newFields = parseKeyFieldsTable(response) // Map<string,string>
  log.info("refine LLM response", {
    file: filePath.split("/").pop(),
    responseLen: response.length,
    responsePreview: response.substring(0, 300),
    parsedFieldsCount: newFields.size,
    parsedFields: [...newFields.entries()].slice(0, 5).map(([k, v]) => `${k}=${v}`),
  })
  if (newFields.size === 0) return 0

  // Merge: replace rows where value starts with "未明确" (may have suffix like "（见计划）")
  let updatedCount = 0
  let updatedContent = content

  for (const [field, newValue] of newFields) {
    if (!newValue || newValue.startsWith("未明确")) continue
    // Match row: | field | 未明确... | (with optional suffix after 未明确)
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const rowRegex = new RegExp(`\\|\\s*${escapedField}\\s*\\|\\s*未明确[^|]*\\|`, "g")
    if (rowRegex.test(updatedContent)) {
      updatedContent = updatedContent.replace(
        new RegExp(`\\|\\s*${escapedField}\\s*\\|\\s*未明确[^|]*\\|`, "g"),
        `| ${field} | ${newValue} |`
      )
      updatedCount++
    }
  }

  if (updatedCount > 0) {
    await writeFile(filePath, updatedContent)
  }

  return updatedCount
}

/**
 * 对指定产品的所有模块文件做精炼。
 * 在 runProductCatalogExtraction 的 Phase 5 中自动调用。
 */
async function refineModuleFiles(
  projectPath: string,
  category: string,
  productName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<RefineResult> {
  const pp = normalizePath(projectPath)
  const catalogDir = `${pp}/wiki/product_catalog`
  const prefix = `${category}-${productName}-`

  let files: Array<{ name: string; path: string; is_dir: boolean }> = []
  try {
    const tree = (await listDirectory(catalogDir)) as Array<{ name: string; path: string; is_dir: boolean }>
    files = tree.filter(f => !f.is_dir && f.name.startsWith(prefix) && f.name.endsWith(".md"))
  } catch {
    return { totalModules: 0, refined: 0, fieldsUpdated: 0, skipped: 0 }
  }

  const activity = useActivityStore.getState()
  let refined = 0, fieldsUpdated = 0, skipped = 0

  for (let i = 0; i < files.length; i += REFINE_PARALLEL) {
    if (signal?.aborted) break
    const batch = files.slice(i, i + REFINE_PARALLEL)
    activity.updateItem(activityId, {
      detail: `精炼 ${Math.min(i + REFINE_PARALLEL, files.length)}/${files.length} 个模块...`,
    })

    const results = await Promise.allSettled(
      batch.map(f => refineSingleModule(f.path, llmConfig, signal))
    )

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value > 0) { refined++; fieldsUpdated += r.value }
        else { skipped++ }
      } else { skipped++ }
    }
  }

  return { totalModules: files.length, refined, fieldsUpdated, skipped }
}

/**
 * 独立入口：对项目中所有产品的所有模块做精炼。
 * 用于 UI 按钮触发（不需要重新上传 PDF）。
 * 并发 10，每个模块 1 次 LLM 调用。
 */
export async function refineAllProductModules(
  projectPath: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<RefineResult> {
  const pp = normalizePath(projectPath)
  const catalogDir = `${pp}/wiki/product_catalog`
  const activity = useActivityStore.getState()

  let allFiles: Array<{ name: string; path: string; is_dir: boolean }> = []
  try {
    const tree = await listDirectory(catalogDir)
    log.info("listDirectory raw result", {
      type: typeof tree,
      length: Array.isArray(tree) ? tree.length : "not array",
      firstItem: tree?.[0] ? JSON.stringify(tree[0]).substring(0, 200) : "empty",
      firstItemKeys: tree?.[0] ? Object.keys(tree[0] as Record<string, unknown>) : [],
    })
    allFiles = (tree as Array<{ name: string; path: string; is_dir: boolean }>)
      .filter(f => !f.is_dir && f.name?.endsWith(".md") && f.name?.includes("-"))
  } catch (err) {
    log.error("listDirectory failed", { error: String(err), catalogDir })
    return { totalModules: 0, refined: 0, fieldsUpdated: 0, skipped: 0 }
  }

  log.info("开始批量精炼", { totalModules: allFiles.length, catalogDir })
  if (allFiles.length > 0) {
    log.info("sample file", { name: allFiles[0].name, path: allFiles[0].path })
  }
  activity.updateItem(activityId, {
    detail: `正在精炼 ${allFiles.length} 个模块文件...`,
  })

  let refined = 0, fieldsUpdated = 0, skipped = 0

  for (let i = 0; i < allFiles.length; i += REFINE_PARALLEL) {
    if (signal?.aborted) break
    const batch = allFiles.slice(i, i + REFINE_PARALLEL)
    activity.updateItem(activityId, {
      detail: `精炼模块 ${Math.min(i + REFINE_PARALLEL, allFiles.length)}/${allFiles.length}...`,
    })

    const results = await Promise.allSettled(
      batch.map(f => refineSingleModule(f.path, llmConfig, signal))
    )

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value > 0) { refined++; fieldsUpdated += r.value }
        else { skipped++ }
      } else { skipped++ }
    }
  }

  log.info("批量精炼完成", { totalModules: allFiles.length, refined, fieldsUpdated, skipped })
  activity.updateItem(activityId, {
    detail: `精炼完成：${refined}/${allFiles.length} 个模块更新，共补充 ${fieldsUpdated} 个字段。`,
  })

  return { totalModules: allFiles.length, refined, fieldsUpdated, skipped }
}
