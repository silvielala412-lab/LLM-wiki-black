import { listDirectory, readFile, writeFile } from "@/commands/fs"

export interface ServiceInventoryRow {
  serviceScene: string
  serviceStage: string
  serviceName: string
  serviceFrequency: string
  sourceFile: string
}

interface SourceFacts {
  rows: ServiceInventoryRow[]
  coverageByService: Map<string, string>
  serviceProvider: string
  relatedProduct: string
}

interface DirEntry {
  name: string
  is_dir?: boolean
}

const AUTO_SECTION_MARKER = "<!-- service-benefit-enrichment -->"

export async function enrichServiceBenefitPagesFromSources(projectPath: string): Promise<string[]> {
  const facts = await collectSourceFacts(projectPath)
  if (facts.rows.length === 0) return []
  return enrichServiceBenefitPages(projectPath, facts)
}

export async function enrichServiceBenefitPagesFromText(
  projectPath: string,
  sourceContent: string,
  sourceFileName: string,
): Promise<string[]> {
  const facts = await collectSourceFacts(projectPath)
  const directRows = parseServiceInventoryRows(sourceContent, sourceFileName)
  const directCoverage = parseCoverageTable(sourceContent)
  for (const [service, coverage] of directCoverage) facts.coverageByService.set(normalizeServiceName(service), coverage)
  const directProvider = stringValue(parseAttributes(sourceContent).service_provider)
  facts.rows = dedupeRows([...directRows, ...facts.rows])
  if (directProvider) facts.serviceProvider = directProvider
  if (!facts.relatedProduct) facts.relatedProduct = scalar(sourceContent, "title") || "臻享家医健康服务计划"
  return enrichServiceBenefitPages(projectPath, facts)
}

export function parseServiceInventoryRows(content: string, sourceFile = "source"): ServiceInventoryRow[] {
  return dedupeRows([
    ...parseMarkdownServiceTable(content, sourceFile),
    ...parseSequentialOcrServiceTable(content, sourceFile),
  ])
}

async function collectSourceFacts(projectPath: string): Promise<SourceFacts> {
  const rows: ServiceInventoryRow[] = []
  const coverageByService = new Map<string, string>()
  let serviceProvider = ""
  let relatedProduct = ""

  const sourceFiles = await safeList(`${projectPath}/wiki/sources`)
  for (const file of sourceFiles) {
    if (file.is_dir || !file.name.endsWith(".md")) continue
    const content = await readFile(`${projectPath}/wiki/sources/${file.name}`).catch(() => "")
    if (!content) continue
    const attrs = parseAttributes(content)
    if (!serviceProvider) serviceProvider = stringValue(attrs.service_provider)
    if (!relatedProduct) relatedProduct = scalar(content, "title") || file.name.replace(/\.md$/i, "")
    rows.push(...parseMarkdownServiceTable(content, file.name))
    rows.push(...parseSequentialOcrServiceTable(content, file.name))
    for (const [service, coverage] of parseCoverageTable(content)) {
      coverageByService.set(normalizeServiceName(service), coverage)
    }
  }

  return {
    rows: dedupeRows(rows),
    coverageByService,
    serviceProvider,
    relatedProduct,
  }
}

async function enrichServiceBenefitPages(projectPath: string, facts: SourceFacts): Promise<string[]> {
  const updatedPaths: string[] = []
  const entityFiles = await safeList(`${projectPath}/wiki/entities`)
  for (const file of entityFiles) {
    if (file.is_dir || !file.name.endsWith(".md")) continue
    const relPath = `wiki/entities/${file.name}`
    const fullPath = `${projectPath}/${relPath}`
    const content = await readFile(fullPath).catch(() => "")
    if (!content || scalar(content, "entity_type") !== "service_benefit") continue

    const title = scalar(content, "title") || file.name.replace(/\.md$/i, "")
    const attrs = parseAttributes(content)
    const serviceName = stringValue(attrs.service_name) || title
    const row = findServiceRow(facts.rows, serviceName, title)
    if (!row) continue

    const enriched = enrichServicePage(content, row, facts)
    if (enriched !== content) {
      await writeFile(fullPath, enriched)
      updatedPaths.push(relPath)
    }
  }
  return updatedPaths
}

