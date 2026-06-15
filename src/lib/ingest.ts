import { createDirectory, readFile, writeFile, listDirectory, readFileAsBase64 } from "@/commands/fs"
import { getLogger } from "@/lib/logger"

// Module-level namespaced loggers — no coupling to console or UI
const log      = getLogger("ingest")
const logOCR   = getLogger("ingest:ocr")
const logDiag  = getLogger("ingest:diag")
const logQueue = getLogger("ingest:queue")
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig, EmbeddingConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { schemaGuidance } from "@/lib/knowledge-schema"
import { normalizeSchemaFrontmatter, shouldNormalizeKnowledgePage } from "@/lib/knowledge-schema-normalizer"
import { cleanupKnowledgeFrontmatter } from "@/lib/knowledge-frontmatter-cleanup"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { withProjectLock } from "@/lib/project-mutex"
import { writeExtractionQualityAudit } from "@/lib/extraction-quality-audit"
import { runKnowledgePostProcess } from "@/lib/knowledge-postprocess"
import { runGlobalRelationPass } from "@/lib/knowledge-global-relation"
import { runIdentityPass } from "@/lib/knowledge-identity-resolution"
import {
  enrichServiceBenefitPagesFromText,
  parseServiceInventoryRows,
} from "@/lib/service-benefit-enrichment"
import {
  extractAndSaveSourceImages,
  buildImageMarkdownSection,
} from "@/lib/extract-source-images"
import { captionMarkdownImages, loadCaptionCache } from "@/lib/image-caption-pipeline"
import { isImagePdf, ocrImagePdf, ocrImageBytes } from "@/lib/pdf-ocr"
import { buildVisionLlmConfig } from "@/lib/server-config"
import {
  buildExistingEntityIndexItem,
  loadExistingEntities,
  mergeStrongIdentityDuplicatePages,
  normalizeEntityBlock,
} from "@/lib/entity-normalizer"
import { resolveIncomingKnowledgePage } from "@/lib/knowledge-resolution"
import { buildServiceItemTitle, findServiceLineVersion, SERVICE_HIERARCHY } from "@/lib/insurance-schema-registry"
import {
  type InsuranceCategoryType,
  INSURANCE_CATEGORIES,
  PRODUCT_CATALOG_MODULES,
  buildProductModuleTitle,
  inferModulesFromSourceFileName,
  getRequiredModules,
  encodeProductCatalogFolderContext,
  getModuleBatchesForFile,
} from "@/lib/product-catalog-modules"
import type { MultimodalConfig } from "@/stores/wiki-store"

/**
 * Extract service line + version context from a source file path.
 *
 * Expected path pattern:
 *   raw/sources/{lineName}/{versionName}/file.pdf
 *
 * Returns null if the path doesn't match a known service line version.
 *
 * Example:
 *   "raw/sources/臻享家医/V1/服务手册.pdf"
 *   → { lineName: "臻享家医", versionName: "V1" }
 */
export function extractServiceLineCtxFromPath(
  sourcePath: string,
): { lineName: string; versionName: string; seriesName: string; scenarioName: string } | null {
  const parts = sourcePath.replace(/\\/g, "/").split("/")
  // Expected: ["raw", "sources", lineName, versionName, ...filename]
  if (parts.length < 5) return null
  if (parts[0] !== "raw" || parts[1] !== "sources") return null
  const lineName = parts[2]
  const versionName = parts[3]
  const ctx = findServiceLineVersion(lineName, versionName)
  if (!ctx) return null
  // Use canonical version name (resolves aliases like 易核版→尊享易核版)
  return { lineName, versionName: ctx.canonicalVersionName, seriesName: ctx.series, scenarioName: ctx.scenario }
}

/**
 * Parse product catalog context from folderContext string.
 *
 * Supported formats:
 *   "product_catalog > {category} > {productName}"
 *   "product_catalog > {category} > {productName} > batch:{n}:{mod1},{mod2}"
 *
 * Returns null if not a product catalog context.
 * When a batch segment is present, returns batchModules = [mod1, mod2].
 */
export function parseProductCatalogCtxFromFolderContext(
  folderContext: string | undefined,
): { category: InsuranceCategoryType; productName: string; batchIndex?: number; batchModules?: string[] } | null {
  if (!folderContext) return null
  const parts = folderContext.split(">").map((p) => p.trim())
  if (parts.length < 3) return null
  if (parts[0] !== "product_catalog") return null
  const category = parts[1] as InsuranceCategoryType
  if (!INSURANCE_CATEGORIES.includes(category)) return null
  const productName = parts[2]
  if (!productName) return null

  // Optional batch segment: "batch:{n}:{mod1},{mod2}"
  let batchIndex: number | undefined
  let batchModules: string[] | undefined
  if (parts[3]) {
    const bm = parts[3].match(/^batch:(\d+):(.+)$/)
    if (bm) {
      batchIndex = parseInt(bm[1], 10)
      batchModules = bm[2].split(",").map(s => s.trim()).filter(Boolean)
    }
  }

  return { category, productName, batchIndex, batchModules }
}

/**
 * Build the extraction directive injected into the LLM prompt for product catalog documents.
 * Tells the LLM exactly which wiki files to create and what content to put in each.
 *
 * @param batchModules When provided (batch mode), restrict extraction to ONLY these modules.
 * @param batchIndex   The current batch number. Source summary page generated only on batch 0.
 */
function buildProductCatalogExtractionDirective(
  category: InsuranceCategoryType,
  productName: string,
  sourceFileName: string,
  batchModules?: string[],
  batchIndex?: number,
): string {
  const allModules = PRODUCT_CATALOG_MODULES[category]
  const requiredModules = getRequiredModules(category)
  const inferredModules = inferModulesFromSourceFileName(sourceFileName, category)
  const hintedModules = new Set(inferredModules)

  // In batch mode: only show the modules for this batch
  const targetModules = batchModules && batchModules.length > 0
    ? allModules.filter(m => batchModules.includes(m.moduleName))
    : allModules

  const isBatchMode = !!(batchModules && batchModules.length > 0)
  const isFirstBatch = batchIndex === undefined || batchIndex === 0

  // Build the list of target files
  const allTargetFiles = targetModules.map((m) => {
    const title = buildProductModuleTitle(category, productName, m.moduleName)
    const isInferred = hintedModules.has(m.moduleName)
    const isRequired = requiredModules.includes(m.moduleName)
    const priority = isRequired ? "[必填]" : isInferred ? "[推断相关]" : "[选填]"
    return `  ${priority} wiki/product_catalog/${title}.md  → entity_type: ${m.entityType}`
  })

  return [
    `## 险种产品知识库抽取指令 (PRODUCT CATALOG EXTRACTION — MANDATORY)`,
    ``,
    isBatchMode
      ? `本次提取为批次 ${(batchIndex ?? 0) + 1}，只抽取以下 ${targetModules.length} 个模块，请勿生成其他模块文件。`
      : `本文档为保险险种产品文档，必须按以下规范抽取知识模块：`,
    ``,
    `- **险种类别：** ${category}`,
    `- **产品名称：** ${productName}`,
    `- **源文件：** ${sourceFileName}`,
    isBatchMode ? `- **本批模块：** ${batchModules!.join("、")}` : "",
    ``,
    `### 强制路径规则`,
    `所有产品知识实体文件 MUST 写入 \`wiki/product_catalog/\` 目录（NOT wiki/entities/）。`,
    `文件命名格式：\`wiki/product_catalog/${category}-${productName}-{模块名}.md\``,
    ``,
    `### 本次要生成的模块文件（仅限这些）`,
    allTargetFiles.join("\n"),
    ``,
    `### 抽取规范`,
    `1. 每个模块独立成一个 FILE block，路径为上表中的 \`wiki/product_catalog/...\` 路径`,
    `2. 每个模块文件的 frontmatter 必须包含：`,
    `   - \`entity_type\`: 见上表对应值`,
    `   - \`knowledge_domain: product_catalog\``,
    `   - \`product_name: "${productName}"\``,
    `   - \`insurance_category: "${category}"\``,
    `   - \`dedup_key: "${category}-${productName}-{模块名}"\``,
    `   - \`confidence\`: 1.0 如内容来自原文明确表述；0.7 如由上下文推断`,
    `   - \`inferred_fields\`: 列出所有由推断得出的字段名（非原文直接引用）`,
    `3. 如果某模块在本文档中找不到相关内容，跳过该模块（不生成空文件）`,
    `4. 如果某 [必填] 模块在文档中找不到内容，在 REVIEW 块中标注为 missing-page`,
    isFirstBatch
      ? `5. 还需生成一个 wiki/sources/${sourceFileName.replace(/\.[^.]+$/, "")}.md 原文摘要页（type: source）`
      : `5. 本批次 **无需** 重新生成 wiki/sources/ 摘要页（已在批次0生成）`,
    ``,
    `### 各模块体结构要求`,
    `每个模块文件 body 必须包含：`,
    `- **一句话摘要**（针对该模块的核心信息）`,
    `- **原文依据**（直接引用原文句子，不少于 2 条）`,
    `- **结构化内容**（表格或列表，展示字段值）`,
    `- **待补全信息**（该模块中文档未提供的字段，需人工补充）`,
  ].join("\n")
}

/**
 * Hard override system prompt prefix injected into buildGenerationPrompt when the
 * source is a product catalog document.
 *
 * @param batchModules When provided (batch mode), restrict to ONLY these 2-3 modules.
 * @param batchIndex   Current batch number (0-based). Source page only generated on batch 0.
 */
function buildProductCatalogGenerationOverride(
  category: InsuranceCategoryType,
  productName: string,
  sourceFileName: string,
  batchModules?: string[],
  batchIndex?: number,
): string {
  const allModules = PRODUCT_CATALOG_MODULES[category]
  const requiredModules = getRequiredModules(category)
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")
  const isFirstBatch = batchIndex === undefined || batchIndex === 0
  const isBatchMode = !!(batchModules && batchModules.length > 0)

  // In batch mode: only show the target modules for this batch
  const targetModules = isBatchMode
    ? allModules.filter(m => batchModules!.includes(m.moduleName))
    : allModules

  const moduleTable = targetModules.map((m) => {
    const flag = requiredModules.includes(m.moduleName) ? "[必填]" : "[选填]"
    const path = `wiki/product_catalog/${category}-${productName}-${m.moduleName}.md`
    return `  ${flag} ${path}  (entity_type: ${m.entityType})`
  }).join("\n")

  return [
    `## ⚠️ PRODUCT CATALOG MODE${isBatchMode ? ` — BATCH ${(batchIndex ?? 0) + 1}` : ""} (OVERRIDES ALL DEFAULTS)`,
    ``,
    isBatchMode
      ? `You are a focused product knowledge compiler. This batch extracts ONLY ${targetModules.length} specific modules from the source document.`
      : `You are a product knowledge compiler for an insurance knowledge base.`,
    ``,
    `### ABSOLUTE PATH RULES`,
    `- ✅ ALLOWED: wiki/product_catalog/${category}-${productName}-{模块名}.md`,
    isFirstBatch
      ? `- ✅ ALLOWED: wiki/sources/${sourceBaseName}.md  (source summary — generate once)`
      : `- ❌ DO NOT regenerate wiki/sources/${sourceBaseName}.md  (already done in batch 0)`,
    `- ❌ FORBIDDEN: wiki/entities/ — do not write ANY files here`,
    `- ❌ FORBIDDEN: wiki/concepts/ — do not write ANY files here`,
    `- ❌ FORBIDDEN: per-field entity pages ("交费方式", "等待期" are ATTRIBUTES, not pages)`,
    isBatchMode ? `- ❌ DO NOT generate modules other than: ${batchModules!.join("、")}` : "",
    ``,
    `### TARGET MODULE FILES FOR THIS ${isBatchMode ? "BATCH" : "DOCUMENT"} (ONLY THESE)`,
    moduleTable,
    ``,
    `### MANDATORY FRONTMATTER FIELDS FOR EVERY MODULE FILE`,
    `knowledge_domain: product_catalog`,
    `insurance_category: "${category}"`,
    `product_name: "${productName}"`,
    `dedup_key: "${category}-${productName}-{模块名}"`,
    `entity_type: (see table above for correct value per module)`,
    `confidence: 1.0 for explicitly stated facts; 0.7 for inferred`,
    `inferred_fields: [list of fields NOT directly stated in source text]`,
    ``,
    `### MODULE BODY STRUCTURE (every module file must contain)`,
    `## 一句话摘要\n(one-sentence summary of this module's key facts)`,
    `## 原文依据\n(direct quotes from the source document, minimum 2)`,
    `## 结构化内容\n(table or list of field values)`,
    `## 待补全信息\n(fields not found in this document — need manual fill)`,
    ``,
    `Example:`,
    `---FILE: wiki/product_catalog/${category}-${productName}-${targetModules[0]?.moduleName ?? "产品基础信息"}.md---`,
    `| 字段 | 值 | 置信度 |`,
    `|---|---|---|`,
    `| 交费方式 | 一次性支付 | 1.0 |`,
    `---END FILE---`,
  ].join("\n")
}

import type { ChunkingConfig } from "@/types/wiki"
import { useAuthStore } from "@/stores/auth-store"
import { chunkMarkdown } from "@/lib/text-chunker"

/** Read the logged-in username without using a React hook (safe to call in lib code). */
function _getUploaderUsername(): string {
  try { return useAuthStore.getState().user?.username ?? "unknown" } catch { return "unknown" }
}

const OCR_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif"])
const DIRECT_SOURCE_CHAR_LIMIT = 50000
const LONG_SOURCE_DIGEST_LIMIT = 48000
const LONG_SOURCE_MERGE_BATCH_CHARS = 30000
const OCR_DETAIL_SECTION_MARKER = "<!-- LLM_WIKI_OCR_DETAIL_START -->"
const OCR_DETAIL_SECTION_END_MARKER = "<!-- LLM_WIKI_OCR_DETAIL_END -->"
const SCHEMA_CANDIDATE_AUDIT_MARKER = "<!-- LLM_WIKI_SCHEMA_CANDIDATE_AUDIT_START -->"
const SCHEMA_CANDIDATE_AUDIT_END_MARKER = "<!-- LLM_WIKI_SCHEMA_CANDIDATE_AUDIT_END -->"
const OCR_DETAIL_CHAR_LIMIT = 120000

type IngestProcessingMode = "direct" | "hierarchical-long-document"
type IngestSourceOrigin = "raw" | "ocr-image" | "ocr-pdf"
const ocrSourceContentCache = new Map<string, { content: string; origin: IngestSourceOrigin }>()

function sourceFingerprint(content: string): string {
  let h1 = 0xdeadbeef ^ content.length
  let h2 = 0x41c6ce57 ^ content.length
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`
}

function safeCacheName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "")
  return (base || "source").slice(0, 48)
}

function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "") as T
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item)) as T
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) cleaned[key] = sanitizeJsonValue(item)
    return cleaned as T
  }
  return value
}

function isJsonSourcePath(path: string): boolean {
  return /\.json$/i.test(path)
}

function shouldHashRawSource(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return ["pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif"].includes(ext)
}

async function readSourceCacheContent(sourcePath: string, fallbackContent: string): Promise<string> {
  if (!shouldHashRawSource(sourcePath)) return fallbackContent
  try {
    const file = await readFileAsBase64(sourcePath)
    return file.base64
  } catch {
    return fallbackContent
  }
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return ""
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

function markdownTableCell(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : JSON.stringify(sanitizeJsonValue(value))
  return String(text ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
}

function yamlInlineStringList(items: string[]): string {
  return `[${items.map((item) => yamlScalar(item)).join(", ")}]`
}

function buildDeterministicJsonSourcePage(
  sourceSummaryPath: string,
  fileName: string,
  sourceContent: string,
): string {
  let parsed: unknown = null
  let parseError = ""
  try {
    parsed = JSON.parse(sourceContent)
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err)
  }

  const record = asJsonRecord(parsed)
  const clauseName = stringField(record, ["clauseName", "productName", "planName", "title", "name"])
  const planCode = stringField(record, ["planCode", "actualPlanCode", "productCode", "code"])
  const salesStatus = stringField(record, ["planSalesStatus", "salesStatus", "status"])
  const planType = stringField(record, ["planPlanType", "productType", "type"])
  const salesChannel = stringField(record, ["planSalesChannel", "salesChannel", "channel"])
  const startDate = stringField(record, ["startDate", "effectiveDate", "date"])
  const regulatoryCode = stringField(record, ["sccode", "recordCode", "regulatoryCode"])
  const title = clauseName ? `${clauseName}产品元数据` : `JSON Source: ${fileName}`
  const summaryParts = [
    clauseName ? `产品名称：${clauseName}` : "",
    planCode ? `产品代码：${planCode}` : "",
    salesStatus ? `销售状态：${salesStatus}` : "",
    planType ? `产品类型：${planType}` : "",
  ].filter(Boolean)
  const summary = summaryParts.length > 0
    ? summaryParts.join("；")
    : parseError
      ? `JSON 文件解析失败：${parseError}`
      : `JSON 文件 ${fileName} 的确定性源页面。`
  const fieldEntries = record ? Object.entries(record) : []
  const factRows = fieldEntries.map(([key, value]) =>
    `| \`${markdownTableCell(key)}\` | ${markdownTableCell(value)} |`,
  )
  const attrs = sanitizeJsonValue({
    doc_type: clauseName || planCode ? "product_meta" : "json",
    file_format: "json",
    field_count: fieldEntries.length,
    deterministic_extract: true,
    plan_code: planCode || undefined,
    clause_name: clauseName || undefined,
    parse_error: parseError || undefined,
  })

  return normalizeSchemaFrontmatter([
    "---",
    "type: source",
    "entity_type: source",
    "knowledge_domain: product",
    "domain: product",
    "taxonomy_path: [product, source]",
    `title: ${yamlScalar(title)}`,
    `summary: ${yamlScalar(summary)}`,
    `source_files: ${yamlInlineStringList([fileName])}`,
    `sources: ${yamlInlineStringList([fileName])}`,
    `source_type: ${yamlScalar(clauseName || planCode ? "product_meta" : "json")}`,
    "confidence: 1",
    "status: candidate",
    "needs_review: true",
    `attributes: ${JSON.stringify(attrs)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## 原文事实清单",
    "",
    parseError ? `JSON 解析失败：${parseError}` : `以下字段直接来自 \`${fileName}\`，未经过 LLM 改写。`,
    "",
    fieldEntries.length > 0 ? "| 字段名 | 原始值 |" : "",
    fieldEntries.length > 0 ? "|---|---|" : "",
    ...factRows,
    "",
    clauseName || planCode || salesStatus || planType || salesChannel || startDate || regulatoryCode
      ? "## 产品元数据"
      : "",
    clauseName ? `- 产品名称：${clauseName}` : "",
    planCode ? `- 产品代码：${planCode}` : "",
    salesStatus ? `- 销售状态：${salesStatus}` : "",
    planType ? `- 产品类型：${planType}` : "",
    salesChannel ? `- 销售渠道：${salesChannel}` : "",
    startDate ? `- 生效日期：${startDate}` : "",
    regulatoryCode ? `- 备案/监管编号：${regulatoryCode}` : "",
    "",
    "## 覆盖审计",
    "",
    "- 本页面由 JSON 快速抽取路径生成，字段值来自 JSON 解析结果。",
    "- 原始 JSON 全文保留在下方自动保留区块，用于人工复核和 RAG 精确检索。",
    "- 如果同名 JSON 被再次上传，本 source page 会按最新 raw 文件重写。",
    "",
    buildOcrDetailSection(sourceContent, "raw").trim(),
    "",
  ].filter((line) => line !== "").join("\n"), {
    relativePath: sourceSummaryPath,
    sourceFileName: fileName,
    defaultStatus: "candidate",
    defaultCreatedBy: _getUploaderUsername(),
  })
}

async function fastIngestJsonSource(
  pp: string,
  fileName: string,
  sourceContent: string,
  sourceOrigin: IngestSourceOrigin,
  sourceSummaryPath: string,
  sourceSummaryFullPath: string,
  activityId: string,
): Promise<string[]> {
  const activity = useActivityStore.getState()
  const preparedSource: PreparedIngestSource = {
    content: sourceContent,
    originalChars: sourceContent.length,
    contextChars: sourceContent.length,
    chunkCount: 1,
    processingMode: "direct",
    qualityConfidence: "high",
    qualityNotes: ["JSON source was parsed deterministically without LLM generation."],
  }
  const writtenPaths = [sourceSummaryPath]

  activity.updateItem(activityId, { detail: "JSON source detected - writing deterministic source page..." })
  await createDirectory(`${pp}/wiki/sources`).catch(() => {/* existing directory is fine */})
  await writeFile(
    sourceSummaryFullPath,
    cleanupKnowledgeFrontmatter(buildDeterministicJsonSourcePage(sourceSummaryPath, fileName, sourceContent)),
  )

  const { stampCandidate } = await import("@/lib/knowledge-governance")
  await stampCandidate(sourceSummaryFullPath).catch(() => {/* non-critical */})
  await stampIngestQualityMetadata(sourceSummaryFullPath, preparedSource).catch(() => {/* non-critical */})
  await preserveOcrDetailsInSourcePage(sourceSummaryFullPath, sourceContent, sourceOrigin)
  await saveIngestCache(pp, fileName, sourceContent, writtenPaths)
  await embedWrittenIngestPages(pp, writtenPaths)

  activity.updateItem(activityId, {
    status: "done",
    detail: "JSON source page written without LLM extraction",
    filesWritten: writtenPaths,
    step: undefined,
    newEntities: 0,
    mergedEntities: 0,
  })

  return writtenPaths
}

interface PreparedIngestSource {
  content: string
  originalChars: number
  contextChars: number
  chunkCount: number
  processingMode: IngestProcessingMode
  qualityConfidence: "high" | "medium" | "low"
  qualityNotes: string[]
}

type SchemaCandidateKind =
  | "product"
  | "product_overview"    // product_catalog domain: 险种总览
  | "product_comparison"  // product_catalog domain: 产品横向对比
  | "rate_table"          // product_catalog domain: 费率表
  | "service_benefit"
  | "coverage_rule"
  | "process"
  | "rule"
  | "compliance_rule"
  | "persona"
  | "customer_signal"
  | "selling_scenario"
  | "pitch"
  | "objection_handling"
  | "success_case"
  | "customer_voice"
  | "sales_path"
  | "asset"
  | "source_inventory"

interface SchemaDrivenCandidate {
  title: string
  aliases: string[]
  knowledgeDomain: string
  entityType: SchemaCandidateKind
  universalType: UniversalTypeForCandidate
  required: boolean
  confidence: number
  reason: string
  sourceLines: string[]
}

type UniversalTypeForCandidate = "entity" | "concept" | "process" | "rule" | "data" | "source" | "case"

interface SchemaCandidateSignals {
  serviceManual: boolean
  serviceQa: boolean
  caseStudy: boolean
  productAccessList: boolean
  productTerms: boolean
  salesMaterial: boolean
}

type DocumentIntentDocType =
  | "service_manual"
  | "service_catalog"
  | "service_qa"
  | "service_case"
  | "product_terms"
  | "product_manual"
  | "product_access_list"
  | "product_catalog"          // product_catalog domain: 险种介绍/产品简介
  | "rate_table"               // product_catalog domain: 费率表
  | "product_comparison"       // product_catalog domain: 多产品对比
  | "sales_script"
  | "customer_persona"
  | "case_study"
  | "compliance_rule"
  | "report"
  | "other"

type DocumentSplitStrategy = "by_item" | "by_section" | "by_table_row_group" | "by_page" | "whole"
type DocumentCoverageUnit = "service_item" | "product_row" | "clause" | "section" | "page" | "document"

interface DocumentIntent {
  docType: DocumentIntentDocType
  primaryDomain: string
  secondaryDomains: string[]
  splitStrategy: DocumentSplitStrategy
  estimatedItemCount: number
  targetSchemaKeys: string[]
  coverageUnit: DocumentCoverageUnit
  boundaryHints: {
    headingPatterns: string[]
    tableHeaders: string[]
    itemColumnNames: string[]
    rulePatterns: string[]
  }
}

interface SmartIngestBatch {
  batchId: string
  batchType: "service_table" | "product_table" | "clause_section" | "section" | "page" | "whole"
  title: string
  text: string
  sourcePages: number[]
  targetSchemaKeys: string[]
  expectedCandidateTypes: SchemaCandidateKind[]
}

interface SmartIngestPlan {
  intent: DocumentIntent
  batches: SmartIngestBatch[]
}

const ZH = {
  service: "\u670d\u52a1",
  serviceManual: "\u670d\u52a1\u624b\u518c",
  serviceBenefit: "\u670d\u52a1\u6743\u76ca",
  serviceContent: "\u670d\u52a1\u5185\u5bb9",
  serviceFlow: "\u670d\u52a1\u6d41\u7a0b",
  appointment: "\u9884\u7ea6",
  application: "\u7533\u8bf7",
  frequency: "\u6b21\u6570",
  target: "\u9002\u7528\u5bf9\u8c61",
  majorIllness: "\u91cd\u75be",
  doctor: "\u533b\u751f",
  consultation: "\u95ee\u8bca",
  expert: "\u4e13\u5bb6",
  famousDoctor: "\u540d\u533b",
  checkup: "\u4f53\u68c0",
  escort: "\u966a\u8bca",
  hospitalization: "\u4f4f\u9662",
  surgery: "\u624b\u672f",
  nursing: "\u62a4\u7406",
  rehab: "\u5eb7\u590d",
  activation: "\u6fc0\u6d3b",
  suspension: "\u4e2d\u6b62",
  termination: "\u7ec8\u6b62",
  waitingPeriod: "\u7b49\u5f85\u671f",
  nonSharing: "\u975e\u5171\u4eab",
  disclaimer: "\u514d\u8d23",
  compliance: "\u5408\u89c4",
  productCode: "\u4ea7\u54c1\u4ee3\u7801",
  productName: "\u4ea7\u54c1\u540d\u79f0",
  accessList: "\u51c6\u5165\u6e05\u5355",
  persona: "\u5ba2\u6237\u753b\u50cf",
  pitch: "\u8bdd\u672f",
  objection: "\u5f02\u8bae",
  scenario: "\u573a\u666f",
}

const SERVICE_LIKE_KEYWORDS = [
  ZH.service,
  ZH.doctor,
  ZH.consultation,
  "\u54a8\u8be2",
  ZH.expert,
  ZH.famousDoctor,
  ZH.checkup,
  "\u4f53\u68c0",
  "\u62a5\u544a",
  ZH.appointment,
  "\u534f\u52a9",
  "\u5b89\u6392",
  ZH.escort,
  ZH.hospitalization,
  ZH.surgery,
  ZH.nursing,
  "\u4f1a\u8bca",
  "\u966a\u8bca",
  "\u51fa\u9662",
  ZH.rehab,
  "\u968f\u8bbf",
  "\u9996\u8bbf",
  ZH.majorIllness,
  "\u5bb6\u533b",
  "\u7eff\u901a",
  "\u9662\u540e",
  "\u8bad\u7ec3\u8425",
  "\u7528\u836f",
  "\u6162\u75c5",
  "\u6570\u5b57\u5316",
  "\u7ba1\u7406",
]

const RULE_LIKE_KEYWORDS = [
  "\u89c4\u5219",
  "\u9650\u5236",
  "\u9002\u7528",
  "\u4e0d\u9002\u7528",
  ZH.frequency,
  ZH.waitingPeriod,
  ZH.nonSharing,
  ZH.suspension,
  ZH.termination,
  "\u6709\u6548\u671f",
  "\u6761\u4ef6",
  "\u8303\u56f4",
]

const PROCESS_LIKE_KEYWORDS = [
  ZH.serviceFlow,
  "\u6d41\u7a0b",
  ZH.activation,
  "\u7ed1\u5b9a",
  ZH.application,
  ZH.appointment,
  "\u64cd\u4f5c",
  "\u6b65\u9aa4",
]

