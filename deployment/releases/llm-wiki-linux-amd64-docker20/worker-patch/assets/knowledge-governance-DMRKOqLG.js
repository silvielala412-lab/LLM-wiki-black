import { o as readFile, u as writeFile } from "./fs-WYeR_9ZT.js";
import { i as hasUsableLlmConfig, r as callLLM } from "./diff-engine-CS--ANVl.js";
import "./lineage-tracker-CX_M8jyO.js";
//#region src/lib/knowledge-governance/status-manager.ts
/**
* knowledge-governance/status-manager.ts
*
* Reads and writes the `status` field in wiki page frontmatter.
* This module is pure FS — no LLM, no vector store, no UI.
*/
/**
* Inject or update the `status` field in frontmatter.
* Preserves all other frontmatter fields and the body.
*/
function setStatusInContent(content, status) {
	if (content.match(/^---\r?\n[\s\S]*?\r?\n---/m)) {
		if (/^status:/m.test(content)) return content.replace(/^status:.*$/m, `status: "${status}"`);
		return content.replace(/^(---\r?\n)/, `$1status: "${status}"\n`);
	}
	return `---\nstatus: "${status}"\n---\n\n${content}`;
}
/**
* Write a new status to a page on disk.
* Returns the updated content (for callers that want to refresh the UI).
*/
async function setPageStatus(pagePath, status) {
	const updated = setStatusInContent(await readFile(pagePath), status);
	await writeFile(pagePath, updated);
	return updated;
}
/**
* Stamp a freshly generated page as "candidate".
* Called by the ingest pipeline immediately after writing the file.
* Ingested pages must remain candidate until a human explicitly approves them.
*/
async function stampCandidate(pagePath) {
	try {
		const content = await readFile(pagePath);
		const updated = setStatusInContent(content, "candidate");
		if (updated !== content) await writeFile(pagePath, updated);
	} catch (err) {
		console.warn("[status-manager] Failed to stamp candidate:", pagePath, err);
	}
}
//#endregion
//#region src/lib/knowledge-governance/review-persistence.ts
/**
* knowledge-governance/review-persistence.ts
*
* Persists the Review Queue to {projectPath}/review-queue.json.
* Pure FS — no UI, no LLM. Append-only by default; resolutions update in place.
*/
var QUEUE_FILE = "review-queue.json";
function queuePath(projectPath) {
	return `${projectPath}/${QUEUE_FILE}`;
}
async function loadReviewQueue(projectPath) {
	try {
		const raw = await readFile(queuePath(projectPath));
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
async function saveReviewQueue(projectPath, items) {
	const safeItems = items.filter((item) => {
		try {
			JSON.stringify(item);
			return true;
		} catch {
			return false;
		}
	});
	let json;
	try {
		json = JSON.stringify(safeItems, null, 2);
		JSON.parse(json);
	} catch (err) {
		console.error("[review-persistence] saveReviewQueue: JSON validation failed, aborting write:", err);
		return;
	}
	await writeFile(queuePath(projectPath), json);
}
/** Append a new ReviewItem. Silently deduplicates by newPagePath. */
async function appendReviewItem(projectPath, item) {
	const queue = await loadReviewQueue(projectPath);
	if (queue.some((q) => q.newPagePath === item.newPagePath && q.status === "pending")) return;
	queue.push(item);
	await saveReviewQueue(projectPath, queue);
}
/** Mark a review item as resolved. */
async function resolveReviewItem(projectPath, id, resolution, resolvedBy = "user") {
	const queue = await loadReviewQueue(projectPath);
	const idx = queue.findIndex((q) => q.id === id);
	if (idx === -1) return;
	queue[idx] = {
		...queue[idx],
		status: "resolved",
		resolution,
		resolvedBy,
		resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await saveReviewQueue(projectPath, queue);
}
/** Dismiss a review item (skip without making a knowledge decision). */
async function dismissReviewItem(projectPath, id) {
	const queue = await loadReviewQueue(projectPath);
	const idx = queue.findIndex((q) => q.id === id);
	if (idx === -1) return;
	queue[idx] = {
		...queue[idx],
		status: "dismissed",
		resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await saveReviewQueue(projectPath, queue);
}
/** Returns only pending (unresolved, undismissed) items. */
function filterPendingItems(items) {
	return items.filter((i) => i.status === "pending");
}
//#endregion
//#region src/lib/knowledge-governance/conflict-detector.ts
/**
* knowledge-governance/conflict-detector.ts
*
* Finds existing wiki pages that are semantically similar to a newly
* ingested page. Uses the vector embedding store when available,
* falling back to title-based fuzzy matching when embeddings are off.
*
* This module is pure logic — no UI, no LLM calls, no side effects
* beyond reading the file system and vector store.
*/
var SKIP_PATH_SEGMENTS = [
	"/wiki/audits/",
	"/wiki/sources/",
	"/wiki/queries/",
	"/wiki/.identity-audit/"
];
function isSkippedPath(filePath) {
	const normalized = filePath.replace(/\\/g, "/");
	return SKIP_PATH_SEGMENTS.some((seg) => normalized.includes(seg));
}
function pathKey(path) {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
function isSamePagePath(left, right) {
	return pathKey(left) === pathKey(right);
}
var VECTOR_HIGH_SIMILARITY = .88;
var VECTOR_MIN_SIMILARITY = .78;
function extractTitleAndExcerpt(content) {
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/m);
	let title = "";
	if (fmMatch) {
		const titleLine = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
		if (titleLine) title = titleLine[1].trim();
	}
	if (!title) {
		const h1 = content.match(/^#\s+(.+)$/m);
		if (h1) title = h1[1].trim();
	}
	const excerpt = (fmMatch ? content.slice(fmMatch[0].length) : content).replace(/^#+\s+.+$/gm, "").replace(/\s+/g, " ").trim().slice(0, 400);
	return {
		title: title || "Untitled",
		excerpt
	};
}
function isSourcePagePath(path) {
	const normalized = path.replace(/\\/g, "/");
	return normalized.includes("/wiki/sources/") || normalized.startsWith("wiki/sources/") || normalized.startsWith("sources/");
}
function frontmatterScalar(content, key) {
	return (content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? "").match(new RegExp(`^${key}\\s*:\\s*["']?([^"'\\r\\n#]*?)["']?\\s*$`, "m"))?.[1]?.trim().toLowerCase() ?? "";
}
function isSourceTypedContent(content) {
	const et = frontmatterScalar(content, "entity_type");
	const tp = frontmatterScalar(content, "type");
	if ([
		"source",
		"audit_report",
		"source_summary",
		"query",
		"audit",
		"report"
	].includes(et)) return true;
	if (["source", "query"].includes(tp)) return true;
	if (/^redirect_to:\s*".+"/m.test(content)) return true;
	return false;
}
/**
* Find pages similar to `newContent` using the vector index.
* Returns candidates sorted by score descending.
*
* @param projectPath  Absolute project root path
* @param newPageId    Page ID of the new page (excluded from results)
* @param newContent   Full markdown content of the new page
* @param embCfg       Embedding config from wiki-store
* @param topK         Maximum candidates to return
*/
async function findSimilarByVector(projectPath, newPageId, newContent, embCfg, topK = 5) {
	try {
		const { searchByEmbedding } = await import("./embedding-DpuQhd20.js").then((n) => n.t);
		const { normalizePath } = await import("./path-utils-BHuw7z0q.js");
		const pp = normalizePath(projectPath);
		const expectedNewPagePath = `${pp}/wiki/${newPageId}.md`;
		if (isSourcePagePath(newPageId) || isSourceTypedContent(newContent) || isSkippedPath(expectedNewPagePath)) return [];
		const { title, excerpt } = extractTitleAndExcerpt(newContent);
		const results = await searchByEmbedding(pp, `${title}\n\n${excerpt.slice(0, 500)}`, embCfg, topK + 1);
		const candidates = [];
		for (const r of results) {
			if (r.id === newPageId) continue;
			if (r.score < VECTOR_MIN_SIMILARITY) continue;
			const dirs = [
				"concepts",
				"entities",
				"queries"
			];
			let pagePath = "";
			for (const dir of dirs) {
				const candidate = `${pp}/wiki/${dir}/${r.id}.md`;
				if (isSamePagePath(candidate, expectedNewPagePath)) {
					pagePath = candidate;
					break;
				}
				try {
					const content = await readFile(candidate);
					if (isSourceTypedContent(content)) break;
					const { title: existingTitle, excerpt: existingExcerpt } = extractTitleAndExcerpt(content);
					candidates.push({
						pageId: r.id,
						pagePath: candidate,
						title: existingTitle,
						score: r.score,
						excerpt: existingExcerpt,
						matchMethod: r.score >= VECTOR_HIGH_SIMILARITY ? "vector" : "vector"
					});
					pagePath = candidate;
					break;
				} catch {}
			}
			if (!pagePath) {
				const candidate = `${pp}/wiki/${r.id}.md`;
				if (isSamePagePath(candidate, expectedNewPagePath)) continue;
				try {
					const content = await readFile(candidate);
					if (!isSourceTypedContent(content)) {
						const { title: existingTitle, excerpt: existingExcerpt } = extractTitleAndExcerpt(content);
						candidates.push({
							pageId: r.id,
							pagePath: candidate,
							title: existingTitle,
							score: r.score,
							excerpt: existingExcerpt,
							matchMethod: "vector"
						});
					}
				} catch {}
			}
			if (candidates.length >= topK) break;
		}
		return candidates.sort((a, b) => b.score - a.score);
	} catch (err) {
		console.warn("[conflict-detector] Vector search failed:", err);
		return [];
	}
}
/**
* Extract meaningful keywords from a title.
* - Strips year-like numbers (2020-2029)
* - Strips common noise chars
* - Splits by CJK character boundaries and Latin words
* - Returns unique tokens of length ≥ 2
*/
function extractKeywords(title) {
	const normalized = title.toLowerCase().replace(/20\d{2}/g, "").replace(/[（）()【】\[\]「」\s_\-·]/g, " ").trim();
	const tokens = [];
	const latinWords = normalized.match(/[a-z0-9]{2,}/g) ?? [];
	tokens.push(...latinWords);
	const cjk = normalized.replace(/[a-z0-9\s]/g, "");
	for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
	for (const ch of cjk) if (ch.trim()) tokens.push(ch);
	return [...new Set(tokens.filter((t) => t.length >= 1))];
}
/** Jaccard-like keyword overlap score 0-1 */
function keywordSimilarity(a, b) {
	if (a.length === 0 || b.length === 0) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const kw of setA) if (setB.has(kw)) intersection++;
	const union = new Set([...setA, ...setB]).size;
	return intersection / union;
}
/**
* Find pages with a similar title using file system scan.
* Used as fallback when embedding is not configured.
*
* Matching strategy (in priority order):
*   1. Exact title match               → score 0.95
*   2. One title contains the other    → score 0.75
*   3. Keyword overlap ≥ 0.30          → score 0.65
*
* @param projectPath  Absolute project root path
* @param newTitle     Title of the new page
* @param newPagePath  Absolute path of the new page (excluded)
*/
async function findSimilarByTitle(projectPath, newTitle, newPagePath) {
	try {
		const { listDirectory } = await import("./fs-WYeR_9ZT.js").then((n) => n.t);
		const { normalizePath } = await import("./path-utils-BHuw7z0q.js");
		const pp = normalizePath(projectPath);
		if (isSourcePagePath(newPagePath) || isSkippedPath(newPagePath)) return [];
		function flatten(nodes) {
			const result = [];
			for (const n of nodes) if (n.is_dir && n.children) result.push(...flatten(n.children));
			else if (!n.is_dir && n.name?.endsWith(".md")) result.push(n.path);
			return result;
		}
		const allPaths = flatten(await listDirectory(`${pp}/wiki`));
		const candidates = [];
		const needle = newTitle.toLowerCase().replace(/\s+/g, "");
		const needleKeywords = extractKeywords(newTitle);
		const SKIP = new Set([
			"index.md",
			"log.md",
			"overview.md"
		]);
		for (const filePath of allPaths) {
			const base = filePath.split(/[/\\]/).pop() ?? "";
			if (SKIP.has(base)) continue;
			if (isSamePagePath(filePath, newPagePath)) continue;
			if (isSourcePagePath(filePath)) continue;
			if (isSkippedPath(filePath)) continue;
			try {
				const content = await readFile(filePath);
				if (isSourceTypedContent(content)) continue;
				const { title, excerpt } = extractTitleAndExcerpt(content);
				const titleNorm = title.toLowerCase().replace(/\s+/g, "");
				let score = 0;
				let method = "title_fuzzy";
				if (titleNorm === needle) {
					score = .95;
					method = "title_exact";
				} else if (titleNorm.includes(needle) || needle.includes(titleNorm)) score = .75;
				else {
					const kwScore = keywordSimilarity(needleKeywords, extractKeywords(title));
					if (kwScore >= .3) score = .55 + kwScore * .3;
				}
				if (score > 0) candidates.push({
					pageId: base.replace(/\.md$/, ""),
					pagePath: filePath,
					title,
					score,
					excerpt,
					matchMethod: method
				});
			} catch {}
		}
		return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
	} catch (err) {
		console.warn("[conflict-detector] Title scan failed:", err);
		return [];
	}
}
/**
* Main entry point: find similar pages for a newly written wiki page.
* Tries vector search first; falls back to title scan.
*
* @returns Sorted list of conflict candidates (best match first)
*/
async function detectConflicts(projectPath, newPageId, newPagePath, newContent, embCfg) {
	if (isSourcePagePath(newPagePath) || isSkippedPath(newPagePath) || isSourceTypedContent(newContent)) return [];
	if (embCfg?.enabled && embCfg?.model) {
		const vectorResults = await findSimilarByVector(projectPath, newPageId, newContent, embCfg);
		if (vectorResults.length > 0) return vectorResults;
	}
	const { title } = extractTitleAndExcerpt(newContent);
	return findSimilarByTitle(projectPath, title, newPagePath);
}
//#endregion
//#region src/lib/knowledge-governance/judge-module.ts
function buildJudgePrompt(newTitle, newExcerpt, existingTitle, existingExcerpt) {
	return `You are a knowledge governance assistant. Your task is to compare two wiki pages and classify their relationship.

## New Page
Title: ${newTitle}
Content preview:
${newExcerpt.slice(0, 600)}

## Existing Page
Title: ${existingTitle}
Content preview:
${existingExcerpt.slice(0, 600)}

## Task
Classify the relationship of the NEW page relative to the EXISTING page.

Choose exactly one relation:
- "same"       — The new page is a duplicate or near-duplicate of the existing page. They cover the same concept with no meaningful new information.
- "update"     — The new page updates, refines, or extends the existing page with more recent or more accurate information.
- "conflict"   — The new page contains information that directly contradicts the existing page.
- "complement" — The new page covers the same general topic but adds genuinely different detail that does not conflict.
- "unrelated"  — The pages are about different topics. The similarity was coincidental.
- "uncertain"  — You cannot determine the relationship with confidence.

Also provide:
- confidence: "high" | "medium" | "low"
- reason: a concise 1-2 sentence explanation in Chinese for the wiki editor

Respond ONLY with valid JSON, no markdown fences:
{"relation":"...","confidence":"...","reason":"..."}`.trim();
}
var VALID_RELATIONS = new Set([
	"same",
	"update",
	"conflict",
	"complement",
	"unrelated",
	"uncertain"
]);
var VALID_CONFIDENCES = new Set([
	"high",
	"medium",
	"low"
]);
function parseJudgeResponse(raw) {
	try {
		const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		return JSON.parse(clean);
	} catch {
		const match = raw.match(/\{[\s\S]*\}/);
		if (match) try {
			return JSON.parse(match[0]);
		} catch {}
		return null;
	}
}
/**
* Ask the LLM to judge the relationship between two pages.
*
* @param llmConfig   LLM config from wiki-store (endpoint, model, apiKey)
* @param newTitle    Title of the newly ingested page
* @param newExcerpt  Content preview of the new page
* @param existingTitle   Title of the existing page
* @param existingExcerpt Content preview of the existing page
* @returns JudgementResult, or null if the LLM call fails
*/
async function judgeRelationship(llmConfig, newTitle, newExcerpt, existingTitle, existingExcerpt) {
	if (!hasUsableLlmConfig(llmConfig)) {
		console.warn("[judge-module] LLM not configured — skipping judgement");
		return null;
	}
	const responseText = await callLLM(llmConfig, [{
		role: "user",
		content: buildJudgePrompt(newTitle, newExcerpt, existingTitle, existingExcerpt)
	}], 256);
	if (!responseText) {
		console.warn("[judge-module] LLM returned empty response");
		return null;
	}
	const parsed = parseJudgeResponse(responseText);
	if (!parsed) {
		console.warn("[judge-module] Could not parse LLM response:", responseText.slice(0, 200));
		return null;
	}
	return {
		relation: VALID_RELATIONS.has(parsed.relation) ? parsed.relation : "uncertain",
		confidence: VALID_CONFIDENCES.has(parsed.confidence) ? parsed.confidence : "low",
		reason: parsed.reason ?? "无法获取分析理由。",
		judgedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/lib/knowledge-governance/policy-engine.ts
/**
* Evaluate the policy for a given judgement result and context.
* Always-conservative: when in doubt, routes to Review.
*/
function evaluatePolicy(judgement, context) {
	if (!judgement) return "review";
	const { relation, confidence } = judgement;
	const { similarityScore } = context;
	if (relation === "unrelated") return similarityScore >= .9 ? "notify" : "auto_accept";
	if (relation === "complement" && confidence === "high") return "notify";
	if (relation === "same" && confidence === "high") return "notify";
	if (relation === "conflict") return "review";
	if (relation === "update" && (confidence === "high" || confidence === "medium")) return "notify";
	return "review";
}
/**
* Build a lightweight description for the Review Queue item based on
* the policy decision and judgement.
*/
function buildPolicyDescription(judgement, decision, newTitle, existingTitle) {
	if (!judgement) return `「${newTitle}」与「${existingTitle}」存在相似内容，无法自动判断关系，请人工确认。`;
	const RELATION_ZH = {
		same: "重复内容",
		update: "内容更新",
		conflict: "内容冲突",
		complement: "补充信息",
		unrelated: "无关联",
		uncertain: "关系待定"
	};
	const CONFIDENCE_ZH = {
		high: "高置信",
		medium: "中置信",
		low: "低置信"
	};
	const relLabel = RELATION_ZH[judgement.relation] ?? judgement.relation;
	const confLabel = CONFIDENCE_ZH[judgement.confidence] ?? judgement.confidence;
	if (decision === "auto_accept") return `AI 判断「${newTitle}」与「${existingTitle}」${relLabel}（${confLabel}），已自动确认。`;
	if (decision === "notify") return `AI 判断「${newTitle}」与「${existingTitle}」存在${relLabel}（${confLabel}）。`;
	return `AI 判断「${newTitle}」与「${existingTitle}」可能${relLabel}（${confLabel}），请确认处理方式。`;
}
//#endregion
//#region src/lib/knowledge-governance/orchestrator.ts
/**
* knowledge-governance/orchestrator.ts
*
* Wires together conflict-detector → judge-module → policy-engine
* into a single async pipeline called after each page is written.
*
* This is the ONLY file that imports multiple governance modules.
* External callers (ingest.ts) import only from index.ts.
*
* Pipeline (all steps run asynchronously, never blocking the ingest):
*   1. detectConflicts      — find similar existing pages
*   2. judgeRelationship    — ask LLM to classify the relationship
*   3. evaluatePolicy       — decide: auto_accept / notify / review
*   4. appendReviewItem     — persist to review-queue.json if needed
*   5. setPageStatus        — update frontmatter status if auto-resolved
*/
function generateId() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function lineageRelationForNotify(relation) {
	return relation === "update" ? "updates" : null;
}
function pageIdFromPath(pagePath, projectPath) {
	return pagePath.replace(projectPath, "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^wiki\//, "").replace(/\.md$/, "");
}
async function notifyUser(message) {
	try {
		const { useActivityStore } = await import("./activity-store-DbP1Cs9i.js");
		useActivityStore.getState().addItem({
			type: "ingest",
			status: "done",
			title: "知识治理",
			detail: message,
			filesWritten: []
		});
	} catch {
		console.info("[governance] notify:", message);
	}
}
/**
* Run the full governance pipeline for one newly written page.
* Should be called fire-and-forget (don't await in the hot path).
*
* @param projectPath  Absolute path to the project root
* @param newPagePath  Absolute path to the newly written .md file
* @param newContent   Full markdown content of the new page
* @param embCfg       EmbeddingConfig from wiki-store
* @param llmConfig    LLM config from wiki-store
*/
async function runGovernancePipeline(projectPath, newPagePath, newContent, embCfg, llmConfig) {
	const newPageId = pageIdFromPath(newPagePath, projectPath);
	let candidates;
	try {
		candidates = await detectConflicts(projectPath, newPageId, newPagePath, newContent, embCfg);
	} catch (err) {
		console.warn("[governance] Conflict detection failed:", err);
		await notifyUser(`[治理调试] 冲突检测异常: ${String(err).slice(0, 80)}`);
		return;
	}
	if (candidates.length === 0) {
		console.log(`[governance] No conflicts found for ${newPageId}`);
		await setPageStatus(newPagePath, "candidate").catch(() => {});
		await notifyUser(`[治理] ${newPageId.split("/").pop()} — 无相似页面，跳过`);
		return;
	}
	const topCandidate = candidates[0];
	console.log(`[governance] Conflict candidate for "${newPageId}": "${topCandidate.title}" (score=${topCandidate.score.toFixed(2)}, method=${topCandidate.matchMethod})`);
	await notifyUser(`[治理] 发现相似页面: 「${topCandidate.title}」 得分=${topCandidate.score.toFixed(2)}`);
	const fmMatch = newContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/m);
	let newTitle = "Untitled";
	if (fmMatch) {
		const t = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
		if (t) newTitle = t[1].trim();
	}
	if (!newTitle || newTitle === "Untitled") {
		const h1 = newContent.match(/^#\s+(.+)$/m);
		if (h1) newTitle = h1[1].trim();
	}
	const newExcerpt = (fmMatch ? newContent.slice(fmMatch[0].length) : newContent).replace(/^#+\s+.+$/gm, "").replace(/\s+/g, " ").trim().slice(0, 600);
	let judgement = null;
	try {
		judgement = await judgeRelationship(llmConfig, newTitle, newExcerpt, topCandidate.title, topCandidate.excerpt);
	} catch (err) {
		console.warn("[governance] Judge module failed:", err);
		await notifyUser(`[治理调试] LLM 判断异常: ${String(err).slice(0, 80)}`);
	}
	await notifyUser(`[治理] LLM 判断: relation=${judgement?.relation ?? "null(LLM失败)"} confidence=${judgement?.confidence ?? "-"}`);
	const decision = evaluatePolicy(judgement, { similarityScore: topCandidate.score });
	const description = buildPolicyDescription(judgement, decision, newTitle, topCandidate.title);
	console.log(`[governance] Policy decision for "${newPageId}": ${decision} (relation=${judgement?.relation ?? "none"}, confidence=${judgement?.confidence ?? "none"})`);
	if (decision === "auto_accept") {
		await setPageStatus(newPagePath, "candidate").catch(() => {});
		return;
	}
	if (decision === "notify") {
		await setPageStatus(newPagePath, "candidate").catch(() => {});
		await notifyUser(description);
		const lineageRelation = lineageRelationForNotify(judgement?.relation);
		if (lineageRelation) try {
			const { recordTransition } = await import("./lineage-tracker-CX_M8jyO.js").then((n) => n.n);
			const { generateSemanticDiff } = await import("./diff-engine-CS--ANVl.js").then((n) => n.t);
			const { readFile } = await import("./fs-WYeR_9ZT.js").then((n) => n.t);
			const [oldContent, _newContent] = await Promise.all([readFile(topCandidate.pagePath).catch(() => ""), Promise.resolve(newContent)]);
			const diffResult = await generateSemanticDiff(llmConfig, topCandidate.title, oldContent, newTitle, newContent).catch(() => null);
			await recordTransition(projectPath, topCandidate.pagePath, topCandidate.title, newPagePath, newTitle, diffResult ?? {
				addedPoints: [],
				removedPoints: [],
				changedPoints: [],
				summary: description
			}, lineageRelation, "auto_notify");
		} catch {}
		return;
	}
	const reviewItem = {
		id: generateId(),
		projectPath,
		newPagePath,
		newPageTitle: newTitle,
		newPageExcerpt: newExcerpt.slice(0, 400),
		existingPagePath: topCandidate.pagePath,
		existingPageTitle: topCandidate.title,
		existingPageExcerpt: topCandidate.excerpt.slice(0, 400),
		judgement: judgement ?? void 0,
		policyDecision: decision,
		status: "pending",
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		await appendReviewItem(projectPath, reviewItem);
		try {
			const { useGovernanceStore } = await import("./governance-store-IwUk1z0M.js");
			const store = useGovernanceStore.getState();
			if (store.items.length > 0 || store.pendingCount > 0) await store.addItem(projectPath, reviewItem);
		} catch {}
		await notifyUser(`发现可能的知识冲突：「${newTitle}」与「${topCandidate.title}」，已加入审核队列。`);
	} catch (err) {
		console.warn("[governance] Failed to append review item:", err);
	}
}
//#endregion
export { resolveReviewItem as a, loadReviewQueue as i, dismissReviewItem as n, filterPendingItems as r, runGovernancePipeline, stampCandidate, appendReviewItem as t };
