/**
 * concept-aggregator.ts
 *
 * Post-processing step that builds wiki/concepts/ pages linking:
 * 1. service_item entities across versions (existing behavior)
 * 2. product_catalog modules across products (new — insurance concepts)
 *
 * Insurance concept pages aggregate all products sharing a common concept
 * (e.g. "保证续保" → links to every product module that has this feature).
 */

import { readFile, writeFile, listDirectory, createDirectory } from "@/commands/fs"
import { parseServiceItemTitle } from "@/lib/insurance-schema-registry"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import {
  INSURANCE_CATEGORIES,
  isModuleAllowedForCategory,
  parseProductModuleTitle,
  type InsuranceCategoryType,
} from "@/lib/product-catalog-modules"

// ════════════════════════════════════════════════════════════════
// Part 1 — Service item concept aggregation (cross-version)
// ════════════════════════════════════════════════════════════════

interface ConceptInstance {
  lineName: string
  versionName: string
  entityRelPath: string  // relative to projectPath
  title: string
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const n of nodes) {
    if (n.is_dir && n.children) files.push(...flattenMdFiles(n.children))
    else if (!n.is_dir && n.name.endsWith(".md")) files.push(n)
  }
  return files
}

async function scanServiceItemConcepts(
  projectPath: string,
): Promise<Map<string, ConceptInstance[]>> {
  const pp = normalizePath(projectPath)
  const conceptMap = new Map<string, ConceptInstance[]>()

  let entityFiles: FileNode[] = []
  try {
    const tree = await listDirectory(`${pp}/wiki/entities`)
    entityFiles = flattenMdFiles(tree)
  } catch {
    return conceptMap
  }

  for (const file of entityFiles) {
    try {
      const content = await readFile(file.path)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue

      const fm = fmMatch[1]
      const titleMatch = fm.match(/^title:\s*["']?([^"'\n]+?)["']?\s*$/m)
      if (!titleMatch) continue

      const title = titleMatch[1].trim()
      const parsed = parseServiceItemTitle(title)
      if (!parsed || !parsed.itemName) continue

      const relPath = file.path.includes(pp)
        ? file.path.slice(pp.length).replace(/^[/\\]/, "")
        : file.path

      const instances = conceptMap.get(parsed.itemName) ?? []
      instances.push({
        lineName: parsed.lineName,
        versionName: parsed.versionName,
        entityRelPath: relPath.replace(/\\/g, "/"),
        title,
      })
      conceptMap.set(parsed.itemName, instances)
    } catch {
      // ignore
    }
  }
  return conceptMap
}

function buildServiceConceptPage(itemName: string, instances: ConceptInstance[]): string {
  const sorted = [...instances].sort((a, b) =>
    a.lineName.localeCompare(b.lineName) || a.versionName.localeCompare(b.versionName)
  )
  const today = new Date().toISOString().split("T")[0]
  const tableRows = sorted.map(inst => {
    const relLink = `../${inst.entityRelPath}`
    return `| ${inst.lineName} | ${inst.versionName} | [${inst.title}](${relLink}) |`
  }).join("\n")
  const relatedTitles = sorted.map(inst => `"${inst.title}"`).join(", ")

  return `---
type: concept
entity_type: service_item_concept
title: "${itemName}"
knowledge_domain: product
business_phase: service
tags: [service-concept, cross-version]
instance_count: ${instances.length}
related: [${relatedTitles}]
created: ${today}
updated: ${today}
---

# ${itemName}

跨服务线服务项概念。以下服务线版本均提供此服务，点击链接查看各版本的具体服务内容：

| 服务线 | 版本 | 服务项详情 |
|--------|------|-----------|
${tableRows}

## 说明

- 此页面由系统自动生成，每次重新抽取后会刷新。
- 各版本的"${itemName}"在服务范围、限制条件、响应时效等方面可能存在差异，请参阅各版本详情页。
- 如需对比各版本差异，可使用顶部"对比"功能。
`
}

export async function buildServiceConceptIndex(projectPath: string): Promise<{
  created: number
  updated: number
  skipped: number
}> {
  const pp = normalizePath(projectPath)
  const conceptMap = await scanServiceItemConcepts(projectPath)
  await createDirectory(`${pp}/wiki/concepts`).catch(() => {})

  let created = 0, updated = 0, skipped = 0

  for (const [itemName, instances] of conceptMap) {
    if (instances.length < 2) { skipped++; continue }
    const conceptPath = `${pp}/wiki/concepts/${itemName}.md`
    const newContent = buildServiceConceptPage(itemName, instances)
    try {
      const existing = await readFile(conceptPath).catch(() => null)
      if (existing === null) {
        await writeFile(conceptPath, newContent)
        created++
      } else {
        const existingCountMatch = existing.match(/^instance_count:\s*(\d+)/m)
        const existingCount = existingCountMatch ? parseInt(existingCountMatch[1]) : 0
        if (existingCount !== instances.length) {
          await writeFile(conceptPath, newContent)
          updated++
        } else {
          skipped++
        }
      }
    } catch {
      skipped++
    }
  }
  return { created, updated, skipped }
}

