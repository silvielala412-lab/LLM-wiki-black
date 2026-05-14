/**
 * knowledge-governance/policy-engine.ts
 *
 * Minimal Phase-2 Policy Engine.
 * Decides what to do with a new page given a JudgementResult:
 *   auto_accept  — High confidence unrelated/complement → no user action
 *   notify       — High confidence same/update → show toast (no Review item)
 *   review       — Conflicts, uncertain, low confidence → Review Queue
 *
 * Phase-3 will make this configurable per domain/source.
 */

import type { JudgementResult, PolicyDecision } from "./types"

interface PolicyContext {
  /** Similarity score 0-1 from the conflict detector */
  similarityScore: number
  /** Source type of the ingested page */
  ingestMethod?: "file-upload" | "deep-research" | "manual" | "chat"
}

/**
 * Evaluate the policy for a given judgement result and context.
 * Always-conservative: when in doubt, routes to Review.
 */
export function evaluatePolicy(
  judgement: JudgementResult | null,
  context: PolicyContext,
): PolicyDecision {
  // No judgement (LLM not configured, or call failed) → always review
  if (!judgement) return "review"

  const { relation, confidence } = judgement
  const { similarityScore } = context

  // High similarity + definitive "unrelated" from LLM → likely a false positive from
  // the vector index; surface it as a notify rather than auto-accept, since the
  // similarity score itself may warrant a human glance.
  if (relation === "unrelated") {
    return similarityScore >= 0.90 ? "notify" : "auto_accept"
  }

  // Complement with high confidence → notify (useful info, but no conflict)
  if (relation === "complement" && confidence === "high") {
    return "notify"
  }

  // Exact duplicate with high confidence → notify (system will mark new as redundant)
  if (relation === "same" && confidence === "high") {
    return "notify"
  }

  // All conflict relations → always require human review
  if (relation === "conflict") return "review"

  // Updates with medium/high confidence → notify so user knows the old page may
  // be outdated; they can go supersede it from the Review panel.
  if (relation === "update" && (confidence === "high" || confidence === "medium")) {
    return "notify"
  }

  // Everything else (uncertain, low confidence, update+low) → review
  return "review"
}

/**
 * Build a lightweight description for the Review Queue item based on
 * the policy decision and judgement.
 */
export function buildPolicyDescription(
  judgement: JudgementResult | null,
  decision: PolicyDecision,
  newTitle: string,
  existingTitle: string,
): string {
  if (!judgement) {
    return `「${newTitle}」与「${existingTitle}」存在相似内容，无法自动判断关系，请人工确认。`
  }

  const RELATION_ZH: Record<string, string> = {
    same:        "重复内容",
    update:      "内容更新",
    conflict:    "内容冲突",
    complement:  "补充信息",
    unrelated:   "无关联",
    uncertain:   "关系待定",
  }
  const CONFIDENCE_ZH: Record<string, string> = {
    high: "高置信",
    medium: "中置信",
    low: "低置信",
  }

  const relLabel = RELATION_ZH[judgement.relation] ?? judgement.relation
  const confLabel = CONFIDENCE_ZH[judgement.confidence] ?? judgement.confidence

  if (decision === "auto_accept") {
    return `AI 判断「${newTitle}」与「${existingTitle}」${relLabel}（${confLabel}），已自动确认。`
  }
  if (decision === "notify") {
    return `AI 判断「${newTitle}」与「${existingTitle}」存在${relLabel}（${confLabel}）。`
  }
  return `AI 判断「${newTitle}」与「${existingTitle}」可能${relLabel}（${confLabel}），请确认处理方式。`
}
