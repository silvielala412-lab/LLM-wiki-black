/**
 * knowledge-governance/diff-engine.ts
 *
 * LLM-powered semantic diff between two wiki pages.
 * Extracts structured change points: added, removed, changed knowledge.
 *
 * Stateless — no file IO. Called by orchestrator or review panel
 * when the user confirms a supersession.
 */

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildDiffPrompt(
  oldTitle: string,
  oldContent: string,
  newTitle: string,
  newContent: string,
): string {
  return `你是一个知识库变更分析助手。请比较以下两个版本的知识文档，提取关键变更点。

## 旧版本：${oldTitle}
${oldContent.slice(0, 1500)}

## 新版本：${newTitle}
${newContent.slice(0, 1500)}

请分析并以 JSON 格式输出，包含以下字段（每项限 15 字以内的简洁要点，最多 5 条）：
- added_points: 新版本新增的知识要点（旧版本没有的）
- removed_points: 旧版本有但新版本删除的知识要点
- changed_points: 两个版本都有但内容发生变化的要点
- summary: 一句话概括本次变更的主要内容（30字以内）

只输出 JSON，不要 markdown 代码块：
{"added_points":[],"removed_points":[],"changed_points":[],"summary":""}`.trim()
}

// ── Response parser ───────────────────────────────────────────────────────────

interface RawDiffResponse {
  added_points?: unknown
  removed_points?: unknown
  changed_points?: unknown
  summary?: unknown
}

function toStringArray(val: unknown, max = 5): string[] {
  if (!Array.isArray(val)) return []
  return val.slice(0, max).map((v) => String(v).trim()).filter(Boolean)
}

function parseDiffResponse(raw: string): {
  addedPoints: string[]
  removedPoints: string[]
  changedPoints: string[]
  summary: string
} | null {
  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    const parsed = JSON.parse(clean) as RawDiffResponse
    return {
      addedPoints:   toStringArray(parsed.added_points),
      removedPoints: toStringArray(parsed.removed_points),
      changedPoints: toStringArray(parsed.changed_points),
      summary:       String(parsed.summary ?? "").slice(0, 80),
    }
  } catch {
    // Try to find embedded JSON
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as RawDiffResponse
        return {
          addedPoints:   toStringArray(parsed.added_points),
          removedPoints: toStringArray(parsed.removed_points),
          changedPoints: toStringArray(parsed.changed_points),
          summary:       String(parsed.summary ?? "").slice(0, 80),
        }
      } catch { /* ignore */ }
    }
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SemanticDiff {
  addedPoints: string[]
  removedPoints: string[]
  changedPoints: string[]
  summary: string
}

/**
 * Generate a semantic diff between old and new page content using the LLM.
 *
 * @param llmConfig  LLM config from wiki-store
 * @param oldTitle   Title of old page
 * @param oldContent Full markdown of old page
 * @param newTitle   Title of new page
 * @param newContent Full markdown of new page
 */
export async function generateSemanticDiff(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llmConfig: any,
  oldTitle: string,
  oldContent: string,
  newTitle: string,
  newContent: string,
): Promise<SemanticDiff | null> {
  if (!llmConfig?.endpoint || !llmConfig?.model) {
    console.warn("[diff-engine] LLM not configured")
    return null
  }

  const prompt = buildDiffPrompt(oldTitle, oldContent, newTitle, newContent)
  let responseText: string | null = null

  // Try backend proxy first
  try {
    const proxyRes = await fetch("/api/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 512,
        stream: false,
      }),
    })
    if (proxyRes.ok) {
      const data = await proxyRes.json()
      responseText = data?.choices?.[0]?.message?.content ?? null
    }
  } catch { /* fall through */ }

  // Direct call fallback
  if (!responseText && llmConfig.endpoint) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (llmConfig.apiKey) headers.Authorization = `Bearer ${llmConfig.apiKey}`
      const { getHttpFetch } = await import("@/lib/tauri-fetch")
      const httpFetch = await getHttpFetch()
      const res = await httpFetch(llmConfig.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: llmConfig.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 512,
          stream: false,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        responseText = data?.choices?.[0]?.message?.content ?? null
      }
    } catch (err) {
      console.warn("[diff-engine] Direct LLM call failed:", err)
    }
  }

  if (!responseText) return null
  return parseDiffResponse(responseText)
}
