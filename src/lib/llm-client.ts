import type { LlmConfig } from "@/stores/wiki-store"
import { getProviderConfig, type RequestOverrides } from "./llm-providers"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"

export type { ChatMessage, RequestOverrides } from "./llm-providers"
export { isFetchNetworkError } from "./tauri-fetch"

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

// Lazy import keeps the Tauri event/invoke bindings out of bundles that
// never touch the subprocess provider (e.g. vitest with a fetch mock).
async function streamViaClaudeCodeCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./claude-cli-transport")
  return mod.streamClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
}

const DECODER = new TextDecoder()

function parseLines(chunk: Uint8Array, buffer: string): [string[], string] {
  const text = buffer + DECODER.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

// ── Backend proxy detection ───────────────────────────────────────────────────

/**
 * Whether the server has LLM_ENDPOINT configured.
 * Cached after first call — the config doesn't change at runtime.
 */
let _serverHasLlm: boolean | null = null

async function serverHasLlm(): Promise<boolean> {
  if (_serverHasLlm !== null) return _serverHasLlm
  try {
    const res = await fetch("/api/config")
    if (!res.ok) { _serverHasLlm = false; return false }
    const cfg = await res.json()
    _serverHasLlm = !!(cfg?.llm?.endpoint)
    return _serverHasLlm
  } catch {
    _serverHasLlm = false
    return false
  }
}

// Standard OpenAI SSE line parser (used for the backend proxy stream,
// which always emits OpenAI-format SSE regardless of the upstream provider).
function parseOpenAiSseLine(line: string): string | null {
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  if (data === "[DONE]") return null
  try {
    const json = JSON.parse(data)
    return json?.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

// ── Main stream function ──────────────────────────────────────────────────────

export async function streamChat(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  /**
   * Wire-agnostic sampling knobs. The provider's buildBody() translates
   * these into its native schema — OpenAI-style wires accept them at
   * the top level ({temperature: 0.1}), Gemini nests them under
   * generationConfig with renamed keys ({generationConfig: {temperature: 0.1}}).
   * Previously we spread them onto the body here, which broke Gemini
   * with "Unknown name 'temperature': Cannot find field." HTTP 400.
   */
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  // Claude Code CLI uses a subprocess transport (stdin/stdout), not
  // HTTP. Dispatch before getProviderConfig — that function throws for
  // this provider because it has no URL/headers.
  if (config.provider === "claude-code") {
    return streamViaClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
  }

  if (config.apiKey === "__SERVER_MANAGED_VISION__") {
    return streamChatViaProxyEndpoint(
      "/api/llm/vision-stream",
      config,
      messages,
      callbacks,
      signal,
      requestOverrides,
      "vision",
    )
  }

  // ── Backend proxy mode ────────────────────────────────────────────────────
  // When the Rust backend has LLM_ENDPOINT configured, route through
  // /api/llm/stream. This avoids Mixed Content errors (HTTPS page → HTTP
  // LLM service) and CORS issues without requiring changes to the LLM service.
  const useProxy = await serverHasLlm()

  if (useProxy) {
    return streamChatViaProxy(config, messages, callbacks, signal, requestOverrides)
  }

  // ── Direct mode (dev / desktop) ───────────────────────────────────────────
  return streamChatDirect(config, messages, callbacks, signal, requestOverrides)
}

// ── Direct fetch (original implementation) ───────────────────────────────────

async function streamChatDirect(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks
  const providerConfig = getProviderConfig(config)

  const timeoutMs = 30 * 60 * 1000
  let combinedSignal = signal
  let timeoutController: AbortController | undefined
  let timeoutFired = false

  if (typeof AbortSignal.timeout === "function") {
    timeoutController = new AbortController()
    const timeoutId = setTimeout(() => {
      timeoutFired = true
      timeoutController?.abort()
    }, timeoutMs)

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId)
        timeoutController?.abort()
      })
    }
    combinedSignal = timeoutController.signal
  }

  let response: Response
  try {
    const body = providerConfig.buildBody(messages, requestOverrides)
    const httpFetch = await getHttpFetch()
    response = await httpFetch(providerConfig.url, {
      method: "POST",
      headers: providerConfig.headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (err) {
    if (signal?.aborted) { onDone(); return }
    if (err instanceof Error && err.name === "AbortError") {
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      onDone(); return
    }
    if (isFetchNetworkError(err)) {
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      onError(new Error(`Network error reaching ${providerConfig.url}. Check endpoint URL, API key, and connectivity.`))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = await response.text()
      if (body) errorDetail += ` — ${body}`
    } catch { /* ignore */ }
    onError(new Error(errorDetail))
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  await consumeStream(response.body, providerConfig.parseStream, callbacks, signal)
}

// ── Proxy fetch ───────────────────────────────────────────────────────────────

async function streamChatViaProxy(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
): Promise<void> {
  return streamChatViaProxyEndpoint(
    "/api/llm/stream",
    config,
    messages,
    callbacks,
    signal,
    requestOverrides,
    "LLM",
  )
}

async function streamChatViaProxyEndpoint(
  endpoint: string,
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
  label: string = "LLM",
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  const body: Record<string, unknown> = { messages }
  if (requestOverrides?.temperature !== undefined) body.temperature = requestOverrides.temperature
  if (requestOverrides?.max_tokens !== undefined) body.max_tokens = requestOverrides.max_tokens
  // Pass model name so the backend can respect it when allow_user_override=true
  if (config.model) body.model = config.model

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) { onDone(); return }
    if (isFetchNetworkError(err)) {
      onError(new Error(`Network error reaching the ${label} proxy. Check server logs.`))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = await response.text()
      if (body) errorDetail += ` — ${body}`
    } catch { /* ignore */ }
    onError(new Error(errorDetail))
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  // Proxy always streams OpenAI-format SSE regardless of upstream provider
  await consumeStream(response.body, parseOpenAiSseLine, callbacks, signal)
}

// ── Shared SSE consumer ───────────────────────────────────────────────────────

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  parseLine: (line: string) => string | null,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks
  const reader = body.getReader()
  let lineBuffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        if (lineBuffer.trim()) {
          const token = parseLine(lineBuffer.trim())
          if (token !== null) onToken(token)
        }
        break
      }

      const [lines, remaining] = parseLines(value, lineBuffer)
      lineBuffer = remaining

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const token = parseLine(trimmed)
        if (token !== null) onToken(token)
      }
    }

    onDone()
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || signal?.aborted)) {
      onDone(); return
    }
    if (isFetchNetworkError(err)) {
      onError(new Error("Connection lost during streaming. Try again."))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}
