import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { getFileName } from "@/lib/path-utils"
import {
  getInsuranceSchemaSpec,
  normalizeInsuranceAttributes,
} from "@/lib/insurance-schema-registry"
import type { ReviewItem } from "@/stores/review-store"

export interface ExtractionAuditInput {
  projectPath: string
  sourceFileName: string
  sourceContent: string
  writtenPaths: string[]
  missingCandidates: { title: string; entityType: string; knowledgeDomain: string; required: boolean }[]
  preparedSource?: {
    processingMode: string
    originalChars: number
    contextChars: number
    chunkCount: number
    qualityConfidence: "high" | "medium" | "low"
    qualityNotes: string[]
  }
}

export interface ExtractionAuditResult {
  auditPath: string | null
  score: number
  reviewItems: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]
}

interface PageAudit {
  path: string
  title: string
  entityType: string
  knowledgeDomain: string
  criticalFilled: number
  criticalTotal: number
  highFilled: number
  highTotal: number
  recommendedFilled: number
  recommendedTotal: number
  missingCritical: string[]
  missingHigh: string[]
  relationCount: number
  claimCount: number
  sourceCount: number
  knowledgeGapCount: number
}

export async function writeExtractionQualityAudit(input: ExtractionAuditInput): Promise<ExtractionAuditResult> {
  const businessPages = input.writtenPaths.filter((path) =>
    path.startsWith("wiki/entities/") || path.startsWith("wiki/concepts/"),
  )
  const pageAudits: PageAudit[] = []
  for (const relPath of businessPages) {
    const content = await readFile(`${input.projectPath}/${relPath}`).catch(() => "")
    if (!content) continue
    pageAudits.push(auditKnowledgePage(relPath, content))
  }

  const sourceSignals = detectSourceSignals(input.sourceContent)
  const totals = summarizeAudits(pageAudits, input.missingCandidates.length, sourceSignals.expectedItemCount)
  const score = scoreAudit(totals)
  const auditPath = await writeAuditPage(input, pageAudits, sourceSignals, totals, score)
  const reviewItems = buildAuditReviewItems(input, auditPath, totals, score)
  return { auditPath, score, reviewItems }
}

function auditKnowledgePage(path: string, content: string): PageAudit {
  const fm = extractFrontmatter(content)
  const title = scalar(fm, "title") || getFileName(path).replace(/\.md$/i, "")
  const entityType = scalar(fm, "entity_type") || "general"
  const knowledgeDomain = scalar(fm, "knowledge_domain") || scalar(fm, "domain") || "general"
  const attributes = normalizeInsuranceAttributes(entityType, jsonObject(scalar(fm, "attributes")))
  const spec = getInsuranceSchemaSpec(entityType)
  const fields = spec?.fields ?? []
  const critical = fields.filter((field) => field.importance === "critical")
  const high = fields.filter((field) => field.importance === "high_confidence")
  const recommended = fields.filter((field) => field.importance === "recommended")
  const filled = (name: string) => !isEmpty(attributes[name])

  const missingCritical = critical.filter((field) => !filled(field.name)).map((field) => field.name)
  const missingHigh = high.filter((field) => !filled(field.name)).map((field) => field.name)
  return {
    path,
    title,
    entityType,
    knowledgeDomain,
    criticalFilled: critical.length - missingCritical.length,
    criticalTotal: critical.length,
    highFilled: high.length - missingHigh.length,
    highTotal: high.length,
    recommendedFilled: recommended.filter((field) => filled(field.name)).length,
    recommendedTotal: recommended.length,
    missingCritical,
    missingHigh,
    relationCount: yamlList(fm, "related").length + yamlList(fm, "relations").length + relationLineCount(content),
    claimCount: yamlList(fm, "claims").length + claimLineCount(content),
    sourceCount: yamlList(fm, "sources").length + yamlList(fm, "source_files").length,
    knowledgeGapCount: countKnowledgeGaps(attributes, content),
  }
}

