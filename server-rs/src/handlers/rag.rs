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
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::UNIX_EPOCH,
};
use tokio::sync::RwLock;

use crate::{error::Result, state::AppState};

const TABLE: &str = "chunks";
const RRF_K: f64 = 60.0;
const TOKEN_RESULT_MULTIPLIER: usize = 8;
const VECTOR_RESULT_MULTIPLIER: usize = 5;
const GRAPH_RESULT_MULTIPLIER: usize = 4;
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
    #[serde(skip_serializing)]
    pub quality_multiplier: f64,
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
    wiki_mtime_secs: u64,
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
    schema_lower: String,
    quality_multiplier: f64,
    token_counts: HashMap<String, u32>,
    token_len: usize,
}

struct TokenIndex {
    fingerprint: TokenIndexFingerprint,
    chunks: Vec<IndexChunk>,
    doc_freq: HashMap<String, usize>,
    avg_doc_len: f64,
    page_chunks: HashMap<String, Vec<usize>>,
    page_meta: HashMap<String, PageMeta>,
    in_links: HashMap<String, HashSet<String>>,
}

struct ScoredChunk {
    chunk: RetrievedChunk,
    raw_score: f64,
}

#[derive(Clone)]
struct PageMeta {
    page_path: String,
    title: String,
    page_type: String,
    schema_text: String,
    page_path_lower: String,
    page_stem_lower: String,
    title_lower: String,
    full_text: String,
    full_lower: String,
    token_counts: HashMap<String, u32>,
    token_len: usize,
    sources: Vec<String>,
    out_links: HashSet<String>,
    quality_multiplier: f64,
    excluded: bool,
}

struct FusedCandidate {
    chunk: RetrievedChunk,
    rrf_score: f64,
    vector_rank: Option<usize>,
    token_rank: Option<usize>,
    graph_rank: Option<usize>,
    vector_score: f64,
    token_score: f64,
    graph_score: f64,
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
                    quality_multiplier: 1.0,
                });
            }
        }
    }

    chunks
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
                wiki_mtime_secs: wiki_mtime(project_path),
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
        wiki_mtime_secs: wiki_mtime(project_path),
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

fn wiki_mtime(project_path: &str) -> u64 {
    let wiki_root = Path::new(project_path).join("wiki");
    let mut max_mtime = 0;
    let mut stack = vec![wiki_root];

    while let Some(path) = stack.pop() {
        let Ok(metadata) = path.metadata() else {
            continue;
        };

        if metadata.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.flatten() {
                    stack.push(entry.path());
                }
            }
            continue;
        }

        let is_markdown = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_markdown {
            continue;
        }

        if let Some(mtime) = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
        {
            max_mtime = max_mtime.max(mtime);
        }
    }

    max_mtime
}

fn wiki_markdown_page_paths(project_path: &str) -> Vec<String> {
    let project_root = Path::new(project_path);
    let wiki_root = project_root.join("wiki");
    let mut pages = Vec::new();
    let mut stack = vec![wiki_root];

    while let Some(path) = stack.pop() {
        let Ok(metadata) = path.metadata() else {
            continue;
        };

        if metadata.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.flatten() {
                    stack.push(entry.path());
                }
            }
            continue;
        }

        let is_markdown = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_markdown {
            continue;
        }

        let rel = path.strip_prefix(project_root).unwrap_or(&path);
        pages.push(rel.to_string_lossy().replace('\\', "/"));
    }

    pages
}

