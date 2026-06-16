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

/**
 * Scan wiki/product_catalog/ for ALL module files and build
 * a map of moduleName → list of products with that module.
 *
 * Every module_name becomes a concept. No filtering or manual mapping.
 */
async function scanProductConcepts(
  projectPath: string,
): Promise<Map<string, ProductConceptInstance[]>> {
  const pp = normalizePath(projectPath)
  const conceptMap = new Map<string, ProductConceptInstance[]>()

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
      const moduleNameMatch = fm.match(/^module_name:\s*["']?([^"'\n]+?)["']?\s*$/m)
      const categoryMatch = fm.match(/^insurance_category:\s*["']?([^"'\n]+?)["']?\s*$/m)
      const productMatch = fm.match(/^product_name:\s*["']?([^"'\n]+?)["']?\s*$/m)

      if (!moduleNameMatch || !categoryMatch || !productMatch) continue

      const moduleName = moduleNameMatch[1].trim()
      const category = categoryMatch[1].trim()
      const product = productMatch[1].trim()

      const relPath = file.path.includes(pp)
        ? file.path.slice(pp.length).replace(/^[/\\]/, "")
        : file.path

      // Auto-create concept entry for this module name
      if (!conceptMap.has(moduleName)) {
        conceptMap.set(moduleName, [])
      }

      const instances = conceptMap.get(moduleName)!
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
    } catch {
      // ignore
    }
  }

  return conceptMap
}

function buildProductConceptPage(
  conceptName: string,
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
tags: ["保险概念", "跨产品"]
instance_count: ${instances.length}
related_products: [${relatedProducts}]
created: ${today}
updated: ${today}
---

# ${conceptName}

「${conceptName}」是保险产品中的通用概念，以下产品涉及此概念。点击详情可查看各产品的具体条款内容。

${productSection}

## 说明

- 此页面由系统自动生成，每次产品目录抽取完成后刷新。
- 点击"查看详情"可查看各产品对此概念的具体条款内容。
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

  for (const [conceptName, instances] of conceptMap) {
    const conceptPath = `${pp}/wiki/concepts/${conceptName}.md`
    const newContent = buildProductConceptPage(conceptName, instances)

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
