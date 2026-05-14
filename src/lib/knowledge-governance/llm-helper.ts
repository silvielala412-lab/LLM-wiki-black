/**
 * knowledge-governance/llm-helper.ts
 *
 * Shared LLM call helper for governance modules.
 * The backend only exposes /api/llm/stream (SSE), so we consume
 * the stream and collect all chunks into a single string.
 *
 * Falls back to a direct non-streaming call when running in dev mode
 * (where the Vite proxy forwards to the backend directly).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LlmConfig = any

/**
 * Call the LLM via the backend SSE proxy and return the full
 * accumulated response text. Non-blocking — the caller decides
 * how to parse the result.
 *
 * @param messages  OpenAI-format message array
 * @param maxTokens Max tokens for the completion
 */
async function callViaStreamProxy(
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<string | null> {
  try {
    const res = await fetch("/api/llm/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    })

    if (!res.ok || !res.body) {
      console.warn(`[llm-helper] Stream proxy returned HTTP ${res.status}`)
      return null
    }

    // Read the SSE stream and accumulate content
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let accumulated = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      // SSE lines look like: data: {"choices":[{"delta":{"content":"..."}}]}
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.slice(5).trim()
        if (data === "[DONE]") continue
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.delta?.content ?? ""
          accumulated += content
        } catch { /* skip malformed SSE lines */ }
      }
    }

    return accumulated.trim() || null
  } catch (err) {
    console.warn("[llm-helper] Stream proxy failed:", err)
    return null
  }
}

/**
 * Call the LLM directly (non-streaming) — used in dev mode where
 * the LLM endpoint is accessible from the browser.
 */
async function callViaDirect(
  llmConfig: LlmConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<string | null> {
  if (!llmConfig?.endpoint) return null
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
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
        stream: false,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.choices?.[0]?.message?.content ?? null
  } catch (err) {
    console.warn("[llm-helper] Direct call failed:", err)
    return null
  }
}

/**
 * Main entry point: call the LLM and return the full response text.
 * Tries the backend stream proxy first, falls back to direct.
 */
export async function callLLM(
  llmConfig: LlmConfig,
  messages: { role: string; content: string }[],
  maxTokens = 512,
): Promise<string | null> {
  // Try backend proxy (works in production where /api is available)
  const proxyResult = await callViaStreamProxy(messages, maxTokens)
  if (proxyResult) return proxyResult

  // Fallback: direct call (dev mode / desktop)
  return callViaDirect(llmConfig, messages, maxTokens)
}
