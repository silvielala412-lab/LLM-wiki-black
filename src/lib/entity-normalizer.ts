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

import { listDirectory, readFile, writeFile } from "@/commands/fs"

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
  /** Lightweight business signature used for schema-aware deduplication. */
  businessSignature?: string
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
          businessSignature: inferBusinessSignature(existingContent, nameFromPath(relativePath)),
        })
      }
    } catch {
      // Directory doesn't exist yet — fine, first ingest
    }
  }

  return results
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
  const newSignature = inferBusinessSignature(content, newName)
  const newEntityType = extractScalar(content, "entity_type")

  // Find the first existing entity that is "similar" but NOT the exact same path
  const match = existingEntities.find(
    (e) =>
      e.relativePath !== relativePath &&
      (
        (newSignature && e.businessSignature === newSignature && compatibleEntityTypes(e.entityType, newEntityType)) ||
        (!newSignature && compatibleEntityTypes(e.entityType, newEntityType) && isSimilar(e.name, newName))
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

  if (entityType === "service_benefit" || /家庭医生在线咨询服务|重疾绿通服务|健康档案管理服务/.test(identityText)) {
    if (/家庭医生|在线咨询/.test(identityText)) return "product.service.family_doctor_online"
    if (/重疾绿通|绿通|专家门诊/.test(identityText)) return "product.service.critical_illness_green_channel"
    if (/健康档案/.test(identityText)) return "product.service.health_record_management"
  }

  if (entityType === "product" || /安心家庭守护重疾险/.test(identityText)) {
    return "product.anxin_family_guard_critical_illness"
  }

  return ""
}

function compatibleEntityTypes(existingType = "", newType = ""): boolean {
  if (!existingType || !newType) return true
  if (existingType === newType) return true

  const genericTypes = new Set(["general", "entity", "concept"])
  if (genericTypes.has(existingType) || genericTypes.has(newType)) return true

  return false
}

function extractTitle(content: string): string {
  return extractScalar(content, "title").replace(/^source:\s*/i, "")
}

function extractScalar(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?\\s*$`, "m"))
  return match ? match[1].trim().toLowerCase().replace(/[\s-]+/g, "_") : ""
}
