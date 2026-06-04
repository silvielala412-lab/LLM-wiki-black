/*!
 * LanceDB vector store handlers.
 *
 * Schema (v2 — dynamic dimension):
 *   page_path    Utf8      — wiki page path (used as page_id)
 *   page_title   Utf8      — human-readable title
 *   chunk_index  Int32     — position within page
 *   heading_path Utf8      — breadcrumb, e.g. "保障范围 > 重疾类别"
 *   chunk_text   Utf8      — raw chunk content
 *   vector       FixedSizeList<f32>[dim]  — embedding vector
 *
 * Dimension is determined from the first upsert batch and recorded in
 * `.llm-wiki/vector-meta.json`. Mismatches are rejected — call
 * /api/vector/drop-legacy first when switching embedding models.
 *
 * search_chunks returns: page_path, page_title, chunk_index, heading_path,
 * chunk_text, distance, score (= 1 - distance for cosine).
 */

use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use lancedb::{connect, query::{ExecutableQuery, QueryBase}};
use arrow_array::{
    Float32Array, Int32Array, RecordBatch, StringArray, FixedSizeListArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use crate::error::Result;

const TABLE: &str = "chunks";
const META_FILE: &str = ".llm-wiki/vector-meta.json";

// ── Schema & metadata ─────────────────────────────────────────────────────────

fn db_path(project_path: &str) -> String {
    format!("{project_path}/.llm-wiki/lancedb")
}

fn schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_path",    DataType::Utf8, false),
        Field::new("page_title",   DataType::Utf8, false),
        Field::new("chunk_index",  DataType::Int32, false),
        Field::new("heading_path", DataType::Utf8, false),
        Field::new("chunk_text",   DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dim,
            ),
            true,
        ),
    ]))
}

#[derive(Serialize, Deserialize, Clone)]
struct VectorMeta {
    dim: i32,
    model: String,
}

fn meta_path(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path).join(META_FILE)
}