async fn load_token_index(
    project_path: &str,
    fingerprint: TokenIndexFingerprint,
) -> anyhow::Result<TokenIndex> {
    let raw_chunks = if fingerprint.chunk_count > 0 {
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
        chunks_from_batches(&batches, "token", false)
    } else {
        Vec::new()
    };

    let mut unique_pages = HashSet::new();
    let mut page_samples: HashMap<String, (String, String)> = HashMap::new();
    for chunk in &raw_chunks {
        let id = page_id(&chunk.page_path);
        unique_pages.insert(id.clone());
        page_samples
            .entry(id)
            .or_insert_with(|| (chunk.page_path.clone(), chunk.page_title.clone()));
    }

    for page_path in wiki_markdown_page_paths(project_path) {
        let id = page_id(&page_path);
        unique_pages.insert(id.clone());
        let fallback_title = page_stem(&page_path).replace('-', " ");
        page_samples
            .entry(id)
            .or_insert_with(|| (page_path, fallback_title));
    }

    let mut page_meta = HashMap::new();
    for id in &unique_pages {
        let (page_path, title) = page_samples
            .get(id)
            .map(|(path, title)| (path.as_str(), title.as_str()))
            .unwrap_or((id.as_str(), id.as_str()));
        let meta = load_page_meta(project_path, page_path, title, &unique_pages).await;
        if !meta.excluded {
            page_meta.insert(id.clone(), meta);
        }
    }

    let mut in_links: HashMap<String, HashSet<String>> = HashMap::new();
    for id in page_meta.keys() {
        in_links.entry(id.clone()).or_default();
    }
    for (from, meta) in &page_meta {
        for to in &meta.out_links {
            if page_meta.contains_key(to) && from != to {
                in_links.entry(to.clone()).or_default().insert(from.clone());
            }
        }
    }

    let mut chunks = Vec::with_capacity(raw_chunks.len());
    let mut doc_freq: HashMap<String, usize> = HashMap::new();
    let mut page_chunks: HashMap<String, Vec<usize>> = HashMap::new();
    let mut total_len = 0usize;

    for chunk in raw_chunks {
        let id = page_id(&chunk.page_path);
        let meta = match page_meta.get(&id) {
            Some(meta) => meta,
            None => continue,
        };
        let search_text = format!(
            "{} {} {} {} {} {}",
            chunk.page_path,
            chunk.page_title,
            chunk.heading_path,
            chunk.chunk_text,
            meta.schema_text,
            meta.sources.join(" ")
        );
        let token_counts = token_counts(&search_text);
        let token_len: usize = token_counts.values().map(|v| *v as usize).sum();
        total_len += token_len.max(1);

        let unique: HashSet<String> = token_counts.keys().cloned().collect();
        for token in unique {
            *doc_freq.entry(token).or_insert(0) += 1;
        }

        let page_path_lower = chunk.page_path.to_lowercase();
        let chunk_index = chunks.len();
        chunks.push(IndexChunk {
            page_stem_lower: page_stem(&chunk.page_path).to_lowercase(),
            page_path_lower,
            title_lower: chunk.page_title.to_lowercase(),
            heading_lower: chunk.heading_path.to_lowercase(),
            text_lower: chunk.chunk_text.to_lowercase(),
            schema_lower: meta.schema_text.to_lowercase(),
            quality_multiplier: meta.quality_multiplier,
            page_path: chunk.page_path,
            page_title: chunk.page_title,
            chunk_index: chunk.chunk_index,
            heading_path: chunk.heading_path,
            chunk_text: chunk.chunk_text,
            token_counts,
            token_len,
        });
        page_chunks.entry(id).or_default().push(chunk_index);
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
        page_chunks,
        page_meta,
        in_links,
    })
}

async fn load_page_meta(
    project_path: &str,
    page_path: &str,
    fallback_title: &str,
    page_ids: &HashSet<String>,
) -> PageMeta {
    let id = page_id(page_path);
    let content = match read_page_content(project_path, page_path).await {
        Some(content) => content,
        None => {
            let full_text = fallback_title.to_string();
            let token_counts = token_counts(&full_text);
            let token_len = token_counts.values().map(|v| *v as usize).sum();
            return PageMeta {
                page_path: page_path.to_string(),
                title: fallback_title.to_string(),
                page_type: "other".to_string(),
                schema_text: fallback_title.to_string(),
                page_path_lower: page_path.to_lowercase(),
                page_stem_lower: page_stem(page_path).to_lowercase(),
                title_lower: fallback_title.to_lowercase(),
                full_lower: full_text.to_lowercase(),
                full_text,
                token_counts,
                token_len,
                sources: vec![],
                out_links: HashSet::new(),
                quality_multiplier: 1.0,
                excluded: false,
            }
        }
    };

    let fm = extract_frontmatter(&content);
    let title = scalar_value(&fm, "title")
        .or_else(|| first_heading(&content))
        .unwrap_or_else(|| fallback_title.to_string());
    let page_type = scalar_value(&fm, "type")
        .or_else(|| scalar_value(&fm, "entity_type"))
        .unwrap_or_else(|| "other".to_string())
        .to_lowercase();
    let (quality_multiplier, excluded) = governance_multiplier(&fm);
    let sources = extract_sources(&fm);
    let raw_links = extract_wikilinks(&content);
    let out_links = raw_links
        .into_iter()
        .filter_map(|link| resolve_link(&link, page_ids))
        .filter(|target| target != &id)
        .collect::<HashSet<_>>();

    let source_text = sources.join(" ");
    let schema_text = [title.as_str(), page_type.as_str(), fm.as_str(), source_text.as_str()].join("\n");
    let title_lower = title.to_lowercase();
    let full_text = format!("{page_path}\n{title}\n{schema_text}\n{content}");
    let token_counts = token_counts(&full_text);
    let token_len = token_counts.values().map(|v| *v as usize).sum();

    PageMeta {
        page_path: page_path.to_string(),
        title,
        page_type,
        schema_text,
        page_path_lower: page_path.to_lowercase(),
        page_stem_lower: page_stem(page_path).to_lowercase(),
        title_lower,
        full_lower: full_text.to_lowercase(),
        full_text,
        token_counts,
        token_len,
        sources,
        out_links,
        quality_multiplier,
        excluded,
    }
}