function summarizeAudits(pageAudits: PageAudit[], missingCandidateCount: number, expectedItemCount: number) {
  const criticalTotal = sum(pageAudits, (page) => page.criticalTotal)
  const highTotal = sum(pageAudits, (page) => page.highTotal)
  const recommendedTotal = sum(pageAudits, (page) => page.recommendedTotal)
  const relationReadyPages = pageAudits.filter((page) => page.relationCount > 0).length
  const evidenceReadyPages = pageAudits.filter((page) => page.claimCount > 0 || page.sourceCount > 0).length
  const expectedCoverage = expectedItemCount > 0 ? Math.min(1, pageAudits.length / expectedItemCount) : 1

  return {
    pageCount: pageAudits.length,
    expectedItemCount,
    expectedCoverage,
    missingCandidateCount,
    criticalCoverage: criticalTotal > 0 ? sum(pageAudits, (page) => page.criticalFilled) / criticalTotal : 1,
    highCoverage: highTotal > 0 ? sum(pageAudits, (page) => page.highFilled) / highTotal : 1,
    recommendedCoverage: recommendedTotal > 0 ? sum(pageAudits, (page) => page.recommendedFilled) / recommendedTotal : 1,
    relationCoverage: pageAudits.length > 0 ? relationReadyPages / pageAudits.length : 1,
    evidenceCoverage: pageAudits.length > 0 ? evidenceReadyPages / pageAudits.length : 1,
    knowledgeGapCount: sum(pageAudits, (page) => page.knowledgeGapCount),
  }
}

function scoreAudit(totals: ReturnType<typeof summarizeAudits>): number {
  const weighted =
    totals.criticalCoverage * 0.28 +
    totals.highCoverage * 0.22 +
    totals.evidenceCoverage * 0.18 +
    totals.relationCoverage * 0.14 +
    totals.expectedCoverage * 0.12 +
    Math.max(0, 1 - totals.missingCandidateCount / 20) * 0.06
  return Math.round(Math.max(0, Math.min(1, weighted)) * 100)
}

async function writeAuditPage(
  input: ExtractionAuditInput,
  pageAudits: PageAudit[],
  sourceSignals: ReturnType<typeof detectSourceSignals>,
  totals: ReturnType<typeof summarizeAudits>,
  score: number,
): Promise<string | null> {
  try {
    const sourceBase = getFileName(input.sourceFileName).replace(/\.[^.]+$/i, "") || "source"
    const auditDir = `${input.projectPath}/wiki/audits`
    const auditPath = `wiki/audits/${sourceBase}-抽取质量审计.md`
    await createDirectory(`${input.projectPath}/wiki`).catch(() => {})
    await createDirectory(auditDir).catch(() => {})
    await writeFile(`${input.projectPath}/${auditPath}`, buildAuditMarkdown(input, pageAudits, sourceSignals, totals, score))
    return auditPath
  } catch (err) {
    console.warn("[extraction-audit] Failed to write audit page:", err)
    return null
  }
}

