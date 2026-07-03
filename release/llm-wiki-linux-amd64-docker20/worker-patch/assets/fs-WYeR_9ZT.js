import { n as __exportAll } from "./react-yWv6PLLo.js";
//#region src/lib/fs-errors.ts
function isFileMissingErrorContent(content) {
	const text = String(content ?? "").trim();
	if (text.length > 3e3) return false;
	if (!/file does not exist|no such file|not found|os error 2/i.test(text)) return false;
	if (parseJsonError(text)) return true;
	if (/^\s*(Error:\s*){1,2}/i.test(text)) return true;
	return /^\s*(file does not exist|no such file|not found|os error 2)/i.test(text);
}
function extractFileMissingErrorMessage(value) {
	const normalized = normalizeErrorText(value);
	if (!/file does not exist|no such file|not found|os error 2/i.test(normalized)) return null;
	const parsed = parseJsonError(normalized);
	if (parsed) return parsed;
	return normalized.replace(/^\s*Error:\s*/i, "").replace(/^\s*Error:\s*/i, "").trim();
}
function normalizeErrorText(value) {
	return String(value ?? "").trim();
}
function parseJsonError(value) {
	const candidates = [value, value.replace(/^\s*Error:\s*/i, "").replace(/^\s*Error:\s*/i, "")];
	for (const candidate of candidates) try {
		const parsed = JSON.parse(candidate);
		const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
		if (message.trim()) return message.trim();
	} catch {}
	const objectStart = value.indexOf("{");
	if (objectStart <= 0) return null;
	return parseJsonError(value.slice(objectStart));
}
//#endregion
//#region src/commands/api-client.ts
/**
* HTTP API client — replaces @tauri-apps/api/core invoke().
*
* Every function mirrors the exact signature of the original Tauri
* invoke() calls so the rest of the codebase needs zero changes
* except replacing the import path.
*
* In web mode the Vite dev server proxies /api → FastAPI :8000.
* In production FastAPI serves both the API and the React build.
*/
var API_BASE = "/api";
var API_TIMEOUT_MS = 3e4;
async function readApiError(res) {
	const text = await res.text().catch(() => res.statusText);
	if (!text) return res.statusText || `HTTP ${res.status}`;
	try {
		const parsed = JSON.parse(text);
		const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
		if (message.trim()) return message.trim();
	} catch {}
	return text;
}
async function post(path, body, timeoutMs = API_TIMEOUT_MS) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!res.ok) throw new Error(await readApiError(res));
		const ct = res.headers.get("content-type") ?? "";
		if (res.status === 204 || !ct.includes("application/json")) return void 0;
		return res.json();
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") throw new Error(`请求超时（>${timeoutMs / 1e3}s）：${path}`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
async function readFile(path) {
	const content = await post("/fs/read", { path });
	if (typeof content === "string" && isFileMissingErrorContent(content)) throw new Error(extractFileMissingErrorMessage(content) ?? "File does not exist");
	return content;
}
async function writeFile(path, contents) {
	return post("/fs/write", {
		path,
		contents
	});
}
async function listDirectory(path) {
	return post("/fs/list", { path });
}
async function fileExists(path) {
	return post("/fs/exists", { path });
}
async function deleteFile(path) {
	return post("/fs/delete", { path });
}
async function createDirectory(path) {
	return post("/fs/mkdir", { path });
}
async function readFileAsBase64(path) {
	return post("/fs/read-base64", { path });
}
async function vectorUpsertChunks(projectPath, pagePath, pageTitle, chunks) {
	return post("/vector/upsert-chunks", {
		project_path: projectPath,
		page_path: pagePath,
		page_title: pageTitle,
		chunks
	});
}
async function vectorSearchChunks(projectPath, queryVector, limit = 10, filterExpr) {
	return post("/vector/search-chunks", {
		project_path: projectPath,
		query_vector: queryVector,
		limit,
		filter_expr: filterExpr
	});
}
//#endregion
//#region src/commands/fs.ts
var fs_exports = /* @__PURE__ */ __exportAll({
	createDirectory: () => createDirectory,
	listDirectory: () => listDirectory,
	readFile: () => readFile
});
//#endregion
export { listDirectory as a, vectorSearchChunks as c, fileExists as i, vectorUpsertChunks as l, createDirectory as n, readFile as o, deleteFile as r, readFileAsBase64 as s, fs_exports as t, writeFile as u };
