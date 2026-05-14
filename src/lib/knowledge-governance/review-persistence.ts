/**
 * knowledge-governance/review-persistence.ts
 *
 * Persists the Review Queue to {projectPath}/review-queue.json.
 * Pure FS — no UI, no LLM. Append-only by default; resolutions update in place.
 */

import { readFile, writeFile } from "@/commands/fs"
import type { ReviewItem, ReviewResolution } from "./types"

const QUEUE_FILE = "review-queue.json"

function queuePath(projectPath: string): string {
  return `${projectPath}/${QUEUE_FILE}`
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function loadReviewQueue(projectPath: string): Promise<ReviewItem[]> {
  try {
    const raw = await readFile(queuePath(projectPath))
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

async function saveReviewQueue(projectPath: string, items: ReviewItem[]): Promise<void> {
  await writeFile(queuePath(projectPath), JSON.stringify(items, null, 2))
}

/** Append a new ReviewItem. Silently deduplicates by newPagePath. */
export async function appendReviewItem(projectPath: string, item: ReviewItem): Promise<void> {
  const queue = await loadReviewQueue(projectPath)
  // Dedup: don't add if there's already a pending item for the same new page
  const alreadyPending = queue.some(
    (q) => q.newPagePath === item.newPagePath && q.status === "pending",
  )
  if (alreadyPending) return
  queue.push(item)
  await saveReviewQueue(projectPath, queue)
}

/** Mark a review item as resolved. */
export async function resolveReviewItem(
  projectPath: string,
  id: string,
  resolution: ReviewResolution,
  resolvedBy: "user" | "auto" = "user",
): Promise<void> {
  const queue = await loadReviewQueue(projectPath)
  const idx = queue.findIndex((q) => q.id === id)
  if (idx === -1) return
  queue[idx] = {
    ...queue[idx],
    status: "resolved",
    resolution,
    resolvedBy,
    resolvedAt: new Date().toISOString(),
  }
  await saveReviewQueue(projectPath, queue)
}

/** Dismiss a review item (skip without making a knowledge decision). */
export async function dismissReviewItem(projectPath: string, id: string): Promise<void> {
  const queue = await loadReviewQueue(projectPath)
  const idx = queue.findIndex((q) => q.id === id)
  if (idx === -1) return
  queue[idx] = { ...queue[idx], status: "dismissed", resolvedAt: new Date().toISOString() }
  await saveReviewQueue(projectPath, queue)
}

/** Returns only pending (unresolved, undismissed) items. */
export function filterPendingItems(items: ReviewItem[]): ReviewItem[] {
  return items.filter((i) => i.status === "pending")
}
