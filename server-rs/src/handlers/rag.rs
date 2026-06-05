// RAG retrieval handler.
//
// POST /api/rag/retrieve returns ranked chunks for callers that need retrieval
// only. POST /api/chat/stream calls the same retrieval function before it
// assembles the ChatPanel-equivalent prompt and streams the LLM answer.
//
// The default retrieval path is hybrid:
//   1. vector search over LanceDB chunks;
//   2. token / BM25-like search over a project-level in-memory chunk cache;
//   3. exact title / path / heading / phrase boosts;
//   4. reciprocal-rank fusion at chunk level.
//
// Important: token search does not read every wiki markdown file on every
// question. It lazily loads the already-indexed LanceDB chunk text columns into
// memory and invalidates that cache when the vector metadata or row count
// changes.

use arrow_array::{Float32Array, Int32Array, StringArray};
use axum::{
    extract::{Query, State},
    Json,
};
use futures::TryStreamExt;
use lancedb::{
    connect,
    query::{ExecutableQuery, QueryBase, Select},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, OnceLock},
    time::UNIX_EPOCH,
};
use tokio::sync::RwLock;

use crate::{error::Result, state::AppState};

const TABLE: &str = "chunks";
const RRF_K: f64 = 60.0;
const TOKEN_RESULT_MULTIPLIER: usize = 8;
const VECTOR_RESULT_MULTIPLIER: usize = 5;
const MAX_TOKEN_CACHE_PROJECTS: usize = 8;

#[derive(Deserialize)]
pub struct RetrieveRequest {
    pub project_path: String,
    pub query: String,
    pub top_k: Option<usize>,
    pub context_budget_tokens: Option<usize>,
    pub use_token: Option<bool>,
    pub use_graph: Option<bool>,
}

#[derive(Clone, Serialize)]
pub struct RetrievedChunk {
    pub page_path: String,
    pub page_title: String,
    pub chunk_index: i32,
    pub heading_path: String,
    pub chunk_text: String,
    pub distance: f64,
    pub score: f64,
    pub source: String,
}

#[derive(Serialize)]
pub struct RetrieveResponse {
    pub chunks: Vec<RetrievedChunk>,
    pub retrieval_ms: u128,
    pub query_len: usize,
    pub top_k: usize,
    pub context_budget_tokens: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TokenIndexFingerprint {
    chunk_count: usize,
    meta_mtime_secs: u64,
}

#[derive(Clone)]
struct IndexChunk {
    page_path: String,
    page_title: String,
    chunk_index: i32,
    heading_path: String,
    chunk_text: String,
    page_path_lower: String,
    page_stem_lower: String,
    title_lower: String,
    heading_lower: String,
    text_lower: String,
    token_counts: HashMap<String, u32>,
    token_len: usize,
}

struct TokenIndex {
    fingerprint: TokenIndexFingerprint,
    chunks: Vec<IndexChunk>,
    doc_freq: HashMap<String, usize>,
    avg_doc_len: f64,
}

struct ScoredChunk {
    chunk: RetrievedChunk,
    raw_score: f64,
}

struct FusedCandidate {
    chunk: RetrievedChunk,
    rrf_score: f64,
    vector_rank: Option<usize>,
    token_rank: Option<usize>,
    vector_score: f64,
    token_score: f64,
}

static TOKEN_INDEX_CACHE: OnceLock<RwLock<HashMap<String, Arc<TokenIndex>>>> = OnceLock::new();

fn token_cache() -> &'static RwLock<HashMap<String, Arc<TokenIndex>>> {
    TOKEN_INDEX_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

async fn embed_query(state: &AppState, query: &str) -> anyhow::Result<Vec<f32>> {
    let cfg = &state.llm_config;

    let endpoint = cfg
        .embedding_endpoint
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Embedding not configured. Set EMBEDDING_ENDPOINT env var."))?
        .trim_end_matches('/')
        .to_string();

    let model = cfg.embedding_model.clone().unwrap_or_default();
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

    let mut req = state
        .http_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    if let Some(key) = cfg.embedding_api_key() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let resp = req
        .json(&req_body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Embedding request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Embedding HTTP {status}: {body}"));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to parse embedding response: {e}"))?;

