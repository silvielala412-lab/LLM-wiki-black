/**
 * Shared HTTP helpers — web version uses native fetch.
 * FastAPI backend handles CORS, so no plugin needed.
 * API is identical to the Tauri version so no callers change.
 */

let pluginFetchPromise: Promise<typeof globalThis.fetch> | null = null

const isNodeEnv = typeof window === "undefined"

export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  if (!pluginFetchPromise) {
    pluginFetchPromise = Promise.resolve(globalThis.fetch.bind(globalThis))
  }
  return pluginFetchPromise
}

/**
 * Detect fetch-level network failures across Tauri's different webview
 * backends. Each platform phrases the same failure class differently:
 *
 *   macOS / iOS (WebKit):       Error,  message === "Load failed"
 *   Windows    (Edge WebView2): TypeError, message === "Failed to fetch"
 *   Linux      (WebKitGTK):     Error,  message === "Load failed"
 *
 * They all collapse DNS / TLS / connection-refused / CORS-preflight
 * into a single opaque error with no structured detail. The only
 * reliable cross-platform signal is "not an AbortError AND one of
 * these generic network error shapes", which this helper centralizes.
 */
export function isFetchNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "AbortError") return false
  // Chromium / Edge WebView2
  if (err.name === "TypeError") return true
  // WebKit (macOS / Linux GTK)
  if (err.message === "Load failed") return true
  // Chromium mid-stream drop
  if (err.message === "Failed to fetch") return true
  if (err.message.includes("network error")) return true
  return false
}
