/**
 * knowledge-governance/orchestrator.ts
 *
 * Wires together conflict-detector → judge-module → policy-engine
 * into a single async pipeline called after each page is written.
 *
 * This is the ONLY file that imports multiple governance modules.
 * External callers (ingest.ts) import only from index.ts.
 *
 * Pipeline (all steps run asynchronously, never blocking the ingest):
 *   1. detectConflicts      — find similar existing pages
 *   2. judgeRelationship    — ask LLM to classify the relationship
 *   3. evaluatePolicy       — decide: auto_accept / notify / review
 *   4. appendReviewItem     — persist to review-queue.json if needed
 *   5. setPageStatus        — update frontmatter status if auto-resolved
 */

import { detectConflicts } from "./conflict-detector"
import { judgeRelationship } from "./judge-module"
import { evaluatePolicy, buildPolicyDescription } from "./policy-engine"
import { appendReviewItem } from "./review-persistence"
import { setPageStatus } from "./status-manager"
import type { ReviewItem } from "./types"

// ── Tiny ID generator (no crypto dependency) ─────────────────────────────────
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Page ID from absolute path ────────────────────────────────────────────────
function pageIdFromPath(pagePath: string, projectPath: string): string {
  const rel = pagePath.replace(projectPath, "").replace(/\\/g, "/").replace(/^\/+/, "")
  // Strip leading "wiki/" and trailing ".md"
  return rel.replace(/^wiki\//, "").replace(/\.md$/, "")
}

// ── Notification helper (toast via activity store) ───────────────────────────
async function notifyUser(message: string): Promise<void> {
  try {
    const { useActivityStore } = await import("@/stores/activity-store")
    useActivityStore.getState().addItem({
      type: "ingest",
      status: "done",
      title: "知识治理",
      detail: message,
      filesWritten: [],
    })
  } catch {
    console.info("[governance] notify:", message)
  }
}

// ── Main orchestration ────────────────────────────────────────────────────────

/**
 * Run the full governance pipeline for one newly written page.
 * Should be called fire-and-forget (don't await in the hot path).
 *
 * @param projectPath  Absolute path to the project root
 * @param newPagePath  Absolute path to the newly written .md file
 * @param newContent   Full markdown content of the new page
 * @param embCfg       EmbeddingConfig from wiki-store
 * @param llmConfig    LLM config from wiki-store
 */
export async function runGovernancePipeline(
  projectPath: string,
  newPagePath: string,
  newContent: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  embCfg: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llmConfig: any,
): Promise<void> {
  const newPageId = pageIdFromPath(newPagePath, projectPath)

  // ── Step 1: Conflict Detection ─────────────────────────────────────────────
  let candidates
  try {
    candidates = await detectConflicts(projectPath, newPageId, newPagePath, newContent, embCfg)
  } catch (err) {
    console.warn("[governance] Conflict detection failed:", err)
    return
  }

  if (candidates.length === 0) {
    // No similar pages found — new page stays as candidate, nothing to review
    console.log(`[governance] No conflicts found for ${newPageId}`)
    return
  }

  // Use the top-scoring candidate
  const topCandidate = candidates[0]
  console.log(
    `[governance] Conflict candidate for "${newPageId}": "${topCandidate.title}" (score=${topCandidate.score.toFixed(2)}, method=${topCandidate.matchMethod})`,
  )

  // ── Step 2: LLM Judgement ─────────────────────────────────────────────────
  // Extract new page title + excerpt
  const fmMatch = newContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/m)
  let newTitle = "Untitled"
  if (fmMatch) {
    const t = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (t) newTitle = t[1].trim()
  }
  if (!newTitle || newTitle === "Untitled") {
    const h1 = newContent.match(/^#\s+(.+)$/m)
    if (h1) newTitle = h1[1].trim()
  }
  const newExcerpt = (fmMatch ? newContent.slice(fmMatch[0].length) : newContent)
    .replace(/^#+\s+.+$/gm, "").replace(/\s+/g, " ").trim().slice(0, 600)

  let judgement = null
  try {
    judgement = await judgeRelationship(
      llmConfig,
      newTitle,
      newExcerpt,
      topCandidate.title,
      topCandidate.excerpt,
    )
  } catch (err) {
    console.warn("[governance] Judge module failed:", err)
    // Proceed without judgement — policy engine handles null
  }

  // ── Step 3: Policy Decision ───────────────────────────────────────────────
  const decision = evaluatePolicy(judgement, {
    similarityScore: topCandidate.score,
  })

  const description = buildPolicyDescription(
    judgement,
    decision,
    newTitle,
    topCandidate.title,
  )

  console.log(`[governance] Policy decision for "${newPageId}": ${decision} (relation=${judgement?.relation ?? "none"}, confidence=${judgement?.confidence ?? "none"})`)

  // ── Step 4: Act on decision ───────────────────────────────────────────────
  if (decision === "auto_accept") {
    // Automatically confirm the new page as active
    await setPageStatus(newPagePath, "active").catch(() => {})
    return
  }

  if (decision === "notify") {
    // Don't create a review item — just notify the user
    await notifyUser(description)
    return
  }

  // decision === "review" → persist to Review Queue
  const reviewItem: ReviewItem = {
    id: generateId(),
    projectPath,
    newPagePath,
    newPageTitle: newTitle,
    newPageExcerpt: newExcerpt.slice(0, 400),
    existingPagePath: topCandidate.pagePath,
    existingPageTitle: topCandidate.title,
    existingPageExcerpt: topCandidate.excerpt.slice(0, 400),
    judgement: judgement ?? undefined,
    policyDecision: decision,
    status: "pending",
    createdAt: new Date().toISOString(),
  }

  try {
    await appendReviewItem(projectPath, reviewItem)
    // Notify UI to refresh the review badge count
    try {
      const { useGovernanceStore } = await import("@/stores/governance-store")
      const store = useGovernanceStore.getState()
      if (store.items.length > 0 || store.pendingCount > 0) {
        // Queue already loaded — add the item directly
        await store.addItem(projectPath, reviewItem)
      }
      // If store wasn't loaded (user not on review tab), it'll load fresh next time
    } catch {
      // Store not available in test / SSR context
    }

    await notifyUser(`发现可能的知识冲突：「${newTitle}」与「${topCandidate.title}」，已加入审核队列。`)
  } catch (err) {
    console.warn("[governance] Failed to append review item:", err)
  }
}