function parseMarkdownServiceTable(content: string, sourceFile: string): ServiceInventoryRow[] {
  const lines = content.split(/\r?\n/)
  const rows: ServiceInventoryRow[] = []
  let header: string[] | null = null
  let sceneIndex = -1
  let stageIndex = -1
  let itemIndex = -1
  let countIndex = -1

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.includes("|")) {
      header = null
      continue
    }
    const cells = parseCells(line)
    if (cells.length < 4 || isSeparator(cells)) continue
    const possibleItem = findHeader(cells, ["服务项目", "权益项目", "项目"])
    const possibleCount = findHeader(cells, ["服务次数", "次数", "频次"])
    if (possibleItem >= 0 && possibleCount >= 0) {
      header = cells
      sceneIndex = findHeader(header, ["服务场景", "场景"])
      stageIndex = findHeader(header, ["服务阶段", "阶段"])
      itemIndex = possibleItem
      countIndex = possibleCount
      continue
    }
    if (!header || itemIndex < 0 || countIndex < 0 || cells.length <= Math.max(itemIndex, countIndex)) continue
    const serviceName = clean(cells[itemIndex])
    const serviceFrequency = clean(cells[countIndex])
    if (!isServiceItem(serviceName) || !serviceFrequency) continue
    rows.push({
      serviceScene: sceneIndex >= 0 ? clean(cells[sceneIndex] ?? "") : "",
      serviceStage: stageIndex >= 0 ? clean(cells[stageIndex] ?? "") : "",
      serviceName,
      serviceFrequency,
      sourceFile,
    })
  }
  return rows
}

function parseSequentialOcrServiceTable(content: string, sourceFile: string): ServiceInventoryRow[] {
  const lines = content.split(/\r?\n/).map(clean).filter(Boolean)
  const rows: ServiceInventoryRow[] = []
  for (let i = 0; i < lines.length - 7; i++) {
    if (lines[i] !== "服务场景" || lines[i + 1] !== "服务阶段" || lines[i + 2] !== "服务项目" || lines[i + 3] !== "服务次数") continue
    for (let j = i + 4; j + 3 < lines.length; j += 4) {
      const serviceScene = lines[j]
      const serviceStage = lines[j + 1]
      const serviceName = lines[j + 2]
      const serviceFrequency = lines[j + 3]
      if (!isServiceItem(serviceName) || !looksLikeFrequency(serviceFrequency)) break
      rows.push({ serviceScene, serviceStage, serviceName, serviceFrequency, sourceFile })
    }
  }
  return rows
}

function parseCoverageTable(content: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = content.split(/\r?\n/)
  let inCoverageTable = false
  let serviceIndex = -1
  let coverageIndex = -1

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.includes("|")) {
      inCoverageTable = false
      continue
    }
    const cells = parseCells(line)
    if (cells.length < 2 || isSeparator(cells)) continue
    const possibleService = findHeader(cells, ["服务项目", "项目"])
    const possibleCoverage = findHeader(cells, ["覆盖范围", "范围"])
    if (possibleService >= 0 && possibleCoverage >= 0) {
      inCoverageTable = true
      serviceIndex = possibleService
      coverageIndex = possibleCoverage
      continue
    }
    if (!inCoverageTable || cells.length <= Math.max(serviceIndex, coverageIndex)) continue
    const service = clean(cells[serviceIndex])
    const coverage = clean(cells[coverageIndex])
    if (service && coverage) result.set(service, coverage)
  }
  return result
}

function enrichServicePage(content: string, row: ServiceInventoryRow, facts: SourceFacts): string {
  const attrs = parseAttributes(content)
  attrs.service_name = stringValue(attrs.service_name) || row.serviceName
  attrs.related_product = stringValue(attrs.related_product) || facts.relatedProduct || "臻享家医健康服务计划"
  attrs.service_category = stringValue(attrs.service_category) || [row.serviceScene, row.serviceStage].filter(Boolean).join("/")
  attrs.service_frequency = row.serviceFrequency
  if (facts.serviceProvider && !stringValue(attrs.service_provider)) attrs.service_provider = facts.serviceProvider
  const coverage = findCoverage(facts.coverageByService, row.serviceName)
  if (coverage && !stringValue(attrs.coverage_scope)) attrs.coverage_scope = coverage
  attrs.knowledge_gaps = filterResolvedGaps(attrs.knowledge_gaps, [
    "service_frequency",
    "服务次数",
    "服务次数限制",
    "service_provider",
    "服务提供商",
    "覆盖范围",
    "coverage_scope",
  ])

  let next = replaceAttributes(content, attrs)
  next = replaceScalar(next, "needs_review", Array.isArray(attrs.knowledge_gaps) && attrs.knowledge_gaps.length === 0 ? "false" : "true")
  next = replaceScalar(next, "updated", new Date().toISOString().slice(0, 10))
  next = upsertAutoSection(next, row, facts, coverage)
  return next
}

