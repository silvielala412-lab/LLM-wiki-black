/**
 * knowledge-governance/llm-helper.ts
 *
 * Thin wrapper around the app's existing `streamChat` client.
 * Accumulates the stream into a single string and returns it.
 *
 * This reuses the full provider-aware routing logic:
 *   - If backend has LLM_ENDPOINT configured → routes through /api/llm/stream
 *   - Otherwise → direct call using getProviderConfig (handles DeepSeek,
 *     OpenAI, Ollama, custom, etc.) with the correct URL + auth headers
 *
 * Previous version tried to re-implement this from scratch and failed
 * because it used llmConfig.endpoint which doesn't exist (it's
 * customEndpoint / ollamaUrl / provider-specific).
 */

import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Call the LLM and return the full accumulated response text.
 * Returns null if the call fails or produces empty output.
 *
 * @param llmConfig  LlmConfig from wiki-store (provider, apiKey, model, etc.)
 * @param messages   OpenAI-format message array
 * @param maxTokens  Max tokens for the response
 */
export async function callLLM(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llmConfig: any,
  messages: { role: string; content: string }[],
  maxTokens = 512,
): Promise<string | null> {
  if (!llmConfig) {
    console.warn("[llm-helper] No LLM config provided")
    return null
  }

  return new Promise<string | null>((resolve) => {
    let accumulated = ""

    streamChat(
      llmConfig as LlmConfig,
      // streamChat expects { role, content } which is the same shape
      messages as Parameters<typeof streamChat>[1],
      {
        onToken: (token) => { accumulated += token },
        onDone:  () => resolve(accumulated.trim() || null),
        onError: (err) => {
          console.warn("[llm-helper] LLM call error:", err.message)
          resolve(null)
        },
      },
      undefined, // no AbortSignal
      { temperature: 0.1, maxTokens },
    )
  })
}