function buildAuditMarkdown(
  input: ExtractionAuditInput,
  pageAudits: PageAudit[],
  sourceSignals: ReturnType<typeof detectSourceSignals>,
  totals: ReturnType<typeof summarizeAudits>,
  score: number,
): string {
  const date = new Date().toISOString()
  const lowPages = pageAudits
    .filter((page) => page.missingCritical.length > 0 || page.missingHigh.length > 2 || page.relationCount === 0)
    .slice(0, 30)
  return [
    "---",
    'schema_version: "2.1"',
    "type: data",
    "entity_type: extraction_audit",
    "knowledge_domain: general",
    "domain: general",
    `title: "${escapeYaml(input.sourceFileName)} 抽取质量审计"`,
    `source_files: ["${escapeYaml(input.sourceFileName)}"]`,
    `sources: ["${escapeYaml(input.sourceFileName)}"]`,
    `confidence: ${score / 100}`,
    "status: candidate",
    "needs_review: false",
    `attributes: ${JSON.stringify({ score, ...totals, sourceSignals })}`,
    `created: "${date.slice(0, 10)}"`,
    `updated: "${date.slice(0, 10)}"`,
    "---",
    "",
    `# ${input.sourceFileName} 抽取质量审计`,
    "",
    `综合评分：**${score}/100**`,
    "",
    "## 处理概况",
    "",
    `- 处理模式：${input.preparedSource?.processingMode ?? "unknown"}`,
    `- 原文字符数：${input.preparedSource?.originalChars ?? input.sourceContent.length}`,
    `- 编译上下文字符数：${input.preparedSource?.contextChars ?? input.sourceContent.length}`,
    `- 分批数量：${input.preparedSource?.chunkCount ?? 1}`,
    `- 解析置信度：${input.preparedSource?.qualityConfidence ?? "unknown"}`,
    "",
    "## 覆盖率",
    "",
    `- 生成业务知识页：${totals.pageCount}`,
    `- 原文预计条目：${totals.expectedItemCount || "未识别"}`,
    `- 原文条目覆盖率：${percent(totals.expectedCoverage)}`,
    `- critical 字段完整率：${percent(totals.criticalCoverage)}`,
    `- high_confidence 字段完整率：${percent(totals.highCoverage)}`,
    `- recommended 字段完整率：${percent(totals.recommendedCoverage)}`,
    `- 关系覆盖率：${percent(totals.relationCoverage)}`,
    `- 证据覆盖率：${percent(totals.evidenceCoverage)}`,
    `- schema 候选缺失数：${totals.missingCandidateCount}`,
    `- 显式知识缺口数：${totals.knowledgeGapCount}`,
    "",
    "## 原文信号",
    "",
    `- 文档形态：${sourceSignals.kind}`,
    `- 检测到的服务/规则条目：${sourceSignals.detectedItems.join("、") || "未识别"}`,
    `- 表格/清单行信号：${sourceSignals.tableLikeRowCount}`,
    "",
    "## 页面字段审计",
    "",
    pageAudits.length === 0
      ? "未生成可审计的实体/概念页。"
      : [
          "| 页面 | 类型 | critical | high | recommended | 关系 | 证据 | 缺口 |",
          "|---|---:|---:|---:|---:|---:|---:|---:|",
          ...pageAudits.map((page) =>
            `| [[${page.title}]] | ${page.entityType} | ${page.criticalFilled}/${page.criticalTotal} | ${page.highFilled}/${page.highTotal} | ${page.recommendedFilled}/${page.recommendedTotal} | ${page.relationCount} | ${page.claimCount + page.sourceCount} | ${page.knowledgeGapCount} |`,
          ),
        ].join("\n"),
    "",
    "## 需要关注的页面",
    "",
    lowPages.length === 0
      ? "暂无明显低覆盖页面。"
      : lowPages.map((page) =>
          `- [[${page.title}]]：missing critical=${page.missingCritical.join(", ") || "无"}；missing high=${page.missingHigh.slice(0, 8).join(", ") || "无"}；relations=${page.relationCount}`,
        ).join("\n"),
    "",
    "## 建议",
    "",
    ...buildRecommendations(totals, score),
    "",
  ].join("\n")
}

function buildAuditReviewItems(
  input: ExtractionAuditInput,
  auditPath: string | null,
  totals: ReturnType<typeof summarizeAudits>,
  score: number,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  if (score >= 75 && totals.missingCandidateCount === 0) return []
  return [{
    type: "suggestion",
    title: `抽取质量需复核：${input.sourceFileName} 评分 ${score}/100`,
    description: [
      `系统已生成抽取质量审计，当前评分 ${score}/100。`,
      `critical 字段完整率：${percent(totals.criticalCoverage)}；high_confidence 字段完整率：${percent(totals.highCoverage)}；关系覆盖率：${percent(totals.relationCoverage)}；证据覆盖率：${percent(totals.evidenceCoverage)}。`,
      totals.missingCandidateCount > 0 ? `仍有 ${totals.missingCandidateCount} 个 schema 候选知识点未覆盖。` : "",
      "建议优先复核低覆盖页面、缺少证据的字段和未连接关系。",
    ].filter(Boolean).join("\n"),
    sourcePath: input.sourceFileName,
    affectedPages: auditPath ? [auditPath] : undefined,
    searchQueries: [
      "知识抽取 质量评估 schema coverage",
      "RAG 知识库 抽取完整率 证据覆盖率",
      "保险知识图谱 字段完整率 关系完整率",
    ],
    options: [
      { label: "Create Page", action: "Create Page" },
      { label: "Skip", action: "Skip" },
    ],
  }]
}

