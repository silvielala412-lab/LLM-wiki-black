/**
 * entity-normalizer.ts
 *
 * P2: Prevent duplicate entity/concept pages in the knowledge graph.
 *
 * Problem: LLM often generates "中国平安" and "平安保险" as separate entity
 * pages when they refer to the same concept, causing wikilink fragmentation.
 *
 * Solution: Before writing entity/concept FILE blocks, compare the new name
 * against existing pages using:
 *   1. Exact match (case-insensitive)
 *   2. Contains match ("平安" ⊆ "中国平安")
 *   3. Edit distance ≤ 2 (e.g. typos, minor variations)
 *
 * If a match is found, the new content is MERGED into the existing file
 * (via the existing mergeSourcesIntoContent pipeline) instead of creating
 * a new page. The colliding name is added as an alias in frontmatter so
 * wikilinks to either name still resolve.
 *
 * Scope: only applies to wiki/entities/ and wiki/concepts/
 */

import { createDirectory, deleteFile, listDirectory, readFile, writeFile } from "@/commands/fs"
import { buildMergedReviewContent } from "@/lib/knowledge-governance/review-actions"
import {
  inferStableInsuranceDedupKey,
  inferStrongInsuranceIdentityKeys,
  normalizeInsuranceAttributes,
} from "@/lib/insurance-schema-registry"

// ── Levenshtein distance (small strings only) ────────────────────────────────

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

// ── Name normalisation ────────────────────────────────────────────────────────

/** Strip common Chinese company/org suffixes and lowercase for comparison. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_\-·•·]/g, "")               // spaces and separators
    .replace(/(有限公司|股份公司|集团|控股|公司|集团|保险|金融|银行|科技)$/u, "")
}

/** Extract entity name from a wiki file path like wiki/entities/中国平安.md */
function nameFromPath(relativePath: string): string {
  const parts = relativePath.split("/")
  const filename = parts[parts.length - 1]
  return filename.replace(/\.md$/i, "")
}

/** Return true if the two names are "similar enough" to be considered duplicates. */
function isSimilar(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb) return true
  // One is a substring of the other (e.g. "平安" ⊆ "中国平安")
  if (na.length >= 2 && nb.length >= 2) {
    if (na.includes(nb) || nb.includes(na)) return true
  }
  // Edit distance for short names (longer names have too many false positives)
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen <= 8 && levenshtein(na, nb) <= 1) return true
  if (maxLen <= 12 && levenshtein(na, nb) <= 2) return true
  return false
}

// ── Existing entity index ─────────────────────────────────────────────────────

export interface ExistingEntity {
  /** Full path on disk: <projectPath>/wiki/entities/名称.md */
  fullPath: string
  /** Relative path within project: wiki/entities/名称.md */
  relativePath: string
  /** Display name (filename without .md) */
  name: string
  /** Schema entity_type from frontmatter, when available. */
  entityType?: string
  /** Stable schema-driven dedup key. First-stage merging only uses exact matches. */
  dedupKey?: string
  /** Strong business identity keys: product code/name, service+product, persona name, etc. */
  identityKeys?: string[]
  /** Lightweight business signature used for schema-aware deduplication. */
  businessSignature?: string
  /** Lightweight parent/variant family signature, e.g. rehab service family. */
  familySignature?: string
}

export interface VariantFamilyDefinition {
  signature: string
  title: string
  description: string
  aliases: string[]
}

/**
 * Load all existing entity and concept file paths from disk.
 * Returns a flat list; the caller deduplicates against this list.
 */
export async function loadExistingEntities(
  projectPath: string,
): Promise<ExistingEntity[]> {
  const results: ExistingEntity[] = []

  for (const dir of ["wiki/entities", "wiki/concepts"]) {
    const base = `${projectPath}/${dir}`
    try {
      const files = await listDirectory(base)
      for (const f of files) {
        if (f.is_dir || !f.name.endsWith(".md")) continue
        const relativePath = `${dir}/${f.name}`
        const existingContent = await safeRead(`${projectPath}/${relativePath}`)
        results.push({
          fullPath: `${projectPath}/${relativePath}`,
          relativePath,
          name: nameFromPath(relativePath),
          entityType: extractScalar(existingContent, "entity_type"),
          dedupKey: inferEntityDedupKey(existingContent, nameFromPath(relativePath)),
          identityKeys: inferEntityIdentityKeys(existingContent, nameFromPath(relativePath)),
          businessSignature: inferBusinessSignature(existingContent, nameFromPath(relativePath)),
          familySignature: inferVariantFamilySignature(existingContent, nameFromPath(relativePath))?.signature,
        })
      }
    } catch {
      // Directory doesn't exist yet — fine, first ingest
    }
  }

  return results
}