fn read_meta(project_path: &str) -> Option<VectorMeta> {
    let p = meta_path(project_path);
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_meta(project_path: &str, meta: &VectorMeta) -> anyhow::Result<()> {
    let p = meta_path(project_path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(p, serde_json::to_string_pretty(meta)?)?;
    Ok(())
}

// ── Request / response types ──────────────────────────────────────────────────

/// One chunk to embed and store.
#[derive(Deserialize)]
pub struct ChunkInput {
    pub chunk_index: i32,
    pub heading_path: String,
    pub chunk_text: String,
    pub vector: Vec<f32>,
}

/// Structured upsert — replaces the flat (page_path, chunks[], vectors[][]) API.
#[derive(Deserialize)]
pub struct UpsertBody {
    pub project_path: String,
    pub page_path: String,
    pub page_title: String,
    pub chunks: Vec<ChunkInput>,
}

#[derive(Deserialize)]
pub struct SearchBody {
    pub project_path: String,
    pub query_vector: Vec<f32>,
    pub limit: Option<usize>,
    pub filter_expr: Option<String>,
}

#[derive(Deserialize)]
pub struct PagePathBody {
    pub project_path: String,
    pub page_path: String,
}

#[derive(Deserialize)]
pub struct ProjectPathBody {
    pub project_path: String,
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn upsert_chunks(Json(body): Json<UpsertBody>) -> Result<Json<Value>> {
    if body.chunks.is_empty() {
        return Ok(Json(json!(0)));
    }

    // Validate: all vectors must have the same dimension, no silent resize.
    let dim = body.chunks[0].vector.len() as i32;
    for (i, chunk) in body.chunks.iter().enumerate() {
        let d = chunk.vector.len() as i32;
        if d != dim {
            return Err(anyhow::anyhow!(
                "chunk[{}] dim={} != batch dim={}. All chunks must share the same embedding dimension.",
                i, d, dim
            ).into());
        }
    }

    // Check / record vector-meta.json
    let pp = &body.project_path;
    if let Some(meta) = read_meta(pp) {
        if meta.dim != dim {
            return Err(anyhow::anyhow!(
                "Dimension mismatch: stored index has dim={}, new vectors have dim={}. \
                 Call POST /api/vector/drop-legacy first to rebuild the index.",
                meta.dim, dim
            ).into());
        }
    } else {
        // First upsert — record dimension
        write_meta(pp, &VectorMeta { dim, model: String::new() })?;
    }

    let db_path = db_path(pp);
    let db = connect(&db_path).execute().await?;

    // Delete old chunks for this page
    if let Ok(tbl) = db.open_table(TABLE).execute().await {
        let _ = tbl
            .delete(&format!("page_path = '{}'", body.page_path))
            .await;
    }

    let schema = schema(dim);
    let tbl = match db.open_table(TABLE).execute().await {
        Ok(t) => t,
        Err(_) => db.create_empty_table(TABLE, schema.clone()).execute().await?,
    };

    let n = body.chunks.len();
    let pages:    Vec<&str> = body.chunks.iter().map(|_| body.page_path.as_str()).collect();
    let titles:   Vec<&str> = body.chunks.iter().map(|_| body.page_title.as_str()).collect();
    let indices:  Vec<i32>  = body.chunks.iter().map(|c| c.chunk_index).collect();
    let headings: Vec<&str> = body.chunks.iter().map(|c| c.heading_path.as_str()).collect();
    let texts:    Vec<&str> = body.chunks.iter().map(|c| c.chunk_text.as_str()).collect();

    let mut flat: Vec<f32> = Vec::with_capacity(n * dim as usize);
    for chunk in &body.chunks {
        flat.extend(&chunk.vector);
    }

    let field  = Arc::new(Field::new("item", DataType::Float32, true));
    let values = Float32Array::from(flat);
    let vec_arr = FixedSizeListArray::try_new(field, dim, Arc::new(values), None)?;

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(StringArray::from(pages)),
            Arc::new(StringArray::from(titles)),
            Arc::new(Int32Array::from(indices)),
            Arc::new(StringArray::from(headings)),
            Arc::new(StringArray::from(texts)),
            Arc::new(vec_arr),
        ],
    )?;

    tbl.add(vec![batch]).execute().await?;
    Ok(Json(json!(n)))
}

pub async fn search_chunks(Json(body): Json<SearchBody>) -> Result<Json<Value>> {
    let db_path = db_path(&body.project_path);
    let db = match connect(&db_path).execute().await {
        Ok(d) => d,
        Err(_) => return Ok(Json(json!([]))),
    };
    let tbl = match db.open_table(TABLE).execute().await {
        Ok(t) => t,
        Err(_) => return Ok(Json(json!([]))),
    };

    let limit = body.limit.unwrap_or(10);
    let mut q = tbl.vector_search(body.query_vector)?.limit(limit);
    if let Some(filter) = &body.filter_expr {
        if !filter.is_empty() {
            q = q.only_if(filter.as_str());
        }
    }

    let batches: Vec<_> = q.execute().await?.try_collect().await?;
    let mut results: Vec<Value> = Vec::new();

    for batch in &batches {
        let page_paths = batch.column_by_name("page_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let page_titles = batch.column_by_name("page_title")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let chunk_indices = batch.column_by_name("chunk_index")
            .and_then(|c| c.as_any().downcast_ref::<Int32Array>());
        let heading_paths = batch.column_by_name("heading_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let texts = batch.column_by_name("chunk_text")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        // LanceDB appends _distance when doing vector search
        let distances = batch.column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

        if let (Some(pp), Some(pt), Some(ci), Some(hp), Some(tx)) =
            (page_paths, page_titles, chunk_indices, heading_paths, texts)
        {
            for i in 0..batch.num_rows() {
                let distance = distances.map(|d| d.value(i) as f64).unwrap_or(0.0);
                results.push(json!({
                    "page_path":    pp.value(i),
                    "page_title":   pt.value(i),
                    "chunk_index":  ci.value(i),
                    "heading_path": hp.value(i),
                    "chunk_text":   tx.value(i),
                    "distance":     distance,
                    "score":        1.0_f64 - distance,
                }));
            }
        }
    }

    Ok(Json(json!(results)))
}

pub async fn delete_page(Json(body): Json<PagePathBody>) -> Result<Json<Value>> {
    let db_path = db_path(&body.project_path);
    let db = match connect(&db_path).execute().await {
        Ok(d) => d,
        Err(_) => return Ok(Json(json!(0))),
    };
    if let Ok(tbl) = db.open_table(TABLE).execute().await {
        let _ = tbl.delete(&format!("page_path = '{}'", body.page_path)).await;
    }
    Ok(Json(json!(0)))
}

pub async fn count_chunks(Json(body): Json<ProjectPathBody>) -> Result<Json<Value>> {
    let db_path = db_path(&body.project_path);
    let db = match connect(&db_path).execute().await {
        Ok(d) => d,
        Err(_) => return Ok(Json(json!(0))),
    };
    if let Ok(tbl) = db.open_table(TABLE).execute().await {
        let n = tbl.count_rows(None).await.unwrap_or(0);
        return Ok(Json(json!(n)));
    }
    Ok(Json(json!(0)))
}

pub async fn drop_legacy(Json(body): Json<ProjectPathBody>) -> Result<Json<Value>> {
    let db_path = db_path(&body.project_path);
    // Drop LanceDB table
    if let Ok(db) = connect(&db_path).execute().await {
        let _ = db.drop_table(TABLE, &[]).await;
    }
    // Remove vector-meta.json so next upsert starts fresh
    let meta_p = meta_path(&body.project_path);
    let _ = std::fs::remove_file(meta_p);
    Ok(Json(json!(null)))
}

/// GET /api/vector/meta?project_path=...
/// Returns the current index metadata (dim, model) or null if not indexed.
pub async fn get_meta(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let pp = params.get("project_path").map(|s| s.as_str()).unwrap_or("");
    match read_meta(pp) {
        Some(m) => Json(json!({ "dim": m.dim, "model": m.model })),
        None    => Json(json!(null)),
    }
}

/// POST /api/vector/update-meta
/// Let the frontend record which embedding model was used after indexing.
#[derive(Deserialize)]
pub struct UpdateMetaBody {
    pub project_path: String,
    pub model: String,
}

pub async fn update_meta(Json(body): Json<UpdateMetaBody>) -> Result<Json<Value>> {
    let pp = &body.project_path;
    let mut meta = read_meta(pp).unwrap_or(VectorMeta { dim: 0, model: String::new() });
    meta.model = body.model;
    write_meta(pp, &meta)?;
    Ok(Json(json!({ "dim": meta.dim, "model": meta.model })))
}
