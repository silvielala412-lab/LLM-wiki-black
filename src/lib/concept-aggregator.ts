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
// ════════════════════════════════════════════════════════════════

/**
 * Predefined concept → module name mapping.
 * When a product module file matches one of these module names,
 * it gets linked from the corresponding concept page.
 */
const INSURANCE_CONCEPT_MAP: Record<string, {
  description: string
  tags: string[]
  relatedModuleNames: string[]
}> = {
  "保证续保": {
    description: "保证续保是指保险公司承诺在约定期限内，不得因被保险人健康状况变化、理赔记录等原因拒绝续保。是医疗险、重疾险等产品的核心保障属性之一。",
    tags: ["续保保障", "医疗险", "长期保障"],
    relatedModuleNames: ["6年保证续保", "保证续保"],
  },
  "百万医疗": {
    description: "百万医疗险是指保额达百万级别（通常100万-600万元）的医疗费用报销型保险，涵盖住院医疗、手术、特殊门诊等费用，是市场上主流高保额医疗险产品类型。",
    tags: ["医疗险", "大额保障", "住院报销"],
    relatedModuleNames: ["一般住院医疗", "年度免赔额"],
  },
  "重大疾病": {
    description: "重大疾病指国家和行业标准定义的、需要花费较高医疗费用或对生活质量有重大影响的疾病，如恶性肿瘤、急性心肌梗死、脑卒中后遗症等。",
    tags: ["重疾险", "医疗险", "疾病定义"],
    relatedModuleNames: ["重大疾病医疗", "重大疾病释义"],
  },
  "免赔额": {
    description: "免赔额是指保险事故发生后，由被保险人自行承担、保险公司不予赔付的费用额度。分为绝对免赔额（需全额扣除）和相对免赔额（超过后全额赔付）。",
    tags: ["费用规则", "医疗险", "赔付计算"],
    relatedModuleNames: ["年度免赔额"],
  },
  "健康告知": {
    description: "健康告知是投保人在投保时需如实告知保险公司被保险人健康状况的问卷，是核保的重要依据。如实告知是法定义务，隐瞒可能导致拒赔或解除合同。",
    tags: ["核保", "健康状况", "如实告知"],
    relatedModuleNames: ["专属健康告知"],
  },
  "等待期": {
    description: "等待期（又称观察期）是指保险合同生效后，在一定期限内被保险人发生的疾病保险公司不予赔付的时段。意外伤害通常无等待期。",
    tags: ["时间约束", "核保规则", "疾病保障"],
    relatedModuleNames: ["疾病等待期"],
  },
  "犹豫期": {
    description: "犹豫期是指投保人在收到保险合同后的一定期限内（通常10-20天），可以无条件退保并获得全额退款的权利期间。",
    tags: ["合同权利", "退保", "消费者保护"],
    relatedModuleNames: ["犹豫期"],
  },
  "就医绿通": {
    description: "就医绿通是保险公司提供的增值服务，帮助被保险人快速预约专家门诊、优先安排住院床位、提供第二医疗意见等，提升就医效率。",
    tags: ["增值服务", "医疗资源", "健康管理"],
    relatedModuleNames: ["重疾就医绿通"],
  },
  "住院垫付": {
    description: "住院垫付（预赔付）是保险公司在被保险人住院期间先行垫付医疗费用的服务，无需被保险人自行垫资，出院后再进行结算。",
    tags: ["增值服务", "资金便利", "医疗险"],
    relatedModuleNames: ["住院垫付"],
  },
  "责任免除": {
    description: "责任免除条款规定了保险公司不承担赔付责任的情形，包括通用免责（自杀、战争、违法行为等）和特定产品的专属免责条款。",
    tags: ["免责条款", "理赔限制", "合同约定"],
    relatedModuleNames: ["通用责任免除", "既往症免责"],
  },
  "保单复效": {
    description: "保单复效是指因欠缴保费等原因导致保险合同中止后，在规定期限内（通常2年），通过补缴保费、完成核保等方式恢复合同效力的程序。",
    tags: ["合同管理", "保单权益", "续期管理"],
    relatedModuleNames: ["保单复效"],
  },
  "费率表": {
    description: "费率表是保险公司按被保险人年龄、性别、投保计划等维度列出的保险费率（保费计算依据）一览表，是产品定价的核心参考文件。",
    tags: ["保费计算", "定价", "投保参考"],
    relatedModuleNames: ["分年龄保费费率表", "有社保费率", "无社保费率上浮"],
  },
  "疾病释义": {
    description: "疾病释义是保险条款中对保障范围内疾病的具体定义和诊断标准，包括重大疾病、中症疾病、轻度疾病的种类列表和认定条件。",
    tags: ["疾病定义", "重疾险", "赔付依据"],
    relatedModuleNames: ["重大疾病释义", "中症疾病释义", "轻度疾病释义"],
  },
}

