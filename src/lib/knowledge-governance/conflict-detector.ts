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
      const dirs = ["concepts", "entities", "queries", "sources"]
      let pagePath = ""
      for (const dir of dirs) {
        const candidate = `${pp}/wiki/${dir}/${r.id}.md`
        try {
          const content = await readFile(candidate)
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
          const { title: existingTitle, excerpt: existingExcerpt } = extractTitleAndExcerpt(content)
          candidates.push({
            pageId: r.id,
            pagePath: candidate,
            title: existingTitle,
            score: r.score,
            excerpt: existingExcerpt,
            matchMethod: "vector",
          })
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

// ── Title-based fallback ─────────────────────────────────────────────────────

/**
 * Find pages with a similar title using file system scan.
 * Used as fallback when embedding is not configured.
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
    const SKIP = new Set(["index.md", "log.md", "overview.md"])

    for (const filePath of allPaths) {
      const base = filePath.split(/[/\\]/).pop() ?? ""
      if (SKIP.has(base)) continue
      if (filePath === newPagePath) continue

      try {
        const content = await readFile(filePath)
        const { title, excerpt } = extractTitleAndExcerpt(content)
        const titleNorm = title.toLowerCase().replace(/\s+/g, "")

        let score = 0
        let method: ConflictCandidate["matchMethod"] = "title_fuzzy"

        if (titleNorm === needle) {
          score = 0.95
          method = "title_exact"
        } else if (titleNorm.includes(needle) || needle.includes(titleNorm)) {
          score = 0.75
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
  const embEnabled = embCfg?.enabled && embCfg?.model

  if (embEnabled) {
    const vectorResults = await findSimilarByVector(projectPath, newPageId, newContent, embCfg)
    if (vectorResults.length > 0) return vectorResults
  }

  // Fallback: title-based scan
  const { title } = extractTitleAndExcerpt(newContent)
  return findSimilarByTitle(projectPath, title, newPagePath)
}
