/**
 * @file use-log-viewer.ts
 * React hook that subscribes to the logger ring buffer.
 *
 * Usage:
 *   const { entries, clear } = useLogViewer({ level: "warn", namespace: "ingest" })
 */
import { useEffect, useState, useCallback } from "react"
import {
  getRingBuffer,
  subscribeRing,
  type RingEntry,
  type LogLevel,
} from "@/lib/logger"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

interface UseLogViewerOptions {
  /** Only show entries at or above this level (default: "info") */
  minLevel?: LogLevel
  /** Filter by namespace prefix, e.g. "ingest" matches "ingest:ocr" */
  namespace?: string
  /** Max entries to show in UI (default: 200) */
  maxEntries?: number
}

interface UseLogViewerReturn {
  entries: RingEntry[]
  clear: () => void
}

export function useLogViewer(opts: UseLogViewerOptions = {}): UseLogViewerReturn {
  const { minLevel = "info", namespace, maxEntries = 200 } = opts

  const filter = useCallback(
    (e: RingEntry) => {
      if (LEVEL_ORDER[e.level] < LEVEL_ORDER[minLevel]) return false
      if (namespace && !e.namespace.startsWith(namespace)) return false
      return true
    },
    [minLevel, namespace],
  )

  const [entries, setEntries] = useState<RingEntry[]>(() =>
    getRingBuffer().filter(filter).slice(0, maxEntries),
  )

  // Refresh from ring on any new write
  useEffect(() => {
    const refresh = () => {
      setEntries(getRingBuffer().filter(filter).slice(0, maxEntries))
    }
    return subscribeRing(refresh)
  }, [filter, maxEntries])

  const clear = useCallback(() => {
    // We can't clear the ring globally (other components may be watching),
    // so we just reset local view to empty and re-sync on next write.
    setEntries([])
  }, [])

  return { entries, clear }
}