async fn read_page_content(project_path: &str, page_path: &str) -> Option<String> {
    for candidate in page_candidates(project_path, page_path) {
        if let Ok(content) = tokio::fs::read_to_string(candidate).await {
            return Some(content);
        }
    }
    None
}

fn page_candidates(project_path: &str, page_path: &str) -> Vec<PathBuf> {
    let root = Path::new(project_path);
    let normalized = page_path.replace('\\', "/");
    let mut candidates = Vec::new();

    let raw = PathBuf::from(&normalized);
    if raw.is_absolute() {
        candidates.push(raw);
    } else {
        candidates.push(root.join(&normalized));
        candidates.push(root.join("wiki").join(&normalized));
        if !normalized.ends_with(".md") {
            candidates.push(root.join(format!("{normalized}.md")));
            candidates.push(root.join("wiki").join(format!("{normalized}.md")));
        }
    }

    let stem = page_stem(&normalized);
    let dirs = [
        "entities",
        "concepts",
        "sources",
        "queries",
        "synthesis",
        "comparisons",
        "audits",
    ];
    for dir in dirs {
        candidates.push(root.join("wiki").join(dir).join(format!("{stem}.md")));
    }
    candidates.push(root.join("wiki").join(format!("{stem}.md")));
    candidates
}

fn extract_frontmatter(content: &str) -> String {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    if !normalized.starts_with("---") {
        return String::new();
    }
    let rest = &normalized[3..];
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')).unwrap_or(rest);
    if let Some(idx) = rest.find("\n---") {
        return rest[..idx].to_string();
    }
    String::new()
}

fn scalar_value(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        let Some((k, v)) = trimmed.split_once(':') else {
            continue;
        };
        if k.trim() != key {
            continue;
        }
        let value = v
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        if !value.is_empty() && !value.starts_with('[') && !value.starts_with('{') {
            return Some(value.to_string());
        }
    }
    None
}

fn first_heading(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("# ")
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
    })
}

fn governance_multiplier(frontmatter: &str) -> (f64, bool) {
    let status = scalar_value(frontmatter, "status")
        .unwrap_or_else(|| "active".to_string())
        .to_lowercase();
    let status_multiplier = match status.as_str() {
        "active" => 1.0,
        "candidate" => 0.7,
        "superseded" => 0.35,
        "rejected" => 0.0,
        _ => 1.0,
    };
    let quality = scalar_value(frontmatter, "ingest_quality_confidence")
        .unwrap_or_default()
        .to_lowercase();
    let quality_multiplier = match quality.as_str() {
        "high" => 1.0,
        "medium" => 0.9,
        "low" => 0.75,
        _ => 1.0,
    };
    let multiplier = status_multiplier * quality_multiplier;
    (multiplier, status == "rejected" || multiplier <= 0.0)
}

fn extract_sources(frontmatter: &str) -> Vec<String> {
    let mut sources = Vec::new();
    for key in ["sources", "source_files"] {
        collect_yaml_values(frontmatter, key, &mut sources);
    }
    dedupe(sources)
}

