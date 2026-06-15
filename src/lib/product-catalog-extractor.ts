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
import { createDirectory, writeFile } from "@/commands/fs"
import { getLogger } from "@/lib/logger"
import { useActivityStore } from "@/stores/activity-store"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  type InsuranceCategoryType,
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

export function splitIntoSections(sourceContent: string): Chunk[] {
  return chunkMarkdown(sourceContent, {
    targetChars: 25000,
    maxChars: 40000,
    minChars: 3000,
    overlapChars: 500,
  })
}

// ── Per-module key fields (tell LLM what to extract as structured summary) ──

// Maps module name → list of key fields that should appear in the summary table
const MODULE_KEY_FIELDS: Record<string, string[]> = {
  "产品基础信息": ["险种名称", "险种简称", "产品类别", "产品类型", "主附加险", "保障期间", "交费方式", "交费期限", "保险期限", "发行公司"],
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
    ], signal, { temperature: 0.1, max_tokens: 16000 })
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

  if (m.contents.length === 1) {
    lines.push(m.contents[0])
  } else {
    for (let i = 0; i < m.contents.length; i++) {
      if (i > 0) {
        lines.push("")
        lines.push("---")
        lines.push(`<!-- 以下内容来自文档第 ${m.sectionIndices[i] + 1} 部分 -->`)
        lines.push("")
      }
      lines.push(m.contents[i])
    }
  }

  return lines.join("\n")
}

// ── Main product summary file ─────────────────────────────────────────────

function buildMainFile(
  mergedModules: Map<string, MergedModule>,
  category: InsuranceCategoryType,
  productName: string,
  sectionCount: number,
  allModules: ProductModule[],
): string {
  const lines: string[] = []
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

  // Summary of all modules
  const found = allModules.filter(m => mergedModules.get(m.moduleName)?.found)
  const missing = allModules.filter(m => !mergedModules.get(m.moduleName)?.found)

  lines.push("## 已抽取模块")
  lines.push("")
  for (const m of found) {
    const merged = mergedModules.get(m.moduleName)!
    const totalChars = merged.contents.reduce((s, c) => s + c.length, 0)
    lines.push(`- ✅ **${m.moduleName}** (${totalChars} 字, ${merged.sectionIndices.length} 个章节)`)
  }
  lines.push("")

  if (missing.length > 0) {
    lines.push("## 待补全模块")
    lines.push("")
    for (const m of missing) {
      lines.push(`- [ ] ${m.moduleName} (${m.required ? "必填" : "选填"})`)
    }
    lines.push("")
  }

  // Inline short summaries for key fields (first line of each found module)
  lines.push("## 关键信息速览")
  lines.push("")
  lines.push("| 模块 | 摘要 |")
  lines.push("|---|---|")
  for (const m of found) {
    const merged = mergedModules.get(m.moduleName)!
    const firstLine = merged.contents[0].split("\n").find(l => l.trim())?.trim() ?? ""
    const summary = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine
    lines.push(`| ${m.moduleName} | ${summary.replace(/\|/g, "\\|")} |`)
  }
  lines.push("")

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
  const allModules = PRODUCT_CATALOG_MODULES[category] ?? []

  if (allModules.length === 0) {
    log.warn("no modules for category", { category })
    return []
  }

  // ── Phase 1: Split ─────────────────────────────────────────
  activity.updateItem(activityId, { detail: "正在按章节切分文档..." })
  const sections = splitIntoSections(sourceContent)
  log.info("document split", { file: fileName, sections: sections.length })
  if (sections.length === 0) return []

  activity.updateItem(activityId, {
    detail: `切分为 ${sections.length} 个章节，开始并行抽取 ${allModules.length} 个模块...`,
  })

  // ── Phase 2: Parallel extraction ───────────────────────────
  const sectionResults: SectionResult[] = []
  for (let i = 0; i < sections.length; i += MAX_SECTION_PARALLEL) {
    if (signal?.aborted) break
    const batch = sections.slice(i, i + MAX_SECTION_PARALLEL)
    const promises = batch.map((section, offset) =>
      extractFromSection(
        section.text, i + offset, section.headingPath,
        sections.length, allModules,
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

  activity.updateItem(activityId, {
    detail: `完成：${foundModules.length}/${allModules.length} 个模块，${writtenPaths.length} 个文件。`,
  })

  return writtenPaths
}
