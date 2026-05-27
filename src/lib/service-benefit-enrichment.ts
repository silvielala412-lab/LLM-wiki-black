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
  serviceItems: string[]
  coverageByService: Map<string, string>
  serviceProvider: string
  relatedProduct: string
  sourceFileName: string
}

interface DirEntry {
  name: string
  is_dir?: boolean
}

interface PersistedRelationEdge {
  target: string
  type: "part_of" | "same_stage" | "same_category" | "next_step"
  confidence: number
  evidence: string
  sourceFiles: string[]
}

const AUTO_SECTION_MARKER = "<!-- service-benefit-enrichment -->"
const MAX_STRUCTURED_SERVICE_EDGES = 6

export async function enrichServiceBenefitPagesFromSources(projectPath: string): Promise<string[]> {
  const facts = await collectSourceFacts(projectPath)
  if (facts.rows.length === 0 && facts.serviceItems.length === 0) return []
  return ensureAndEnrichServiceBenefitPages(projectPath, facts)
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
  const directItems = parseDeclaredServiceItems(sourceContent)
  facts.rows = dedupeRows([...directRows, ...facts.rows])
  facts.serviceItems = dedupeNames([...directItems, ...facts.serviceItems, ...directRows.map((row) => row.serviceName)])
  facts.sourceFileName = sourceFileName
  if (directProvider) facts.serviceProvider = directProvider
  if (!facts.relatedProduct) {
    facts.relatedProduct =
      extractPlanNameFromBody(sourceContent) ||
      sanitizeSourceTitle(scalar(sourceContent, "title") || "") ||
      "臻享家医健康服务计划"
  }
  return ensureAndEnrichServiceBenefitPages(projectPath, facts)
}

export function parseServiceInventoryRows(content: string, sourceFile = "source"): ServiceInventoryRow[] {
  return dedupeRows([
    ...parseMarkdownServiceTable(content, sourceFile),
    ...parseSequentialOcrServiceTable(content, sourceFile),
  ])
}

async function collectSourceFacts(projectPath: string): Promise<SourceFacts> {
  const rows: ServiceInventoryRow[] = []
  const serviceItems: string[] = []
  const coverageByService = new Map<string, string>()
  let serviceProvider = ""
  let relatedProduct = ""
  let sourceFileName = ""

  const sourceFiles = await safeList(`${projectPath}/wiki/sources`)
  for (const file of sourceFiles) {
    if (file.is_dir || !file.name.endsWith(".md")) continue
    const content = await readFile(`${projectPath}/wiki/sources/${file.name}`).catch(() => "")
    if (!content) continue
    const attrs = parseAttributes(content)
    if (!serviceProvider) serviceProvider = stringValue(attrs.service_provider)
    // Extract canonical product name. Priority:
    //   1. Structured attribute fields (product_name, service_plan_name, plan_name)
    //   2. Body text pattern matching for known plan-name keywords
    //   3. Sanitized source-page title (strip version suffix, never use raw filename)
    // We intentionally do NOT fall back to the raw source-page title (file.name)
    // because that would make all service_benefit pages point to the source doc
    // instead of the product entity.
    if (!relatedProduct) {
      relatedProduct =
        stringValue(attrs.product_name) ||
        stringValue(attrs.service_plan_name) ||
        stringValue(attrs.plan_name) ||
        extractPlanNameFromBody(content) ||
        sanitizeSourceTitle(scalar(content, "title") || "")
    }
    if (!sourceFileName) sourceFileName = firstListValue(content, "source_files") || firstListValue(content, "sources") || file.name
    rows.push(...parseMarkdownServiceTable(content, file.name))
    rows.push(...parseSequentialOcrServiceTable(content, file.name))
    serviceItems.push(...parseDeclaredServiceItems(content))
    for (const [service, coverage] of parseCoverageTable(content)) {
      coverageByService.set(normalizeServiceName(service), coverage)
    }
  }

  return {
    rows: dedupeRows(rows),
    serviceItems: dedupeNames([...serviceItems, ...rows.map((row) => row.serviceName)]),
    coverageByService,
    serviceProvider,
    relatedProduct,
    sourceFileName,
  }
}

