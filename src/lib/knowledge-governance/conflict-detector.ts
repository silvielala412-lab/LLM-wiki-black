/**
 * knowledge-governance/conflict-detector.ts
 *
 * Finds existing wiki pages that are semantically similar to a newly
 * ingested page. Uses the vector embedding store when available,
 * falling back to title-based fuzzy matching when embeddings are off.
 *
 * This module is pure logic — no UI, no LLM calls, no side effects
 * beyond reading the file system and vector store.
 */

import { readFile } from "@/commands/fs"

// ─── Path segments that are ALWAYS skipped ─────────────────────────────────
// Add new non-entity wiki subdirectories here — the check runs on
// both the vector branch and the title-scan branch automatically.
const SKIP_PATH_SEGMENTS = [
  "/wiki/audits/",
  "/wiki/sources/",
  "/wiki/queries/",
  "/wiki/.identity-audit/",
] as const

function isSkippedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return SKIP_PATH_SEGMENTS.some(seg => normalized.includes(seg))
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictCandidate {
  /** Relative wiki page ID (e.g. "concepts/my-concept") */
  pageId: string
  /** Absolute path to the existing page */
  pagePath: string
  /** Display title extracted from frontmatter */
  title: string
  /** Similarity score 0-1 (from vector search or title heuristic) */
  score: number
  /** First 400 chars of the body, for the review decision card */
  excerpt: string
  /** How the match was found */
  matchMethod: "vector" | "title_exact" | "title_fuzzy"
}

// Thresholds
const VECTOR_HIGH_SIMILARITY = 0.88   // Treat as definite conflict candidate
const VECTOR_MIN_SIMILARITY  = 0.78   // Minimum to surface at all

// ── Helper: extract title + excerpt from page content ────────────────────────

function extractTitleAndExcerpt(content: string): { title: string; excerpt: string } {
  // Try frontmatter title
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/m)
  let title = ""
  if (fmMatch) {
    const titleLine = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleLine) title = titleLine[1].trim()
  }
  // Fall back to first H1
  if (!title) {
    const h1 = content.match(/^#\s+(.+)$/m)
    if (h1) title = h1[1].trim()
  }

  // Excerpt: first 400 chars of body after frontmatter
  const body = fmMatch ? content.slice(fmMatch[0].length) : content
  const excerpt = body.replace(/^#+\s+.+$/gm, "").replace(/\s+/g, " ").trim().slice(0, 400)

  return { title: title || "Untitled", excerpt }
}

function isSourcePagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  return normalized.includes("/wiki/sources/") ||
    normalized.startsWith("wiki/sources/") ||
    normalized.startsWith("sources/")
}

function frontmatterScalar(content: string, key: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ""
  const match = fm.match(new RegExp(`^${key}\\s*:\\s*["']?([^"'\\r\\n#]*?)["']?\\s*$`, "m"))
  return match?.[1]?.trim().toLowerCase() ?? ""
}

function isSourceTypedContent(content: string): boolean {
  const et = frontmatterScalar(content, "entity_type")
  const tp = frontmatterScalar(content, "type")
  // Skip source documents, audit reports, query pages, and already-merged entities
  if (["source", "audit_report", "source_summary", "query", "audit", "report"].includes(et)) return true
  if (["source", "query"].includes(tp)) return true
  // Skip pages already absorbed by Identity Pass (redirect_to marker)
  if (/^redirect_to:\s*".+"/m.test(content)) return true
  return false
}

// ── Vector-based detection ───────────────────────────────────────────────────

/**
 * Find pages similar to `newContent` using the vector index.
 * Returns candidates sorted by score descending.
 *
 * @param projectPath  Absolute project root path
 * @param newPageId    Page ID of the new page (excluded from results)
 * @param newContent   Full markdown content of the new page
 * @param embCfg       Embedding config from wiki-store
 * @param topK         Maximum candidates to return
 */
