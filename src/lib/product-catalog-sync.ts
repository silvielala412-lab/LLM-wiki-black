import { readFile, writeFile } from "@/commands/fs"
import { embedPage } from "@/lib/embedding"
import { runConceptAggregator } from "@/lib/concept-aggregator"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

export interface ProductFieldPageInfo {
  category: string
  productName: string
  fieldName: string
  value: string
}

export interface ProductFieldSyncResult {
  isProductFieldPage: boolean
  content: string
  touchedPaths: string[]
}

interface ProductFieldUpdateInput {
  fieldPath: string
  category: string
  productName: string
  fieldName: string
  value: string
}

function frontmatterBlock(content: string): string | null {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null
}

function frontmatterScalar(fm: string | null, key: string): string | null {
  if (!fm) return null
  const match = fm.match(new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]*))\\s*$`, "m"))
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null
}

function parseInfoFromFileName(filePath: string): Omit<ProductFieldPageInfo, "value"> | null {
  const stem = getFileName(filePath).replace(/\.md$/i, "")
  const marker = "-字段-"
  const markerIndex = stem.lastIndexOf(marker)
  if (markerIndex < 0) return null

  const productKey = stem.slice(0, markerIndex)
  const firstDash = productKey.indexOf("-")
  if (firstDash <= 0) return null

  return {
    category: productKey.slice(0, firstDash),
    productName: productKey.slice(firstDash + 1),
    fieldName: stem.slice(markerIndex + marker.length),
  }
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

function markdownTableCell(value: string): string {
  return value.replace(/\n/g, "<br>").replace(/\|/g, "\\|")
}

function markdownTableRow(cells: string[]): string {
  return `| ${cells.map(markdownTableCell).join(" | ")} |`
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

function replaceProductFieldRows(content: string, fieldName: string, value: string): string {
  const lines = content.split(/\r?\n/)
  let changed = false
  const next = lines.map((line) => {
    const cells = splitMarkdownTableRow(line)
    if (!cells || cells.length < 2) return line
    if (cells[0] === fieldName) {
      changed = true
      return markdownTableRow([cells[0], value, ...cells.slice(2)])
    }
    if (cells.length >= 3 && cells[1] === fieldName) {
      changed = true
      return markdownTableRow([cells[0], cells[1], value, ...cells.slice(3)])
    }
    return line
  })
  return changed ? next.join("\n") : content
}

function buildSearchSummary(info: ProductFieldPageInfo): string {
  const value = info.value.replace(/\s+/g, " ").trim()
  return value
    ? `${info.productName} 的${info.fieldName}为：${value}`
    : `${info.productName} 的${info.fieldName}尚未抽取到明确值。`
}

function upsertProductFieldSearchSummary(content: string, info: ProductFieldPageInfo): string {
  const section = `## 检索摘要\n\n${buildSearchSummary(info)}`
  if (/^##\s+检索摘要\s*$/m.test(content)) {
    return content.replace(/^##\s+检索摘要\s*\r?\n[\s\S]*?(?=\r?\n##\s+|\s*$)/m, section)
  }
  return `${content.trimEnd()}\n\n${section}\n`
}

function parseProductFieldPageInfo(filePath: string, content: string): ProductFieldPageInfo | null {
  const fm = frontmatterBlock(content)
  const filenameInfo = parseInfoFromFileName(filePath)
  const domain = frontmatterScalar(fm, "knowledge_domain")

  if (domain && domain !== "product_catalog_field") return null
  if (!domain && !filenameInfo) return null

  const category = frontmatterScalar(fm, "insurance_category") ?? filenameInfo?.category ?? ""
  const productName = frontmatterScalar(fm, "product_name") ?? filenameInfo?.productName ?? ""
  const fieldName = frontmatterScalar(fm, "field_name") ?? filenameInfo?.fieldName ?? ""
  if (!category || !productName || !fieldName) return null

  return {
    category,
    productName,
    fieldName,
    value: parseFieldValue(content, fieldName),
  }
}

