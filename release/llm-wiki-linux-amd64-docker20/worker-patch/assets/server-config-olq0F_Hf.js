import { useWikiStore } from "./wiki-store-DMaxMIiL.js";
//#region src/lib/server-config.ts
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
/** In-memory cache so we don't re-fetch on every render. */
var _cached = null;
async function fetchServerConfig() {
	if (_cached) return _cached;
	try {
		const res = await fetch("/api/config", { cache: "no-store" });
		if (!res.ok) return null;
		_cached = await res.json();
		return _cached;
	} catch {
		return null;
	}
}
/**
* Load server config and merge into the wiki-store.
* Called once on app mount (before the user sees Settings).
*/
async function applyServerConfig() {
	const cfg = await fetchServerConfig();
	if (!cfg) return;
	const store = useWikiStore.getState();
	const { llm } = cfg;
	if (llm.endpoint || llm.model || llm.has_api_key) {
		const currentConfigs = store.providerConfigs ?? {};
		const customOverride = currentConfigs["custom"] ?? {};
		const patch = {};
		if (llm.endpoint && !customOverride.baseUrl) patch.baseUrl = llm.endpoint;
		if (llm.model && !customOverride.model) patch.model = llm.model;
		if (llm.api_mode && !customOverride.apiMode) patch.apiMode = llm.api_mode;
		if (llm.max_context_size && !customOverride.maxContextSize) patch.maxContextSize = llm.max_context_size;
		if (llm.has_api_key && !customOverride.apiKey) patch.apiKey = "__SERVER_MANAGED__";
		if (Object.keys(patch).length > 0) {
			store.setProviderConfigs({
				...currentConfigs,
				custom: {
					...customOverride,
					...patch
				}
			});
			if (!store.activePresetId) store.setActivePresetId("custom");
		}
		const currentLlm = store.llmConfig;
		if (!currentLlm.apiKey && llm.has_api_key) store.setLlmConfig({
			...currentLlm,
			provider: "custom",
			apiKey: "__SERVER_MANAGED__",
			model: llm.model ?? currentLlm.model,
			customEndpoint: llm.endpoint ?? currentLlm.customEndpoint,
			apiMode: llm.api_mode ?? currentLlm.apiMode ?? "chat_completions",
			maxContextSize: llm.max_context_size ?? currentLlm.maxContextSize
		});
	}
	const { embedding } = cfg;
	if (embedding.endpoint || embedding.model) {
		const embCfg = store.embeddingConfig ?? {};
		const embPatch = {};
		if (embedding.endpoint && (embedding.has_api_key || !embCfg.endpoint)) embPatch.endpoint = embedding.endpoint;
		if (embedding.model && (embedding.has_api_key || !embCfg.model)) embPatch.model = embedding.model;
		if (embedding.endpoint && embedding.model && embedding.has_api_key) embPatch.enabled = true;
		if (Object.keys(embPatch).length > 0) store.setEmbeddingConfig({
			...embCfg,
			...embPatch
		});
	}
	if (cfg.vision.endpoint || cfg.vision.model) {
		_visionConfig = {
			endpoint: cfg.vision.endpoint,
			model: cfg.vision.model,
			hasApiKey: cfg.vision.has_api_key
		};
		if (cfg.vision.has_api_key) {
			const mmCfg = store.multimodalConfig;
			if (!mmCfg.enabled || !mmCfg.apiKey || mmCfg.apiKey === "__SERVER_MANAGED_VISION__") store.setMultimodalConfig({
				...mmCfg,
				enabled: true,
				useMainLlm: false,
				provider: "custom",
				apiKey: "__SERVER_MANAGED_VISION__",
				model: cfg.vision.model ?? mmCfg.model,
				customEndpoint: cfg.vision.endpoint ?? mmCfg.customEndpoint,
				apiMode: "chat_completions"
			});
		}
	}
	if (cfg.pdf?.dpi) _pdfDpi = cfg.pdf.dpi;
	const search = cfg.search;
	if (search?.provider && search.provider !== "none" && search.has_api_key) {
		const currentSearch = store.searchApiConfig;
		if (currentSearch.provider === "none" || !currentSearch.apiKey) store.setSearchApiConfig({
			provider: search.provider,
			apiKey: "__SERVER_MANAGED__"
		});
	}
}
var _visionConfig = null;
var _pdfDpi = 150;
function getVisionConfig() {
	return _visionConfig;
}
function getPdfDpi() {
	return _pdfDpi;
}
/**
* Build an LlmConfig suitable for the pdf-ocr pipeline from the server's
* vision endpoint + the active LLM provider's api_key (since vision models
* typically share the same key as the main LLM in a private deployment).
*/
function buildVisionLlmConfig() {
	const store = useWikiStore.getState();
	const baseCfg = store.llmConfig;
	if (_visionConfig?.endpoint) return {
		...baseCfg,
		provider: "custom",
		apiKey: _visionConfig.hasApiKey ? "__SERVER_MANAGED_VISION__" : baseCfg.apiKey,
		customEndpoint: _visionConfig.endpoint,
		model: _visionConfig.model ?? baseCfg.model,
		apiMode: "chat_completions"
	};
	const mmCfg = store.multimodalConfig;
	if (mmCfg.useMainLlm) return mmCfg.enabled ? baseCfg : null;
	if (mmCfg.provider === "claude-code") return null;
	if (mmCfg.apiKey === "__SERVER_MANAGED_VISION__") return null;
	const model = mmCfg.model || (mmCfg.provider === "custom" ? "qwen-vl-ocr-latest" : "");
	if (!model) return null;
	const cfg = {
		...baseCfg,
		provider: mmCfg.provider,
		apiKey: mmCfg.apiKey,
		model,
		ollamaUrl: mmCfg.ollamaUrl || baseCfg.ollamaUrl,
		customEndpoint: mmCfg.customEndpoint,
		apiMode: mmCfg.provider === "custom" ? mmCfg.apiMode ?? "chat_completions" : void 0
	};
	if (mmCfg.provider === "custom") {
		cfg.customEndpoint = mmCfg.customEndpoint || "https://dashscope.aliyuncs.com/compatible-mode/v1";
		cfg.apiMode = mmCfg.apiMode ?? "chat_completions";
		if (!cfg.customEndpoint || !cfg.apiKey) return null;
	} else if (mmCfg.provider !== "ollama" && !cfg.apiKey) return null;
	return cfg;
}
//#endregion
export { applyServerConfig, buildVisionLlmConfig, fetchServerConfig, getPdfDpi, getVisionConfig };
