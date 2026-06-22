import { readFile, writeFile } from "@/commands/fs"
import { getLogger } from "@/lib/logger"

const log = getLogger("queue")

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { checkIngestCache } from "@/lib/ingest-cache"

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  /** Stable project UUID (see project-identity.ts). Prefer this to
   *  `projectPath` because the filesystem location can change — tasks
   *  look up the current path via the registry at run time. */
  projectId: string
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  startedAt?: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
/** Number of ingest tasks currently running in parallel. */
let activeCount = 0
/** Maximum number of files to ingest in parallel. Increase for faster
 *  throughput; decrease if the LLM provider throttles you. */
const MAX_PARALLEL = 6
/** UUID of the currently-active project. */
let currentProjectId = ""
let currentProjectPath = ""
/** Per-task abort controllers, keyed by task ID. */
let abortControllers = new Map<string, AbortController>()
/** Files written per task (for rollback on cancel/failure). */
let writtenFilesByTask = new Map<string, string[]>()
let processedSinceDrain = false
let sweepAbortController: AbortController | null = null
/** Accumulates all entity titles written in this drain cycle for the deferred relation pass. */
let sessionEntityTitles = new Set<string>()
const PROCESSING_STALE_MS = 10 * 60 * 1000
/** Heartbeat timer ID — polls processNext every 15s to self-recover from any stuck state. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
/**
 * Tracks which source file paths are currently being processed.
 * For product catalog batches: multiple batch tasks share the same sourcePath.
 * We run them serially (one batch at a time per file) to prevent concurrent
 * writes to wiki/overview.md and wiki/index.md.
 * Different source files still run in parallel (up to MAX_PARALLEL).
 */
let activeSourcePaths = new Set<string>()

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    // Only save pending and failed tasks (done tasks are removed)
    const toSave = queue.filter((t) => t.status !== "done")
    await writeFile(queueFilePath(projectPath), JSON.stringify(toSave, null, 2))
  } catch {
    // non-critical
  }
}

async function loadQueue(projectPath: string, projectId: string): Promise<IngestTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const tasks = JSON.parse(raw) as IngestTask[]
    // Backfill projectId for tasks persisted before the field existed.
    // Files live inside a specific project, so every task in this file
    // belongs to `projectId` regardless of what's on disk.
    return tasks.map((t) => ({
      ...t,
      projectId: t.projectId ?? projectId,
    }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function sourceExtension(sourcePath: string): string {
  return sourcePath.split("?")[0]?.split(".").pop()?.toLowerCase() ?? ""
}

function sourceFileName(sourcePath: string): string {
  return sourcePath.replace(/\\/g, "/").split("/").pop() ?? sourcePath
}

async function readSourceContentForCache(sourceFullPath: string): Promise<string> {
  const ext = sourceExtension(sourceFullPath)
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif", "pdf"].includes(ext)) {
    const { readFileAsBase64 } = await import("@/commands/fs")
    const file = await readFileAsBase64(sourceFullPath)
    return file.base64
  }
  return await readFile(sourceFullPath)
}

async function taskAlreadyCompleted(projectPath: string, task: IngestTask): Promise<boolean> {
  const pp = normalizePath(projectPath)
  const fullSourcePath = isAbsolutePath(task.sourcePath)
    ? normalizePath(task.sourcePath)
    : `${pp}/${task.sourcePath}`
  try {
    const sourceContent = await readSourceContentForCache(fullSourcePath)
    const cached = await checkIngestCache(pp, sourceFileName(task.sourcePath), sourceContent)
    if (cached !== null) return true
  } catch {
    return false
  }

  return false
}

function ingestPriority(sourcePath: string): number {
  const ext = sourceExtension(sourcePath)
  if (["md", "mdx", "txt", "csv", "json", "yaml", "yml"].includes(ext)) return 0
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return 1
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "html", "htm", "rtf", "epub"].includes(ext)) return 2
  if (ext === "pdf") return 3
  return 2
}

function orderTasksForProcessing<T extends { sourcePath: string; addedAt?: number }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const priority = ingestPriority(a.sourcePath) - ingestPriority(b.sourcePath)
    if (priority !== 0) return priority
    return (a.addedAt ?? 0) - (b.addedAt ?? 0)
  })
}

/**
 * Delete files written by a cancelled / failed ingest, AND drop the
 * matching pages' chunks from LanceDB. Called from the cancel paths
 * (cancelTask, cancelAllTasks).
 *
 * Per-file errors are swallowed (best-effort cleanup) — a missing
 * file or LanceDB unavailable shouldn't abort the cancel flow.
 * Structural pages (index/log/overview) aren't embedded, so the
 * cascade no-ops for them.
 */