const COMPLIANCE_LIKE_KEYWORDS = [
  ZH.disclaimer,
  ZH.compliance,
  "\u4e0d\u627f\u8bfa",
  "\u4e0d\u4fdd\u8bc1",
  "\u4e0d\u5f97",
  "\u7981\u6b62",
  "\u98ce\u9669\u63d0\u793a",
  "\u6cd5\u5f8b\u8d23\u4efb",
  // Service definition/rule terms — must fire BEFORE pitch detection
  "\u5b9a\u4e49\u8bf4\u660e",   // 定义说明
  "\u91cd\u75be\u5b9a\u4e49",   // 重疾定义
  "\u91cd\u75be\u76ee\u5f55",   // 重疾目录
  "\u670d\u52a1\u5b9a\u4e49",   // 服务定义
  "\u975e\u5171\u4eab",         // 非共享
  "\u4e2d\u6b62\u89c4\u5219",   // 中止规则
  "\u7ec8\u6b62\u89c4\u5219",   // 终止规则
  "\u7b49\u5f85\u671f",         // 等待期
]

const GENERIC_CANDIDATE_TITLES = new Set([
  "overview",
  "summary",
  "introduction",
  "ocr text",
  "\u76ee\u5f55",
  "\u524d\u8a00",
  "\u6982\u8ff0",
  "\u80cc\u666f",
  "\u9644\u5f55",
  "\u5907\u6ce8",
  "\u8bf4\u660e",
  "\u5b9a\u4e49",
  "\u5e38\u89c1\u95ee\u9898",
  "\u670d\u52a1\u573a\u666f",
  "\u670d\u52a1\u9636\u6bb5",
  "\u670d\u52a1\u9879\u76ee",
  "\u670d\u52a1\u6b21\u6570",
  "\u670d\u52a1\u6807\u51c6",
  "\u670d\u52a1\u5185\u5bb9",
  "\u542f\u52a8\u6761\u4ef6",
])

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}

function detectSchemaCandidateSignals(content: string): SchemaCandidateSignals {
  return {
    serviceQa: hasAny(content, [
      "Q&A",
      "QA",
      "问答",
      "常见问题",
      "客户问",
      "客户答",
      "问：",
      "答：",
      "Q:",
      "A:",
      "如何解释",
      "怎么解释",
    ]),
    caseStudy: hasAny(content, [
      "案例",
      "服务案例",
      "成交案例",
      "客户案例",
      "客户原声",
      "客户反馈",
      "真实案例",
      "案例背景",
      "关键转折",
      "后续结果",
    ]),
    serviceManual: hasAny(content, [
      ZH.serviceManual,
      ZH.serviceBenefit,
      ZH.serviceContent,
      ZH.serviceFlow,
      "\u670d\u52a1\u4f53\u7cfb",
      "\u670d\u52a1\u671f\u9650",
      ZH.appointment,
      ZH.application,
      ZH.frequency,
      ZH.target,
      "\u91cd\u75be\u5168\u7a0b",
    ]),
    productAccessList: hasAny(content, [
      ZH.accessList,
      ZH.productCode,
      ZH.productName,
      "\u4e3b\u9669\u4ee3\u7801",
      "\u6e20\u9053",
      "\u4ea4\u671f",
      "\u662f\u5426",
      "1+N",
      "PVMargin",
    ]),
    productTerms: hasAny(content, [
      "\u6295\u4fdd\u5e74\u9f84",
      ZH.waitingPeriod,
      "\u4fdd\u9669\u8d23\u4efb",
      "\u8d23\u4efb\u514d\u9664",
      "\u7f34\u8d39\u671f\u95f4",
      "\u4fdd\u969c\u671f\u95f4",
      "\u7406\u8d54",
      "\u5065\u5eb7\u544a\u77e5",
    ]),
    salesMaterial: hasAny(content, [
      "\u5ba3\u4f20",
      "\u5356\u70b9",
      ZH.persona,
      ZH.scenario,
      ZH.pitch,
      ZH.objection,
      "\u4fc3\u6210",
      "\u8f6c\u4ecb\u7ecd",
      "\u9762\u8bbf",
    ]),
  }
}

function estimateServiceTableItemCount(content: string): number {
  const structuredRows = parseServiceInventoryRows(content)
  if (structuredRows.length > 0) return structuredRows.length

  const lines = content.split(/\r?\n/)
  let inServiceTable = false
  let itemIndex = -1
  let count = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.includes("|")) {
      inServiceTable = false
      continue
    }
    const cells = parseMarkdownTableCells(line)
    if (cells.length < 2 || isMarkdownSeparatorRow(cells)) continue

    const possibleItemIndex = findHeaderIndex(cells, [ZH.service + "\u9879\u76ee", "\u6743\u76ca\u9879\u76ee", "\u9879\u76ee"])
    const possibleCountIndex = findHeaderIndex(cells, [ZH.service + "\u6b21\u6570", ZH.frequency, "\u6b21/\u5e74", "\u6b21"])
    if (possibleItemIndex >= 0 && possibleCountIndex >= 0) {
      inServiceTable = true
      itemIndex = possibleItemIndex
      continue
    }

    if (inServiceTable && itemIndex >= 0 && cells.length > itemIndex && isUsableCandidateTitle(cells[itemIndex])) {
      count++
    }
  }

  return count
}

function recognizeDocumentIntent(sourceContent: string): DocumentIntent {
  const signals = detectSchemaCandidateSignals(sourceContent)
  const serviceItems = estimateServiceTableItemCount(sourceContent)
  const productRows = estimateTableLikeRowCount(sourceContent)

  // ── product_catalog domain: 险种/产品库识别 (优先于 product domain) ───────────
  // 识别信号：费率表关键词 OR 险种大类关键词 + 产品代码/备案号 (且不是服务手册)
  const hasRateTableSignal = hasAny(sourceContent, [
    "费率表", "每万元", "年缴保费", "月缴保费", "保费示例", "保费参考",
    "费率", "缴费率", "基本保费",
  ])
  const hasProductCategoryKeyword = hasAny(sourceContent, [
    "重疾险", "医疗险", "年金险", "终身寿险", "定期寿险", "意外险",
    "教育金", "养老金", "护理险", "失能险",
  ])
  const hasProductCodeSignal = hasAny(sourceContent, [
    "产品代码", "险种代码", "主险代码",
    "监管备案", "备案号", "保单号",
    "保险责任", "责任免除", "投保年龄", "保障期间",
  ])
  const hasProductComparisonSignal = hasAny(sourceContent, [
    "产品对比", "险种对比", "方案对比", "对比表", "横向对比",
    "A产品", "B产品", "产品A", "产品B",
  ])
  const isNotServiceManual = !hasAny(sourceContent, [
    "服务手册", "服务次数", "预约", "陪诊", "家庭医生服务",
  ])

  if (hasRateTableSignal && isNotServiceManual) {
    return {
      docType: "rate_table",
      primaryDomain: "product_catalog",
      secondaryDomains: ["product", "compliance"],
      splitStrategy: "by_section",
      estimatedItemCount: productRows,
      targetSchemaKeys: ["insurance.product_catalog.RateTable", "insurance.product_catalog.ProductOverview"],
      coverageUnit: "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^第[一二三四五六七八九十0-9]+"],
        tableHeaders: ["年龄", "性别", "保额", "年缴保费", "月缴保费", "费率"],
        itemColumnNames: ["年龄", "保额", "保费"],
        rulePatterns: ["备注", "说明", "注"],
      },
    }
  }

  if (hasProductComparisonSignal && isNotServiceManual) {
    return {
      docType: "product_comparison",
      primaryDomain: "product_catalog",
      secondaryDomains: ["product", "compliance", "customer"],
      splitStrategy: "by_section",
      estimatedItemCount: 0,
      targetSchemaKeys: ["insurance.product_catalog.ProductComparison", "insurance.product_catalog.ProductOverview"],
      coverageUnit: "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^对比", "^方案"],
        tableHeaders: ["产品名称", "产品代码", "保障责任", "费率", "健康告知"],
        itemColumnNames: ["产品", "方案", "险种"],
        rulePatterns: ["免责", "不承诺", "不保证", "仅供参考"],
      },
    }
  }

  if ((hasProductCategoryKeyword && hasProductCodeSignal) && isNotServiceManual) {
    return {
      docType: "product_catalog",
      primaryDomain: "product_catalog",
      secondaryDomains: ["product", "compliance"],
      splitStrategy: "by_section",
      estimatedItemCount: 0,
      targetSchemaKeys: ["insurance.product_catalog.ProductOverview", "insurance.product_catalog.RateTable"],
      coverageUnit: "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^第[一二三四五六七八九十0-9]+条", "^第[一二三四五六七八九十0-9]+章"],
        tableHeaders: ["保险责任", "责任免除", "等待期", "投保年龄", "产品代码"],
        itemColumnNames: ["险种", "产品", "责任"],
        rulePatterns: ["保险责任", "责任免除", "等待期", "缴费期间", "保障期间"],
      },
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  if (signals.caseStudy && !signals.productAccessList) {
    return {
      docType: "service_case",
      primaryDomain: "cases",
      secondaryDomains: ["product", "method", "customer", "compliance"],
      splitStrategy: "by_section",
      estimatedItemCount: Math.max(1, detectedServiceManualNodes(sourceContent).length),
      targetSchemaKeys: ["insurance.cases.SuccessCase", "insurance.cases.CustomerVoice", "insurance.method.SalesPath", "insurance.product.ServiceBenefit"],
      coverageUnit: "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^案例", "^客户"],
        tableHeaders: ["案例背景", "服务过程", "客户反馈", "亮点"],
        itemColumnNames: ["案例", "客户", "服务项目", "结果"],
        rulePatterns: ["免责", "不承诺", "不保证", "仅供参考"],
      },
    }
  }

  if (signals.serviceQa && (signals.serviceManual || serviceItems >= 3) && !signals.productAccessList) {
    return {
      docType: "service_qa",
      primaryDomain: "method",
      secondaryDomains: ["product", "compliance", "customer"],
      splitStrategy: serviceItems >= 5 ? "by_table_row_group" : "by_section",
      estimatedItemCount: Math.max(serviceItems, detectedServiceManualNodes(sourceContent).length),
      targetSchemaKeys: ["insurance.method.Pitch", "insurance.method.ObjectionHandling", "insurance.product.ServiceBenefit", "insurance.compliance.ComplianceRule"],
      coverageUnit: serviceItems >= 5 ? "service_item" : "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^Q\\d+", "^问[:：]"],
        tableHeaders: ["问题", "回答", "服务项目", "服务次数"],
        itemColumnNames: ["问题", "服务项目", "权益项目"],
        rulePatterns: ["免责", "不承诺", "不保证", "超出", "转机构", "不得"],
      },
    }
  }

  if (signals.serviceManual || serviceItems >= 5) {
    return {
      docType: serviceItems >= 5 ? "service_catalog" : "service_manual",
      primaryDomain: "product",
      secondaryDomains: ["compliance", "method"],
      splitStrategy: serviceItems >= 5 ? "by_table_row_group" : "by_section",
      estimatedItemCount: Math.max(serviceItems, detectedServiceManualNodes(sourceContent).length),
      targetSchemaKeys: ["insurance.product.Product", "insurance.product.ServiceBenefit", "insurance.product.SellingPoint"],
      coverageUnit: serviceItems >= 5 ? "service_item" : "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^第[一二三四五六七八九十0-9]+[章节部分]"],
        tableHeaders: ["服务项目", "服务次数", "服务场景", "服务阶段"],
        itemColumnNames: ["服务项目", "权益项目", "项目"],
        rulePatterns: ["等待期", "非共享", "中止", "终止", "免责", "不承诺", "不保证"],
      },
    }
  }

  if (signals.productAccessList || productRows >= 20) {
    return {
      docType: "product_access_list",
      primaryDomain: "product",
      secondaryDomains: ["compliance"],
      splitStrategy: "by_table_row_group",
      estimatedItemCount: productRows,
      targetSchemaKeys: ["insurance.product.Product", "insurance.product.RegulatoryDoc"],
      coverageUnit: "product_row",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+"],
        tableHeaders: ["产品名称", "产品代码", "主险代码", "渠道", "交期", "是否"],
        itemColumnNames: ["产品名称", "产品代码", "服务项目"],
        rulePatterns: ["1\\*", "N", "是", "否", "备注", "准入"],
      },
    }
  }

  if (signals.productTerms) {
    return {
      docType: "product_terms",
      primaryDomain: "product",
      secondaryDomains: ["compliance"],
      splitStrategy: "by_section",
      estimatedItemCount: 0,
      targetSchemaKeys: ["insurance.product.Product", "insurance.product.RegulatoryDoc"],
      coverageUnit: "clause",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+", "^第[一二三四五六七八九十0-9]+条"],
        tableHeaders: ["保险责任", "责任免除", "等待期", "投保年龄"],
        itemColumnNames: ["条款", "责任", "规则"],
        rulePatterns: ["保险责任", "责任免除", "等待期", "缴费期间", "保障期间", "理赔"],
      },
    }
  }

  if (signals.salesMaterial) {
    return {
      docType: "sales_script",
      primaryDomain: "method",
      secondaryDomains: ["customer", "product", "compliance"],
      splitStrategy: "by_section",
      estimatedItemCount: 0,
      targetSchemaKeys: ["insurance.method.SellingScenario", "insurance.method.Pitch", "insurance.method.ObjectionHandling"],
      coverageUnit: "section",
      boundaryHints: {
        headingPatterns: ["^#{1,6}\\s+"],
        tableHeaders: ["场景", "话术", "异议", "客户"],
        itemColumnNames: ["场景", "话术", "异议"],
        rulePatterns: ["保证", "收益", "一定", "不得"],
      },
    }
  }

  return {
    docType: "other",
    primaryDomain: "general",
    secondaryDomains: [],
    splitStrategy: sourceContent.length > 50000 ? "by_section" : "whole",
    estimatedItemCount: 0,
    targetSchemaKeys: [],
    coverageUnit: sourceContent.length > 50000 ? "section" : "document",
    boundaryHints: {
      headingPatterns: ["^#{1,6}\\s+"],
      tableHeaders: [],
      itemColumnNames: [],
      rulePatterns: [],
    },
  }
}

function pagesInText(text: string): number[] {
  const pages = Array.from(text.matchAll(/<!--\s*Page\s+(\d+)\s*-->/gi))
    .map((match) => Number(match[1]))
    .filter((page) => Number.isFinite(page))
  return Array.from(new Set(pages))
}

function buildWholeBatch(sourceContent: string, intent: DocumentIntent): SmartIngestBatch[] {
  return [{
    batchId: "whole-001",
    batchType: "whole",
    title: "Full document",
    text: sourceContent,
    sourcePages: pagesInText(sourceContent),
    targetSchemaKeys: intent.targetSchemaKeys,
    expectedCandidateTypes: [],
  }]
}

function buildServiceTableBatches(sourceContent: string, intent: DocumentIntent): SmartIngestBatch[] {
  const lines = sourceContent.split(/\r?\n/)
  const batches: SmartIngestBatch[] = []
  let activeRows: string[] = []
  let activeTitle = "Service item table"
  let activePage = 0
  let seenHeader = false
  let itemCount = 0

  const flush = () => {
    if (!seenHeader || activeRows.length === 0) return
    batches.push({
      batchId: `service-table-${String(batches.length + 1).padStart(3, "0")}`,
      batchType: "service_table",
      title: activeTitle,
      text: activeRows.join("\n"),
      sourcePages: activePage > 0 ? [activePage] : pagesInText(activeRows.join("\n")),
      targetSchemaKeys: intent.targetSchemaKeys.length > 0 ? intent.targetSchemaKeys : ["insurance.product.ServiceBenefit"],
      expectedCandidateTypes: intent.docType === "service_qa"
        ? ["service_benefit", "pitch", "objection_handling", "rule", "compliance_rule"]
        : ["service_benefit", "rule", "process", "compliance_rule"],
    })
    activeRows = []
    seenHeader = false
    itemCount = 0
  }

  for (const rawLine of lines) {
    const pageMatch = rawLine.match(/<!--\s*Page\s+(\d+)\s*-->/i)
    if (pageMatch) activePage = Number(pageMatch[1])

    const line = rawLine.trim()
    if (!line.includes("|")) {
      if (seenHeader) flush()
      continue
    }

    const cells = parseMarkdownTableCells(line)
    if (cells.length < 2) continue
    const itemIndex = findHeaderIndex(cells, [ZH.service + "\u9879\u76ee", "\u6743\u76ca\u9879\u76ee", "\u9879\u76ee"])
    const countIndex = findHeaderIndex(cells, [ZH.service + "\u6b21\u6570", ZH.frequency, "\u6b21/\u5e74", "\u6b21"])
    if (itemIndex >= 0 && countIndex >= 0) {
      if (seenHeader) flush()
      seenHeader = true
      activeTitle = "服务项目与次数"
      activeRows = [line]
      itemCount = 0
      continue
    }

    if (!seenHeader) continue
    activeRows.push(line)
    if (!isMarkdownSeparatorRow(cells)) itemCount++
    if (itemCount >= 8) flush()
  }
  flush()

  return batches.length > 0 ? batches : buildWholeBatch(sourceContent, intent)
}

function buildSectionBatches(sourceContent: string, intent: DocumentIntent): SmartIngestBatch[] {
  const lines = sourceContent.split(/\r?\n/)
  const batches: SmartIngestBatch[] = []
  let currentTitle = "Document section"
  let currentLines: string[] = []
  let currentPage = 0

  const flush = () => {
    const text = currentLines.join("\n").trim()
    if (!text) return
    batches.push({
      batchId: `section-${String(batches.length + 1).padStart(3, "0")}`,
      batchType: intent.docType === "product_terms" ? "clause_section" : "section",
      title: currentTitle,
      text,
      sourcePages: currentPage > 0 ? [currentPage] : pagesInText(text),
      targetSchemaKeys: intent.targetSchemaKeys,
      expectedCandidateTypes: expectedCandidateTypesForIntent(intent),
    })
  }

  for (const rawLine of lines) {
    const pageMatch = rawLine.match(/<!--\s*Page\s+(\d+)\s*-->/i)
    if (pageMatch) currentPage = Number(pageMatch[1])

    const heading = rawLine.match(/^(#{1,6})\s+(.+)$/)
    const numberedClause = rawLine.match(/^(第[一二三四五六七八九十0-9]+[章节条部分].*)$/)
    if ((heading || numberedClause) && currentLines.length > 0) {
      flush()
      currentLines = []
    }
    if (heading) currentTitle = normalizeCandidateTitle(heading[2])
    if (numberedClause) currentTitle = normalizeCandidateTitle(numberedClause[1])
    currentLines.push(rawLine)
  }
  flush()

  return batches.length > 0 ? batches : buildWholeBatch(sourceContent, intent)
}

function buildPageBatches(sourceContent: string, intent: DocumentIntent): SmartIngestBatch[] {
  const pageBlocks = sourceContent.split(/(?=<!--\s*Page\s+\d+\s*-->)/i).filter((block) => block.trim())
  if (pageBlocks.length === 0) return buildWholeBatch(sourceContent, intent)
  return pageBlocks.map((text, index) => ({
    batchId: `page-${String(index + 1).padStart(3, "0")}`,
    batchType: "page",
    title: `Page batch ${index + 1}`,
    text,
    sourcePages: pagesInText(text),
    targetSchemaKeys: intent.targetSchemaKeys,
    expectedCandidateTypes: expectedCandidateTypesForIntent(intent),
  }))
}

function expectedCandidateTypesForIntent(intent: DocumentIntent): SchemaCandidateKind[] {
  if (intent.docType === "product_terms") return ["coverage_rule", "rule", "compliance_rule"]
  if (intent.docType === "service_qa") return ["service_benefit", "pitch", "objection_handling", "rule", "compliance_rule"]
  if (intent.docType === "service_case" || intent.docType === "case_study") return ["success_case", "customer_voice", "sales_path", "service_benefit", "compliance_rule"]
  return ["service_benefit", "process", "rule", "compliance_rule"]
}

function buildSmartIngestPlan(sourceContent: string): SmartIngestPlan {
  const intent = recognizeDocumentIntent(sourceContent)
  let batches: SmartIngestBatch[]
  if (intent.splitStrategy === "by_table_row_group") {
    batches = intent.coverageUnit === "service_item"
      ? buildServiceTableBatches(sourceContent, intent)
      : buildSectionBatches(sourceContent, intent)
  } else if (intent.splitStrategy === "by_section") {
    batches = buildSectionBatches(sourceContent, intent)
  } else if (intent.splitStrategy === "by_page") {
    batches = buildPageBatches(sourceContent, intent)
  } else {
    batches = buildWholeBatch(sourceContent, intent)
  }

  return { intent, batches }
}

function buildSmartIngestPlanDigest(plan: SmartIngestPlan): string {
  const lines = [
    "## Smart Ingest Plan",
    "",
    `doc_type: ${plan.intent.docType}`,
    `primary_domain: ${plan.intent.primaryDomain}`,
    `secondary_domains: ${plan.intent.secondaryDomains.join(", ") || "none"}`,
    `split_strategy: ${plan.intent.splitStrategy}`,
    `coverage_unit: ${plan.intent.coverageUnit}`,
    `estimated_item_count: ${plan.intent.estimatedItemCount}`,
    `target_schema_keys: ${plan.intent.targetSchemaKeys.join(", ") || "none"}`,
    `batch_count: ${plan.batches.length}`,
    "",
    "Batches:",
  ]
  for (const batch of plan.batches.slice(0, 20)) {
    lines.push(`- ${batch.batchId} | ${batch.batchType} | pages=${batch.sourcePages.join(",") || "unknown"} | chars=${batch.text.length} | expected=${batch.expectedCandidateTypes.join(",") || "general"}`)
  }
  if (plan.batches.length > 20) lines.push(`- ... ${plan.batches.length - 20} additional batches omitted.`)
  return lines.join("\n")
}

async function persistSmartCompileArtifacts(
  projectPath: string,
  sourceFileName: string,
  plan: SmartIngestPlan,
  candidates: SchemaDrivenCandidate[],
): Promise<void> {
  try {
    const dir = `${projectPath}/.llm-wiki/compile`
    await createDirectory(`${projectPath}/.llm-wiki`).catch(() => {})
    await createDirectory(dir).catch(() => {})
    const payload = {
      sourceFileName,
      generatedAt: new Date().toISOString(),
      intent: plan.intent,
      batches: plan.batches.map((batch) => ({
        batchId: batch.batchId,
        batchType: batch.batchType,
        title: batch.title,
        sourcePages: batch.sourcePages,
        targetSchemaKeys: batch.targetSchemaKeys,
        expectedCandidateTypes: batch.expectedCandidateTypes,
        textChars: batch.text.length,
      })),
      candidates,
      coverage: {
        candidateCount: candidates.length,
        requiredCandidateCount: candidates.filter((candidate) => candidate.required).length,
        coverageUnit: plan.intent.coverageUnit,
        estimatedItemCount: plan.intent.estimatedItemCount,
      },
    }
    await writeFile(`${dir}/${safeCacheName(sourceFileName)}-compile-candidates.json`, JSON.stringify(sanitizeJsonValue(payload), null, 2))
  } catch (err) {
    console.warn("[ingest] Failed to persist smart compile artifacts:", err)
  }
}

function normalizeCandidateTitle(title: string): string {
  return title
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/^[\s#>*\-+|0-9.、:：;；()[\]【】"'“”‘’]+/g, "")
    .replace(/[\s|:：;；()[\]【】"'“”‘’，。,./\\]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function splitCandidateTitle(raw: string): string[] {
  const cleaned = normalizeCandidateTitle(raw)
  if (!cleaned) return []
  const parts = cleaned.split(/\s*(?:\/|、|，|,|；|;|\t)\s*/g)
  return parts
    .map(normalizeCandidateTitle)
    .filter((part) => part.length >= 2 && part.length <= 40)
}

function isUsableCandidateTitle(title: string): boolean {
  if (!title || title.length < 2 || title.length > 40) return false
  if (/^OCR text extracted from\b/i.test(title)) return false
  if (/^[\d\s.\-_/]+$/.test(title)) return false
  if (/^(第?\d+[章节页]?|page\s*\d+)$/i.test(title)) return false
  if (GENERIC_CANDIDATE_TITLES.has(title.toLowerCase())) return false
  if (/^(true|false|null|yes|no|1|0|n)$/i.test(title)) return false
  if (isFieldValueOnlyTitle(title)) return false
  return /[\p{L}\p{N}]/u.test(title)
}

function isFieldValueOnlyTitle(title: string): boolean {
  const t = normalizeCandidateTitle(title)
  if (!t) return true
  if (/^(家庭|每人|首年|年度|服务期内|非共享|不限次|按需|结合客户情况)/.test(t) && /(\d+\s*次|不限次|按需|\/\s*年|年度|服务期内)/.test(t)) return true
  if (/^(家庭|每人)?\s*\d+\s*次\s*(\(非共享\))?\s*(\/|每)?\s*(年|年度|服务期内)?$/.test(t)) return true
  if (/^(家庭|每人)?\s*不限次/.test(t)) return true
  if (/^首年每人\s*\d+\s*次/.test(t)) return true
  if (/^T\s*\+\s*\d+\s*(个)?(工作|自然)?日$/i.test(t)) return true
  if (/^\d+\s*[*xX]\s*\d+\s*(小时|h)?/.test(t)) return true
  if (/^(是|否|有|无|不适用|以实际安排为准)$/.test(t)) return true
  return false
}

function tableLineLooksLikeServiceHeader(cells: string[]): boolean {
  return findHeaderIndex(cells, [ZH.service + "\u9879\u76ee", "\u6743\u76ca\u9879\u76ee", "\u9879\u76ee"]) >= 0 &&
    findHeaderIndex(cells, [ZH.service + "\u6b21\u6570", ZH.frequency, "\u6b21/\u5e74", "\u6b21"]) >= 0
}

function shouldScanTableCellAsCandidate(cell: string, line: string, signals: SchemaCandidateSignals): boolean {
  if (!isUsableCandidateTitle(cell)) return false
  if (!signals.serviceManual) return true
  if (isFieldValueOnlyTitle(cell)) return false
  const context = `${line} ${cell}`
  if (hasAny(context, COMPLIANCE_LIKE_KEYWORDS)) return true
  if (hasAny(context, PROCESS_LIKE_KEYWORDS) && cell.length <= 24) return true
  if (hasAny(context, RULE_LIKE_KEYWORDS) && !hasAny(cell, SERVICE_LIKE_KEYWORDS) && cell.length <= 24) return true
  return false
}

function inferCandidateKind(
  title: string,
  line: string,
  sectionPath: string[],
  signals: SchemaCandidateSignals,
): Pick<SchemaDrivenCandidate, "knowledgeDomain" | "entityType" | "universalType" | "required" | "reason" | "confidence"> | null {
  const context = `${sectionPath.join(" ")} ${line} ${title}`
  if (signals.caseStudy && hasAny(context, ["案例", "服务案例", "客户案例", "服务经过", "关键转折", "后续结果", "亮点"])) {
    return {
      knowledgeDomain: "cases",
      entityType: "success_case",
      universalType: "case",
      required: true,
      confidence: 0.88,
      reason: "Customer/service case narrative detected.",
    }
  }
  if (signals.caseStudy && hasAny(context, ["客户原声", "客户反馈", "客户说", "表示", "评价", "感谢", "认可"])) {
    return {
      knowledgeDomain: "cases",
      entityType: "customer_voice",
      universalType: "data",
      required: true,
      confidence: 0.82,
      reason: "Customer voice or feedback detected in a case source.",
    }
  }
  if (hasAny(context, COMPLIANCE_LIKE_KEYWORDS)) {
    return {
      knowledgeDomain: "compliance",
      entityType: "compliance_rule",
      universalType: "rule",
      required: true,
      confidence: 0.88,
      reason: "Compliance/disclaimer wording detected.",
    }
  }
  if (hasAny(context, [ZH.objection, "\u62d2\u7edd", "\u592a\u8d35", "\u533b\u4fdd", "\u5df2\u7ecf\u6709", "\u7528\u4e0d\u4e0a"])) {
    return {
      knowledgeDomain: "method",
      entityType: "objection_handling",
      universalType: "process",
      required: true,
      confidence: 0.84,
      reason: "Customer objection or response guidance detected.",
    }
  }
  if (hasAny(context, [ZH.pitch, "\u8bdd\u672f", "\u8bf4\u6cd5", "\u600e\u4e48\u8bf4", "\u5982\u4f55\u89e3\u91ca", "\u5ba2\u6237\u95ee", "\u5ba2\u6237\u7b54", "\u95ee\uff1a", "\u7b54\uff1a", "Q:", "A:"])) {
    return {
      knowledgeDomain: "method",
      entityType: "pitch",
      universalType: "process",
      required: true,
      confidence: 0.82,
      reason: "Sales explanation, QA, or reusable pitch guidance detected.",
    }
  }
  if (signals.serviceQa && hasAny(context, ["问题", "回答", "Q", "A", "怎么用", "如何使用", "怎么办", "能否", "是否"])) {
    return {
      knowledgeDomain: "method",
      entityType: "pitch",
      universalType: "process",
      required: true,
      confidence: 0.78,
      reason: "Service QA answer can be reused as customer-facing explanation.",
    }
  }
  if (hasAny(context, PROCESS_LIKE_KEYWORDS)) {
    return {
      knowledgeDomain: "product",
      entityType: "process",
      universalType: "process",
      required: true,
      confidence: 0.84,
      reason: "Reusable process or application flow detected.",
    }
  }
  if (hasAny(context, RULE_LIKE_KEYWORDS)) {
    return {
      knowledgeDomain: "product",
      entityType: "rule",
      universalType: "rule",
      required: true,
      confidence: 0.82,
      reason: "Reusable limit, eligibility, frequency, waiting-period, or lifecycle rule detected.",
    }
  }
  if (hasAny(context, SERVICE_LIKE_KEYWORDS) || (signals.serviceManual && hasAny(sectionPath.join(" "), [ZH.service, ZH.serviceContent, ZH.serviceBenefit]))) {
    return {
      knowledgeDomain: "product",
      entityType: "service_benefit",
      universalType: "entity",
      required: true,
      confidence: 0.86,
      reason: "Independent service benefit detected in a service-oriented document.",
    }
  }
  if (signals.productTerms && hasAny(context, ["\u4ea7\u54c1", "\u4fdd\u969c", "\u8d23\u4efb", "\u6761\u6b3e"])) {
    return {
      knowledgeDomain: "product",
      entityType: "coverage_rule",
      universalType: "rule",
      required: true,
      confidence: 0.78,
      reason: "Product responsibility or clause-like item detected.",
    }
  }
  if (signals.salesMaterial && hasAny(context, [ZH.pitch, "\u8bf4\u6cd5", "\u8bdd\u672f"])) {
    return {
      knowledgeDomain: "method",
      entityType: "pitch",
      universalType: "process",
      required: true,
      confidence: 0.8,
      reason: "Reusable sales pitch detected.",
    }
  }
  if (signals.salesMaterial && hasAny(context, [ZH.objection, "\u62d2\u7edd", "\u592a\u8d35", "\u533b\u4fdd"])) {
    return {
      knowledgeDomain: "method",
      entityType: "objection_handling",
      universalType: "process",
      required: true,
      confidence: 0.8,
      reason: "Reusable objection handling detected.",
    }
  }
  if (signals.salesMaterial && hasAny(context, [ZH.persona, "\u5ba2\u6237", "\u5bb6\u5ead\u652f\u67f1", "\u9ad8\u51c0\u503c"])) {
    return {
      knowledgeDomain: "customer",
      entityType: "persona",
      universalType: "entity",
      required: true,
      confidence: 0.75,
      reason: "Customer persona-like item detected.",
    }
  }
  return null
}

function addSchemaCandidate(
  map: Map<string, SchemaDrivenCandidate>,
  title: string,
  line: string,
  sectionPath: string[],
  signals: SchemaCandidateSignals,
): void {
  const cleaned = normalizeCandidateTitle(title)
  if (!isUsableCandidateTitle(cleaned)) return
  const inferred = inferCandidateKind(cleaned, line, sectionPath, signals)
  if (!inferred) return

  const key = normalizeCoverageTitle(cleaned)
  const existing = map.get(key)
  const sourceLine = line.trim().slice(0, 500)
  if (existing) {
    if (!existing.sourceLines.includes(sourceLine)) existing.sourceLines.push(sourceLine)
    existing.confidence = Math.max(existing.confidence, inferred.confidence)
    existing.required = existing.required || inferred.required
    return
  }

  map.set(key, {
    title: cleaned,
    aliases: [],
    knowledgeDomain: inferred.knowledgeDomain,
    entityType: inferred.entityType,
    universalType: inferred.universalType,
    required: inferred.required,
    confidence: inferred.confidence,
    reason: inferred.reason,
    sourceLines: sourceLine ? [sourceLine] : [],
  })
}

function parseMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return []
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => normalizeCandidateTitle(cell.replace(/<br\s*\/?>/gi, " ")))
}

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))
}

