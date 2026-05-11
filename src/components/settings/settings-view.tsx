import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Binary,
  Globe,
  Languages,
  Palette,
  Info,
  Image as ImageIcon,
  Sliders,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { saveLanguage } from "@/lib/project-store"
import type { SettingsDraft, DraftSetter } from "./settings-types"
import { LlmProviderSection } from "./sections/llm-provider-section"
import { EmbeddingSection } from "./sections/embedding-section"
import { MultimodalSection } from "./sections/multimodal-section"
import { WebSearchSection } from "./sections/web-search-section"
import { OutputSection } from "./sections/output-section"
import { InterfaceSection } from "./sections/interface-section"
import { AboutSection } from "./sections/about-section"
import { ChunkingSection } from "./sections/chunking-section"
import type { ChunkingConfig } from "@/types/wiki"
import { DEFAULT_CHUNKING_CONFIG } from "@/types/wiki"

type CategoryId =
  | "llm"
  | "embedding"
  | "multimodal"
  | "web-search"
  | "knowledge"
  | "output"
  | "interface"
  | "about"

interface Category {
  id: CategoryId
  /** i18n key under settings.categories — resolved at render time so
   *  switching language in Settings → Interface takes effect without
   *  remounting this component (Bug #53). */
  labelKey: string
  icon: typeof Bot
}

const CATEGORIES: Category[] = [
  { id: "llm", labelKey: "settings.categories.llm", icon: Bot },
  { id: "embedding", labelKey: "settings.categories.embedding", icon: Binary },
  { id: "multimodal", labelKey: "settings.categories.multimodal", icon: ImageIcon },
  { id: "web-search", labelKey: "settings.categories.webSearch", icon: Globe },
  { id: "knowledge", labelKey: "settings.categories.knowledge", icon: Sliders },
  { id: "output", labelKey: "settings.categories.output", icon: Languages },
  { id: "interface", labelKey: "settings.categories.interface", icon: Palette },
  { id: "about", labelKey: "settings.categories.about", icon: Info },
]

function initialDraft(
  llm: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  search: ReturnType<typeof useWikiStore.getState>["searchApiConfig"],
  embed: ReturnType<typeof useWikiStore.getState>["embeddingConfig"],
  multimodal: ReturnType<typeof useWikiStore.getState>["multimodalConfig"],
  outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"],
  maxHistoryMessages: number,
  uiLanguage: string,
): SettingsDraft {
  return {
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    ollamaUrl: llm.ollamaUrl,
    customEndpoint: llm.customEndpoint,
    maxContextSize: llm.maxContextSize ?? 204800,
    apiMode: llm.apiMode,
    embeddingEnabled: embed.enabled,
    embeddingEndpoint: embed.endpoint,
    embeddingApiKey: embed.apiKey,
    embeddingModel: embed.model,
    embeddingMaxChunkChars: embed.maxChunkChars,
    embeddingOverlapChunkChars: embed.overlapChunkChars,
    multimodalEnabled: multimodal.enabled,
    multimodalUseMainLlm: multimodal.useMainLlm,
    multimodalProvider: multimodal.provider,
    multimodalApiKey: multimodal.apiKey,
    multimodalModel: multimodal.model,
    multimodalOllamaUrl: multimodal.ollamaUrl,
    multimodalCustomEndpoint: multimodal.customEndpoint,
    multimodalApiMode: multimodal.apiMode,
    multimodalConcurrency: multimodal.concurrency,
    searchProvider: search.provider,
    searchApiKey: search.apiKey,
    outputLanguage,
    maxHistoryMessages,
    uiLanguage,
  }
}