export async function cleanupWrittenFiles(
  projectPath: string,
  filePaths: string[],
): Promise<void> {
  const { cascadeDeleteWikiPage } = await import("@/lib/wiki-page-delete")
  for (const filePath of filePaths) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${projectPath}/${filePath}`
    try {
      await cascadeDeleteWikiPage(projectPath, fullPath)
    } catch {
      // file may not exist / lancedb unavailable — non-critical
    }
  }
}

/**
 * Add a file to the ingest queue. The project MUST be the currently-
 * active project — switching first is a prerequisite. Returns the new
 * task's id.
 */
export async function enqueueIngest(
  projectId: string,
  sourcePath: string,
  folderContext: string = "",
): Promise<string> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueIngest: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const task: IngestTask = {
    id: generateId(),
    projectId,
    sourcePath,
    folderContext,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }

  queue.push(task)
  await saveQueue(currentProjectPath)

  processNext(currentProjectId)

  return task.id
}

/**
 * Add multiple files to the queue at once. Same active-project
 * requirement as enqueueIngest.
 */
export async function enqueueBatch(
  projectId: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueBatch: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const ids: string[] = []
  for (const file of orderTasksForProcessing(files)) {
    const task: IngestTask = {
      id: generateId(),
      projectId,
      sourcePath: file.sourcePath,
      folderContext: file.folderContext,
      status: "pending",
      addedAt: Date.now(),
      error: null,
      retryCount: 0,
    }
    queue.push(task)
    ids.push(task.id)
  }

  await saveQueue(currentProjectPath)
  log.info("enqueued", { count: files.length, project: projectId })
  processNext(currentProjectId)

  return ids
}

/**
 * Retry a failed task. Only valid for tasks in the active project's
 * queue.
 */
export async function retryTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  task.status = "pending"
  task.startedAt = undefined
  task.error = null
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  if (task.status === "processing") {
    // Abort the in-progress LLM call for this specific task
    const ctrl = abortControllers.get(taskId)
    if (ctrl) {
      ctrl.abort()
      abortControllers.delete(taskId)
    }
    // Clean up files written by this task
    const taskFiles = writtenFilesByTask.get(taskId) ?? []
    writtenFilesByTask.delete(taskId)
    if (taskFiles.length > 0) {
      await cleanupWrittenFiles(currentProjectPath, taskFiles)
      log.info("cancel: cleaned up written files", { file: task.sourcePath, files: taskFiles.length })
    }
    activeCount = Math.max(0, activeCount - 1)
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(currentProjectPath)
  log.info("cancelled", { file: task.sourcePath })

  processNext(currentProjectId)
}

/**
 * Clear all done/failed tasks from the active project's queue.
 */
export async function clearCompletedTasks(): Promise<void> {
  queue = queue.filter((t) => t.status === "pending" || t.status === "processing")
  await saveQueue(currentProjectPath)
}

/**
 * Cancel everything that's not finished in the active project's queue:
 * aborts the running task (if any), cleans up its partial output, and
 * drops every pending + processing item.
 *
 * Failed tasks are retained so the user can still see / retry them.
 * Returns the number of tasks removed from the queue.
 */
export async function cancelAllTasks(): Promise<number> {
  // Abort all running tasks
  for (const [, ctrl] of abortControllers) {
    ctrl.abort()
  }
  abortControllers.clear()
  activeCount = 0

  // Cleanup all written files from running tasks
  for (const [, files] of writtenFilesByTask) {
    if (files.length > 0) {
      await cleanupWrittenFiles(currentProjectPath, files)
    }
  }
  writtenFilesByTask.clear()

  const before = queue.length
  queue = queue.filter((t) => t.status === "failed")
  const removed = before - queue.length

  await saveQueue(currentProjectPath)
  log.info("cancel-all", { removed })
  return removed
}

/**
 * Get current queue state.
 */
export function getQueue(): readonly IngestTask[] {
  return queue
}

/**
 * Get queue summary.
 */
export function getQueueSummary(): { pending: number; processing: number; failed: number; total: number } {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: queue.filter((t) => t.status === "processing").length,
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
  }
}

/**
 * Clear all in-memory queue state without touching disk. Used by tests
 * that want a clean slate between cases. **Production code should use
 * `pauseQueue()` on project switch**, which flushes pending state to
 * disk before clearing memory.
 */
export function clearQueueState(): void {
  stopHeartbeat()
  for (const [, ctrl] of abortControllers) ctrl.abort()
  if (sweepAbortController) sweepAbortController.abort()
  queue = []
  activeCount = 0
  currentProjectId = ""
  currentProjectPath = ""
  abortControllers = new Map()
  writtenFilesByTask = new Map()
  activeSourcePaths = new Set()
  sweepAbortController = null
  processedSinceDrain = false
}

/**
 * Project-switch handshake. Flushes the active project's current queue
 * state to its disk file (so pending/failed tasks survive the switch),
 * reverts any processing task to pending, then clears in-memory state
 * so the next `restoreQueue()` can safely load a different project.
 *
 * Must be called before opening or switching to a different project.
 * Must be `await`ed — the disk flush is async.
 */
export async function pauseQueue(): Promise<void> {
  if (!currentProjectId || !currentProjectPath) return

  stopHeartbeat()
  const pausedProjectPath = currentProjectPath

  // Abort all running tasks
  for (const [, ctrl] of abortControllers) ctrl.abort()
  abortControllers.clear()
  writtenFilesByTask.clear()
  activeSourcePaths.clear()
  activeCount = 0

  if (sweepAbortController) {
    sweepAbortController.abort()
    sweepAbortController = null
  }

  // Revert any in-flight processing tasks back to pending
  for (const task of queue) {
    if (task.status === "processing") {
      task.status = "pending"
      task.startedAt = undefined
    }
  }

  await saveQueue(pausedProjectPath)

  queue = []
  currentProjectId = ""
  currentProjectPath = ""
  processedSinceDrain = false
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk and resume processing. Called on app startup
 * and when opening / switching to a project. `pauseQueue()` must have
 * been called first (or the active project already cleared) so that
 * in-memory state is not contaminated from the previous project.
 */
/**
 * Synchronously register `projectId` as the active project so that
 * `enqueueBatch` / `enqueueIngest` can be called immediately, before
 * the async `restoreQueue` has finished reading the disk queue.
 * App.tsx calls this before the dynamic-import `.then()` that calls
 * restoreQueue, eliminating the timing window where uploads would fail
 * the `currentProjectId !== projectId` guard.
 */
export function activateProject(projectId: string, projectPath: string): void {
  currentProjectId = projectId
  currentProjectPath = normalizePath(projectPath)
  startHeartbeat()
}

/**
 * Poll processNext every 15 s so the queue self-recovers from any unexpected
 * stuck state (e.g. an unhandled rejection that prevents the normal cascade).
 */
function startHeartbeat(): void {
  if (heartbeatTimer !== null) return          // already running
  heartbeatTimer = setInterval(() => {
    if (!currentProjectId) return
    const hasPending = queue.some((t) => t.status === "pending")
    const hasProcessing = queue.some((t) => t.status === "processing")
    if (hasPending && activeCount === 0) {
      log.warn("heartbeat: queue stalled, restarting", { pending: queue.filter(t => t.status==="pending").length })
      processNext(currentProjectId)
    } else if (!hasPending && !hasProcessing) {
      // Nothing left — stop beating to avoid wasting resources
      stopHeartbeat()
    }
  }, 15_000)
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  // Defensive: reset in-memory state (should already be empty via
  // pauseQueue, but clearing again costs nothing).
  queue = []
  activeCount = 0
  abortControllers = new Map()
  writtenFilesByTask = new Map()
  currentProjectId = projectId
  currentProjectPath = pp

  const saved = await loadQueue(pp, projectId)

  if (saved.length === 0) return

  // Drop any cross-project contamination (shouldn't happen in practice
  // but defends against a corrupt queue file).
  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    log.warn("restore: dropped cross-project tasks", { dropped: saved.length - mine.length })
  }

  // Reset any "processing" tasks back to "pending" (interrupted by app close)
  let restored = 0
  for (const task of mine) {
    if (task.status === "processing") {
      task.status = "pending"
      task.startedAt = undefined
      restored++
    }
  }

  const resumable: IngestTask[] = []
  let completed = 0
  for (const task of mine) {
    if (await taskAlreadyCompleted(pp, task)) {
      completed++
      continue
    }
    resumable.push(task)
  }

  queue = orderTasksForProcessing(resumable)
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    log.info("restored", { pending, failed, restored, completed })
    processNext(projectId)
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

function retryDelayMs(message: string, retryCount: number): number {
  if (!/(503|Service Unavailable|service is too busy|rate limit|429)/i.test(message)) return 0
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, retryCount - 1))
}

function isPermanentIngestError(message: string): boolean {
  return /(未找到可复用 OCR 缓存|PDF has no extractable text|pdftoppm|poppler-utils|OCR_ENDPOINT)/i.test(message)
}

function startProcessingWatchdog(projectId: string, taskId: string, startedAt: number, projectPath: string): void {
  globalThis.setTimeout(() => {
    if (currentProjectId !== projectId || activeCount === 0) return
    const task = queue.find((t) => t.id === taskId)
    if (!task || task.status !== "processing" || task.startedAt !== startedAt) return

    const ageMs = Date.now() - startedAt
    if (ageMs < PROCESSING_STALE_MS) return

    // Abort via per-task controller map (replaces old single-controller pattern)
    const ctrl = abortControllers.get(taskId)
    if (ctrl) {
      ctrl.abort()
      abortControllers.delete(taskId)
    }

    task.status = "pending"
    task.startedAt = undefined
    task.error = `Processing timed out after ${Math.round(PROCESSING_STALE_MS / 60000)} minutes; requeued automatically`
    activeCount = Math.max(0, activeCount - 1)

    log.warn("watchdog: task timed out, requeued", { file: task.sourcePath, ageMs })
    saveQueue(projectPath)
      .catch(() => {})
      .finally(() => processNext(projectId))
  }, PROCESSING_STALE_MS + 1000)
}

async function onQueueDrained(projectId: string, projectPath: string): Promise<void> {
  if (activeCount > 0) return
  if (!processedSinceDrain) return
  if (currentProjectId !== projectId) return
  processedSinceDrain = false

  // ── Step 1: Concept aggregator (rule-based, no LLM) ─────────────────────
  // Runs FIRST so that entity related fields are populated immediately,
  // without waiting for the LLM relation pass. Groups service_item entities
  // by concept name and back-fills sibling titles into each entity's `related`.
  try {
    const { runConceptAggregator } = await import("@/lib/concept-aggregator")
    const caResult = await runConceptAggregator(projectPath)
    if (caResult.serviceConceptsCreated + caResult.serviceConceptsUpdated + caResult.productConceptsCreated + caResult.productConceptsUpdated + caResult.entitiesUpdated > 0) {
      log.info("drain: concept aggregator done", caResult)
    }
  } catch (err) {
    log.warn("drain: concept aggregator failed", { error: err instanceof Error ? err.message : String(err) })
  }

  // ── Step 2: Deferred LLM relation pass ───────────────────────────────────
  // Run once after all files are extracted, passing all entity titles written
  // during this drain cycle. Much more efficient than per-file passes.
  const titlesForPass = new Set(sessionEntityTitles)
  sessionEntityTitles = new Set()

  if (titlesForPass.size > 0) {
    const llmConfig = useWikiStore.getState().llmConfig
    const canLlm = !!(llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")
    if (canLlm) {
      log.info("drain: relation pass", { entities: titlesForPass.size })
      sweepAbortController = new AbortController()
      const signal = sweepAbortController.signal
      try {
        const { runGlobalRelationPass } = await import("@/lib/knowledge-global-relation")
        const grpResult = await runGlobalRelationPass(projectPath, llmConfig, signal, { newEntityTitles: titlesForPass })
        log.info("drain: relation pass done", { catalog: grpResult.catalogSize, pairs: grpResult.candidatePairs, written: grpResult.written })
      } catch (err) {
        log.warn("drain: relation pass failed", { error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (sweepAbortController?.signal === signal) sweepAbortController = null
      }
    }
  }

  sweepAbortController = new AbortController()
  const signal = sweepAbortController.signal

  try {
    const { sweepResolvedReviews } = await import("@/lib/sweep-reviews")
    await sweepResolvedReviews(projectPath, signal)
  } catch (err) {
    log.error("drain: sweep-reviews failed", { error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (sweepAbortController && sweepAbortController.signal === signal) {
      sweepAbortController = null
    }
  }
}

async function processNext(projectId: string): Promise<void> {
  // Guard: don't exceed parallel limit
  if (activeCount >= MAX_PARALLEL) return
  if (currentProjectId !== projectId) return

  const next = queue.find(
    (t) =>
      t.projectId === projectId &&
      t.status === "pending" &&
      // Per-sourcePath serialization: only one batch per source file runs at a time.
      // Different source files still run concurrently.
      !activeSourcePaths.has(t.sourcePath),
  )
  if (!next) {
    // Queue fully drained — trigger review cleanup when all tasks also finish
    if (activeCount === 0) {
      const pathAtDrain = currentProjectPath
      onQueueDrained(projectId, pathAtDrain).catch((err) =>
        log.error("drain: sweep failed", { error: err instanceof Error ? err.message : String(err) })
      )
    }
    return
  }

  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""

  if (currentProjectId !== projectId) return

  if (!pp) {
    next.status = "failed"
    next.error = "Project not found in registry (was it deleted?)"
    await saveQueue(currentProjectPath)
    processNext(projectId)
    return
  }

  // Mark task as processing and increment active count
  activeCount++
  activeSourcePaths.add(next.sourcePath)
  next.status = "processing"
  next.startedAt = Date.now()
  await saveQueue(pp)

  // Kick off another task immediately to fill remaining parallel slots
  processNext(projectId)

  const taskId = next.id
  const llmConfig = useWikiStore.getState().llmConfig

  if (!llmConfig.apiKey && llmConfig.provider !== "ollama" && llmConfig.provider !== "custom") {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    activeCount = Math.max(0, activeCount - 1)
    await saveQueue(pp)
    processNext(projectId)
    return
  }

  const fullSourcePath = isAbsolutePath(next.sourcePath)
    ? normalizePath(next.sourcePath)
    : `${pp}/${next.sourcePath}`

  log.info("start", { file: next.sourcePath, active: activeCount, max: MAX_PARALLEL, folder: next.folderContext || undefined })

  const abortController = new AbortController()
  abortControllers.set(taskId, abortController)
  writtenFilesByTask.set(taskId, [])

  // Start watchdog for this task
  startProcessingWatchdog(projectId, taskId, next.startedAt, pp)

  // Run the ingest task asynchronously (non-blocking — allows parallel tasks)
  ;(async () => {
    let delayBeforeNextMs = 0
    try {
      const { autoIngest } = await import("./ingest")
      const writtenFiles = await autoIngest(
        pp,
        fullSourcePath,
        llmConfig,
        abortController.signal,
        next.folderContext,
        { skipRelationPass: true },   // deferred to onQueueDrained
      )
      // Stale-context guard
      if (currentProjectId !== projectId) return
      writtenFilesByTask.set(taskId, writtenFiles)

      // Accumulate entity titles for the deferred batch relation pass
      for (const f of writtenFiles) {
        if (f.startsWith("wiki/entities/") || f.startsWith("wiki/concepts/")) {
          const stem = f.split("/").pop()?.replace(/\.md$/i, "")
          if (stem) sessionEntityTitles.add(stem)
        }
      }

      if (writtenFiles.length === 0) {
        throw new Error("Ingest produced no output files")
      }

      // Success
      abortControllers.delete(taskId)
      writtenFilesByTask.delete(taskId)
      activeSourcePaths.delete(next.sourcePath)
      queue = queue.filter((t) => t.id !== taskId)
      processedSinceDrain = true
      await saveQueue(pp)
      const durationMs = Date.now() - (next.startedAt ?? Date.now())
      log.info("done", { file: next.sourcePath, written: writtenFiles.length, durationMs, active: activeCount - 1 })
    } catch (err) {
      if (currentProjectId !== projectId) return
      abortControllers.delete(taskId)
      writtenFilesByTask.delete(taskId)
      activeSourcePaths.delete(next.sourcePath)
      const message = err instanceof Error ? err.message : String(err)
      next.retryCount++
      next.error = message
      if (isPermanentIngestError(message)) {
        next.retryCount = MAX_RETRIES
      }

      if (next.retryCount >= MAX_RETRIES) {
        next.status = "failed"
        next.startedAt = undefined
        log.error("failed", { file: next.sourcePath, error: message, retries: next.retryCount })
      } else {
        next.status = "pending"
        next.startedAt = undefined
        delayBeforeNextMs = retryDelayMs(message, next.retryCount)
        log.warn("retry", { file: next.sourcePath, error: message, retry: next.retryCount, max: MAX_RETRIES, delayMs: retryDelayMs(message, next.retryCount) })
      }

      await saveQueue(pp).catch((e) => log.warn("saveQueue failed in catch", { error: String(e) }))
    } finally {
      activeCount = Math.max(0, activeCount - 1)
      if (delayBeforeNextMs > 0) {
        log.debug("retry: waiting", { delayMs: delayBeforeNextMs })
        setTimeout(() => processNext(projectId), delayBeforeNextMs)
      } else {
        processNext(projectId)
      }
    }
  })()
}