function buildRecommendations(totals: ReturnType<typeof summarizeAudits>, score: number): string[] {
  const lines: string[] = []
  if (score < 60) lines.push("- 本次编译不建议直接演示问答，应先补齐低覆盖页面或重新分批抽取。")
  if (totals.criticalCoverage < 0.8) lines.push("- critical 字段缺失偏多，优先检查产品、服务、规则的核心字段。")
  if (totals.highCoverage < 0.65) lines.push("- high_confidence 字段不足，可能影响 Agent 精准检索和结构化过滤。")
  if (totals.relationCoverage < 0.6) lines.push("- 关系覆盖不足，建议补充 Product-Customer-Method 以及服务-规则-合规链接。")
  if (totals.evidenceCoverage < 0.75) lines.push("- 证据覆盖不足，字段应绑定 sources/claims，避免 RAG 返回无来源结论。")
  if (totals.missingCandidateCount > 0) lines.push("- schema 候选缺失仍存在，建议进入审核队列确认是补页、合并到已有页，还是标记为不处理。")
  if (lines.length === 0) lines.push("- 抽取结果整体可用，建议抽样核对关键字段和跨域关系后进入演示。")
  return lines
}

function detectSourceSignals(sourceContent: string): { kind: string; expectedItemCount: number; detectedItems: string[]; tableLikeRowCount: number } {
  const serviceItems = [
    "家庭医生服务", "在线问诊", "音视频问诊", "名医大咖", "特色体检", "21天社群训练营", "门诊预约协助", "就医陪诊",
    "重疾专案管理", "专家会诊", "国内住院安排协助", "手术安排协助", "住院照护", "上门护理", "服务激活流程",
    "服务中止规则", "服务终止规则", "重疾服务等待期与非共享规则", "合规免责说明",
  ].filter((item) => sourceContent.includes(item))
  const tableLikeRowCount = sourceContent.split(/\r?\n/).filter((line) =>
    /(\|\s*[^|]+\s*\|)|(^\s*\d+[\.、]\s+)|(\bY\b|\bN\b|是|否|1\*?)/.test(line),
  ).length
  const kind = serviceItems.length >= 6
    ? "service_manual"
    : tableLikeRowCount >= 20
      ? "table_or_catalog"
      : sourceContent.length > 50000
        ? "long_document"
        : "standard_document"
  return {
    kind,
    expectedItemCount: Math.max(serviceItems.length, tableLikeRowCount >= 20 ? tableLikeRowCount : 0),
    detectedItems: serviceItems,
    tableLikeRowCount,
  }
}

function extractFrontmatter(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
}

function scalar(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`, "m"))
  return match ? stripQuotes(match[1].trim()) : ""
}

function yamlList(frontmatter: string, key: string): string[] {
  const inline = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\[([^\\]]*)]`, "m"))
  if (inline) return inline[1].split(",").map((item) => stripQuotes(item.trim())).filter(Boolean)
  const block = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"))
  if (!block) return []
  return block[1].split(/\r?\n/)
    .map((line) => line.match(/^\s+-\s+(.+?)\s*$/)?.[1] ?? "")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean)
}

function jsonObject(raw: string): Record<string, unknown> {
  if (!raw || raw === "{}") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function relationLineCount(content: string): number {
  return (content.match(/\b(recommended_for|applies_to|supports|has_part|complements|bundled_with|uses_asset|governed_by|requires|uses_process)\s*:/g) ?? []).length
}

function claimLineCount(content: string): number {
  return (content.match(/(^|\n)\s*[-*]\s+.*(来源|证据|raw:|source:|confidence:)/g) ?? []).length
}

function countKnowledgeGaps(attributes: Record<string, unknown>, content: string): number {
  const gaps = attributes.knowledge_gaps
  const attrCount = Array.isArray(gaps) ? gaps.length : isEmpty(gaps) ? 0 : 1
  const visibleCount = (content.match(/待补全|知识缺口|缺失|未提供/g) ?? []).length
  return attrCount + visibleCount
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "string") return value.trim() === "" || value.trim().toLowerCase() === "null"
  return false
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0)
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim()
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
