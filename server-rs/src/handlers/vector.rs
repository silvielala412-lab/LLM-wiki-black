/*!
 * LanceDB vector store handlers.
 * Mirrors src-tauri/src/commands/vectorstore.rs — identical schema.
 */

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use lancedb::{connect, query::{ExecutableQuery, QueryBase}};
use arrow_array::{
    Float32Array, RecordBatch, StringArray, FixedSizeListArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use crate::error::Result;

const TABLE: &str = "chunks";

fn db_path(project_path: &str) -> String {
    format!("{project_path}/.llm-wiki/lancedb")
}

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_path", DataType::Utf8, false),
        Field::new("chunk_text", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 384),
            true,
        ),
    ]))
}

#[derive(Deserialize)]
pub struct UpsertBody {
    pub project_path: String,
    pub page_path: String,
    pub chunks: Vec<String>,
    pub vectors: Vec<Vec<f32>>,
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

pub async fn upsert_chunks(Json(body): Json<UpsertBody>) -> Result<Json<Value>> {
    let db_path = db_path(&body.project_path);
    let db = connect(&db_path).execute().await?;

    // Delete existing chunks for this page
    let tbl = db.open_table(TABLE).execute().await;
    if let Ok(tbl) = tbl {
        let _ = tbl
            .delete(&format!("page_path = '{}'", body.page_path))
            .await;
    }

    if body.chunks.is_empty() {
        return Ok(Json(json!(0)));
    }

    let schema = schema();
    let tbl = match db.open_table(TABLE).execute().await {
        Ok(t) => t,
        Err(_) => db.create_empty_table(TABLE, schema.clone()).execute().await?,
    };

    let dim = 384i32;
    let mut flat_vectors: Vec<f32> = Vec::new();
    for v in &body.vectors {
        let mut padded = v.clone();
        padded.resize(dim as usize, 0.0);
        flat_vectors.extend(padded);
    }

    let n = body.chunks.len();
    let pages: Vec<&str> = body.chunks.iter().map(|_| body.page_path.as_str()).collect();
    let texts: Vec<&str> = body.chunks.iter().map(|c| c.as_str()).collect();

    let field = Arc::new(Field::new("item", DataType::Float32, true));
    let values = Float32Array::from(flat_vectors);
    let vector_array = FixedSizeListArray::try_new(field, dim, Arc::new(values), None)?;

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(StringArray::from(pages)),
            Arc::new(StringArray::from(texts)),
            Arc::new(vector_array),
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
        let pages = batch.column_by_name("page_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let texts = batch.column_by_name("chunk_text")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());

        if let (Some(p), Some(t)) = (pages, texts) {
            for i in 0..batch.num_rows() {
                results.push(json!({
                    "page_path": p.value(i),
                    "chunk_text": t.value(i),
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
    if let Ok(db) = connect(&db_path).execute().await {
        let _ = db.drop_table(TABLE, &[]).await;
    }
    Ok(Json(json!(null)))
}