fn collect_yaml_values(frontmatter: &str, key: &str, out: &mut Vec<String>) {
    let lines = frontmatter.lines().collect::<Vec<_>>();
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix(&format!("{key}:")) else {
            continue;
        };
        let rest = rest.trim();
        if rest.starts_with('[') && rest.ends_with(']') {
            for item in rest.trim_matches(['[', ']']).split(',') {
                push_clean_value(out, item);
            }
            continue;
        }
        if !rest.is_empty() {
            push_clean_value(out, rest);
            continue;
        }
        for next in lines.iter().skip(idx + 1) {
            let next_trimmed = next.trim();
            if next_trimmed.is_empty() {
                continue;
            }
            if !next.starts_with(' ') && !next.starts_with('\t') {
                break;
            }
            if let Some(item) = next_trimmed.strip_prefix('-') {
                push_clean_value(out, item);
            }
        }
    }
}

fn push_clean_value(out: &mut Vec<String>, value: &str) {
    let cleaned = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if !cleaned.is_empty() {
        out.push(cleaned);
    }
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("]]") else {
            break;
        };
        let raw = &after_start[..end];
        let target = raw.split('|').next().unwrap_or(raw).trim();
        if !target.is_empty() {
            links.push(target.to_string());
        }
        rest = &after_start[end + 2..];
    }
    links
}

fn resolve_link(raw: &str, page_ids: &HashSet<String>) -> Option<String> {
    let target = page_id(raw);
    if page_ids.contains(&target) {
        return Some(target);
    }
    let normalized = normalize_link_id(&target);
    page_ids
        .iter()
        .find(|id| normalize_link_id(id) == normalized)
        .cloned()
}

fn normalize_link_id(value: &str) -> String {
    value.to_lowercase().replace(' ', "-").replace('_', "-")
}

fn score_token_index(index: &TokenIndex, query: &str, limit: usize) -> Vec<ScoredChunk> {
    if (index.chunks.is_empty() && index.page_meta.is_empty()) || query.trim().is_empty() {
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
        let score = score_index_chunk(
            chunk,
            &query_phrase,
            &query_tokens,
            &index.doc_freq,
            n_docs,
            avg_doc_len,
            max_phrase_occ,
        );

        if score <= 0.0 {
            continue;
        }

        scored.push(ScoredChunk {
            raw_score: score,
            chunk: retrieved_from_index_chunk(chunk, score, "token"),
        });
    }

    for (page_id, meta) in &index.page_meta {
        let score = score_page_meta(meta, &query_phrase, &query_tokens, max_phrase_occ);
        if score <= 0.0 {
            continue;
        }
        if let Some(candidate) = best_chunk_for_page(index, page_id, query, score, "token", 0.20) {
            scored.push(candidate);
        }
    }

    scored.sort_by(|a, b| {
        b.raw_score
            .partial_cmp(&a.raw_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk.page_path.cmp(&b.chunk.page_path))
            .then_with(|| a.chunk.chunk_index.cmp(&b.chunk.chunk_index))
    });
    dedupe_scored_chunks(scored, limit)
}

fn score_index_chunk(
    chunk: &IndexChunk,
    query_phrase: &str,
    query_tokens: &[String],
    doc_freq: &HashMap<String, usize>,
    n_docs: f64,
    avg_doc_len: f64,
    max_phrase_occ: usize,
) -> f64 {
    let mut score = 0.0;

    if !query_phrase.is_empty() {
        if chunk.page_stem_lower == query_phrase || chunk.page_path_lower == query_phrase {
            score += 240.0;
        }
        if chunk.title_lower.contains(query_phrase) {
            score += 90.0;
        }
        if chunk.heading_lower.contains(query_phrase) {
            score += 45.0;
        }
        if chunk.schema_lower.contains(query_phrase) {
            score += 35.0;
        }
        let phrase_occ = count_occurrences(&chunk.text_lower, query_phrase).min(max_phrase_occ);
        score += phrase_occ as f64 * 22.0;
    }

    for token in query_tokens {
        let tf = *chunk.token_counts.get(token).unwrap_or(&0) as f64;
        let df = *doc_freq.get(token).unwrap_or(&0) as f64;
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
        if chunk.schema_lower.contains(token) {
            score += idf * 3.0;
        }
    }

    score
}

