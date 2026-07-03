import { n as __exportAll } from "./react-yWv6PLLo.js";
import { t as streamChat } from "./llm-client-FMZwdcen.js";
//#region src/lib/knowledge-governance/llm-helper.ts
/**
* knowledge-governance/llm-helper.ts
*
* Thin wrapper around the app's existing `streamChat` client.
* Accumulates the stream into a single string and returns it.
*
* This reuses the full provider-aware routing logic:
*   - Server-managed configs route through /api/llm/stream
*   - User-provided configs call getProviderConfig directly (handles DeepSeek,
*     OpenAI, Ollama, custom, etc.) with the correct URL + auth headers
*
* Previous version tried to re-implement this from scratch and failed
* because it used llmConfig.endpoint which doesn't exist (it's
* customEndpoint / ollamaUrl / provider-specific).
*/
function hasUsableLlmConfig(config) {
	if (!config?.model) return false;
	if (config.apiKey) return true;
	if (config.provider === "ollama" || config.provider === "claude-code") return true;
	return config.provider === "custom" && Boolean(config.customEndpoint);
}
/**
* Call the LLM and return the full accumulated response text.
* Returns null if the call fails or produces empty output.
*
* @param llmConfig  LlmConfig from wiki-store (provider, apiKey, model, etc.)
* @param messages   OpenAI-format message array
* @param maxTokens  Max tokens for the response
*/
async function callLLM(llmConfig, messages, maxTokens = 512) {
	if (!hasUsableLlmConfig(llmConfig)) {
		console.warn("[llm-helper] No LLM config provided");
		return null;
	}
	return new Promise((resolve) => {
		let accumulated = "";
		streamChat(llmConfig, messages, {
			onToken: (token) => {
				accumulated += token;
			},
			onDone: () => resolve(accumulated.trim() || null),
			onError: (err) => {
				console.warn("[llm-helper] LLM call error:", err.message);
				resolve(null);
			}
		}, void 0, {
			temperature: .1,
			max_tokens: maxTokens
		});
	});
}
//#endregion
//#region src/lib/knowledge-governance/diff-engine.ts
var diff_engine_exports = /* @__PURE__ */ __exportAll({ generateSemanticDiff: () => generateSemanticDiff });
/**
* knowledge-governance/diff-engine.ts
*
* LLM-powered semantic diff between two wiki pages.
* Extracts structured change points: added, removed, changed knowledge.
*
* Stateless — no file IO. Called by orchestrator or review panel
* when the user confirms a supersession.
*/
function buildDiffPrompt(oldTitle, oldContent, newTitle, newContent) {
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
{"added_points":[],"removed_points":[],"changed_points":[],"summary":""}`.trim();
}
function toStringArray(val, max = 5) {
	if (!Array.isArray(val)) return [];
	return val.slice(0, max).map((v) => String(v).trim()).filter(Boolean);
}
function parseDiffResponse(raw) {
	try {
		const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		const parsed = JSON.parse(clean);
		return {
			addedPoints: toStringArray(parsed.added_points),
			removedPoints: toStringArray(parsed.removed_points),
			changedPoints: toStringArray(parsed.changed_points),
			summary: String(parsed.summary ?? "").slice(0, 80)
		};
	} catch {
		const match = raw.match(/\{[\s\S]*\}/);
		if (match) try {
			const parsed = JSON.parse(match[0]);
			return {
				addedPoints: toStringArray(parsed.added_points),
				removedPoints: toStringArray(parsed.removed_points),
				changedPoints: toStringArray(parsed.changed_points),
				summary: String(parsed.summary ?? "").slice(0, 80)
			};
		} catch {}
		return null;
	}
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
async function generateSemanticDiff(llmConfig, oldTitle, oldContent, newTitle, newContent) {
	if (!hasUsableLlmConfig(llmConfig)) {
		console.warn("[diff-engine] LLM not configured");
		return null;
	}
	const responseText = await callLLM(llmConfig, [{
		role: "user",
		content: buildDiffPrompt(oldTitle, oldContent, newTitle, newContent)
	}], 512);
	if (!responseText) {
		console.warn("[diff-engine] LLM returned no response");
		return null;
	}
	return parseDiffResponse(responseText);
}
//#endregion
export { hasUsableLlmConfig as i, generateSemanticDiff as n, callLLM as r, diff_engine_exports as t };