export async function backfillEntityRelated(projectPath: string): Promise<{
  updated: number
  skipped: number
}> {
  const pp = normalizePath(projectPath)
  const conceptMap = await scanServiceItemConcepts(projectPath)
  let updated = 0, skipped = 0

  for (const [, instances] of conceptMap) {
    if (instances.length < 2) continue
    const allTitles = instances.map(i => i.title)
    for (const inst of instances) {
      const siblings = allTitles.filter(t => t !== inst.title)
      if (siblings.length === 0) { skipped++; continue }
      const fullPath = `${pp}/${inst.entityRelPath}`
      try {
        const content = await readFile(fullPath)
        const existingMatch = content.match(/^related:\s*\[([^\]]*)\]/m)
        const existing: string[] = existingMatch
          ? existingMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
          : []
        const merged = Array.from(new Set([...existing, ...siblings]))
        const newRelatedLine = `related: [${merged.map(t => `"${t}"`).join(", ")}]`
        const newContent = existingMatch
          ? content.replace(/^related:\s*\[([^\]]*)\]/m, newRelatedLine)
          : content.replace(/^(---\r?\n[\s\S]*?)(related:\s*\n)/m, (_, pre) => `${pre}${newRelatedLine}\n`)
        if (newContent === content) { skipped++; continue }
        await writeFile(fullPath, newContent)
        updated++
      } catch {
        skipped++
      }
    }
  }
  return { updated, skipped }
}

// ════════════════════════════════════════════════════════════════
// Part 2 — Insurance product concept aggregation (cross-product)
//
// Every unique module_name found in wiki/product_catalog/ auto-
// generates a concept page. No hardcoded concept map needed —
// concepts are 1:1 with module names, enabling both cross-product
// and cross-benefit querying.
// ════════════════════════════════════════════════════════════════

interface ProductConceptInstance {
  insuranceCategory: string
  productName: string
  moduleName: string
  moduleRelPath: string   // relative to projectPath
}

interface ProductFieldConceptInstance {
  insuranceCategory: string
  productName: string
  fieldName: string
  fieldScope: string
  valueSummary: string
  fieldRelPath: string
}

interface ProductConceptGroup {
  modules: ProductConceptInstance[]
  fields: ProductFieldConceptInstance[]
}

function frontmatterScalar(fm: string, key: string): string | null {
  const pattern = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]*))\\s*$`, "m")
  const match = fm.match(pattern)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null
}

function getProductConceptGroup(
  conceptMap: Map<string, ProductConceptGroup>,
  conceptName: string,
): ProductConceptGroup {
  let group = conceptMap.get(conceptName)
  if (!group) {
    group = { modules: [], fields: [] }
    conceptMap.set(conceptName, group)
  }
  return group
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) backslashes++
  return backslashes % 2 === 1
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null

  const cells: string[] = []
  let current = ""
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i]
    if (ch === "|" && !isEscapedAt(trimmed, i)) {
      cells.push(current.trim().replace(/\\\|/g, "|"))
      current = ""
    } else {
      current += ch
    }
  }
  cells.push(current.trim().replace(/\\\|/g, "|"))
  return cells
}

const PLACEHOLDER_VALUE_REGEX = /^(未明确|未提及|未提到|未说明|未在本|未在证据|未从证据|证据片段未|证据片段中未|证据片段没有|证据中未|该字段未|文中未|原文未|原文中未|材料未|未找到|未见|没有提到|证据不足|无明确|不涉及|暂无|暂未|无此信息|无相关|本章节未|条款未|不适用于本|N\/A|n\/a|无$)/
const REFERENCE_ONLY_PREFIX_REGEX = /^(?:详见|见|参见|参考|请参见|请查看|查看)\s*/i
const REFERENCE_ONLY_TARGET_REGEX = /^(?:来源文件|费率表|原文|附件|附表|附录|条款|章节|投保范围|责任免除|保险金给付限额|计划表|保险计划表|第?\d+(?:\.\d+)*\s*(?:条|节)?)/i

function isReferenceOnlyFieldValue(value: string): boolean {
  const normalized = value.trim()
  if (!REFERENCE_ONLY_PREFIX_REGEX.test(normalized)) return false
  const target = normalized.replace(REFERENCE_ONLY_PREFIX_REGEX, "").trim()
  if (!target) return true
  return REFERENCE_ONLY_TARGET_REGEX.test(target) || (target.length <= 48 && /\d+(?:\.\d+)+/.test(target))
}

function isMissingConceptFieldValue(value: string): boolean {
  const normalized = value.trim()
  return normalized === "" || PLACEHOLDER_VALUE_REGEX.test(normalized) || isReferenceOnlyFieldValue(normalized)
}

function summarizeFieldValue(value: string, maxLength = 180): string {
  const normalized = value.replace(/<br>/g, " ").replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength).trim()}...`
}

function markdownTableCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")
}

function parseFieldValue(content: string, fieldName: string): string {
  for (const line of content.split(/\r?\n/)) {
    const cells = splitMarkdownTableRow(line)
    if (!cells || cells.length < 2) continue
    if (cells[0] !== fieldName) continue
    return cells[1].replace(/<br>/g, " ").trim()
  }
  return ""
}

/**
 * Scan wiki/product_catalog/ for ALL module files and build
 * a map of concept name → product modules/fields sharing that concept.
 *
 * Every module_name and every populated field_name becomes a concept.
 */
async function scanProductConcepts(
  projectPath: string,
): Promise<Map<string, ProductConceptGroup>> {
  const pp = normalizePath(projectPath)
  const conceptMap = new Map<string, ProductConceptGroup>()

  let catalogFiles: FileNode[] = []
  try {
    const tree = await listDirectory(`${pp}/wiki/product_catalog`)
    catalogFiles = flattenMdFiles(tree)
  } catch {
    return conceptMap
  }

  for (const file of catalogFiles) {
    try {
      const content = await readFile(file.path)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue

      const fm = fmMatch[1]
      const domain = frontmatterScalar(fm, "knowledge_domain")
      if (domain && domain !== "product_catalog" && domain !== "product_catalog_field") continue

      const status = frontmatterScalar(fm, "status")
      if (status === "rejected") continue

      const titleMeta = parseProductModuleTitle(file.name.replace(/\.md$/, ""))
      const moduleName = frontmatterScalar(fm, "module_name") ?? titleMeta?.moduleName
      const fieldName = frontmatterScalar(fm, "field_name")
      const category = frontmatterScalar(fm, "insurance_category") ?? titleMeta?.category
      const product = frontmatterScalar(fm, "product_name") ?? titleMeta?.productName

      if (!INSURANCE_CATEGORIES.includes(category as InsuranceCategoryType)) continue
      if (!product) continue

      const relPath = file.path.includes(pp)
        ? file.path.slice(pp.length).replace(/^[/\\]/, "")
        : file.path

      if (domain === "product_catalog_field") {
        if (!fieldName) continue
        const fieldScope = frontmatterScalar(fm, "field_scope") ?? "产品字段"
        const fieldValue = parseFieldValue(content, fieldName)
        if (isMissingConceptFieldValue(fieldValue)) continue
        const valueSummary = summarizeFieldValue(fieldValue)

        const group = getProductConceptGroup(conceptMap, fieldName)
        const exists = group.fields.some(i => i.productName === product && i.fieldName === fieldName)
        if (!exists) {
          group.fields.push({
            insuranceCategory: category,
            productName: product,
            fieldName,
            fieldScope,
            valueSummary,
            fieldRelPath: relPath.replace(/\\/g, "/"),
          })
        }
        continue
      }

      if (!moduleName) continue
      if (!isModuleAllowedForCategory(category as InsuranceCategoryType, moduleName)) continue

      const group = getProductConceptGroup(conceptMap, moduleName)
      const exists = group.modules.some(i => i.productName === product && i.moduleName === moduleName)
      if (!exists) {
        group.modules.push({
          insuranceCategory: category,
          productName: product,
          moduleName,
          moduleRelPath: relPath.replace(/\\/g, "/"),
        })
      }
    } catch {
      // ignore
    }
  }

  return conceptMap
}

