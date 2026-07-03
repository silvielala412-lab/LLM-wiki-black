import { a as listDirectory, o as readFile } from "./fs-WYeR_9ZT.js";
import { normalizePath } from "./path-utils-BHuw7z0q.js";
import { t as streamChat } from "./llm-client-FMZwdcen.js";
import { useWikiStore } from "./wiki-store-DMaxMIiL.js";
import { useActivityStore } from "./activity-store-DbP1Cs9i.js";
import { n as normalizeReviewTitle, t as useReviewStore } from "./review-store-DhdQpc75.js";
//#region src/lib/sweep-reviews.ts
/**
* Sweep pending review items and auto-resolve those whose underlying
* condition has been addressed by subsequent ingests.
*
* Triggered when the ingest queue drains. Two stages:
*   1. Rule-based matching (filename / frontmatter title / affectedPages)
*   2. LLM semantic judgment for remaining pending items
*
* Conservative: preserves contradiction / suggestion / confirm types
* that need human judgment.
*/
function flattenMdFiles(nodes) {
	const files = [];
	for (const node of nodes) if (node.is_dir && node.children) files.push(...flattenMdFiles(node.children));
	else if (!node.is_dir && node.name.endsWith(".md")) files.push(node);
	return files;
}
/** Build an index of wiki pages: id (filename without .md) + title → normalized */
async function buildWikiIndex(projectPath) {
	const pp = normalizePath(projectPath);
	const byId = /* @__PURE__ */ new Set();
	const byTitle = /* @__PURE__ */ new Set();
	const pages = [];
	try {
		const files = flattenMdFiles(await listDirectory(`${pp}/wiki`));
		for (const file of files) {
			const id = file.name.replace(/\.md$/, "").toLowerCase();
			byId.add(id);
			let title = null;
			try {
				const match = (await readFile(file.path)).match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
				if (match) {
					title = match[1].trim();
					byTitle.add(title.toLowerCase());
				}
			} catch {}
			pages.push({
				id,
				title
			});
		}
	} catch {}
	return {
		byId,
		byTitle,
		pages
	};
}
/**
* Extract candidate page names from a review item's title / description.
* Conservative — only flags items where we can confidently identify a page name.
*/
function extractCandidateNames(item) {
	const names = /* @__PURE__ */ new Set();
	const cleaned = normalizeReviewTitle(item.title);
	if (cleaned && cleaned.length <= 100) names.add(cleaned);
	for (const page of item.affectedPages ?? []) {
		const base = page.split("/").pop()?.replace(/\.md$/, "");
		if (base) names.add(base.toLowerCase());
	}
	return Array.from(names);
}
/** Check if a candidate name matches an existing wiki page */
function pageExists(name, index) {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return false;
	if (index.byId.has(normalized)) return true;
	if (index.byId.has(normalized.replace(/\s+/g, "-"))) return true;
	if (index.byTitle.has(normalized)) return true;
	return false;
}
/**
* Extract a JSON object from an LLM response.
*
* Handles:
*   - Bare JSON: `{...}`
*   - Fenced: ` ```json\n{...}\n``` ` or single-line ` ```{...}``` `
*   - Wrapped in prose: find the first balanced `{...}` object via brace depth
*
* Returns empty string if no balanced object is found.
*
* @internal Exported for unit tests only.
*/
function extractJsonObject(raw) {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, "");
	text = text.replace(/\s*```\s*$/i, "");
	text = text.trim();
	const start = text.indexOf("{");
	if (start === -1) return "";
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escape = true;
			continue;
		}
		if (ch === "\"") {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return "";
}
var JUDGE_BATCH_SIZE = 40;
var MAX_JUDGE_BATCHES = 5;
var MAX_PAGES_IN_PROMPT = 300;
/**
* Ask the LLM to judge a single batch of pending reviews. Returns the set of
* resolved review IDs (subset of the batch's IDs).
*
* Conservative: returns empty set on any error (network, parse, config missing,
* aborted).
*/
async function judgeBatch(batch, index, signal) {
	if (batch.length === 0 || signal?.aborted) return /* @__PURE__ */ new Set();
	const llmConfig = useWikiStore.getState().llmConfig;
	if (!(!!llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")) return /* @__PURE__ */ new Set();
	const pageList = index.pages.slice(0, MAX_PAGES_IN_PROMPT).map((p) => p.title ? `- ${p.id}  (title: ${p.title})` : `- ${p.id}`).join("\n");
	const reviewList = batch.map((r) => {
		const affected = r.affectedPages?.length ? ` | affected: ${r.affectedPages.join(", ")}` : "";
		const desc = r.description ? ` — ${r.description.slice(0, 200)}` : "";
		return `- id=${r.id} [${r.type}] "${r.title}"${desc}${affected}`;
	}).join("\n");
	const prompt = [
		"You are cleaning up a stale review queue for a personal wiki.",
		"After recent ingests, some review items may no longer be valid because the missing page now exists, the duplicate was resolved, or the referenced concept has been added.",
		"",
		"Current wiki pages (filename, optional title):",
		pageList || "(no pages yet)",
		"",
		"Pending review items to judge:",
		reviewList,
		"",
		"For each review item, decide whether the underlying condition has been RESOLVED by the current wiki state.",
		"Be conservative: only mark as resolved if you are confident the concern no longer applies.",
		"For contradictions, confirmations, or human-judgment items, default to keeping them pending.",
		"",
		"Respond with ONLY a JSON object in this exact shape: {\"resolved\": [\"id1\", \"id2\"]}",
		"If none of the items are resolved, return exactly: {\"resolved\": []}",
		"Do not wrap in markdown fences. Do not add commentary."
	].join("\n");
	let raw = "";
	let hadError = false;
	try {
		await streamChat(llmConfig, [{
			role: "user",
			content: prompt
		}], {
			onToken: (token) => {
				raw += token;
			},
			onDone: () => {},
			onError: (err) => {
				hadError = true;
				console.warn("[Sweep Reviews] LLM error:", err.message);
			}
		}, signal);
	} catch (err) {
		console.warn("[Sweep Reviews] LLM call failed:", err);
		return /* @__PURE__ */ new Set();
	}
	if (hadError || signal?.aborted || !raw.trim()) return /* @__PURE__ */ new Set();
	try {
		const cleaned = extractJsonObject(raw);
		if (!cleaned) {
			console.warn("[Sweep Reviews] No JSON object in response:", raw.slice(0, 300));
			return /* @__PURE__ */ new Set();
		}
		const parsed = JSON.parse(cleaned);
		if (!parsed || !Array.isArray(parsed.resolved)) return /* @__PURE__ */ new Set();
		const validIds = new Set(batch.map((i) => i.id));
		const resolved = /* @__PURE__ */ new Set();
		for (const id of parsed.resolved) if (typeof id === "string" && validIds.has(id)) resolved.add(id);
		return resolved;
	} catch (err) {
		console.warn("[Sweep Reviews] Failed to parse LLM response:", err, raw.slice(0, 300));
		return /* @__PURE__ */ new Set();
	}
}
/**
* Judge all remaining pending reviews by processing them in batches.
*
* - Caps at MAX_JUDGE_BATCHES to avoid unbounded LLM calls per drain.
* - Breaks early if a batch resolves nothing (likely nothing else will either).
* - Stops immediately on abort.
*/
async function llmJudgeReviews(pending, index, signal) {
	const resolved = /* @__PURE__ */ new Set();
	if (pending.length === 0) return resolved;
	const remaining = [...pending];
	let batches = 0;
	while (remaining.length > 0 && batches < MAX_JUDGE_BATCHES) {
		if (signal?.aborted) break;
		const batchResolved = await judgeBatch(remaining.splice(0, JUDGE_BATCH_SIZE), index, signal);
		batches++;
		if (batchResolved.size === 0) break;
		for (const id of batchResolved) resolved.add(id);
	}
	return resolved;
}
/**
* Returns true if the given path still matches the currently-open project.
* Used to bail mid-sweep if the user has switched projects under us —
* the sweep's wiki index is for the old project and would falsely match
* the new project's reviews if we kept going.
*/
function matchesCurrentProject(projectPath) {
	const current = useWikiStore.getState().project?.path;
	if (!current) return false;
	return normalizePath(current) === normalizePath(projectPath);
}
/**
* Scan pending review items and auto-resolve those whose condition
* no longer holds. Called when the ingest queue drains.
*
* Guards against two races:
*   - `signal` aborted mid-flight (e.g. project switch triggered clearQueueState)
*   - The current project changed while we were awaiting I/O — the wiki index
*     we built is for the wrong project and must not be applied.
*/
async function sweepResolvedReviews(projectPath, signal) {
	if (signal?.aborted) return 0;
	if (!matchesCurrentProject(projectPath)) return 0;
	const store = useReviewStore.getState();
	const pending = store.items.filter((i) => !i.resolved);
	if (pending.length === 0) return 0;
	const index = await buildWikiIndex(projectPath);
	if (signal?.aborted || !matchesCurrentProject(projectPath)) return 0;
	let ruleResolved = 0;
	const stillPending = [];
	for (const item of pending) {
		if (signal?.aborted || !matchesCurrentProject(projectPath)) return ruleResolved;
		let resolvedByRule = false;
		if (item.type === "missing-page") {
			const names = extractCandidateNames(item);
			if (names.length > 0 && names.some((n) => pageExists(n, index))) {
				store.resolveItem(item.id, "auto-resolved");
				ruleResolved++;
				resolvedByRule = true;
			}
		} else if (item.type === "duplicate") {
			const affected = item.affectedPages ?? [];
			if (affected.length > 0) {
				if (!affected.every((p) => {
					const base = p.split("/").pop()?.replace(/\.md$/, "").toLowerCase();
					return base ? index.byId.has(base) : false;
				})) {
					store.resolveItem(item.id, "auto-resolved");
					ruleResolved++;
					resolvedByRule = true;
				}
			}
		}
		if (!resolvedByRule) stillPending.push(item);
	}
	let llmResolved = 0;
	const activity = useActivityStore.getState();
	let activityId = null;
	if (stillPending.length > 0 && !signal?.aborted && matchesCurrentProject(projectPath)) {
		activityId = activity.addItem({
			type: "query",
			title: "Review cleanup",
			status: "running",
			detail: `Judging ${stillPending.length} pending review${stillPending.length > 1 ? "s" : ""}…`,
			filesWritten: []
		});
		try {
			const resolvedIds = await llmJudgeReviews(stillPending, index, signal);
			if (!signal?.aborted && matchesCurrentProject(projectPath)) for (const id of resolvedIds) {
				store.resolveItem(id, "llm-judged");
				llmResolved++;
			}
		} catch (err) {
			activity.updateItem(activityId, {
				status: "error",
				detail: `Review cleanup failed: ${err instanceof Error ? err.message : String(err)}`
			});
			activityId = null;
		}
	}
	const total = ruleResolved + llmResolved;
	const parts = [];
	if (ruleResolved > 0) parts.push(`${ruleResolved} by rules`);
	if (llmResolved > 0) parts.push(`${llmResolved} by LLM`);
	const detail = total > 0 ? `Auto-resolved ${total} stale review item${total > 1 ? "s" : ""} (${parts.join(", ")})` : "No stale review items to clean up";
	if (activityId !== null) activity.updateItem(activityId, {
		status: signal?.aborted ? "error" : "done",
		detail: signal?.aborted ? "Review cleanup cancelled" : detail
	});
	else if (total > 0) activity.addItem({
		type: "query",
		title: "Review cleanup",
		status: "done",
		detail,
		filesWritten: []
	});
	if (total > 0) console.log(`[Sweep Reviews] ${detail}`);
	return total;
}
//#endregion
export { sweepResolvedReviews };
