/*!
 * LLM proxy handlers — routes LLM and embedding requests through the
 * backend so the browser never calls external services directly.
 *
 * This solves two problems for intranet HTTPS deployments:
 *   1. Mixed Content: browser on HTTPS cannot fetch HTTP LLM services.
 *   2. CORS: LLM services may not whitelist the Wiki's origin.
 *
 * API:
 *   POST /api/llm/stream  – OpenAI-compatible SSE stream proxy
 *   POST /api/llm/embed   – OpenAI-compatible embedding proxy
 */

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    http::{StatusCode, header},
    Json,
    body::Body,
};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::state::AppState;

// ── Request types ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct StreamRequest {
    pub messages: Vec<Value>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    /// Optional model override — ignored when SERVER_CONFIG_LOCKED=true
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub struct EmbedRequest {
    /// Text to embed
    pub input: String,
}

#[derive(Serialize)]
pub struct EmbedResponse {
    pub embedding: Vec<f32>,
    pub model: String,
    pub usage: EmbedUsage,
}

#[derive(Serialize)]
pub struct EmbedUsage {
    pub prompt_tokens: u64,
    pub total_tokens: u64,
}

fn normalize_openai_vision_messages(messages: Vec<Value>) -> Vec<Value> {
    messages
        .into_iter()
        .map(|mut message| {
            let Some(content) = message.get_mut("content") else {
                return message;
            };
            let Some(blocks) = content.as_array_mut() else {
                return message;
            };

            for block in blocks.iter_mut() {
                let is_internal_image = block
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|t| t == "image")
                    .unwrap_or(false);
                if !is_internal_image {
                    continue;
                }

                let media_type = block
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/jpeg");
                let Some(data_base64) = block.get("dataBase64").and_then(Value::as_str) else {
                    continue;
                };

                *block = json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{media_type};base64,{data_base64}")
                    }
                });
            }

            message
        })
        .collect()
}

// ── POST /api/llm/stream ─────────────────────────────────────────────────────

/// Proxy an OpenAI-compatible chat completion stream to the configured
/// LLM backend. The SSE response is forwarded byte-for-byte so the
/// frontend's existing stream parser needs no changes.
pub async fn stream_chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StreamRequest>,
) -> Response {
    let cfg = &state.llm_config;

    let endpoint = match &cfg.endpoint {
        Some(e) => e.trim_end_matches('/').to_string(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "LLM endpoint not configured. Set LLM_ENDPOINT env var."})),
            )
                .into_response()
        }
    };

    // Model: use server config; allow user override only when not locked
    let model = if cfg.allow_user_override {
        body.model
            .filter(|m| !m.is_empty())
            .or_else(|| cfg.model.clone())
            .unwrap_or_default()
    } else {
        cfg.model.clone().unwrap_or_default()
    };

    let mut req_body = json!({
        "model": model,
        "messages": body.messages,
        "stream": true,
    });
    if let Some(t) = body.temperature {
        req_body["temperature"] = json!(t);
    }
    if let Some(m) = body.max_tokens {
        req_body["max_tokens"] = json!(m);
    }
    if let Some(p) = body.top_p {
        req_body["top_p"] = json!(p);
    }

    let url = format!("{endpoint}/chat/completions");
    tracing::info!("LLM proxy → {url} model={model}");

    let mut req = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");

    if let Some(key) = cfg.api_key() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let upstream = match req.json(&req_body).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("LLM proxy request failed: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("LLM request failed: {e}")})),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let body_text = upstream.text().await.unwrap_or_default();
        tracing::warn!("LLM upstream HTTP {status}: {body_text}");
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({"error": body_text})),
        )
            .into_response();
    }

    // Stream the SSE bytes straight through to the client.
    // map_err converts reqwest::Error → std::io::Error for Body::from_stream.
    let stream = upstream
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no") // disable nginx buffering if behind proxy
        .body(Body::from_stream(stream))
        .unwrap()
}