fn score_page_meta(
    meta: &PageMeta,
    query_phrase: &str,
    query_tokens: &[String],
    max_phrase_occ: usize,
) -> f64 {
    let mut score = 0.0;

    if !query_phrase.is_empty() {
        if meta.page_stem_lower == query_phrase || meta.page_path_lower == query_phrase {
            score += 240.0;
        }
        if meta.title_lower.contains(query_phrase) {
            score += 90.0;
        }
        if meta.schema_text.to_lowercase().contains(query_phrase) {
            score += 35.0;
        }
        let phrase_occ = count_occurrences(&meta.full_lower, query_phrase).min(max_phrase_occ);
        score += phrase_occ as f64 * 22.0;
    }

    for token in query_tokens {
        let tf = *meta.token_counts.get(token).unwrap_or(&0) as f64;
        if tf > 0.0 {
            score += tf.min(12.0);
        }
        if meta.title_lower.contains(token) {
            score += 7.0;
        }
        if meta.page_path_lower.contains(token) {
            score += 5.0;
        }
        if meta.schema_text.to_lowercase().contains(token) {
            score += 3.0;
        }
    }

    let length_penalty = (meta.token_len.max(1) as f64 / 1600.0).sqrt().clamp(1.0, 3.0);
    score / length_penalty
}

fn dedupe_scored_chunks(scored: Vec<ScoredChunk>, limit: usize) -> Vec<ScoredChunk> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for item in scored {
        if !seen.insert(chunk_key(&item.chunk)) {
            continue;
        }
        out.push(item);
        if out.len() >= limit {
            break;
        }
    }

    out
}

fn retrieved_from_index_chunk(chunk: &IndexChunk, score: f64, source: &str) -> RetrievedChunk {
    RetrievedChunk {
        page_path: chunk.page_path.clone(),
        page_title: chunk.page_title.clone(),
        chunk_index: chunk.chunk_index,
        heading_path: chunk.heading_path.clone(),
        chunk_text: chunk.chunk_text.clone(),
        distance: 1.0,
        score,
        source: source.to_string(),
        quality_multiplier: chunk.quality_multiplier,
    }
}

fn apply_index_metadata(index: &TokenIndex, chunks: &mut [RetrievedChunk]) {
    for chunk in chunks {
        let id = page_id(&chunk.page_path);
        if let Some(meta) = index.page_meta.get(&id) {
            chunk.quality_multiplier = meta.quality_multiplier;
            if chunk.page_title.trim().is_empty() {
                chunk.page_title = meta.title.clone();
            }
        }
    }
}