function findHeaderIndex(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.some((name) => header.includes(name)))
}

function addServiceTableCandidates(
  map: Map<string, SchemaDrivenCandidate>,
  lines: string[],
  signals: SchemaCandidateSignals,
): void {
  if (!signals.serviceManual) return

  let activeHeader: string[] | null = null
  let serviceItemIndex = -1
  let serviceCountIndex = -1
  let serviceStageIndex = -1
  let serviceSceneIndex = -1

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.includes("|")) {
      activeHeader = null
      continue
    }

    const cells = parseMarkdownTableCells(line)
    if (cells.length < 2 || isMarkdownSeparatorRow(cells)) continue

    const possibleServiceItemIndex = findHeaderIndex(cells, [ZH.service + "\u9879\u76ee", "\u6743\u76ca\u9879\u76ee", "\u9879\u76ee"])
    const possibleCountIndex = findHeaderIndex(cells, [ZH.service + "\u6b21\u6570", ZH.frequency, "\u6b21/\u5e74", "\u6b21"])
    if (possibleServiceItemIndex >= 0 && possibleCountIndex >= 0) {
      activeHeader = cells
      serviceItemIndex = possibleServiceItemIndex
      serviceCountIndex = possibleCountIndex
      serviceStageIndex = findHeaderIndex(cells, [ZH.service + "\u9636\u6bb5", "\u9636\u6bb5"])
      serviceSceneIndex = findHeaderIndex(cells, [ZH.service + "\u573a\u666f", "\u573a\u666f"])
      continue
    }

    if (!activeHeader || serviceItemIndex < 0 || cells.length <= serviceItemIndex) continue
    const serviceTitle = cells[serviceItemIndex]
    if (!isUsableCandidateTitle(serviceTitle)) continue

    const sourceLineParts = [
      serviceSceneIndex >= 0 && cells[serviceSceneIndex] ? `服务场景：${cells[serviceSceneIndex]}` : "",
      serviceStageIndex >= 0 && cells[serviceStageIndex] ? `服务阶段：${cells[serviceStageIndex]}` : "",
      `服务项目：${serviceTitle}`,
      serviceCountIndex >= 0 && cells[serviceCountIndex] ? `服务次数：${cells[serviceCountIndex]}` : "",
    ].filter(Boolean)

    const sourceLine = sourceLineParts.length > 0 ? sourceLineParts.join("；") : line
    const key = normalizeCoverageTitle(serviceTitle)
    const existing = map.get(key)
    if (existing) {
      if (!existing.sourceLines.includes(sourceLine)) existing.sourceLines.push(sourceLine)
      existing.entityType = "service_benefit"
      existing.universalType = "entity"
      existing.knowledgeDomain = "product"
      existing.required = true
      existing.confidence = Math.max(existing.confidence, 0.93)
      continue
    }

    map.set(key, {
      title: serviceTitle,
      aliases: [],
      knowledgeDomain: "product",
      entityType: "service_benefit",
      universalType: "entity",
      required: true,
      confidence: 0.93,
      reason: "Service item extracted from a service-project table with service count/frequency.",
      sourceLines: [sourceLine],
    })
  }
}

function addStructuredServiceInventoryCandidates(
  map: Map<string, SchemaDrivenCandidate>,
  sourceContent: string,
): void {
  const rows = parseServiceInventoryRows(sourceContent)
  for (const row of rows) {
    const key = normalizeCoverageTitle(row.serviceName)
    const sourceLine = [
      row.serviceScene ? `服务场景：${row.serviceScene}` : "",
      row.serviceStage ? `服务阶段：${row.serviceStage}` : "",
      `服务项目：${row.serviceName}`,
      row.serviceFrequency ? `服务次数：${row.serviceFrequency}` : "",
    ].filter(Boolean).join("；")
    const existing = map.get(key)
    if (existing) {
      if (sourceLine && !existing.sourceLines.includes(sourceLine)) existing.sourceLines.push(sourceLine)
      existing.entityType = "service_benefit"
      existing.universalType = "entity"
      existing.knowledgeDomain = "product"
      existing.required = true
      existing.confidence = Math.max(existing.confidence, 0.96)
      continue
    }
    map.set(key, {
      title: row.serviceName,
      aliases: [],
      knowledgeDomain: "product",
      entityType: "service_benefit",
      universalType: "entity",
      required: true,
      confidence: 0.96,
      reason: "Service benefit row deterministically parsed from service inventory table/OCR text.",
      sourceLines: sourceLine ? [sourceLine] : [],
    })
  }
}

function extractSchemaDrivenCandidates(sourceContent: string, plan = buildSmartIngestPlan(sourceContent)): SchemaDrivenCandidate[] {
  const signals = detectSchemaCandidateSignals(sourceContent)
  const candidates = new Map<string, SchemaDrivenCandidate>()
  const sectionPath: string[] = []
  const lines = sourceContent.split(/\r?\n/)

  addStructuredServiceInventoryCandidates(candidates, sourceContent)

  if (plan.intent.docType === "service_case" || plan.intent.docType === "case_study") {
    candidates.set("case.service_case_review", {
      title: "服务案例复盘",
      aliases: ["服务案例", "客户案例"],
      knowledgeDomain: "cases",
      entityType: "success_case",
      universalType: "case",
      required: true,
      confidence: 0.9,
      reason: "Case-oriented source must create a Cases.SuccessCase page instead of only updating product pages.",
      sourceLines: [],
    })
    candidates.set("case.customer_voice", {
      title: "客户服务体验反馈",
      aliases: ["客户反馈", "客户原声"],
      knowledgeDomain: "cases",
      entityType: "customer_voice",
      universalType: "data",
      required: false,
      confidence: 0.78,
      reason: "Case source may contain customer voice or reusable feedback evidence.",
      sourceLines: [],
    })
  }

  if (plan.intent.docType === "service_qa") {
    candidates.set("method.service_qa_pitch", {
      title: "服务问答解释话术",
      aliases: ["服务QA", "常见问题解释"],
      knowledgeDomain: "method",
      entityType: "pitch",
      universalType: "process",
      required: true,
      confidence: 0.86,
      reason: "Service QA should be reusable as customer-facing explanation and sales enablement.",
      sourceLines: [],
    })
    candidates.set("method.service_boundary_objection", {
      title: "服务边界异议处理",
      aliases: ["服务限制说明", "免责说明异议"],
      knowledgeDomain: "method",
      entityType: "objection_handling",
      universalType: "process",
      required: true,
      confidence: 0.82,
      reason: "Service QA often includes customer concerns about availability, limits, and responsibility boundaries.",
      sourceLines: [],
    })
  }

  for (const batch of plan.batches) {
    if (batch.batchType === "service_table") {
      addServiceTableCandidates(candidates, batch.text.split(/\r?\n/), signals)
    }
  }
  if (plan.batches.every((batch) => batch.batchType !== "service_table")) {
    addServiceTableCandidates(candidates, lines, signals)
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const depth = heading[1].length
      sectionPath.length = Math.max(0, depth - 1)
      sectionPath[depth - 1] = normalizeCandidateTitle(heading[2])
      addSchemaCandidate(candidates, heading[2], line, sectionPath, signals)
      continue
    }

    const bullet = line.match(/^(?:[-*+]\s+|\d{1,3}[.、)]\s+|[一二三四五六七八九十]+[、.]\s*)(.+)$/)
    if (bullet) {
      for (const part of splitCandidateTitle(bullet[1])) {
        addSchemaCandidate(candidates, part, line, sectionPath, signals)
      }
      continue
    }

    if (line.includes("|")) {
      const cells = line.split("|").map(normalizeCandidateTitle).filter(Boolean)
      if (tableLineLooksLikeServiceHeader(cells)) continue
      for (const cell of cells.slice(0, 8)) {
        if (!shouldScanTableCellAsCandidate(cell, line, signals)) continue
        addSchemaCandidate(candidates, cell, line, sectionPath, signals)
      }
    }
  }

  if (signals.productAccessList || isTableLikeSource(sourceContent)) {
    candidates.set("source_inventory", {
      title: "\u539f\u59cb\u6e05\u5355\u660e\u7ec6",
      aliases: ["row_inventory", "table_inventory"],
      knowledgeDomain: "general",
      entityType: "source_inventory",
      universalType: "source",
      required: true,
      confidence: 0.9,
      reason: "Table/list-like source requires row-level preservation on the source page.",
      sourceLines: [],
    })
  }

  return Array.from(candidates.values())
    .sort((a, b) => Number(b.required) - Number(a.required) || b.confidence - a.confidence || a.title.localeCompare(b.title))
    .slice(0, 80)
}

function candidateExcerpt(sourceContent: string, candidate: SchemaDrivenCandidate, maxChars = 1600): string {
  const needles = [candidate.title, ...candidate.aliases].filter(Boolean)
  const snippets: string[] = []
  for (const needle of needles) {
    const idx = sourceContent.indexOf(needle)
    if (idx < 0) continue
    const start = Math.max(0, idx - 500)
    const end = Math.min(sourceContent.length, idx + needle.length + 900)
    snippets.push(sourceContent.slice(start, end).trim())
    if (snippets.join("\n\n").length >= maxChars) break
  }
  if (snippets.length === 0 && candidate.sourceLines.length > 0) {
    snippets.push(candidate.sourceLines.join("\n").slice(0, maxChars))
  }
  return snippets.join("\n\n---\n\n").slice(0, maxChars)
}

function buildSchemaCandidateManifest(
  candidates: SchemaDrivenCandidate[],
  plan?: SmartIngestPlan,
  serviceLineCtx?: { lineName: string; versionName: string } | null,
): string {
  if (candidates.length === 0 && !plan) return ""
  const required = candidates.filter((candidate) => candidate.required)
  const lines = [
    plan ? buildSmartIngestPlanDigest(plan) : "",
    "",
    "## Schema-Driven Candidate Manifest",
    "",
    "The system pre-scanned the source and found reusable knowledge candidates. Treat this manifest as a coverage contract, not as optional suggestions.",
    "For every REQUIRED candidate, either generate a dedicated page or create a REVIEW missing-page item explaining why the source evidence is insufficient.",
    "Do not collapse many required service/rule/process candidates into one generic page.",
    serviceLineCtx
      ? `Domain routing (v2 service hierarchy): service_item → service domain (NOT product); rule/process → product; compliance_rule → compliance; pitch/objection_handling → method; cases → cases.`
      : `Domain routing: service_benefit → product; rule/process for service eligibility/activation/limits → product; compliance_rule → compliance; pitch/objection_handling/QA sales explanation → method; customer/service case narratives → cases.`,
    serviceLineCtx
      ? `\u2757 Service item naming (v2): ALL service_item entity titles MUST follow "${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-{\u670d\u52a1\u9879\u540d\u79f0}". NEVER use bare item names as titles.`
      : "",
    "Field values such as service frequency, time limits, and yes/no flags are attributes of their parent service/rule, not independent pages.",
    "",
    `Candidate count: ${candidates.length}. Required count: ${required.length}.`,
    "",
  ].filter(Boolean)

  for (const candidate of candidates.slice(0, 60)) {
    // In v2 service line context, prefix service_item candidate titles with line-version
    const displayTitle = (serviceLineCtx && (candidate.entityType === "service_item" || candidate.entityType === "service_benefit"))
      ? `${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-${candidate.title}`
      : candidate.title
    const displayDomain = (serviceLineCtx && (candidate.entityType === "service_item" || candidate.entityType === "service_benefit"))
      ? "service"
      : candidate.knowledgeDomain
    const displayType = (serviceLineCtx && candidate.entityType === "service_benefit")
      ? "service_item"
      : candidate.entityType
    const evidence = candidate.sourceLines[0] ? ` | evidence=${candidate.sourceLines[0].slice(0, 180)}` : ""
    lines.push(
      `- ${candidate.required ? "REQUIRED" : "OPTIONAL"} | ${displayTitle} | domain=${displayDomain} | entity_type=${displayType} | type=${candidate.universalType} | confidence=${candidate.confidence.toFixed(2)} | ${candidate.reason}${evidence}`,
    )
  }
  if (candidates.length > 60) lines.push(`- ... ${candidates.length - 60} additional candidates omitted from prompt display.`)
  return lines.join("\n")
}

// ─── Business-driven extraction body specs ───────────────────────────────
//
// These define the EXACT required section structure for each page type.
// ALL fields listed as "必须" must appear in every generated page body.
// Optional fields marked 「可选」 should be added only when evidence exists.
//
// IMPORTANT: Do NOT rename, merge, or omit required sections.
// Field names are used verbatim for downstream RAG retrieval and front-end rendering.

/**
 * Body spec for the MAIN SERVICE VERSION page
 * (e.g., 安有医-颐享版.md — one page per service line + version combination).
 */
const SERVICE_VERSION_PAGE_BODY_SPEC = `
## 服务简介                【必须】对该服务版本的整体说明

## 准入规则                【必须】
### 达标门槛               【必须】持有什么产品/保额/费率才能享受
### 指定产品               【必须】关联的保险产品代码/名称清单
### 生效时间               【必须】服务权益何时生效
### 权益人规则              【必须】主被保险人/家属共享规则

## 服务期限                【必须】服务有效期、续期规则

## 服务详情                【必须】
### 服务入口               【必须】如何触达/激活服务（电话/APP/小程序）
### 服务体系               【必须】含所有服务项目目录及核心内容（列表或表格）
### 服务覆盖范围             【必须】适用地区/医院/人群范围
### 注意事项               【必须】限制条件、免责、合规提示
### 服务流程               【必须】激活→使用→结束的完整步骤

## 触客素材                【必须】销售人员可直接使用的话术/海报/简介

## 常见Q&A                【必须】客户最常问的问题及标准答复（≥5条）
`.trim()

/**
 * Body spec for each INDIVIDUAL SERVICE ITEM page
 * (e.g., 安有医-颐享版-在线问诊.md — one page per service item within a version).
 */
const SERVICE_ITEM_PAGE_BODY_SPEC = `
## 服务项目                【必须】该服务项目名称，说明其在服务体系中的位置
### 服务场景               【必须】该服务项目适用的典型场景（就医前/中/后/日常健康）
### 服务阶段               【必须】所属阶段（预防/急性期/康复/慢病等）
### 服务项目介绍             【必须】完整的服务项目内容描述

## 服务次数                【必须】年度/保单期可用次数及有效期

## 服务内容                【必须】具体提供的内容列表（分项细化）

## 服务标准                【必须】质量标准、时效要求、响应承诺

## 服务启动条件              【必须】触发条件/申请要求/证明材料

## 触客素材                【必须】该服务项的专属销售话术、卖点提炼

## 常见Q&A                【必须】该服务项专属常见问题（≥3条）

---（以下字段按需拓展，有证据才写）---

## 服务特色               【可选】区别于同类产品的差异化优势
## 服务覆盖城市             【可选】若有城市限制，详细列出
## 服务说明               【可选】额外补充说明
## 适用人群               【可选】特定人群限制（年龄/病种/会员等级）
## 服务项目使用流程          【可选】该项目独立的使用步骤（与主版本页流程不同时填写）
## 重要提示               【可选】特别风险提示、合规免责声明
`.trim()

// ─── Business body spec for rule/definition/compliance pages ───────────
/**
 * Body spec for RULE / DEFINITION / COMPLIANCE pages
 * (e.g., 安有医-惠享版-重疾定义说明.md, 服务中止规则.md).
 * Even definition/rule pages MUST include 触客素材 and 常见Q&A.
 */
const SERVICE_RULE_PAGE_BODY_SPEC = `
## 定义与范围              【必须】该规则/定义的精确描述，包括适用范围和查询方式

## 触发条件                【必须】哪些服务在申请时需要满足此规则

## 对服务的影响              【必须】该规则如何影响具体服务的可用性和资格确认

## 客户查询方式              【必须】客户如何查询该定义/规则的详细信息（APP路径/客服电话）

## 触客素材                【必须】销售人员如何将此规则/定义弱化客户顾虑的话术

## 常见Q&A                【必须】客户最常问的问题（≥3条）

---（以下按需拓展）---
## 重要提示               【可选】销售时必须告知客户的注意事项
## 实贻示例               【可选】该规则在实际服务中的应用示例
`.trim()

/**
 * Per-version SOFT reference checklist of expected service items.
 * Passed to the LLM as GUIDANCE only:
 *   ✅ Extract an item if found in the PDF (even if not on this list)
 *   ⚠️  Skip an item if NOT found in the PDF (list is not mandatory)
 *   ✅ Extract a PDF item not on this list (list is not exhaustive)
 */
const SERVICE_VERSION_REFERENCE_ITEMS: Record<string, ReadonlyArray<{ item: string; scenario: string }>> = {
  "安有医/尊享易核版": [
    { item: "在线问诊",       scenario: "院前就医" },
    { item: "门诊预约协助",   scenario: "院前就医" },
    { item: "就医陪诊",       scenario: "院前就医" },
    { item: "高级门诊预约",   scenario: "院前就医" },
    { item: "高级陪诊",       scenario: "院中治疗" },
    { item: "住院安排协助",   scenario: "院中治疗" },
    { item: "住院照护",       scenario: "院中治疗" },
    { item: "手术安排",       scenario: "院中治疗" },
    { item: "专家会诊",       scenario: "院中治疗" },
    { item: "质重就医协助",   scenario: "院中治疗" },
    { item: "国内院外药购药", scenario: "院中治疗" },
    { item: "高端医疗垫付",   scenario: "院中治疗" },
    { item: "高端医疗直付",   scenario: "院中治疗" },
    { item: "出院安排协助",   scenario: "院中治疗" },
    { item: "远程康复指导",   scenario: "院后康复" },
    { item: "上门康复护理",   scenario: "院后康复" },
    { item: "康复门诊协助",   scenario: "院后康复" },
    { item: "康复住院协助",   scenario: "院后康复" },
    { item: "慢病管理",       scenario: "健康管理" },
    { item: "自选健康检测",   scenario: "健康管理" },
  ],
  "安有医/尊享版": [
    { item: "在线问诊",     scenario: "院前就医" },
    { item: "门诊预约协助", scenario: "院前就医" },
    { item: "就医陪诊",     scenario: "院前就医" },
    { item: "高级陪诊",     scenario: "院中治疗" },
    { item: "住院安排协助", scenario: "院中治疗" },
    { item: "住院照护",     scenario: "院中治疗" },
    { item: "手术安排",     scenario: "院中治疗" },
    { item: "专家会诊",     scenario: "院中治疗" },
    { item: "出院安排协助", scenario: "院中治疗" },
    { item: "远程康复指导", scenario: "院后康复" },
    { item: "上门康复护理", scenario: "院后康复" },
    { item: "康复门诊协助", scenario: "院后康复" },
    { item: "慢病管理",     scenario: "健康管理" },
  ],
  "安有医/悦享版": [
    { item: "在线问诊",     scenario: "院前就医" },
    { item: "门诊预约协助", scenario: "院前就医" },
    { item: "就医陪诊",     scenario: "院前就医" },
    { item: "住院安排协助", scenario: "院中治疗" },
    { item: "住院照护",     scenario: "院中治疗" },
    { item: "出院安排协助", scenario: "院中治疗" },
    { item: "远程康复指导", scenario: "院后康复" },
    { item: "慢病管理",     scenario: "健康管理" },
  ],
  "安有医/惠享版": [
    { item: "在线问诊",     scenario: "院前就医" },
    { item: "门诊预约协助", scenario: "院前就医" },
    { item: "就医陪诊",     scenario: "院前就医" },
    { item: "住院安排协助", scenario: "院中治疗" },
    { item: "住院照护",     scenario: "院中治疗" },
    { item: "出院安排协助", scenario: "院中治疗" },
    { item: "远程康复指导", scenario: "院后康复" },
  ],
  "安有医/颐享版": [
    { item: "在线问诊",             scenario: "院前就医" },
    { item: "门诊预约协助",         scenario: "院前就医" },
    { item: "就医陪诊",             scenario: "院前就医" },
    { item: "高级陪诊",             scenario: "院中治疗" },
    { item: "住院安排协助",         scenario: "院中治疗" },
    { item: "住院照护",             scenario: "院中治疗" },
    { item: "手术安排",             scenario: "院中治疗" },
    { item: "专家会诊",             scenario: "院中治疗" },
    { item: "海外重疾住院安排协助", scenario: "院中治疗" },
    { item: "出院安排协助",         scenario: "院中治疗" },
    { item: "远程康复指导",         scenario: "院后康复" },
    { item: "上门康复护理",         scenario: "院后康复" },
    { item: "康复门诊协助",         scenario: "院后康复" },
  ],
}

function buildServiceManualNodeDirective(
  sourceContent: string,
  /** v2: if provided, service_item titles will be prefixed with {lineName}-{versionName}- */
  serviceLineCtx?: { lineName: string; versionName: string },
): string {
  const nodes = detectedServiceManualNodes(sourceContent)
  if (nodes.length === 0) return ""
  const serviceNodes = nodes.filter((node) => node.kind === "service_item")
  const ruleNodes = nodes.filter((node) => node.kind !== "service_item")

  // v2 naming: prefix service item titles with line-version
  const makeItemTitle = (itemName: string): string => {
    if (!serviceLineCtx) return itemName
    return buildServiceItemTitle(serviceLineCtx.lineName, serviceLineCtx.versionName, itemName)
  }

  const prefixNote = serviceLineCtx
    ? `\nNaming convention (v2): each service_item page title MUST follow the pattern "{service_line}-{version}-{item_name}" (e.g., "${makeItemTitle("在线问诊")}"). Do NOT use bare item names like "在线问诊" as the title.`
    : ""

  // P1: FORBIDDEN rules for version-specific extraction
  const forbiddenRules = serviceLineCtx ? [
    `FORBIDDEN: entity_type=service_benefit — use entity_type=service_item for ALL service content from this version handbook. service_benefit is ONLY for cross-version generic concepts.`,
    `FORBIDDEN: bare entity titles without prefix (e.g. "在线问诊", "住院照护"). Every service entity page title MUST start with "${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-".`,
  ] : []

  // P0: inject per-version soft reference checklist
  const versionKey = serviceLineCtx ? `${serviceLineCtx.lineName}/${serviceLineCtx.versionName}` : null
  const refItems = versionKey ? (SERVICE_VERSION_REFERENCE_ITEMS[versionKey] ?? null) : null
  const refSection = (serviceLineCtx && refItems && refItems.length > 0)
    ? [
      "",
      `## Version Reference Service List (SOFT GUIDANCE — ${serviceLineCtx.lineName} ${serviceLineCtx.versionName})`,
      "Use this checklist when scanning the PDF. Rules:",
      "  ✅ Item in list AND found in PDF → MUST generate a separate entity page",
      "  ⚠️  Item in list but NOT in PDF → SKIP it, do not create an empty entity",
      "  ✅ Item found in PDF but NOT in list → STILL extract it",
      "",
      ...refItems.map((r) => `  - [${r.scenario}] ${makeItemTitle(r.item)}`),
    ].join("\n")
    : ""

  return [
    "## Service Manual Node Extraction Requirements",
    "This source appears to be an insurance service manual. Treat service items, process rules, and compliance disclaimers as first-class reusable knowledge nodes.",
    prefixNote,
    ...forbiddenRules,
    refSection,
    "",
    `Detected service/rule candidates (${nodes.length}): ${nodes.map((node) => node.title).join("、")}.`,
    "",
    "Required generation policy:",
    "- Create the main service_line_version page (one per line+version), but do not stop there.",
    serviceLineCtx
      ? `- For each independent service item, generate a dedicated wiki/entities/${serviceLineCtx.lineName}/${serviceLineCtx.versionName}/*.md page with knowledge_domain: service, entity_type: service_item, and title following the v2 naming convention (e.g., "${makeItemTitle("在线问诊")}").`
      : "- For each independent service item, generate a dedicated wiki/entities/*.md page with knowledge_domain: service, entity_type: service_item.",
    "- For service activation, suspension, termination, waiting-period/non-sharing, and disclaimer content, generate dedicated `process`, `rule`, or `compliance_rule` pages.",
    "",
    "=== MAIN SERVICE VERSION PAGE (安有医-颐享版.md style) body spec — ALL sections REQUIRED ===",
    SERVICE_VERSION_PAGE_BODY_SPEC,
    "",
    "=== EACH SERVICE ITEM PAGE body spec — sections marked [必须] are REQUIRED; [可选] only when evidence exists ===",
    SERVICE_ITEM_PAGE_BODY_SPEC,
    "",
    "- Each rule/process/compliance page body must include: 规则定义、触发条件、影响范围、业务含义、销售提示、来源依据、待补全信息.",
    "- Link the main service_line_version page to every generated service_item/rule page using `has_part`, `governed_by`, `requires`, or `uses_process` relations.",
    "- If output budget prevents generating all pages, generate the top business-critical pages first and emit REVIEW missing-page items for every omitted node.",
    "- CRITICAL: Output all page bodies in Chinese. Use the EXACT section headings from the spec above (## 服务简介, ### 达标门槛, ## 服务次数, etc.) — do NOT translate, shorten, or rename them.",
    "",
    serviceNodes.length > 0
      ? `Service item pages expected: ${serviceNodes.map((node) => makeItemTitle(node.title)).join("、")}.`
      : "",
    ruleNodes.length > 0 ? `Rule/process/compliance pages expected: ${ruleNodes.map((node) => node.title).join("、")}.` : "",
  ].filter(Boolean).join("\n")
}

