/**
 * knowledge-governance/index.ts
 *
 * Public API for the knowledge governance system.
 * External modules ONLY import from here — never from internal files.
 *
 * Internal module boundaries:
 *   types.ts              ← shared types
 *   status-manager.ts     ← frontmatter status R/W
 *   review-persistence.ts ← review-queue.json R/W
 *   conflict-detector.ts  ← find similar pages (vector + title fallback)   [Phase 2]
 *   judge-module.ts       ← LLM judgement of relationship                  [Phase 2]
 *   policy-engine.ts      ← auto_accept / notify / review decision          [Phase 2]
 *   orchestrator.ts       ← pipeline: detect → judge → policy → persist    [Phase 2]
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

// ── Phase 1: Status + Review Queue ───────────────────────────────────────────

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

// ── Phase 2: Conflict Detection + LLM Judge + Policy ─────────────────────────

// Conflict Detector
export type { ConflictCandidate } from "./conflict-detector"
export { detectConflicts, findSimilarByVector, findSimilarByTitle } from "./conflict-detector"

// Judge Module
export { judgeRelationship } from "./judge-module"

// Policy Engine
export { evaluatePolicy, buildPolicyDescription } from "./policy-engine"

// Orchestrator (main Phase 2 entry point)
export { runGovernancePipeline } from "./orchestrator"

// ── Phase 3: Knowledge Evolution + Lineage ────────────────────────────────────

// Lineage Tracker
export type { KnowledgeTransition } from "./lineage-tracker"
export {
  loadLineage,
  appendTransition,
  recordTransition,
  getSupersededBy,
  getSupersedes,
  buildVersionChain,
} from "./lineage-tracker"

// Diff Engine
export type { SemanticDiff } from "./diff-engine"
export { generateSemanticDiff } from "./diff-engine"

