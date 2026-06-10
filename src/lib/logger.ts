/**
 * @file logger.ts
 * Decoupled, zero-dependency logging module for LLM Wiki.
 *
 * Design principles:
 *  - This file has NO imports from app code (no React, no Zustand, no fs commands).
 *    Sinks that need those are registered from outside (see registerSink / initLogger).
 *  - Callers create a namespaced logger: const log = getLogger("ingest:ocr")
 *  - Global log level and per-namespace overrides are controllable at runtime.
 *  - Three built-in sink types: ConsoleSink, ActivitySink, FileSink — all optional.
 */

// ─── Log levels ──────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// ─── Log entry ───────────────────────────────────────────────────────────────

export interface LogEntry {
  /** ISO timestamp */
  timestamp: string
  /** e.g. "ingest", "ingest:ocr", "queue", "schema" */
  namespace: string
  level: LogLevel
  message: string
  /** Optional structured metadata (serialisable) */
  meta?: Record<string, unknown>
}

// ─── Sink interface ───────────────────────────────────────────────────────────

export interface LogSink {
  name: string
  /** Return false to skip this sink for this entry */
  filter?: (entry: LogEntry) => boolean
  write: (entry: LogEntry) => void
}

// ─── Built-in sink: console ───────────────────────────────────────────────────

export const consoleSink: LogSink = {
  name: "console",
  write(entry) {
    const prefix = `[${entry.namespace}]`
    const args = entry.meta ? [prefix, entry.message, entry.meta] : [prefix, entry.message]
    switch (entry.level) {
      case "debug": console.debug(...args); break
      case "info":  console.info(...args);  break
      case "warn":  console.warn(...args);  break
      case "error": console.error(...args); break
    }
  },
}

// ─── Built-in sink: in-memory ring buffer (for UI display) ───────────────────

const RING_MAX = 500

export interface RingEntry extends LogEntry {
  id: number
}

let _ringCounter = 0
const _ring: RingEntry[] = []
const _ringListeners = new Set<() => void>()

/** Returns a snapshot of the in-memory ring buffer (newest first). */
export function getRingBuffer(): readonly RingEntry[] {
  return _ring.slice().reverse()
}

/** Subscribe to ring buffer changes. Returns an unsubscribe function. */
export function subscribeRing(cb: () => void): () => void {
  _ringListeners.add(cb)
  return () => _ringListeners.delete(cb)
}

export const ringBufferSink: LogSink = {
  name: "ring",
  write(entry) {
    if (_ring.length >= RING_MAX) _ring.shift()
    _ring.push({ ...entry, id: ++_ringCounter })
    _ringListeners.forEach((cb) => cb())
  },
}

// ─── Built-in sink: file (async, via injected writer) ─────────────────────────
//
// The file writer is injected at runtime so this module stays import-free.
// In practice, App.tsx calls initLogger({ fileWriter: writeFile }).

type FileWriter = (path: string, content: string) => Promise<void>
type FileReader = (path: string) => Promise<string>

interface FileSinkOptions {
  /** Absolute path to the NDJSON log file, e.g. {project}/system-logs/ingest.ndjson */
  path: string
  writer: FileWriter
  reader: FileReader
  /** Max lines to keep in the file before rotation (default: 2000) */
  maxLines?: number
}

/** Creates a file sink that appends NDJSON log entries to a file. */
export function createFileSink(opts: FileSinkOptions): LogSink {
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const pending: string[] = []

  async function flush() {
    if (pending.length === 0) return
    const lines = pending.splice(0, pending.length)
    try {
      let existing = ""
      try { existing = await opts.reader(opts.path) } catch { /* first write */ }
      const allLines = (existing ? existing.split("\n").filter(Boolean) : [])
        .concat(lines)
      const max = opts.maxLines ?? 2000
      const kept = allLines.slice(-max)
      await opts.writer(opts.path, kept.join("\n") + "\n")
    } catch (e) {
      // Silently ignore file errors — logger must never throw
      console.warn("[logger:file] flush error", e)
    }
  }

  return {
    name: "file",
    write(entry) {
      pending.push(JSON.stringify({
        t: entry.timestamp,
        ns: entry.namespace,
        lv: entry.level,
        msg: entry.message,
        ...(entry.meta ? { meta: entry.meta } : {}),
      }))
      // Debounce: batch writes within 800 ms
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(flush, 800)
    },
  }
}

