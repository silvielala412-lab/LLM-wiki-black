/**
 * project-store.ts — Web version
 *
 * Replaces @tauri-apps/plugin-store with localStorage.
 * API is identical to the Tauri version so no callers need to change.
 */

import type { WikiProject } from "@/types/wiki"
import type {
  LlmConfig,
  SearchApiConfig,
  EmbeddingConfig,
  MultimodalConfig,
  OutputLanguage,
  ProviderConfigs,
} from "@/stores/wiki-store"
import { BAILIAN_OCR_MODEL, BAILIAN_VISION_ENDPOINT } from "@/lib/bailian-vision"

// ── Generic localStorage helpers ──────────────────────────────────────────────

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    console.warn("[project-store] localStorage write failed:", e)
  }
}

function lsDel(key: string): void {
  localStorage.removeItem(key)
}

// ── Keys ──────────────────────────────────────────────────────────────────────

const RECENT_PROJECTS_KEY     = "llm-wiki:recentProjects"
const LAST_PROJECT_KEY        = "llm-wiki:lastProject"
const LLM_CONFIG_KEY          = "llm-wiki:llmConfig"
const PROVIDER_CONFIGS_KEY    = "llm-wiki:providerConfigs"
const ACTIVE_PRESET_KEY       = "llm-wiki:activePresetId"
const SEARCH_API_KEY          = "llm-wiki:searchApiConfig"
const EMBEDDING_KEY           = "llm-wiki:embeddingConfig"
const MULTIMODAL_KEY          = "llm-wiki:multimodalConfig"
const LANGUAGE_KEY            = "llm-wiki:language"
const OUTPUT_LANGUAGE_KEY     = "llm-wiki:outputLanguage"
const UPDATE_CHECK_STATE_KEY  = "llm-wiki:updateCheckState"

// ── Recent projects ───────────────────────────────────────────────────────────

export async function getRecentProjects(): Promise<WikiProject[]> {
  return lsGet<WikiProject[]>(RECENT_PROJECTS_KEY) ?? []
}

export async function getLastProject(): Promise<WikiProject | null> {
  return lsGet<WikiProject>(LAST_PROJECT_KEY)
}

export async function saveLastProject(project: WikiProject): Promise<void> {
  lsSet(LAST_PROJECT_KEY, project)
  await addToRecentProjects(project)
}

export async function addToRecentProjects(project: WikiProject): Promise<void> {
  const existing = lsGet<WikiProject[]>(RECENT_PROJECTS_KEY) ?? []
  const filtered = existing.filter((p) => p.path !== project.path)
  lsSet(RECENT_PROJECTS_KEY, [project, ...filtered].slice(0, 10))
}

export async function removeFromRecentProjects(path: string): Promise<void> {
  const existing = lsGet<WikiProject[]>(RECENT_PROJECTS_KEY) ?? []
  lsSet(RECENT_PROJECTS_KEY, existing.filter((p) => p.path !== path))
  const last = lsGet<WikiProject>(LAST_PROJECT_KEY)
  if (last && last.path === path) lsDel(LAST_PROJECT_KEY)
}

// ── LLM config ────────────────────────────────────────────────────────────────

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  lsSet(LLM_CONFIG_KEY, config)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  const config = lsGet<LlmConfig>(LLM_CONFIG_KEY)
  if (config && config.model === "deepseek-chat") {
    config.model = "deepseek-v4-pro"
    lsSet(LLM_CONFIG_KEY, config)
  }
  return config
}

export async function saveProviderConfigs(configs: ProviderConfigs): Promise<void> {
  lsSet(PROVIDER_CONFIGS_KEY, configs)
}

export async function loadProviderConfigs(): Promise<ProviderConfigs | null> {
  const configs = lsGet<ProviderConfigs>(PROVIDER_CONFIGS_KEY)
  if (configs?.["deepseek"]?.model === "deepseek-chat") {
    configs["deepseek"].model = "deepseek-v4-pro"
    lsSet(PROVIDER_CONFIGS_KEY, configs)
  }
  return configs
}

export async function saveActivePresetId(id: string | null): Promise<void> {
  lsSet(ACTIVE_PRESET_KEY, id)
}

export async function loadActivePresetId(): Promise<string | null> {
  return lsGet<string>(ACTIVE_PRESET_KEY)
}

// ── Search / Embedding / Multimodal ───────────────────────────────────────────

export async function saveSearchApiConfig(config: SearchApiConfig): Promise<void> {
  lsSet(SEARCH_API_KEY, config)
}

export async function loadSearchApiConfig(): Promise<SearchApiConfig | null> {
  return lsGet<SearchApiConfig>(SEARCH_API_KEY)
}

export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  lsSet(EMBEDDING_KEY, config)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  return lsGet<EmbeddingConfig>(EMBEDDING_KEY)
}

export async function saveMultimodalConfig(config: MultimodalConfig): Promise<void> {
  lsSet(MULTIMODAL_KEY, config)
}

function normalizeMultimodalConfig(config: MultimodalConfig): MultimodalConfig {
  if (config.provider !== "custom") return config

  const oldEmptyDefault =
    config.useMainLlm &&
    !config.model &&
    !config.customEndpoint

  if (!oldEmptyDefault && config.model && config.customEndpoint) return config

  return {
    ...config,
    useMainLlm: oldEmptyDefault ? false : config.useMainLlm,
    model: config.model || BAILIAN_OCR_MODEL,
    customEndpoint: config.customEndpoint || BAILIAN_VISION_ENDPOINT,
    apiMode: config.apiMode ?? "chat_completions",
  }
}

export async function loadMultimodalConfig(): Promise<MultimodalConfig | null> {
  const config = lsGet<MultimodalConfig>(MULTIMODAL_KEY)
  if (!config) return null

  const normalized = normalizeMultimodalConfig(config)
  if (JSON.stringify(normalized) !== JSON.stringify(config)) {
    lsSet(MULTIMODAL_KEY, normalized)
  }
  return normalized
}

// ── Language ──────────────────────────────────────────────────────────────────

export async function saveLanguage(lang: string): Promise<void> {
  lsSet(LANGUAGE_KEY, lang)
}

export async function loadLanguage(): Promise<string | null> {
  return lsGet<string>(LANGUAGE_KEY)
}

export async function saveOutputLanguage(lang: OutputLanguage): Promise<void> {
  lsSet(OUTPUT_LANGUAGE_KEY, lang)
}

export async function loadOutputLanguage(): Promise<OutputLanguage | null> {
  return lsGet<OutputLanguage>(OUTPUT_LANGUAGE_KEY)
}

// ── Update check ──────────────────────────────────────────────────────────────

export interface PersistedUpdateCheckState {
  enabled: boolean
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

export async function saveUpdateCheckState(state: PersistedUpdateCheckState): Promise<void> {
  lsSet(UPDATE_CHECK_STATE_KEY, state)
}

export async function loadUpdateCheckState(): Promise<PersistedUpdateCheckState | null> {
  return lsGet<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY)
}