// In v2, actual entity title = {line_name}-{version_name}-{item_name}
// The INSURANCE_SERVICE_MANUAL_NODES defines the canonical item_name and detection aliases.
const INSURANCE_SERVICE_MANUAL_NODES = [
  { title: "家庭医生服务", kind: "service_item", aliases: ["家庭医生"] },
  { title: "在线问诊", kind: "service_item", aliases: ["在线问诊"] },
  { title: "音视频问诊", kind: "service_item", aliases: ["音视频问诊", "音视频随访", "音视频首访"] },
  { title: "名医大咖", kind: "service_item", aliases: ["名医大咖"] },
  { title: "特色体检", kind: "service_item", aliases: ["特色体检", "深度检查", "报告解读"] },
  { title: "21天社群训练营", kind: "service_item", aliases: ["21天社群训练营"] },
  { title: "用药服务", kind: "service_item", aliases: ["用药服务"] },
  { title: "数字化慢病管理", kind: "service_item", aliases: ["数字化管理", "慢病管理"] },
  { title: "门诊预约协助", kind: "service_item", aliases: ["门诊预约协助"] },
  { title: "就医陪诊", kind: "service_item", aliases: ["就医陪诊"] },
  { title: "重疾专案管理", kind: "service_item", aliases: ["重疾专案管理"] },
  { title: "心理咨询", kind: "service_item", aliases: ["心理咨询"] },
  { title: "检查安排协助", kind: "service_item", aliases: ["检查安排协助"] },
  { title: "专家会诊", kind: "service_item", aliases: ["专家会诊"] },
  { title: "海外远程书面咨询", kind: "service_item", aliases: ["海外远程书面咨询"] },
  { title: "国内住院安排协助", kind: "service_item", aliases: ["国内住院安排协助", "住院安排协助"] },
  { title: "手术安排", kind: "service_item", aliases: ["手术安排"] },
  { title: "海外重疾住院安排协助", kind: "service_item", aliases: ["海外重疾住院安排协助"] },
  { title: "住院照护", kind: "service_item", aliases: ["住院照护"] },
  { title: "出院安排协助", kind: "service_item", aliases: ["出院安排协助"] },
  { title: "康复门诊协助", kind: "service_item", aliases: ["康复门诊协助"] },
  { title: "康复住院协助", kind: "service_item", aliases: ["康复住院协助"] },
  { title: "上门护理", kind: "service_item", aliases: ["上门护理"] },
  { title: "康复训练管理", kind: "service_item", aliases: ["康复训练管理"] },
  { title: "服务激活流程", kind: "process", aliases: ["激活权益", "绑定家庭医生", "健康测评", "首访", "建档"] },
  { title: "服务中止规则", kind: "rule", aliases: ["服务中止"] },
  { title: "服务终止规则", kind: "rule", aliases: ["服务终止", "服务终止时间/情形"] },
  { title: "重疾服务等待期与非共享规则", kind: "rule", aliases: ["90天等待期", "非共享", "仅限1人使用"] },
  { title: "合规免责说明", kind: "compliance_rule", aliases: ["不承担", "仅供参考", "最终决定权", "法律责任", "免责"] },
] as const

function detectedServiceManualNodes(sourceContent: string): typeof INSURANCE_SERVICE_MANUAL_NODES[number][] {
  if (!/(服务手册|服务体系|服务内容及标准|服务流程|服务期限|常见问题|家庭医生|重疾全程服务)/i.test(sourceContent)) {
    return []
  }
  return INSURANCE_SERVICE_MANUAL_NODES.filter((node) =>
    node.aliases.some((alias) => sourceContent.includes(alias)),
  )
}


function isImageSourcePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return OCR_IMAGE_EXTS.has(ext)
}

function countUniqueProductLikeCodes(content: string): number {
  return new Set(content.match(/\b\d{4}[A-Z]?\b/g) ?? []).size
}

function estimateTableLikeRowCount(content: string): number {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const numberedRows = lines.filter((line) =>
    /^(?:\|?\s*)\d{1,4}(?:\s*\||[、.．\s])/.test(line),
  ).length
  if (numberedRows > 0) return numberedRows

  const codeRows = lines.filter((line) =>
    /\b\d{4}[A-Z]?\b/.test(line) &&
    /(是|否|1\*|1|N|产品|险|渠道|交期|备注)/i.test(line),
  ).length
  return codeRows
}

function isTableLikeSource(content: string): boolean {
  const hasTableVocabulary = /(序号|产品名称|产品代码|主险代码|渠道|交期|是否|清单|准入|备注|1\+N|PVMargin)/i.test(content)
  const uniqueCodes = countUniqueProductLikeCodes(content)
  const rowCount = estimateTableLikeRowCount(content)
  const markdownRows = (content.match(/^\s*\|.+\|\s*$/gm) ?? []).length
  return hasTableVocabulary && (uniqueCodes >= 20 || rowCount >= 20 || markdownRows >= 20)
}

function buildInsuranceExtractionChecklist(sourceContent: string): string {
  const signals: string[] = []
  if (/(准入|清单|产品代码|主险代码|是否|1\+N|PVMargin|渠道|交期)/i.test(sourceContent)) signals.push("product_access_list")
  if (/(服务手册|服务权益|服务内容|服务流程|预约|申请|次数|有效期|适用对象|不适用|限制|免责)/i.test(sourceContent)) signals.push("service_manual")
  if (/(Q&A|QA|问答|常见问题|问：|答：|客户问|客户答|如何解释|怎么解释)/i.test(sourceContent)) signals.push("service_qa")
  if (/(服务案例|客户案例|成交案例|案例背景|关键转折|客户原声|客户反馈|后续结果)/i.test(sourceContent)) signals.push("case_study")
  if (/(投保年龄|等待期|保险责任|责任免除|缴费期间|保障期间|基本保险金额|理赔|核保|健康告知)/i.test(sourceContent)) signals.push("product_terms")
  if (/(宣传|海报|卖点|客户|场景|话术|异议|促成|转介绍|邀约|面访)/i.test(sourceContent)) signals.push("sales_material")
  const detected = signals.length > 0 ? signals.join(", ") : "general_insurance_source"

  return [
    "## Insurance Extraction Completeness Standard",
    `Detected document signals: ${detected}.`,
    "",
    "This ingestion is for a business demo. The generated Markdown body must be useful when compared with the original document in the frontend.",
    "Do not only write high-level summaries. Extract and display concrete facts, rules, limits, exceptions, and gaps.",
    "",
    "Mandatory source-page sections:",
    "- `原文事实清单`: enumerate the important facts from the source. Use compact tables/lists and keep the original wording where it matters.",
    "- `结构化抽取结果`: map facts into Product / Customer / Method / Content / Activity / Cases / Compliance / General.",
    "- `覆盖审计`: state what has been structured, what is only preserved in the source page, and what is missing or uncertain.",
    "- `待补全信息`: list missing fields from the insurance schema instead of hiding them in frontmatter only.",
    "",
    "If the source is a product access list or service eligibility list:",
    "- Preserve every identifiable row/item on the source page when the list is within a few hundred rows.",
    "- Extract product name, product code, main product code, channel, delivery/payment period, yes/no/1/1*/N flags, service eligibility, remarks, and exceptions.",
    "- Create entity pages for meaningful products, service benefits, eligibility rules, and limitation rules. Do not create hundreds of shallow pages for every row.",
    "- Add claims for representative and business-critical rows; put the full row inventory on the source page.",
    "",
    "If the source is a service manual:",
    "- Extract service name, service category, target product/customer, eligibility, service frequency, time limits, service process, required materials, provider/network, exclusions, disclaimers, customer-facing value, and compliance reminders.",
    "- When a service table/OCR block contains 服务场景、服务阶段、服务项目、服务次数, treat those four columns as deterministic facts. They must be copied into the corresponding service_benefit attributes and visible body.",
    "- Split independent services into `service_benefit`, `process`, `limitation`, and `compliance_rule` pages when they have reusable business value.",
    "- A service manual should usually generate many pages, not only one service-plan page. If it contains family doctor, online consultation, famous-doctor, medical appointment, escort, hospitalization, surgery, nursing, rehabilitation, activation, suspension, termination, waiting-period, non-sharing, or disclaimer rules, these must become dedicated nodes or explicit review gaps.",
    "",
    "If the source is service QA:",
    "- Preserve the exact Q/A facts on the source page, but also create reusable Method pages: `pitch` for customer-facing explanation and `objection_handling` for concerns about limits, availability, responsibility boundaries, or service value.",
    "- Keep service definitions and service limits linked back to Product/service_benefit and Compliance/compliance_rule pages.",
    "",
    "If the source is a service/customer case:",
    "- Create at least one Cases `success_case` or `failure_case` page when the case contains a customer, service journey, result, or lesson.",
    "- Extract customer profile, trigger event, service path, key moments, outcome, lessons learned, customer voice, and linked Product/Method/Compliance nodes.",
    "- Do not force a case-only source into only the product page.",
    "",
    "If the source is product terms or a product brochure:",
    "- Extract positioning, product category, status, effective date, regulatory filing number if present, age range, waiting period, payment periods, coverage periods, responsibilities, exclusions, claim trigger, underwriting basics, service packages, selling points, and compliance limits.",
    "",
    "If the source is sales material:",
    "- Extract target persona, scenario, business phase, pitch, objection, content asset, recommended product, risk wording, and customer-facing claims.",
    "",
    "Coverage rule:",
    "- Any important source fact that is not converted into an entity attribute, relation, or claim must appear either in the source page `原文事实清单` or in `待补全信息` / review items.",
  ].join("\n")
}

function buildFactLayerHints(sourceContent: string, sourceOrigin: IngestSourceOrigin): string {
  const rowCount = estimateTableLikeRowCount(sourceContent)
  const codeCount = countUniqueProductLikeCodes(sourceContent)
  const tableLike = isTableLikeSource(sourceContent)
  const shouldPreserveFacts = sourceOrigin !== "raw" || tableLike || rowCount >= 20 || codeCount >= 20
  if (!shouldPreserveFacts) return ""

  return [
    "## Evidence/Facts Layer Required",
    `Detected source_origin=${sourceOrigin}, estimated_table_rows=${rowCount}, unique_code_count=${codeCount}.`,
    "",
    "This source must be handled as two layers:",
    "1. Source evidence layer: preserve row-level/table-level facts on the source page for exact review and RAG retrieval.",
    "2. Domain entity layer: create concise Product/Customer/Method/etc. pages that link back to the source evidence.",
    "",
    "Rules:",
    "- Do not compress a long product/service eligibility table into only a few sample rows.",
    "- If the source is a product access list, service entitlement list, or eligibility sheet, keep raw rows/items available on wiki/sources/*.md.",
    "- The source summary page must visibly include `原文事实清单` and `覆盖审计`; these sections are required for frontend review.",
    "- For lists within a few hundred rows, include every identifiable row/item on the source page in a compact table or numbered list.",
    "- Add source-page attributes such as raw_item_count, table_columns, row_level_facts_preserved, product_codes, eligibility_rules, service_items when supported by the source.",
    "- Entity pages should summarize business meaning and include claims that cite the source, not duplicate every table row unless the row is itself a major entity.",
    "- If row count or columns are uncertain, set needs_review: true and add knowledge_gaps for manual review.",
  ].join("\n")
}

function buildOcrDetailSection(
  sourceContent: string,
  sourceOrigin: IngestSourceOrigin,
): string {
  const clipped = sourceContent.length > OCR_DETAIL_CHAR_LIMIT
  const preserved = clipped ? sourceContent.slice(0, OCR_DETAIL_CHAR_LIMIT) : sourceContent
  const originLabel =
    sourceOrigin === "ocr-pdf" ? "图片型 PDF OCR"
    : sourceOrigin === "ocr-image" ? "图片 OCR"
    : "文字型文档（直接提取）"
  const rowCount = estimateTableLikeRowCount(sourceContent)
  const codeCount = countUniqueProductLikeCodes(sourceContent)

  return [
    "",
    OCR_DETAIL_SECTION_MARKER,
    "",
    "## 原始全文（自动保留）",
    "",
    `来源类型：${originLabel}`,
    `原文字符数：${sourceContent.length}`,
    `疑似表格行数：${rowCount}`,
    `识别到的唯一产品/代码数：${codeCount}`,
    "",
    "> 这部分是系统自动保留的原始全文，用于人工复核、RAG 精确检索和后续结构化抽取。上方知识卡片可以摘要化，但这里完整保留所有原文，包括费率表、条款原文、数字明细，不得省略。",
    "",
    preserved.trim(),
    "",
    clipped ? `[原文过长，仅保留前 ${OCR_DETAIL_CHAR_LIMIT} 字符；完整内容请查看原始上传文件。]` : "",
    "",
    OCR_DETAIL_SECTION_END_MARKER,
    "",
  ].filter((line) => line !== "").join("\n")
}

async function preserveOcrDetailsInSourcePage(
  sourceSummaryFullPath: string,
  sourceContent: string,
  sourceOrigin: IngestSourceOrigin,
): Promise<void> {
  // Preserve the full original text for ALL ingested files — not just OCR or
  // table-heavy sources. Plain-text PDFs (product terms, fee-rate tables,
  // underwriting rules, etc.) must also land verbatim in the source page so
  // that RAG retrieval and human review can access the exact original wording.
  if (!sourceContent.trim()) return

  try {
    let content = await readFile(sourceSummaryFullPath)
    content = upsertFrontmatterField(content, "ingest_source_origin", sourceOrigin)
    content = upsertFrontmatterField(content, "ocr_text_chars", sourceContent.length)
    content = upsertFrontmatterField(content, "ocr_estimated_table_rows", estimateTableLikeRowCount(sourceContent))
    content = upsertFrontmatterField(content, "ocr_unique_code_count", countUniqueProductLikeCodes(sourceContent))
    content = upsertFrontmatterField(content, "ocr_detail_preserved", "true")

    const detailSection = buildOcrDetailSection(sourceContent, sourceOrigin)
    if (content.includes(OCR_DETAIL_SECTION_MARKER)) {
      content = content.replace(
        new RegExp(`${OCR_DETAIL_SECTION_MARKER}[\\s\\S]*?${OCR_DETAIL_SECTION_END_MARKER}`),
        detailSection.trim(),
      )
    } else {
      content = `${content.trimEnd()}\n\n${detailSection.trim()}\n`
    }

    await writeFile(sourceSummaryFullPath, content)
  } catch (err) {
    console.warn("[ingest:ocr] Failed to preserve OCR details:", err)
  }
}

function buildSchemaCandidateAuditSection(
  candidates: SchemaDrivenCandidate[],
  missingAfterBackfill: SchemaDrivenCandidate[],
  projectPath: string,
): string {
  const required = candidates.filter((candidate) => candidate.required)
  const missingKeys = new Set(missingAfterBackfill.map((candidate) => normalizeCoverageTitle(candidate.title)))
  const rows = required.slice(0, 120).map((candidate) => {
    const status = candidate.entityType === "source_inventory"
      ? "source-page"
      : missingKeys.has(normalizeCoverageTitle(candidate.title))
        ? "missing-review"
        : "page-generated-or-existing"
    const pagePath = candidate.entityType === "source_inventory" ? "" : `wiki/entities/${candidate.title}.md`
    return `| ${candidate.title.replace(/\|/g, "\\|")} | ${candidate.knowledgeDomain} | ${candidate.entityType} | ${status} | ${pagePath} |`
  })

  return [
    SCHEMA_CANDIDATE_AUDIT_MARKER,
    "",
    "## 结构化候选覆盖审计（自动生成）",
    "",
    `候选知识点总数：${candidates.length}`,
    `必须覆盖候选数：${required.length}`,
    `补页后仍缺失：${missingAfterBackfill.length}`,
    "",
    "> 这部分用于演示和人工审核：系统会先从原文/OCR 中枚举服务、规则、流程、合规等可复用知识点，再检查是否已生成独立知识页。它不是最终业务结论，而是知识编译覆盖率审计。",
    "",
    "| 候选知识点 | 所属域 | 实体类型 | 覆盖状态 | 预期页面 |",
    "|---|---|---|---|---|",
    ...rows,
    required.length > 120 ? `| ... | ... | ... | 还有 ${required.length - 120} 项未展开 | ... |` : "",
    "",
    missingAfterBackfill.length > 0
      ? `仍缺失候选：${missingAfterBackfill.map((candidate) => candidate.title).join("、")}`
      : "所有必须候选已生成页面、已有页面或保留在源清单层。",
    "",
    `项目路径：${projectPath}`,
    "",
    SCHEMA_CANDIDATE_AUDIT_END_MARKER,
  ].filter(Boolean).join("\n")
}

async function preserveSchemaCandidateAuditInSourcePage(
  sourceSummaryFullPath: string,
  candidates: SchemaDrivenCandidate[],
  missingAfterBackfill: SchemaDrivenCandidate[],
  projectPath: string,
): Promise<void> {
  if (candidates.length === 0) return
  try {
    let content = await tryReadFile(sourceSummaryFullPath)
    if (!content) return

    const auditSection = buildSchemaCandidateAuditSection(candidates, missingAfterBackfill, projectPath)
    if (content.includes(SCHEMA_CANDIDATE_AUDIT_MARKER)) {
      content = content.replace(
        new RegExp(`${SCHEMA_CANDIDATE_AUDIT_MARKER}[\\s\\S]*?${SCHEMA_CANDIDATE_AUDIT_END_MARKER}`),
        auditSection.trim(),
      )
    } else {
      content = `${content.trimEnd()}\n\n${auditSection.trim()}\n`
    }

    await writeFile(sourceSummaryFullPath, content)
  } catch (err) {
    console.warn("[ingest] Failed to preserve schema candidate audit in source page:", err)
  }
}

async function embedWrittenIngestPages(pp: string, writtenPaths: string[]): Promise<void> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model || writtenPaths.length === 0) return

  try {
    const { embedPage } = await import("@/lib/embedding")
    for (const wpath of writtenPaths) {
      const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
      if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
      try {
        const content = await readFile(`${pp}/${wpath}`)
        const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
        const title = titleMatch ? titleMatch[1].trim() : pageId
        await embedPage(pp, pageId, title, content, embCfg)
      } catch {
        // non-critical
      }
    }
  } catch {
    // embedding module not available
  }
}

/**
 * Resolve the LLM config that the caption pipeline should use.
 * `null` = captioning is OFF, caller should skip the pipeline
 * entirely. Otherwise either the main `llmConfig` (when
 * `useMainLlm` is set) or the dedicated multimodal endpoint
 * fields, projected into the same `LlmConfig` shape so callers
 * pass it through to `streamChat` unchanged.
 */
function resolveCaptionConfig(
  mm: MultimodalConfig,
  mainLlm: LlmConfig,
): LlmConfig | null {
  if (!mm.enabled) return null
  if (mm.useMainLlm) return mainLlm
  return {
    provider: mm.provider,
    apiKey: mm.apiKey,
    model: mm.model,
    ollamaUrl: mm.ollamaUrl,
    customEndpoint: mm.customEndpoint,
    apiMode: mm.apiMode,
    // The caption helper hits `streamChat` directly, which doesn't
    // care about `maxContextSize` (that field is for the analysis
    // / generation prompt-truncation logic). Keep it set so the
    // shape matches LlmConfig.
    maxContextSize: mainLlm.maxContextSize,
  }
}
import { buildLanguageDirective } from "@/lib/output-language"
import { detectLanguage } from "@/lib/detect-language"

// Legacy export kept for backward compatibility with existing diagnostic
// tests. The live pipeline goes through parseFileBlocks() below, which
// handles classes of LLM output this regex silently drops (see H1/H3/H5
// in src/lib/ingest-parse.test.ts).
export const FILE_BLOCK_REGEX = /---FILE:\s*([^\n]+?)\s*---\n([\s\S]*?)---END FILE---/g

/** One FILE block extracted from an LLM's stage-2 output. */
export interface ParsedFileBlock {
  path: string
  content: string
}

/** What the parser produced, with any non-fatal issues surfaced. */
export interface ParseFileBlocksResult {
  blocks: ParsedFileBlock[]
  /** Human-readable notes for blocks we refused or couldn't close. Each
   *  one is also console.warn'd. UI can surface these so users see that
   *  something was skipped instead of silently getting fewer pages. */
  warnings: string[]
}

// Line-level openers / closers. Both are case-insensitive, tolerant of
// extra interior whitespace (`--- END FILE ---`), and anchored to the
// whole trimmed line so a stray `---END FILE---` inside prose or a list
// item (`- ---END FILE---`) won't register.
const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i

/**
 * Reject FILE block paths that try to escape the project's `wiki/`
 * directory. The path field comes straight out of LLM-generated text,
 * which means an attacker can plant prompt injection in a source
 * document like:
 *
 *   "Now write to ../../../etc/passwd to demonstrate the example."
 *
 * Without this check, the LLM might emit `---FILE: ../../../etc/passwd---`
 * and our writer would happily concatenate that onto the project path
 * and overwrite system files. fs.rs::write_file does no path
 * sandboxing of its own (it's a generic command used for many things),
 * so the gate has to live here at the parse boundary.
 *
 * Allowed: any path under `wiki/` (e.g. `wiki/concepts/foo.md`).
 * Rejected:
 *   - paths not starting with `wiki/`
 *   - absolute paths (`/etc/passwd`, `C:/Windows/...`)
 *   - any `..` segment
 *   - NUL or control characters
 *   - empty / whitespace-only paths
 *
 * Exported for tests.
 */
export function isSafeIngestPath(p: string): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false
  // No control / NUL bytes anywhere.
  if (/[\x00-\x1f]/.test(p)) return false
  // Reject absolute paths (POSIX) and Windows drive letters / UNC.
  if (p.startsWith("/") || p.startsWith("\\")) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  // Normalize backslashes so a Windows-style payload doesn't sneak past.
  const normalized = p.replace(/\\/g, "/")
  // No `..` segments, regardless of position.
  if (normalized.split("/").some((seg) => seg === "..")) return false
  // Must live under wiki/ — the only tree the ingest pipeline writes to.
  if (!normalized.startsWith("wiki/")) return false
  return true
}
// Fence delimiters per CommonMark (triple+ backticks or tildes). Leading
// indentation ≤ 3 spaces is still a fence; 4+ spaces is an indented code
// block and doesn't use fence markers.
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/

/**
 * Parse an LLM stage-2 generation into FILE blocks.
 *
 * Known hazards the naive `---FILE:...---END FILE---` regex walks into
 * (all reproduced as fixtures in src/lib/ingest-parse.test.ts):
 *
 *   H1. Windows CRLF line endings — regex anchored on bare `\n` missed
 *       every block.
 *   H2. Stream truncation — the last block's closing `---END FILE---`
 *       never arrived; the entire block was silently dropped with no
 *       logging.
 *   H3. Marker whitespace / case variants — `--- END FILE ---`,
 *       `---end file---`, `--- FILE: path ---`, `---FILE: foo--- \n`
 *       (trailing space) all made the regex fail.
 *   H5. Literal `---END FILE---` inside a fenced code block (e.g. when
 *       the LLM is writing a concept page about our own ingest format)
 *       — lazy match stopped at the first occurrence, truncating the
 *       page and dumping all subsequent real content into no-man's-land.
 *   H6. Empty path — block matched but was silently dropped by a
 *       downstream `!path` check.
 *
 * This parser fixes every one except H2 (which is fundamentally a
 * stream-budget problem), and at least surfaces H2 as a warning so the
 * user isn't left wondering why a page is missing.
 */
export function parseFileBlocks(text: string): ParseFileBlocksResult {
  // H1 fix: normalize CRLF to LF before anything else. Cheap and
  // covers the case where a proxy / server / LLM inserts Windows line
  // endings into the stream.
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  const blocks: ParsedFileBlock[] = []
  const warnings: string[] = []

  let i = 0
  while (i < lines.length) {
    const openerMatch = OPENER_LINE.exec(lines[i])
    if (!openerMatch) {
      i++
      continue
    }
    const path = openerMatch[1].trim()
    i++ // consume opener

    const contentLines: string[] = []
    let fenceMarker: string | null = null // tracks whether we're inside ``` or ~~~
    let fenceLen = 0
    let closed = false

    while (i < lines.length) {
      const line = lines[i]

      // H5 fix: update fence state before checking closer. Only close
      // the fence when we see the same character repeated at least as
      // many times — CommonMark rule. This lets docs-about-our-format
      // quote `---END FILE---` inside code fences without truncating
      // the outer block.
      const fenceMatch = FENCE_LINE.exec(line)
      if (fenceMatch) {
        const run = fenceMatch[1]
        const char = run[0] // '`' or '~'
        const len = run.length
        if (fenceMarker === null) {
          fenceMarker = char
          fenceLen = len
        } else if (char === fenceMarker && len >= fenceLen) {
          fenceMarker = null
          fenceLen = 0
        }
        contentLines.push(line)
        i++
        continue
      }

      // A line matching the closer ONLY counts when we're outside any
      // code fence. Inside a fence, treat it as ordinary body text.
      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true
        i++
        break
      }

      contentLines.push(line)
      i++
    }

    if (!closed) {
      // H2 fix (partial): we can't fabricate content the LLM never
      // sent, but we surface the drop instead of silently hiding it.
      const pathLabel = path || "(unnamed)"
      const msg = `FILE block "${pathLabel}" was not closed before end of stream — likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    if (!path) {
      // H6 fix: surface empty-path blocks.
      const msg = `FILE block with empty path skipped (LLM omitted the path after \`---FILE:\`).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    if (!isSafeIngestPath(path)) {
      // Path-traversal guard. Drops blocks whose path tries to escape
      // wiki/ — see isSafeIngestPath for the threat model.
      const msg = `FILE block with unsafe path "${path}" rejected (must be under wiki/, no .., no absolute paths).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    blocks.push({ path, content: contentLines.join("\n") })
  }

  return { blocks, warnings }
}

/**
 * Build the language rule for ingest prompts.
 * Uses the user's configured output language, falling back to source content detection.
 */
export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

async function streamText(
  llmConfig: LlmConfig,
  messages: Parameters<typeof streamChat>[1],
  signal: AbortSignal | undefined,
  overrides?: Parameters<typeof streamChat>[4],
): Promise<string> {
  let out = ""
  let streamError: Error | null = null
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token) => { out += token },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
    signal,
    overrides,
  )
  if (streamError) throw streamError
  return out.trim()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isTransientLlmError(err: unknown): boolean {
  return /(503|Service Unavailable|service is too busy|429|rate limit|temporarily|timeout|timed out)/i.test(errorMessage(err))
}