// ─── Core logger state ────────────────────────────────────────────────────────

let _globalLevel: LogLevel = "info"
const _namespaceOverrides = new Map<string, LogLevel>()
const _sinks: LogSink[] = [consoleSink, ringBufferSink]

/** Replace the global minimum log level. */
export function setGlobalLogLevel(level: LogLevel) {
  _globalLevel = level
}

/** Override log level for a specific namespace prefix (e.g. "ingest:ocr"). */
export function setNamespaceLogLevel(namespace: string, level: LogLevel) {
  _namespaceOverrides.set(namespace, level)
}

/** Register an additional sink. */
export function registerSink(sink: LogSink) {
  if (!_sinks.find((s) => s.name === sink.name)) {
    _sinks.push(sink)
  }
}

/** Remove a sink by name. */
export function removeSink(name: string) {
  const idx = _sinks.findIndex((s) => s.name === name)
  if (idx >= 0) _sinks.splice(idx, 1)
}

function effectiveLevel(namespace: string): LogLevel {
  // Exact match first, then prefix match (longest wins)
  if (_namespaceOverrides.has(namespace)) {
    return _namespaceOverrides.get(namespace)!
  }
  let best: LogLevel | undefined
  let bestLen = -1
  for (const [ns, lv] of _namespaceOverrides) {
    if (namespace.startsWith(ns) && ns.length > bestLen) {
      best = lv
      bestLen = ns.length
    }
  }
  return best ?? _globalLevel
}

function dispatch(entry: LogEntry) {
  const minOrder = LEVEL_ORDER[effectiveLevel(entry.namespace)]
  if (LEVEL_ORDER[entry.level] < minOrder) return
  for (const sink of _sinks) {
    if (sink.filter && !sink.filter(entry)) continue
    try {
      sink.write(entry)
    } catch {
      // Never let a sink crash the caller
    }
  }
}

// ─── Logger factory ───────────────────────────────────────────────────────────

export interface Logger {
  readonly namespace: string
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  /** Create a child logger with a sub-namespace: log.child("ocr") → "ingest:ocr" */
  child(sub: string): Logger
}

function makeLogger(namespace: string): Logger {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    dispatch({
      timestamp: new Date().toISOString(),
      namespace,
      level,
      message,
      meta,
    })
  }

  return {
    namespace,
    debug: (msg, meta) => log("debug", msg, meta),
    info:  (msg, meta) => log("info",  msg, meta),
    warn:  (msg, meta) => log("warn",  msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    child: (sub) => makeLogger(`${namespace}:${sub}`),
  }
}

const _loggers = new Map<string, Logger>()

/**
 * Get (or create) a namespaced logger.
 * @example
 *   const log = getLogger("ingest:ocr")
 *   log.info("OCR complete", { pages: 12, chars: 4500 })
 */
export function getLogger(namespace: string): Logger {
  if (!_loggers.has(namespace)) {
    _loggers.set(namespace, makeLogger(namespace))
  }
  return _loggers.get(namespace)!
}

// ─── One-shot initialisation helper ──────────────────────────────────────────

export interface LoggerInitOptions {
  /** Minimum global log level (default: "info") */
  level?: LogLevel
  /** Injected file I/O — when provided, a FileSink is registered automatically */
  fileWriter?: FileWriter
  fileReader?: FileReader
  /** Path for the NDJSON log file */
  logFilePath?: string
  /** Additional sinks to register on startup */
  extraSinks?: LogSink[]
}

/**
 * Call once from App.tsx (or equivalent) after the project is known.
 * Safe to call multiple times — re-registration is idempotent.
 */
export function initLogger(opts: LoggerInitOptions) {
  if (opts.level) setGlobalLogLevel(opts.level)

  if (opts.fileWriter && opts.fileReader && opts.logFilePath) {
    removeSink("file")
    registerSink(createFileSink({
      path: opts.logFilePath,
      writer: opts.fileWriter,
      reader: opts.fileReader,
    }))
  }

  for (const sink of opts.extraSinks ?? []) {
    registerSink(sink)
  }
}
