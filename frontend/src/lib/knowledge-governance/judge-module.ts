/**
 * knowledge-governance/judge-module.ts
 *
 * LLM-based judgement of the relationship between a new page and an
 * existing one. Outputs a JudgementResult with relation, confidence,
 * and a human-readable reason shown in the Review UI.
 *
 * This module is STATELESS — it never reads or writes files.
 * It only calls the LLM and returns a structured result.
 */

import type { JudgementResult, JudgeRelation, JudgeConfidence } from "./types"
import { callLLM, hasUsableLlmConfig } from "./llm-helper"

// ── Prompt construction ───────────────────────────────────────────────────────

function buildJudgePrompt(
  newTitle: string,
  newExcerpt: string,
  existingTitle: string,
  existingExcerpt: string,
): string {
  return `You are a knowledge governance assistant. Your task is to compare two wiki pages and classify their relationship.

## New Page
Title: ${newTitle}
Content preview:
${newExcerpt.slice(0, 600)}

## Existing Page
Title: ${existingTitle}
Content preview:
${existingExcerpt.slice(0, 600)}

## Task
Classify the relationship of the NEW page relative to the EXISTING page.

Choose exactly one relation:
- "same"       — The new page is a duplicate or near-duplicate of the existing page. They cover the same concept with no meaningful new information.
- "update"     — The new page updates, refines, or extends the existing page with more recent or more accurate information.
- "conflict"   — The new page contains information that directly contradicts the existing page.
- "complement" — The new page covers the same general topic but adds genuinely different detail that does not conflict.
- "unrelated"  — The pages are about different topics. The similarity was coincidental.
- "uncertain"  — You cannot determine the relationship with confidence.

Also provide:
- confidence: "high" | "medium" | "low"
- reason: a concise 1-2 sentence explanation in Chinese for the wiki editor

Respond ONLY with valid JSON, no markdown fences:
{"relation":"...","confidence":"...","reason":"..."}`.trim()
}

// ── LLM call (non-streaming) ──────────────────────────────────────────────────

interface RawJudgeResponse {
  relation?: string
  confidence?: string
  reason?: string
}

const VALID_RELATIONS = new Set<JudgeRelation>([
  "same", "update", "conflict", "complement", "unrelated", "uncertain",
])
const VALID_CONFIDENCES = new Set<JudgeConfidence>(["high", "medium", "low"])

function parseJudgeResponse(raw: string): RawJudgeResponse | null {
  try {
    // Strip markdown fences if LLM adds them
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    return JSON.parse(clean) as RawJudgeResponse
  } catch {
    // Try to find JSON object in the response
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) as RawJudgeResponse } catch { /* ignore */ }
    }
    return null
  }
}

/**
 * Ask the LLM to judge the relationship between two pages.
 *
 * @param llmConfig   LLM config from wiki-store (endpoint, model, apiKey)
 * @param newTitle    Title of the newly ingested page
 * @param newExcerpt  Content preview of the new page
 * @param existingTitle   Title of the existing page
 * @param existingExcerpt Content preview of the existing page
 * @returns JudgementResult, or null if the LLM call fails
 */
export async function judgeRelationship(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llmConfig: any,
  newTitle: string,
  newExcerpt: string,
  existingTitle: string,
  existingExcerpt: string,
): Promise<JudgementResult | null> {
  if (!hasUsableLlmConfig(llmConfig)) {
    console.warn("[judge-module] LLM not configured — skipping judgement")
    return null
  }

  const prompt = buildJudgePrompt(newTitle, newExcerpt, existingTitle, existingExcerpt)
  const responseText = await callLLM(
    llmConfig,
    [{ role: "user", content: prompt }],
    256,
  )

  if (!responseText) {
    console.warn("[judge-module] LLM returned empty response")
    return null
  }

  const parsed = parseJudgeResponse(responseText)
  if (!parsed) {
    console.warn("[judge-module] Could not parse LLM response:", responseText.slice(0, 200))
    return null
  }

  const relation = VALID_RELATIONS.has(parsed.relation as JudgeRelation)
    ? (parsed.relation as JudgeRelation)
    : "uncertain"
  const confidence = VALID_CONFIDENCES.has(parsed.confidence as JudgeConfidence)
    ? (parsed.confidence as JudgeConfidence)
    : "low"

  return {
    relation,
    confidence,
    reason: parsed.reason ?? "无法获取分析理由。",
    judgedAt: new Date().toISOString(),
  }
}
