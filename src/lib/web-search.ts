import type { SearchApiConfig } from "@/stores/wiki-store"

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

/**
 * Execute a web search via the backend proxy (/api/search/web).
 *
 * Why proxy instead of direct browser fetch?
 *   1. CORS — Tavily / Perplexity may not whitelist the Wiki's origin.
 *   2. Intranet deployments — the client browser is behind a firewall that
 *      blocks public internet access, but the server has outbound routing.
 *
 * The Rust handler forwards the request server-side and returns the same
 * normalized [{ title, url, snippet, source }] array so no callers change.
 */
export async function webSearch(
  query: string,
  config: SearchApiConfig,
  maxResults: number = 10,
): Promise<WebSearchResult[]> {
  if (config.provider === "none" || !config.apiKey) {
    throw new Error("Web search not configured. Add a search API key in Settings.")
  }

  const res = await fetch("/api/search/web", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: config.provider,
      api_key: config.apiKey,
      query,
      max_results: maxResults,
    }),
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error")
    // Try to parse as JSON error message from the server
    try {
      const parsed = JSON.parse(errorText)
      throw new Error(parsed.error ?? parsed.message ?? errorText)
    } catch {
      throw new Error(`Search failed (HTTP ${res.status}): ${errorText}`)
    }
  }

  return res.json() as Promise<WebSearchResult[]>
}
