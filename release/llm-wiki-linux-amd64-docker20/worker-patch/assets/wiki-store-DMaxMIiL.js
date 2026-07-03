import { t as create } from "./react-yWv6PLLo.js";
//#region src/lib/bailian-vision.ts
var BAILIAN_VISION_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
var BAILIAN_OCR_MODEL = "qwen-vl-ocr-latest";
//#endregion
//#region src/stores/wiki-store.ts
var useWikiStore = create((set) => ({
	project: null,
	fileTree: [],
	selectedFile: null,
	fileContent: "",
	pendingScrollImageSrc: null,
	chatExpanded: false,
	activeView: "wiki",
	llmConfig: {
		provider: "openai",
		apiKey: "",
		maxContextSize: 204800,
		model: "",
		ollamaUrl: "http://localhost:11434",
		customEndpoint: ""
	},
	providerConfigs: {},
	activePresetId: null,
	dataVersion: 0,
	setProject: (project) => set({ project }),
	setFileTree: (fileTree) => set({ fileTree }),
	setSelectedFile: (selectedFile) => set({ selectedFile }),
	setFileContent: (fileContent) => set({ fileContent }),
	setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),
	setChatExpanded: (chatExpanded) => set({ chatExpanded }),
	setActiveView: (activeView) => set({ activeView }),
	searchApiConfig: {
		provider: "none",
		apiKey: ""
	},
	embeddingConfig: {
		enabled: false,
		endpoint: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
		apiKey: "",
		model: "tongyi-embedding-vision-plus-2026-03-06"
	},
	multimodalConfig: {
		enabled: false,
		useMainLlm: false,
		provider: "custom",
		apiKey: "",
		model: BAILIAN_OCR_MODEL,
		ollamaUrl: "http://localhost:11434",
		customEndpoint: BAILIAN_VISION_ENDPOINT,
		apiMode: "chat_completions",
		concurrency: 4
	},
	outputLanguage: "auto",
	setLlmConfig: (llmConfig) => set({ llmConfig }),
	setProviderConfigs: (providerConfigs) => set({ providerConfigs }),
	setActivePresetId: (activePresetId) => set({ activePresetId }),
	setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
	setEmbeddingConfig: (embeddingConfig) => set({ embeddingConfig }),
	setMultimodalConfig: (multimodalConfig) => set({ multimodalConfig }),
	setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
	bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 }))
}));
//#endregion
export { BAILIAN_VISION_ENDPOINT as n, BAILIAN_OCR_MODEL as t, useWikiStore };