function llmLabel(config: LlmConfig): string {
  return config.model || config.provider || "LLM"
}

async function streamTextWithCompileFallback(
  primaryConfig: LlmConfig,
  messages: Parameters<typeof streamChat>[1],
  signal: AbortSignal | undefined,
  overrides: Parameters<typeof streamChat>[4] | undefined,
  activityId: string,
  stageLabel: string,
): Promise<string> {
  try {
    return await streamText(primaryConfig, messages, signal, overrides)
  } catch (err) {
    if (!isTransientLlmError(err)) throw err

    const fallbackConfig = buildVisionLlmConfig()
    if (!fallbackConfig) throw err

    useActivityStore.getState().updateItem(activityId, {
      detail: `${stageLabel}: ${llmLabel(primaryConfig)} is busy; falling back to ${llmLabel(fallbackConfig)}...`,
    })

    try {
      return await streamText(fallbackConfig, messages, signal, overrides)
    } catch (fallbackErr) {
      throw new Error(
        `${stageLabel} failed. primary=${errorMessage(err)}; fallback=${errorMessage(fallbackErr)}`,
      )
    }
  }
}

interface LongSourceChunk {
  text: string
  headingPath: string
  charStart: number
  charEnd: number
}

function hardSplitLongChunk(chunk: LongSourceChunk, maxChars: number, overlapChars: number): LongSourceChunk[] {
  if (chunk.text.length <= maxChars) return [chunk]
  const out: LongSourceChunk[] = []
  const step = Math.max(1, maxChars - Math.max(0, overlapChars))
  for (let offset = 0; offset < chunk.text.length; offset += step) {
    const text = chunk.text.slice(offset, offset + maxChars)
    if (!text.trim()) continue
    out.push({
      text,
      headingPath: chunk.headingPath,
      charStart: chunk.charStart + offset,
      charEnd: chunk.charStart + offset + text.length,
    })
  }
  return out
}

function buildLongSourceChunks(content: string, llmConfig: LlmConfig): LongSourceChunk[] {
  const contextSize = llmConfig.maxContextSize || 100000
  const targetChars = clampInt(contextSize * 0.12, 10000, 22000)
  const maxChars = clampInt(targetChars * 1.25, targetChars, 26000)
  const overlapChars = clampInt(targetChars * 0.08, 600, 1400)

  const semanticChunks = chunkMarkdown(content, {
    targetChars,
    maxChars,
    minChars: 1200,
    overlapChars,
  })

  if (semanticChunks.length === 0 && content.trim()) {
    return hardSplitLongChunk({
      text: content,
      headingPath: "",
      charStart: 0,
      charEnd: content.length,
    }, maxChars, overlapChars)
  }

  return semanticChunks.flatMap((chunk) =>
    hardSplitLongChunk({
      text: chunk.text,
      headingPath: chunk.headingPath,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
    }, maxChars, overlapChars),
  )
}

function buildChunkDigestPrompt(fileName: string, chunkNumber: number, totalChunks: number): string {
  return [
    "You are extracting durable knowledge from one chunk of a long source document.",
    "Return a compact, factual digest. Do not invent facts.",
    "Preserve exact names, dates, numeric data, versions, constraints, and source wording when important.",
    "Resolve local pronouns only when the referent is explicit inside this chunk; otherwise record the unresolved reference.",
    "Use the same language as the source where practical.",
    "",
    "Output Markdown with exactly these sections:",
    "## Entities",
    "- name | type | role | aliases",
    "## Concepts",
    "- name | definition | why it matters",
    "## Claims And Evidence",
    "- claim | evidence text or data | confidence: high/medium/low",
    "## Relations",
    "- subject | relation | object | evidence",
    "## Updates Or Conflicts",
    "- item | update/conflict/uncertain | evidence",
    "## Open References",
    "- phrase | possible referent | uncertainty",
    "",
    `Source file: ${fileName}`,
    `Chunk: ${chunkNumber}/${totalChunks}`,
  ].join("\n")
}

function buildDigestMergePrompt(fileName: string): string {
  return [
    "You are merging chunk-level knowledge digests from a long source document.",
    "Canonicalize duplicate entities and concepts, preserve meaningful aliases, and keep temporal/version differences explicit.",
    "Do not drop niche but important facts, numbers, dates, rules, exclusions, or definitions.",
    "When facts conflict, keep both and label the conflict instead of choosing silently.",
    "Use the same language as the source where practical.",
    "",
    "Output Markdown with these sections:",
    "## Global Entities",
    "## Global Concepts",
    "## Core Claims And Evidence",
    "## Cross-Chunk Relations",
    "## Temporal Or Version Changes",
    "## Conflicts And Review Candidates",
    "## Recommended Wiki Pages",
    "",
    `Source file: ${fileName}`,
  ].join("\n")
}

async function mergeDigestBatch(
  fileName: string,
  llmConfig: LlmConfig,
  digests: string[],
  activityId: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = digests.map((digest, idx) => `### Digest ${idx + 1}\n${digest}`).join("\n\n")
  return streamTextWithCompileFallback(
    llmConfig,
    [
      { role: "system", content: buildDigestMergePrompt(fileName) },
      { role: "user", content: body },
    ],
    signal,
    { temperature: 0.05, max_tokens: 2200 },
    activityId,
    "Long document digest merge",
  )
}

async function mergeDigestsHierarchically(
  fileName: string,
  llmConfig: LlmConfig,
  digests: string[],
  activityId: string,
  signal?: AbortSignal,
): Promise<{ merged: string; failedMerges: number }> {
  let level = digests.filter((d) => d.trim().length > 0)
  let failedMerges = 0
  if (level.length === 0) return { merged: "", failedMerges }

  for (let depth = 0; depth < 5; depth++) {
    const combined = level.join("\n\n")
    if (combined.length <= LONG_SOURCE_DIGEST_LIMIT || level.length === 1) {
      return { merged: combined, failedMerges }
    }

    const next: string[] = []
    let batch: string[] = []
    let batchChars = 0
    for (const digest of level) {
      if (batch.length > 0 && batchChars + digest.length > LONG_SOURCE_MERGE_BATCH_CHARS) {
        try {
          next.push(await mergeDigestBatch(fileName, llmConfig, batch, activityId, signal))
        } catch (err) {
          failedMerges++
          console.warn(`[ingest:long] digest merge failed:`, err)
          next.push(batch.join("\n\n"))
        }
        batch = []
        batchChars = 0
      }
      batch.push(digest)
      batchChars += digest.length
    }
    if (batch.length > 0) {
      try {
        next.push(await mergeDigestBatch(fileName, llmConfig, batch, activityId, signal))
      } catch (err) {
        failedMerges++
        console.warn(`[ingest:long] digest merge failed:`, err)
        next.push(batch.join("\n\n"))
      }
    }
    level = next
  }

  return { merged: level.join("\n\n").slice(0, LONG_SOURCE_DIGEST_LIMIT), failedMerges }
}

function fitLongSourceContext(context: string): string {
  if (context.length <= LONG_SOURCE_DIGEST_LIMIT) return context
  return `${context.slice(0, LONG_SOURCE_DIGEST_LIMIT)}\n\n[...long-document synthesis clipped to fit generation context...]`
}

async function prepareSourceForIngest(
  sourceContent: string,
  fileName: string,
  llmConfig: LlmConfig,
  activityId: string,
  signal?: AbortSignal,
): Promise<PreparedIngestSource> {
  if (sourceContent.length <= DIRECT_SOURCE_CHAR_LIMIT) {
    return {
      content: sourceContent,
      originalChars: sourceContent.length,
      contextChars: sourceContent.length,
      chunkCount: 1,
      processingMode: "direct",
      qualityConfidence: "high",
      qualityNotes: ["Full source content used directly."],
    }
  }

  const activity = useActivityStore.getState()
  const chunks = buildLongSourceChunks(sourceContent, llmConfig)
  const digests: string[] = []
  let failedChunkDigests = 0
  activity.updateItem(activityId, {
    detail: `Long document detected: extracting chunk digests 0/${chunks.length}...`,
  })

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) break
    const chunk = chunks[i]
    activity.updateItem(activityId, {
      detail: `Long document: extracting chunk digest ${i + 1}/${chunks.length}...`,
    })
    const chunkHeader = [
      `File: ${fileName}`,
      `Chunk: ${i + 1}/${chunks.length}`,
      chunk.headingPath ? `Heading path: ${chunk.headingPath}` : "",
      `Character range: ${chunk.charStart}-${chunk.charEnd}`,
      "",
      chunk.text,
    ].filter(Boolean).join("\n")

    try {
      const digest = await streamTextWithCompileFallback(
        llmConfig,
        [
          { role: "system", content: buildChunkDigestPrompt(fileName, i + 1, chunks.length) },
          { role: "user", content: chunkHeader },
        ],
        signal,
        { temperature: 0.05, max_tokens: 1800 },
        activityId,
        `Long document chunk ${i + 1}/${chunks.length}`,
      )
      digests.push(`<!-- chunk:${i + 1} chars:${chunk.charStart}-${chunk.charEnd} -->\n${digest}`)
    } catch (err) {
      failedChunkDigests++
      console.warn(`[ingest:long] chunk digest failed for ${fileName} #${i + 1}:`, err)
      digests.push([
        `<!-- chunk:${i + 1} chars:${chunk.charStart}-${chunk.charEnd} digest:fallback -->`,
        `## Fallback Excerpt`,
        chunk.headingPath ? `Heading path: ${chunk.headingPath}` : "",
        chunk.text.slice(0, 3000),
      ].filter(Boolean).join("\n"))
    }
  }

  activity.updateItem(activityId, { detail: "Long document: merging chunk digests..." })
  const { merged, failedMerges } = await mergeDigestsHierarchically(fileName, llmConfig, digests, activityId, signal)
  const context = fitLongSourceContext([
    `# Long-document synthesis for ${fileName}`,
    "",
    `Original characters: ${sourceContent.length}`,
    `Chunks processed: ${chunks.length}`,
    `Chunk digest failures: ${failedChunkDigests}`,
    `Merge failures: ${failedMerges}`,
    "",
    "This is a hierarchical synthesis of the full source. It replaces raw truncation: every source chunk was processed into a digest before this global context was produced.",
    "",
    merged || digests.join("\n\n"),
  ].join("\n"))

  const qualityNotes = [
    `Long source processed with hierarchical chunk digests (${chunks.length} chunks).`,
    failedChunkDigests > 0 ? `${failedChunkDigests} chunk digest(s) used fallback excerpts.` : "All chunks produced LLM digests.",
    failedMerges > 0 ? `${failedMerges} merge batch(es) used concatenation fallback.` : "Digest merge completed normally.",
  ]

  return {
    content: context,
    originalChars: sourceContent.length,
    contextChars: context.length,
    chunkCount: Math.max(1, chunks.length),
    processingMode: "hierarchical-long-document",
    qualityConfidence: failedChunkDigests === 0 && failedMerges === 0 ? "medium" : "low",
    qualityNotes,
  }
}

/**
 * Auto-ingest: reads source → LLM analyzes → LLM writes wiki pages, all in one go.
 * Used when importing new files.
 *
 * Concurrency: this function holds a per-project lock for its full
 * duration. Two simultaneous calls for the same project (e.g. queue
 * + Save-to-Wiki) take turns. The lock is necessary because the
 * analysis stage reads `wiki/index.md` and the generation stage
 * overwrites it; without serialization, each call would emit an
 * "updated" index based on the same pre-state and overwrite each
 * other's additions.
 */
/** Options for autoIngest / autoIngestImpl */
export interface IngestOptions {
  /**
   * When true, skip per-file Identity Pass and Global Relation Pass.
   * Use this for batch ingestion: run relation passes once after queue drains.
   * Dramatically increases throughput when ingesting many files at once.
   */
  skipRelationPass?: boolean
}

export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  options?: IngestOptions,
): Promise<string[]> {
  return withProjectLock(normalizePath(projectPath), () =>
    autoIngestImpl(projectPath, sourcePath, llmConfig, signal, folderContext, options),
  )
}

