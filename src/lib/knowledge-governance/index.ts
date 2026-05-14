/**
 * knowledge-governance/index.ts
 *
 * Public API for the knowledge governance system.
 * External modules ONLY import from here — never from internal files.
 *
 * Internal module boundaries:
 *   types.ts              ← shared types (ok to import directly for types only)
 *   status-manager.ts     ← frontmatter status R/W
 *   review-persistence.ts ← review-queue.json R/W
 *   judge-module.ts       ← LLM judgement (Phase 2)
 *   policy-engine.ts      ← decision policy (Phase 3)
 */

// Types (re-exported for convenience)
export type {
  KnowledgeStatus,
  JudgeRelation,
  JudgeConfidence,
  JudgementResult,
  PolicyDecision,
  ReviewResolution,
  ReviewStatus,
  ReviewItem,
} from "./types"
export { DEFAULT_STATUS } from "./types"

// Status Manager
export {
  parseStatusFromContent,
  setStatusInContent,
  getPageStatus,
  setPageStatus,
  stampCandidate,
} from "./status-manager"

// Review Persistence
export {
  loadReviewQueue,
  appendReviewItem,
  resolveReviewItem,
  dismissReviewItem,
  filterPendingItems,
} from "./review-persistence"