    let embedding = if is_dashscope_multimodal {
        data.pointer("/output/embeddings/0/embedding")
            .ok_or_else(|| anyhow::anyhow!("DashScope response missing output.embeddings[0].embedding"))?
            .clone()
    } else {
        data.pointer("/data/0/embedding")
            .ok_or_else(|| anyhow::anyhow!("OpenAI response missing data[0].embedding"))?
            .clone()
    };

    serde_json::from_value(embedding)
        .map_err(|e| anyhow::anyhow!("Failed to deserialize embedding: {e}"))
}

async fn vector_retrieve(
    project_path: &str,
    query_vec: Vec<f32>,
    limit: usize,
) -> anyhow::Result<Vec<RetrievedChunk>> {
    let db_path = format!("{project_path}/.llm-wiki/lancedb");
    let db = match connect(&db_path).execute().await {
        Ok(d) => d,
        Err(_) => return Ok(vec![]),
    };
    let tbl = match db.open_table(TABLE).execute().await {
        Ok(t) => t,
        Err(_) => return Ok(vec![]),
    };

    let batches: Vec<_> = tbl
        .vector_search(query_vec)?
        .limit(limit)
        .execute()
        .await?
        .try_collect()
        .await?;

    Ok(chunks_from_batches(&batches, "vector", true))
}