export async function findSimilarByVector(
  projectPath: string,
  newPageId: string,
  newContent: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  embCfg: any,
  topK = 5,
): Promise<ConflictCandidate[]> {
  try {
    const { searchByEmbedding } = await import("@/lib/embedding")
    const { normalizePath } = await import("@/lib/path-utils")
    const pp = normalizePath(projectPath)
    const newIsSource = isSourcePagePath(newPageId) || isSourceTypedContent(newContent)
    if (newIsSource) return []

    // Use the page's title + first 500 chars as the search query
    const { title, excerpt } = extractTitleAndExcerpt(newContent)
    const query = `${title}\n\n${excerpt.slice(0, 500)}`

    const results = await searchByEmbedding(pp, query, embCfg, topK + 1)

    const candidates: ConflictCandidate[] = []
    for (const r of results) {
      // Skip the page itself (just ingested)
      if (r.id === newPageId) continue
      if (r.score < VECTOR_MIN_SIMILARITY) continue

      // Resolve to absolute path — try common wiki subdirs
      const dirs = ["concepts", "entities", "queries"]
      let pagePath = ""
      for (const dir of dirs) {
        const candidate = `${pp}/wiki/${dir}/${r.id}.md`
        try {
          const content = await readFile(candidate)
          // Skip audit/source/redirect pages even if vector-similar
          if (isSourceTypedContent(content)) break
          const { title: existingTitle, excerpt: existingExcerpt } = extractTitleAndExcerpt(content)
          candidates.push({
            pageId: r.id,
            pagePath: candidate,
            title: existingTitle,
            score: r.score,
            excerpt: existingExcerpt,
            matchMethod: r.score >= VECTOR_HIGH_SIMILARITY ? "vector" : "vector",
          })
          pagePath = candidate
          break
        } catch {
          // Try next dir
        }
      }

      // If we still haven't resolved it, try a flat wiki/ path
      if (!pagePath) {
        const candidate = `${pp}/wiki/${r.id}.md`
        try {
          const content = await readFile(candidate)
          // Skip audit/source/redirect pages even if vector-similar
          if (!isSourceTypedContent(content)) {
            const { title: existingTitle, excerpt: existingExcerpt } = extractTitleAndExcerpt(content)
            candidates.push({
              pageId: r.id,
              pagePath: candidate,
              title: existingTitle,
              score: r.score,
              excerpt: existingExcerpt,
              matchMethod: "vector",
            })
          }
        } catch {
          // Page ID found in vector store but can't read file — skip
        }
      }

      if (candidates.length >= topK) break
    }

    return candidates.sort((a, b) => b.score - a.score)
  } catch (err) {
    console.warn("[conflict-detector] Vector search failed:", err)
    return []
  }
}

// ── Keyword extraction helper ─────────────────────────────────────────────────

/**
 * Extract meaningful keywords from a title.
 * - Strips year-like numbers (2020-2029)
 * - Strips common noise chars
 * - Splits by CJK character boundaries and Latin words
 * - Returns unique tokens of length ≥ 2
 */
function extractKeywords(title: string): string[] {
  const normalized = title
    .toLowerCase()
    .replace(/20\d{2}/g, "")          // remove years like 2023, 2024
    .replace(/[（）()【】\[\]「」\s_\-·]/g, " ") // punctuation → space
    .trim()

  // Split CJK characters into bigrams + Latin words
  const tokens: string[] = []
  const latinWords = normalized.match(/[a-z0-9]{2,}/g) ?? []
  tokens.push(...latinWords)

  // CJK: extract all 2-char sequences as bigrams
  const cjk = normalized.replace(/[a-z0-9\s]/g, "")
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.push(cjk.slice(i, i + 2))
  }
  // Also add individual CJK chars that appear ≥ 2 times in original title
  for (const ch of cjk) {
    if (ch.trim()) tokens.push(ch)
  }

  return [...new Set(tokens.filter((t) => t.length >= 1))]
}

/** Jaccard-like keyword overlap score 0-1 */
function keywordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const kw of setA) { if (setB.has(kw)) intersection++ }
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

