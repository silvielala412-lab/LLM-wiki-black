use axum::{extract::State, Json};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::state::AppState;
use crate::error::Result;

/// GET /api/config
///
/// Returns the server-level LLM / embedding / vision configuration so the
/// frontend can pre-fill Settings without asking every user to type keys and
/// endpoints manually.
///
/// Sensitive fields (api_key) are NEVER included — only a boolean
/// `has_api_key` is returned so the frontend can show "🔑 Configured by
/// admin" instead of a blank input.
pub async fn get_config(State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    let cfg = &state.llm_config;

    Ok(Json(json!({
        // Main LLM
        "llm": {
            "provider":         cfg.provider,
            "has_api_key":      cfg.has_api_key,
            "model":            cfg.model,
            "endpoint":         cfg.endpoint,
            "api_mode":         cfg.api_mode,
            "max_context_size": cfg.max_context_size,
        },
        // Embedding
        "embedding": {
            "endpoint": cfg.embedding_endpoint,
            "model":    cfg.embedding_model,
            "has_api_key": cfg.has_embedding_api_key,
        },
        // Vision / multimodal (for image-PDF OCR)
        "vision": {
            "endpoint": cfg.vision_endpoint,
            "model":    cfg.vision_model,
            "has_api_key": cfg.has_vision_api_key,
        },
        // PDF processing
        "pdf": {
            "dpi": cfg.pdf_dpi,
            "ocr_mode": cfg.pdf_ocr_mode,
        },
        // Web search
        "search": {
            "provider": std::env::var("SEARCH_PROVIDER").ok(),
            "has_api_key": std::env::var("SEARCH_API_KEY").ok().filter(|v| !v.is_empty()).is_some(),
        },
        // Frontend behaviour
        "allow_user_override": cfg.allow_user_override,
    })))
}