export function SettingsView() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const setMultimodalConfig = useWikiStore((s) => s.setMultimodalConfig)
  const outputLanguage = useWikiStore((s) => s.outputLanguage)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)

  // Chunking config — live, saved immediately on change to project.json
  const [chunkingConfig, setChunkingConfig] = useState<ChunkingConfig>(
    () => project?.chunking ?? DEFAULT_CHUNKING_CONFIG
  )
  useEffect(() => {
    setChunkingConfig(project?.chunking ?? DEFAULT_CHUNKING_CONFIG)
  }, [project?.id])

  async function handleChunkingChange(cfg: ChunkingConfig) {
    setChunkingConfig(cfg)
    if (!project) return
    const updated = { ...project, chunking: cfg }
    setProject(updated)
    // Persist to .llm-wiki/project.json
    try {
      const { writeFile } = await import("@/commands/fs")
      const cfgPath = `${project.path}/.llm-wiki/project.json`
      const { readFile } = await import("@/commands/fs")
      let raw: Record<string, unknown> = {}
      try { raw = JSON.parse(await readFile(cfgPath)) } catch { /* new file */ }
      await writeFile(cfgPath, JSON.stringify({ ...raw, chunking: cfg }, null, 2))
    } catch (e) {
      console.error("Failed to save chunking config:", e)
    }
  }

  // Drives the red dot next to the "About" row in the settings
  // sidebar. Uses `hasAvailableUpdate` (NOT `shouldShowUpdateBanner`)
  // so the indicator remains even after the user dismisses the
  // top banner — the user explicitly asked for the gear/About dots
  // to keep showing as a signpost so they can find the update
  // again later. The top banner stays gated by the dismiss
  // preference so the more aggressive interruption only fires once
  // per version.
  const updateAvailable = useUpdateStore((s) => hasAvailableUpdate(s))

  const [active, setActive] = useState<CategoryId>("llm")
  const [saved, setSaved] = useState(false)
  const [draft, setDraftState] = useState<SettingsDraft>(() =>
    initialDraft(
      llmConfig,
      searchApiConfig,
      embeddingConfig,
      multimodalConfig,
      outputLanguage,
      maxHistoryMessages,
      i18n.language,
    ),
  )

  // Resync draft from store if it changes out-of-band (e.g. project switch).
  useEffect(() => {
    setDraftState(
      initialDraft(
        llmConfig,
        searchApiConfig,
        embeddingConfig,
        multimodalConfig,
        outputLanguage,
        maxHistoryMessages,
        i18n.language,
      ),
    )
  }, [
    llmConfig,
    searchApiConfig,
    embeddingConfig,
    multimodalConfig,
    outputLanguage,
    maxHistoryMessages,
  ])

  const setDraft: DraftSetter = useCallback((key, value) => {
    setDraftState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSave = useCallback(async () => {
    const {
      saveLlmConfig,
      saveSearchApiConfig,
      saveEmbeddingConfig,
      saveMultimodalConfig,
      saveOutputLanguage,
    } = await import("@/lib/project-store")

    const newLlm = {
      provider: draft.provider,
      apiKey: draft.apiKey,
      model: draft.model,
      ollamaUrl: draft.ollamaUrl,
      customEndpoint: draft.customEndpoint,
      maxContextSize: draft.maxContextSize,
      apiMode: draft.provider === "custom" ? draft.apiMode : undefined,
    }
    const newSearch = { provider: draft.searchProvider, apiKey: draft.searchApiKey }
    const newEmbed = {
      enabled: draft.embeddingEnabled,
      endpoint: draft.embeddingEndpoint,
      apiKey: draft.embeddingApiKey,
      model: draft.embeddingModel,
      maxChunkChars: draft.embeddingMaxChunkChars,
      overlapChunkChars: draft.embeddingOverlapChunkChars,
    }
    const newMultimodal = {
      enabled: draft.multimodalEnabled,
      useMainLlm: draft.multimodalUseMainLlm,
      provider: draft.multimodalProvider,
      apiKey: draft.multimodalApiKey,
      model: draft.multimodalModel,
      ollamaUrl: draft.multimodalOllamaUrl,
      customEndpoint: draft.multimodalCustomEndpoint,
      apiMode: draft.multimodalProvider === "custom" ? draft.multimodalApiMode : undefined,
      // Clamp at save time so a hand-edited persisted store with a
      // ridiculous concurrency value (e.g. someone setting 1000 in
      // the JSON) doesn't blow up the captioning pipeline. Caption
      // calls already share the LLM endpoint with everything else;
      // going wider than ~16 just queues behind the server's batch
      // slot.
      concurrency: Math.max(1, Math.min(16, draft.multimodalConcurrency || 4)),
    }

    setLlmConfig(newLlm)
    await saveLlmConfig(newLlm)
    setSearchApiConfig(newSearch)
    await saveSearchApiConfig(newSearch)
    setEmbeddingConfig(newEmbed)
    await saveEmbeddingConfig(newEmbed)
    setMultimodalConfig(newMultimodal)
    await saveMultimodalConfig(newMultimodal)
    setOutputLanguage(draft.outputLanguage as typeof outputLanguage)
    await saveOutputLanguage(draft.outputLanguage as typeof outputLanguage)
    setMaxHistoryMessages(draft.maxHistoryMessages)

    if (draft.uiLanguage !== i18n.language) {
      await i18n.changeLanguage(draft.uiLanguage)
      await saveLanguage(draft.uiLanguage)
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [
    draft,
    setLlmConfig,
    setSearchApiConfig,
    setEmbeddingConfig,
    setOutputLanguage,
    setMaxHistoryMessages,
    outputLanguage,
  ])

  const body = useMemo(() => {
    switch (active) {
      case "llm":
        // The LLM section manages its own store state (per-provider
        // configs + active preset) and persists directly — it bypasses
        // the shared draft / global Save button.
        return <LlmProviderSection />
      case "embedding":
        return <EmbeddingSection draft={draft} setDraft={setDraft} />
      case "multimodal":
        return <MultimodalSection draft={draft} setDraft={setDraft} />
      case "web-search":
        return <WebSearchSection draft={draft} setDraft={setDraft} />
      case "knowledge":
        return (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold">知识切分配置</h2>
              <p className="text-sm text-muted-foreground mt-1">
                自定义 AI 在导入文件时切分和组织知识的方式，配置对该项目后续所有导入生效。
              </p>
            </div>
            {project ? (
              <ChunkingSection config={chunkingConfig} onChange={handleChunkingChange} />
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                请先打开一个项目，再配置知识切分选项。
              </p>
            )}
          </div>
        )
      case "output":
        return <OutputSection draft={draft} setDraft={setDraft} />
      case "interface":
        return <InterfaceSection draft={draft} setDraft={setDraft} />
      case "about":
        return <AboutSection />
    }
  }, [active, draft, setDraft, chunkingConfig, project])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar — category nav. Matches the IconSidebar's pill-on-accent
          pattern so the two navigational surfaces feel like one app. */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("settings.title")}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {CATEGORIES.map((c) => {
            const Icon = c.icon
            const isActive = c.id === active
            // Mirror the gear-icon dot inside the settings sidebar
            // so the user can find which sub-section the update
            // notification is pointing at. Update info lives in
            // the About panel, so the dot follows the About row.
            // Same store, same gating — once dismissed, both
            // disappear together.
            const showUpdateDot =
              c.id === "about" && updateAvailable
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActive(c.id)}
                aria-current={isActive ? "page" : undefined}
                className={`group mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-foreground/[0.08] font-medium text-foreground ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground/80 group-hover:text-accent-foreground"
                  }`}
                />
                <span className="truncate">{t(c.labelKey)}</span>
                {showUpdateDot && (
                  <span
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-label={t("nav.updateAvailable")}
                    title={t("nav.updateAvailable")}
                  />
                )}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-2xl">{body}</div>
        </div>

        {/* Global Save bar — hidden for sections that manage their own persistence */}
        {active !== "about" && active !== "llm" && active !== "knowledge" && (
          <div className="shrink-0 border-t bg-background/80 backdrop-blur px-8 py-3">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                {saved ? t("settings.savedTick") : t("settings.changeHint")}
              </p>
              <Button onClick={handleSave}>
                {saved ? t("settings.saved") : t("settings.save")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
