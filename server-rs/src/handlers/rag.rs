/*!
 * RAG retrieval handler
 *   POST /api/rag/retrieve   — semantic search, returns ranked chunks
 *   GET  /api/rag/status     — index health check (dim, count, needs_reindex)
 *
 * Moves the retrieval pipeline off the browser and into the Rust backend.
 * The browser was previously reading all wiki markdown files on every question,
 * which caused multi-minute delays for large projects (65MB+ of markdown).
 *
 * Phase 1 (this file): vector-only retrieval.
 *   1. Embed the query via the configured embedding endpoint.
 *   2. Search LanceDB for the top matching chunks.
 *   3. Return scored, ranked chunks to the frontend.
 *   Frontend only needs to assemble the LLM prompt from the returned chunks.
 *
 * Phase 2 (future): add BM25/FTS token retrieval + RRF fusion.
 * Phase 3 (future): add graph expansion via relation_edges.
 *
 * Design principles:
 *   - Zero business logic: no insurance schema awareness, no entity_type hardcoding.
 *   - All domain-specific filtering can be passed via request parameters.
 *   - Stateless: no caching here; LanceDB handles its own I/O efficiently.
 */

use axum::{extract::{State, Query}, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use lancedb::{connect, query::{ExecutableQuery, QueryBase}};
use arrow_array::{Float32Array, Int32Array, StringArray};
use futures::TryStreamExt;
use crate::{error::Result, state::AppState};

const TABLE: &str = "chunks";

// ── Request / response ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RetrieveRequest {
    /// Absolute path to the wiki project directory.
    pub project_path: String,
    /// Natural language query from the user.
    pub query: String,
    /// How many chunks to return. Default: 8.
    pub top_k: Option<usize>,
    /// Approximate token budget for the returned context (informational).
    /// The handler does NOT truncate — caller is responsible for fitting context.
    pub context_budget_tokens: Option<usize>,
    // Phase 2 params (ignored in Phase 1, accepted to avoid breaking callers):
    pub use_token: Option<bool>,
    pub use_graph: Option<bool>,
}

#[derive(Serialize)]
pub struct RetrievedChunk {
    pub page_path: String,
    pub page_title: String,
    pub chunk_index: i32,
    pub heading_path: String,
    pub chunk_text: String,
    pub distance: f64,
    pub score: f64,   // 1.0 - distance (cosine)
    pub source: String, // "vector" | "token" | "graph"
}

#[derive(Serialize)]
pub struct RetrieveResponse {
    pub chunks: Vec<RetrievedChunk>,
    pub retrieval_ms: u128,
    pub query_len: usize,
    pub top_k: usize,
    pub context_budget_tokens: Option<usize>,
}

// ── Embedding helper ──────────────────────────────────────────────────────────

/// Call the configured embedding endpoint and return the embedding vector.
/// Mirrors the frontend fetchEmbeddingViaProxy logic — both go through the
/// same AppState LlmServerConfig.
async fn embed_query(state: &AppState, query: &str) -> anyhow::Result<Vec<f32>> {
    let cfg = &state.llm_config;

    let endpoint = cfg.embedding_endpoint.as_deref()
        .ok_or_else(|| anyhow::anyhow!(
            "Embedding not configured. Set EMBEDDING_ENDPOINT env var."
        ))?
        .trim_end_matches('/')
        .to_string();

    let model = cfg.embedding_model.clone().unwrap_or_default();

    // DashScope multimodal format detection (same heuristic as llm.rs)
    let is_dashscope_multimodal = endpoint.contains("/multimodal-embedding/")
        || model.starts_with("tongyi-embedding-vision")
        || model == "qwen3-vl-embedding"
        || model == "qwen2.5-vl-embedding"
        || model == "multimodal-embedding-v1";

    let req_body = if is_dashscope_multimodal {
        json!({
            "model": model,
            "input": { "contents": [{ "text": query }] }
        })
    } else {
        json!({ "model": model, "input": query })
    };

    let mut req = state.http_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    if let Some(key) = cfg.embedding_api_key() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let resp = req.json(&req_body).send().await
        .map_err(|e| anyhow::anyhow!("Embedding request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Embedding HTTP {status}: {body}"));
    }

    let data: Value = resp.json().await
        .map_err(|e| anyhow::anyhow!("Failed to parse embedding response: {e}"))?;

    // Extract embedding from either DashScope or OpenAI format
    let embedding = if is_dashscope_multimodal {
        data.pointer("/output/embeddings/0/embedding")
            .ok_or_else(|| anyhow::anyhow!("DashScope response missing output.embeddings[0].embedding"))?
            .clone()
    } else {
        data.pointer("/data/0/embedding")
            .ok_or_else(|| anyhow::anyhow!("OpenAI response missing data[0].embedding"))?
            .clone()
    };

    let vec: Vec<f32> = serde_json::from_value(embedding)
        .map_err(|e| anyhow::anyhow!("Failed to deserialize embedding: {e}"))?;

    Ok(vec)
}

// ── Vector retrieval ──────────────────────────────────────────────────────────