function relativeToProject(projectPath: string, fullPath: string): string {
  const pp = normalizePath(projectPath).replace(/\/$/, "")
  const normalized = normalizePath(fullPath)
  return normalized.startsWith(`${pp}/`) ? normalized.slice(pp.length + 1) : normalized
}

function titleFromMarkdown(content: string, fallback: string): string {
  const fm = frontmatterBlock(content)
  return (
    frontmatterScalar(fm, "title") ??
    content.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    fallback
  )
}

async function reembedChangedPages(projectPath: string, paths: string[]): Promise<void> {
  const cfg = useWikiStore.getState().embeddingConfig
  if (!cfg.enabled || !cfg.model) return

  const pp = normalizePath(projectPath)
  const uniquePaths = Array.from(new Set(paths.map(normalizePath)))
  for (const path of uniquePaths) {
    try {
      const content = await readFile(path)
      const pageId = getFileName(path).replace(/\.md$/i, "")
      await embedPage(pp, pageId, titleFromMarkdown(content, pageId), content, cfg)
    } catch (err) {
      console.warn("[ProductCatalogSync] Failed to re-embed changed page:", path, err)
    }
  }
}

async function refreshConceptsAndEmbeddings(
  projectPath: string,
  info: ProductFieldPageInfo,
  touchedPaths: string[],
): Promise<void> {
  const pp = normalizePath(projectPath)
  try {
    await runConceptAggregator(pp)
    touchedPaths.push(`${pp}/wiki/concepts/${info.fieldName}.md`)
  } catch (err) {
    console.warn("[ProductCatalogSync] Failed to refresh product concepts:", err)
  }

  await reembedChangedPages(pp, touchedPaths)
}

export async function syncProductFieldPageAfterEdit(
  projectPath: string,
  fieldPath: string,
  content: string,
): Promise<ProductFieldSyncResult> {
  const pp = normalizePath(projectPath)
  const normalizedFieldPath = normalizePath(fieldPath)
  const info = parseProductFieldPageInfo(normalizedFieldPath, content)
  if (!info) {
    return { isProductFieldPage: false, content, touchedPaths: [] }
  }

  const touchedPaths: string[] = []
  const nextFieldContent = upsertProductFieldSearchSummary(content, info)
  if (nextFieldContent !== content) {
    await writeFile(normalizedFieldPath, nextFieldContent)
    touchedPaths.push(normalizedFieldPath)
  } else {
    touchedPaths.push(normalizedFieldPath)
  }

  const mainPath = `${pp}/wiki/product_catalog/${info.category}-${info.productName}.md`
  try {
    const mainContent = await readFile(mainPath)
    const nextMain = replaceProductFieldRows(mainContent, info.fieldName, info.value)
    if (nextMain !== mainContent) {
      await writeFile(mainPath, nextMain)
      touchedPaths.push(mainPath)
    }
  } catch {
    // The field page is still valid even if the product summary page is absent.
  }

  await refreshConceptsAndEmbeddings(pp, info, touchedPaths)
  return { isProductFieldPage: true, content: nextFieldContent, touchedPaths }
}

export async function applyProductFieldValueUpdate(
  projectPath: string,
  input: ProductFieldUpdateInput,
): Promise<ProductFieldSyncResult> {
  const pp = normalizePath(projectPath)
  const fieldPath = normalizePath(input.fieldPath)
  const existing = await readFile(fieldPath)
  const nextContent = upsertProductFieldSearchSummary(
    replaceProductFieldRows(existing, input.fieldName, input.value),
    {
      category: input.category,
      productName: input.productName,
      fieldName: input.fieldName,
      value: input.value,
    },
  )
  await writeFile(fieldPath, nextContent)

  return syncProductFieldPageAfterEdit(pp, fieldPath, nextContent)
}

export function isProductCatalogFieldPath(projectPath: string, path: string): boolean {
  const rel = relativeToProject(projectPath, path)
  return rel.startsWith("wiki/product_catalog/") && rel.includes("-字段-") && rel.endsWith(".md")
}