fn graph_expand(
    index: &TokenIndex,
    query: &str,
    vector_chunks: &[RetrievedChunk],
    token_chunks: &[ScoredChunk],
    limit: usize,
) -> Vec<ScoredChunk> {
    if index.page_meta.is_empty() {
        return vec![];
    }

    let mut seed_scores: HashMap<String, f64> = HashMap::new();
    for (rank0, chunk) in vector_chunks.iter().take(12).enumerate() {
        let id = page_id(&chunk.page_path);
        if index.page_meta.contains_key(&id) {
            let rank = rank0 + 1;
            *seed_scores.entry(id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
        }
    }
    for (rank0, scored) in token_chunks.iter().take(16).enumerate() {
        let id = page_id(&scored.chunk.page_path);
        if index.page_meta.contains_key(&id) {
            let rank = rank0 + 1;
            *seed_scores.entry(id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
        }
    }
    if seed_scores.is_empty() {
        return vec![];
    }

    let mut page_scores: HashMap<String, f64> = HashMap::new();
    for (seed_id, seed_weight) in &seed_scores {
        let Some(seed_meta) = index.page_meta.get(seed_id) else {
            continue;
        };
        for (target_id, target_meta) in &index.page_meta {
            if target_id == seed_id {
                continue;
            }
            let relevance = graph_relevance(seed_id, seed_meta, target_id, target_meta, index);
            if relevance <= 0.0 {
                continue;
            }
            let contribution = relevance * seed_weight;
            *page_scores.entry(target_id.clone()).or_insert(0.0) += contribution;
        }
    }

    let mut scored = Vec::new();
    for (page_id, graph_score) in page_scores {
        if graph_score <= 0.0 {
            continue;
        }
        if let Some(chunk) = best_chunk_for_page(index, &page_id, query, graph_score, "graph", 0.15) {
            scored.push(chunk);
        }
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

fn best_chunk_for_page(
    index: &TokenIndex,
    page_id: &str,
    query: &str,
    base_score: f64,
    source: &str,
    lexical_weight: f64,
) -> Option<ScoredChunk> {
    let meta = index.page_meta.get(page_id)?;
    let query_phrase = normalize_phrase(query);
    let query_tokens = tokenize_query(query);
    let n_docs = index.chunks.len() as f64;
    let avg_doc_len = index.avg_doc_len.max(1.0);

    let mut best: Option<(&IndexChunk, f64)> = None;
    if let Some(chunk_indices) = index.page_chunks.get(page_id) {
        for idx in chunk_indices {
            let Some(chunk) = index.chunks.get(*idx) else {
                continue;
            };
            let lexical_score = score_index_chunk(
                chunk,
                &query_phrase,
                &query_tokens,
                &index.doc_freq,
                n_docs,
                avg_doc_len,
                10,
            );
            let combined = lexical_score * lexical_weight + base_score;
            match best {
                Some((_, best_score)) if best_score >= combined => {}
                _ => best = Some((chunk, combined)),
            }
        }
    }

    if let Some((chunk, raw_score)) = best {
        return Some(ScoredChunk {
            raw_score,
            chunk: retrieved_from_index_chunk(chunk, raw_score, source),
        });
    }

    let chunk_text = page_excerpt(meta, &query_phrase, &query_tokens, 1800);
    Some(ScoredChunk {
        raw_score: base_score,
        chunk: RetrievedChunk {
            page_path: meta.page_path.clone(),
            page_title: meta.title.clone(),
            chunk_index: -1,
            heading_path: String::new(),
            chunk_text,
            distance: 1.0,
            score: base_score,
            source: source.to_string(),
            quality_multiplier: meta.quality_multiplier,
        },
    })
}

fn page_excerpt(
    meta: &PageMeta,
    query_phrase: &str,
    query_tokens: &[String],
    max_chars: usize,
) -> String {
    let anchor = if !query_phrase.is_empty() && meta.full_lower.contains(query_phrase) {
        Some(query_phrase)
    } else {
        query_tokens
            .iter()
            .find(|token| meta.full_lower.contains(token.as_str()))
            .map(|token| token.as_str())
    };

    let anchor_char = anchor
        .and_then(|needle| meta.full_lower.find(needle))
        .map(|byte_idx| meta.full_lower[..byte_idx].chars().count())
        .unwrap_or(0);

    let chars = meta.full_text.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return meta.full_text.clone();
    }

    let start = anchor_char.saturating_sub(max_chars / 3);
    let end = (start + max_chars).min(chars.len());
    chars[start..end].iter().collect()
}

fn graph_relevance(
    seed_id: &str,
    seed: &PageMeta,
    target_id: &str,
    target: &PageMeta,
    index: &TokenIndex,
) -> f64 {
    let mut score = 0.0;
    if seed.out_links.contains(target_id) {
        score += 3.0;
    }
    if index
        .in_links
        .get(seed_id)
        .map(|links| links.contains(target_id))
        .unwrap_or(false)
    {
        score += 3.0;
    }

    if !seed.sources.is_empty() && !target.sources.is_empty() {
        let seed_sources = seed.sources.iter().collect::<HashSet<_>>();
        let shared = target
            .sources
            .iter()
            .filter(|source| seed_sources.contains(source))
            .count();
        score += shared as f64 * 4.0;
    }

    let seed_neighbors = graph_neighbors(seed_id, seed, index);
    let target_neighbors = graph_neighbors(target_id, target, index);
    let common = seed_neighbors
        .intersection(&target_neighbors)
        .filter(|neighbor| neighbor.as_str() != seed_id && neighbor.as_str() != target_id)
        .count();
    score += common as f64 * 1.5;
    score += type_affinity(&seed.page_type, &target.page_type);
    score
}

fn graph_neighbors(id: &str, meta: &PageMeta, index: &TokenIndex) -> HashSet<String> {
    let mut out = meta.out_links.clone();
    if let Some(inbound) = index.in_links.get(id) {
        out.extend(inbound.iter().cloned());
    }
    out
}

fn type_affinity(a: &str, b: &str) -> f64 {
    match (a, b) {
        ("entity", "concept") | ("concept", "entity") => 1.2,
        ("concept", "synthesis") | ("synthesis", "concept") => 1.2,
        ("source", "source") | ("query", "query") => 0.5,
        ("entity", "entity") | ("concept", "concept") | ("synthesis", "synthesis") => 0.8,
        ("other", _) | (_, "other") => 0.5,
        _ => 1.0,
    }
}

pub async fn retrieve_chunks_for_query(
    state: &AppState,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> anyhow::Result<(Vec<RetrievedChunk>, u128)> {
    retrieve_chunks_for_query_with_options(state, project_path, query, top_k, true, true).await
}

pub async fn retrieve_chunks_for_query_with_options(
    state: &AppState,
    project_path: &str,
    query: &str,
    top_k: usize,
    use_token: bool,
    use_graph: bool,
) -> anyhow::Result<(Vec<RetrievedChunk>, u128)> {
    let t0 = std::time::Instant::now();
    let vector_limit = (top_k * VECTOR_RESULT_MULTIPLIER).max(top_k);
    let token_limit = (top_k * TOKEN_RESULT_MULTIPLIER).max(top_k);
    let graph_limit = (top_k * GRAPH_RESULT_MULTIPLIER).max(top_k);

    let mut vector_chunks = match embed_query(state, query).await {
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

    let index = if use_token {
        match get_token_index(project_path).await {
            Ok(index) => Some(index),
            Err(e) => {
                tracing::warn!("[RAG] token index load failed: {e}");
                None
            }
        }
    } else {
        None
    };

    if let Some(index) = index.as_deref() {
        apply_index_metadata(index, &mut vector_chunks);
    }

    let token_chunks = index
        .as_deref()
        .map(|index| score_token_index(index, query, token_limit))
        .unwrap_or_default();

    let graph_chunks = index
        .as_deref()
        .filter(|_| use_graph)
        .map(|index| graph_expand(index, query, &vector_chunks, &token_chunks, graph_limit))
        .unwrap_or_default();

    let chunks = fuse_chunks(vector_chunks, token_chunks, graph_chunks, top_k, query);
    Ok((chunks, t0.elapsed().as_millis()))
}

fn fuse_chunks(
    vector_chunks: Vec<RetrievedChunk>,
    token_chunks: Vec<ScoredChunk>,
    graph_chunks: Vec<ScoredChunk>,
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
            graph_rank: None,
            chunk,
            graph_score: 0.0,
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
            graph_rank: None,
            chunk: scored.chunk.clone(),
            graph_score: 0.0,
        });
        entry.token_rank = Some(rank);
        entry.token_score = entry.token_score.max(scored.raw_score);
        entry.rrf_score += 1.0 / (RRF_K + rank as f64);

        if entry.chunk.source == "vector" {
            entry.chunk = scored.chunk;
        }
    }

    for (rank0, scored) in graph_chunks.into_iter().enumerate() {
        let rank = rank0 + 1;
        let key = chunk_key(&scored.chunk);
        let entry = candidates.entry(key).or_insert_with(|| FusedCandidate {
            vector_score: 0.0,
            token_score: 0.0,
            graph_score: 0.0,
            rrf_score: 0.0,
            vector_rank: None,
            token_rank: None,
            graph_rank: None,
            chunk: scored.chunk.clone(),
        });
        entry.graph_rank = Some(rank);
        entry.graph_score = entry.graph_score.max(scored.raw_score);
        entry.rrf_score += 1.0 / (RRF_K + rank as f64);

        if entry.chunk.source == "vector" {
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
            chunk.source = match (candidate.vector_rank, candidate.token_rank, candidate.graph_rank) {
                (Some(_), Some(_), _) | (Some(_), _, Some(_)) | (_, Some(_), Some(_)) => "hybrid",
                (Some(_), None, None) => "vector",
                (None, Some(_), None) => "token",
                (None, None, Some(_)) => "graph",
                (None, None, None) => "unknown",
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
    let graph_norm = candidate.graph_score.clamp(0.0, 1.0);
    let base = candidate.rrf_score + token_norm * 0.035 + vector_norm * 0.012 + graph_norm * 0.02;
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
    let page_multiplier = if is_audit_page {
        0.55
    } else {
        1.0
    };
    page_multiplier * chunk.quality_multiplier
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

fn page_id(page_path: &str) -> String {
    page_stem(page_path.trim())
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
    let use_graph = body.use_graph.unwrap_or(true);

    let (chunks, retrieval_ms) = retrieve_chunks_for_query_with_options(
        &state,
        &body.project_path,
        &body.query,
        top_k,
        use_token,
        use_graph,
    )
    .await?;

    tracing::info!(
        "[RAG] query_len={} top_k={} chunks={} retrieval_ms={} token={} graph={}",
        body.query.len(),
        top_k,
        chunks.len(),
        retrieval_ms,
        use_token,
        use_graph
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
        "retrieval_mode": "hybrid_vector_chunk_page_graph_schema_rrf",
        "token_cache_loaded": token_cache_loaded,
        "needs_reindex": needs_reindex,
        "reason": reason,
    }))
}
