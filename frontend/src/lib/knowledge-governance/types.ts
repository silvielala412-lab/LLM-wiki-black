/**
 * knowledge-governance/types.ts
 *
 * Shared type definitions for the knowledge governance system.
 * This is the ONLY file that crosses module boundaries.
 * All governance modules import from here; never from each other.
 */

// ── Knowledge Status ────────────────────────────────────────────────────────

/**
 * Lifecycle state of a wiki page.
 *
 * candidate  — Newly ingested, awaiting human or auto confirmation.
 *              Searchable but with lower RAG weight.
 * active     — Confirmed knowledge. Primary source for RAG.
 * superseded — Replaced by a newer version. Retained for history.
 * rejected   — Determined to be incorrect or duplicate. Excluded from RAG.
 */
export type KnowledgeStatus = "candidate" | "active" | "superseded" | "rejected"

/** When a page has no status field (legacy / manually created), treat as active. */
export const DEFAULT_STATUS: KnowledgeStatus = "active"

// ── Judge Module Types ───────────────────────────────────────────────────────

/**
 * Relationship between a new page/claim and an existing one.
 * Judge Module outputs this; Policy Engine consumes it.
 */
export type JudgeRelation =
  | "same"        // Exact duplicate — new adds nothing
  | "update"      // New content updates or refines the old
  | "conflict"    // Content contradicts existing knowledge
  | "complement"  // Adds new detail without contradicting
  | "unrelated"   // Different topic entirely
  | "uncertain"   // LLM cannot determine with confidence

export type JudgeConfidence = "high" | "medium" | "low"

export interface JudgementResult {
  relation: JudgeRelation
  confidence: JudgeConfidence
  /** Human-readable explanation shown in Review UI */
  reason: string
  /** The model that produced this judgement */
  model?: string
  /** ISO timestamp */
  judgedAt: string
}

// ── Policy Engine Types ──────────────────────────────────────────────────────

/**
 * What the Policy Engine decides to do with a new piece of knowledge.
 *
 * auto_accept — Automatically confirm as active, no user action needed.
 * notify      — Accept but show a lightweight toast notification.
 * review      — Route to Review Queue for human decision.
 */
export type PolicyDecision = "auto_accept" | "notify" | "review"

// ── Review Queue Types ───────────────────────────────────────────────────────

export type ReviewResolution =
  | "accepted"    // User confirmed: new page becomes active
  | "rejected"    // User rejected: new page marked rejected
  | "merged"      // User chose to merge into existing page
  | "superseded"  // User confirmed: old page becomes superseded, new becomes active
  | "unrelated"   // User says the suggested A-B relation is wrong; keep the new page

export type ReviewStatus = "pending" | "resolved" | "dismissed"

export interface ReviewItem {
  /** UUID for this review item */
  id: string
  /** Absolute path to the project root */
  projectPath: string
  /** The newly ingested / created page */
  newPagePath: string
  newPageTitle: string
  /** Brief excerpt from the new page (first 300 chars of body) */
  newPageExcerpt?: string
  /** The existing page this conflicts / overlaps with, if any */
  existingPagePath?: string
  existingPageTitle?: string
  existingPageExcerpt?: string
  /** LLM judgement (present only if Judge Module has run) */
  judgement?: JudgementResult
  /** What the Policy Engine decided */
  policyDecision: PolicyDecision
  /** Current state of this review item */
  status: ReviewStatus
  /** ISO timestamp when this item was created */
  createdAt: string
  /** ISO timestamp when resolved */
  resolvedAt?: string
  /** Who resolved: human via UI, or auto by policy */
  resolvedBy?: "user" | "auto"
  resolution?: ReviewResolution
}
