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
        results.push({
          fullPath: `${projectPath}/${relativePath}`,
          relativePath,
          name: nameFromPath(relativePath),
        })
      }
    } catch {
      // Directory doesn't exist yet — fine, first ingest
    }
  }

  return results
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

  // Find the first existing entity that is "similar" but NOT the exact same path
  const match = existingEntities.find(
    (e) =>
      e.relativePath !== relativePath &&
      isSimilar(e.name, newName),
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