// ── Title-based fallback ─────────────────────────────────────────────────────

/**
 * Find pages with a similar title using file system scan.
 * Used as fallback when embedding is not configured.
 *
 * Matching strategy (in priority order):
 *   1. Exact title match               → score 0.95
 *   2. One title contains the other    → score 0.75
 *   3. Keyword overlap ≥ 0.30          → score 0.65
 *
 * @param projectPath  Absolute project root path
 * @param newTitle     Title of the new page
 * @param newPagePath  Absolute path of the new page (excluded)
 */
export async function findSimilarByTitle(
  projectPath: string,
  newTitle: string,
  newPagePath: string,
): Promise<ConflictCandidate[]> {
  try {
    const { listDirectory } = await import("@/commands/fs")
    const { normalizePath } = await import("@/lib/path-utils")
    const pp = normalizePath(projectPath)
    if (isSourcePagePath(newPagePath)) return []

    // Flatten all .md files under wiki/
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function flatten(nodes: any[]): string[] {
      const result: string[] = []
      for (const n of nodes) {
        if (n.is_dir && n.children) result.push(...flatten(n.children))
        else if (!n.is_dir && n.name?.endsWith(".md")) result.push(n.path as string)
      }
      return result
    }

    const tree = await listDirectory(`${pp}/wiki`) as unknown[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allPaths = flatten(tree as any[])

    const candidates: ConflictCandidate[] = []
    const needle = newTitle.toLowerCase().replace(/\s+/g, "")
    const needleKeywords = extractKeywords(newTitle)
    const SKIP = new Set(["index.md", "log.md", "overview.md"])

    for (const filePath of allPaths) {
      const base = filePath.split(/[/\\]/).pop() ?? ""
      if (SKIP.has(base)) continue
      if (filePath === newPagePath) continue
      if (isSourcePagePath(filePath)) continue
      if (isSkippedPath(filePath)) continue  // path-based audit/source/query filter

      try {
        const content = await readFile(filePath)
        if (isSourceTypedContent(content)) continue
        const { title, excerpt } = extractTitleAndExcerpt(content)
        const titleNorm = title.toLowerCase().replace(/\s+/g, "")

        let score = 0
        let method: ConflictCandidate["matchMethod"] = "title_fuzzy"

        if (titleNorm === needle) {
          score = 0.95
          method = "title_exact"
        } else if (titleNorm.includes(needle) || needle.includes(titleNorm)) {
          score = 0.75
        } else {
          // Keyword overlap fallback
          const existingKeywords = extractKeywords(title)
          const kwScore = keywordSimilarity(needleKeywords, existingKeywords)
          if (kwScore >= 0.30) {
            score = 0.55 + kwScore * 0.3  // maps 0.30..1.0 → 0.64..0.85
          }
        }

        if (score > 0) {
          candidates.push({
            pageId: base.replace(/\.md$/, ""),
            pagePath: filePath,
            title,
            score,
            excerpt,
            matchMethod: method,
          })
        }
      } catch {
        // Skip unreadable files
      }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, 5)
  } catch (err) {
    console.warn("[conflict-detector] Title scan failed:", err)
    return []
  }
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point: find similar pages for a newly written wiki page.
 * Tries vector search first; falls back to title scan.
 *
 * @returns Sorted list of conflict candidates (best match first)
 */
export async function detectConflicts(
  projectPath: string,
  newPageId: string,
  newPagePath: string,
  newContent: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  embCfg: any,
): Promise<ConflictCandidate[]> {
  if (isSourcePagePath(newPagePath) || isSourceTypedContent(newContent)) return []

  const embEnabled = embCfg?.enabled && embCfg?.model

  if (embEnabled) {
    const vectorResults = await findSimilarByVector(projectPath, newPageId, newContent, embCfg)
    if (vectorResults.length > 0) return vectorResults
  }

  // Fallback: title-based scan
  const { title } = extractTitleAndExcerpt(newContent)
  return findSimilarByTitle(projectPath, title, newPagePath)
}
