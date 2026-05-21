/**
 * knowledge-governance/status-manager.ts
 *
 * Reads and writes the `status` field in wiki page frontmatter.
 * This module is pure FS — no LLM, no vector store, no UI.
 */

import { readFile, writeFile } from "@/commands/fs"
import type { KnowledgeStatus } from "./types"
import { DEFAULT_STATUS } from "./types"

// ── Frontmatter parsing ──────────────────────────────────────────────────────

/**
 * Extract the `status` value from a page's frontmatter.
 * Returns DEFAULT_STATUS ("active") if the field is absent (legacy pages).
 */
export function parseStatusFromContent(content: string): KnowledgeStatus {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)
  if (!match) return DEFAULT_STATUS
  const statusMatch = match[1].match(/^status:\s*["']?(\w+)["']?\s*$/m)
  if (!statusMatch) return DEFAULT_STATUS
  const raw = statusMatch[1].toLowerCase()
  if (raw === "candidate" || raw === "active" || raw === "superseded" || raw === "rejected") {
    return raw as KnowledgeStatus
  }
  return DEFAULT_STATUS
}

/**
 * Inject or update the `status` field in frontmatter.
 * Preserves all other frontmatter fields and the body.
 */
export function setStatusInContent(content: string, status: KnowledgeStatus): string {
  // If there's existing frontmatter, update or insert the status line
  if (content.match(/^---\r?\n[\s\S]*?\r?\n---/m)) {
    // Replace existing status line
    if (/^status:/m.test(content)) {
      return content.replace(/^status:.*$/m, `status: "${status}"`)
    }
    // Insert after the opening ---
    return content.replace(/^(---\r?\n)/, `$1status: "${status}"\n`)
  }
  // No frontmatter at all — prepend minimal frontmatter
  return `---\nstatus: "${status}"\n---\n\n${content}`
}

// ── File-level API ───────────────────────────────────────────────────────────

/** Read the status of a page from disk. */
export async function getPageStatus(pagePath: string): Promise<KnowledgeStatus> {
  try {
    const content = await readFile(pagePath)
    return parseStatusFromContent(content)
  } catch {
    return DEFAULT_STATUS
  }
}

/**
 * Write a new status to a page on disk.
 * Returns the updated content (for callers that want to refresh the UI).
 */
export async function setPageStatus(pagePath: string, status: KnowledgeStatus): Promise<string> {
  const content = await readFile(pagePath)
  const updated = setStatusInContent(content, status)
  await writeFile(pagePath, updated)
  return updated
}

/**
 * Stamp a freshly generated page as "candidate".
 * Called by the ingest pipeline immediately after writing the file.
 * Ingested pages must remain candidate until a human explicitly approves them.
 */
export async function stampCandidate(pagePath: string): Promise<void> {
  try {
    const content = await readFile(pagePath)
    const updated = setStatusInContent(content, "candidate")
    if (updated !== content) await writeFile(pagePath, updated)
  } catch (err) {
    console.warn("[status-manager] Failed to stamp candidate:", pagePath, err)
  }
}