/// Proxy a vision-capable OpenAI-compatible chat completion stream to the
/// configured VISION_ENDPOINT. This keeps hosted vision API keys server-side
/// while allowing the browser ingest pipeline to send image content blocks.
pub async fn stream_vision_chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StreamRequest>,
) -> Response {
    let cfg = &state.llm_config;

    let endpoint = match &cfg.vision_endpoint {
        Some(e) => e.trim_end_matches('/').to_string(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Vision endpoint not configured. Set VISION_ENDPOINT env var."})),
            )
                .into_response()
        }
    };

    let model = cfg
        .vision_model
        .clone()
        .filter(|m| !m.is_empty())
        .or_else(|| body.model.filter(|m| !m.is_empty()))
        .unwrap_or_default();

    let mut req_body = json!({
        "model": model,
        "messages": normalize_openai_vision_messages(body.messages),
        "stream": true,
    });
    if let Some(t) = body.temperature {
        req_body["temperature"] = json!(t);
    }
    if let Some(m) = body.max_tokens {
        req_body["max_tokens"] = json!(m);
    }
    if let Some(p) = body.top_p {
        req_body["top_p"] = json!(p);
    }

    let url = format!("{endpoint}/chat/completions");
    tracing::info!("Vision proxy -> {url} model={model}");

    let mut req = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");

    if let Some(key) = cfg.vision_api_key() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let upstream = match req.json(&req_body).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Vision proxy request failed: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("Vision request failed: {e}")})),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let body_text = upstream.text().await.unwrap_or_default();
        tracing::warn!("Vision upstream HTTP {status}: {body_text}");
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({"error": body_text})),
        )
            .into_response();
    }

    let stream = upstream
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

// ── POST /api/llm/embed ──────────────────────────────────────────────────────

/// Proxy an OpenAI-compatible embedding request to the configured
/// embedding backend. Returns the embedding vector directly.
pub async fn embed(
    State(state): State<Arc<AppState>>,
    Json(body): Json<EmbedRequest>,
) -> Response {
    let cfg = &state.llm_config;

    let endpoint = match &cfg.embedding_endpoint {
        Some(e) => e.trim_end_matches('/').to_string(),
        None => {
            // Embedding not configured — return a clear error so the
            // frontend can fall back to BM25 keyword search gracefully.
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Embedding endpoint not configured. Set EMBEDDING_ENDPOINT env var."})),
            )
                .into_response();
        }
    };

    let model = cfg.embedding_model.clone().unwrap_or_default();
    let is_dashscope_multimodal = endpoint.contains("/multimodal-embedding/")
        || model.starts_with("tongyi-embedding-vision")
        || model == "qwen3-vl-embedding"
        || model == "qwen2.5-vl-embedding"
        || model == "multimodal-embedding-v1";
    let req_body = if is_dashscope_multimodal {
        json!({
            "model": model,
            "input": {
                "contents": [
                    { "text": body.input }
                ]
            }
        })
    } else {
        json!({
            "model": model,
            "input": body.input,
        })
    };

    tracing::debug!("Embedding proxy → {endpoint} model={model} input_len={}", body.input.len());

    let mut req = state
        .http_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    if let Some(key) = cfg.embedding_api_key() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let upstream = match req.json(&req_body).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Embedding proxy request failed: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("Embedding request failed: {e}")})),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let body_text = upstream.text().await.unwrap_or_default();
        tracing::warn!("Embedding upstream HTTP {status}: {body_text}");
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({"error": body_text})),
        )
            .into_response();
    }

    match upstream.json::<Value>().await {
        Ok(data) => {
            if is_dashscope_multimodal {
                if let Some(embedding) = data.pointer("/output/embeddings/0/embedding") {
                    let usage = data.get("usage").cloned().unwrap_or_else(|| json!({}));
                    let normalized = json!({
                        "object": "list",
                        "data": [
                            {
                                "object": "embedding",
                                "index": 0,
                                "embedding": embedding,
                            }
                        ],
                        "model": model,
                        "usage": usage,
                    });
                    return (StatusCode::OK, Json(normalized)).into_response();
                }
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error": "DashScope multimodal embedding response missing output.embeddings[0].embedding"})),
                )
                    .into_response();
            }
            (StatusCode::OK, Json(data)).into_response()
        },
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": format!("Failed to parse embedding response: {e}")})),
        )
            .into_response(),
    }
}
