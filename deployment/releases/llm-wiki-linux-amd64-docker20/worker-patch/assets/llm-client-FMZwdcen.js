import { n as isFetchNetworkError, t as getHttpFetch } from "./tauri-fetch-C8XUv1DJ.js";
//#region src/lib/llm-providers.ts
var JSON_CONTENT_TYPE = "application/json";
/**
* Origin header for local-LLM endpoints (Ollama, LM Studio, llama.cpp
* server, LocalAI, vLLM, …).
*
* Always sets `Origin: http://localhost` regardless of where the
* actual server is. Two interlocking reasons:
*
*   1. We MUST override the platform default. `@tauri-apps/plugin-
*      http` v2.5.x auto-injects the webview's own origin
*      (`tauri://localhost` on macOS/Linux,
*      `http://tauri.localhost` on Windows). Ollama's default
*      `OLLAMA_ORIGINS` allowlist accepts `tauri://*` since ~0.1.30
*      but NOT `http://tauri.localhost` — without our override,
*      Windows users hit 403. (User packet capture v0.3.11.)
*
*   2. We can't override with the request's REAL origin because
*      that breaks cross-machine LAN setups. A user pointing at
*      `http://192.168.0.20:11434/v1` would get `Origin:
*      http://192.168.0.20:11434`, which is NOT in Ollama's
*      default OLLAMA_ORIGINS — Ollama then 403s or RST-closes
*      the connection, surfacing as a generic "error sending
*      request" reqwest error. The earlier code claimed Ollama
*      did same-origin bypass; it does not. Reported by user
*      v0.4.2.
*
* `http://localhost` is unconditionally in Ollama's default
* OLLAMA_ORIGINS list (`http://localhost`, `http://localhost:*`,
* `http://127.0.0.1*`, etc.). LM Studio / llama.cpp / vLLM /
* LocalAI don't check Origin at all, so the value is ignored
* there. The header is purely a CORS-allowlist signal — semantic
* "where this request came from" is meaningless here because the
* server uses API keys (or no auth), not origin, for actual
* permission checks.
*
* Users who actively tightened OLLAMA_ORIGINS to remove localhost
* (rare) need to re-add `http://localhost` to their server config;
* no client-side fix can satisfy a hand-locked allowlist that
* specifically excludes the one origin every other LLM client
* also relies on.
*
* Why this overrides at all: plugin-http's JS shim respects user-
* set headers (see `node_modules/@tauri-apps/plugin-http/dist-js/
* index.js` — the loop after `new Request(input, init)` only fills
* browser-default headers when the user did NOT already set them).
* Rust-side, the `unsafe-headers` feature flag in
* `src-tauri/Cargo.toml` lets reqwest forward Origin without
* stripping it. End-to-end our value wins.
*/
function localLlmOriginHeader() {
	return { Origin: "http://localhost" };
}
function parseOpenAiLine(line) {
	if (!line.startsWith("data: ")) return null;
	const data = line.slice(6).trim();
	if (data === "[DONE]") return null;
	try {
		return JSON.parse(data).choices?.[0]?.delta?.content ?? null;
	} catch {
		return null;
	}
}
function parseAnthropicLine(line) {
	if (!line.startsWith("data: ")) return null;
	const data = line.slice(6).trim();
	try {
		const parsed = JSON.parse(data);
		if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") return parsed.delta.text ?? null;
		return null;
	} catch {
		return null;
	}
}
function parseGoogleLine(line) {
	if (!line.startsWith("data: ")) return null;
	const data = line.slice(6).trim();
	try {
		const parts = JSON.parse(data).candidates?.[0]?.content?.parts;
		if (!parts || parts.length === 0) return null;
		let out = "";
		for (const p of parts) {
			if (p.thought) continue;
			if (p.text) out += p.text;
		}
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}
/**
* Translate a `ChatMessage.content` into the OpenAI Chat Completions
* `content` field. The wire accepts either a plain string or an
* array of `{type:"text"|"image_url", ...}` parts; we use the array
* form only when the message actually carries an image, so single-
* string requests stay byte-identical to what we sent before vision
* existed (avoids accidentally regressing endpoints that lag behind
* the spec — quite a few llama.cpp and vLLM builds in the wild
* still parse `content: string` faster than `content: [...]`).
*
* Image bytes are emitted as a `data:` URL inside `image_url.url`.
* `image_url` accepts both URLs and data URLs; data URL keeps every
* byte in the request (no follow-up GET from the model server),
* which is what we want for desktop-LLM endpoints that may not
* have outbound network access at all.
*/
function toOpenAiContent(content) {
	if (typeof content === "string") return content;
	if (content.every((b) => b.type === "text")) return content.map((b) => b.type === "text" ? b.text : "").join("");
	return content.map((b) => {
		if (b.type === "text") return {
			type: "text",
			text: b.text
		};
		return {
			type: "image_url",
			image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` }
		};
	});
}
function buildOpenAiBody(messages, overrides) {
	return {
		messages: messages.map((m) => ({
			role: m.role,
			content: toOpenAiContent(m.content)
		})),
		stream: true,
		...overrides ?? {}
	};
}
/**
* Translate `ChatMessage.content` into Anthropic Messages
* `content`. Anthropic requires the array form for any non-text
* block, and uses a different shape than OpenAI for images
* (`source.media_type` + `source.data` instead of a `data:` URL).
*
* For system messages, Anthropic accepts the top-level `system`
* field as a string OR as a content-block array. We always
* stringify system content here because every existing system-
* prompt call site sends a string and the round-trip through
* blocks is lossy.
*/
function toAnthropicContent(content) {
	if (typeof content === "string") return content;
	if (content.every((b) => b.type === "text")) return content.map((b) => b.type === "text" ? b.text : "").join("");
	return content.map((b) => {
		if (b.type === "text") return {
			type: "text",
			text: b.text
		};
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: b.mediaType,
				data: b.dataBase64
			}
		};
	});
}
/**
* Anthropic's top-level `system` field is a string, not blocks.
* If a caller puts images inside a system message we drop them —
* Anthropic doesn't accept system-level images today, and silently
* losing them is the lesser evil compared to the request 400ing
* out for "Unsupported content block in system".
*/
function flattenAnthropicSystem(content) {
	if (typeof content === "string") return content;
	return content.map((b) => b.type === "text" ? b.text : "").join("");
}
function buildAnthropicBody(messages, overrides) {
	const systemMessages = messages.filter((m) => m.role === "system");
	const conversationMessages = messages.filter((m) => m.role !== "system").map((m) => ({
		role: m.role,
		content: toAnthropicContent(m.content)
	}));
	const system = systemMessages.map((m) => flattenAnthropicSystem(m.content)).join("\n") || void 0;
	return {
		messages: conversationMessages,
		...system !== void 0 ? { system } : {},
		stream: true,
		max_tokens: overrides?.max_tokens ?? 4096,
		...overrides?.temperature !== void 0 ? { temperature: overrides.temperature } : {},
		...overrides?.top_p !== void 0 ? { top_p: overrides.top_p } : {},
		...overrides?.top_k !== void 0 ? { top_k: overrides.top_k } : {},
		...overrides?.stop !== void 0 ? { stop_sequences: Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop] } : {}
	};
}
/**
* Some Anthropic-compatible third-party endpoints (MiniMax global + CN)
* serve the Messages API but authenticate with `Authorization: Bearer`
* instead of Anthropic-native `x-api-key`. See hermes-agent
* `agent/anthropic_adapter.py:_requires_bearer_auth` for reference.
*
* This also matters for CORS: MiniMax's preflight lists `Authorization`
* in `Access-Control-Allow-Headers` but NOT `x-api-key`, so sending the
* Anthropic-native header gets blocked by the browser before the request
* even leaves.
*/
function requiresBearerAuth(url) {
	const normalized = url.toLowerCase().replace(/\/+$/, "");
	return normalized.startsWith("https://api.minimax.io/anthropic") || normalized.startsWith("https://api.minimaxi.com/anthropic") || normalized.startsWith("https://coding.dashscope.aliyuncs.com/apps/anthropic");
}
/**
* Build the final POST URL for an Anthropic-wire endpoint given whatever
* base the user provided. Handles every shape we've seen in the wild:
*
*   .../v1/messages    → as-is (user pasted the full path)
*   .../v1             → append /messages (don't double the /v1)
*   .../api/paas/v4    → append /messages (arbitrary version segment)
*   .../anthropic      → append /v1/messages (MiniMax-style proxy base)
*   .../               → append /v1/messages (bare host)
*
* A bug where this naively appended "/v1/messages" caused requests to
* ".../v1/v1/messages" (404) whenever a user typed a URL ending in /v1.
*/
function buildAnthropicUrl(base) {
	const trimmed = base.replace(/\/+$/, "");
	if (/\/v\d+\/messages$/i.test(trimmed)) return trimmed;
	if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/messages`;
	return `${trimmed}/v1/messages`;
}
function buildAnthropicHeaders(apiKey, url) {
	const base = { "Content-Type": JSON_CONTENT_TYPE };
	if (requiresBearerAuth(url)) base.Authorization = `Bearer ${apiKey}`;
	else {
		base["x-api-key"] = apiKey;
		base["anthropic-version"] = "2023-06-01";
		base["anthropic-dangerous-direct-browser-access"] = "true";
	}
	return base;
}
/**
* Translate `ChatMessage.content` into Gemini `parts`. Gemini's
* native shape is already block-like (`parts: [{text}|{inline_data}]`)
* so the mapping is mostly cosmetic — we don't try to flatten
* single-text-block arrays because Gemini accepts the array form
* uniformly.
*/
function toGoogleParts(content) {
	if (typeof content === "string") return [{ text: content }];
	return content.map((b) => {
		if (b.type === "text") return { text: b.text };
		return { inline_data: {
			mime_type: b.mediaType,
			data: b.dataBase64
		} };
	});
}
function flattenGoogleSystemParts(content) {
	if (typeof content === "string") return content;
	return content.map((b) => b.type === "text" ? b.text : "").join("");
}
function buildGoogleBody(messages, overrides) {
	const systemMessages = messages.filter((m) => m.role === "system");
	const contents = messages.filter((m) => m.role !== "system").map((m) => ({
		role: m.role === "assistant" ? "model" : "user",
		parts: toGoogleParts(m.content)
	}));
	const systemInstruction = systemMessages.length > 0 ? { parts: systemMessages.map((m) => ({ text: flattenGoogleSystemParts(m.content) })) } : void 0;
	const generationConfig = {};
	if (overrides?.temperature !== void 0) generationConfig.temperature = overrides.temperature;
	if (overrides?.top_p !== void 0) generationConfig.topP = overrides.top_p;
	if (overrides?.top_k !== void 0) generationConfig.topK = overrides.top_k;
	if (overrides?.max_tokens !== void 0) generationConfig.maxOutputTokens = overrides.max_tokens;
	if (overrides?.stop !== void 0) generationConfig.stopSequences = Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop];
	return {
		contents,
		...systemInstruction !== void 0 ? { systemInstruction } : {},
		...Object.keys(generationConfig).length > 0 ? { generationConfig } : {}
	};
}
function getProviderConfig(config) {
	const { provider, apiKey, model, ollamaUrl, customEndpoint } = config;
	switch (provider) {
		case "openai": return {
			url: "https://api.openai.com/v1/chat/completions",
			headers: {
				"Content-Type": JSON_CONTENT_TYPE,
				Authorization: `Bearer ${apiKey}`
			},
			buildBody: (messages, overrides) => ({
				...buildOpenAiBody(messages, overrides),
				model
			}),
			parseStream: parseOpenAiLine
		};
		case "anthropic": {
			const url = buildAnthropicUrl("https://api.anthropic.com");
			return {
				url,
				headers: buildAnthropicHeaders(apiKey, url),
				buildBody: (messages, overrides) => ({
					...buildAnthropicBody(messages, overrides),
					model
				}),
				parseStream: parseAnthropicLine
			};
		}
		case "google": return {
			url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
			headers: {
				"Content-Type": JSON_CONTENT_TYPE,
				"x-goog-api-key": apiKey
			},
			buildBody: buildGoogleBody,
			parseStream: parseGoogleLine
		};
		case "ollama": {
			let ollamaBase = ollamaUrl.replace(/\/+$/, "");
			if (/\/v1\/chat\/completions$/i.test(ollamaBase)) ollamaBase = ollamaBase.replace(/\/v1\/chat\/completions$/i, "");
			else if (/\/v1$/i.test(ollamaBase)) ollamaBase = ollamaBase.replace(/\/v1$/i, "");
			return {
				url: `${ollamaBase}/v1/chat/completions`,
				headers: {
					"Content-Type": JSON_CONTENT_TYPE,
					...localLlmOriginHeader()
				},
				buildBody: (messages, overrides) => {
					const body = {
						...buildOpenAiBody(messages, overrides),
						model
					};
					if (/qwen[-_]?3/i.test(model)) body.chat_template_kwargs = { enable_thinking: false };
					return body;
				},
				parseStream: parseOpenAiLine
			};
		}
		case "minimax": {
			const url = buildAnthropicUrl(customEndpoint || "https://api.minimax.io/anthropic");
			return {
				url,
				headers: buildAnthropicHeaders(apiKey, url),
				buildBody: (messages, overrides) => ({
					...buildAnthropicBody(messages, overrides),
					model
				}),
				parseStream: parseAnthropicLine
			};
		}
		case "claude-code": throw new Error("claude-code provider uses subprocess transport; getProviderConfig should not be called for it");
		case "custom": {
			if ((config.apiMode ?? "chat_completions") === "anthropic_messages") {
				const url = buildAnthropicUrl(customEndpoint);
				return {
					url,
					headers: buildAnthropicHeaders(apiKey, url),
					buildBody: (messages, overrides) => ({
						...buildAnthropicBody(messages, overrides),
						model
					}),
					parseStream: parseAnthropicLine
				};
			}
			const base = customEndpoint.replace(/\/+$/, "");
			return {
				url: /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`,
				headers: {
					"Content-Type": JSON_CONTENT_TYPE,
					...apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
					...localLlmOriginHeader()
				},
				buildBody: (messages, overrides) => ({
					...buildOpenAiBody(messages, overrides),
					model
				}),
				parseStream: parseOpenAiLine
			};
		}
		default: throw new Error(`Unknown provider: ${String(provider)}`);
	}
}
//#endregion
//#region src/lib/llm-client.ts
async function streamViaClaudeCodeCli(config, messages, callbacks, signal, requestOverrides) {
	return (await import("./claude-cli-transport-DtID-VAx.js")).streamClaudeCodeCli(config, messages, callbacks, signal, requestOverrides);
}
var DECODER = new TextDecoder();
function parseLines(chunk, buffer) {
	const lines = (buffer + DECODER.decode(chunk, { stream: true })).split("\n");
	return [lines, lines.pop() ?? ""];
}
/**
* The main LLM proxy is only for server-managed requests. User-provided
* endpoints go through the normal provider client so dedicated vision
* configs do not get routed to the text-only server LLM.
*/
function shouldUseServerLlmProxy(config) {
	return config.apiKey === "__SERVER_MANAGED__";
}
function parseOpenAiSseLine(line) {
	if (!line.startsWith("data:")) return null;
	const data = line.slice(5).trim();
	if (data === "[DONE]") return null;
	try {
		return JSON.parse(data)?.choices?.[0]?.delta?.content ?? null;
	} catch {
		return null;
	}
}
async function streamChat(config, messages, callbacks, signal, requestOverrides) {
	if (config.provider === "claude-code") return streamViaClaudeCodeCli(config, messages, callbacks, signal, requestOverrides);
	if (config.apiKey === "__SERVER_MANAGED_VISION__") return streamChatViaProxyEndpoint("/api/llm/vision-stream", config, messages, callbacks, signal, requestOverrides, "vision");
	if (shouldUseServerLlmProxy(config)) return streamChatViaProxy(config, messages, callbacks, signal, requestOverrides);
	return streamChatDirect(config, messages, callbacks, signal, requestOverrides);
}
async function streamChatDirect(config, messages, callbacks, signal, requestOverrides) {
	const { onDone, onError } = callbacks;
	const providerConfig = getProviderConfig(config);
	const timeoutMs = 1800 * 1e3;
	let combinedSignal = signal;
	let timeoutController;
	let timeoutFired = false;
	if (typeof AbortSignal.timeout === "function") {
		timeoutController = new AbortController();
		const timeoutId = setTimeout(() => {
			timeoutFired = true;
			timeoutController?.abort();
		}, timeoutMs);
		if (signal) signal.addEventListener("abort", () => {
			clearTimeout(timeoutId);
			timeoutController?.abort();
		});
		combinedSignal = timeoutController.signal;
	}
	let response;
	try {
		const body = providerConfig.buildBody(messages, requestOverrides);
		response = await (await getHttpFetch())(providerConfig.url, {
			method: "POST",
			headers: providerConfig.headers,
			body: JSON.stringify(body),
			signal: combinedSignal
		});
	} catch (err) {
		if (signal?.aborted) {
			onDone();
			return;
		}
		if (err instanceof Error && err.name === "AbortError") {
			if (timeoutFired) {
				onError(/* @__PURE__ */ new Error(`Request timed out after ${Math.round(timeoutMs / 6e4)} min. Try a faster model or a smaller context.`));
				return;
			}
			onDone();
			return;
		}
		if (isFetchNetworkError(err)) {
			if (timeoutFired) {
				onError(/* @__PURE__ */ new Error(`Request timed out after ${Math.round(timeoutMs / 6e4)} min. Try a faster model or a smaller context.`));
				return;
			}
			onError(/* @__PURE__ */ new Error(`Network error reaching ${providerConfig.url}. Check endpoint URL, API key, and connectivity.`));
			return;
		}
		onError(err instanceof Error ? err : new Error(String(err)));
		return;
	}
	if (!response.ok) {
		let errorDetail = `HTTP ${response.status}: ${response.statusText}`;
		try {
			const body = await response.text();
			if (body) errorDetail += ` — ${body}`;
		} catch {}
		onError(new Error(errorDetail));
		return;
	}
	if (!response.body) {
		onError(/* @__PURE__ */ new Error("Response body is null"));
		return;
	}
	await consumeStream(response.body, providerConfig.parseStream, callbacks, signal);
}
async function streamChatViaProxy(config, messages, callbacks, signal, requestOverrides) {
	return streamChatViaProxyEndpoint("/api/llm/stream", config, messages, callbacks, signal, requestOverrides, "LLM");
}
function toOpenAiCompatContent(content) {
	if (typeof content === "string") return content;
	return content.map((block) => {
		if (block.type === "text") return block;
		return {
			type: "image_url",
			image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` }
		};
	});
}
function toOpenAiCompatMessages(messages) {
	return messages.map((message) => ({
		...message,
		content: toOpenAiCompatContent(message.content)
	}));
}
async function streamChatViaProxyEndpoint(endpoint, config, messages, callbacks, signal, requestOverrides, label = "LLM") {
	const { onDone, onError } = callbacks;
	const body = { messages: toOpenAiCompatMessages(messages) };
	if (requestOverrides?.temperature !== void 0) body.temperature = requestOverrides.temperature;
	if (requestOverrides?.max_tokens !== void 0) body.max_tokens = requestOverrides.max_tokens;
	if (config.model) body.model = config.model;
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal
		});
	} catch (err) {
		if (signal?.aborted) {
			onDone();
			return;
		}
		if (isFetchNetworkError(err)) {
			onError(/* @__PURE__ */ new Error(`Network error reaching the ${label} proxy. Check server logs.`));
			return;
		}
		onError(err instanceof Error ? err : new Error(String(err)));
		return;
	}
	if (!response.ok) {
		let errorDetail = `HTTP ${response.status}: ${response.statusText}`;
		try {
			const body = await response.text();
			if (body) errorDetail += ` — ${body}`;
		} catch {}
		onError(new Error(errorDetail));
		return;
	}
	if (!response.body) {
		onError(/* @__PURE__ */ new Error("Response body is null"));
		return;
	}
	await consumeStream(response.body, parseOpenAiSseLine, callbacks, signal);
}
async function consumeStream(body, parseLine, callbacks, signal) {
	const { onToken, onDone, onError } = callbacks;
	const reader = body.getReader();
	let lineBuffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (lineBuffer.trim()) {
					const token = parseLine(lineBuffer.trim());
					if (token !== null) onToken(token);
				}
				break;
			}
			const [lines, remaining] = parseLines(value, lineBuffer);
			lineBuffer = remaining;
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const token = parseLine(trimmed);
				if (token !== null) onToken(token);
			}
		}
		onDone();
	} catch (err) {
		if (err instanceof Error && (err.name === "AbortError" || signal?.aborted)) {
			onDone();
			return;
		}
		if (isFetchNetworkError(err)) {
			onError(/* @__PURE__ */ new Error("Connection lost during streaming. Try again."));
			return;
		}
		onError(err instanceof Error ? err : new Error(String(err)));
	} finally {
		reader.releaseLock();
	}
}
//#endregion
export { streamChat as t };
