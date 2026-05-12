/*!
 * Web search proxy handler.
 *
 * Routes search requests (Tavily / Perplexity) through the Rust backend
 * so the browser never calls external APIs directly. This solves two problems:
 *   1. CORS — external APIs may not whitelist the Wiki's origin.
 *   2. Intranet deployments — servers inside a firewalled network cannot
 *      reach the public internet from the client browser, but the server
 *      can (through a proxy / NAT gateway).
 *
 * API:
 *   POST /api/search/web
 *   Body: { "provider": "tavily"|"perplexity", "api_key": "...", "query": "...", "max_results": 10 }
 *   Response: [{ "title", "url", "snippet", "source" }]
 */

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SearchRequest {
    pub provider: String,
    pub api_key: String,
    pub query: String,
    pub max_results: Option<usize>,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

pub async fn web_search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SearchRequest>,
) -> axum::response::Result<Json<Value>, axum::http::StatusCode> {
    let max = body.max_results.unwrap_or(10);

    let results = match body.provider.as_str() {
        "tavily" => tavily_search(&state, &body.query, &body.api_key, max).await,
        "perplexity" => perplexity_search(&state, &body.query, &body.api_key, max).await,
        other => {
            tracing::warn!("Unknown search provider: {other}");
            return Err(axum::http::StatusCode::BAD_REQUEST);
        }
    };

    match results {
        Ok(v) => Ok(Json(json!(v))),
        Err(e) => {
            tracing::warn!("Web search failed ({}): {e}", body.provider);
            // Return a JSON error body with 502 so the frontend can surface it
            Err(axum::http::StatusCode::BAD_GATEWAY)
        }
    }
}

async fn tavily_search(
    state: &AppState,
    query: &str,
    api_key: &str,
    max_results: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    let body = json!({
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": "advanced",
        "include_answer": false,
    });

    let resp = state
        .http_client
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Tavily request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Tavily HTTP {status}: {text}"));
    }

    let data: Value = resp.json().await
        .map_err(|e| anyhow::anyhow!("Tavily response parse error: {e}"))?;

    let results = data["results"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            let url = r["url"].as_str().unwrap_or("").to_string();
            let source = url_hostname(&url);
            SearchResult {
                title: r["title"].as_str().unwrap_or("Untitled").to_string(),
                url,
                snippet: r["content"].as_str().unwrap_or("").to_string(),
                source,
            }
        })
        .collect();

    Ok(results)
}

async fn perplexity_search(
    state: &AppState,
    query: &str,
    api_key: &str,
    max_results: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    let body = json!({
        "model": "sonar",
        "messages": [
            {
                "role": "system",
                "content": "You are a search assistant. Answer concisely with facts. Include source URLs when available."
            },
            { "role": "user", "content": query }
        ],
        "max_tokens": 1024,
        "return_citations": true,
        "return_images": false,
        "search_recency_filter": "month",
    });

    let resp = state
        .http_client
        .post("https://api.perplexity.ai/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Perplexity request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Perplexity HTTP {status}: {text}"));
    }

    let data: Value = resp.json().await
        .map_err(|e| anyhow::anyhow!("Perplexity response parse error: {e}"))?;

    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let citations: Vec<String> = data["citations"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let mut results = Vec::new();
    if !content.is_empty() {
        results.push(SearchResult {
            title: format!("Perplexity: {}", &query[..query.len().min(60)]),
            url: citations.first().cloned().unwrap_or_else(|| "https://www.perplexity.ai".to_string()),
            snippet: content[..content.len().min(800)].to_string(),
            source: "perplexity.ai".to_string(),
        });
    }
    for url in citations.into_iter().skip(1).take(max_results - 1) {
        let source = url_hostname(&url);
        results.push(SearchResult {
            title: format!("Source"),
            url,
            snippet: String::new(),
            source,
        });
    }

    Ok(results)
}

fn url_hostname(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .trim_start_matches("www.")
        .to_string()
}
