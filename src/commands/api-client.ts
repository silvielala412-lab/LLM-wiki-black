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

import { isFileMissingErrorContent, extractFileMissingErrorMessage } from "@/lib/fs-errors"
import type { FileNode } from "@/types/wiki"

const API_BASE = "/api"

// ── Generic fetch helpers ─────────────────────────────────────────────────────

const API_TIMEOUT_MS = 30_000   // 30 s — prevents indefinite hangs

async function readApiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText)
  if (!text) return res.statusText || `HTTP ${res.status}`
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    const message = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.message === "string"
        ? parsed.message
        : ""
    if (message.trim()) return message.trim()
  } catch {
    // Plain-text error body.
  }
  return text
}

async function post<T>(path: string, body: unknown, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(await readApiError(res))
    }
    // 204 No Content or empty body
    const ct = res.headers.get("content-type") ?? ""
    if (res.status === 204 || !ct.includes("application/json")) return undefined as T
    return res.json() as Promise<T>
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`请求超时（>${timeoutMs / 1000}s）：${path}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function get<T>(path: string, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal })
    if (!res.ok) throw new Error(await readApiError(res))
    return res.json() as Promise<T>
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`请求超时（>${timeoutMs / 1000}s）：${path}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ── File System ───────────────────────────────────────────────────────────────

export interface FileBase64 {
  base64: string
  mimeType: string
}

export async function readFile(path: string): Promise<string> {
  const content = await post<string>("/fs/read", { path })
  if (typeof content === "string" && isFileMissingErrorContent(content)) {
    throw new Error(extractFileMissingErrorMessage(content) ?? "File does not exist")
  }
  return content
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return post<void>("/fs/write", { path, contents })
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  return post<FileNode[]>("/fs/list", { path })
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

export async function readFileAsBase64(path: string): Promise<FileBase64> {
  return post<FileBase64>("/fs/read-base64", { path })
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

export interface VectorChunkInput {
  chunk_index: number
  heading_path: string
  chunk_text: string
  vector: number[]
}

export async function vectorUpsertChunks(
  projectPath: string,
  pagePath: string,
  pageTitle: string,
  chunks: VectorChunkInput[],
): Promise<number> {
  return post<number>("/vector/upsert-chunks", {
    project_path: projectPath,
    page_path: pagePath,
    page_title: pageTitle,
    chunks,
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

/** 5-minute upload timeout — large PDF files need time, but shouldn't hang forever */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000

export async function uploadFile(
  file: File,
  destinationDir: string,
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<{ path: string; name: string; size: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const fd = new FormData()
    fd.append("file", file)
    fd.append("destination_dir", destinationDir)
    const res = await fetch(`${API_BASE}/upload/file`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`上传超时（>${Math.round(timeoutMs / 60000)} 分钟）：${file.name}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function uploadFiles(
  files: File[],
  destinationDir: string,
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<Array<{ path: string; name: string; size: number } | { error: string; name: string }>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const fd = new FormData()
    for (const f of files) fd.append("files", f)
    // Also include in body as fallback for servers that read multipart fields
    fd.append("destination_dir", destinationDir)
    // Pass as query param so the backend always gets it before reading the body
    const url = `${API_BASE}/upload/files?dest=${encodeURIComponent(destinationDir)}`
    const res = await fetch(url, { method: "POST", body: fd, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      let msg = `HTTP ${res.status}: ${res.statusText}`
      if (text) {
        try {
          const json = JSON.parse(text)
          msg = json.error ?? json.message ?? text
        } catch {
          msg = text
        }
      }
      throw new Error(msg)
    }
    return res.json()
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`上传超时（>${Math.round(timeoutMs / 60000)} 分钟）：${files.length} 个文件，请检查服务器状态`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ── Product Catalog Batch Ingestion ──────────────────────────────────────────

export type ProductIngestBatchStatus =
  | "uploading"
  | "ready"
  | "queued"
  | "processing"
  | "completed"
  | "failed"

export interface ProductIngestBatchFile {
  file_id: string
  name: string
  relative_path: string
  stored_path: string
  size: number
  sha256: string
  document_type?: string
}

export interface ProductIngestBatch {
  batch_id: string
  client_batch_id?: string
  project_id: string
  project_name: string
  project_path: string
  product_name: string
  product_code?: string
  insurance_category: string
  duplicate_policy: "reject" | "merge"
  status: ProductIngestBatchStatus
  files: ProductIngestBatchFile[]
  written_files: string[]
  warnings: string[]
  manifest_path?: string
  error?: string
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
}

export interface CreateProductIngestBatchInput {
  project_name: string
  product_name: string
  insurance_category: string
  product_code?: string
  client_batch_id?: string
  duplicate_policy?: "reject" | "merge"
}

export async function createProductIngestBatch(
  input: CreateProductIngestBatchInput,
): Promise<ProductIngestBatch> {
  return post<ProductIngestBatch>("/ingest/product-batches", input)
}

export async function uploadProductIngestFile(
  batchId: string,
  file: File,
  relativePath?: string,
  documentType?: string,
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<{ batch: ProductIngestBatch; file: ProductIngestBatchFile }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const query = new URLSearchParams()
    if (relativePath) query.set("relative_path", relativePath)
    if (documentType) query.set("document_type", documentType)
    const fd = new FormData()
    fd.append("file", file)
    const suffix = query.size > 0 ? `?${query.toString()}` : ""
    const res = await fetch(`${API_BASE}/ingest/product-batches/${encodeURIComponent(batchId)}/files${suffix}`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(await readApiError(res))
    return res.json()
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`上传超时（>${Math.round(timeoutMs / 60000)} 分钟）：${file.name}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function startProductIngestBatch(batchId: string): Promise<ProductIngestBatch> {
  return post<ProductIngestBatch>(`/ingest/product-batches/${encodeURIComponent(batchId)}/start`, {})
}

export async function retryProductIngestBatch(batchId: string): Promise<ProductIngestBatch> {
  return post<ProductIngestBatch>(`/ingest/product-batches/${encodeURIComponent(batchId)}/retry`, {})
}

export async function getProductIngestBatch(batchId: string): Promise<ProductIngestBatch> {
  return get<ProductIngestBatch>(`/ingest/product-batches/${encodeURIComponent(batchId)}`)
}

export async function listProductIngestBatches(
  projectName: string,
  limit = 50,
): Promise<ProductIngestBatch[]> {
  const query = new URLSearchParams({ project_name: projectName, limit: String(limit) })
  return get<ProductIngestBatch[]>(`/ingest/product-batches?${query.toString()}`)
}

// ── Media URL helper (replaces Tauri convertFileSrc) ─────────────────────────

export function convertFileSrc(path: string): string {
  return `${API_BASE}/fs/media?path=${encodeURIComponent(path)}`
}