interface ProductConceptInstance {
  insuranceCategory: string
  productName: string
  moduleName: string
  moduleRelPath: string   // relative to projectPath
}

/**
 * Scan wiki/product_catalog/ for module files and build
 * a map of conceptName → list of products with that concept.
 */
async function scanProductConcepts(
  projectPath: string,
): Promise<Map<string, ProductConceptInstance[]>> {
  const pp = normalizePath(projectPath)
  const conceptMap = new Map<string, ProductConceptInstance[]>()

  // Initialize all concepts
  for (const conceptName of Object.keys(INSURANCE_CONCEPT_MAP)) {
    conceptMap.set(conceptName, [])
  }

  let catalogFiles: FileNode[] = []
  try {
    const tree = await listDirectory(`${pp}/wiki/product_catalog`)
    catalogFiles = flattenMdFiles(tree)
  } catch {
    return conceptMap
  }

  // Build reverse lookup: moduleName → conceptNames
  const moduleToConceptNames = new Map<string, string[]>()
  for (const [conceptName, def] of Object.entries(INSURANCE_CONCEPT_MAP)) {
    for (const moduleName of def.relatedModuleNames) {
      const existing = moduleToConceptNames.get(moduleName) ?? []
      existing.push(conceptName)
      moduleToConceptNames.set(moduleName, existing)
    }
  }

  for (const file of catalogFiles) {
    try {
      const content = await readFile(file.path)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue

      const fm = fmMatch[1]
      const moduleNameMatch = fm.match(/^module_name:\s*["']?([^"'\n]+?)["']?\s*$/m)
      const categoryMatch = fm.match(/^insurance_category:\s*["']?([^"'\n]+?)["']?\s*$/m)
      const productMatch = fm.match(/^product_name:\s*["']?([^"'\n]+?)["']?\s*$/m)

      if (!moduleNameMatch || !categoryMatch || !productMatch) continue

      const moduleName = moduleNameMatch[1].trim()
      const category = categoryMatch[1].trim()
      const product = productMatch[1].trim()

      const conceptNames = moduleToConceptNames.get(moduleName)
      if (!conceptNames) continue

      const relPath = file.path.includes(pp)
        ? file.path.slice(pp.length).replace(/^[/\\]/, "")
        : file.path

      for (const conceptName of conceptNames) {
        const instances = conceptMap.get(conceptName)!
        // Dedup by product + module
        const exists = instances.some(i => i.productName === product && i.moduleName === moduleName)
        if (!exists) {
          instances.push({
            insuranceCategory: category,
            productName: product,
            moduleName,
            moduleRelPath: relPath.replace(/\\/g, "/"),
          })
        }
      }
    } catch {
      // ignore
    }
  }

  return conceptMap
}

function buildProductConceptPage(
  conceptName: string,
  def: typeof INSURANCE_CONCEPT_MAP[string],
  instances: ProductConceptInstance[],
): string {
  const today = new Date().toISOString().split("T")[0]
  const sorted = [...instances].sort((a, b) =>
    a.insuranceCategory.localeCompare(b.insuranceCategory) || a.productName.localeCompare(b.productName)
  )

  const tableRows = sorted.map(inst => {
    const relLink = `../${inst.moduleRelPath}`
    return `| ${inst.insuranceCategory} | ${inst.productName} | ${inst.moduleName} | [查看详情](${relLink}) |`
  }).join("\n")

  const relatedProducts = sorted.map(i => `"${i.insuranceCategory}-${i.productName}"`).join(", ")

  const productSection = instances.length > 0
    ? `## 涉及产品（${instances.length}个）

| 险种类别 | 产品名称 | 相关模块 | 详情链接 |
|---|---|---|---|
${tableRows}`
    : `## 涉及产品\n\n暂无产品归属此概念。`

  return `---
type: concept
entity_type: insurance_concept
title: "${conceptName}"
knowledge_domain: product_catalog
tags: [${def.tags.map(t => `"${t}"`).join(", ")}]
instance_count: ${instances.length}
related_products: [${relatedProducts}]
created: ${today}
updated: ${today}
---

# ${conceptName}

${def.description}

${productSection}

## 说明

- 此页面由系统自动生成，每次产品目录抽取完成后刷新。
- 点击"查看详情"可查看各产品对此概念的具体条款内容。
`
}

/**
 * Build/refresh all insurance concept pages under wiki/concepts/.
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

  for (const [conceptName, instances] of conceptMap) {
    const def = INSURANCE_CONCEPT_MAP[conceptName]
    if (!def) continue

    const conceptPath = `${pp}/wiki/concepts/${conceptName}.md`
    const newContent = buildProductConceptPage(conceptName, def, instances)

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
