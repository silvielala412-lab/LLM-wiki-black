/**
 * knowledge-governance/lineage-tracker.ts
 *
 * Tracks knowledge transition records — when a new page supersedes an
 * old one, this module records the event with semantic diff points
 * extracted by the LLM.
 *
 * Storage: {projectPath}/knowledge-lineage.json
 *
 * Pure FS — no UI. Called by the Review Panel when the user confirms
 * a "superseded" or "merged" resolution.
 */

import { readFile, writeFile } from "@/commands/fs"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KnowledgeTransition {
  /** UUID */
  id: string
  /** Relation type */
  relation: "supersedes" | "updates" | "merged_into"
  /** The old page being replaced */
  fromPagePath: string
  fromPageTitle: string
  /** The new page doing the replacing */
  toPagePath: string
  toPageTitle: string
  /** ISO date when the transition was confirmed */
  effectiveDate: string
  /** Semantic diff — extracted by LLM */
  addedPoints: string[]      // New knowledge in the new page (not in old)
  removedPoints: string[]    // Knowledge in old page missing from new
  changedPoints: string[]    // Concepts that changed between versions
  /** One-line human-readable summary */
  summary: string
  /** Who triggered this transition */
  resolvedBy: "user" | "auto"
}

const LINEAGE_FILE = "knowledge-lineage.json"

function lineagePath(projectPath: string): string {
  return `${projectPath}/${LINEAGE_FILE}`
}

// ── Read / Write ─────────────────────────────────────────────────────────────

export async function loadLineage(projectPath: string): Promise<KnowledgeTransition[]> {
  try {
    const raw = await readFile(lineagePath(projectPath))
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function appendTransition(
  projectPath: string,
  transition: KnowledgeTransition,
): Promise<void> {
  const records = await loadLineage(projectPath)
  // Deduplicate: don't add if same from/to already exists
  const dup = records.some(
    (r) => r.fromPagePath === transition.fromPagePath && r.toPagePath === transition.toPagePath,
  )
  if (!dup) {
    records.push(transition)
    await writeFile(lineagePath(projectPath), JSON.stringify(records, null, 2))
  }
}

// ── Frontmatter injection ─────────────────────────────────────────────────────

/**
 * Inject lineage pointers into page frontmatter:
 *   Old page: superseded_by: "path/to/new"
 *   New page: supersedes: "path/to/old"
 */
async function injectLineageFrontmatter(
  pagePath: string,
  field: "superseded_by" | "supersedes",
  value: string,
): Promise<void> {
  try {
    const content = await readFile(pagePath)
    if (content.includes(`${field}:`)) return  // Already set

    const updated = content.match(/^---\r?\n/)
      ? content.replace(/^(---\r?\n)/, `$1${field}: "${value.replace(/"/g, '\\"')}"\n`)
      : `---\n${field}: "${value}"\n---\n\n${content}`

    await writeFile(pagePath, updated)
  } catch (err) {
    console.warn(`[lineage-tracker] Failed to inject ${field} into ${pagePath}:`, err)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a knowledge supersession event.
 * Call this AFTER the user confirms "替代旧版本" in the Review Panel.
 *
 * @param projectPath  Absolute project root
 * @param fromPagePath Absolute path to the OLD page
 * @param fromPageTitle Title of the old page
 * @param toPagePath   Absolute path to the NEW page
 * @param toPageTitle  Title of the new page
 * @param diffResult   Semantic diff from the diff engine (may be null if LLM failed)
 * @param relation     Type of transition
 */
export async function recordTransition(
  projectPath: string,
  fromPagePath: string,
  fromPageTitle: string,
  toPagePath: string,
  toPageTitle: string,
  diffResult: Pick<KnowledgeTransition, "addedPoints" | "removedPoints" | "changedPoints" | "summary"> | null,
  relation: KnowledgeTransition["relation"] = "supersedes",
): Promise<KnowledgeTransition> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const transition: KnowledgeTransition = {
    id,
    relation,
    fromPagePath,
    fromPageTitle,
    toPagePath,
    toPageTitle,
    effectiveDate: new Date().toISOString(),
    addedPoints:   diffResult?.addedPoints   ?? [],
    removedPoints: diffResult?.removedPoints ?? [],
    changedPoints: diffResult?.changedPoints ?? [],
    summary:       diffResult?.summary       ?? `「${toPageTitle}」替代了「${fromPageTitle}」`,
    resolvedBy: "user",
  }

  // Persist lineage record
  await appendTransition(projectPath, transition)

  // Inject cross-reference pointers into both pages' frontmatter
  await injectLineageFrontmatter(fromPagePath, "superseded_by", toPagePath)
  await injectLineageFrontmatter(toPagePath,   "supersedes",    fromPagePath)

  return transition
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Get all transitions where this page was replaced (old page). */
export function getSupersededBy(
  transitions: KnowledgeTransition[],
  pagePath: string,
): KnowledgeTransition | undefined {
  return transitions.find((t) => t.fromPagePath === pagePath)
}

/** Get all transitions where this page replaced something (new page). */
export function getSupersedes(
  transitions: KnowledgeTransition[],
  pagePath: string,
): KnowledgeTransition | undefined {
  return transitions.find((t) => t.toPagePath === pagePath)
}

/**
 * Build a full version chain for a topic, sorted oldest → newest.
 * Starts from any page in the chain and walks both directions.
 */
export function buildVersionChain(
  transitions: KnowledgeTransition[],
  pagePath: string,
): KnowledgeTransition[] {
  const chain: KnowledgeTransition[] = []
  const visited = new Set<string>()

  // Walk backward (find what this page replaced)
  let current = pagePath
  while (true) {
    if (visited.has(current)) break
    visited.add(current)
    const t = transitions.find((t) => t.toPagePath === current)
    if (!t) break
    chain.unshift(t)
    current = t.fromPagePath
  }

  // Walk forward (find what replaced this page)
  current = pagePath
  visited.clear()
  while (true) {
    if (visited.has(current)) break
    visited.add(current)
    const t = transitions.find((t) => t.fromPagePath === current)
    if (!t) break
    chain.push(t)
    current = t.toPagePath
  }

  return chain
}