function buildProductConceptPage(
  conceptName: string,
  group: ProductConceptGroup,
): string {
  const today = new Date().toISOString().split("T")[0]
  const moduleInstances = [...group.modules].sort((a, b) =>
    a.insuranceCategory.localeCompare(b.insuranceCategory) || a.productName.localeCompare(b.productName)
  )
  const fieldInstances = [...group.fields].sort((a, b) =>
    a.insuranceCategory.localeCompare(b.insuranceCategory) || a.productName.localeCompare(b.productName)
  )
  const instanceCount = moduleInstances.length + fieldInstances.length
  const conceptRelativeLink = (wikiRelPath: string) =>
    `../${wikiRelPath.replace(/\\/g, "/").replace(/^wiki\//, "")}`

  const moduleRows = moduleInstances.map(inst => {
    const relLink = conceptRelativeLink(inst.moduleRelPath)
    return `| ${inst.insuranceCategory} | ${inst.productName} | ${inst.moduleName} | [查看详情](${relLink}) |`
  }).join("\n")

  const fieldRows = fieldInstances.map(inst => {
    const relLink = conceptRelativeLink(inst.fieldRelPath)
    return `| ${markdownTableCell(inst.insuranceCategory)} | ${markdownTableCell(inst.productName)} | ${markdownTableCell(inst.fieldScope)} | ${markdownTableCell(inst.valueSummary)} | [查看字段](${relLink}) |`
  }).join("\n")

  const relatedProducts = Array.from(new Set([
    ...moduleInstances.map(i => `"${i.insuranceCategory}-${i.productName}"`),
    ...fieldInstances.map(i => `"${i.insuranceCategory}-${i.productName}"`),
  ])).join(", ")

  const fieldSection = fieldInstances.length > 0
    ? `## 字段实体（${fieldInstances.length}个）

| 险种类别 | 产品名称 | 字段范围 | 字段值摘要 | 字段页 |
|---|---|---|---|---|
${fieldRows}`
    : `## 字段实体\n\n暂无字段页归属此概念。`

  const moduleSection = moduleInstances.length > 0
    ? `## 模块实体（${moduleInstances.length}个）

| 险种类别 | 产品名称 | 相关模块 | 详情链接 |
|---|---|---|---|
${moduleRows}`
    : `## 模块实体\n\n暂无模块页归属此概念。`

  return `---
type: concept
entity_type: insurance_concept
title: "${conceptName}"
knowledge_domain: product_catalog
tags: ["保险概念", "跨产品"]
instance_count: ${instanceCount}
field_instance_count: ${fieldInstances.length}
module_instance_count: ${moduleInstances.length}
related_products: [${relatedProducts}]
created: ${today}
updated: ${today}
---

# ${conceptName}

「${conceptName}」是保险产品中的通用概念，以下产品涉及此概念。点击详情可查看各产品的具体条款内容。

${fieldSection}

${moduleSection}

## 说明

- 此页面由系统自动生成，每次产品目录抽取完成后刷新。
- 字段实体来自 xlsx 字段页；模块实体来自条款模块页。
- 空值字段页不会进入概念页，避免污染检索。
`
}

/**
 * Build/refresh all insurance concept pages under wiki/concepts/.
 * Concepts are auto-generated from every unique module_name in product_catalog.
 */
export async function buildProductConceptIndex(projectPath: string): Promise<{
  created: number
  updated: number
  skipped: number
}> {
  const pp = normalizePath(projectPath)
  const conceptMap = await scanProductConcepts(projectPath)
  await createDirectory(`${pp}/wiki/concepts`).catch(() => {})

  let created = 0, updated = 0, skipped = 0

  for (const [conceptName, group] of conceptMap) {
    const conceptPath = `${pp}/wiki/concepts/${conceptName}.md`
    const newContent = buildProductConceptPage(conceptName, group)

    try {
      const existing = await readFile(conceptPath).catch(() => null)
      if (existing === null) {
        await writeFile(conceptPath, newContent)
        created++
      } else {
        if (existing !== newContent) {
          await writeFile(conceptPath, newContent)
          updated++
        } else {
          skipped++
        }
      }
    } catch {
      skipped++
    }
  }

  return { created, updated, skipped }
}


// ════════════════════════════════════════════════════════════════
// Combined entry point
// ════════════════════════════════════════════════════════════════

/**
 * Run all concept aggregation passes:
 * 1. Service item concepts (cross-version, in wiki/entities/)
 * 2. Insurance product concepts (cross-product, in wiki/product_catalog/)
 * 3. Back-fill entity related fields
 */
export async function runConceptAggregator(projectPath: string): Promise<{
  serviceConceptsCreated: number
  serviceConceptsUpdated: number
  productConceptsCreated: number
  productConceptsUpdated: number
  entitiesUpdated: number
}> {
  const [serviceResult, productResult, relatedResult] = await Promise.all([
    buildServiceConceptIndex(projectPath),
    buildProductConceptIndex(projectPath),
    backfillEntityRelated(projectPath),
  ])

  return {
    serviceConceptsCreated: serviceResult.created,
    serviceConceptsUpdated: serviceResult.updated,
    productConceptsCreated: productResult.created,
    productConceptsUpdated: productResult.updated,
    entitiesUpdated: relatedResult.updated,
  }
}