fn chunks_from_batches(
    batches: &[arrow_array::RecordBatch],
    source: &str,
    include_distance: bool,
) -> Vec<RetrievedChunk> {
    let mut chunks = Vec::new();

    for batch in batches {
        let page_paths = batch
            .column_by_name("page_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let page_titles = batch
            .column_by_name("page_title")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let chunk_indices = batch
            .column_by_name("chunk_index")
            .and_then(|c| c.as_any().downcast_ref::<Int32Array>());
        let heading_paths = batch
            .column_by_name("heading_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let texts = batch
            .column_by_name("chunk_text")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let distances = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

        if let (Some(pp), Some(pt), Some(ci), Some(hp), Some(tx)) =
            (page_paths, page_titles, chunk_indices, heading_paths, texts)
        {
            for i in 0..batch.num_rows() {
                let distance = if include_distance {
                    distances.map(|d| d.value(i) as f64).unwrap_or(1.0)
                } else {
                    1.0
                };
                chunks.push(RetrievedChunk {
                    page_path: pp.value(i).to_string(),
                    page_title: pt.value(i).to_string(),
                    chunk_index: ci.value(i),
                    heading_path: hp.value(i).to_string(),
                    chunk_text: tx.value(i).to_string(),
                    distance,
                    score: 1.0 - distance,
                    source: source.to_string(),
                });
            }
        }
    }

    chunks
}

async fn token_retrieve(project_path: &str, query: &str, limit: usize) -> anyhow::Result<Vec<ScoredChunk>> {
    let index = get_token_index(project_path).await?;
    Ok(score_token_index(&index, query, limit))
}

async fn get_token_index(project_path: &str) -> anyhow::Result<Arc<TokenIndex>> {
    let fingerprint = token_index_fingerprint(project_path).await?;
    let key = normalize_project_key(project_path);

    {
        let cache = token_cache().read().await;
        if let Some(index) = cache.get(&key) {
            if index.fingerprint == fingerprint {
                return Ok(index.clone());
            }
        }
    }

    let index = Arc::new(load_token_index(project_path, fingerprint).await?);
    let mut cache = token_cache().write().await;
    if cache.len() >= MAX_TOKEN_CACHE_PROJECTS && !cache.contains_key(&key) {
        if let Some(old_key) = cache.keys().next().cloned() {
            cache.remove(&old_key);
        }
    }
    cache.insert(key, index.clone());
    Ok(index)
}

async fn token_index_fingerprint(project_path: &str) -> anyhow::Result<TokenIndexFingerprint> {
    let db_path = format!("{project_path}/.llm-wiki/lancedb");
    let db = match connect(&db_path).execute().await {
        Ok(d) => d,
        Err(_) => {
            return Ok(TokenIndexFingerprint {
                chunk_count: 0,
                meta_mtime_secs: vector_meta_mtime(project_path),
            })
        }
    };
    let chunk_count = match db.open_table(TABLE).execute().await {
        Ok(tbl) => tbl.count_rows(None).await.unwrap_or(0),
        Err(_) => 0,
    };

    Ok(TokenIndexFingerprint {
        chunk_count,
        meta_mtime_secs: vector_meta_mtime(project_path),
    })
}

fn vector_meta_mtime(project_path: &str) -> u64 {
    Path::new(project_path)
        .join(".llm-wiki/vector-meta.json")
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn load_token_index(
    project_path: &str,
    fingerprint: TokenIndexFingerprint,
) -> anyhow::Result<TokenIndex> {
    if fingerprint.chunk_count == 0 {
        return Ok(TokenIndex {
            fingerprint,
            chunks: vec![],
            doc_freq: HashMap::new(),
            avg_doc_len: 0.0,
        });
    }

    let db_path = format!("{project_path}/.llm-wiki/lancedb");
    let db = connect(&db_path).execute().await?;
    let tbl = db.open_table(TABLE).execute().await?;
    let batches: Vec<_> = tbl
        .query()
        .select(Select::columns(&[
            "page_path",
            "page_title",
            "chunk_index",
            "heading_path",
            "chunk_text",
        ]))
        .limit(fingerprint.chunk_count)
        .execute()
        .await?
        .try_collect()
        .await?;

    let raw_chunks = chunks_from_batches(&batches, "token", false);
    let mut chunks = Vec::with_capacity(raw_chunks.len());
    let mut doc_freq: HashMap<String, usize> = HashMap::new();
    let mut total_len = 0usize;

    for chunk in raw_chunks {
        let search_text = format!(
            "{} {} {} {}",
            chunk.page_path, chunk.page_title, chunk.heading_path, chunk.chunk_text
        );
        let token_counts = token_counts(&search_text);
        let token_len: usize = token_counts.values().map(|v| *v as usize).sum();
        total_len += token_len.max(1);

        let unique: HashSet<String> = token_counts.keys().cloned().collect();
        for token in unique {
            *doc_freq.entry(token).or_insert(0) += 1;
        }

        let page_path_lower = chunk.page_path.to_lowercase();
        chunks.push(IndexChunk {
            page_stem_lower: page_stem(&chunk.page_path).to_lowercase(),
            page_path_lower,
            title_lower: chunk.page_title.to_lowercase(),
            heading_lower: chunk.heading_path.to_lowercase(),
            text_lower: chunk.chunk_text.to_lowercase(),
            page_path: chunk.page_path,
            page_title: chunk.page_title,
            chunk_index: chunk.chunk_index,
            heading_path: chunk.heading_path,
            chunk_text: chunk.chunk_text,
            token_counts,
            token_len,
        });
    }

    let avg_doc_len = if chunks.is_empty() {
        0.0
    } else {
        total_len as f64 / chunks.len() as f64
    };

    tracing::info!(
        "[RAG] loaded token index project={} chunks={} vocab={}",
        project_path,
        chunks.len(),
        doc_freq.len()
    );

    Ok(TokenIndex {
        fingerprint,
        chunks,
        doc_freq,
        avg_doc_len,
    })
}

fn score_token_index(index: &TokenIndex, query: &str, limit: usize) -> Vec<ScoredChunk> {
    if index.chunks.is_empty() || query.trim().is_empty() {
        return vec![];
    }

    let query_phrase = normalize_phrase(query);
    let query_tokens = tokenize_query(query);
    if query_phrase.is_empty() && query_tokens.is_empty() {
        return vec![];
    }

    let max_phrase_occ = 10usize;
    let n_docs = index.chunks.len() as f64;
    let avg_doc_len = index.avg_doc_len.max(1.0);
    let mut scored = Vec::new();

    for chunk in &index.chunks {
        let mut score = 0.0;

        if !query_phrase.is_empty() {
            if chunk.page_stem_lower == query_phrase || chunk.page_path_lower == query_phrase {
                score += 240.0;
            }
            if chunk.title_lower.contains(&query_phrase) {
                score += 90.0;
            }
            if chunk.heading_lower.contains(&query_phrase) {
                score += 45.0;
            }
            let phrase_occ = count_occurrences(&chunk.text_lower, &query_phrase).min(max_phrase_occ);
            score += phrase_occ as f64 * 22.0;
        }

        for token in &query_tokens {
            let tf = *chunk.token_counts.get(token).unwrap_or(&0) as f64;
            let df = *index.doc_freq.get(token).unwrap_or(&0) as f64;
            if df <= 0.0 {
                continue;
            }

            let idf = (((n_docs - df + 0.5) / (df + 0.5)) + 1.0).ln().max(0.05);
            if tf > 0.0 {
                let k1 = 1.2;
                let b = 0.75;
                let len_norm = chunk.token_len.max(1) as f64 / avg_doc_len;
                let bm25 = idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * len_norm));
                score += bm25;
            }
            if chunk.title_lower.contains(token) {
                score += idf * 7.0;
            }
            if chunk.heading_lower.contains(token) {
                score += idf * 4.0;
            }
            if chunk.page_path_lower.contains(token) {
                score += idf * 5.0;
            }
        }

        if score <= 0.0 {
            continue;
        }

        scored.push(ScoredChunk {
            raw_score: score,
            chunk: RetrievedChunk {
                page_path: chunk.page_path.clone(),
                page_title: chunk.page_title.clone(),
                chunk_index: chunk.chunk_index,
                heading_path: chunk.heading_path.clone(),
                chunk_text: chunk.chunk_text.clone(),
                distance: 1.0,
                score,
                source: "token".to_string(),
            },
        });
    }

    scored.sort_by(|a, b| {
        b.raw_score
            .partial_cmp(&a.raw_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk.page_path.cmp(&b.chunk.page_path))
            .then_with(|| a.chunk.chunk_index.cmp(&b.chunk.chunk_index))
    });
    scored.truncate(limit);
    scored
}

pub async fn retrieve_chunks_for_query(
    state: &AppState,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> anyhow::Result<(Vec<RetrievedChunk>, u128)> {
    retrieve_chunks_for_query_with_options(state, project_path, query, top_k, true).await
}

pub async fn retrieve_chunks_for_query_with_options(
    state: &AppState,
    project_path: &str,
    query: &str,
    top_k: usize,
    use_token: bool,
) -> anyhow::Result<(Vec<RetrievedChunk>, u128)> {
    let t0 = std::time::Instant::now();
    let vector_limit = (top_k * VECTOR_RESULT_MULTIPLIER).max(top_k);
    let token_limit = (top_k * TOKEN_RESULT_MULTIPLIER).max(top_k);

    let vector_chunks = match embed_query(state, query).await {
        Ok(query_vec) => match vector_retrieve(project_path, query_vec, vector_limit).await {
            Ok(chunks) => chunks,
            Err(e) => {
                tracing::warn!("[RAG] vector retrieval failed: {e}");
                vec![]
            }
        },
        Err(e) => {
            tracing::warn!("[RAG] query embedding failed; continuing token-only if possible: {e}");
            vec![]
        }
    };

    let token_chunks = if use_token {
        match token_retrieve(project_path, query, token_limit).await {
            Ok(chunks) => chunks,
            Err(e) => {
                tracing::warn!("[RAG] token retrieval failed: {e}");
                vec![]
            }
        }
    } else {
        vec![]
    };

    let chunks = fuse_chunks(vector_chunks, token_chunks, top_k, query);
    Ok((chunks, t0.elapsed().as_millis()))
}

fn fuse_chunks(
    vector_chunks: Vec<RetrievedChunk>,
    token_chunks: Vec<ScoredChunk>,
    top_k: usize,
    query: &str,
) -> Vec<RetrievedChunk> {
    let mut candidates: HashMap<String, FusedCandidate> = HashMap::new();
    let top_token_score = token_chunks
        .first()
        .map(|s| s.raw_score.max(1.0))
        .unwrap_or(1.0);

    for (rank0, chunk) in vector_chunks.into_iter().enumerate() {
        let rank = rank0 + 1;
        let key = chunk_key(&chunk);
        let entry = candidates.entry(key).or_insert_with(|| FusedCandidate {
            vector_score: chunk.score,
            token_score: 0.0,
            rrf_score: 0.0,
            vector_rank: None,
            token_rank: None,
            chunk,
        });
        entry.vector_rank = Some(rank);
        entry.vector_score = entry.vector_score.max(entry.chunk.score);
        entry.rrf_score += 1.0 / (RRF_K + rank as f64);
    }

    for (rank0, scored) in token_chunks.into_iter().enumerate() {
        let rank = rank0 + 1;
        let key = chunk_key(&scored.chunk);
        let entry = candidates.entry(key).or_insert_with(|| FusedCandidate {
            vector_score: 0.0,
            token_score: 0.0,
            rrf_score: 0.0,
            vector_rank: None,
            token_rank: None,
            chunk: scored.chunk.clone(),
        });
        entry.token_rank = Some(rank);
        entry.token_score = entry.token_score.max(scored.raw_score);
        entry.rrf_score += 1.0 / (RRF_K + rank as f64);

        if entry.chunk.source == "vector" && scored.raw_score > entry.token_score {
            entry.chunk = scored.chunk;
        }
    }

    let mut fused = candidates.into_values().collect::<Vec<_>>();
    fused.sort_by(|a, b| {
        let a_score = final_fused_score(a, top_token_score, query);
        let b_score = final_fused_score(b, top_token_score, query);
        b_score
            .partial_cmp(&a_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk.page_path.cmp(&b.chunk.page_path))
            .then_with(|| a.chunk.chunk_index.cmp(&b.chunk.chunk_index))
    });

    fused
        .into_iter()
        .take(top_k)
        .map(|candidate| {
            let score = final_fused_score(&candidate, top_token_score, query);
            let mut chunk = candidate.chunk;
            chunk.score = score;
            chunk.distance = (1.0 - chunk.score).clamp(0.0, 1.0);
            chunk.source = match (candidate.vector_rank, candidate.token_rank) {
                (Some(_), Some(_)) => "hybrid",
                (Some(_), None) => "vector",
                (None, Some(_)) => "token",
                (None, None) => "unknown",
            }
            .to_string();
            chunk
        })
        .collect()
}

fn final_fused_score(candidate: &FusedCandidate, top_token_score: f64, query: &str) -> f64 {
    let token_norm = if candidate.token_score > 0.0 {
        (candidate.token_score / top_token_score).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let vector_norm = candidate.vector_score.clamp(0.0, 1.0);
    let base = candidate.rrf_score + token_norm * 0.035 + vector_norm * 0.012;
    base * quality_multiplier(&candidate.chunk, query)
}

fn quality_multiplier(chunk: &RetrievedChunk, query: &str) -> f64 {
    let query_lower = query.to_lowercase();
    let query_asks_audit = query_lower.contains('\u{5ba1}')
        || query_lower.contains('\u{8d28}')
        || query_lower.contains("audit")
        || query_lower.contains("review");
    if query_asks_audit {
        return 1.0;
    }

    let page = format!("{} {}", chunk.page_path, chunk.page_title).to_lowercase();
    let is_audit_page = page.contains("\u{62bd}\u{53d6}\u{8d28}\u{91cf}\u{5ba1}\u{8ba1}")
        || page.contains("\u{8d28}\u{91cf}\u{5ba1}\u{8ba1}")
        || page.contains("audit");
    if is_audit_page {
        0.55
    } else {
        1.0
    }
}

fn chunk_key(chunk: &RetrievedChunk) -> String {
    format!("{}#{}", chunk.page_path, chunk.chunk_index)
}

fn normalize_project_key(project_path: &str) -> String {
    project_path.replace('\\', "/").to_lowercase()
}

fn page_stem(page_path: &str) -> String {
    let name = page_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(page_path);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

fn normalize_phrase(query: &str) -> String {
    query
        .trim()
        .trim_matches(|c: char| {
            c.is_whitespace()
                || c.is_ascii_punctuation()
                || matches!(
                    c,
                    '\u{3002}'
                        | '\u{ff0c}'
                        | '\u{ff1f}'
                        | '\u{ff01}'
                        | '\u{3001}'
                        | '\u{ff1b}'
                        | '\u{ff1a}'
                        | '\u{201c}'
                        | '\u{201d}'
                        | '\u{2018}'
                        | '\u{2019}'
                )
        })
        .to_lowercase()
}

fn tokenize_query(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for segment in split_query_segments(query) {
        let lower = segment.to_lowercase();
        if lower.chars().any(is_cjk) && lower.chars().count() > 2 {
            let chars = lower.chars().collect::<Vec<_>>();
            for window in chars.windows(2) {
                tokens.push(window.iter().collect::<String>());
            }
            for ch in chars {
                let s = ch.to_string();
                if !is_stop_word(&s) {
                    tokens.push(s);
                }
            }
            tokens.push(lower);
        } else if lower.chars().count() > 1 && !is_stop_word(&lower) {
            tokens.push(lower);
        }
    }
    dedupe(tokens)
}

fn token_counts(text: &str) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    for token in tokenize_query(text) {
        *counts.entry(token).or_insert(0) += 1;
    }
    counts
}

fn split_query_segments(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut current_kind: Option<u8> = None;

    for ch in text.chars() {
        let kind = if ch.is_ascii_alphanumeric() {
            Some(1)
        } else if is_cjk(ch) {
            Some(2)
        } else {
            None
        };

        match (kind, current_kind) {
            (Some(k), Some(existing)) if k == existing => current.push(ch),
            (Some(k), _) => {
                if !current.is_empty() {
                    out.push(current.clone());
                    current.clear();
                }
                current.push(ch);
                current_kind = Some(k);
            }
            (None, _) => {
                if !current.is_empty() {
                    out.push(current.clone());
                    current.clear();
                }
                current_kind = None;
            }
        }
    }

    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn is_cjk(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&ch) || ('\u{3400}'..='\u{4dbf}').contains(&ch)
}

fn is_stop_word(token: &str) -> bool {
    matches!(
        token,
        "the"
            | "is"
            | "a"
            | "an"
            | "what"
            | "how"
            | "are"
            | "was"
            | "were"
            | "do"
            | "does"
            | "did"
            | "be"
            | "been"
            | "being"
            | "have"
            | "has"
            | "had"
            | "it"
            | "its"
            | "in"
            | "on"
            | "at"
            | "to"
            | "for"
            | "of"
            | "with"
            | "by"
            | "\u{7684}"
            | "\u{662f}"
            | "\u{4e86}"
            | "\u{5728}"
            | "\u{6709}"
            | "\u{548c}"
            | "\u{4e0e}"
            | "\u{53ca}"
    )
}

fn dedupe(tokens: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for token in tokens {
        if seen.insert(token.clone()) {
            out.push(token);
        }
    }
    out
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut pos = 0;
    while let Some(idx) = haystack[pos..].find(needle) {
        count += 1;
        pos += idx + needle.len();
        if pos >= haystack.len() {
            break;
        }
    }
    count
}

pub async fn retrieve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RetrieveRequest>,
) -> Result<Json<Value>> {
    let top_k = body.top_k.unwrap_or(8).clamp(1, 64);
    let use_token = body.use_token.unwrap_or(true);
    if body.use_graph.unwrap_or(false) {
        tracing::info!("[RAG] use_graph requested but graph expansion is not implemented in this phase");
    }

    let (chunks, retrieval_ms) = retrieve_chunks_for_query_with_options(
        &state,
        &body.project_path,
        &body.query,
        top_k,
        use_token,
    )
    .await?;

    tracing::info!(
        "[RAG] query_len={} top_k={} chunks={} retrieval_ms={} token={}",
        body.query.len(),
        top_k,
        chunks.len(),
        retrieval_ms,
        use_token
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

pub async fn status(Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    let pp = match params.get("project_path") {
        Some(p) => p.as_str(),
        None => return Json(json!({ "error": "project_path required" })),
    };

    let meta_path = Path::new(pp).join(".llm-wiki/vector-meta.json");
    let meta: Option<serde_json::Value> = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let stored_dim = meta.as_ref().and_then(|m| m["dim"].as_i64()).unwrap_or(0);
    let stored_model = meta
        .as_ref()
        .and_then(|m| m["model"].as_str())
        .unwrap_or("")
        .to_string();

    let db_path = format!("{pp}/.llm-wiki/lancedb");
    let chunk_count: i64 = if let Ok(db) = connect(&db_path).execute().await {
        if let Ok(tbl) = db.open_table(TABLE).execute().await {
            tbl.count_rows(None).await.unwrap_or(0) as i64
        } else {
            -1
        }
    } else {
        -1
    };

    let indexed = chunk_count > 0;
    let token_cache_key = normalize_project_key(pp);
    let token_cache_loaded = token_cache().read().await.contains_key(&token_cache_key);
    let (needs_reindex, reason) = if chunk_count < 0 {
        (true, Some("LanceDB index not found - run Re-index All".to_string()))
    } else if chunk_count == 0 {
        (true, Some("Index is empty - run Re-index All".to_string()))
    } else if stored_dim == 0 {
        (true, Some("vector-meta.json missing - index may be corrupt".to_string()))
    } else {
        (false, None)
    };

    Json(json!({
        "indexed": indexed,
        "chunk_count": chunk_count.max(0),
        "dim": stored_dim,
        "embedding_model": stored_model,
        "schema_version": 2,
        "retrieval_mode": "hybrid_vector_token_rrf",
        "token_cache_loaded": token_cache_loaded,
        "needs_reindex": needs_reindex,
        "reason": reason,
    }))
}
