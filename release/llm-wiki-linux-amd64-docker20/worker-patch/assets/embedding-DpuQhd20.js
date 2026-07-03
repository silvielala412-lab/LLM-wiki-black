import { n as __exportAll } from "./react-yWv6PLLo.js";
import { c as vectorSearchChunks$1, l as vectorUpsertChunks$1 } from "./fs-WYeR_9ZT.js";
import { normalizePath } from "./path-utils-BHuw7z0q.js";
import "./product-catalog-modules-Bd1IGcTo.js";
import { n as isFetchNetworkError, t as getHttpFetch } from "./tauri-fetch-C8XUv1DJ.js";
import { t as chunkMarkdown } from "./text-chunker-pjcnuz1l.js";
//#region src/lib/embedding.ts
/**
* Embedding pipeline — standard RAG flow.
*
*   1. chunkMarkdown(content)        (src/lib/text-chunker.ts)
*   2. for each chunk:
*        fetchEmbedding(title + heading_path + chunk_text)
*        with auto-halve retry on "input too long" errors
*   3. vector_upsert_chunks(page_id, [{chunk_index, chunk_text,
*      heading_path, embedding}, …])
*
* Search:
*   1. fetchEmbedding(query)
*   2. vector_search_chunks(query_emb, topK × 3)
*   3. group by page_id, max-pool primary score + weighted tail sum
*   4. return top-K pages, outer API-compatible with the old per-page
*      `{id, score}[]` shape; matched chunks available on the
*      optional `matchedChunks` field for future UI surfacing.
*
* HTTP goes through the Tauri plugin (`src/lib/tauri-fetch.ts`) so
* CORS-unfriendly endpoints work the same as the LLM path.
*/
var embedding_exports = /* @__PURE__ */ __exportAll({
	embedPage: () => embedPage,
	fetchEmbedding: () => fetchEmbedding,
	looksLikeOversizeError: () => looksLikeOversizeError,
	searchByEmbedding: () => searchByEmbedding
});
/**
* Most recent embedding failure description, so Settings → Embedding
* can show the user WHY vector search fell back to BM25 instead of
* silently dropping to keyword match. Cleared on any successful
* embed.
*/
var lastEmbeddingError = null;
/**
* Heuristic: does this error response look like an "input too long /
* exceeds model context / payload too large" rejection? True for all
* the phrasings we've seen from OpenAI, LM Studio, llama.cpp,
* Ollama, and Azure. Safer to over-match than under-match — a false
* positive just means a retry at half size, which will still succeed
* on a real auth/model-id error (it won't) or just log the same error.
*/
function looksLikeOversizeError(httpStatus, body) {
	if (httpStatus === 413) return true;
	const lower = body.toLowerCase();
	return lower.includes("too long") || lower.includes("maximum context") || lower.includes("max_tokens") || lower.includes("max tokens") || lower.includes("context length") || lower.includes("token limit") || lower.includes("exceeds") || lower.includes("input length");
}
function isDashScopeMultimodalEmbedding(endpoint, model) {
	return endpoint.includes("/multimodal-embedding/") || model.startsWith("tongyi-embedding-vision") || model === "qwen3-vl-embedding" || model === "qwen2.5-vl-embedding" || model === "multimodal-embedding-v1";
}
function buildEmbeddingRequestBody(endpoint, model, input) {
	if (isDashScopeMultimodalEmbedding(endpoint, model)) return {
		model,
		input: { contents: [{ text: input }] }
	};
	return {
		model,
		input
	};
}
function readEmbeddingFromResponse(data) {
	const value = data;
	return value?.data?.[0]?.embedding ?? value?.output?.embeddings?.[0]?.embedding ?? value?.output?.embedding ?? null;
}
/**
* POST one embedding request; on an oversize rejection, halve the text
* and retry up to `maxRetries` times. Returns null on definitive
* failure (auth, network, dim mismatch, retries exhausted) with a
* human-readable reason left in `lastEmbeddingError`.
*
* The returned vector represents the (possibly truncated) text that
* actually got through. Chunker config should be tuned to minimise
* truncation — this is a safety net, not the main line of defence.
*/
async function fetchEmbedding(text, cfg, maxRetries = 3) {
	if (!cfg.endpoint && !cfg.model) return null;
	try {
		const cfgRes = await fetch("/api/config");
		if (cfgRes.ok) {
			if ((await cfgRes.json())?.embedding?.endpoint) return fetchEmbeddingViaProxy(text, maxRetries);
		}
	} catch {}
	if (!cfg.endpoint) return null;
	const headers = { "Content-Type": "application/json" };
	if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
	let current = text;
	let attempts = 0;
	while (attempts <= maxRetries) {
		attempts++;
		try {
			const resp = await (await getHttpFetch())(cfg.endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(buildEmbeddingRequestBody(cfg.endpoint, cfg.model, current))
			});
			if (resp.ok) {
				const data = await resp.json();
				const embedding = readEmbeddingFromResponse(data);
				if (embedding) {
					lastEmbeddingError = null;
					return embedding;
				}
				lastEmbeddingError = `Embedding response missing embedding vector (got ${JSON.stringify(data).slice(0, 200)})`;
				console.warn(`[Embedding] ${lastEmbeddingError}`);
				return null;
			}
			let bodyText = "";
			try {
				bodyText = await resp.text();
			} catch {}
			if (looksLikeOversizeError(resp.status, bodyText)) {
				if (current.length > 64 && attempts <= maxRetries) {
					const prev = current.length;
					current = current.slice(0, Math.floor(current.length / 2));
					console.warn(`[Embedding] auto-halving after HTTP ${resp.status} at ${prev} chars → retrying at ${current.length} chars (attempt ${attempts}/${maxRetries + 1})`);
					continue;
				}
				lastEmbeddingError = `Endpoint rejected input even at ${current.length} chars — server context smaller than expected. Lower Settings → Embedding → Max Chunk Chars (${bodyText.slice(0, 160)}).`;
				console.warn(`[Embedding] ${lastEmbeddingError}`);
				return null;
			}
			lastEmbeddingError = `API ${resp.status} ${resp.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""} at ${cfg.endpoint}`;
			console.warn(`[Embedding] ${lastEmbeddingError}`);
			return null;
		} catch (err) {
			if (isFetchNetworkError(err)) lastEmbeddingError = `Network error reaching ${cfg.endpoint}. Check endpoint URL, API key, and connectivity.`;
			else lastEmbeddingError = err instanceof Error ? err.message : String(err);
			console.warn(`[Embedding] ${lastEmbeddingError}`);
			return null;
		}
	}
	lastEmbeddingError = `Embedding endpoint rejected every size down to ${current.length} chars — the server's context is smaller than ${current.length * 2}. Lower Settings → Embedding → Max Chunk Chars.`;
	console.warn(`[Embedding] ${lastEmbeddingError}`);
	return null;
}
/**
* Call /api/llm/embed (backend proxy) — avoids Mixed Content + CORS.
* Auto-halves on oversize errors, same as the direct path.
*/
async function fetchEmbeddingViaProxy(text, maxRetries = 3) {
	let current = text;
	let attempts = 0;
	while (attempts <= maxRetries) {
		attempts++;
		try {
			const resp = await fetch("/api/llm/embed", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: current })
			});
			if (resp.ok) {
				const embedding = readEmbeddingFromResponse(await resp.json());
				if (embedding) {
					lastEmbeddingError = null;
					return embedding;
				}
				lastEmbeddingError = `Embedding proxy response missing embedding vector`;
				console.warn(`[Embedding] ${lastEmbeddingError}`);
				return null;
			}
			let bodyText = "";
			try {
				bodyText = await resp.text();
			} catch {}
			if (resp.status === 503) {
				lastEmbeddingError = `Embedding not configured on server (set EMBEDDING_ENDPOINT env var).`;
				console.warn(`[Embedding] ${lastEmbeddingError}`);
				return null;
			}
			if (looksLikeOversizeError(resp.status, bodyText)) {
				if (current.length > 64 && attempts <= maxRetries) {
					const prev = current.length;
					current = current.slice(0, Math.floor(current.length / 2));
					console.warn(`[Embedding] proxy auto-halving after HTTP ${resp.status} at ${prev} chars → ${current.length} chars`);
					continue;
				}
				lastEmbeddingError = `Embedding proxy rejected input even at ${current.length} chars.`;
				console.warn(`[Embedding] ${lastEmbeddingError}`);
				return null;
			}
			lastEmbeddingError = `Embedding proxy HTTP ${resp.status}: ${bodyText.slice(0, 200)}`;
			console.warn(`[Embedding] ${lastEmbeddingError}`);
			return null;
		} catch (err) {
			lastEmbeddingError = err instanceof Error ? err.message : String(err);
			console.warn(`[Embedding] proxy error: ${lastEmbeddingError}`);
			return null;
		}
	}
	lastEmbeddingError = `Embedding proxy rejected every size down to ${current.length} chars.`;
	console.warn(`[Embedding] ${lastEmbeddingError}`);
	return null;
}
async function vectorUpsertChunks(projectPath, pageId, pageTitle, chunks) {
	await vectorUpsertChunks$1(normalizePath(projectPath), pageId, pageTitle, chunks.map((c) => ({
		chunk_index: c.chunkIndex,
		heading_path: c.headingPath,
		chunk_text: c.chunkText,
		vector: c.embedding.map((v) => Math.fround(v))
	})));
}
async function vectorSearchChunks(projectPath, queryEmbedding, topK) {
	return await vectorSearchChunks$1(normalizePath(projectPath), queryEmbedding.map((v) => Math.fround(v)), topK);
}
/**
* Build the text we actually embed for a chunk: page title + heading
* breadcrumb + chunk content. The breadcrumb is the most important
* context for a short chunk — a 300-char excerpt about "Mixture of
* Experts" is far more findable when the embedded text explicitly
* names its containing sections.
*/
function enrichChunkForEmbedding(pageTitle, chunk) {
	const parts = [];
	if (pageTitle.trim().length > 0) parts.push(pageTitle.trim());
	if (chunk.headingPath.trim().length > 0) parts.push(chunk.headingPath.trim());
	parts.push(chunk.text.trim());
	return parts.join("\n\n");
}
/**
* Embed a wiki page: chunk → per-chunk embed → replace the page's
* vectors in LanceDB in one batch. Every transient failure leaves the
* existing v2 rows intact (empty upsert is a no-op Rust-side).
*
* Called by ingest.ts after writing a page to disk.
*/
async function embedPage(projectPath, pageId, title, content, cfg) {
	if (!cfg.enabled || !cfg.model) return;
	const t0 = performance.now();
	const chunks = chunkMarkdown(content, {
		targetChars: cfg.maxChunkChars ?? 1e3,
		overlapChars: cfg.overlapChunkChars ?? 200
	});
	if (chunks.length === 0) return;
	const rows = [];
	let failedChunks = 0;
	for (const chunk of chunks) {
		const vec = await fetchEmbedding(enrichChunkForEmbedding(title, chunk), cfg);
		if (vec) rows.push({
			chunkIndex: chunk.index,
			chunkText: chunk.text,
			headingPath: chunk.headingPath,
			embedding: vec
		});
		else failedChunks++;
	}
	if (rows.length === 0) {
		console.log(`[Embedding] Indexed nothing for "${pageId}" — all ${chunks.length} chunks failed. See getLastEmbeddingError().`);
		return;
	}
	await vectorUpsertChunks(projectPath, pageId, title, rows);
	const elapsed = Math.round(performance.now() - t0);
	console.log(`[Embedding] Indexed "${pageId}": ${rows.length}/${chunks.length} chunks (${failedChunks} skipped) in ${elapsed}ms`);
}
async function searchByEmbedding(projectPath, query, cfg, topK = 10) {
	if (!cfg.enabled || !cfg.model) return [];
	const queryEmb = await fetchEmbedding(query, cfg);
	if (!queryEmb) return [];
	const t0 = performance.now();
	let rawChunks = [];
	try {
		rawChunks = await vectorSearchChunks(projectPath, queryEmb, Math.max(topK * 3, 30));
	} catch (err) {
		console.log(`[Embedding] LanceDB chunk search failed: ${err instanceof Error ? err.message : err}`);
		return [];
	}
	if (rawChunks.length === 0) return [];
	const byPage = /* @__PURE__ */ new Map();
	for (const c of rawChunks) {
		const pageId = c.page_id ?? c.page_path;
		if (!pageId) continue;
		const bucket = byPage.get(pageId);
		if (bucket) bucket.push(c);
		else byPage.set(pageId, [c]);
	}
	const ranked = [];
	for (const [pageId, chunks] of byPage.entries()) {
		chunks.sort((a, b) => b.score - a.score);
		const top = chunks[0].score;
		const tail = chunks.slice(1).reduce((sum, c) => sum + c.score, 0);
		const blended = top + Math.min(tail * .3, Math.max(0, 1 - top));
		ranked.push({
			id: pageId,
			score: blended,
			matchedChunks: chunks.slice(0, 3).map((c) => ({
				text: c.chunk_text,
				headingPath: c.heading_path ?? "",
				score: c.score
			}))
		});
	}
	ranked.sort((a, b) => b.score - a.score);
	const elapsed = Math.round(performance.now() - t0);
	console.log(`[Embedding] LanceDB chunk search: ${rawChunks.length} chunks → ${ranked.length} pages in ${elapsed}ms`);
	return ranked.slice(0, topK);
}
//#endregion
export { fetchEmbedding as n, embedding_exports as t };
