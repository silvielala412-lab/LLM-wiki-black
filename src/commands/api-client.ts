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

const API_BASE = "/api"

// ── Generic fetch helpers ─────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text)
  }
  // 204 No Content or empty body
  const ct = res.headers.get("content-type") ?? ""
  if (res.status === 204 || !ct.includes("application/json")) return undefined as T
  return res.json() as Promise<T>
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
  return res.json() as Promise<T>
}

// ── File System ───────────────────────────────────────────────────────────────

export async function readFile(path: string): Promise<string> {
  return post<string>("/fs/read", { path })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return post<void>("/fs/write", { path, contents })
}

export async function listDirectory(path: string): Promise<unknown[]> {
  return post<unknown[]>("/fs/list", { path })
}

export async function fileExists(path: string): Promise<boolean> {
  return post<boolean>("/fs/exists", { path })
}

export async function deleteFile(path: string): Promise<void> {
  return post<void>("/fs/delete", { path })
}

export async function createDirectory(path: string): Promise<void> {
  return post<void>("/fs/mkdir", { path })
}

export async function copyFile(source: string, destination: string): Promise<void> {
  return post<void>("/fs/copy", { source, destination })
}

export async function copyDirectory(source: string, destination: string): Promise<string[]> {
  return post<string[]>("/fs/copy-dir", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
  return post<string>("/fs/preprocess", { path })
}

export async function readFileAsBase64(path: string): Promise<{ base64: string; mimeType: string }> {
  return post<{ base64: string; mimeType: string }>("/fs/read-base64", { path })
}

export async function findRelatedWikiPages(
  projectPath: string,
  sourceName: string,
): Promise<string[]> {
  return post<string[]>("/fs/related-wiki-pages", { projectPath, sourceName })
}

export async function clipServerStatus(): Promise<string> {
  return get<string>("/fs/clip-server-status")
}

// ── Project ───────────────────────────────────────────────────────────────────

import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import type { WikiProject } from "@/types/wiki"

interface RawProject { name: string; path: string }

export async function listProjects(): Promise<{ name: string; path: string }[]> {
  return get<{ name: string; path: string }[]>("/project/list")
}

export async function createProjectAuto(name: string): Promise<WikiProject> {
  const raw = await post<RawProject>("/project/create-auto", { name })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function createProject(name: string, path: string): Promise<WikiProject> {
  const raw = await post<RawProject>("/project/create", { name, path })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProject(path: string): Promise<WikiProject> {
  const raw = await post<RawProject>("/project/open", { path })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

// ── Vector Store ──────────────────────────────────────────────────────────────

export async function vectorUpsertChunks(
  projectPath: string,
  pagePath: string,
  chunks: string[],
  vectors: number[][],
): Promise<number> {
  return post<number>("/vector/upsert-chunks", {
    project_path: projectPath,
    page_path: pagePath,
    chunks,
    vectors,
  })
}

export async function vectorSearchChunks(
  projectPath: string,
  queryVector: number[],
  limit = 10,
  filterExpr?: string,
): Promise<unknown[]> {
  return post<unknown[]>("/vector/search-chunks", {
    project_path: projectPath,
    query_vector: queryVector,
    limit,
    filter_expr: filterExpr,
  })
}

export async function vectorDeletePage(projectPath: string, pagePath: string): Promise<number> {
  return post<number>("/vector/delete-page", {
    project_path: projectPath,
    page_path: pagePath,
  })
}

export async function vectorCountChunks(projectPath: string): Promise<number> {
  return post<number>("/vector/count-chunks", { project_path: projectPath })
}

export async function vectorDropLegacy(projectPath: string): Promise<void> {
  return post<void>("/vector/drop-legacy", { project_path: projectPath })
}

// ── File Upload (new — replaces dialog.open) ──────────────────────────────────

export async function uploadFile(
  file: File,
  destinationDir: string,
): Promise<{ path: string; name: string; size: number }> {
  const fd = new FormData()
  fd.append("file", file)
  fd.append("destination_dir", destinationDir)
  const res = await fetch(`${API_BASE}/upload/file`, { method: "POST", body: fd })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function uploadFiles(
  files: File[],
  destinationDir: string,
): Promise<Array<{ path: string; name: string; size: number } | { error: string; name: string }>> {
  const fd = new FormData()
  for (const f of files) fd.append("files", f)
  fd.append("destination_dir", destinationDir)
  const res = await fetch(`${API_BASE}/upload/files`, { method: "POST", body: fd })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Media URL helper (replaces Tauri convertFileSrc) ─────────────────────────

export function convertFileSrc(path: string): string {
  return `${API_BASE}/fs/media?path=${encodeURIComponent(path)}`
}