async function ensureAndEnrichServiceBenefitPages(projectPath: string, facts: SourceFacts): Promise<string[]> {
  const created = await ensureMissingServiceBenefitPages(projectPath, facts)
  const enriched = await enrichServiceBenefitPages(projectPath, facts)
  return [...created, ...enriched.filter((path) => !created.includes(path))]
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

async function ensureMissingServiceBenefitPages(projectPath: string, facts: SourceFacts): Promise<string[]> {
  const existingFiles = await safeList(`${projectPath}/wiki/entities`)
  const existingNames = new Set<string>()
  for (const file of existingFiles) {
    if (file.is_dir || !file.name.endsWith(".md")) continue
    const content = await readFile(`${projectPath}/wiki/entities/${file.name}`).catch(() => "")
    const title = scalar(content, "title") || file.name.replace(/\.md$/i, "")
    existingNames.add(normalizeServiceName(title))
    const attrs = parseAttributes(content)
    const serviceName = stringValue(attrs.service_name)
    if (serviceName) existingNames.add(normalizeServiceName(serviceName))
  }

  const created: string[] = []
  for (const serviceName of facts.serviceItems) {
    const normalized = normalizeServiceName(serviceName)
    if (!normalized || existingNames.has(normalized)) continue

    const displayName = canonicalServiceName(serviceName)
    const row = findServiceRow(facts.rows, displayName, displayName)
    const path = `wiki/entities/${safeFileName(displayName)}.md`
    const content = buildServiceBenefitPage(displayName, row, facts)
    await writeFile(`${projectPath}/${path}`, content)
    existingNames.add(normalized)
    created.push(path)
  }
  return created
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

function parseDeclaredServiceItems(content: string): string[] {
  const attrs = parseAttributes(content)
  const fromAttrs = Array.isArray(attrs.service_items)
    ? attrs.service_items.map(stringValue).filter(Boolean)
    : []
  const fromStructuredTable: string[] = []
  for (const match of content.matchAll(/\|\s*`?service_benefit`?\s*\|\s*([^|\r\n]+?)\s*\|/g)) {
    const item = canonicalServiceName(match[1])
    if (isServiceItem(item)) fromStructuredTable.push(item)
  }
  return dedupeNames([...fromAttrs, ...fromStructuredTable])
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
  next = upsertServiceRelations(next, buildServiceRelationEdges(row.serviceName, row, facts))
  next = upsertAutoSection(next, row, facts, coverage)
  return next
}

function buildServiceBenefitPage(serviceName: string, row: ServiceInventoryRow | null, facts: SourceFacts): string {
  const date = new Date().toISOString().slice(0, 10)
  const coverage = findCoverage(facts.coverageByService, serviceName)
  const sourceFile = facts.sourceFileName || row?.sourceFile || "来源文档"
  const category = row ? [row.serviceScene, row.serviceStage].filter(Boolean).join("/") : ""
  const gaps = [
    row?.serviceFrequency ? "" : "service_frequency",
    category ? "" : "service_category",
    coverage ? "" : "coverage_scope",
    facts.serviceProvider ? "" : "service_provider",
    "application_process",
    "time_limits",
    "service_limits",
    "compliance_notes",
  ].filter(Boolean)
  const attrs = {
    service_name: serviceName,
    related_product: facts.relatedProduct || "臻享家医健康服务计划",
    service_category: category || null,
    core_value: null,
    eligible_customers: null,
    service_frequency: row?.serviceFrequency || null,
    application_process: null,
    time_limits: null,
    service_provider: facts.serviceProvider || null,
    coverage_scope: coverage || null,
    service_limits: null,
    compliance_notes: null,
    knowledge_gaps: gaps,
  }
  const summaryText = `${serviceName}是${facts.relatedProduct || "服务手册"}中的服务权益，已由源文档清单自动生成。`
  const relatedProduct = facts.relatedProduct || "臻享家医健康服务计划"
  const relationEdges = buildServiceRelationEdges(serviceName, row, facts)
  const relationLines = dedupeStrings([
    `part_of: ${relatedProduct}`,
    ...relationEdges
      .filter((edge) => edge.type !== "part_of")
      .map((edge) => `${edge.type}: ${edge.target}`),
  ])
  const knownRows = [
    row?.serviceScene ? `| 服务场景 | ${escapeTable(row.serviceScene)} |` : "",
    row?.serviceStage ? `| 服务阶段 | ${escapeTable(row.serviceStage)} |` : "",
    `| 服务项目 | ${escapeTable(serviceName)} |`,
    row?.serviceFrequency ? `| 服务次数 | ${escapeTable(row.serviceFrequency)} |` : "",
    facts.serviceProvider ? `| 服务提供方 | ${escapeTable(facts.serviceProvider)} |` : "",
    coverage ? `| 覆盖范围 | ${escapeTable(coverage)} |` : "",
  ].filter(Boolean)

  return [
    "---",
    'schema_version: "2.1"',
    "industry: insurance",
    "knowledge_domain: product",
    "taxonomy_path: [product, service_benefit]",
    "type: entity",
    "entity_type: service_benefit",
    "business_phase: service",
    `dedup_key: "service_benefit.${escapeYaml(serviceName)}"`,
    `title: "${escapeYaml(serviceName)}"`,
    `summary: "${escapeYaml(summaryText)}"`,
    `created: ${date}`,
    `updated: ${date}`,
    `created_at: ${date}`,
    `updated_at: ${date}`,
    "created_by: system",
    `tags: ["服务权益", "${escapeYaml(serviceName)}"]`,
    `keywords: ["${escapeYaml(serviceName)}"]`,
    `related: ["${escapeYaml(relatedProduct)}"]`,
    'relations:',
    relationLines.map((line) => `  - "${escapeYaml(line)}"`).join("\n"),
    relationEdges.length > 0 ? "relation_edges:" : "",
    relationEdges.length > 0 ? formatRelationEdgesBlock(relationEdges) : "",
    'parent: ""',
    "children: []",
    `source_files: ["${escapeYaml(sourceFile)}"]`,
    `sources: ["${escapeYaml(sourceFile)}"]`,
    'source_type: "service_manual"',
    "confidence: 0.78",
    "status: candidate",
    "needs_review: true",
    `attributes: ${JSON.stringify(attrs)}`,
    "claims: []",
    "---",
    "",
    `# ${serviceName}`,
    "",
    AUTO_SECTION_MARKER,
    "## 服务手册确定信息",
    "",
    "| 字段 | 已抽取事实 |",
    "|---|---|",
    knownRows.join("\n"),
    "",
    `来源依据：[[${sourceFile.replace(/\.[^.]+$/i, "")}]] 服务项目清单。`,
    "",
    "## 服务说明",
    "",
    `${serviceName} 是服务手册中识别出的独立服务权益。当前页面由系统根据服务清单兜底生成，用于避免重要服务项只停留在源文档中而没有独立知识页。`,
    "",
    "## 待补全信息",
    "",
    gaps.length > 0 ? gaps.map((gap) => `- ${gap}`).join("\n") : "- 暂无",
    "",
  ].join("\n")
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
    const autoSectionRe = new RegExp(
      `${escapeRegExp(AUTO_SECTION_MARKER)}[\\s\\S]*?(?=\\n## (?!服务手册确定信息)|\\n# |$)`,
    )
    return content.replace(autoSectionRe, section)
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

function buildServiceRelationEdges(
  serviceName: string,
  row: ServiceInventoryRow | null,
  facts: SourceFacts,
): PersistedRelationEdge[] {
  const edges: PersistedRelationEdge[] = []
  const sourceFiles = [facts.sourceFileName || row?.sourceFile || ""].filter(Boolean)
  const relatedProduct = facts.relatedProduct || "臻享家医健康服务计划"
  if (relatedProduct) {
    edges.push({
      target: relatedProduct,
      type: "part_of",
      confidence: 0.92,
      evidence: `${serviceName} 来自 ${relatedProduct} 的服务项目清单。`,
      sourceFiles,
    })
  }

  if (!row) return edges

  const currentKey = normalizeServiceName(row.serviceName || serviceName)
  const orderedRows = facts.rows.filter((item) => normalizeServiceName(item.serviceName) !== currentKey)
  const sameStage = orderedRows.filter((item) =>
    row.serviceScene &&
    row.serviceStage &&
    item.serviceScene === row.serviceScene &&
    item.serviceStage === row.serviceStage
  )
  for (const peer of nearestServiceRows(facts.rows, row, sameStage, 3)) {
    edges.push({
      target: peer.serviceName,
      type: "same_stage",
      confidence: 0.72,
      evidence: `${row.serviceName} 与 ${peer.serviceName} 同属「${row.serviceScene}/${row.serviceStage}」服务阶段。`,
      sourceFiles,
    })
  }

  const sameCategory = orderedRows.filter((item) =>
    row.serviceScene &&
    item.serviceScene === row.serviceScene &&
    item.serviceStage !== row.serviceStage
  )
  for (const peer of nearestServiceRows(facts.rows, row, sameCategory, 2)) {
    edges.push({
      target: peer.serviceName,
      type: "same_category",
      confidence: 0.64,
      evidence: `${row.serviceName} 与 ${peer.serviceName} 同属「${row.serviceScene}」服务场景。`,
      sourceFiles,
    })
  }

  const next = nextServiceRow(facts.rows, row)
  if (next) {
    edges.push({
      target: next.serviceName,
      type: "next_step",
      confidence: 0.66,
      evidence: `${row.serviceName} 与 ${next.serviceName} 在源服务清单中相邻，属于同一服务场景的连续候选。`,
      sourceFiles,
    })
  }

  return dedupeRelationEdges(edges).slice(0, MAX_STRUCTURED_SERVICE_EDGES)
}

function nearestServiceRows(
  allRows: ServiceInventoryRow[],
  row: ServiceInventoryRow,
  candidates: ServiceInventoryRow[],
  limit: number,
): ServiceInventoryRow[] {
  const currentIndex = allRows.findIndex((item) => normalizeServiceName(item.serviceName) === normalizeServiceName(row.serviceName))
  return candidates
    .slice()
    .sort((a, b) => {
      const ai = allRows.findIndex((item) => normalizeServiceName(item.serviceName) === normalizeServiceName(a.serviceName))
      const bi = allRows.findIndex((item) => normalizeServiceName(item.serviceName) === normalizeServiceName(b.serviceName))
      return Math.abs(ai - currentIndex) - Math.abs(bi - currentIndex)
    })
    .slice(0, limit)
}

function nextServiceRow(rows: ServiceInventoryRow[], row: ServiceInventoryRow): ServiceInventoryRow | null {
  const currentIndex = rows.findIndex((item) => normalizeServiceName(item.serviceName) === normalizeServiceName(row.serviceName))
  if (currentIndex < 0) return null
  const next = rows[currentIndex + 1]
  if (!next || next.serviceScene !== row.serviceScene) return null
  return next
}

function dedupeRelationEdges(edges: PersistedRelationEdge[]): PersistedRelationEdge[] {
  const seen = new Set<string>()
  const result: PersistedRelationEdge[] = []
  for (const edge of edges) {
    const key = `${edge.type}::${normalizeServiceName(edge.target)}`
    if (!edge.target || seen.has(key)) continue
    seen.add(key)
    result.push(edge)
  }
  return result
}

function upsertServiceRelations(content: string, edges: PersistedRelationEdge[]): string {
  if (edges.length === 0) return content
  let next = upsertFrontmatterList(
    content,
    "relations",
    edges.map((edge) => `${edge.type}: ${edge.target}`),
  )
  next = upsertRelationEdges(next, edges)
  return next
}

function upsertFrontmatterList(content: string, key: string, items: string[]): string {
  const existing = new Set(extractFrontmatterList(content, key).map((item) => item.toLowerCase()))
  const toAdd = items.filter((item) => item && !existing.has(item.toLowerCase()))
  if (toAdd.length === 0) return content
  const itemLines = toAdd.map((item) => `  - "${escapeYaml(item)}"`).join("\n")
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!fmMatch) return `---\n${key}:\n${itemLines}\n---\n\n${content}`

  const [fullFmBlock, open, fm, close] = fmMatch
  const blockRe = new RegExp(`^(${escapeRegExp(key)}:\\s*\\n(?:\\s+-\\s+.+\\n?)*)`, "m")
  if (blockRe.test(fm)) {
    const newFm = fm.replace(blockRe, (match) => `${match.trimEnd()}\n${itemLines}\n`)
    return content.replace(fullFmBlock, open + newFm + close)
  }
  const inlineEmptyRe = new RegExp(`^${escapeRegExp(key)}:\\s*\\[\\]`, "m")
  if (inlineEmptyRe.test(fm)) {
    const newFm = fm.replace(inlineEmptyRe, `${key}:\n${itemLines}`)
    return content.replace(fullFmBlock, open + newFm + close)
  }
  const newFm = `${fm.trimEnd()}\n${key}:\n${itemLines}`
  return content.replace(fullFmBlock, open + newFm + close)
}

function upsertRelationEdges(content: string, edges: PersistedRelationEdge[]): string {
  const existing = readExistingRelationEdgeKeys(content)
  const toAdd = edges.filter((edge) => !existing.has(`${edge.type}::${normalizeServiceName(edge.target)}`))
  if (toAdd.length === 0) return content
  const edgeBlock = formatRelationEdgesBlock(toAdd)
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/m)
  if (!fmMatch) return `---\nrelation_edges:\n${edgeBlock}\n---\n\n${content}`

  const [fullFmBlock, open, fm, close] = fmMatch
  const blockRe = /^relation_edges:[ \t]*\n(?:[ \t]+.*(?:\r?\n|$))*/m
  if (blockRe.test(fm)) {
    const newFm = fm.replace(blockRe, (match) => `${match.trimEnd()}\n${edgeBlock}\n`)
    return content.replace(fullFmBlock, open + newFm + close)
  }
  const newFm = `${fm.trimEnd()}\nrelation_edges:\n${edgeBlock}`
  return content.replace(fullFmBlock, open + newFm + close)
}

function formatRelationEdgesBlock(edges: PersistedRelationEdge[]): string {
  return edges.map((edge) => [
    `  - target: "${escapeYaml(edge.target)}"`,
    `    type: ${edge.type}`,
    "    provenance: postprocess_inferred",
    `    confidence: ${edge.confidence.toFixed(2)}`,
    `    evidence: "${escapeYaml(edge.evidence)}"`,
    edge.sourceFiles.length > 0
      ? `    source_files: [${edge.sourceFiles.map((file) => `"${escapeYaml(file)}"`).join(", ")}]`
      : "    source_files: []",
  ].join("\n")).join("\n")
}

function readExistingRelationEdgeKeys(content: string): Set<string> {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const block = fm.match(/^relation_edges:\s*\n((?:\s+-[\s\S]*?(?=\n\S|$))+)/m)?.[1] ?? ""
  const entries = block.split(/\n(?=\s+-)/)
  const keys = new Set<string>()
  for (const entry of entries) {
    const target = entry.match(/target:\s*["']?([^"'\n]+)["']?/)?.[1]?.trim()
    const type = entry.match(/type:\s*["']?([^"'\n]+)["']?/)?.[1]?.trim()
    if (target && type) keys.add(`${type}::${normalizeServiceName(target)}`)
  }
  return keys
}

function extractFrontmatterList(content: string, key: string): string[] {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const inline = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)]`, "m"))
  if (inline) return inline[1].split(",").map((item) => stripQuotes(item.trim())).filter(Boolean)
  const block = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"))
  if (!block) return []
  return block[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s+-\s+(.+)$/)?.[1]?.trim() ?? "")
    .map(stripQuotes)
    .filter(Boolean)
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

/**
 * Normalize an entity title for use as a relation target or page title.
 * Removes HTML artifacts, OCR noise, and known naming inconsistencies that
 * cause relation reconciliation to fail.
 */
export function normalizeEntityTitle(value: string): string {
  return value
    // Strip HTML tags (OCR/table remnants)
    .replace(/<[^>]+>/g, "")
    // Remove known entity-specific suffixes that cause mismatch
    .replace(/_?臻享家医$/, "")
    .replace(/_?家医健康$/, "")
    // Remove source-document version markers
    .replace(/[（(]\d{4}年\d+月版[)）]/g, "")
    .replace(/服务手册$/, "")
    // Common OCR substitution fixes
    .replace(/普视频/g, "音视频")
    .replace(/体验专项/g, "体检专项")
    // Clean whitespace
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Extracts a canonical product/service-plan name from body text.
 * Looks for patterns like "XX健康服务计划" or "XX服务计划" in headings.
 */
function extractPlanNameFromBody(content: string): string {
  // Match headings containing common plan-name patterns
  const patterns = [
    /#{1,3}\s*([^\n]*?(?:健康服务计划|服务计划|健康计划)[^\n]*)/,
    /(?:产品名称|计划名称|服务计划名称)\s*[:：]\s*([^\n]{4,40})/,
    /([\u4e00-\u9fff]{4,20}(?:健康服务计划|服务计划))/,
  ]
  for (const pattern of patterns) {
    const m = content.match(pattern)
    if (m) {
      const candidate = normalizeEntityTitle(m[1].trim())
      // Must be a plausible plan name (4-30 chars, contains Chinese)
      if (candidate.length >= 4 && candidate.length <= 30 && /[\u4e00-\u9fff]/.test(candidate)) {
        return candidate
      }
    }
  }
  return ""
}

/**
 * Sanitize a source-document title for use as a product name fallback.
 * Strips version suffixes, "服务手册" etc. that indicate a source doc, not a product.
 */
function sanitizeSourceTitle(title: string): string {
  const cleaned = normalizeEntityTitle(title)
  // If the cleaned title still looks like a source document, return empty
  // so the caller can try the next fallback
  if (/手册|规范|说明书|条款|（\d{4}|\(\d{4}/.test(cleaned)) return ""
  return cleaned
}

function canonicalServiceName(value: string): string {
  return normalizeEntityTitle(clean(value))
    .replace(/^(服务权益名称|服务名称|权益名称|服务项目名称)\s*[:：]\s*/g, "")
    .replace(/(?:\.md)+$/i, "")
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
  return canonicalServiceName(value)
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

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of names.map(canonicalServiceName).filter(isServiceItem)) {
    const key = normalizeServiceName(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function safeFileName(name: string): string {
  const safe = canonicalServiceName(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "")
    .replace(/(?:\.md)+$/i, "")
    .slice(0, 80)
  return safe || "service_benefit"
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

function firstListValue(content: string, key: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const inline = fm.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)]`, "m"))
  if (!inline) return ""
  return stripQuotes(inline[1].split(",")[0]?.trim() ?? "")
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

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