async fn vector_retrieve(
    project_path: &str,
    query_vec: Vec<f32>,
    limit: usize,
) -> anyhow::Result<Vec<RetrievedChunk>> {
    let db_path = format!("{project_path}/.llm-wiki/lancedb");
    let db = match connect(&db_path).execute().await {
        Ok(d) => d,
        Err(_) => return Ok(vec![]),  // LanceDB not initialized yet
    };
    let tbl = match db.open_table(TABLE).execute().await {
        Ok(t) => t,
        Err(_) => return Ok(vec![]),  // Table doesn't exist yet
    };

    let batches: Vec<_> = tbl
        .vector_search(query_vec)?
        .limit(limit)
        .execute()
        .await?
        .try_collect()
        .await?;

    let mut chunks = Vec::new();

    for batch in &batches {
        let page_paths   = batch.column_by_name("page_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let page_titles  = batch.column_by_name("page_title")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let chunk_indices = batch.column_by_name("chunk_index")
            .and_then(|c| c.as_any().downcast_ref::<Int32Array>());
        let heading_paths = batch.column_by_name("heading_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let texts        = batch.column_by_name("chunk_text")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let distances    = batch.column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

        if let (Some(pp), Some(pt), Some(ci), Some(hp), Some(tx)) =
            (page_paths, page_titles, chunk_indices, heading_paths, texts)
        {
            for i in 0..batch.num_rows() {
                let distance = distances.map(|d| d.value(i) as f64).unwrap_or(0.0);
                chunks.push(RetrievedChunk {
                    page_path:    pp.value(i).to_string(),
                    page_title:   pt.value(i).to_string(),
                    chunk_index:  ci.value(i),
                    heading_path: hp.value(i).to_string(),
                    chunk_text:   tx.value(i).to_string(),
                    distance,
                    score: 1.0 - distance,
                    source: "vector".to_string(),
                });
            }
        }
    }

    Ok(chunks)
}

// ── Handler ───────────────────────────────────────────────────────────────────

pub async fn retrieve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RetrieveRequest>,
) -> Result<Json<Value>> {
    let t0 = std::time::Instant::now();
    let top_k = body.top_k.unwrap_or(8);

    // Step 1: Embed the query
    let query_vec = embed_query(&state, &body.query).await
        .map_err(|e| anyhow::anyhow!("Query embedding failed: {e}"))?;

    // Step 2: Vector retrieval (top_k × 3 to allow re-ranking)
    let mut chunks = vector_retrieve(&body.project_path, query_vec, top_k * 3).await
        .map_err(|e| anyhow::anyhow!("Vector retrieval failed: {e}"))?;

    // Step 3: Sort by score descending and take top_k
    chunks.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    chunks.truncate(top_k);

    let retrieval_ms = t0.elapsed().as_millis();
    tracing::info!(
        "[RAG] query_len={} top_k={} chunks={} retrieval_ms={}",
        body.query.len(), top_k, chunks.len(), retrieval_ms
    );

    let response = RetrieveResponse {
        query_len: body.query.len(),
        top_k,
        context_budget_tokens: body.context_budget_tokens,
        retrieval_ms,
        chunks,
    };

    Ok(Json(serde_json::to_value(response)?))
}

// ── Status handler ────────────────────────────────────────────────────────────

/// GET /api/rag/status?project_path=...
///
/// Returns the health of the vector index for a given project.
/// Frontend uses this to show a targeted error when chunks are empty,
/// instead of silently falling back to slow file scanning.
pub async fn status(
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let pp = match params.get("project_path") {
        Some(p) => p.as_str(),
        None => return Json(json!({ "error": "project_path required" })),
    };

    let meta_path = std::path::Path::new(pp).join(".llm-wiki/vector-meta.json");
    let meta: Option<serde_json::Value> = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let stored_dim = meta.as_ref().and_then(|m| m["dim"].as_i64()).unwrap_or(0);
    let stored_model = meta.as_ref()
        .and_then(|m| m["model"].as_str())
        .unwrap_or("")
        .to_string();

    // Count chunks in LanceDB
    let db_path = format!("{pp}/.llm-wiki/lancedb");
    let chunk_count: i64 = if let Ok(db) = connect(&db_path).execute().await {
        if let Ok(tbl) = db.open_table(TABLE).execute().await {
            tbl.count_rows(None).await.unwrap_or(0) as i64
        } else {
            -1  // table not found
        }
    } else {
        -1  // lancedb dir not found
    };

    let indexed = chunk_count > 0;
    let (needs_reindex, reason) = if chunk_count < 0 {
        (true, Some("LanceDB index not found — run Re-index All".to_string()))
    } else if chunk_count == 0 {
        (true, Some("Index is empty — run Re-index All".to_string()))
    } else if stored_dim == 0 {
        (true, Some("vector-meta.json missing — index may be corrupt".to_string()))
    } else {
        (false, None)
    };

    Json(json!({
        "indexed":         indexed,
        "chunk_count":     chunk_count.max(0),
        "dim":             stored_dim,
        "embedding_model": stored_model,
        "schema_version":  2,
        "needs_reindex":   needs_reindex,
        "reason":          reason,
    }))
}
