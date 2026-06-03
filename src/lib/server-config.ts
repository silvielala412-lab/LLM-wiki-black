/**
 * server-config.ts
 *
 * Fetches the server-side LLM / embedding / vision configuration from
 * GET /api/config and merges it into the wiki-store as default values.
 *
 * Design:
 * - Server-supplied values are applied as "defaults" — users can still
 *   override them in Settings (when allow_user_override is true).
 * - The api_key is NEVER sent by the server; only `has_api_key: true`
 *   is returned so we can show "🔑 Configured by admin" in the UI.
 * - Vision config is stored separately for use by the PDF-OCR pipeline.
 */

import { useWikiStore } from "@/stores/wiki-store"

interface ServerLlmConfig {
  provider?: string
  has_api_key?: boolean
  model?: string
  endpoint?: string
  api_mode?: string
  max_context_size?: number
}

interface ServerEmbeddingConfig {
  endpoint?: string
  model?: string
  has_api_key?: boolean
}

interface ServerVisionConfig {
  endpoint?: string
  model?: string
  has_api_key?: boolean
}

interface ServerPdfConfig {
  dpi?: number
}

interface ServerSearchConfig {
  provider?: "tavily" | "perplexity" | "none"
  has_api_key?: boolean
}

export interface ServerConfig {
  llm: ServerLlmConfig
  embedding: ServerEmbeddingConfig
  vision: ServerVisionConfig
  pdf: ServerPdfConfig
  search?: ServerSearchConfig
  allow_user_override: boolean
}

/** In-memory cache so we don't re-fetch on every render. */
let _cached: ServerConfig | null = null

export async function fetchServerConfig(): Promise<ServerConfig | null> {
  if (_cached) return _cached
  try {
    const res = await fetch("/api/config", { cache: "no-store" })
    if (!res.ok) return null
    _cached = (await res.json()) as ServerConfig
    return _cached
  } catch {
    // Server not available or endpoint not yet deployed — fail silently.
    return null
  }
}

/**
 * Load server config and merge into the wiki-store.
 * Called once on app mount (before the user sees Settings).
 */
export async function applyServerConfig(): Promise<void> {
  const cfg = await fetchServerConfig()
  if (!cfg) return

  const store = useWikiStore.getState()

  // ── Apply LLM defaults ──────────────────────────────────────────────
  const { llm } = cfg
  if (llm.endpoint || llm.model || llm.has_api_key) {
    // Find or create the "custom" preset override
    const currentConfigs = store.providerConfigs ?? {}
    const customOverride = currentConfigs["custom"] ?? {}

    const patch: Record<string, unknown> = {}
    if (llm.endpoint && !customOverride.baseUrl) patch.baseUrl = llm.endpoint
    if (llm.model && !customOverride.model)    patch.model = llm.model
    if (llm.api_mode && !customOverride.apiMode) patch.apiMode = llm.api_mode
    if (llm.max_context_size && !customOverride.maxContextSize)
      patch.maxContextSize = llm.max_context_size
    // Sentinel so the UI can show "🔑 Configured by admin" instead of blank
    if (llm.has_api_key && !customOverride.apiKey)
      patch.apiKey = "__SERVER_MANAGED__"

    if (Object.keys(patch).length > 0) {
      store.setProviderConfigs({
        ...currentConfigs,
        custom: { ...customOverride, ...patch },
      })
      // Auto-activate the custom preset if no preset is active yet
      if (!store.activePresetId) {
        store.setActivePresetId("custom")
      }
    }

    const currentLlm = store.llmConfig
    if (!currentLlm.apiKey && llm.has_api_key) {
      store.setLlmConfig({
        ...currentLlm,
        provider: "custom",
        apiKey: "__SERVER_MANAGED__",
        model: llm.model ?? currentLlm.model,
        customEndpoint: llm.endpoint ?? currentLlm.customEndpoint,
        apiMode: (llm.api_mode as "chat_completions" | "anthropic_messages" | undefined) ?? currentLlm.apiMode ?? "chat_completions",
        maxContextSize: llm.max_context_size ?? currentLlm.maxContextSize,
      })
    }
  }

  // ── Apply embedding defaults ────────────────────────────────────────
  const { embedding } = cfg
  if (embedding.endpoint || embedding.model) {
    const embCfg = store.embeddingConfig ?? {}
    const embPatch: Record<string, unknown> = {}
    if (embedding.endpoint && (embedding.has_api_key || !embCfg.endpoint)) embPatch.endpoint = embedding.endpoint
    if (embedding.model && (embedding.has_api_key || !embCfg.model))       embPatch.model = embedding.model
    if (embedding.endpoint && embedding.model && embedding.has_api_key) embPatch.enabled = true
    if (Object.keys(embPatch).length > 0) {
      store.setEmbeddingConfig({ ...embCfg, ...embPatch })
    }
  }

  // ── Store vision config for PDF-OCR pipeline ────────────────────────
  // Vision config is not directly in the store, so we keep it in a
  // module-level variable that pdf-ocr.ts reads via getVisionConfig().
  if (cfg.vision.endpoint || cfg.vision.model) {
    _visionConfig = {
      endpoint: cfg.vision.endpoint,
      model: cfg.vision.model,
      hasApiKey: cfg.vision.has_api_key,
    }

    if (cfg.vision.has_api_key) {
      const mmCfg = store.multimodalConfig
      if (!mmCfg.enabled || !mmCfg.apiKey) {
        store.setMultimodalConfig({
          ...mmCfg,
          enabled: true,
          useMainLlm: false,
          provider: "custom",
          apiKey: "__SERVER_MANAGED_VISION__",
          model: cfg.vision.model ?? mmCfg.model,
          customEndpoint: cfg.vision.endpoint ?? mmCfg.customEndpoint,
          apiMode: "chat_completions",
        })
      }
    }
  }

  // ── Apply PDF DPI ────────────────────────────────────────────────────
  if (cfg.pdf?.dpi) {
    _pdfDpi = cfg.pdf.dpi
  }

  const search = cfg.search
  if (search?.provider && search.provider !== "none" && search.has_api_key) {
    const currentSearch = store.searchApiConfig
    if (currentSearch.provider === "none" || !currentSearch.apiKey) {
      store.setSearchApiConfig({
        provider: search.provider,
        apiKey: "__SERVER_MANAGED__",
      })
    }
  }
}

// ── Vision config accessor (used by ingest.ts / pdf-ocr.ts) ─────────────────

interface VisionEndpoint {
  endpoint?: string
  model?: string
  hasApiKey?: boolean
}

let _visionConfig: VisionEndpoint | null = null
let _pdfDpi = 150

export function getVisionConfig(): VisionEndpoint | null {
  return _visionConfig
}

export function getPdfDpi(): number {
  return _pdfDpi
}

/**
 * Build an LlmConfig suitable for the pdf-ocr pipeline from the server's
 * vision endpoint + the active LLM provider's api_key (since vision models
 * typically share the same key as the main LLM in a private deployment).
 */
export function buildVisionLlmConfig() {
  const store = useWikiStore.getState()
  const baseCfg = store.llmConfig
  if (!_visionConfig?.endpoint) return null
  return {
    ...baseCfg,
    provider: "custom" as const,
    apiKey: _visionConfig.hasApiKey ? "__SERVER_MANAGED_VISION__" : baseCfg.apiKey,
    customEndpoint: _visionConfig.endpoint,
    model: _visionConfig.model ?? baseCfg.model,
    apiMode: "chat_completions" as const,
  }
}
