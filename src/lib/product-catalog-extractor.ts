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
  type ProductField,
  PRODUCT_FIELDS,
  BASE_FIELDS,
  isModuleAllowedForCategory,
} from "@/lib/product-catalog-modules"

const log = getLogger("product-catalog-extractor")

const EMPTY_FIELD_VALUE = ""

const PLACEHOLDER_REGEX = /^(未明确|未提及|未提到|未说明|未在本|未在证据|未从证据|证据片段中未|证据中未|该字段未|文中未|原文未|原文中未|材料未|未找到|未见|没有提到|无明确|不涉及|暂无|暂未|无此信息|无相关|本章节未|条款未|不适用于本|N\/A|n\/a|无$)/

function isMissingFieldValue(value: string | undefined | null): boolean {
  const normalized = (value ?? "").trim()
  return normalized === "" || PLACEHOLDER_REGEX.test(normalized)
}

function sanitizeFieldValue(value: string): string {
  const trimmed = value.trim()
  return PLACEHOLDER_REGEX.test(trimmed) ? "" : trimmed
}

const FIELD_EXTRACTION_HINTS: Record<string, Record<string, string>> = {
  "疾病等待期": {
    "意外豁免": "实际指全部“无等待期/等待期豁免情形”，不限于意外伤害；如原文列出多种情形，必须逐条完整列出，不要只取第 1 条。",
    "等待期内发生理赔处理": "分别列出一般疾病、恶性肿瘤等不同情形下的处理结果，不要合并丢项。",
  },
  "身故保险金": {
    "保什么": "概括本产品保险责任。若只有身故责任，填写“身故保险金”及核心给付规则；若同时出现全残、意外身故、疾病身故，必须分别列出。",
    "全残保障": "仅在原文明示全残/身体全残/全残保险金责任时填写；没有明确全残责任则留空。",
    "意外身故": "仅在原文把意外身故作为单独责任、额外赔付或单独给付规则时填写；一般身故责任不要强行写成意外身故。",
    "疾病身故": "仅在原文把疾病身故或非意外身故作为单独责任、额外赔付或单独给付规则时填写。",
  },
}

const FIELD_NAME_ALIASES: Record<string, string[]> = {
  "意外豁免": ["无等待期情形", "等待期豁免情形", "无等待期/等待期豁免情形"],
  "保什么": ["保险责任", "保障责任", "保障内容", "我们保什么", "保险金责任"],
  "全残保障": ["全残保险金", "身体全残保险金", "全残责任", "身体全残责任"],
  "意外身故": ["意外身故保险金", "意外死亡保险金"],
  "疾病身故": ["疾病身故保险金", "非意外身故保险金"],
}

const FIELD_EVIDENCE_KEYWORDS: Record<string, string[]> = {
  "疾病等待期": ["等待期", "无等待期", "意外伤害", "重新投保", "上一保险期间", "届满", "60日", "指定", "审核同意", "恶性肿瘤", "合同终止", "返还", "不承担"],
  "等待期天数": ["等待期", "30日", "天", "日"],
  "适用疾病范围": ["疾病", "恶性肿瘤", "重度", "所有疾病", "一般疾病"],
  "意外豁免": ["无等待期", "等待期豁免", "意外伤害", "重新投保", "上一保险期间", "届满", "60日", "指定", "审核同意"],
  "等待期内发生理赔处理": ["等待期内", "不承担", "给付保险金", "恶性肿瘤", "返还", "合同终止", "一般疾病"],
  "犹豫期": ["犹豫期", "退保", "解除合同", "扣除", "无息退还"],
  "宽限期": ["宽限期", "60日", "逾期", "保险费"],
  "投保年龄": ["投保年龄", "出生", "周岁", "最低", "最高"],
  "产品简介": ["产品提供", "保障", "保险责任", "阅读指引", "产品"],
  "产品特色": ["领取方式", "领取期间", "保证给付", "保单贷款", "现金价值", "权益"],
  "保单权益": ["重要权益", "保单贷款", "自动垫交", "退保", "现金价值", "受益人"],
  "投保范围": ["投保范围", "被保险人", "投保年龄", "周岁"],
  "保障人群": ["投保年龄", "被保险人", "周岁"],
  "高流动性": ["保单贷款", "现金价值", "减保", "部分领取", "退保"],
  "部分领取": ["部分领取", "减保", "领取", "账户价值"],
  "保证领取": ["保证给付", "领取期间内身故", "养老保险金总额", "已给付"],
  "领取规则": ["领取方式", "一次性领取", "年领", "月领", "领取期间"],
  "领取期间": ["领取期间", "10年", "20年", "届满"],
  "养老金": ["养老保险金", "给付", "领取方式", "基本保险金额"],
  "保单贷款": ["保单贷款", "贷款金额", "现金价值", "贷款期限", "贷款利率"],
  "身故保险金": ["保险责任", "身故保险金", "被保险人身故", "给付", "基本保险金额", "所交保险费", "已交保险费", "现金价值", "合同终止"],
  "保什么": ["保险责任", "我们保什么", "保什么", "身故保险金", "全残保险金", "意外身故", "疾病身故", "给付", "基本保险金额", "现金价值"],
  "全残保障": ["全残", "身体全残", "全残保险金", "全残保障"],
  "意外身故": ["意外身故", "意外伤害", "身故保险金"],
  "疾病身故": ["疾病身故", "非意外身故", "身故保险金"],
}

const REFINE_EXTRA_FIELDS_BY_MODULE: Record<string, string[]> = {
  "产品基础信息": [
    "险种代码", "险种简称", "险种名称", "产品类别", "产品类型", "主附加险",
    "产品简介", "产品特色", "保单权益", "交费期限", "交费方式", "宽限期",
    "保障期间", "保障期间分类", "投保年龄", "保险期间和续保", "投保范围",
  ],
  "投保年龄": ["投保年龄", "保障人群", "投保范围"],
  "投保人群": ["适用人群", "保障人群", "投保范围"],
  "犹豫期": ["犹豫期", "犹豫期及合同解除（退保）"],
  "退保": ["犹豫期及合同解除（退保）", "保单权益"],
  "身故保险金": [
    "保什么", "身故保险金", "全残保障", "意外身故", "疾病身故", "满期返还",
    "特殊免责", "购买限制", "保单权益", "产品特色",
  ],
  "通用责任免除": ["特殊免责", "免责少"],
  "未成年人保额限制": ["购买限制"],
  "年金给付规则": [
    "保什么", "养老金", "保证领取", "领取规则", "领取期间", "产品特色",
    "保单权益", "领钱时间早", "教育金",
  ],
  "领取期间": ["领取期间", "领取规则", "保障期间", "保险期间和续保", "产品特色"],
  "领取明细示例": ["领取期间", "领取规则", "养老金", "产品特色"],
  "保单贷款": ["保单贷款", "高流动性", "现金价值", "保单权益", "产品特色"],
  "减保": ["部分领取", "高流动性", "现金价值", "保单权益"],
  "万能账户规则": ["万能账户", "产品利率", "保证利率", "初始费用", "领取手续费", "部分领取", "高流动性"],
  "保证利率": ["保证利率", "产品利率"],
  "初始费用": ["初始费用"],
  "领取手续费": ["领取手续费"],
  "年度现金价值表": ["现金价值", "高流动性"],
}

const LONG_FIELD_MODULE_MAP: Record<string, string[]> = {
  "保什么": [
    "一般住院医疗", "重大疾病医疗", "特殊门诊医疗", "质子重离子医疗", "恶性肿瘤赴日医疗", "院外特定药品",
    "重大疾病保险金", "轻症保险金", "中症保险金", "特定重疾额外赔付", "身故保险金",
    "意外身故", "意外伤残", "意外医疗", "交通意外额外赔付",
    "年金给付规则", "领取期间",
  ],
  "报销范围": ["一般住院医疗", "住院前后门急诊", "特殊门诊医疗", "门诊手术医疗"],
  "投保范围": ["投保年龄", "投保人群", "投保职业"],
  "保险期间和续保": ["6年保证续保"],
  "犹豫期及合同解除（退保）": ["犹豫期", "退保"],
}

const RULE_DERIVED_FIELD_NAMES = new Set([
  "保障人群",
  "保障期间分类",
  "高流动性",
  "产品简介",
  "产品特色",
  "保单权益",
  "投保范围",
])