export function buildExistingEntityIndexItem(
  projectPath: string,
  relativePath: string,
  content: string,
): ExistingEntity {
  return {
    fullPath: `${projectPath}/${relativePath}`,
    relativePath,
    name: nameFromPath(relativePath),
    entityType: extractScalar(content, "entity_type"),
    dedupKey: inferEntityDedupKey(content, nameFromPath(relativePath)),
    identityKeys: inferEntityIdentityKeys(content, nameFromPath(relativePath)),
    businessSignature: inferBusinessSignature(content, nameFromPath(relativePath)),
    familySignature: inferVariantFamilySignature(content, nameFromPath(relativePath))?.signature,
  }
}

export async function mergeStrongIdentityDuplicatePages(
  projectPath: string,
): Promise<{ mergedPaths: string[]; deletedPaths: string[]; warnings: string[] }> {
  const entities = await loadExistingEntities(projectPath)
  const warnings: string[] = []
  const mergedPaths: string[] = []
  const deletedPaths: string[] = []
  const seenPairs = new Set<string>()

  for (const entity of entities) {
    for (const candidate of entities) {
      if (entity.relativePath === candidate.relativePath) continue
      if (!compatibleEntityTypesForMerge(entity.entityType, candidate.entityType)) continue
      if (!hasSharedIdentityKey(entity.identityKeys ?? [], candidate.identityKeys ?? [])) continue

      const [canonical, duplicate] = chooseCanonicalEntity(entity, candidate)
      const pairKey = `${canonical.relativePath}<- ${duplicate.relativePath}`
      const reverseKey = `${duplicate.relativePath}<- ${canonical.relativePath}`
      if (seenPairs.has(pairKey) || seenPairs.has(reverseKey) || deletedPaths.includes(duplicate.relativePath)) continue
      seenPairs.add(pairKey)

      try {
        const [canonicalContent, duplicateContent] = await Promise.all([
          readFile(canonical.fullPath),
          readFile(duplicate.fullPath),
        ])
        const withAlias = injectAlias(canonicalContent, duplicate.name)
        const merged = buildMergedReviewContent(withAlias, duplicateContent, duplicate.name)
        await writeFile(canonical.fullPath, merged)
        await deleteFile(duplicate.fullPath)
        mergedPaths.push(canonical.relativePath)
        deletedPaths.push(duplicate.relativePath)
      } catch (err) {
        warnings.push(`Could not merge duplicate "${duplicate.relativePath}" into "${canonical.relativePath}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return {
    mergedPaths: dedupeStrings(mergedPaths),
    deletedPaths: dedupeStrings(deletedPaths),
    warnings,
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

// ── Alias injection ───────────────────────────────────────────────────────────

/**
 * Add `alias` to the YAML frontmatter of an existing page.
 * Creates the frontmatter block if it doesn't exist.
 * Is idempotent — won't add the same alias twice.
 */
function injectAlias(existingContent: string, newAlias: string): string {
  const fmMatch = existingContent.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    // No frontmatter — prepend one
    return `---\naliases: ["${newAlias}"]\n---\n\n${existingContent}`
  }

  const fm = fmMatch[1]
  const rest = existingContent.slice(fmMatch[0].length)

  // Already has aliases field?
  const aliasesMatch = fm.match(/^aliases:\s*\[(.*)]/m)
  if (aliasesMatch) {
    const existingAliases = aliasesMatch[1]
    // Already contains this alias (case-insensitive)?
    if (existingAliases.toLowerCase().includes(newAlias.toLowerCase())) {
      return existingContent
    }
    const updated = fm.replace(
      aliasesMatch[0],
      `aliases: [${existingAliases}, "${newAlias}"]`,
    )
    return `---\n${updated}\n---${rest}`
  }

  // Add aliases field to existing frontmatter
  return `---\n${fm}\naliases: ["${newAlias}"]\n---${rest}`
}

// ── Main deduplication hook ───────────────────────────────────────────────────

export interface NormalizedBlock {
  /** The path to write to (may be redirected to an existing canonical file) */
  path: string
  content: string
  /** If true, this is a merge into an existing file (no new page created) */
  merged: boolean
  /** The original path before dedup redirect */
  originalPath: string
  /** The name of the canonical entity this was merged into */
  canonicalName?: string
}

/**
 * Normalise a single FILE block intended for wiki/entities/ or wiki/concepts/.
 *
 * - If no existing entity matches → returns the block unchanged.
 * - If a match is found:
 *     - Injects the new name as an alias into the existing canonical page
 *     - Returns the block redirected to the canonical path so the content
 *       gets merged by mergeSourcesIntoContent (called in writeFileBlocks)
 *
 * @param relativePath  e.g. "wiki/entities/中国平安.md"
 * @param content       Markdown content of the new FILE block
 * @param existingEntities  Pre-loaded entity list (call loadExistingEntities once per ingest)
 * @param projectPath   Absolute path to the project root
 */
export async function normalizeEntityBlock(
  relativePath: string,
  content: string,
  existingEntities: ExistingEntity[],
  projectPath: string,
): Promise<NormalizedBlock> {
  const isEntityOrConcept =
    relativePath.startsWith("wiki/entities/") ||
    relativePath.startsWith("wiki/concepts/")

  if (!isEntityOrConcept) {
    return { path: relativePath, content, merged: false, originalPath: relativePath }
  }

  const newName = nameFromPath(relativePath)
  const newDedupKey = inferEntityDedupKey(content, newName)
  const newIdentityKeys = inferEntityIdentityKeys(content, newName)
  const newEntityType = extractScalar(content, "entity_type")

  // Deterministic same-concept merge: exact dedup_key OR strong schema identity
  // keys redirect to the canonical page. Loose title similarity is still
  // deferred; this protects sibling concepts such as 康复门诊协助 / 康复住院协助.
  const match = existingEntities.find(
    (e) =>
      e.relativePath !== relativePath &&
      compatibleEntityTypes(e.entityType, newEntityType) &&
      (
        (!!newDedupKey && e.dedupKey === newDedupKey) ||
        hasSharedIdentityKey(e.identityKeys ?? [], newIdentityKeys)
      ),
  )

  if (!match) {
    // No duplicate — write normally
    return { path: relativePath, content, merged: false, originalPath: relativePath }
  }

  console.log(
    `[entity-normalizer] "${newName}" → merging into canonical "${match.name}" (${match.relativePath})`,
  )

  // Inject alias into the canonical page
  try {
    const existing = await readFile(match.fullPath)
    const withAlias = injectAlias(existing, newName)
    if (withAlias !== existing) {
      await writeFile(match.fullPath, withAlias)
    }
  } catch (err) {
    console.warn(`[entity-normalizer] Could not inject alias into ${match.fullPath}:`, err)
  }

  // Redirect the FILE block to the canonical path so mergeSourcesIntoContent
  // can merge the `sources:` field from the new content into the existing page.
  return {
    path: match.relativePath,
    content,
    merged: true,
    originalPath: relativePath,
    canonicalName: match.name,
  }
}

export async function materializeVariantFamilyPages(
  projectPath: string,
): Promise<{ writtenPaths: string[]; warnings: string[] }> {
  const writtenPaths: string[] = []
  const warnings: string[] = []
  const entities = await loadExistingEntities(projectPath)
  const familyMembers = new Map<string, { family: VariantFamilyDefinition; members: ExistingEntity[] }>()

  for (const entity of entities) {
    if (!entity.relativePath.startsWith("wiki/entities/")) continue
    const content = await safeRead(entity.fullPath)
    const family = inferVariantFamilySignature(content, entity.name)
    if (!family) continue
    if (!familyMembers.has(family.signature)) familyMembers.set(family.signature, { family, members: [] })
    familyMembers.get(family.signature)!.members.push(entity)
  }

  for (const { family, members } of familyMembers.values()) {
    const uniqueMembers = dedupeBy(members, (member) => member.relativePath)
    if (uniqueMembers.length < 2) continue

    const conceptPath = `wiki/concepts/${family.title}.md`
    const conceptFullPath = `${projectPath}/${conceptPath}`
    const memberLinks = uniqueMembers.map((member) => `[[${member.name}]]`)

    await createDirectory(`${projectPath}/wiki`).catch(() => {})
    await createDirectory(`${projectPath}/wiki/concepts`).catch(() => {})

    const existingConcept = await safeRead(conceptFullPath)
    const conceptContent = buildVariantFamilyConcept(family, memberLinks, existingConcept)
    if (conceptContent !== existingConcept) {
      await writeFile(conceptFullPath, conceptContent)
      writtenPaths.push(conceptPath)
    }

    for (const member of uniqueMembers) {
      try {
        const existing = await readFile(member.fullPath)
        const updated = upsertFamilyRelation(existing, family.title, memberLinks.filter((link) => link !== `[[${member.name}]]`))
        if (updated !== existing) {
          await writeFile(member.fullPath, updated)
          writtenPaths.push(member.relativePath)
        }
      } catch (err) {
        warnings.push(`Could not update variant relation for ${member.relativePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { writtenPaths: dedupeStrings(writtenPaths), warnings }
}

function buildVariantFamilyConcept(
  family: VariantFamilyDefinition,
  memberLinks: string[],
  existingContent: string,
): string {
  const frontmatter = [
    "---",
    "schema_version: \"2.1\"",
    "industry: insurance",
    "knowledge_domain: product",
    "domain: product",
    "type: concept",
    "entity_type: service_family",
    `title: "${family.title}"`,
    `summary: "${family.description}"`,
    `dedup_key: "${family.signature}"`,
    `aliases: [${family.aliases.map((alias) => `"${alias}"`).join(", ")}]`,
    `children: [${memberLinks.map((link) => `"${link.replace(/^\[\[|\]\]$/g, "")}"`).join(", ")}]`,
    `related: [${memberLinks.map((link) => `"${link.replace(/^\[\[|\]\]$/g, "")}"`).join(", ")}]`,
    "status: candidate",
    "needs_review: true",
    "---",
    "",
  ].join("\n")

  const body = [
    `# ${family.title}`,
    "",
    family.description,
    "",
    "## 子服务",
    "",
    ...memberLinks.map((link) => `- ${link}`),
    "",
    "## 建模说明",
    "",
    "这些页面不是重复概念，而是同一上位服务族下的不同服务场景或服务步骤。系统保留子服务独立页面，同时通过本页聚合它们的共同业务语义。",
  ].join("\n")

  if (!existingContent.trim()) return `${frontmatter}${body}\n`
  return appendSectionIfMissing(existingContent, "## 子服务", body)
}

function upsertFamilyRelation(content: string, parentTitle: string, siblingLinks: string[]): string {
  let updated = upsertFrontmatterScalar(content, "parent", parentTitle)
  updated = upsertFrontmatterList(updated, "related", [parentTitle, ...siblingLinks.map((link) => link.replace(/^\[\[|\]\]$/g, ""))])
  const section = [
    "## 概念层级",
    "",
    `- 上位概念：[[${parentTitle}]]`,
    ...siblingLinks.map((link) => `- 同族服务：${link}`),
  ].join("\n")
  return appendSectionIfMissing(updated, "## 概念层级", section)
}

function upsertFrontmatterScalar(content: string, key: string, value: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return `---\n${key}: "${escapeYaml(value)}"\n---\n\n${content}`
  const fm = fmMatch[1]
  const rest = content.slice(fmMatch[0].length)
  const line = `${key}: "${escapeYaml(value)}"`
  if (new RegExp(`^${key}:`, "m").test(fm)) {
    return `---\n${fm.replace(new RegExp(`^${key}:.*$`, "m"), line)}\n---${rest}`
  }
  return `---\n${fm}\n${line}\n---${rest}`
}

function upsertFrontmatterList(content: string, key: string, values: string[]): string {
  const cleanValues = values.map((value) => value.trim()).filter(Boolean)
  if (cleanValues.length === 0) return content
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return `---\n${key}: [${cleanValues.map((value) => `"${escapeYaml(value)}"`).join(", ")}]\n---\n\n${content}`
  const fm = fmMatch[1]
  const rest = content.slice(fmMatch[0].length)
  const existing = extractListValuesFromFrontmatter(fm, key)
  const merged = dedupeStrings([...existing, ...cleanValues])
  const line = `${key}: [${merged.map((value) => `"${escapeYaml(value)}"`).join(", ")}]`
  if (new RegExp(`^${key}:`, "m").test(fm)) {
    return `---\n${fm.replace(new RegExp(`^${key}:.*$`, "m"), line)}\n---${rest}`
  }
  return `---\n${fm}\n${line}\n---${rest}`
}

function extractListValuesFromFrontmatter(frontmatter: string, key: string): string[] {
  const inline = frontmatter.match(new RegExp(`^${key}:\\s*\\[(.*)]\\s*$`, "m"))
  if (!inline) return []
  return inline[1]
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

function appendSectionIfMissing(content: string, heading: string, section: string): string {
  if (content.includes(heading)) return content
  return `${content.trimEnd()}\n\n${section}\n`
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function inferBusinessSignature(content: string, fallbackName: string): string {
  const entityType = extractScalar(content, "entity_type")
  const title = extractTitle(content) || fallbackName
  const identityText = `${fallbackName}\n${title}`.toLowerCase()
  const contentText = content.toLowerCase()

  if (entityType === "objection_handling" || /异议处理|objection|医保异议|保费太贵/.test(identityText)) {
    if (/医保|社保|医疗保险|补充医疗/.test(contentText)) return "method.objection.medical_insurance"
    if (/保费太贵|太贵|预算|年收入.*5%|5%/.test(contentText)) return "method.objection.premium_too_expensive"
    if (/身体很好|暂时不用|健康/.test(contentText)) return "method.objection.currently_healthy"
  }

  if (entityType === "persona" || /家庭经济支柱|30-45岁家庭支柱画像|高净值家庭健康管理客户|体检异常客户/.test(identityText)) {
    if (/家庭经济支柱|家庭支柱|30-45岁家庭支柱/.test(identityText)) return "customer.persona.family_breadwinner"
    if (/高净值|企业主|高管|健康管理体验/.test(identityText)) return "customer.persona.high_net_worth_health_management"
    if (/体检异常/.test(identityText)) return "customer.persona.abnormal_physical_exam"
  }

  if (entityType === "service_benefit" || entityType === "process" || /家庭医生在线咨询服务|重疾绿通服务|健康档案管理服务/.test(identityText)) {
    if (/康复门诊|康复住院|康复训练/.test(identityText)) return ""
    if (/家庭医生|在线咨询/.test(identityText)) return "product.service.family_doctor_online"
    if (/重疾绿通|绿通|专家门诊/.test(identityText)) return "product.service.critical_illness_green_channel"
    if (/健康档案/.test(identityText)) return "product.service.health_record_management"
  }

  if (entityType === "product" || /安心家庭守护重疾险/.test(identityText)) {
    return "product.anxin_family_guard_critical_illness"
  }

  return ""
}

const SERVICE_FAMILIES: VariantFamilyDefinition[] = [
  {
    signature: "product.service_family.rehab",
    title: "康复服务",
    description: "围绕重疾或术后康复阶段提供的门诊、住院、训练和随访类服务集合。",
    aliases: ["康复门诊协助", "康复住院协助", "康复训练管理", "康复随访"],
  },
  {
    signature: "product.service_family.critical_illness_journey",
    title: "重疾全程服务",
    description: "围绕重疾疑似确诊、诊疗、手术、住院和康复阶段的全流程医疗协助服务集合。",
    aliases: ["重疾专案管理", "检查安排协助", "专家会诊", "国内住院安排协助", "手术安排协助", "住院照护"],
  },
  {
    signature: "product.service_family.outpatient",
    title: "日常就医服务",
    description: "围绕普通门诊、预约、陪诊和线下就医过程的服务集合。",
    aliases: ["门诊预约协助", "就医陪诊"],
  },
  {
    signature: "product.service_family.family_doctor",
    title: "家庭医生服务组",
    description: "围绕家庭医生、在线问诊、音视频首访/随访和健康报告的主动健康管理服务集合。",
    aliases: ["家庭医生服务", "在线问诊", "音视频首访", "音视频随访", "年度健康报告"],
  },
]

export function inferVariantFamilySignature(content: string, fallbackName: string): VariantFamilyDefinition | null {
  const entityType = extractScalar(content, "entity_type")
  const type = extractScalar(content, "type")
  const title = extractTitle(content) || fallbackName
  const identityText = `${fallbackName}\n${title}`.toLowerCase()
  const contentText = content.toLowerCase()
  const haystack = `${identityText}\n${contentText}`

  if (["product", "persona", "compliance_rule", "source"].includes(entityType)) return null

  const serviceLike = entityType === "service_benefit" ||
    entityType === "process" ||
    type === "process" ||
    /服务|协助|问诊|会诊|陪诊|住院|门诊|康复|重疾|家庭医生/.test(identityText)
  if (!serviceLike) return null

  if (/康复(门诊|住院|训练|随访)|康复科|康复医院/.test(haystack)) return SERVICE_FAMILIES[0]
  if (/重疾|疑似确诊|专家会诊|手术安排|住院安排|检查安排|住院照护|海外远程/.test(haystack)) return SERVICE_FAMILIES[1]
  if (/门诊预约|就医陪诊|日常就医/.test(haystack)) return SERVICE_FAMILIES[2]
  if (/家庭医生|在线问诊|音视频(首访|随访|问诊)|年度健康报告/.test(haystack)) return SERVICE_FAMILIES[3]

  return null
}

function compatibleEntityTypes(existingType = "", newType = ""): boolean {
  if (!existingType || !newType) return true
  if (existingType === newType) return true

  const genericTypes = new Set(["general", "entity", "concept"])
  if (genericTypes.has(existingType) || genericTypes.has(newType)) return true

  return false
}

function compatibleEntityTypesForMerge(a = "", b = ""): boolean {
  if (compatibleEntityTypes(a, b)) return true
  const serviceTypes = new Set(["service_benefit", "process", "rule", "service_plan", "product"])
  return serviceTypes.has(a) && serviceTypes.has(b)
}

function chooseCanonicalEntity(a: ExistingEntity, b: ExistingEntity): [ExistingEntity, ExistingEntity] {
  const score = (entity: ExistingEntity): number => {
    let value = 0
    if (entity.entityType === "product" || entity.entityType === "service_benefit") value += 40
    if (entity.entityType === "service_plan") value += 30
    if (entity.entityType === "process") value += 20
    if (entity.entityType === "rule") value += 10
    value += Math.max(0, 80 - entity.name.length)
    if (!/流程|说明|规则/.test(entity.name)) value += 10
    return value
  }
  return score(a) >= score(b) ? [a, b] : [b, a]
}

function inferEntityDedupKey(content: string, fallbackName: string): string {
  const existing = extractScalar(content, "dedup_key")
  if (existing) return existing
  return inferStableInsuranceDedupKey({
    entityType: extractScalar(content, "entity_type"),
    title: extractTitle(content) || fallbackName,
    attributes: normalizeInsuranceAttributes(extractScalar(content, "entity_type"), extractAttributes(content)),
    fallback: fallbackName,
  })
}

function inferEntityIdentityKeys(content: string, fallbackName: string): string[] {
  const entityType = extractScalar(content, "entity_type")
  const title = extractTitle(content) || fallbackName
  const attributes = normalizeInsuranceAttributes(entityType, extractAttributes(content))
  const dedupKey = inferStableInsuranceDedupKey({
    entityType,
    title,
    attributes,
    fallback: fallbackName,
  })
  const existingDedupKey = extractScalar(content, "dedup_key")
  const keys = inferStrongInsuranceIdentityKeys({
    entityType,
    title,
    attributes,
    dedupKey: existingDedupKey || dedupKey,
  })
  const serviceKey = inferServiceTitleIdentityKey(title || fallbackName)
  if (serviceKey) keys.push(serviceKey)
  return dedupeStrings(keys)
}

function inferServiceTitleIdentityKey(title: string): string {
  const normalized = title
    .replace(/服务流程|流程|服务说明|说明|规则/g, "")
    .replace(/服务$/g, "")
    .replace(/[\s_\-·•、，,]/g, "")
    .trim()
  if (!normalized || normalized.length < 3) return ""
  if (!/家庭医生|在线问诊|音视频问诊|音视频首访|音视频随访|年度健康报告|名医大咖|特色体检|体检报告解读|21天社群训练营|用药服务|数字化管理|门诊预约协助|就医陪诊|检查安排协助|专家会诊|海外远程书面咨询|国内住院安排协助|手术安排协助|海外重疾住院安排协助|住院照护|出院安排协助|康复门诊协助|康复住院协助|上门护理|康复训练管理|重疾专案管理|心理咨询|臻享家医服务计划|平安臻享家医/.test(normalized)) {
    return ""
  }
  return `service_identity.title.${normalized.toLowerCase()}`
}

function hasSharedIdentityKey(existingKeys: string[], incomingKeys: string[]): boolean {
  if (existingKeys.length === 0 || incomingKeys.length === 0) return false
  const existing = new Set(existingKeys)
  return incomingKeys.some((key) => existing.has(key))
}

function extractAttributes(content: string): Record<string, unknown> {
  const raw = content.match(/^attributes:\s*(\{.*\})\s*$/m)?.[1]
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function extractTitle(content: string): string {
  return extractScalar(content, "title").replace(/^source:\s*/i, "")
}

function extractScalar(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?\\s*$`, "m"))
  return match ? match[1].trim().toLowerCase().replace(/[\s-]+/g, "_") : ""
}