async function autoIngestImpl(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  options?: IngestOptions,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  // Read chunking config from active project (if any)
  const chunking = useWikiStore.getState().project?.chunking
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  // Detect service hierarchy context from upload path (v2 schema)
  // e.g. raw/sources/臻享家医/V1/file.pdf → { lineName: "臻享家医", versionName: "V1" }
  const relativeSourcePath = sp.startsWith(pp + "/") ? sp.slice(pp.length + 1) : sp
  const serviceLineCtx = extractServiceLineCtxFromPath(relativeSourcePath)
  logDiag.debug("autoIngestImpl ENTRY", { file: fileName, project: pp, source: sp })
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })

  const [rawSourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])
  const sourceCacheContent = await readSourceCacheContent(sp, rawSourceContent)

  // ── Image-PDF OCR: detect scanned PDFs and run vision-model OCR ──
  let sourceContent = rawSourceContent
  let sourceOrigin: IngestSourceOrigin = "raw"
  const rawCacheKey = `${sp}|${rawSourceContent.length}`
  if (isImagePdf(rawSourceContent)) {
    const pdfOcrCacheDir = `${pp}/.llm-wiki/ocr-cache/${safeCacheName(fileName)}-${sourceFingerprint(rawSourceContent)}`
    const cached = ocrSourceContentCache.get(rawCacheKey)
    if (cached) {
      sourceContent = cached.content
      sourceOrigin = cached.origin
      activity.updateItem(activityId, { detail: "Reusing cached PDF OCR text..." })
      logOCR.debug("pdf-ocr cache hit", { file: fileName, chars: sourceContent.length })
    } else {
      activity.updateItem(activityId, { detail: "Scanned PDF detected — running OCR..." })
      const visionCfg = buildVisionLlmConfig()
      if (visionCfg) {
      try {
        sourceContent = await ocrImagePdf(rawSourceContent, visionCfg, {
          signal,
          cacheDir: pdfOcrCacheDir,
          onProgress: (done, total) =>
            activity.updateItem(activityId, {
              detail: `OCR: page ${done}/${total}...`,
            }),
        })
        sourceOrigin = "ocr-pdf"
        ocrSourceContentCache.set(rawCacheKey, { content: sourceContent, origin: sourceOrigin })
        logOCR.info("pdf-ocr complete", { file: fileName, chars: sourceContent.length })
      } catch (err) {
        logOCR.warn("pdf-ocr failed", { file: fileName, error: err instanceof Error ? err.message : String(err) })
        activity.updateItem(activityId, {
          status: "error",
          detail: `PDF OCR failed: ${err instanceof Error ? err.message : err}. Configure VISION_ENDPOINT in server settings.`,
        })
        // Non-fatal: fall through with empty content so the pipeline
        // at least generates a stub source-summary page.
        sourceContent = `(图片型 PDF — OCR 失败。请在服务器配置中设置 VISION_ENDPOINT 和 VISION_MODEL。文件: ${fileName})`
      }
      } else {
      // Vision model not configured → friendly message in the wiki
      sourceContent = `(图片型 PDF — 服务器未配置视觉模型 VISION_ENDPOINT，无法 OCR。文件: ${fileName})`
      logOCR.warn("pdf-ocr skipped: no vision config", { file: fileName })
      }
    }
  } else if (isImageSourcePath(sp)) {
    const visionCfg = buildVisionLlmConfig()
    if (visionCfg) {
      try {
        const image = await readFileAsBase64(sp)
        const imageCacheKey = `${sp}|${image.base64.length}`
        const cached = ocrSourceContentCache.get(imageCacheKey)
        if (cached) {
          sourceContent = cached.content
          sourceOrigin = cached.origin
          activity.updateItem(activityId, { detail: "Reusing cached image OCR text..." })
          logOCR.debug("image-ocr cache hit", { file: fileName, chars: sourceContent.length })
        } else {
          activity.updateItem(activityId, { detail: "Image file detected - running OCR..." })
          const ocrText = await ocrImageBytes(image.base64, image.mimeType, visionCfg, signal)
          if (ocrText) {
            sourceContent = `# OCR text extracted from ${fileName}\n\n${ocrText}`
            sourceOrigin = "ocr-image"
            ocrSourceContentCache.set(imageCacheKey, { content: sourceContent, origin: sourceOrigin })
          }
        }
      } catch (err) {
        console.warn(`[ingest:image-ocr] OCR failed for "${fileName}":`, err)
      }
    }
  }

  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`

  if (isJsonSourcePath(sp)) {
    try {
      return await fastIngestJsonSource(
        pp,
        fileName,
        sourceContent,
        sourceOrigin,
        sourceSummaryPath,
        sourceSummaryFullPath,
        activityId,
      )
    } catch (err) {
      activity.updateItem(activityId, {
        status: "error",
        detail: `JSON ingest failed: ${errorMessage(err)}`,
      })
      throw err
    }
  }

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  //
  // Image cascade still runs on cache hits. Reason: a user may have
  // ingested this source on a previous app version that didn't extract
  // images yet, or the media dir may have been deleted out from under
  // us. `extractAndSaveSourceImages` + injection are both idempotent
  // (deterministic output paths, marker-bracketed replacement), so
  // re-running them costs only the extraction time and converges the
  // source-summary page on the current pipeline's contract regardless
  // of when the file was first ingested.
  const cachedFiles = await checkIngestCache(pp, fileName, sourceCacheContent)
  console.log(`[ingest:diag] cache check for "${fileName}":`, cachedFiles === null ? "MISS (full pipeline)" : `HIT (${cachedFiles.length} cached files)`)
  if (cachedFiles !== null) {
    try {
      console.log(`[ingest:diag] cache-hit branch: starting image extraction for ${sp}`)
      const savedImages = await extractAndSaveSourceImages(pp, sp)
      console.log(`[ingest:diag] cache-hit branch: got ${savedImages.length} image(s)`)
      if (savedImages.length > 0) {
        // Caption first (populates the cache), THEN inject — the
        // safety-net section uses the cache to populate alt text.
        // Doing them in this order means cache-hit re-runs (e.g.
        // user re-imports an old PDF after captioning was added)
        // converge: first run grows the cache, second run uses it.
        //
        // Master-toggle gate: when multimodal is OFF the entire
        // image-cascade is skipped here. This matches the
        // full-pipeline branch's strip-and-skip behavior for the
        // cache-hit path, so a user re-importing an old file
        // after disabling captioning sees images disappear from
        // the wiki side. (If a previous ingest had already written
        // a `## Embedded Images` block, it stays — re-import
        // doesn't proactively scrub old wiki content. The user
        // would need to delete the wiki/sources/<slug>.md page
        // to start clean.)
        const mmCfg = useWikiStore.getState().multimodalConfig
        if (!mmCfg.enabled) {
          console.log(
            `[ingest:caption] cache-hit + disabled — skipping caption + safety-net inject (${savedImages.length} image(s) untouched on disk)`,
          )
        } else {
          const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
          if (captionLlm) {
            try {
              await captionMarkdownImages(pp, sourceContent, captionLlm, {
                signal,
                shouldCaption: (url) =>
                  url.startsWith(`${pp}/wiki/media/${fileName.replace(/\.[^.]+$/, "")}/`),
                urlToAbsPath: (url) => url,
                concurrency: mmCfg.concurrency,
                onProgress: (done, total) =>
                  activity.updateItem(activityId, {
                    detail: `Captioning images... ${done}/${total}`,
                  }),
              })
            } catch (err) {
              console.warn(
                `[ingest:caption] cache-hit caption pass failed:`,
                err instanceof Error ? err.message : err,
              )
            }
          }
          await injectImagesIntoSourceSummary(pp, fileName, savedImages)
          // Re-embed the source-summary page so caption text lands
          // in the search index. Without this step, search by image
          // content stays empty for files ingested before captioning
          // was added — the safety-net section was just rewritten
          // with captions, but the embeddings still reflect the old
          // empty-alt content.
          await reembedSourceSummary(pp, fileName)
        }
      } else {
        console.log(`[ingest:diag] cache-hit branch: skipping injection (no images returned from extraction)`)
      }
    } catch (err) {
      console.warn(
        `[ingest:images] cache-hit injection failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
    }
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    await preserveOcrDetailsInSourcePage(sourceSummaryFullPath, sourceContent, sourceOrigin)
    return cachedFiles
  }

  // ── Step 0.5: Extract embedded images ─────────────────────────
  // Pulls every embedded image out of PDF / PPTX / DOCX into
  // `wiki/media/<source-slug>/`. We DON'T inject the markdown
  // references into sourceContent here — without VLM captions
  // (Phase 3a) the alt text is empty, which gives the LLM no
  // semantic signal to preserve them. The LLM tends to silently
  // strip empty-alt images when summarizing.
  //
  // Instead, the markdown section is appended to the source-summary
  // page on disk AFTER writeFileBlocks (see Step 5b below). That
  // guarantees images appear in `wiki/sources/<slug>.md` regardless
  // of LLM behavior. Once Phase 3a lands, we'll re-introduce the
  // sourceContent injection because the captioned alt-text gives
  // the LLM something meaningful to work with.
  //
  // Failure here is never fatal — extractAndSaveSourceImages logs
  // and returns [] on any error.
  activity.updateItem(activityId, { detail: "Extracting embedded images..." })
  console.log(`[ingest:diag] full-pipeline branch: starting image extraction for ${sp}`)
  const savedImages = await extractAndSaveSourceImages(pp, sp)
  console.log(`[ingest:diag] full-pipeline branch: got ${savedImages.length} image(s)`)
  if (savedImages.length > 0) {
    console.log(
      `[ingest:images] saved ${savedImages.length} image(s) for "${fileName}" → wiki/media/${fileName.replace(/\.[^.]+$/, "")}/`,
    )
  }

  // ── Step 0.6: Caption embedded images ─────────────────────────
  // Now that read_file's combined extraction has put `![](abs_path)`
  // markers inline in `sourceContent`, walk them and replace the
  // empty alt text with a vision-model-generated factual caption.
  // SHA-256-keyed cache (`<project>/.llm-wiki/image-caption-cache.json`)
  // dedupes across runs and across documents (shared logos / chart
  // templates caption once, not once per document).
  //
  // Why this matters: an empty-alt image gets paraphrased away by
  // text summarization. With a caption, the alt text carries enough
  // semantic load that the generation LLM tends to preserve the
  // image reference inline at the right paragraph.
  //
  // Scope: we only caption images whose absolute path lives under
  // <project>/wiki/media/<source-slug>/ — i.e. images the current
  // ingest produced. User-typed external URLs in markdown source
  // documents are passed through untouched.
  //
  // Master-toggle behavior: when `multimodalConfig.enabled` is
  // false, we don't just skip the caption LLM call — we ALSO
  // strip `![](url)` references from sourceContent before the LLM
  // sees it, AND skip the post-write safety-net injection further
  // down. Net effect: the wiki-side pipeline never references
  // images at all. Without the strip + skip, image references
  // would leak via two paths:
  //   1. The LLM-generation prompt sees them in sourceContent and
  //      can preserve them in the generated wiki pages
  //   2. injectImagesIntoSourceSummary unconditionally appends a
  //      `## Embedded Images` section to wiki/sources/<slug>.md
  // Both paths land image refs into wiki pages, which then get
  // embedded → searchable → visible in the search image grid even
  // though the user disabled captioning. This was the user-
  // surprising behavior that prompted the fix.
  //
  // Rust extraction itself is untouched: images still land on disk
  // under wiki/media/<slug>/ (cheap), and the raw-source preview
  // (which renders read_file output directly) still shows them —
  // that surface is "the source document as-is", separate from
  // "the curated wiki knowledge".
  let enrichedSourceContent = sourceContent
  const mmCfg = useWikiStore.getState().multimodalConfig
  const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
  if (!mmCfg.enabled && savedImages.length > 0) {
    // Strip `![alt](url)` references — match the same regex shape
    // we use elsewhere for image refs. Preserve a single space
    // where the ref used to sit so adjacent words don't fuse.
    enrichedSourceContent = sourceContent.replace(
      /!\[[^\]]*\]\([^)\s]+\)/g,
      " ",
    )
    console.log(
      `[ingest:caption] disabled — stripped image refs from sourceContent (${savedImages.length} image(s) won't appear in wiki pages)`,
    )
  } else if (
    captionLlm &&
    savedImages.length > 0 &&
    /!\[\]\(/.test(sourceContent)
  ) {
    activity.updateItem(activityId, { detail: "Captioning images..." })
    const sourceSlug = fileName.replace(/\.[^.]+$/, "")
    const ourMediaPrefix = `${pp}/wiki/media/${sourceSlug}/`
    try {
      const result = await captionMarkdownImages(pp, sourceContent, captionLlm, {
        signal,
        // Strict filter: only caption images we know we just
        // extracted into this source's media directory. Skips any
        // pre-existing markdown image refs the user may have typed
        // into the source content (e.g. for hand-authored .md
        // sources).
        shouldCaption: (url) => url.startsWith(ourMediaPrefix),
        urlToAbsPath: (url) => url, // already absolute in our extraction output
        concurrency: mmCfg.concurrency,
        onProgress: (done, total) =>
          activity.updateItem(activityId, {
            detail: `Captioning images... ${done}/${total}`,
          }),
      })
      enrichedSourceContent = result.enrichedMarkdown
      console.log(
        `[ingest:caption] images=${savedImages.length} fresh=${result.freshCaptions} cached=${result.cachedCaptions} failed=${result.failed}`,
      )
    } catch (err) {
      console.warn(
        `[ingest:caption] pipeline failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
      // Fall through with original (empty-alt) source content —
      // captioning failure must NEVER break ingest.
    }
  }

  const preparedSource = await prepareSourceForIngest(
    enrichedSourceContent,
    fileName,
    llmConfig,
    activityId,
    signal,
  )
  const sourceForPrompts = preparedSource.content
  const smartIngestPlan = buildSmartIngestPlan(enrichedSourceContent)
  // For product catalog documents, skip schema candidate extraction — they generate
  // per-field entity pages (e.g. "交费方式", "等待期") which pollute wiki/entities/.
  // Product catalog has its own module-based extraction system.
  const productCtxForIngest = parseProductCatalogCtxFromFolderContext(folderContext)
  const schemaCandidates = productCtxForIngest
    ? []
    : extractSchemaDrivenCandidates(enrichedSourceContent, smartIngestPlan)
  const schemaCandidateManifest = buildSchemaCandidateManifest(schemaCandidates, smartIngestPlan, serviceLineCtx)
  await persistSmartCompileArtifacts(pp, fileName, smartIngestPlan, schemaCandidates)
  if (schemaCandidates.length > 0) {
    activity.updateItem(activityId, {
      detail: `Smart ingest: ${smartIngestPlan.intent.docType}, ${smartIngestPlan.batches.length} batch(es), ${schemaCandidates.filter((candidate) => candidate.required).length}/${schemaCandidates.length} required candidates...`,
    })
  }

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  activity.updateItem(activityId, {
    detail: preparedSource.processingMode === "hierarchical-long-document"
      ? "Step 1/2: Analyzing long-document synthesis..."
      : "Step 1/2: Analyzing source...",
  })

  let analysis = ""
  const factLayerHints = buildFactLayerHints(enrichedSourceContent, sourceOrigin)
  const analysisMessages: Parameters<typeof streamChat>[1] = [
    { role: "system", content: buildAnalysisPrompt(purpose, index, sourceForPrompts, chunking, schemaGuidance(schema), serviceLineCtx) },
    {
      role: "user",
      content: [
        "Analyze this source document:",
        "",
        `**File:** ${fileName}`,
        folderContext ? `**Folder context:** ${folderContext}` : "",
        // Product catalog extraction directive (higher priority than service line context)
        (() => {
          const productCtx = parseProductCatalogCtxFromFolderContext(folderContext)
          if (productCtx) {
            return buildProductCatalogExtractionDirective(productCtx.category, productCtx.productName, fileName)
          }
          return null
        })(),
        serviceLineCtx && !parseProductCatalogCtxFromFolderContext(folderContext)
          ? [
              `**Service hierarchy context (v2):** 系列=${serviceLineCtx.seriesName} | 场景=${serviceLineCtx.scenarioName} | 服务线=${serviceLineCtx.lineName} | 版本=${serviceLineCtx.versionName}`,
              `**Entity naming rule:** All service_item entities extracted from this file MUST be titled "${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-{服务项名称}", e.g. "${buildServiceItemTitle(serviceLineCtx.lineName, serviceLineCtx.versionName, "在线问诊")}"`,
              `**entity_type for service items:** service_item (NOT service_benefit)`,
              `**knowledge_domain for service items:** service`,
            ].join("\n")
          : "",
        `**Processing mode:** ${preparedSource.processingMode}`,
        factLayerHints,
        schemaCandidateManifest,
        "---",
        "",
        sourceForPrompts,
      ].filter(Boolean).join("\n"),
    },
  ]

  try {
    analysis = await streamTextWithCompileFallback(
      llmConfig,
      analysisMessages,
      signal,
      { temperature: 0.1 },
      activityId,
      "Analysis",
    )
  } catch (err) {
    activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${errorMessage(err)}` })
    throw err
  }

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes the analysis as context and produces wiki files + review items
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })

  let generation = ""
  const generationMessages: Parameters<typeof streamChat>[1] = [
    { role: "system", content: buildGenerationPrompt(schema, purpose, index, fileName, overview, sourceForPrompts, chunking, _getUploaderUsername(), preparedSource, serviceLineCtx, productCtxForIngest) },
    {
      role: "user",
      content: [
        `Source document to process: **${fileName}**`,
        // Product catalog: re-inject the module directive into the user message (reinforcement)
        (() => {
          if (productCtxForIngest) {
            return [
              buildProductCatalogExtractionDirective(
                productCtxForIngest.category,
                productCtxForIngest.productName,
                fileName,
                productCtxForIngest.batchModules,
                productCtxForIngest.batchIndex,
              ),
            ].join("\n")
          }
          return null
        })(),
        serviceLineCtx && !parseProductCatalogCtxFromFolderContext(folderContext)
          ? [
              `**Service hierarchy context (v2):** ${serviceLineCtx.lineName}-${serviceLineCtx.versionName}`,
              `**Entity naming rule:** service_item page titles = "${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-{服务项名称}"`,
            ].join("\n")
          : "",
        factLayerHints,
        schemaCandidateManifest,
        "",
        "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
        "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
        "blocks as specified in the system prompt - nothing else.",
        "",
        "## Stage 1 Analysis (context only - do not repeat)",
        "",
        analysis,
        "",
        preparedSource.processingMode === "hierarchical-long-document"
          ? "## Long-Document Synthesis"
          : "## Original Source Content",
        "",
        sourceForPrompts,
        "",
        "---",
        "",
        `Now emit the FILE blocks for the wiki files derived from **${fileName}**.`,
        "Your response MUST begin with `---FILE:` as the very first characters.",
        "No preamble. No analysis prose. Start immediately.",
      ].filter(Boolean).join("\n"),
    },
  ]

  try {
    generation = await streamTextWithCompileFallback(
      llmConfig,
      generationMessages,
      signal,
      { temperature: 0.1 },
      activityId,
      "Generation",
    )
  } catch (err) {
    activity.updateItem(activityId, { status: "error", detail: `Generation failed: ${errorMessage(err)}` })
    throw err
  }

  // ── Step 3: Write files ───────────────────────────────────────
  activity.updateItem(activityId, { detail: "Writing files...", step: "Analysing entity deduplication" })
  const { writtenPaths, warnings: writeWarnings, hardFailures } = await writeFileBlocks(pp, generation, fileName)

  // Stamp all newly written wiki pages as "candidate" (knowledge governance).
  // Skip structural pages (index, log, overview) — they don't need review.
  const { stampCandidate } = await import("@/lib/knowledge-governance")
  const SKIP_STAMP = new Set(["index.md", "log.md", "overview.md"])
  for (const rel of writtenPaths) {
    const base = rel.split("/").pop() ?? ""
    if (!SKIP_STAMP.has(base) && rel.startsWith("wiki/")) {
      const absPath = `${pp}/${rel}`
      await stampCandidate(absPath).catch(() => {/* non-critical */})
      await stampIngestQualityMetadata(absPath, preparedSource).catch(() => {/* non-critical */})
    }
  }

  // Surface parser / writer warnings to the activity panel so users
  // don't have to open devtools to find out a block was dropped.
  // Keeping the base "Writing files..." detail on top and appending the
  // first few warnings; full list stays in the console.
  if (writeWarnings.length > 0) {
    const summary = writeWarnings.length === 1
      ? writeWarnings[0]
      : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in console)` : ""}`
    activity.updateItem(activityId, { detail: summary })
  }

  const schemaBackfill = await backfillMissingSchemaCandidatePages(
    pp,
    fileName,
    enrichedSourceContent,
    schemaCandidates,
    llmConfig,
    activityId,
    preparedSource,
    signal,
    serviceLineCtx,
  )
  if (schemaBackfill.writtenPaths.length > 0) {
    writtenPaths.push(...schemaBackfill.writtenPaths)
  }
  if (schemaBackfill.warnings.length > 0) {
    console.warn("[ingest] Schema backfill warnings:", schemaBackfill.warnings)
  }

  // Skip the legacy service_benefit enrichment when a service-hierarchy
  // context is present — the main generation pass already creates correctly
  // named service_item entities in wiki/entities/service/{line}/{version}/.
  // Running the old enrichment would produce stale flat service_benefit
  // pages (e.g. "26项服务权益.md") that conflict with the v2 naming.
  const enrichedServiceBenefitPaths = !signal?.aborted && !serviceLineCtx
    ? await enrichServiceBenefitPagesFromText(pp, sourceContent, fileName).catch((err) => {
        console.warn("[ingest] Service benefit enrichment failed:", err)
        return [] as string[]
      })
    : []
  for (const relPath of enrichedServiceBenefitPaths) {
    if (!writtenPaths.includes(relPath)) writtenPaths.push(relPath)
  }

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const hasSourceSummary = writtenPaths.some((p) => p.startsWith("wiki/sources/"))

  // If the signal was aborted (e.g. user switched projects / cancelled),
  // skip the fallback summary write — the LLM streams returned empty
  // via the abort fast-path (onDone), and writing a stub file into the
  // old project's wiki would both be noise and mask the error.
  // Returning no files lets processNext's length-0 safety net mark the
  // task for retry rather than "success".
  if (!hasSourceSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = normalizeSchemaFrontmatter([
      "---",
      `type: source`,
      `title: "Source: ${fileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${fileName}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${fileName}`,
      "",
      analysis ? analysis.slice(0, 3000) : "(Analysis not available)",
      "",
    ].join("\n"), {
      relativePath: sourceSummaryPath,
      sourceFileName: fileName,
      defaultStatus: "candidate",
      defaultCreatedBy: _getUploaderUsername(),
    })
    try {
      await writeFile(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  let extractionAuditReviewItems: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  if (!signal?.aborted) {
    await preserveOcrDetailsInSourcePage(sourceSummaryFullPath, sourceContent, sourceOrigin)
    await preserveSchemaCandidateAuditInSourcePage(sourceSummaryFullPath, schemaCandidates, schemaBackfill.missingAfterBackfill, pp)
    // ── Step 3.4b: Hard-constraint schema materializer + relation inference ──
    // MUST run BEFORE audit so the audit score reflects the final on-disk state,
    // not the raw LLM output. This ensures audit metrics are meaningful.
    try {
      const postResult = await runKnowledgePostProcess(pp)
      if (postResult.errors.length > 0) {
        console.warn("[ingest] Post-process errors:", postResult.errors)
      }
      if (postResult.lintWarnings.length > 0) {
        console.log("[ingest] Post-process lint:", postResult.lintWarnings.slice(0, 10))
      }
      const changed = postResult.reconciled + postResult.materialized + postResult.relationsInferred + postResult.titlesNormalized
      if (changed > 0) {
        console.log(`[ingest] Post-process: reconciled=${postResult.reconciled} materialized=${postResult.materialized} relationsInferred=${postResult.relationsInferred} titlesNormalized=${postResult.titlesNormalized}`)
      }
    } catch (err) {
      console.warn("[ingest] Post-process failed (non-critical):", err)
    }

    // ── Step 3.4c: Identity Pass ──────────────────────────────────────────────
    // Skipped when skipRelationPass=true (deferred to post-queue batch pass).
    if (!signal?.aborted && !options?.skipRelationPass) {
      try {
        const newEntityTitles = new Set<string>()
        for (const rel of writtenPaths) {
          if (rel.startsWith("wiki/entities/") || rel.startsWith("wiki/concepts/")) {
            const stem = rel.split("/").pop()?.replace(/\.md$/i, "")
            if (stem) newEntityTitles.add(stem)
          }
        }
        const embeddingConfig: EmbeddingConfig = useWikiStore.getState().embeddingConfig
        const idResult = await runIdentityPass(pp, llmConfig, signal, {
          newEntityTitles,
          embeddingConfig: embeddingConfig.enabled ? embeddingConfig : undefined,
        })
        if (idResult.merged > 0 || idResult.aliasEdges > 0 || idResult.siblingEdges > 0 || idResult.errors.length > 0) {
          console.log(`[ingest] Identity pass: catalog=${idResult.catalogSize} pairs=${idResult.candidatePairs} merged=${idResult.merged} alias=${idResult.aliasEdges} sibling=${idResult.siblingEdges} parent_child=${idResult.parentChildEdges}`)
        }
        if (idResult.errors.length > 0) {
          console.warn("[ingest] Identity pass errors:", idResult.errors)
        }
      } catch (err) {
        console.warn("[ingest] Identity pass failed (non-critical):", err)
      }
    } else if (options?.skipRelationPass) {
      console.log(`[ingest] Identity pass deferred (skipRelationPass=true): ${fileName}`)
    }

    // ── Step 3.4d: Global Relation Pass ───────────────────────────────────────
    // Skipped when skipRelationPass=true (deferred to post-queue batch pass).
    // IMPORTANT: we pass newEntityTitles so the pass only evaluates pairs that include
    // at least one entity written during THIS ingest.
    if (!signal?.aborted && !options?.skipRelationPass) {
      try {
        const newEntityTitles = new Set<string>()
        for (const rel of writtenPaths) {
          if (rel.startsWith("wiki/entities/") || rel.startsWith("wiki/concepts/")) {
            const stem = rel.split("/").pop()?.replace(/\.md$/i, "")
            if (stem) newEntityTitles.add(stem)
          }
        }
        const grpResult = await runGlobalRelationPass(pp, llmConfig, signal, { newEntityTitles })
        if (grpResult.written > 0 || grpResult.errors.length > 0) {
          console.log(`[ingest] Global relation pass: catalog=${grpResult.catalogSize} newEntities=${newEntityTitles.size} pairs=${grpResult.candidatePairs} written=${grpResult.written} queued=${grpResult.queued} discarded=${grpResult.discarded}`)
        }
        if (grpResult.errors.length > 0) {
          console.warn("[ingest] Global relation pass errors:", grpResult.errors)
        }
      } catch (err) {
        console.warn("[ingest] Global relation pass failed (non-critical):", err)
      }
    } else if (options?.skipRelationPass) {
      console.log(`[ingest] Global relation pass deferred (skipRelationPass=true): ${fileName}`)
    }

    // ── Step 3.4a: Extraction quality audit ──────────────────────────────────
    // Runs AFTER postprocess so it reads the final, materialized page state.
    // Audit scores now reflect: schema compliance, relation coverage, field
    // completeness — all after the hard-constraint normalizer has run.
    const audit = await writeExtractionQualityAudit({
      projectPath: pp,
      sourceFileName: fileName,
      sourceContent,
      writtenPaths,
      missingCandidates: schemaBackfill.missingAfterBackfill,
      preparedSource,
    })
    if (audit.auditPath && !writtenPaths.includes(audit.auditPath)) writtenPaths.push(audit.auditPath)
    extractionAuditReviewItems = audit.reviewItems
  }

  // ── Step 3.5: Append extracted images to the source-summary page ─
  // Skipped when the master toggle is off — see Step 0.6 above for
  // the full rationale. With captioning disabled we also don't
  // want the safety-net section to slip image refs into the wiki
  // through the back door.
  if (mmCfg.enabled && savedImages.length > 0 && !signal?.aborted) {
    await injectImagesIntoSourceSummary(pp, fileName, savedImages)
  }

  if (writtenPaths.length > 0) {
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  // ── Step 4: Parse review items ────────────────────────────────
  const deterministicReviewItems = [
    ...(await buildMissingLinkReviewItems(pp)),
    ...buildSchemaCandidateCoverageReviewItems(schemaBackfill.missingAfterBackfill, writtenPaths, sp),
    ...(await buildServiceManualCoverageReviewItems(pp, sourceContent, writtenPaths, sp)),
    ...extractionAuditReviewItems,
  ]
  const reviewItems = [
    ...parseReviewBlocks(generation, sp),
    ...deterministicReviewItems,
  ]
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  // ── Step 4.5: AI Quality Scoring ────────────────────────────────
  // For each review item, fire a lightweight (non-streaming) LLM call
  // to score confidence, generate a critique and questions.
  // Runs async and non-blocking — failures are silent.
  if (reviewItems.length > 0 && !signal?.aborted) {
    ;(async () => {
      try {
        const store = useReviewStore.getState()
        // Find the IDs that were just added (most recent ones in store)
        const allItems = store.items
        const addedIds = allItems
          .filter((it) => !it.resolved && reviewItems.some((ri) => ri.title === it.title))
          .map((it) => it.id)

        for (const itemId of addedIds) {
          if (signal?.aborted) break
          const item = useReviewStore.getState().items.find((it) => it.id === itemId)
          if (!item) continue

          let scoreRaw = ""
          await streamChat(
            llmConfig,
            [
              {
                role: "system",
                content: [
                  "你是一位知识质量审核专家。请评估以下 Wiki 审阅条目。",
                  "只输出一个 JSON 对象（不要加 markdown 代码块），格式如下：",
                  '{ "confidence": <0-100>, "critique": "<1-2句中文评价>", "questions": ["<问题1>","<问题2>","<问题3>"], "verdict": "reliable"|"uncertain"|"questionable" }',
                  "confidence说明：80-100=可靠，50-79=存疑，0-49=有问题",
                ].join("\n"),
              },
              {
                role: "user",
                content: `Type: ${item.type}\nTitle: ${item.title}\nDescription: ${item.description}`,
              },
            ],
            {
              onToken: (t) => { scoreRaw += t },
              onDone: () => {
                try {
                  // Strip any markdown code fences if LLM adds them
                  const clean = scoreRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
                  const parsed = JSON.parse(clean)
                  const verdict =
                    parsed.confidence >= 80 ? "reliable"
                    : parsed.confidence >= 50 ? "uncertain"
                    : "questionable"
                  useReviewStore.setState((s) => ({
                    items: s.items.map((it) =>
                      it.id === itemId
                        ? {
                            ...it,
                            aiScore: {
                              confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
                              critique: String(parsed.critique || ""),
                              questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3).map(String) : [],
                              verdict: (["reliable", "uncertain", "questionable"].includes(parsed.verdict)
                                ? parsed.verdict : verdict) as "reliable" | "uncertain" | "questionable",
                            },
                          }
                        : it
                    ),
                  }))
                } catch {
                  // Invalid JSON from LLM — ignore silently
                }
              },
              onError: () => { /* silent */ },
            },
            signal,
            { temperature: 0.1, max_tokens: 200 },
          )
        }
      } catch {
        // Scoring is non-critical
      }
    })()
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  // Skip cache when ANY block hit a hard FS failure: we'd otherwise
  // freeze the partial-write result into the cache and a future
  // re-ingest of the same source would silently replay only the
  // pages that succeeded the first time, never giving the user a
  // chance to recover the failed ones. Soft drops (language
  // mismatch, path-traversal rejection, empty-path) are NOT failures
  // — they represent deterministic decisions and caching them is
  // safe.
  if (writtenPaths.length > 0 && hardFailures.length === 0) {
    await saveIngestCache(pp, fileName, sourceCacheContent, writtenPaths)
  } else if (hardFailures.length > 0) {
    console.warn(
      `[ingest] Skipping cache save for "${fileName}" — ${hardFailures.length} block(s) failed to write: ${hardFailures.join(", ")}`,
    )
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  await embedWrittenIngestPages(pp, writtenPaths)

  // ── Step 7: Governance pipeline (conflict detection + LLM judge) ──────────
  // Runs fire-and-forget — never blocks ingest completion.
  // Must run AFTER Step 6 (embedding) so the vector index is up to date
  // before conflict detection queries it.
  {
    const { runGovernancePipeline } = await import("@/lib/knowledge-governance")
    const llmConfig = useWikiStore.getState().llmConfig
    const govEmbCfg = useWikiStore.getState().embeddingConfig
    const SKIP_GOV = new Set(["index.md", "log.md", "overview.md"])

    for (const rel of writtenPaths) {
      const base = rel.split("/").pop() ?? ""
      if (SKIP_GOV.has(base) || !rel.startsWith("wiki/")) continue
      if (rel.startsWith("wiki/sources/") || rel.includes("/sources/")) continue
      const absPath = `${pp}/${rel}`
      // Read the content once and hand it off; don't await — fire-and-forget
      readFile(absPath).then((content) => {
        runGovernancePipeline(pp, absPath, content, govEmbCfg, llmConfig).catch((err) => {
          console.warn(`[governance] Pipeline failed for ${rel}:`, err)
        })
      }).catch(() => {/* non-critical */})
    }
  }

  // ── P3: count entity stats from written paths & warnings ──────
  const newEntities = writtenPaths.filter(
    (p) => p.startsWith("wiki/entities/") || p.startsWith("wiki/concepts/")
  ).length
  const mergedEntities = writeWarnings.filter((w) => w.includes("merged into canonical")).length

  const detail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}${
        mergedEntities > 0 ? ` · ${mergedEntities} entities merged` : ""
      }`
    : "No files generated"

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
    step: undefined,
    newEntities,
    mergedEntities,
  })

  return writtenPaths
}

/**
 * Per-file language guard. Strips frontmatter + code/math blocks, runs
 * detectLanguage on the remainder, and returns whether the content is in
 * a language family compatible with the target. This catches cases where
 * the LLM follows the format spec but writes a single page in a wrong
 * language (observed ~once in 5 real-LLM runs on MiniMax-M2.7-highspeed).
 */
function contentMatchesTargetLanguage(content: string, target: string): boolean {
  // Strip frontmatter
  const fmEnd = content.indexOf("\n---\n", 3)
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content
  // Strip code + math
  body = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "")
  const sample = body.slice(0, 1500)
  if (sample.trim().length < 20) return true // too short to judge

  const detected = detectLanguage(sample)

  // Compatible families: CJK targets accept CJK variants; Latin targets
  // accept any Latin family (English may mis-detect as Italian/French for
  // short idiomatic samples — that's fine). Cross-family is the real bug.
  const cjk = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  return !detectedIsCjk && !["Arabic", "Hindi", "Thai", "Hebrew"].includes(detected)
}

function frontmatterBody(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
}

function frontmatterScalar(content: string, key: string): string {
  const fm = frontmatterBody(content)
  const match = fm.match(new RegExp(`^${key}\\s*:\\s*["']?([^"'\\r\\n#]*?)["']?\\s*$`, "m"))
  return match?.[1]?.trim() ?? ""
}

function frontmatterListValues(content: string, key: string): string[] {
  const fm = frontmatterBody(content)
  const inline = fm.match(new RegExp(`^${key}\\s*:\\s*\\[([^\\]]*)\\]`, "m"))
  if (inline) {
    return inline[1]
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }

  const lines = fm.split(/\r?\n/)
  const values: string[] = []
  let active = false
  for (const line of lines) {
    if (new RegExp(`^${key}\\s*:\\s*$`).test(line)) {
      active = true
      continue
    }
    if (active) {
      const item = line.match(/^\s*-\s+["']?(.+?)["']?\s*$/)
      if (item) {
        values.push(item[1].trim())
        continue
      }
      if (/^\S/.test(line)) break
    }
  }
  return values
}

function sourceNamesFromContent(content: string): string[] {
  const sourceFiles = frontmatterListValues(content, "source_files")
  return sourceFiles.length > 0 ? sourceFiles : frontmatterListValues(content, "sources")
}

function isMetaValidationSourceName(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized === "readme.md" ||
    normalized.includes("readme") ||
    normalized.includes("测试题") ||
    normalized.includes("問答") ||
    normalized.includes("问答") ||
    normalized.includes("validation") ||
    normalized.includes("验证框架") ||
    normalized.includes("质量评估")
}

function comesFromMetaValidationSource(content: string): boolean {
  const sources = sourceNamesFromContent(content)
  return sources.length > 0 && sources.every(isMetaValidationSourceName)
}

function isBusinessKnowledgeDomain(content: string): boolean {
  const domain = (frontmatterScalar(content, "knowledge_domain") || frontmatterScalar(content, "domain")).toLowerCase()
  return ["product", "customer", "method", "content", "activity", "cases", "compliance"].includes(domain)
}

function isPlaceholderLikeContent(content: string): boolean {
  const head = content.slice(0, 2500)
  return /占位页|占位页面|知识缺口|尚未处理|待处理|尚无对应页面|未被处理|需要补充/.test(head)
}

function isSourceTypedEntityOrConcept(content: string): boolean {
  return frontmatterScalar(content, "entity_type").toLowerCase() === "source" ||
    frontmatterScalar(content, "type").toLowerCase() === "source"
}

export function shouldSkipUnsafeKnowledgeWrite(
  relativePath: string,
  incoming: string,
  existing: string,
): string | null {
  const isEntity = relativePath.startsWith("wiki/entities/") || relativePath.includes("/entities/")
  const isConcept = relativePath.startsWith("wiki/concepts/") || relativePath.includes("/concepts/")
  if (!isEntity && !isConcept) return null

  const fromMetaSource = comesFromMetaValidationSource(incoming)
  const businessDomain = isBusinessKnowledgeDomain(incoming)

  if (fromMetaSource && (isEntity || businessDomain)) {
    return "meta validation source attempted to write business knowledge"
  }

  if (isEntity && isSourceTypedEntityOrConcept(incoming)) {
    return "entity page attempted to use source entity_type"
  }

  if (!existing) return null

  const existingIsBusiness = isBusinessKnowledgeDomain(existing) && !isSourceTypedEntityOrConcept(existing)
  if (existingIsBusiness && isPlaceholderLikeContent(incoming)) {
    return "placeholder content attempted to overwrite existing business page"
  }

  return null
}

/**
 * Post-process entity FILE block paths: if the LLM emitted a flat
 * wiki/entities/XXX.md path but the entity has line_name + version_name
 * in its frontmatter, redirect to wiki/entities/{line}/{version}/{title}.md.
 * Also strips wrong prefixes like "service_安有医_颐享版_" or "安有医_颐享版_"
 * that the LLM adds when encoding hierarchy in the filename.
 */
function rerouteServiceEntityPath(relativePath: string, content: string): string {
  if (!relativePath.startsWith("wiki/entities/")) return relativePath
  const segs = relativePath.split("/")
  // Already in a subdirectory (wiki/entities/line/version/file.md = 5 parts)
  if (segs.length >= 5) return relativePath

  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return relativePath
  const fm = fmMatch[1]

  const lineMatch = fm.match(/^line_name:\s*["']?([^"'\n]+?)["']?\s*$/m)
  const versionMatch = fm.match(/^version_name:\s*["']?([^"'\n]+?)["']?\s*$/m)
  // Also check attributes JSON blob
  const attrLine = content.match(/"line_name"\s*:\s*"([^"]+)"/)  
  const attrVersion = content.match(/"version_name"\s*:\s*"([^"]+)"/)  

  let lineName = lineMatch?.[1]?.trim() ?? attrLine?.[1]
  let versionName = versionMatch?.[1]?.trim() ?? attrVersion?.[1]

  // Fallback: derive from title (handles old entities where line_name/version_name are absent)
  if (!lineName || !versionName) {
    const titleMatch2 = fm.match(/^title:\s*["']?([^"'\n]+?)["']?\s*$/m)
    const candidateTitle = titleMatch2?.[1]?.trim() ?? ""
    const fileName2 = segs[segs.length - 1]
    outer: for (const ser of SERVICE_HIERARCHY) {
      for (const sc of ser.scenarios) {
        for (const ln of sc.lines) {
          for (const vn of ln.versions) {
            const patterns = [
              `${ln.lineName}-${vn.versionName}-`, `${ln.lineName}_${vn.versionName}_`,
              `service_${ln.lineName}_${vn.versionName}_`,
            ]
            if (patterns.some(p => candidateTitle.startsWith(p) || fileName2.startsWith(p))) {
              lineName = ln.lineName; versionName = vn.versionName; break outer
            }
          }
        }
      }
    }
  }
  if (!lineName || !versionName) return relativePath

  // Determine clean file name: prefer the frontmatter title
  const titleMatch = fm.match(/^title:\s*["']?([^"'\n]+?)["']?\s*$/m)
  let fileName = segs[segs.length - 1] // last segment, e.g. service_安有医_颐享版_xxx.md
  if (titleMatch) {
    const cleanTitle = titleMatch[1].trim().replace(/[\/\\:*?"<>|]/g, "").trim()
    if (cleanTitle) fileName = `${cleanTitle}.md`
  } else {
    // Strip common wrong prefixes: "service_{line}_{version}_" or "{line}_{version}_"
    for (const prefix of [`service_${lineName}_${versionName}_`, `${lineName}_${versionName}_`]) {
      if (fileName.startsWith(prefix)) { fileName = fileName.slice(prefix.length); break }
    }
  }
  return `wiki/entities/${lineName}/${versionName}/${fileName}`
}

/**
 * Post-process product catalog entity paths:
 * If the LLM emitted wiki/entities/XXX.md but the content has
 * knowledge_domain: product_catalog, redirect to wiki/product_catalog/XXX.md.
 * Also enforces the naming rule: {category}-{productName}-{moduleName}.md
 */
function rerouteProductCatalogEntityPath(relativePath: string, content: string): string {
  // Already in product_catalog dir — keep as-is
  if (relativePath.startsWith("wiki/product_catalog/")) return relativePath

  // Only reroute if frontmatter declares product_catalog domain
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return relativePath
  const fm = fmMatch[1]

  const domainMatch = fm.match(/^(?:knowledge_domain|domain):\s*["']?([^"'\n]+?)["']?\s*$/m)
  if (!domainMatch) return relativePath
  const domain = domainMatch[1].trim()
  if (domain !== "product_catalog") return relativePath

  // Extract title from frontmatter to build the correct filename
  const titleMatch = fm.match(/^title:\s*["']?([^"'\n]+?)["']?\s*$/m)
  if (!titleMatch) return relativePath
  const title = titleMatch[1].trim().replace(/[\/\\:*?"<>|]/g, "").trim()
  if (!title) return relativePath

  return `wiki/product_catalog/${title}.md`
}

async function writeFileBlocks(
  projectPath: string,
  text: string,
  sourceFileName = "",
): Promise<{ writtenPaths: string[]; warnings: string[]; hardFailures: string[] }> {
  const { blocks, warnings: parseWarnings } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []

  // P2: load existing entities/concepts once for deduplication
  const existingEntities = await loadExistingEntities(projectPath)
  // "Hard failures" = blocks we INTENDED to write but the FS rejected
  // (disk full, permission, OS-level errors). Distinct from soft drops
  // (language mismatch, parse warnings, path-traversal rejections):
  // those represent intentional content-level decisions, while hard
  // failures are unexpected losses. The autoIngest cache layer keys
  // off this list — any hard failure means the cache entry must NOT
  // be written, so the next re-ingest goes through the full pipeline
  // instead of replaying the partial result forever.
  const hardFailures: string[] = []

  const targetLang = useWikiStore.getState().outputLanguage

  for (const { path: originalRelativePath, content: originalContent } of blocks) {
    // P2: Deduplicate entity/concept pages
    const normalised = await normalizeEntityBlock(
      originalRelativePath,
      originalContent,
      existingEntities,
      projectPath,
    )
    // Correct flat entity paths: first try product_catalog reroute, then service hierarchy reroute
    const afterProductCatalog = rerouteProductCatalogEntityPath(normalised.path, normalised.content)
    const relativePath = afterProductCatalog !== normalised.path
      ? afterProductCatalog
      : rerouteServiceEntityPath(normalised.path, normalised.content)
    let content = shouldNormalizeKnowledgePage(relativePath)
      ? cleanupKnowledgeFrontmatter(normalizeSchemaFrontmatter(normalised.content, {
          relativePath,
          sourceFileName,
          defaultStatus: "candidate",
          defaultCreatedBy: _getUploaderUsername(),
        }))
      : normalised.content
    if (normalised.merged) {
      warnings.push(
        `Entity "${normalised.originalPath}" merged into canonical "${normalised.canonicalName}" (alias injected)`,
      )
    }
    // Language guard: reject individual FILE blocks whose body contradicts
    // the user-set target language. Skip:
    // - log.md (structural, short)
    // - /sources/ and /entities/ pages: these legitimately cite cross-
    //   language proper nouns (a German philosophy source summary naturally
    //   quotes Russian philosophers) which confuses naive script-based
    //   detection. Keep the check for /concepts/ pages, which should be
    //   authoritative content in the target language.
    const isLog =
      relativePath.endsWith("/log.md") || relativePath === "wiki/log.md"
    const isEntityOrSource =
      relativePath.startsWith("wiki/entities/") ||
      relativePath.includes("/entities/") ||
      relativePath.startsWith("wiki/sources/") ||
      relativePath.includes("/sources/")
    if (
      targetLang &&
      targetLang !== "auto" &&
      !isLog &&
      !isEntityOrSource &&
      !contentMatchesTargetLanguage(content, targetLang)
    ) {
      const msg = `Dropped "${relativePath}" — body language doesn't match target ${targetLang}.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    const fullPath = `${projectPath}/${relativePath}`
    try {
      const existing = await tryReadFile(fullPath)
      const resolution = resolveIncomingKnowledgePage(relativePath, content, existing || null)
      if (resolution.reviewItems.length > 0) {
        useReviewStore.getState().addItems(resolution.reviewItems)
      }
      if (resolution.hasBlockingConflict) {
        const msg = `Blocked "${relativePath}" because same dedup_key has conflicting critical/high-confidence fields.`
        console.warn(`[ingest] ${msg}`)
        warnings.push(msg)
        continue
      }
      content = resolution.content

      const skipReason = shouldSkipUnsafeKnowledgeWrite(relativePath, content, existing)
      if (skipReason) {
        const msg = `Skipped "${relativePath}" because ${skipReason}.`
        console.warn(`[ingest] ${msg}`)
        warnings.push(msg)
        continue
      }

      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFile(fullPath, appended)
      } else if (
        relativePath === "wiki/index.md" ||
        relativePath.endsWith("/index.md") ||
        relativePath === "wiki/overview.md" ||
        relativePath.endsWith("/overview.md")
      ) {
        // Listing pages (index / overview) are always overwritten
        // wholesale — their sources field is incidental and merging
        // wouldn't make semantic sense (they aren't source-derived
        // content pages).
        await writeFile(fullPath, content)
      } else {
        // Content pages (entities / concepts / queries / synthesis /
        // comparisons / sources summaries): MERGE the sources field
        // with what's already on disk before overwriting, so pages
        // that multiple source documents contribute to retain the
        // full `sources: [...]` history. Without this, every
        // re-ingest clobbers sources to a single entry and the
        // source-delete flow would later treat the page as single-
        // sourced and delete it outright — silent data loss.
        //
        // See src/lib/sources-merge.ts for the merge semantics
        // (case-insensitive dedup, preserves existing order).
        const { mergeSourcesIntoContent } = await import("./sources-merge")
        const toWrite = mergeSourcesIntoContent(content, existing)
        await writeFile(fullPath, toWrite)
      }
      writtenPaths.push(relativePath)
      if (
        relativePath.startsWith("wiki/entities/") ||
        relativePath.startsWith("wiki/concepts/") ||
        relativePath.startsWith("wiki/product_catalog/")
      ) {
        existingEntities.push(buildExistingEntityIndexItem(projectPath, relativePath, content))
      }
    } catch (err) {
      const msg = `Failed to write "${relativePath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      warnings.push(msg)
      hardFailures.push(relativePath)
    }
  }

  try {
    const duplicateResult = await mergeStrongIdentityDuplicatePages(projectPath)
    for (const rel of duplicateResult.mergedPaths) {
      if (!writtenPaths.includes(rel)) writtenPaths.push(rel)
    }
    for (const rel of duplicateResult.deletedPaths) {
      warnings.push(`Merged duplicate concept page and removed "${rel}".`)
    }
    warnings.push(...duplicateResult.warnings)
  } catch (err) {
    const msg = `Strong identity duplicate scan failed: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[ingest] ${msg}`)
    warnings.push(msg)
  }

  return { writtenPaths, warnings, hardFailures }
}

function candidatePageCovered(candidate: SchemaDrivenCandidate, knownTitles: Set<string>): boolean {
  if (candidate.entityType === "source_inventory") return true
  const expected = normalizeCoverageTitle(candidate.title)
  if (knownTitles.has(expected)) return true
  return candidate.aliases.some((alias) => knownTitles.has(normalizeCoverageTitle(alias)))
}

function batchCandidates<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

function buildCandidateBackfillPrompt(
  sourceFileName: string,
  preparedSource: PreparedIngestSource,
  serviceLineCtx?: { lineName: string; versionName: string } | null,
): string {
  const serviceItemPathExample = serviceLineCtx
    ? `wiki/entities/${serviceLineCtx.lineName}/${serviceLineCtx.versionName}/${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-服务项名称.md`
    : "wiki/entities/Page Title.md"
  return [
    "You are a schema-driven insurance knowledge compiler.",
    "",
    "The main generation pass missed required knowledge candidates. Generate dedicated wiki pages for the candidate batch provided by the user.",
    serviceLineCtx
      ? `This is a v2 service hierarchy backfill. ALL service_item pages MUST be placed under wiki/entities/${serviceLineCtx.lineName}/${serviceLineCtx.versionName}/ (mirroring the source upload path) with title prefix ${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-. Do NOT write service items to flat wiki/entities/ or any other subdirectory.`
      : "This is a backfill pass: do not create index, log, overview, or source pages. Emit only FILE blocks under wiki/entities/ or wiki/concepts/.",
    "Use the same language as the source. For Chinese insurance documents, write polished Chinese business-facing Markdown bodies.",
    "",
    "Required behavior:",
    "- Create one page per candidate unless the evidence is clearly insufficient.",
    "- Do not merge multiple service benefits, process rules, or compliance rules into a single generic page.",
    "- Respect candidate domain routing exactly: see ENTITY_TYPE ROUTING RULES below.",
    "- Do not create standalone pages for field values such as 家庭不限次、首年每人 1 次、T+2 个工作日. Put these values under attributes on the related service/rule page.",
    "- If `deterministic_source_facts` or manifest evidence includes service scene/stage/name/frequency, those fields are already known facts. Put them into `attributes` and visible body sections; do not list them as knowledge gaps.",
    "- Fill universal frontmatter plus entity-specific attributes. Put missing extension fields into attributes.knowledge_gaps and a visible knowledge-gap section.",
    "- Every page body must include visible business content, not only frontmatter.",
    "- Every page must cite the source filename and evidence excerpt.",
    "- Keep status: candidate and needs_review true when evidence is partial.",
    "",
    "Minimal frontmatter contract:",
    "schema_version: \"2.1\"",
    "industry: insurance",
    "knowledge_domain: product | customer | method | content | activity | cases | compliance | service | general",
    "domain: same as knowledge_domain",
    "type: entity | concept | process | rule | data | case",
    "entity_type: service_item | service_benefit | process | rule | compliance_rule | coverage_rule | product | pitch | objection_handling | success_case | customer_voice",
    "business_phase: service | conversion | signing | general",
    "dedup_key: stable key",
    "title: human-readable title",
    "summary: short summary",
    "source_files: [source filename]",
    "sources: [source filename]",
    "confidence: 0.0-1.0",
    "status: candidate",
    "needs_review: true | false",
    "attributes: one-line JSON object",
    "claims: compact evidence strings",
    "",
    "Body sections for the main service_version page (\u5b89\u6709\u533b-\u9890\u4eab\u7248.md style) MUST follow this exact structure:",
    SERVICE_VERSION_PAGE_BODY_SPEC,
    "",
    "Body sections for each service_item page MUST follow this exact structure:",
    SERVICE_ITEM_PAGE_BODY_SPEC,
    "",
    "Body sections for process/rule/compliance pages should include: \u89c4\u5219\u5b9a\u4e49\u3001\u89e6\u53d1\u6761\u4ef6.",
    "=== ENTITY_TYPE ROUTING RULES (CRITICAL) ===",
    "entity_type = compliance_rule | rule for: \u91cd\u75be\u5b9a\u4e49\u8bf4\u660e\u3001\u7b49\u5f85\u671f\u8bf4\u660e\u3001\u975e\u5171\u4eab\u89c4\u5219\u3001\u670d\u52a1\u4e2d\u6b62/\u7ec8\u6b62\u89c4\u5219 (knowledge_domain=compliance).",
    "entity_type = service_item for: named health service items like \u5728\u7ebf\u95ee\u8bca\u3001\u540d\u533b\u5927\u548c (knowledge_domain=service).",
    "entity_type = process for: activation/application flow steps (knowledge_domain=product).",
    "entity_type = pitch ONLY for: pure sales talking-point scripts. NOT definitions or rules.",
    "",
    "For rule/definition/compliance pages (\u91cd\u75be\u5b9a\u4e49\u8bf4\u660e\u3001\u7b49\u5f85\u671f\u3001\u975e\u5171\u4eab\u89c4\u5219 etc.):",
    SERVICE_RULE_PAGE_BODY_SPEC,
    "",
    "CRITICAL: Output ALL page bodies in Chinese with exact headings from the specs above.",
    "",
    `Source file: ${sourceFileName}`,
    `Ingest mode: ${preparedSource.processingMode}; source chars: ${preparedSource.originalChars}; context chars: ${preparedSource.contextChars}.`,
    "",
    "Output format only:",
    `---FILE: ${serviceItemPathExample}---`,
    "(complete markdown file)",
    "---END FILE---",
  ].join("\n")
}

function buildCandidateBackfillUserContent(
  sourceFileName: string,
  sourceContent: string,
  candidates: SchemaDrivenCandidate[],
): string {
  const blocks = candidates.map((candidate, index) => [
    `## Candidate ${index + 1}: ${candidate.title}`,
    `domain: ${candidate.knowledgeDomain}`,
    `entity_type: ${candidate.entityType}`,
    `type: ${candidate.universalType}`,
    `required: ${candidate.required}`,
    `confidence: ${candidate.confidence.toFixed(2)}`,
    `reason: ${candidate.reason}`,
    candidate.aliases.length > 0 ? `aliases: ${candidate.aliases.join(", ")}` : "",
    candidate.sourceLines.length > 0 ? `deterministic_source_facts:\n${candidate.sourceLines.map((line) => `- ${line}`).join("\n")}` : "",
    "",
    "Evidence excerpt:",
    "```",
    candidateExcerpt(sourceContent, candidate, 1800) || "(No direct excerpt found; use the candidate source lines and keep needs_review true.)",
    "```",
  ].filter(Boolean).join("\n"))

  return [
    `Backfill missing pages from source: ${sourceFileName}`,
    "",
    "Generate exactly one dedicated page for each candidate below. Start with ---FILE: as the first characters.",
    "",
    blocks.join("\n\n"),
  ].join("\n")
}

async function backfillMissingSchemaCandidatePages(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  candidates: SchemaDrivenCandidate[],
  llmConfig: LlmConfig,
  activityId: string,
  preparedSource: PreparedIngestSource,
  signal?: AbortSignal,
  serviceLineCtx?: { lineName: string; versionName: string; seriesName: string; scenarioName: string } | null,
): Promise<{ writtenPaths: string[]; missingAfterBackfill: SchemaDrivenCandidate[]; warnings: string[] }> {
  const required = candidates.filter((candidate) => candidate.required && candidate.entityType !== "source_inventory")
  if (required.length === 0 || signal?.aborted) return { writtenPaths: [], missingAfterBackfill: [], warnings: [] }

  const knownTitles = await collectWikiPageTitles(projectPath)
  const missingBefore = required.filter((candidate) => !candidatePageCovered(candidate, knownTitles))
  if (missingBefore.length === 0) return { writtenPaths: [], missingAfterBackfill: [], warnings: [] }

  const activity = useActivityStore.getState()
  const allWritten: string[] = []
  const allWarnings: string[] = []
  const batches = batchCandidates(missingBefore.slice(0, 48), 6)

  // ── Phase 1: Launch ALL batch LLM calls in parallel ─────────────────────
  // Batches are pre-divided non-overlapping slices of missingBefore, so there
  // is no risk of the same candidate being generated twice.
  activity.updateItem(activityId, {
    detail: `Schema backfill: launching ${batches.length} batches in parallel (${missingBefore.length} items)...`,
  })

  const generationResults = await Promise.allSettled(
    batches.map((batch, i) => {
      if (signal?.aborted) return Promise.reject(new Error("aborted"))
      return streamTextWithCompileFallback(
        llmConfig,
        [
          { role: "system", content: buildCandidateBackfillPrompt(sourceFileName, preparedSource, serviceLineCtx) },
          { role: "user", content: buildCandidateBackfillUserContent(sourceFileName, sourceContent, batch) },
        ],
        signal,
        { temperature: 0.05, max_tokens: 4200 },
        activityId,
        `Schema backfill batch ${i + 1}/${batches.length}`,
      )
    })
  )

  // ── Phase 2: Write results sequentially ──────────────────────────────────
  // writeFileBlocks modifies shared files (wiki/index.md, etc.) so we keep
  // the write step serial to avoid race conditions.
  const { stampCandidate } = await import("@/lib/knowledge-governance")
  for (let i = 0; i < generationResults.length; i++) {
    if (signal?.aborted) break
    const result = generationResults[i]
    if (result.status === "rejected") {
      const msg = `Schema backfill batch ${i + 1} failed: ${errorMessage(result.reason)}`
      console.warn(`[ingest] ${msg}`)
      allWarnings.push(msg)
      continue
    }

    activity.updateItem(activityId, {
      detail: `Schema backfill: writing batch ${i + 1}/${batches.length}...`,
    })

    const { writtenPaths, warnings } = await writeFileBlocks(projectPath, result.value, sourceFileName)
    allWritten.push(...writtenPaths)
    allWarnings.push(...warnings)

    for (const rel of writtenPaths) {
      if (!rel.startsWith("wiki/")) continue
      const base = rel.split("/").pop() ?? ""
      if (base === "index.md" || base === "log.md" || base === "overview.md") continue
      const absPath = `${projectPath}/${rel}`
      await stampCandidate(absPath).catch(() => {/* non-critical */})
      await stampIngestQualityMetadata(absPath, preparedSource).catch(() => {/* non-critical */})
    }
  }

  const finalTitles = await collectWikiPageTitles(projectPath)
  const missingAfterBackfill = missingBefore.filter((candidate) => !candidatePageCovered(candidate, finalTitles))
  return { writtenPaths: allWritten, missingAfterBackfill, warnings: allWarnings }
}


function yamlScalar(value: string | number): string {
  if (typeof value === "number") return String(value)
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function upsertFrontmatterField(content: string, key: string, value: string | number): string {
  const line = `${key}: ${yamlScalar(value)}`
  if (!content.match(/^---\r?\n[\s\S]*?\r?\n---/m)) {
    return `---\n${line}\n---\n\n${content}`
  }
  const re = new RegExp(`^${key}:.*$`, "m")
  if (re.test(content)) return content.replace(re, line)
  return content.replace(/^(---\r?\n)/, `$1${line}\n`)
}

async function stampIngestQualityMetadata(pagePath: string, preparedSource: PreparedIngestSource): Promise<void> {
  try {
    let content = await readFile(pagePath)
    content = upsertFrontmatterField(content, "ingest_processing_mode", preparedSource.processingMode)
    content = upsertFrontmatterField(content, "ingest_source_chars", preparedSource.originalChars)
    content = upsertFrontmatterField(content, "ingest_context_chars", preparedSource.contextChars)
    content = upsertFrontmatterField(content, "ingest_chunk_count", preparedSource.chunkCount)
    content = upsertFrontmatterField(content, "ingest_quality_confidence", preparedSource.qualityConfidence)
    await writeFile(pagePath, content)
  } catch (err) {
    console.warn("[ingest] Failed to stamp quality metadata:", pagePath, err)
  }
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

function parseReviewBlocks(
  text: string,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    // Parse OPTIONS line
    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    // Parse PAGES line
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    // Parse SEARCH line (optimized search queries for Deep Research)
    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    // Description is the body minus OPTIONS, PAGES, and SEARCH lines
    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}

async function buildMissingLinkReviewItems(
  projectPath: string,
): Promise<Omit<ReviewItem, "id" | "resolved" | "createdAt">[]> {
  try {
    const wikiRoot = `${projectPath}/wiki`
    const files = flattenMarkdownNodes(await listDirectory(wikiRoot))
    const knownTitles = new Set<string>()
    const pageTexts: { relativePath: string; content: string }[] = []

    for (const file of files) {
      const relativePath = file.path.replace(projectPath.replace(/\\/g, "/") + "/", "").replace(/\\/g, "/")
      const content = await readFile(file.path)
      pageTexts.push({ relativePath, content })
      const fileTitle = file.name.replace(/\.md$/i, "")
      knownTitles.add(fileTitle)
      const title = content.match(/^---\r?\n[\s\S]*?\r?\n---/m)?.[0].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
      if (title) knownTitles.add(title)
    }

    const missing = new Map<string, Set<string>>()
    for (const page of pageTexts) {
      const matches = page.content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?]]/g)
      for (const match of matches) {
        const target = match[1].trim()
        if (!target || target.startsWith("wiki/") || knownTitles.has(target)) continue
        if (!missing.has(target)) missing.set(target, new Set())
        missing.get(target)!.add(page.relativePath)
      }
    }

    return Array.from(missing.entries()).map(([target, pages]) => ({
      type: "missing-page" as const,
      title: `缺失页面：${target}`,
      description: `页面中引用了 [[${target}]]，但当前 wiki 尚未生成对应知识页。请确认是创建新页面、改为已有页面别名，还是删除该链接。`,
      affectedPages: Array.from(pages),
      searchQueries: [`${target} 保险 知识`, `${target} 销售 方法`, `${target} 合规 要点`],
      options: [
        { label: "Create Page", action: "Create Page" },
        { label: "Skip", action: "Skip" },
      ],
    }))
  } catch (err) {
    console.warn("[ingest] Missing-link review scan failed:", err)
    return []
  }
}

function normalizeCoverageTitle(value: string): string {
  return value
    .replace(/\.md$/i, "")
    .replace(/["'“”‘’《》【】\[\]（）()_\-\s]/g, "")
    .toLowerCase()
}

async function collectWikiPageTitles(projectPath: string): Promise<Set<string>> {
  const wikiRoot = `${projectPath}/wiki`
  const files = flattenMarkdownNodes(await listDirectory(wikiRoot))
  const titles = new Set<string>()

  for (const file of files) {
    const baseName = file.name.replace(/\.md$/i, "")
    titles.add(normalizeCoverageTitle(baseName))
    try {
      const content = await readFile(file.path)
      const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)
      if (titleMatch) titles.add(normalizeCoverageTitle(titleMatch[1]))
    } catch {
      // Ignore unreadable files; coverage review is best-effort.
    }
  }

  return titles
}

function buildSchemaCandidateCoverageReviewItems(
  missingCandidates: SchemaDrivenCandidate[],
  writtenPaths: string[],
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const actionableMissing = missingCandidates.filter((candidate) => candidate.entityType !== "source_inventory")
  if (actionableMissing.length === 0) return []

  const sourceBaseName = getFileName(sourcePath).replace(/\.[^.]+$/, "")
  const byType = new Map<string, SchemaDrivenCandidate[]>()
  for (const candidate of actionableMissing) {
    if (!byType.has(candidate.entityType)) byType.set(candidate.entityType, [])
    byType.get(candidate.entityType)!.push(candidate)
  }

  const grouped = Array.from(byType.entries())
    .map(([type, items]) => `${type}: ${items.map((item) => item.title).join("、")}`)
    .join("\n")

  return [{
    type: "missing-page",
    title: `抽取覆盖不足：仍缺少 ${actionableMissing.length} 个 schema 候选知识页`,
    description: [
      "系统已完成 schema 候选扫描和自动补页，但仍有部分必须覆盖的服务、流程、规则或合规知识点没有独立页面。",
      "",
      grouped,
      "",
      "这通常说明原文证据不足、OCR 分段不清、模型输出预算不足，或候选名称需要人工归并。演示前建议补齐这些页面或确认它们应合并到已有页面。",
    ].join("\n"),
    sourcePath,
    affectedPages: [
      `wiki/sources/${sourceBaseName}.md`,
      ...writtenPaths.filter((path) => path.startsWith("wiki/entities/") || path.startsWith("wiki/concepts/")).slice(0, 10),
    ],
    searchQueries: [
      "保险 服务权益 知识抽取 覆盖率",
      "保险服务手册 服务项目 流程 规则 合规",
      "知识编译 schema 候选实体 覆盖审计",
    ],
    options: [
      { label: "Create Page", action: "Create Page" },
      { label: "Skip", action: "Skip" },
    ],
  }]
}

async function buildServiceManualCoverageReviewItems(
  projectPath: string,
  sourceContent: string,
  writtenPaths: string[],
  sourcePath: string,
): Promise<Omit<ReviewItem, "id" | "resolved" | "createdAt">[]> {
  const detected = detectedServiceManualNodes(sourceContent)
  if (detected.length < 6) return []

  try {
    const knownTitles = await collectWikiPageTitles(projectPath)
    const missing = detected.filter((node) => {
      const expected = normalizeCoverageTitle(node.title)
      for (const title of knownTitles) {
        if (title === expected) return false
      }
      return true
    })

    if (missing.length < Math.max(3, Math.ceil(detected.length * 0.35))) return []

    const missingServices = missing.filter((node) => node.kind === "service_benefit")
    const missingRules = missing.filter((node) => node.kind !== "service_benefit")
    const sourceBaseName = getFileName(sourcePath).replace(/\.[^.]+$/, "")
    const affectedPages = [
      `wiki/sources/${sourceBaseName}.md`,
      ...writtenPaths.filter((path) => path.startsWith("wiki/entities/") || path.startsWith("wiki/concepts/")).slice(0, 8),
    ]

    return [{
      type: "missing-page",
      title: `抽取覆盖不足：服务手册缺少 ${missing.length} 个服务/规则节点`,
      description: [
        "系统在源文档中识别到多个独立服务权益、流程规则或合规免责条款，但本次编译没有生成对应的独立知识页。",
        "",
        missingServices.length > 0 ? `缺少服务权益页：${missingServices.map((node) => node.title).join("、")}` : "",
        missingRules.length > 0 ? `缺少流程/规则/合规页：${missingRules.map((node) => node.title).join("、")}` : "",
        "",
        "建议重新编译或手工补页。服务手册不应只生成主服务计划页；每个可复用服务项目至少应有 service_benefit 页面，激活/中止/终止/等待期/免责应有 process/rule/compliance_rule 页面。",
      ].filter(Boolean).join("\n"),
      sourcePath,
      affectedPages,
      searchQueries: [
        "保险 服务手册 服务权益 结构化抽取",
        "健康服务权益 服务流程 等待期 非共享规则",
        "保险销售 服务权益 合规免责 知识图谱",
      ],
      options: [
        { label: "Create Page", action: "Create Page" },
        { label: "Skip", action: "Skip" },
      ],
    }]
  } catch (err) {
    console.warn("[ingest] Service-manual coverage review failed:", err)
    return []
  }
}

function flattenMarkdownNodes(nodes: { name: string; path: string; is_dir: boolean; children?: { name: string; path: string; is_dir: boolean; children?: any[] }[] }[]): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      files.push(...flattenMarkdownNodes(node.children ?? []))
    } else if (node.name.endsWith(".md")) {
      files.push({ name: node.name, path: node.path })
    }
  }
  return files
}

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 */
export function buildAnalysisPrompt(
  purpose: string,
  index: string,
  sourceContent: string = "",
  chunking?: ChunkingConfig,
  schema: string = "",
  serviceLineCtx?: { lineName: string; versionName: string } | null,
): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "",
    languageRule(sourceContent),
    "",
    buildChunkingDirective(chunking),
    "",
    buildInsuranceExtractionChecklist(sourceContent),
    "",
    buildServiceManualNodeDirective(sourceContent, serviceLineCtx ?? undefined),
    "",
    "Your analysis should cover:",
    "",
    "## Source Fact Inventory",
    "Before summarizing, enumerate source facts at the finest useful business granularity. Include rules, rows, thresholds, service items, eligibility conditions, exceptions, time limits, counts, product codes, channels, and remarks.",
    "For OCR/table/list documents, count the apparent rows/items and identify the columns. If there are many rows, group them only after preserving the row-level inventory for the source page.",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "## Insurance Schema Classification",
    "If the source is about insurance sales knowledge, classify each important item with `industry / knowledge_domain / entity_type / schema_key`.",
    "Separate universal fields, `attributes`, `relations`, `claims`, and missing fields. For Product, Customer, and Method sources, explicitly identify which Registry fields can be filled and which should become knowledge_gaps.",
    "Do this classification for every reusable business fact, not just for the top-level document title.",
    "",
    "## Coverage Audit",
    "- Which source facts will become entity pages?",
    "- Which source facts will become attributes or claims only?",
    "- Which source facts must remain on the source page as row-level inventory?",
    "- Which schema fields are missing from the source and must be shown as knowledge gaps?",
    "- What important facts would be lost if the output only created 1-3 summary pages?",
    "",
    "## OCR / Long Table Handling",
    "If the source is OCR text from an image or scanned PDF, first judge whether it is a table/list/eligibility sheet.",
    "For long tables, preserve row-level facts: row count, column meanings, product names/codes, yes/no flags, 1/1*/N markers, channels, dates, and remarks. Do not summarize a 100+ row table as a few examples.",
    "Recommend a source summary page plus only the most important entity pages; row-level details should remain available on the source page for exact retrieval.",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    schema ? `## Knowledge Schema\n${schema}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ].filter(Boolean).join("\n")
}

/** Build a chunking directive string from user preferences (appended to both prompts). */
function buildChunkingDirective(cfg?: ChunkingConfig): string {
  if (!cfg?.enabled) return ""
  const lines = ["## User Knowledge Chunking Preferences", "Apply these preferences when structuring the output:"]
  const granularityMap = {
    fine: "Break knowledge into FINE-GRAINED atomic concepts — one single idea, method or fact per wiki page.",
    standard: "Use standard granularity — balanced topics per wiki page (default).",
    coarse: "Use COARSE granularity — group related concepts into larger topic clusters per page.",
  }
  const styleMap = {
    engineering: "Writing style: engineering-focused — practical, concise, with emphasis on how-to and implementation.",
    academic: "Writing style: academic — formal language, include methodology context and cite evidence.",
    bullet_points: "Writing style: bullet-point-heavy — use structured lists, minimize prose.",
    narrative: "Writing style: narrative — flowing prose, story-driven explanations.",
  }
  lines.push(`- Granularity: ${granularityMap[cfg.granularity]}`)
  lines.push(`- Style: ${styleMap[cfg.style]}`)
  if (cfg.include_examples) lines.push("- REQUIRED: Every concept or entity page MUST include a concrete code or usage example.")
  if (cfg.include_references) lines.push("- REQUIRED: Include inline source citations/references in each page (e.g. [Source: filename]).")
  if (cfg.custom_instruction.trim()) lines.push(`- User instruction: ${cfg.custom_instruction.trim()}`)
  return lines.join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 */
export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  index: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
  chunking?: ChunkingConfig,
  uploaderUsername = "unknown",
  preparedSource?: PreparedIngestSource,
  serviceLineCtx?: { lineName: string; versionName: string } | null,
  productCatalogCtx?: { category: InsuranceCategoryType; productName: string; batchModules?: string[]; batchIndex?: number } | null,
): string {
  // Use original filename (without extension) as the source summary page name
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")

  // ── PRODUCT CATALOG HARD OVERRIDE ────────────────────────────────────────
  // When the source belongs to the product catalog domain, prepend a hard
  // override block that completely replaces the generic "What to generate"
  // section. This must come BEFORE all other instructions in the system
  // prompt so it wins the "most recent instruction" priority tie-breaker.
  const productCatalogOverride = productCatalogCtx
    ? buildProductCatalogGenerationOverride(
        productCatalogCtx.category,
        productCatalogCtx.productName,
        sourceFileName,
        productCatalogCtx.batchModules,
        productCatalogCtx.batchIndex,
      )
    : null

  return [
    productCatalogOverride ?? "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "",
    languageRule(sourceContent),
    "",
    buildChunkingDirective(chunking),
    "",
    buildInsuranceExtractionChecklist(sourceContent),
    "",
    buildServiceManualNodeDirective(sourceContent, serviceLineCtx ?? undefined),
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    "",
    "## What to generate",
    "",
    `1. A source summary page at **wiki/sources/${sourceBaseName}.md** (MUST use this exact path)`,
    productCatalogCtx
      ? `2. Module files in wiki/product_catalog/ ONLY. Naming: wiki/product_catalog/${productCatalogCtx.category}-${productCatalogCtx.productName}-{模块名}.md. DO NOT write to wiki/entities/.`
      : "2. Entity pages in wiki/entities/ for key entities identified in the analysis",
    productCatalogCtx
      ? null
      : "3. Concept pages in wiki/concepts/ for key concepts identified in the analysis",
    "4. An updated wiki/index.md — add new entries to existing categories, preserve all existing entries",
    "5. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "6. An updated wiki/overview.md — a high-level summary of what the entire wiki covers, updated to reflect the newly ingested source. This should be a comprehensive 2-5 paragraph overview of ALL topics in the wiki, not just the new source.",
    "",
    "## Page Naming Requirements",
    "",
    productCatalogCtx
      ? [
          `Product catalog naming rule — ALL files MUST follow scheme A:`,
          `  wiki/product_catalog/${productCatalogCtx.category}-${productCatalogCtx.productName}-{模块名}.md`,
          `  where 模块名 is one of: ${PRODUCT_CATALOG_MODULES[productCatalogCtx.category].map(m => m.moduleName).join("、")}`,
          `Example: wiki/product_catalog/${productCatalogCtx.category}-${productCatalogCtx.productName}-${PRODUCT_CATALOG_MODULES[productCatalogCtx.category][0]?.moduleName ?? "产品基础信息"}.md`,
          `NEVER write to wiki/entities/. NEVER create per-field entity pages.`,
        ].join("\n")
      : serviceLineCtx
      ? [
          "**Service hierarchy v2 naming (REQUIRED for this file):**",
          `- service_item entities: MUST follow \`${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-{服务项名称}\``,
          `  Example: \`${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-在线问诊\`, \`${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-家庭医生服务\``,
          `- service_line_version entity (main page): \`${serviceLineCtx.lineName}-${serviceLineCtx.versionName}\``,
          "- Rule/process/compliance pages: use descriptive names, no prefix needed",
          "- NEVER use bare item names like \"在线问诊\" alone as a service_item title",
        ].join("\n")
      : [
          "Use these naming rules for generated page titles and filenames:",
          "- Service project pages: [服务名称]_[产品简称]. Example: 绿通住院_安有医尊享版",
          "- General concepts: use the concept name directly. Example: 家庭医生服务流程",
          "- Version comparison pages: [服务名称]_版本对比. Example: 专家会诊_版本对比",
        ].join("\n"),
    "",
    "The frontmatter `title` should use the exact human-readable page name above.",
    "For Chinese titles, use the Chinese title directly as the filename under the correct wiki directory. Example: wiki/entities/安心家庭守护重疾险.md",
    "Use ASCII kebab-case filenames only when the title is English/code-like or contains filesystem-unsafe characters.",
    "",
    "## Frontmatter Rules (CRITICAL)",
    "",
    "Every page MUST have YAML frontmatter with these fields:",
    "```yaml",
    "---",
    "schema_version: \"2.1\"",
    "industry: insurance",
    "knowledge_domain: product | customer | method | content | activity | cases | compliance | general",
    "taxonomy_path: []",
    "type: concept | entity | event | process | rule | data | comparison | timeline | case | source",
    "entity_type: product | regulatory_doc | product_clause | service_benefit | product_combo | selling_point | persona | life_stage | customer_signal | customer_relationship | selling_scenario | pitch | objection_handling | sales_path | sales_playbook | referral_method | needs_discovery | asset | asset_collection | content_template | presentation_kit | campaign | incentive | success_case | failure_case | customer_voice | referral_case | agent_feedback | competitive_insight | compliance_rule | source | general",
    "business_phase: lead_generation | first_touch | appointment | conversion | signing | service | referral | general",
    "dedup_key: stable-slug-or-business-key",
    "title: Human-readable title",
    "summary: 200字以内摘要",
    "created: YYYY-MM-DD",
    "updated: YYYY-MM-DD",
    "tags: []",
    "keywords: []",
    "related: []",
    "relations: []",
    "parent: \"\"",
    "children: []",
    `source_files: ["${sourceFileName}"]  # MUST contain the original source filename`,
    "source_chunks: []",
    `sources: ["${sourceFileName}"]  # MUST contain the original source filename`,
    "source_type: regulatory_doc | product_terms | product_manual | service_manual | official_marketing | sales_training | agent_experience | ocr_image | unknown",
    "confidence: 0.0-1.0",
    "status: candidate",
    "needs_review: true | false",
    "attributes: {}  # one-line JSON object following the Insurance Schema Registry for this entity_type",
    "claims: []  # compact evidence strings, e.g. \"等待期为90天 | raw: 等待期：90天 | source: file.md | confidence: 0.95\"",
    `ingested_at: "${new Date().toISOString()}"  # timestamp of this ingestion`,
    `ingested_by: "file-upload"  # provenance: file-upload | deep-research | manual | chat`,
    `ingested_by_user: "${uploaderUsername}"  # who uploaded this`,
    preparedSource ? `ingest_processing_mode: "${preparedSource.processingMode}"` : "",
    preparedSource ? `ingest_source_chars: ${preparedSource.originalChars}` : "",
    preparedSource ? `ingest_context_chars: ${preparedSource.contextChars}` : "",
    preparedSource ? `ingest_chunk_count: ${preparedSource.chunkCount}` : "",
    preparedSource ? `ingest_quality_confidence: "${preparedSource.qualityConfidence}"` : "",
    "---",
    "```",
    "",
    `The \`sources\` field MUST always contain "${sourceFileName}" — this links the wiki page back to the original uploaded document.`,
    "",
    "Other rules:",
    "- Completeness is more important than brevity for this insurance demo. The frontend page should let a business reviewer compare extracted knowledge against the original source without feeling that key information disappeared.",
    "- First generate a detailed source page, then generate concise entity pages. Do not sacrifice the source page's fact inventory to keep entity pages short.",
    "- Use [[wikilink]] syntax for cross-references between pages",
    "- Prefer human-readable Chinese wikilinks that match generated page titles, e.g. [[安心家庭守护重疾险]] and [[家庭经济支柱]]. Do not turn Chinese titles into pinyin slugs for links.",
    "- Also emit compact relation lines such as `recommended_for: target_key`, `applies_to: target_key`, `supports: target_key`, `has_part: target_key`, `complements: target_key`, `bundled_with: target_key`, `uses_asset: target_key`, and `governed_by: target_key`.",
    "- Relation rule: `recommended_for` only points to customer personas, life stages, or customer signals. Product-to-product pairing must use `complements` or `bundled_with`. Product/service composition must use `has_part`.",
    "- Customer pages must link back to suitable Product pages with `has_recommendation`, not `recommended_for`.",
    "- part_of direction rule: service benefit child pages MUST use `part_of: <product-or-plan page title>` — pointing to the product or service plan entity page, NOT to the source document filename. Example: `part_of: 平安臻享家医健康服务计划`, never `part_of: 平安臻享家医服务手册.md`.",
    "- Relation target naming rule: relation target values MUST exactly match the `title` field of an existing or concurrently generated wiki page. Do NOT append suffixes (e.g. write `在线问诊`, not `在线问诊_臻享家医`). Do NOT use the source document filename as a relation target for entity-to-entity relations.",
    "- Use the Insurance Schema Registry to choose a schema_key, then fill `attributes` with the entity-specific extension fields. Put unavailable fields as null or [] and mention important missing fields in `attributes.knowledge_gaps`.",
    "- Attribute key rule: use canonical English field names from the Insurance Schema Registry. If the source says 服务对象/适用客户, map it to the matching registry field such as eligible_customers or target_personas; do not invent parallel keys.",
    "- Keep universal governance status in `status` (candidate/active/superseded/rejected). Put business status such as 在售/已停售 in `attributes.product_status`, never in universal `status`.",
    "- Do not let LLM invent auto_derived metrics such as usage_count, conversion_rate, sales_volume_trend, feedback_score, or average_premium_per_policy. Use null unless supplied by a business system.",
    "- For uploaded documents, keep `status: candidate` by default. Do not mark generated knowledge as active unless the source explicitly says it has been human-approved.",
    "- For Product pages, extract Product positioning, basic rules, core responsibilities, exclusions, service benefits, suitable customers, sales associations, and compliance limits into `attributes` when present.",
    "- For Persona pages, extract demographic, psychology, behavior, pain points, objections, matching products, and purchase signals into `attributes`. A persona with no behavior signal should set needs_review: true.",
    "- For Method pages, extract scenario, pitch, objection handling, sales path, business phase, applicable persona/product, scripts, constraints, and risk flags into `attributes`.",
    "- For official/regulatory documents, use entity_type `regulatory_doc` under wiki/sources/ when it is the original truth source. Do not rewrite official clauses; cite them through claims.",
    "- For the first demo, connect Product pages to Customer pages and Method pages whenever the source implies a sales use case.",
    "- Create REVIEW missing-page items for obvious gaps, such as a product benefit without a matching customer persona, a customer objection without an objection handling method, or a method claim without supporting product evidence.",
    "- Never use `entity_type: source` for pages under wiki/entities/ or wiki/concepts/. Source files must live under wiki/sources/.",
    "- If the current source is README, validation framework material, a test-question file, or a quality checklist, do not create or overwrite Product/Customer/Method business entities. Keep it as source/query/general evaluation knowledge only.",
    "- Do not create placeholder entity pages for other uploaded files. If a referenced source has not been processed, create a REVIEW missing-page item instead of a wiki/entities or wiki/concepts placeholder.",
    "- Do not transliterate Chinese page titles into pinyin filenames.",
    "- Demo readability rule: frontmatter is for machines only; the Markdown body is for business users. Do not put important content only in `attributes` or `claims`.",
    "- Every Product/Customer/Method business page body should be a polished Chinese knowledge card with useful visible text: a short opening summary, structured sections, bullet lists or compact tables, applicable scenarios, cross-domain links, evidence/source notes, and knowledge gaps when relevant.",
    "- If the source has enough information, write at least 5 visible sections in the body. Keep the prose factual and do not invent missing values; show unavailable values under a visible `待补全信息` section.",
    "- Source page body requirements: include `原文事实清单`, `结构化抽取结果`, `覆盖审计`, `关联关系`, and `待补全信息` whenever the source has business knowledge.",
    "- OCR/table source rule: if the source is an OCR table, eligibility list, product access list, catalogue, or spreadsheet-like document, the source summary page MUST visibly include a row-level section named `原始清单明细` or `原始OCR明细`; do not only list sample rows.",
    "- For table/list documents, put row-count and column semantics into `attributes`, preserve all product names/codes and yes/no/1/1*/N flags on the source page body, and create only selected entity pages for meaningful products/services/rules instead of fabricating hundreds of shallow pages.",
    "- For product access lists or service eligibility lists within a few hundred rows, the source page must include every identifiable row/item in a compact Markdown table or numbered list. If token budget prevents full table rendering, include a clear `未完全展开的清单范围` section and a REVIEW item; never silently omit rows.",
    "- For service manuals, do not collapse multiple services into one generic paragraph. Extract independent service benefits, process steps, usage limits, exclusions, materials, time limits, and compliance disclaimers as separate visible bullets or tables.",
    "- If the manifest evidence includes `服务场景` / `服务阶段` / `服务项目` / `服务次数`, these are deterministic source facts. Fill `service_category`, `service_name`, and `service_frequency` from them and show them visibly; never put these known values under `待补全信息`.",
    "- Service manual minimum node rule: if the source contains identifiable service items, generate dedicated pages for the service items and rules named in `Service Manual Node Extraction Requirements`. A service manual output with only the main service-plan page is incomplete.",
    "- Concept resolution rule: do not create isolated near-duplicate pages. Exact duplicates should update the existing page; near variants such as 康复门诊协助 / 康复住院协助 should remain separate child service pages linked through a shared parent concept such as 康复服务.",
    "- When generating a child service page that belongs to a service family, include `parent` and `related` frontmatter when the parent or sibling service is known. Do not assume the system will automatically merge variants; only exact `dedup_key` duplicates are auto-merged.",
    "- LATERAL RELATION EXTRACTION (REQUIRED for service_item / service_benefit and product entities): For each service_item or product entity page, you MUST identify and declare structured lateral (sibling) relations in the `relations` frontmatter. Do NOT rely only on generic `related_to`. Use specific types:",
    "  * `complements: <title>` — services that enhance each other when used together (e.g. 在线问诊 + 就医陪诊)",
    "  * `next_step: <title>` — the natural next service in the customer journey (e.g. 门诊预约协助 → 就医陪诊)",
    "  * `same_stage: <title>` — services at the same stage of care (e.g. 国内住院安排协助 + 住院照护)",
    "  * `bundled_with: <title>` — services that are always offered together",
    "  * `governed_by: <title>` — a rule, waiting period, or compliance page that governs this service",
    "  * `part_of: <title>` — the parent service_line_version this item belongs to",
    "  * `instance_of: <title>` — the service_item_concept (concept page) this item is an instance of",
    "  For each lateral relation, also add a structured entry in `attributes.relation_candidates` as a JSON array:",
    "  `relation_candidates: [{target: \"就医陪诊\", type: \"complements\", confidence: 0.85, evidence: \"原文中二者出现在同一就诊流程描述中，先在线问诊再陪诊\", source: \"explicit_ingest\"}]`",
    "  This structured output is critical for the knowledge graph's horizontal connectivity. A service_item page with no lateral relations and no relation_candidates is considered incomplete.",
    serviceLineCtx
      ? [
          `- Service item pages (v2): MUST use path \`wiki/entities/${serviceLineCtx.lineName}/${serviceLineCtx.versionName}/${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-{\u670d\u52a1\u9879\u540d\u79f0}.md\` — mirroring the source upload directory.`,
          `  Example: \`wiki/entities/${serviceLineCtx.lineName}/${serviceLineCtx.versionName}/${serviceLineCtx.lineName}-${serviceLineCtx.versionName}-\u5728\u7ebf\u95ee\u8bca.md\``,
          `  The \`wiki/entities/${serviceLineCtx.lineName}/${serviceLineCtx.versionName}/\` directory prefix is MANDATORY. Do NOT write to flat \`wiki/entities/\` or any other subdirectory.`,
          `  Frontmatter: \`entity_type: service_item\`, \`knowledge_domain: service\`, \`business_phase: service\``,
          `  MUST include: line_name: "${serviceLineCtx.lineName}", version_name: "${serviceLineCtx.versionName}", item_name: "{服\u52a1\u9879\u540d\u79f0}"`,
          "  Link back to the main service_line_version page using `part_of` relation.",
        ].join("\n")
      : "- Service benefit pages should use `wiki/entities/[\u670d\u52a1\u9879\u76ee\u540d].md`, `entity_type: service_benefit`, `knowledge_domain: product`, `business_phase: service`, and should link back to the main service plan.",
    "- Service process pages should use `type: process`; service limitation/waiting-period/non-sharing pages should use `type: rule`; disclaimer pages should use `knowledge_domain: compliance` and `entity_type: compliance_rule`.",
    "- For product terms, do not collapse responsibilities/exclusions/rules into a single summary. Extract age range, waiting period, payment period, coverage period, claim trigger, responsibility amounts, exclusions, underwriting basics, service packages, and official caveats separately.",
    "- For sales/customer/method content, extract target personas, lifecycle triggers, customer signals, scenario, business phase, pitch, objection handling, content assets, and compliance-sensitive wording separately.",
    "- For service QA sources, generate Method pages for customer-facing explanation and objection handling when the source contains reusable answers. Keep Product service benefits and Compliance rules as separate linked pages.",
    "- For service/customer case sources, generate Cases pages (`success_case`, `customer_voice`, or `failure_case`) when the source contains customer background, service journey, key moments, outcome, or lessons. Do not only update the Product page.",
    "- Every entity page should include an `证据摘录` or `来源依据` section with 3-8 concrete source-backed facts when available. Do not rely only on frontmatter claims.",
    "- If a field is absent in the source, do not invent it. Put it under visible `待补全信息` and in `attributes.knowledge_gaps`.",
    "- Add REVIEW missing-page items when the source implies a reusable Product/Customer/Method/Compliance concept but there is not enough evidence to create a full page.",
    "- For Product pages, visible body sections should include 产品定位、基础规则、核心保障/权益、适配客户、销售方法关联、合规提醒、待补全信息 when available.",
    "- For Persona pages, visible body sections should include 画像定义、识别信号、核心痛点、适配产品/场景、典型异议、销售切入建议、待补全信息 when available.",
    "- For Method pages, visible body sections should include 使用场景、适用客户、核心逻辑、推荐话术/步骤、注意事项、关联产品/证据、待补全信息 when available.",
    "- For Cases pages, visible body sections should include 案例背景、客户画像、触发事件、服务/销售路径、关键转折、结果、可复用经验、关联产品/方法、合规提醒、来源依据、待补全信息 when available.",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "",
    "## Review block types",
    "",
    "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
    "",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    "## OPTIONS allowed values (only these predefined labels):",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
    "(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    `## Wiki Schema\n${schemaGuidance(schema)}`,
    index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
    "",
    // ── OUTPUT FORMAT MUST BE THE LAST SECTION — models weight recent instructions highest ──
    "## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)",
    "",
    "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "```",
    "",
    "REVIEW block template (optional, after all FILE blocks):",
    "```",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "## Output Requirements (STRICT — deviations will cause parse failure)",
    "",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
    "3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.",
    "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
    "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
    "6. Between blocks, use only blank lines — no prose.",
    "7. EVERY FILE block's content (titles, body, descriptions) MUST be in the mandatory output language specified below. No exceptions — not even for page names or section headings.",
    "",
    "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    "",
    // Repeat the language directive at the very end so it wins the "most
    // recent instruction" tie-breaker. Small-to-medium models otherwise
    // drift back to their training-data language for individual pages.
    "---",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