function uniqueStrings(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const normalized = (item ?? "").trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function keywordsForField(
  fieldName: string,
  moduleName: string,
  fieldHints?: Record<string, string>,
): string[] {
  const aliases = Object.entries(FIELD_NAME_ALIASES)
    .filter(([canonical, names]) => fieldName === canonical || names.includes(fieldName))
    .flatMap(([canonical, names]) => [canonical, ...names])

  const hintText = fieldHints?.[fieldName] ?? ""
  const hintKeywords = hintText.split(/[，；、。:：\s]+/).filter(part => part.length >= 2)

  return uniqueStrings([
    fieldName,
    moduleName,
    ...aliases,
    ...(FIELD_EVIDENCE_KEYWORDS[moduleName] ?? []),
    ...(FIELD_EVIDENCE_KEYWORDS[fieldName] ?? []),
    ...hintKeywords,
  ])
}

function chunkTextForEvidence(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}|(?=^#{1,6}\s+)/m)
    .map(part => part.trim())
    .filter(Boolean)
  const parts = paragraphs.length > 0 ? paragraphs : [text.trim()]
  const chunks: string[] = []
  let current = ""

  for (const part of parts) {
    if (current && current.length + part.length + 2 > 1800) {
      chunks.push(current)
      current = part
    } else {
      current = current ? `${current}\n\n${part}` : part
    }

    while (current.length > 2400) {
      chunks.push(current.slice(0, 2000))
      current = current.slice(1800).trim()
    }
  }

  if (current) chunks.push(current)
  return chunks
}

function buildRefineSourceExcerpt(
  sourceText: string,
  moduleName: string,
  targetFields: string[],
  fieldHints?: Record<string, string>,
  maxChars = 12000,
): string {
  const chunks = chunkTextForEvidence(sourceText)
  const keywords = uniqueStrings([
    moduleName,
    ...targetFields.flatMap(field => keywordsForField(field, moduleName, fieldHints)),
  ]).filter(keyword => keyword.length >= 2)

  const scored = chunks.map((chunk, index) => {
    let score = 0
    for (const keyword of keywords) {
      const matches = chunk.match(new RegExp(escapeRegExp(keyword), "g"))
      if (!matches) continue
      const isTargetField = targetFields.includes(keyword)
      score += matches.length * (isTargetField ? 40 : 12) + Math.min(keyword.length, 12)
    }
    if (/(?:^|\n)\s*(?:\d+[.、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.])/.test(chunk)) {
      score += 20
    }
    return { chunk, index, score }
  })

  const selected = new Set<number>()
  let selectedLength = 0
  for (const item of scored.sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (item.score <= 0) break
    if (selectedLength + item.chunk.length > maxChars && selected.size > 0) continue
    selected.add(item.index)
    selectedLength += item.chunk.length
    if (selectedLength >= maxChars) break
  }

  if (selected.size === 0) return sourceText.slice(0, maxChars)

  return [...selected]
    .sort((a, b) => a - b)
    .map(index => chunks[index])
    .join("\n\n---\n\n")
    .slice(0, maxChars)
}

function resolveExistingFieldName(field: string, existingFields: Map<string, string>): string | null {
  if (existingFields.has(field)) return field
  for (const [canonical, aliases] of Object.entries(FIELD_NAME_ALIASES)) {
    if (field === canonical || aliases.includes(field)) {
      if (existingFields.has(canonical)) return canonical
    }
  }
  for (const existing of existingFields.keys()) {
    if (existing.includes(field) || field.includes(existing)) return existing
  }
  return null
}

function informationScore(value: string): number {
  const normalized = value.trim()
  if (!normalized) return 0
  const listMarkers = (normalized.match(/(?:^|[;；。]\s*|\n)\s*(?:\d+[.、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.])/g) ?? []).length
  const separators = (normalized.match(/[;；。]\s*/g) ?? []).length
  const keywords = (normalized.match(/无等待期|重新投保|指定|期限|审核同意|意外伤害|合同终止|返还|不承担/g) ?? []).length
  return normalized.length + listMarkers * 80 + separators * 20 + keywords * 30
}

function shouldReplaceFieldValue(
  existing: string | undefined,
  candidate: string,
  moduleName?: string,
  fieldName?: string,
): boolean {
  if (isMissingFieldValue(candidate)) return false
  if (isMissingFieldValue(existing)) return true
  const current = existing!.trim()
  const next = candidate.trim()
  if (current === next || current.includes(next)) return false
  if (next.includes(current)) return true

  const hinted = !!(moduleName && fieldName && FIELD_EXTRACTION_HINTS[moduleName]?.[fieldName])
  const currentScore = informationScore(current)
  const nextScore = informationScore(next)
  return hinted
    ? nextScore > currentScore + 30
    : nextScore > currentScore * 1.35 && next.length > current.length + 12
}

function shouldFuzzyBridgeSchemaField(schemaField: ProductField, extractedName: string): boolean {
  if (extractedName === schemaField.fieldName) return true
  if (!schemaField.extractable) return false
  return extractedName.includes(schemaField.fieldName)
}

function shouldRejectMainFieldValue(fieldName: string, value: string): boolean {
  if (fieldName !== "费用") return false
  return /(?:退保|解除合同).*(?:损失|慎重)|(?:损失|慎重).*(?:退保|解除合同)|可能会遭受一定损失|造成一定的损失/.test(value)
}

function tableCell(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  const clipped = normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
  return clipped.replace(/\|/g, "\\|")
}

function fieldScopeLabel(
  fieldName: string,
  baseFieldNames: Set<string>,
  category: InsuranceCategoryType,
): string {
  return baseFieldNames.has(fieldName) ? "基础字段" : `${category}专属字段`
}

function valueSourceForField(fieldName: string, value: string): "extracted" | "derived" | "missing" {
  if (isMissingFieldValue(value)) return "missing"
  return RULE_DERIVED_FIELD_NAMES.has(fieldName) ? "derived" : "extracted"
}

function evidenceModulesForField(fieldName: string, category?: InsuranceCategoryType): string[] {
  const refineModules = Object.entries(REFINE_EXTRA_FIELDS_BY_MODULE)
    .filter(([, fields]) => fields.includes(fieldName))
    .map(([moduleName]) => moduleName)
  const longFieldModules = LONG_FIELD_MODULE_MAP[fieldName] ?? []
  const modules = uniqueStrings([...refineModules, ...longFieldModules])
  return category ? modules.filter(moduleName => isModuleAllowedForCategory(category, moduleName)) : modules
}

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
// 目标：让每个 section 约 4000-8000 字（≈条款 2-5 页），
// 一个 39 页 47000 字的 PDF 通常切成 ~8-12 个 sections。
// 较大的 section 确保 LLM 能看到完整上下文（如免赔额引用附录、续保条款跨页等）。

export function splitIntoSections(sourceContent: string): Chunk[] {
  return chunkMarkdown(sourceContent, {
    targetChars: 6000,    // 目标每块字符数（约 2-3 页条款）
    maxChars: 12000,      // 单块最大字符数（约 5-6 页条款）
    minChars: 1500,       // 单块最小字符数（过小则合并上块）
    overlapChars: 300,    // 相邻块重叠字符数（防止跨界信息丢失）
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
  "身故保险金": ["保什么", "身故保险金", "身故保险金给付条件", "身故保险金给付金额", "身故保险金给付对象", "全残保障", "意外身故", "疾病身故", "身故保险金责任免除"],
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
    const hints = FIELD_EXTRACTION_HINTS[m.moduleName]
    const hintStr = hints
      ? `\n     字段提示: ${Object.entries(hints).map(([field, hint]) => `${field}=${hint}`).join("；")}`
      : ""
    return `  - 「${m.moduleName}」${keyFieldStr}${hintStr}`
  }).join("\n")

  // Build enriched field list with hints for LLM
  // Show all fields so LLM knows the full schema, but mark non-extractable ones
  // to prevent hallucination of operational/manual-fill data.
  const productFields = PRODUCT_FIELDS[category] ?? []
  const fieldListWithHints = productFields
    .map(f => {
      let entry = f.fieldName
      if (!f.extractable) entry += ` [人工填充-请勿抽取]`
      if (f.valueHint) entry += `（如：${f.valueHint}）`
      if (f.valueType === "long") entry += ` [长文本]`
      return entry
    }).join("、")

  const exampleModule = `---MODULE: 年度免赔额---
## 关键字段

| 字段 | 值 |
|---|---|
| 免赔额金额（有社保） | 1万元/年 |
| 免赔额金额（无社保） | 1万元/年 |
| 免赔额类型 | 绝对免赔 |
| 计划选项 | 计划一（1万元）、计划二（0元） |
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
    "## 产品字段总表（对齐 xlsx，含格式提示；找不到值就留空）",
    fieldListWithHints,
    "",
    "## 特别注意：以下业务字段如在本章节出现，必须额外添加到 \`产品基础信息\` 模块",
    "主附加险、交费方式、交费期限、宽限期、保证续保、保证续保期、补偿原则、不限社保、",
    "报销比例、免赔额、额度类型、费率可调、报销门诊住院范围",
    "（哪怕当前章节主题不是基础信息，只要提到了上述字段的值，就要同时输出一个 产品基础信息 模块）",
    "",
    "## 输出格式（每个模块只需输出表格，禁止摘抄原文）",
    "",
    "```",
    exampleModule,
    "```",
    "",
    "## 关键规则",
    "1. **只需要输出表格**：不需要摘抄原文，只需输出 \`## 关键字段\` 表格即可（原文将由系统自动追加）。",
    "2. **关键字段**：从文档中找到对应值填入表格，找不到的字段保留字段行，值留空。",
    "3. **多模块归属**：同一段内容可以同时归属多个模块（各模块都单独输出表格）。",
    "4. **空模块不输出**：本章节完全没有相关内容的模块直接跳过，不要输出空块。",
    "5. **取值来源不作为跳过理由**：即使字段在业务表里标过人工填充，只要原文明确出现，也要抽取；原文没有就留空。",
    "6. **枚举型规则必须完整**：若原文用 1/2/3 或分号列出多个条件、责任、例外或处理方式，必须全部列出，可用分号压缩，但不能只取第一条。",
    "7. **关键字段表格提炼核心值**：短字段保持简洁；规则型字段可用分号完整列举必要条件。",
    "8. **长文本字段**：标有 [长文本] 的字段，值可以较长（100-300字），概括原文核心内容，不要只写一句话。",
    "9. **严禁占位文本**：绝对不要输出\"未明确\"、\"未提及\"、\"未在本章节说明\"、\"暂无\"、\"不涉及\"等占位文字。没有值的字段，值直接留空，写成 `| 字段名 |  |` 即可。",
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

function parseModuleBlocks(response: string, validNames: Set<string>, sectionText: string): ModuleFragment[] {
  const fragments: ModuleFragment[] = []
  const regex = /---MODULE:\s*(.+?)\s*---\n([\s\S]*?)---END---/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    const name = match[1].trim()
    let md = match[2].trim()
    if (!md) continue

    // 防御性清理：如果 LLM 不听话还是输出了原文，把它砍掉
    md = md.replace(/## 详细(?:条款)?原文[\s\S]*$/, "").trim()

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
      // 自动注入完整无损的原文
      const fullMd = `${md}\n\n## 详细条款原文\n\n${sectionText}`
      fragments.push({ moduleName: matchedName, markdown: fullMd, sectionIndex: 0 })
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

  const validNames = new Set(PRODUCT_CATALOG_MODULES[category].map(m => m.moduleName))
  const fragments = parseModuleBlocks(rawResponse, validNames, sectionText)
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
  const rowRegex = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/gm
  let row: RegExpExecArray | null
  while ((row = rowRegex.exec(tableBlock)) !== null) {
    const field = row[1].trim()
    const value = sanitizeFieldValue(row[2])
    // Skip header separators and header row
    if (field === "---" || field === "字段" || field.startsWith("--")) continue
    fields.set(field, value)
  }
  return fields
}

function hasExtractedFieldValue(markdown: string): boolean {
  const fields = parseKeyFieldsTable(markdown)
  for (const value of fields.values()) {
    if (!isMissingFieldValue(value)) return true
  }
  return false
}

function moduleHasExtractedValues(m: Pick<MergedModule, "contents">): boolean {
  return m.contents.some(hasExtractedFieldValue)
}

function collectModuleKeyFields(m: MergedModule | undefined): Map<string, string> {
  const merged = new Map<string, string>()
  if (!m?.found) return merged
  for (const content of m.contents) {
    const fields = parseKeyFieldsTable(content)
    for (const [field, value] of fields) {
      if (!merged.has(field) || shouldReplaceFieldValue(merged.get(field), value, m.moduleName, field)) {
        merged.set(field, value)
      }
    }
  }
  return merged
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
 * for each field, take the first non-empty value.
 * Returns a single merged Markdown table + concatenated detail content.
 */
function mergeFragmentContents(contents: string[], sectionIndices: number[], moduleName?: string): string {
  // 1. Collect all field tables and merge
  const mergedFields = new Map<string, string>()
  const fieldOrder: string[] = []

  for (const content of contents) {
    const fields = parseKeyFieldsTable(content)
    for (const [field, value] of fields) {
      if (!mergedFields.has(field)) {
        mergedFields.set(field, value)
        fieldOrder.push(field)
      } else if (shouldReplaceFieldValue(mergedFields.get(field), value, moduleName, field)) {
        // Upgrade from an empty or less-informative value to a better value.
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
      lines.push(`| ${field} | ${mergedFields.get(field) ?? EMPTY_FIELD_VALUE} |`)
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
  const hasValues = moduleHasExtractedValues(m)
  const lines: string[] = []
  lines.push("---")
  lines.push(`title: "${category}-${productName}-${m.moduleName}"`)
  lines.push(`knowledge_domain: product_catalog`)
  lines.push(`insurance_category: "${category}"`)
  lines.push(`product_name: "${productName}"`)
  lines.push(`module_name: "${m.moduleName}"`)
  lines.push(`concept_name: "${m.moduleName}"`)
  lines.push(`entity_type: "${moduleDef.entityType}"`)
  lines.push(`status: ${hasValues ? "candidate" : "rejected"}`)
  lines.push(`extraction_state: ${hasValues ? "has_values" : "needs_refinement"}`)
  lines.push(`created_by: auto-extract`)
  lines.push(`source_sections: ${m.sectionIndices.length}`)
  lines.push("---")
  lines.push("")
  lines.push(`# ${m.moduleName}`)
  lines.push("")

  // Use field-level merge instead of raw concatenation
  lines.push(mergeFragmentContents(m.contents, m.sectionIndices, m.moduleName))

  return lines.join("\n")
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function sanitizeFileNamePart(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned || "未命名字段"
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null

  const cells: string[] = []
  let current = ""
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i]
    if (ch === "|" && trimmed[i - 1] !== "\\") {
      cells.push(current.trim().replace(/\\\|/g, "|"))
      current = ""
    } else {
      current += ch
    }
  }
  cells.push(current.trim().replace(/\\\|/g, "|"))
  return cells
}

function parseProductProfileFieldValues(profileMarkdown: string): Map<string, string> {
  const values = new Map<string, string>()
  const fieldSection = profileMarkdown.split(/\n## 已有知识清单\b/)[0] ?? profileMarkdown
  for (const line of fieldSection.split(/\r?\n/)) {
    const cells = splitMarkdownTableRow(line)
    if (!cells || cells.length < 2) continue
    const [field, rawValue] = cells
    if (!field || field === "字段" || field.startsWith("---")) continue
    values.set(field, sanitizeFieldValue(rawValue.replace(/<br>/g, "\n")))
  }
  return values
}

function buildProductFieldFile(
  field: ProductField,
  value: string,
  category: InsuranceCategoryType,
  productName: string,
  baseFieldNames: Set<string>,
): string {
  const hasValue = !isMissingFieldValue(value)
  const fieldScope = fieldScopeLabel(field.fieldName, baseFieldNames, category)
  const valueSource = valueSourceForField(field.fieldName, value)
  const evidenceModules = evidenceModulesForField(field.fieldName, category)
  const status = hasValue ? "candidate" : "rejected"
  const extractionState = hasValue ? "has_values" : "needs_refinement"
  const valueCell = value.replace(/\n/g, "<br>").replace(/\|/g, "\\|")
  const summary = hasValue
    ? `${productName} 的${field.fieldName}为：${value.replace(/\s+/g, " ").trim()}`
    : `${productName} 的${field.fieldName}尚未从已上传资料中抽取到明确值。`

  const lines: string[] = []
  lines.push("---")
  lines.push(`title: ${yamlString(`${category}-${productName}-${field.fieldName}`)}`)
  lines.push(`knowledge_domain: product_catalog_field`)
  lines.push(`insurance_category: ${yamlString(category)}`)
  lines.push(`product_name: ${yamlString(productName)}`)
  lines.push(`field_name: ${yamlString(field.fieldName)}`)
  lines.push(`field_scope: ${yamlString(fieldScope)}`)
  lines.push(`concept_name: ${yamlString(field.fieldName)}`)
  lines.push(`entity_type: product_field`)
  lines.push(`status: ${status}`)
  lines.push(`extraction_state: ${extractionState}`)
  lines.push(`value_source: ${valueSource}`)
  lines.push(`evidence_modules: [${evidenceModules.map(name => yamlString(name)).join(", ")}]`)
  lines.push(`value_type: ${field.valueType}`)
  lines.push(`source_hint: ${yamlString(field.source)}`)
  lines.push(`created_by: auto-extract`)
  lines.push("---")
  lines.push("")
  lines.push(`# ${field.fieldName}`)
  lines.push("")
  lines.push("## 字段值")
  lines.push("")
  lines.push("| 字段 | 值 |")
  lines.push("|---|---|")
  lines.push(`| ${field.fieldName} | ${valueCell} |`)
  lines.push("")
  lines.push("## 字段元信息")
  lines.push("")
  lines.push("| 项目 | 内容 |")
  lines.push("|---|---|")
  lines.push(`| 字段范围 | ${fieldScope} |`)
  lines.push(`| 字段类型 | ${field.valueType === "long" ? "长文本" : "短字段"} |`)
  lines.push(`| 取值来源提示 | ${field.source.replace(/\|/g, "\\|")} |`)
  lines.push(`| 值来源类型 | ${valueSource === "derived" ? "规则回填" : valueSource === "extracted" ? "原文抽取/模块回填" : "缺失待补"} |`)
  if (field.valueHint) lines.push(`| 取值格式提示 | ${field.valueHint.replace(/\|/g, "\\|")} |`)
  if (field.description) lines.push(`| 说明 | ${field.description.replace(/\|/g, "\\|")} |`)
  if (evidenceModules.length > 0) {
    lines.push("")
    lines.push("## 来源与证据")
    lines.push("")
    if (valueSource === "derived") {
      lines.push("该字段由规则从已抽取字段或模块内容回填，原文证据请查看下列模块。")
    } else if (valueSource === "missing") {
      lines.push("该字段尚未抽取到值，后续精炼或补充资料时优先查看下列模块。")
    } else {
      lines.push("该字段值来自模块抽取或模块精炼，原文证据请查看下列模块。")
    }
    lines.push("")
    for (const moduleName of evidenceModules) {
      lines.push(`- [[${category}-${productName}-${moduleName}]]`)
    }
  }
  lines.push("")
  lines.push("## 所属产品")
  lines.push("")
  lines.push(`- 险种：${category}`)
  lines.push(`- 产品：${productName}`)
  lines.push(`- 主文件：[[${category}-${productName}]]`)
  lines.push(`- 字段概念：[[${field.fieldName}]]`)
  lines.push("")
  lines.push("## 检索摘要")
  lines.push("")
  lines.push(summary)
  if (!hasValue) {
    lines.push("")
    lines.push("## 知识缺口")
    lines.push("")
    lines.push(`- [ ] ${field.fieldName} 尚未抽取到明确值，后续精炼或补充资料时填充。`)
  }

  return lines.join("\n")
}

function buildProductFieldFiles(
  profileMarkdown: string,
  category: InsuranceCategoryType,
  productName: string,
): Array<{ fileName: string; content: string; hasValue: boolean }> {
  const fieldValues = parseProductProfileFieldValues(profileMarkdown)
  const baseFieldNames = new Set(BASE_FIELDS.map(f => f.fieldName))
  return (PRODUCT_FIELDS[category] ?? []).map(field => {
    const value = fieldValues.get(field.fieldName) ?? EMPTY_FIELD_VALUE
    return {
      fileName: `${category}-${productName}-字段-${sanitizeFileNamePart(field.fieldName)}.md`,
      content: buildProductFieldFile(field, value, category, productName, baseFieldNames),
      hasValue: !isMissingFieldValue(value),
    }
  })
}

function deriveAudienceFromAge(ageText: string | undefined): string | null {
  if (!ageText || isMissingFieldValue(ageText)) return null
  const ages = [...ageText.matchAll(/(\d+)\s*周岁/g)].map(m => Number.parseInt(m[1], 10))
  if (ages.length === 0) return null
  const minAge = Math.min(...ages)
  const maxAge = Math.max(...ages)
  if (maxAge <= 17) return "儿童(0-17岁)"
  if (minAge >= 60) return "老人(60岁以上)"
  if (minAge >= 18 && maxAge <= 60) return "成人(18-60岁)"
  const groups: string[] = []
  if (minAge <= 17) groups.push("儿童(0-17岁)")
  if (minAge <= 60 && maxAge >= 18) groups.push("成人(18-60岁)")
  if (maxAge >= 60) groups.push("老人(60岁以上)")
  return groups.length > 0 ? groups.join("；") : null
}

function deriveCoveragePeriodClass(periodText: string | undefined): string | null {
  if (!periodText || isMissingFieldValue(periodText)) return null
  if (/终身/.test(periodText)) return "终身"
  if (/1\s*年|一年|保险期间不超过\s*1\s*年/.test(periodText) && !/10\s*年|20\s*年|30\s*年/.test(periodText)) return "短期"
  if (/至|届满|领取期间|长期|10\s*年|20\s*年|30\s*年/.test(periodText)) return "长期"
  return null
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
  // Uses the same best-value logic as mergeFragmentContents: take first non-empty value
  const basicInfoModule = mergedModules.get("产品基础信息")
  const shortFieldLookup = new Map<string, string>()
  if (basicInfoModule && basicInfoModule.found) {
    for (const content of basicInfoModule.contents) {
      const fields = parseKeyFieldsTable(content)
      for (const [field, value] of fields) {
        if (!shortFieldLookup.has(field) || shouldReplaceFieldValue(shortFieldLookup.get(field), value, "产品基础信息", field)) {
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
        if (!isMissingFieldValue(value) && (!shortFieldLookup.has(field) || shouldReplaceFieldValue(shortFieldLookup.get(field), value, m.moduleName, field))) {
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
    if (shortFieldLookup.has(sf.fieldName) && !isMissingFieldValue(shortFieldLookup.get(sf.fieldName))) continue
    // Try to find a match in shortFieldLookup where the extracted name contains this schema name
    for (const [extractedName, extractedValue] of shortFieldLookup) {
      if (isMissingFieldValue(extractedValue)) continue
      if (shouldFuzzyBridgeSchemaField(sf, extractedName)) {
        shortFieldLookup.set(sf.fieldName, extractedValue)
        break
      }
    }
  }

  // ── Auto-bridge: fill main file fields from dedicated module key-fields ──
  // e.g. 犹豫期 module has 犹豫期天数=15日 → main file 犹豫期=15日
  const MODULE_TO_FIELD_BRIDGE: Record<string, Record<string, string>> = {
    "犹豫期": { "犹豫期天数": "犹豫期", "犹豫期退保处理": "犹豫期及合同解除（退保）" },
    "疾病等待期": { "等待期天数": "等待期" },
    "投保年龄": { "最低投保年龄": "投保年龄", "最高投保年龄": "投保年龄" },
    "年度免赔额": { "免赔额金额（有社保）": "免赔额", "免赔额类型": "0免赔" },
    "社保后赔付比例": { "报销比例": "报销比例" },
    "无社保赔付比例": { "报销比例": "报销比例" },
    "一般住院医疗": { "适用医院范围": "医院范围", "给付限额": "给付限额", "给付比例": "报销比例", "免赔额": "免赔额" },
    "投保职业": { "可投职业类别": "投保职业" },
    "投保人群": { "投保人与被保人关系要求": "投保范围" },
    "6年保证续保": { "保证续保": "保证续保", "保证续保期": "保证续保期" },
    "退保": { "犹豫期退保处理": "犹豫期及合同解除（退保）" },
  }
  for (const [moduleName, fieldMap] of Object.entries(MODULE_TO_FIELD_BRIDGE)) {
    const mod = mergedModules.get(moduleName)
    if (!mod || !mod.found) continue
    for (const content of mod.contents) {
      const fields = parseKeyFieldsTable(content)
      for (const [moduleFieldName, mainFieldName] of Object.entries(fieldMap)) {
        const val = fields.get(moduleFieldName)
        if (!val || isMissingFieldValue(val)) continue
        if (!shortFieldLookup.has(mainFieldName) || isMissingFieldValue(shortFieldLookup.get(mainFieldName))) {
          shortFieldLookup.set(mainFieldName, val)
        }
      }
    }
  }

  const setMainFieldIfMissing = (fieldName: string, value?: string | null) => {
    if (!value || isMissingFieldValue(value)) return
    if (!shortFieldLookup.has(fieldName) || isMissingFieldValue(shortFieldLookup.get(fieldName))) {
      shortFieldLookup.set(fieldName, value)
    }
  }

  const setMainFieldIfWeak = (fieldName: string, value?: string | null) => {
    if (!value || isMissingFieldValue(value)) return
    const current = shortFieldLookup.get(fieldName)
    if (!current || isMissingFieldValue(current) || value.length > current.length) {
      shortFieldLookup.set(fieldName, value)
    }
  }

  const ageFields = collectModuleKeyFields(mergedModules.get("投保年龄"))
  const minAge = ageFields.get("最低投保年龄")
  const maxAge = ageFields.get("最高投保年龄")
  if (minAge && maxAge) {
    setMainFieldIfWeak("投保年龄", `${minAge}至${maxAge}`)
  }

  const annuityFields = collectModuleKeyFields(mergedModules.get("年金给付规则"))
  const annuityPayoutFields = collectModuleKeyFields(mergedModules.get("领取期间"))
  setMainFieldIfMissing("领取规则", annuityFields.get("领取方式") ?? annuityPayoutFields.get("领取方式"))
  setMainFieldIfMissing("保证领取", annuityFields.get("保证给付"))
  const pensionParts = uniqueStrings([
    annuityFields.get("领取方式") ? `领取方式：${annuityFields.get("领取方式")}` : undefined,
    annuityFields.get("一次性领取金额") ? `一次性领取：${annuityFields.get("一次性领取金额")}` : undefined,
    annuityFields.get("年领领取期间") ? `年领领取期间：${annuityFields.get("年领领取期间")}` : undefined,
    annuityFields.get("年领每次给付金额（领取期间10年）") ? `10年领取期间：${annuityFields.get("年领每次给付金额（领取期间10年）")}` : undefined,
    annuityFields.get("年领每次给付金额（领取期间20年）") ? `20年领取期间：${annuityFields.get("年领每次给付金额（领取期间20年）")}` : undefined,
  ])
  if (pensionParts.length > 0) {
    setMainFieldIfMissing("养老金", pensionParts.join("；"))
    setMainFieldIfMissing("保什么", `养老保险金；${pensionParts.join("；")}`)
  }
  setMainFieldIfMissing("保险期间和续保", shortFieldLookup.get("保障期间"))

  if (category === "寿险") {
    const deathFields = collectModuleKeyFields(mergedModules.get("身故保险金"))
    const directCoverage = deathFields.get("保什么")
    const deathAmount = deathFields.get("身故保险金") ?? deathFields.get("身故保险金给付金额") ?? deathFields.get("身故保险金责任描述")
    const deathValue = directCoverage && (!deathAmount || informationScore(directCoverage) >= informationScore(deathAmount))
      ? directCoverage
      : deathAmount
    const disabilityValue = deathFields.get("全残保障") ?? deathFields.get("全残保险金") ?? deathFields.get("全残保险金给付金额")
    const accidentDeathValue = deathFields.get("意外身故")
    const diseaseDeathValue = deathFields.get("疾病身故")
    const responsibilityParts = uniqueStrings([
      deathValue ? `身故保险金：${deathValue}` : undefined,
      disabilityValue ? `全残保障：${disabilityValue}` : undefined,
      accidentDeathValue ? `意外身故：${accidentDeathValue}` : undefined,
      diseaseDeathValue ? `疾病身故：${diseaseDeathValue}` : undefined,
    ])

    if (responsibilityParts.length > 0) {
      setMainFieldIfWeak("保什么", responsibilityParts.join("；"))
      const coverageLabels = uniqueStrings([
        deathValue ? "身故保险金" : undefined,
        disabilityValue ? "全残保障" : undefined,
        accidentDeathValue ? "意外身故" : undefined,
        diseaseDeathValue ? "疾病身故" : undefined,
      ])
      if (coverageLabels.length > 0) {
        setMainFieldIfMissing("产品简介", `${productName}提供${coverageLabels.join("、")}保障。`)
      }
      setMainFieldIfMissing("产品特色", responsibilityParts.join("；"))
    }

    setMainFieldIfMissing("全残保障", disabilityValue)
    setMainFieldIfMissing("意外身故", accidentDeathValue)
    setMainFieldIfMissing("疾病身故", diseaseDeathValue)
    if (shortFieldLookup.get("投保年龄")) {
      setMainFieldIfMissing("投保范围", `被保险人投保年龄：${shortFieldLookup.get("投保年龄")}`)
    }

    const loanFields = collectModuleKeyFields(mergedModules.get("保单贷款"))
    const reductionFields = collectModuleKeyFields(mergedModules.get("减保"))
    const lifeRights = uniqueStrings([
      shortFieldLookup.get("保单贷款") ?? loanFields.get("保单贷款") ?? loanFields.get("贷款规则"),
      shortFieldLookup.get("部分领取") ?? reductionFields.get("部分领取") ?? reductionFields.get("减保规则"),
      shortFieldLookup.get("现金价值") ? `现金价值：${shortFieldLookup.get("现金价值")}` : undefined,
      shortFieldLookup.get("犹豫期") ? `犹豫期：${shortFieldLookup.get("犹豫期")}` : undefined,
    ])
    if (lifeRights.length > 0) {
      setMainFieldIfMissing("保单权益", lifeRights.join("；"))
    }
  }

  setMainFieldIfMissing("保障人群", deriveAudienceFromAge(shortFieldLookup.get("投保年龄")))
  setMainFieldIfMissing("保障期间分类", deriveCoveragePeriodClass(shortFieldLookup.get("保障期间")))

  if (category === "年金险") {
    const loanFields = collectModuleKeyFields(mergedModules.get("保单贷款"))
    const loanRule = shortFieldLookup.get("保单贷款") ?? loanFields.get("保单贷款")
    const payoutRule = shortFieldLookup.get("领取规则")
    const payoutPeriod = shortFieldLookup.get("领取期间")
    const guaranteePayout = shortFieldLookup.get("保证领取")
    const startAge = annuityFields.get("开始领取年龄") ?? annuityFields.get("年金给付起始年龄")

    if (loanRule && !isMissingFieldValue(loanRule)) {
      setMainFieldIfMissing("高流动性", "具备一定流动性：支持保单贷款，贷款额度与合同现金价值相关")
    }
    if (shortFieldLookup.get("投保年龄")) {
      setMainFieldIfMissing("投保范围", `被保险人投保年龄：${shortFieldLookup.get("投保年龄")}`)
    }
    if (shortFieldLookup.get("保什么")) {
      setMainFieldIfMissing(
        "产品简介",
        `${productName}提供养老保险金保障${guaranteePayout ? "，并约定领取期间内身故的保证给付安排" : ""}。`,
      )
    }

    const featureParts = uniqueStrings([
      payoutRule ? `领取规则：${payoutRule}` : undefined,
      payoutPeriod ? `领取期间：${payoutPeriod}` : undefined,
      startAge ? `开始领取年龄：${startAge}` : undefined,
      guaranteePayout ? `保证领取：${guaranteePayout}` : undefined,
      loanRule ? "支持保单贷款" : undefined,
    ])
    if (featureParts.length > 0) {
      setMainFieldIfMissing("产品特色", featureParts.join("；"))
      setMainFieldIfMissing("保单权益", featureParts.join("；"))
    }
  }

  // ── Auto-fill long text fields from module source text ──
  // For long text fields like 保什么, 报销范围 etc., synthesize from module contents
  for (const [fieldName, moduleNames] of Object.entries(LONG_FIELD_MODULE_MAP)) {
    if (shortFieldLookup.has(fieldName) && !isMissingFieldValue(shortFieldLookup.get(fieldName))) continue
    const parts: string[] = []
    for (const mn of moduleNames) {
      const mod = mergedModules.get(mn)
      if (!mod || !mod.found) continue
      for (const content of mod.contents) {
        const fields = parseKeyFieldsTable(content)
        // Collect all non-empty field values from this module as a summary
        const vals: string[] = []
        for (const [k, v] of fields) {
          if (!isMissingFieldValue(v) && k !== "字段" && !k.startsWith("--")) {
            vals.push(`${k}: ${v}`)
          }
        }
        if (vals.length > 0) parts.push(`【${mn}】${vals.join("；")}`)
      }
    }
    if (parts.length > 0) {
      shortFieldLookup.set(fieldName, parts.join(" | "))
    }
  }

  for (const [fieldName, value] of [...shortFieldLookup]) {
    if (shouldRejectMainFieldValue(fieldName, value)) {
      shortFieldLookup.delete(fieldName)
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
    const val = shortFieldLookup.get(f.fieldName) ?? EMPTY_FIELD_VALUE
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
      const val = shortFieldLookup.get(f.fieldName) ?? EMPTY_FIELD_VALUE
      lines.push(`| ${f.fieldName} | ${val.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`)
    }
    lines.push("")
  }

  // ── Section 3: Long business fields from Excel schema ────────────────
  const longFields = allFields.filter(f => f.valueType === "long")
  if (longFields.length > 0) {
    lines.push("## 长文本字段")
    lines.push("")
    lines.push("| 字段 | 值 |")
    lines.push("|---|---|")
    for (const f of longFields) {
      const val = shortFieldLookup.get(f.fieldName) ?? EMPTY_FIELD_VALUE
      lines.push(`| ${f.fieldName} | ${val.replace(/\n/g, "<br>").replace(/\|/g, "\\|")} |`)
    }
    lines.push("")
  }


  // ── Section 4+: long fields inline ──────────────────────────
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
  const found = allModules.filter(m => {
    const merged = mergedModules.get(m.moduleName)
    return !!merged?.found && moduleHasExtractedValues(merged)
  })
  const pendingRefinement = allModules.filter(m => {
    const merged = mergedModules.get(m.moduleName)
    return !!merged?.found && !moduleHasExtractedValues(merged)
  })
  const missing = allModules.filter(m => !mergedModules.get(m.moduleName)?.found)
  const knownFields = allFields
    .map(f => ({ field: f, value: shortFieldLookup.get(f.fieldName) ?? EMPTY_FIELD_VALUE }))
    .filter(item => !isMissingFieldValue(item.value))
  const gapFields = allFields
    .map(f => ({ field: f, value: shortFieldLookup.get(f.fieldName) ?? EMPTY_FIELD_VALUE }))
    .filter(item => isMissingFieldValue(item.value))

  lines.push("## 已有知识清单")
  lines.push("")
  lines.push("### 已有字段")
  lines.push("")
  if (knownFields.length > 0) {
    lines.push("| 字段范围 | 字段 | 当前值摘要 |")
    lines.push("|---|---|---|")
    for (const item of knownFields) {
      lines.push(`| ${fieldScopeLabel(item.field.fieldName, baseFieldNames, category)} | ${item.field.fieldName} | ${tableCell(item.value)} |`)
    }
  } else {
    lines.push("- 暂无已抽取字段。")
  }
  lines.push("")
  lines.push("### 已有模块")
  lines.push("")
  if (found.length > 0) {
    for (const m of found) {
      const merged = mergedModules.get(m.moduleName)!
      const totalChars = merged.contents.reduce((s, c) => s + c.length, 0)
      lines.push(`- **${m.moduleName}**：${totalChars} 字，覆盖 ${merged.sectionIndices.length} 个章节。`)
    }
  } else {
    lines.push("- 暂无已抽取模块。")
  }
  lines.push("")

  lines.push("## 知识缺口清单")
  lines.push("")
  lines.push("### 缺失字段")
  lines.push("")
  if (gapFields.length > 0) {
    lines.push("| 字段范围 | 字段 | 类型 |")
    lines.push("|---|---|---|")
    for (const item of gapFields) {
      lines.push(`| ${fieldScopeLabel(item.field.fieldName, baseFieldNames, category)} | ${item.field.fieldName} | ${item.field.valueType === "long" ? "长文本" : "短字段"} |`)
    }
  } else {
    lines.push("- 字段层面暂无缺口。")
  }
  lines.push("")
  lines.push("### 缺失模块")
  lines.push("")
  if (pendingRefinement.length > 0 || missing.length > 0) {
    for (const m of pendingRefinement) {
      lines.push(`- [ ] **${m.moduleName}** (已定位原文，待精炼)`)
    }
    for (const m of missing) {
      lines.push(`- [ ] **${m.moduleName}** (${m.required ? "必填" : "选填"})`)
    }
  } else {
    lines.push("- 模块层面暂无缺口。")
  }
  lines.push("")

  lines.push("## 已抽取模块")
  lines.push("")
  for (const m of found) {
    const merged = mergedModules.get(m.moduleName)!
    const totalChars = merged.contents.reduce((s, c) => s + c.length, 0)
    lines.push(`- ✅ **${m.moduleName}** — ${totalChars} 字 · ${merged.sectionIndices.length} 个章节 → [\`${category}-${productName}-${m.moduleName}.md\`]`)
  }
  lines.push("")

  if (pendingRefinement.length > 0 || missing.length > 0) {
    lines.push("## 待补全模块")
    lines.push("")
    for (const m of pendingRefinement) {
      lines.push(`- [ ] **${m.moduleName}** (已定位原文，待精炼)`)
    }
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
    basic_info: /险种|产品|保险期|保险期间|交费|保障期|保障期间|投保|承保|年龄|简称|代码|主险|附加|公司|计划|等待期|无等待期|犹豫期|宽限期|豁免|重新投保|届满|合同解除|退保/,
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
  const extractionStartTime = Date.now()
  let completedGroups = 0
  const totalGroups = [...groupMap.keys()].length

  // Heartbeat: update activity panel every 5 seconds so the UI doesn't look frozen
  let heartbeatDetail = ""
  const heartbeatTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - extractionStartTime) / 1000)
    const min = Math.floor(elapsed / 60)
    const sec = elapsed % 60
    const timeStr = min > 0 ? `${min}分${sec}秒` : `${sec}秒`
    activity.updateItem(activityId, {
      detail: `${heartbeatDetail}（已耗时 ${timeStr}）`,
    })
  }, 5000)

  try {
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

      completedGroups++
      heartbeatDetail = `[${completedGroups}/${totalGroups}] ${groupKey}: ${relevantSections.length}/${sections.length} 个相关章节，${groupModules.length} 个模块`
      activity.updateItem(activityId, {
        detail: `${heartbeatDetail}...`,
      })

      // Process chunks in batches to avoid overwhelming the internal model.
      for (let i = 0; i < relevantSections.length; i += MAX_SECTION_PARALLEL) {
        if (signal?.aborted) break
        const batch = relevantSections.slice(i, i + MAX_SECTION_PARALLEL)
        const batchEnd = Math.min(i + MAX_SECTION_PARALLEL, relevantSections.length)
        heartbeatDetail = `[${completedGroups}/${totalGroups}] ${groupKey}: 章节 ${batchEnd}/${relevantSections.length}，模块 ${groupModules.length} 个`
        activity.updateItem(activityId, {
          detail: `${heartbeatDetail}...`,
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
  } finally {
    clearInterval(heartbeatTimer)
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

  const catalogDir = `${projectPath}/wiki/product_catalog`
  await createDirectory(catalogDir)

  if (foundModules.length === 0) {
    activity.updateItem(activityId, { detail: "未能提取到任何模块。" })
    return []
  }

  // ── Phase 4: Write files ───────────────────────────────────
  activity.updateItem(activityId, {
    detail: `正在写入 ${foundModules.length} 个模块文件 + 主文件 + 字段页...`,
  })
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

  // 4b: Field-level pages aligned to the Excel schema (only for fields with values)
  for (const fieldPage of buildProductFieldFiles(mainContent, category, productName)) {
    if (!fieldPage.hasValue) continue
    const fieldPath = `${catalogDir}/${fieldPage.fileName}`
    const fieldRelative = `wiki/product_catalog/${fieldPage.fileName}`
    try {
      await writeFile(fieldPath, fieldPage.content)
      writtenPaths.push(fieldRelative)
    } catch (err) {
      log.error("failed to write product field file", { path: fieldRelative, error: String(err) })
    }
  }

  // 4c: Individual module files
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

  // 4d: Save OCR source text for reference
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

  log.info("initial extraction complete; refinement is manual", {
    foundModules: foundModules.length,
    filesWritten: writtenPaths.length,
  })

  activity.updateItem(activityId, {
    detail: `完成：${foundModules.length}/${allModules.length} 个模块，${writtenPaths.length} 个文件。已保留原文，可点击“精炼”补抽缺口。`,
  })

  return writtenPaths
}

// ════════════════════════════════════════════════════════════════
// Phase 5 — Module Refinement (二次精炼)
//
// 对每个模块文件的「详细条款原文」做聚焦式 LLM 调用，
// 补充首次抽取中遗漏（值为空）的关键字段。
// 并发数 10，每次只发几百字原文 + 字段列表。
// ════════════════════════════════════════════════════════════════

const REFINE_PARALLEL = 10

interface RefineResult {
  totalModules: number
  refined: number
  fieldsUpdated: number
  skipped: number
  mainFilesRebuilt: number
}

/**
 * 从模块 md 文件中提取「详细条款原文」部分。
 */
function extractSourceText(content: string): string {
  const match = content.match(/## 详细条款原文\s*\n([\s\S]*?)$/)
  return match ? match[1].trim() : ""
}

function markModuleHasValues(content: string): string {
  let next = content.replace(/^status:\s*["']?rejected["']?\s*$/m, "status: candidate")
  next = next.replace(/^extraction_state:\s*["']?needs_refinement["']?\s*$/m, "extraction_state: has_values")
  return next
}

function extraRefineFieldsForModule(moduleName: string, category?: InsuranceCategoryType): string[] {
  const fields = REFINE_EXTRA_FIELDS_BY_MODULE[moduleName] ?? []
  if (category === "年金险") return fields
  return fields.filter(field => !["高流动性", "教育金", "领钱时间早", "投保门槛低", "万能账户", "养老金", "领取规则", "产品利率", "领取期间"].includes(field))
}

function appendKeyFieldRow(content: string, fieldName: string, value: string): string {
  const sectionRegex = /(## 关键字段\s*\r?\n\s*\|[^\n]*\|\s*\r?\n\s*\|[-:\s|]+\|\s*\r?\n)((?:\|.*\|\s*\r?\n)*)/
  if (!sectionRegex.test(content)) return content
  return content.replace(sectionRegex, (_match, header: string, rows: string) => {
    if (new RegExp(`^\\|\\s*${escapeRegExp(fieldName)}\\s*\\|`, "m").test(rows)) {
      return `${header}${rows}`
    }
    return `${header}${rows}| ${fieldName} | ${value} |\n`
  })
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
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) {
    log.info("refine skip", { file: fileName, reason: "no frontmatter", contentStart: content.substring(0, 50) })
    return 0
  }
  const fm = fmMatch[1]
  const moduleNameMatch = fm.match(/^module_name:\s*"?([^"\n]+?)"?\s*$/m)
  const categoryMatch = fm.match(/^insurance_category:\s*"?([^"\n]+?)"?\s*$/m)
  if (!moduleNameMatch) {
    log.info("refine skip", { file: fileName, reason: "no module_name in frontmatter" })
    return 0
  }
  const moduleName = moduleNameMatch[1].trim()
  const category = isInsuranceCategory(categoryMatch?.[1]?.trim()) ? categoryMatch?.[1]?.trim() as InsuranceCategoryType : undefined

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

  // Check if there are any empty/missing fields to fill
  const existingFields = parseKeyFieldsTable(content)
  let needsRefinement = false
  const targetFields: string[] = []

  const addTargetField = (fieldName: string, force = false) => {
    const existingName = resolveExistingFieldName(fieldName, existingFields)
    if (existingName) {
      if ((force || isMissingFieldValue(existingFields.get(existingName))) && !targetFields.includes(existingName)) {
        needsRefinement = true
        targetFields.push(existingName)
      }
      return
    }
    if (!targetFields.includes(fieldName)) {
      needsRefinement = true
      targetFields.push(fieldName)
    }
  }

  for (const [k, v] of existingFields) {
    if (isMissingFieldValue(v)) addTargetField(k)
  }
  const fieldHints = FIELD_EXTRACTION_HINTS[moduleName]
  if (fieldHints) {
    for (const hintedField of Object.keys(fieldHints)) {
      addTargetField(hintedField, true)
    }
  }
  for (const extraField of extraRefineFieldsForModule(moduleName, category)) {
    addTargetField(extraField)
  }
  if (!needsRefinement) {
    log.info("refine skip", { file: fileName, reason: "no empty fields", moduleName, fieldsCount: existingFields.size })
    return 0
  }

  // Extract source text
  const sourceText = extractSourceText(content)
  if (!sourceText || sourceText.length < 20) {
    log.info("refine skip", { file: fileName, reason: "no source text", moduleName, srcLen: sourceText?.length ?? 0 })
    return 0
  }

  const sourceExcerpt = buildRefineSourceExcerpt(sourceText, moduleName, targetFields, fieldHints)
  log.info("refine calling LLM", {
    file: fileName,
    moduleName,
    targetCount: targetFields.length,
    srcLen: sourceText.length,
    excerptLen: sourceExcerpt.length,
  })

  // Build focused prompt
  const fieldList = targetFields.map(f => `- ${f}`).join("\n")
  const fieldHintBlock = fieldHints
    ? [
        "",
        "## 字段特别说明",
        ...Object.entries(fieldHints).map(([field, hint]) => `- ${field}: ${hint}`),
      ].join("\n")
    : ""
  const prompt = `你是保险条款分析专家。请从以下证据片段中提取关键字段。

## 需要提取的字段
${fieldList}
${fieldHintBlock}

## 证据片段
${sourceExcerpt}

## 输出要求
请输出 Markdown 表格，格式如下：
| 字段 | 值 |
|---|---|
| 字段名 | 提取到的值 |

规则：
- 只输出“需要提取的字段”中在证据片段里明确找到的字段
- 如果证据片段没有提到某字段，不要输出该行
- 不要输出空值或任何占位文本（如"未明确"、"未提及"、"暂无"、"不涉及"），只输出有实际值的行
- 若原文用编号列出多种情形，必须完整列出所有编号情形，不要只输出第一条
- 值要简洁准确`

  // Call LLM via callback-based streamChat
  let response = ""
  try {
    await new Promise<void>((resolve, reject) => {
      streamChat(
        llmConfig,
        [{ role: "user", content: prompt }],
        {
          onToken: (token) => { response += token },
          onDone: () => resolve(),
          onError: (err) => reject(err),
        },
        signal,
        { temperature: 0.1, max_tokens: 2000 },
      )
    })
  } catch {
    return 0
  }

  if (!response || signal?.aborted) return 0

  // Parse LLM response: extract table rows directly (no section header required)
  const newFields = new Map<string, string>()
  const rowRegex = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRegex.exec(response)) !== null) {
    const field = rowMatch[1].trim()
    const value = sanitizeFieldValue(rowMatch[2])
    if (field === "---" || field === "字段" || field.startsWith("--") || value === "值" || value === "---") continue
    if (field && value) newFields.set(field, value)
  }
  log.info("refine parsed response", {
    file: filePath.split("/").pop(),
    responseLen: response.length,
    parsedCount: newFields.size,
    sample: [...newFields.entries()].slice(0, 3).map(([k, v]) => `${k}=${v.substring(0, 20)}`),
  })
  if (newFields.size === 0) return 0

  // Merge: replace rows whose current value is empty or placeholder text.
  let updatedCount = 0
  let updatedContent = content

  for (const [field, newValue] of newFields) {
    if (isMissingFieldValue(newValue)) continue
    const existingFieldName = resolveExistingFieldName(field, existingFields) ?? field
    if (!shouldReplaceFieldValue(existingFields.get(existingFieldName), newValue, moduleName, existingFieldName)) continue

    // Match row: | field | existing value |
    const escapedField = escapeRegExp(existingFieldName)
    const rowRegex = new RegExp(`\\|\\s*${escapedField}\\s*\\|\\s*[^|]*\\|`, "g")
    if (rowRegex.test(updatedContent)) {
      updatedContent = updatedContent.replace(
        new RegExp(`\\|\\s*${escapedField}\\s*\\|\\s*[^|]*\\|`, "g"),
        `| ${existingFieldName} | ${newValue} |`
      )
      updatedCount++
      existingFields.set(existingFieldName, newValue)
    } else {
      const appended = appendKeyFieldRow(updatedContent, existingFieldName, newValue)
      if (appended !== updatedContent) {
        updatedContent = appended
        updatedCount++
        existingFields.set(existingFieldName, newValue)
      }
    }
  }

  if (updatedCount > 0) {
    updatedContent = markModuleHasValues(updatedContent)
    await writeFile(filePath, updatedContent)
  }

  return updatedCount
}

type CatalogFileEntry = { name: string; path: string; is_dir: boolean }

interface CatalogModuleMetadata {
  category: InsuranceCategoryType
  productName: string
  moduleName: string
  sourceSections: number
}

function frontmatterValue(content: string, key: string): string | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return null
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]*))\\s*$`, "m")
  const match = fmMatch[1].match(pattern)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null
}

function isInsuranceCategory(value: string | null | undefined): value is InsuranceCategoryType {
  return !!value && Object.prototype.hasOwnProperty.call(PRODUCT_CATALOG_MODULES, value)
}

function parseCatalogModuleMetadata(content: string): CatalogModuleMetadata | null {
  const categoryValue = frontmatterValue(content, "insurance_category")
  const productName = frontmatterValue(content, "product_name")
  const moduleName = frontmatterValue(content, "module_name")
  if (!isInsuranceCategory(categoryValue) || !productName || !moduleName) return null
  if (!isModuleAllowedForCategory(categoryValue, moduleName)) return null

  const sourceSectionsValue = Number.parseInt(frontmatterValue(content, "source_sections") ?? "1", 10)
  return {
    category: categoryValue,
    productName,
    moduleName,
    sourceSections: Number.isFinite(sourceSectionsValue) && sourceSectionsValue > 0 ? sourceSectionsValue : 1,
  }
}

async function filterModuleFiles(
  files: CatalogFileEntry[],
  scope?: { category?: string; productName?: string },
): Promise<CatalogFileEntry[]> {
  const moduleFiles: CatalogFileEntry[] = []
  for (const file of files) {
    try {
      const content = await readFile(file.path)
      const metadata = parseCatalogModuleMetadata(content)
      if (!metadata) continue
      if (scope?.category && metadata.category !== scope.category) continue
      if (scope?.productName && metadata.productName !== scope.productName) continue
      moduleFiles.push(file)
    } catch (err) {
      log.warn("failed to inspect catalog module file", { file: file.name, error: String(err) })
    }
  }
  return moduleFiles
}

async function rebuildMainFilesFromModules(
  catalogDir: string,
  scope?: { category?: string; productName?: string },
): Promise<number> {
  const tree = (await listDirectory(catalogDir)) as CatalogFileEntry[]
  const files = tree.filter(f => !f.is_dir && f.name?.endsWith(".md"))
  const groups = new Map<string, {
    category: InsuranceCategoryType
    productName: string
    sectionCount: number
    modules: Map<string, MergedModule>
  }>()

  for (const file of files) {
    let content = ""
    try {
      content = await readFile(file.path)
    } catch (err) {
      log.warn("failed to read catalog module while rebuilding main file", { file: file.name, error: String(err) })
      continue
    }

    const metadata = parseCatalogModuleMetadata(content)
    if (!metadata) continue
    if (scope?.category && metadata.category !== scope.category) continue
    if (scope?.productName && metadata.productName !== scope.productName) continue

    const key = `${metadata.category}\0${metadata.productName}`
    let group = groups.get(key)
    if (!group) {
      group = {
        category: metadata.category,
        productName: metadata.productName,
        sectionCount: metadata.sourceSections,
        modules: new Map<string, MergedModule>(),
      }
      groups.set(key, group)
    }

    group.sectionCount = Math.max(group.sectionCount, metadata.sourceSections)
    const existing = group.modules.get(metadata.moduleName)
    if (existing) {
      existing.contents.push(content)
      existing.sectionIndices.push(existing.sectionIndices.length)
      existing.found = true
    } else {
      group.modules.set(metadata.moduleName, {
        moduleName: metadata.moduleName,
        contents: [content],
        sectionIndices: [0],
        found: true,
      })
    }
  }

  let rebuilt = 0
  for (const group of groups.values()) {
    const allModules = PRODUCT_CATALOG_MODULES[group.category]
    const merged = new Map<string, MergedModule>()
    for (const moduleDef of allModules) {
      merged.set(moduleDef.moduleName, {
        moduleName: moduleDef.moduleName,
        contents: [],
        sectionIndices: [],
        found: false,
      })
    }
    for (const [moduleName, moduleData] of group.modules) {
      merged.set(moduleName, moduleData)
    }

    const mainContent = buildMainFile(
      merged,
      group.category,
      group.productName,
      Math.max(group.sectionCount, 1),
      allModules,
    )
    await writeFile(`${catalogDir}/${group.category}-${group.productName}.md`, mainContent)
    for (const fieldPage of buildProductFieldFiles(mainContent, group.category, group.productName)) {
      if (!fieldPage.hasValue) continue
      await writeFile(`${catalogDir}/${fieldPage.fileName}`, fieldPage.content)
    }
    rebuilt++
  }

  return rebuilt
}

export async function rebuildProductCatalogMainFiles(
  projectPath: string,
  scope?: { category?: string; productName?: string },
): Promise<number> {
  const pp = normalizePath(projectPath)
  return rebuildMainFilesFromModules(`${pp}/wiki/product_catalog`, scope)
}

/**
 * 对指定产品的所有模块文件做精炼。
 * 可用于手动补抽某个产品，并在结束后刷新产品主文件。
 */
export async function refineModuleFiles(
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

  let files: CatalogFileEntry[] = []
  try {
    const tree = (await listDirectory(catalogDir)) as CatalogFileEntry[]
    const candidates = tree.filter(f => !f.is_dir && f.name.startsWith(prefix) && f.name.endsWith(".md"))
    files = await filterModuleFiles(candidates, { category, productName })
  } catch {
    return { totalModules: 0, refined: 0, fieldsUpdated: 0, skipped: 0, mainFilesRebuilt: 0 }
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

  let mainFilesRebuilt = 0
  if (!signal?.aborted) {
    activity.updateItem(activityId, { detail: "正在刷新产品主文件..." })
    try {
      mainFilesRebuilt = await rebuildMainFilesFromModules(catalogDir, { category, productName })
    } catch (err) {
      log.warn("failed to rebuild product main file after refinement", { error: String(err), category, productName })
    }
  }

  return { totalModules: files.length, refined, fieldsUpdated, skipped, mainFilesRebuilt }
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

  let allFiles: CatalogFileEntry[] = []
  try {
    const tree = await listDirectory(catalogDir)
    log.info("listDirectory raw result", {
      type: typeof tree,
      length: Array.isArray(tree) ? tree.length : "not array",
      firstItem: tree?.[0] ? JSON.stringify(tree[0]).substring(0, 200) : "empty",
      firstItemKeys: tree?.[0] ? Object.keys(tree[0] as Record<string, unknown>) : [],
    })
    const candidates = (tree as CatalogFileEntry[])
      .filter(f => !f.is_dir && f.name?.endsWith(".md") && f.name?.includes("-"))
    allFiles = await filterModuleFiles(candidates)
  } catch (err) {
    log.error("listDirectory failed", { error: String(err), catalogDir })
    return { totalModules: 0, refined: 0, fieldsUpdated: 0, skipped: 0, mainFilesRebuilt: 0 }
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

  let mainFilesRebuilt = 0
  if (!signal?.aborted) {
    activity.updateItem(activityId, {
      detail: "正在刷新产品主文件的已有知识/知识缺口清单...",
    })
    try {
      mainFilesRebuilt = await rebuildMainFilesFromModules(catalogDir)
    } catch (err) {
      log.warn("failed to rebuild product main files after refinement", { error: String(err), catalogDir })
    }
  }

  log.info("批量精炼完成", { totalModules: allFiles.length, refined, fieldsUpdated, skipped, mainFilesRebuilt })
  activity.updateItem(activityId, {
    detail: `精炼完成：${refined}/${allFiles.length} 个模块更新，共补充 ${fieldsUpdated} 个字段，刷新 ${mainFilesRebuilt} 个主文件。`,
  })

  return { totalModules: allFiles.length, refined, fieldsUpdated, skipped, mainFilesRebuilt }
}
