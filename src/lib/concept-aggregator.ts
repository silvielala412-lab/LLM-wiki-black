/**
 * concept-aggregator.ts
 *
 * Post-processing step: scan all service_item entities, group by item concept name
 * (stripping the {line}-{version}- prefix from the title), and generate/update
 * `wiki/concepts/{itemName}.md` concept pages that aggregate all cross-version instances.
 *
 * This implements Q3 (cross-version relationships) and Q4 (common concept page)
 * from the user's requirements.
 */

import { readFile, writeFile, listDirectory, createDirectory } from "@/commands/fs"
import { parseServiceItemTitle } from "@/lib/insurance-schema-registry"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

interface ConceptInstance {
  lineName: string
  versionName: string
  entityRelPath: string  // relative to projectPath, e.g. wiki/entities/安有医/颐享版/xxx.md
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

/**
 * Scan all service_item entities and return a map of
 * itemName → list of instances (lineName, versionName, path).
 */
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
      // Skip version-summary pages (e.g. "安有医-颐享版" has only 2 parts)
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
      // ignore unreadable files
    }
  }
  return conceptMap
}

/**
 * Generate the markdown content for a concept page.
 */
function buildConceptPageContent(itemName: string, instances: ConceptInstance[]): string {
  // Sort: by lineName then versionName
  const sorted = [...instances].sort((a, b) =>
    a.lineName.localeCompare(b.lineName) || a.versionName.localeCompare(b.versionName)
  )

  const today = new Date().toISOString().split("T")[0]
  const tableRows = sorted.map(inst => {
    // Relative link from wiki/concepts/ to wiki/entities/...
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

/**
 * Main entry point: build/refresh all service item concept pages.
 *
 * Call this after a batch ingestion completes.
 */
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
    // Only create concept page if there are 2+ instances across different line/version combos
    if (instances.length < 2) { skipped++; continue }

    const conceptPath = `${pp}/wiki/concepts/${itemName}.md`
    const newContent = buildConceptPageContent(itemName, instances)

    try {
      const existing = await readFile(conceptPath).catch(() => null)
      if (existing === null) {
        await writeFile(conceptPath, newContent)
        created++
      } else {
        // Update if instance count changed or any instance changed
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
      // Write failed — skip
      skipped++
    }
  }

  return { created, updated, skipped }
}

/**
 * Back-fill the `related: [...]` frontmatter field of every service_item entity
 * with its cross-version siblings.
 *
 * For entity "安有医_惠享版_重疾定义说明", siblings are all other instances of
 * the same concept name ("安有医_颐享版_重疾定义说明", etc.).
 *
 * This is a rule-based serial pass — no LLM required.
 */
export async function backfillEntityRelated(projectPath: string): Promise<{
  updated: number
  skipped: number
}> {
  const pp = normalizePath(projectPath)
  const conceptMap = await scanServiceItemConcepts(projectPath)

  let updated = 0
  let skipped = 0

  for (const [, instances] of conceptMap) {
    if (instances.length < 2) continue

    const allTitles = instances.map(i => i.title)

    for (const inst of instances) {
      const siblings = allTitles.filter(t => t !== inst.title)
      if (siblings.length === 0) { skipped++; continue }

      const fullPath = `${pp}/${inst.entityRelPath}`
      try {
        const content = await readFile(fullPath)

        // Build new related array (merge existing + siblings, deduplicate)
        const existingMatch = content.match(/^related:\s*\[([^\]]*)\]/m)
        const existing: string[] = existingMatch
          ? existingMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
          : []
        const merged = Array.from(new Set([...existing, ...siblings]))
        const newRelatedLine = `related: [${merged.map(t => `"${t}"`).join(", ")}]`

        // Replace related line
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

/**
 * Combined concept aggregation pass:
 * 1. Build/update concept pages in wiki/concepts/
 * 2. Back-fill each entity's `related` field with cross-version siblings
 *
 * Call this after a batch ingestion completes (onQueueDrained).
 * No LLM required — purely rule-based title matching.
 */
export async function runConceptAggregator(projectPath: string): Promise<{
  conceptsCreated: number
  conceptsUpdated: number
  entitiesUpdated: number
}> {
  const [conceptResult, relatedResult] = await Promise.all([
    buildServiceConceptIndex(projectPath),
    backfillEntityRelated(projectPath),
  ])
  return {
    conceptsCreated: conceptResult.created,
    conceptsUpdated: conceptResult.updated,
    entitiesUpdated: relatedResult.updated,
  }
}