function upsertAutoSection(content: string, row: ServiceInventoryRow, facts: SourceFacts, coverage = ""): string {
  const section = [
    AUTO_SECTION_MARKER,
    "## 服务手册确定信息",
    "",
    "| 字段 | 已抽取事实 |",
    "|---|---|",
    `| 服务场景 | ${escapeTable(row.serviceScene || "未提供")} |`,
    `| 服务阶段 | ${escapeTable(row.serviceStage || "未提供")} |`,
    `| 服务项目 | ${escapeTable(row.serviceName)} |`,
    `| 服务次数 | ${escapeTable(row.serviceFrequency)} |`,
    facts.serviceProvider ? `| 服务提供方 | ${escapeTable(facts.serviceProvider)} |` : "",
    coverage ? `| 覆盖范围 | ${escapeTable(coverage)} |` : "",
    "",
    `来源依据：[[${row.sourceFile.replace(/\.md$/i, "")}]] 服务项目清单。`,
    "",
  ].filter(Boolean).join("\n")

  const existing = content.indexOf(AUTO_SECTION_MARKER)
  if (existing >= 0) {
    const before = content.slice(0, existing).trimEnd()
    const afterStart = content.indexOf("\n## ", existing + AUTO_SECTION_MARKER.length)
    const after = afterStart >= 0 ? content.slice(afterStart).trimStart() : ""
    return `${before}\n\n${section}${after ? `\n${after}` : ""}`
  }

  const h1 = content.match(/^# .+$/m)
  if (!h1 || h1.index === undefined) return `${content.trimEnd()}\n\n${section}`
  const insertAt = h1.index + h1[0].length
  return `${content.slice(0, insertAt)}\n\n${section}${content.slice(insertAt)}`
}

function findServiceRow(rows: ServiceInventoryRow[], serviceName: string, title: string): ServiceInventoryRow | null {
  const names = [serviceName, title, title.replace(/服务$/g, "")]
    .map(normalizeServiceName)
    .filter(Boolean)
  return rows.find((row) => names.some((name) => name === normalizeServiceName(row.serviceName))) ??
    rows.find((row) => names.some((name) => name.includes(normalizeServiceName(row.serviceName)) || normalizeServiceName(row.serviceName).includes(name))) ??
    null
}

function findCoverage(coverageByService: Map<string, string>, serviceName: string): string {
  const normalized = normalizeServiceName(serviceName)
  for (const [service, coverage] of coverageByService.entries()) {
    if (service === normalized || service.includes(normalized) || normalized.includes(service)) return coverage
  }
  return ""
}

async function safeList(path: string): Promise<DirEntry[]> {
  try {
    return (await listDirectory(path)) as DirEntry[]
  } catch {
    return []
  }
}

function parseCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(clean)
}

function isSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

function findHeader(cells: string[], names: string[]): number {
  return cells.findIndex((cell) => names.some((name) => cell.includes(name)))
}

function clean(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\*\*/g, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isServiceItem(value: string): boolean {
  if (!value || value.length < 2 || value.length > 40) return false
  if (/^(服务项目|权益项目|项目|服务次数|服务阶段|服务场景)$/.test(value)) return false
  if (looksLikeFrequency(value)) return false
  return /[\u4e00-\u9fa5]/.test(value)
}

function looksLikeFrequency(value: string): boolean {
  return /(不限次|每人|家庭|最多|次\s*\/|次\(|年度|服务期内|\d+\s*次)/.test(value)
}

function normalizeServiceName(value: string): string {
  return clean(value)
    .replace(/（.*?）|\(.*?\)/g, "")
    .replace(/、趋势对比/g, "")
    .replace(/服务流程$/g, "")
    .replace(/服务$/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
}

function dedupeRows(rows: ServiceInventoryRow[]): ServiceInventoryRow[] {
  const seen = new Set<string>()
  const result: ServiceInventoryRow[] = []
  for (const row of rows) {
    const key = normalizeServiceName(row.serviceName)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }
  return result
}

function scalar(content: string, key: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const match = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`, "m"))
  return match ? stripQuotes(match[1].trim()) : ""
}

function parseAttributes(content: string): Record<string, unknown> {
  const raw = scalar(content, "attributes")
  if (!raw || raw === "{}") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function replaceAttributes(content: string, attrs: Record<string, unknown>): string {
  return replaceScalar(content, "attributes", JSON.stringify(attrs))
}

function replaceScalar(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, "m")
  if (pattern.test(content)) return content.replace(pattern, `${key}: ${value}`)
  const fmEnd = content.indexOf("\n---", 4)
  if (fmEnd < 0) return content
  return `${content.slice(0, fmEnd)}\n${key}: ${value}${content.slice(fmEnd)}`
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join("、")
  if (value == null) return ""
  return String(value).trim()
}

function filterResolvedGaps(value: unknown, resolved: string[]): string[] {
  const gaps = Array.isArray(value) ? value.map(stringValue).filter(Boolean) : []
  const normalizedResolved = new Set(resolved.map((item) => item.toLowerCase()))
  return gaps.filter((gap) => !normalizedResolved.has(gap.toLowerCase()))
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|")
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
