import { readFile, writeFile } from "@/commands/fs"
import { embedPage } from "@/lib/embedding"
import { runConceptAggregator } from "@/lib/concept-aggregator"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { parseSources, writeSources } from "@/lib/sources-merge"
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

export interface ProductFieldDeleteSourceResult {
  isProductFieldPage: boolean
  clearedValue: boolean
  content: string
  touchedPaths: string[]
}

interface ProductFieldUpdateInput {
  fieldPath: string
  category: string
  productName: string
  fieldName: string
  value: string
  deferDerivedRefresh?: boolean
}

interface ProductFieldSyncOptions {
  deferDerivedRefresh?: boolean
  skipDerivedRefresh?: boolean
}

function frontmatterBlock(content: string): string | null {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null
}

function frontmatterScalar(fm: string | null, key: string): string | null {
  if (!fm) return null
  const match = fm.match(new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]*))\\s*$`, "m"))
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function frontmatterArray(content: string, key: string): string[] {
  const fm = frontmatterBlock(content)
  if (!fm) return []

  const multi = fm.match(new RegExp(`^${escapeRegExp(key)}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, "m"))
  if (multi) {
    return multi[1]
      .split(/\r?\n/)
      .map(line => line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)?.[1]?.trim() ?? "")
      .filter(Boolean)
  }

  const inline = fm.match(new RegExp(`^${escapeRegExp(key)}:\\s*\\[([^\\]]*)\\]`, "m"))
  if (!inline) return []
  const body = inline[1].trim()
  if (!body) return []
  return body
    .split(",")
    .map(item => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

function yamlInlineStringList(values: string[]): string {
  return `[${values.map(value => JSON.stringify(value)).join(", ")}]`
}

function writeFrontmatterArray(content: string, key: string, values: readonly string[]): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fmMatch) return content
  const [, open, body, close] = fmMatch
  const line = `${key}: ${yamlInlineStringList([...values])}`
  const inlineRegex = new RegExp(`^${escapeRegExp(key)}:\\s*\\[[^\\]]*\\]`, "m")
  if (inlineRegex.test(body)) {
    return `${open}${body.replace(inlineRegex, line)}${close}${content.slice(fmMatch[0].length)}`
  }
  const multiRegex = new RegExp(`^${escapeRegExp(key)}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, "m")
  if (multiRegex.test(body)) {
    return `${open}${body.replace(multiRegex, line)}${close}${content.slice(fmMatch[0].length)}`
  }
  return `${open}${body}\n${line}${close}${content.slice(fmMatch[0].length)}`
}

function writeFrontmatterScalar(content: string, key: string, value: string): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fmMatch) return content
  const [, open, body, close] = fmMatch
  const line = `${key}: ${value}`
  const regex = new RegExp(`^${escapeRegExp(key)}:\\s*[^\\n]*`, "m")
  if (regex.test(body)) {
    return `${open}${body.replace(regex, line)}${close}${content.slice(fmMatch[0].length)}`
  }
  return `${open}${body}\n${line}${close}${content.slice(fmMatch[0].length)}`
}

function removeSourceRefs(values: readonly string[], deletingRefs: readonly string[]): string[] {
  const deleting = new Set(deletingRefs.map(ref => ref.toLowerCase()))
  return values.filter(value => !deleting.has(value.toLowerCase()))
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

function splitConflictFieldName(fieldName: string): { baseFieldName: string; moduleFieldName: string } {
  const [base, ...rest] = fieldName.split(".").map(part => part.trim()).filter(Boolean)
  return {
    baseFieldName: base || fieldName.trim(),
    moduleFieldName: rest.join(".") || base || fieldName.trim(),
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(value => value?.trim()).filter(Boolean) as string[]))
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

function fieldPagePath(projectPath: string, category: string, productName: string, fieldName: string): string {
  return `${normalizePath(projectPath)}/wiki/product_catalog/${category}-${productName}-字段-${fieldName}.md`
}

function productFieldCandidatesForModule(baseFieldName: string, moduleFieldName: string): string[] {
  const mapped = baseFieldName === "身故保险金"
    ? ({
        "身故保险金": "保什么",
        "身故保险金给付条件": "保什么",
        "身故保险金给付金额": "保什么",
        "身故保险金给付对象": "保什么",
        "身故保险金责任免除": "特殊免责",
      } as Record<string, string | undefined>)[moduleFieldName]
    : undefined

  return uniqueStrings([baseFieldName, moduleFieldName, mapped])
}

function aggregateDeathCoverageValue(content: string, fallbackValue: string): string {
  const deathValue =
    parseFieldValue(content, "身故保险金") ||
    parseFieldValue(content, "身故保险金给付金额") ||
    parseFieldValue(content, "保什么") ||
    fallbackValue
  const disabilityValue = parseFieldValue(content, "全残保障") || parseFieldValue(content, "全残保险金")
  const accidentDeathValue = parseFieldValue(content, "意外身故")
  const diseaseDeathValue = parseFieldValue(content, "疾病身故")

  return uniqueStrings([
    deathValue ? `身故保险金：${deathValue}` : undefined,
    disabilityValue ? `全残保障：${disabilityValue}` : undefined,
    accidentDeathValue ? `意外身故：${accidentDeathValue}` : undefined,
    diseaseDeathValue ? `疾病身故：${diseaseDeathValue}` : undefined,
  ]).join("；") || fallbackValue
}

function aggregateModuleValue(content: string, baseFieldName: string, fallbackValue: string): string {
  if (baseFieldName === "投保年龄") {
    const min = parseFieldValue(content, "最低投保年龄")
    const max = parseFieldValue(content, "最高投保年龄")
    if (min && max) return `${min}至${max}`
    return min || max || fallbackValue
  }

  if (baseFieldName === "犹豫期") {
    const start = parseFieldValue(content, "起算时间")
    const days = parseFieldValue(content, "犹豫期天数")
    if (start && days) return `${start}${days}`
    return parseFieldValue(content, "犹豫期") || days || start || fallbackValue
  }

  return parseFieldValue(content, baseFieldName) || fallbackValue
}

function aggregateProductFieldValue(
  content: string,
  baseFieldName: string,
  moduleFieldName: string,
  productFieldName: string,
  fallbackValue: string,
): string {
  if (baseFieldName === productFieldName) {
    return aggregateModuleValue(content, baseFieldName, fallbackValue)
  }
  if (baseFieldName === "身故保险金" && productFieldName === "保什么") {
    return aggregateDeathCoverageValue(content, fallbackValue)
  }
  return parseFieldValue(content, productFieldName) || parseFieldValue(content, moduleFieldName) || fallbackValue
}

function isMissingFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /File does not exist|ENOENT|找不到/.test(message)
}

async function readFirstExistingProductFieldPage(
  projectPath: string,
  category: string,
  productName: string,
  candidates: string[],
): Promise<{ fieldName: string; path: string; content: string } | null> {
  for (const fieldName of candidates) {
    const path = fieldPagePath(projectPath, category, productName, fieldName)
    try {
      return { fieldName, path, content: await readFile(path) }
    } catch (err) {
      if (!isMissingFileError(err)) throw err
    }
  }
  return null
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
  options: ProductFieldSyncOptions = {},
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

  if (options.skipDerivedRefresh) {
    return { isProductFieldPage: true, content: nextFieldContent, touchedPaths }
  }

  if (options.deferDerivedRefresh) {
    void refreshConceptsAndEmbeddings(pp, info, [...touchedPaths]).catch((err) => {
      console.warn("[ProductCatalogSync] Deferred refresh failed:", err)
    })
  } else {
    await refreshConceptsAndEmbeddings(pp, info, touchedPaths)
  }
  return { isProductFieldPage: true, content: nextFieldContent, touchedPaths }
}

export async function applyProductFieldValueUpdate(
  projectPath: string,
  input: ProductFieldUpdateInput,
): Promise<ProductFieldSyncResult> {
  const pp = normalizePath(projectPath)
  const targetPath = normalizePath(input.fieldPath)
  const existing = await readFile(targetPath)
  const fieldPageInfo = parseProductFieldPageInfo(targetPath, existing)
  if (fieldPageInfo) {
    const nextContent = upsertProductFieldSearchSummary(
      replaceProductFieldRows(existing, fieldPageInfo.fieldName, input.value),
      {
        category: input.category,
        productName: input.productName,
        fieldName: fieldPageInfo.fieldName,
        value: input.value,
      },
    )
    await writeFile(targetPath, nextContent)

    return syncProductFieldPageAfterEdit(pp, targetPath, nextContent, {
      deferDerivedRefresh: input.deferDerivedRefresh,
    })
  }

  const { baseFieldName, moduleFieldName } = splitConflictFieldName(input.fieldName)
  const updatedModuleRows = replaceProductFieldRows(existing, moduleFieldName, input.value)
  const aggregateValue = aggregateModuleValue(updatedModuleRows, baseFieldName, input.value)
  const nextModuleContent = upsertProductFieldSearchSummary(updatedModuleRows, {
    category: input.category,
    productName: input.productName,
    fieldName: baseFieldName,
    value: aggregateValue,
  })
  await writeFile(targetPath, nextModuleContent)

  const canonicalField = await readFirstExistingProductFieldPage(
    pp,
    input.category,
    input.productName,
    productFieldCandidatesForModule(baseFieldName, moduleFieldName),
  )
  if (!canonicalField) {
    const touchedPaths = [targetPath]
    const refreshInfo = {
      category: input.category,
      productName: input.productName,
      fieldName: baseFieldName,
      value: aggregateValue,
    }
    if (input.deferDerivedRefresh) {
      void refreshConceptsAndEmbeddings(pp, refreshInfo, [...touchedPaths]).catch((err) => {
        console.warn("[ProductCatalogSync] Deferred refresh failed:", err)
      })
    } else {
      await refreshConceptsAndEmbeddings(pp, refreshInfo, touchedPaths)
    }
    return { isProductFieldPage: false, content: nextModuleContent, touchedPaths }
  }

  const canonicalValue = aggregateProductFieldValue(
    updatedModuleRows,
    baseFieldName,
    moduleFieldName,
    canonicalField.fieldName,
    input.value,
  )
  const nextFieldContent = upsertProductFieldSearchSummary(
    replaceProductFieldRows(canonicalField.content, canonicalField.fieldName, canonicalValue),
    {
      category: input.category,
      productName: input.productName,
      fieldName: canonicalField.fieldName,
      value: canonicalValue,
    },
  )
  await writeFile(canonicalField.path, nextFieldContent)

  const syncResult = await syncProductFieldPageAfterEdit(pp, canonicalField.path, nextFieldContent, {
    deferDerivedRefresh: input.deferDerivedRefresh,
  })
  return {
    ...syncResult,
    touchedPaths: Array.from(new Set([targetPath, ...syncResult.touchedPaths])),
  }
}

export async function clearProductFieldValueForDeletedSource(
  projectPath: string,
  fieldPath: string,
  deletingRefs: readonly string[],
  options: ProductFieldSyncOptions = {},
): Promise<ProductFieldDeleteSourceResult> {
  const pp = normalizePath(projectPath)
  const normalizedFieldPath = normalizePath(fieldPath)
  const existing = await readFile(normalizedFieldPath)
  const info = parseProductFieldPageInfo(normalizedFieldPath, existing)
  if (!info) {
    return { isProductFieldPage: false, clearedValue: false, content: existing, touchedPaths: [] }
  }

  const pageSources = parseSources(existing)
  const explicitValueSources = frontmatterArray(existing, "value_sources")
  const valueSources = explicitValueSources.length > 0 ? explicitValueSources : pageSources
  const remainingPageSources = removeSourceRefs(pageSources, deletingRefs)
  const remainingValueSources = removeSourceRefs(valueSources, deletingRefs)
  const valueWasBackedByDeletingSource = remainingValueSources.length !== valueSources.length

  let nextContent = pageSources.length > 0 ? writeSources(existing, remainingPageSources) : existing

  if (!valueWasBackedByDeletingSource) {
    if (nextContent !== existing) await writeFile(normalizedFieldPath, nextContent)
    return {
      isProductFieldPage: true,
      clearedValue: false,
      content: nextContent,
      touchedPaths: nextContent !== existing ? [normalizedFieldPath] : [],
    }
  }

  if (remainingValueSources.length > 0) {
    nextContent = writeFrontmatterArray(nextContent, "value_sources", remainingValueSources)
    if (nextContent !== existing) await writeFile(normalizedFieldPath, nextContent)
    return {
      isProductFieldPage: true,
      clearedValue: false,
      content: nextContent,
      touchedPaths: nextContent !== existing ? [normalizedFieldPath] : [],
    }
  }

  nextContent = replaceProductFieldRows(nextContent, info.fieldName, "")
  nextContent = writeFrontmatterArray(nextContent, "value_sources", [])
  nextContent = writeFrontmatterScalar(nextContent, "status", "rejected")
  nextContent = writeFrontmatterScalar(nextContent, "extraction_state", "needs_refinement")
  nextContent = writeFrontmatterScalar(nextContent, "value_source", "missing")

  const syncResult = await syncProductFieldPageAfterEdit(pp, normalizedFieldPath, nextContent, options)
  return {
    isProductFieldPage: true,
    clearedValue: true,
    content: syncResult.content,
    touchedPaths: syncResult.touchedPaths,
  }
}

export function isProductCatalogFieldPath(projectPath: string, path: string): boolean {
  const rel = relativeToProject(projectPath, path)
  return rel.startsWith("wiki/product_catalog/") && rel.includes("-字段-") && rel.endsWith(".md")
}