/**
 * Append (or replace) the embedded-images section on the source-
 * summary page. Idempotent — paired marker comments bracket our
 * injection, so re-running this for the same source either:
 *   - replaces an existing injection in-place (image set changed), or
 *   - leaves an existing injection untouched (image set unchanged).
 *
 * Falls back to creating a minimal source-summary stub if the
 * page doesn't exist yet (covers the cache-hit path where the
 * original LLM-written page may have been deleted by the user but
 * extracted images are still salvageable, and the rare case where
 * the LLM wrote the source page under a slightly-different slug
 * that didn't match `${sourceBaseName}.md`).
 */
async function injectImagesIntoSourceSummary(
  pp: string,
  fileName: string,
  savedImages: { relPath: string; page: number | null; sha256?: string }[],
): Promise<void> {
  if (savedImages.length === 0) return
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  console.log(`[ingest:diag] injectImagesIntoSourceSummary: target=${sourceSummaryFullPath}, images=${savedImages.length}`)
  try {
    const existing = await tryReadFile(sourceSummaryFullPath)
    console.log(`[ingest:diag] injectImagesIntoSourceSummary: existing file ${existing ? `read OK (${existing.length} chars)` : "MISSING (will write stub)"}`)
    // Load captions from the on-disk cache so the safety-net
    // section embeds caption text as alt — the embedding pipeline
    // indexes whatever's in the wiki page, so without this, search
    // by image content (e.g. "find the chart with revenue data")
    // never matches because alt text was empty.
    const captionsBySha = await loadCaptionCache(pp)
    const newSection = buildImageMarkdownSection(savedImages as never, captionsBySha)
    const marker = "<!-- llm-wiki:embedded-images -->"
    const wrapped = `\n\n${marker}\n${newSection.trim()}\n${marker}\n`
    if (existing) {
      // Strip any prior injection (paired markers) so re-ingest
      // doesn't accumulate stale references when images change.
      const stripped = existing.replace(
        new RegExp(`\\n*${marker}[\\s\\S]*?${marker}\\n*`, "g"),
        "",
      )
      await writeFile(sourceSummaryFullPath, normalizeSchemaFrontmatter(stripped.trimEnd() + wrapped, {
        relativePath: sourceSummaryPath,
        sourceFileName: fileName,
        defaultStatus: "candidate",
        defaultCreatedBy: _getUploaderUsername(),
      }))
    } else {
      // Page is missing — write a minimal stub so the user actually
      // sees the images in the file tree. Without this fallback, the
      // images sit in wiki/media/<slug>/ with no .md page referencing
      // them, which means the lint view's orphan-page sweep eventually
      // reaps the media directory (cascadeDeleteWikiPage triggered by
      // a missing source page) — silent loss of extracted images.
      const date = new Date().toISOString().slice(0, 10)
      const stubFrontmatter = normalizeSchemaFrontmatter([
        "---",
        "type: source",
        `title: "Source: ${fileName}"`,
        `created: ${date}`,
        `updated: ${date}`,
        `sources: ["${fileName}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${fileName}`,
        "",
      ].join("\n"), {
        relativePath: sourceSummaryPath,
        sourceFileName: fileName,
        defaultStatus: "candidate",
        defaultCreatedBy: _getUploaderUsername(),
      })
      await writeFile(sourceSummaryFullPath, stubFrontmatter + wrapped)
    }
    console.log(
      `[ingest:images] injected ${savedImages.length} image reference(s) into ${sourceSummaryPath}`,
    )
  } catch (err) {
    console.warn(
      `[ingest:images] failed to append images to ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Re-embed the source-summary page after we've rewritten its
 * `## Embedded Images` safety-net section with captions. The full
 * autoIngest pipeline calls `embedPage` at step 6 unconditionally;
 * this is the cache-hit equivalent (where step 6 is skipped) and
 * exists specifically to keep the search index in sync after a
 * caption refresh.
 *
 * Why not just call `embedPage` inline at the call site: the
 * embedding store + config lookup, the readFile-then-parse-title
 * dance, and the no-op behavior when embedding is disabled all
 * already exist in the step-6 logic. Wrapping them once here
 * avoids drift between the two paths if either side changes.
 */
async function reembedSourceSummary(pp: string, fileName: string): Promise<void> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) return
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryFullPath = `${pp}/wiki/sources/${sourceBaseName}.md`
  try {
    const content = await readFile(sourceSummaryFullPath)
    const titleMatch = content.match(
      /^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m,
    )
    const title = titleMatch ? titleMatch[1].trim() : sourceBaseName
    const { embedPage } = await import("@/lib/embedding")
    await embedPage(pp, sourceBaseName, title, content, embCfg)
    console.log(`[ingest:caption] re-embedded ${sourceBaseName} with captioned alt text`)
  } catch (err) {
    console.warn(
      `[ingest:caption] re-embed failed for ${sourceBaseName}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  // Extract embedded images upfront — independent of the LLM call
  // that follows. Done eagerly here (rather than in
  // `executeIngestWrites`) so the images are on disk before the user
  // even sees the analysis stream, and the cost is only paid once
  // per source: a follow-up `executeIngestWrites` will reuse the
  // already-extracted set rather than re-running pdfium.
  // Failure-tolerant — `extractAndSaveSourceImages` returns [] on
  // any error and logs internally; we never want image extraction
  // to break the ingest chat flow.
  void extractAndSaveSourceImages(pp, sp).catch((err) => {
    console.warn(
      `[startIngest:images] eager extraction failed for "${getFileName(sp)}":`,
      err instanceof Error ? err.message : err,
    )
  })

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const fileName = getFileName(sp)

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    languageRule(sourceContent),
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    `## Wiki Schema\n${schemaGuidance(schema)}`,
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${fileName}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${fileName}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during ingest: ${err.message}`)
      },
    },
    signal,
  )
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()

  const [schema, index] = await Promise.all([
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  store.addMessage("user", writePrompt)
  store.setStreaming(true)

  let accumulated = ""

  // In auto mode, fall back to detecting language from the chat history
  // (user's discussion messages) rather than the empty string, which would
  // default to English regardless of the source content.
  const historyText = conversationHistory
    .map((m) => m.content)
    .join("\n")
    .slice(0, 2000)

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    "",
    languageRule(historyText),
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  await streamChat(
    llmConfig,
    [{ role: "system", content: systemPrompt }, ...conversationHistory],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error generating wiki files: ${err.message}`)
      },
    },
    signal,
  )

  const writtenPaths: string[] = []
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    const relativePath = match[1].trim()
    const rawContent = match[2]
    const content = shouldNormalizeKnowledgePage(relativePath)
      ? normalizeSchemaFrontmatter(rawContent, {
          relativePath,
          defaultStatus: "candidate",
          defaultCreatedBy: _getUploaderUsername(),
        })
      : rawContent

    if (!relativePath) continue

    const fullPath = `${pp}/${relativePath}`

    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing
          ? `${existing}\n\n${content.trim()}`
          : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `Files written to wiki:\n${fileList}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  // Image cascade: surface any embedded images on the source-summary
  // page. `startIngest` already kicked off extraction in parallel
  // with the chat stream — by now the images are sitting in
  // `wiki/media/<slug>/`, but no markdown references them yet. We
  // re-run extraction here to get back the SavedImage metadata
  // (rel_path, page) needed to build the markdown section. The Rust
  // command is idempotent (deterministic file paths, overwrite-safe
  // writes), so repeating it is cheap on the second call where every
  // file already exists.
  //
  // Read the source path from the chat store — `startIngest` set it
  // there at the beginning of the flow, and we don't have it as a
  // parameter (the chat-panel "Save to Wiki" button only passes
  // projectPath). Skipped silently when there's no ingestSource
  // (e.g. user manually entered chat mode and called this).
  const ingestSource = getStore().ingestSource
  // Master toggle gate — see autoIngestImpl Step 0.6 / 3.5 for
  // the full rationale. When captioning is disabled, we skip the
  // safety-net inject here too so the executeIngestWrites path
  // stays consistent with autoIngest.
  const mmCfgWrites = useWikiStore.getState().multimodalConfig
  if (ingestSource && mmCfgWrites.enabled) {
    try {
      const savedImages = await extractAndSaveSourceImages(pp, ingestSource)
      if (savedImages.length > 0) {
        const fileName = getFileName(ingestSource)
        await injectImagesIntoSourceSummary(pp, fileName, savedImages)
      }
    } catch (err) {
      console.warn(
        `[executeIngestWrites:images] post-write injection failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return writtenPaths
}
