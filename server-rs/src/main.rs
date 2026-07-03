use axum::{
    extract::DefaultBodyLimit,
    extract::Request,
    http::{header, HeaderValue, Method},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::net::TcpListener;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::info;

mod error;
mod handlers;
mod state;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let loaded_env = load_dotenv();

    // Tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "llm_wiki_server=info,tower_http=warn".into()),
        )
        .init();

    if let Some(path) = loaded_env {
        info!("Loaded environment file: {}", path.display());
    }

    let port: u16 = std::env::var("APP_PORT")
        .unwrap_or_else(|_| "8000".into())
        .parse()
        .unwrap_or(8000);

    let host = std::env::var("APP_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let data_root = std::env::var("WIKI_DATA_PATH").unwrap_or_else(|_| "./data".into());
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "./dist".into());

    let llm_config = state::LlmServerConfig::from_env();
    info!(
        "Server LLM config: provider={:?} model={:?} has_key={} vision={:?} ocr_endpoint={}",
        llm_config.provider,
        llm_config.model,
        llm_config.has_api_key,
        llm_config.vision_endpoint,
        llm_config.has_ocr_endpoint
    );

    let state = Arc::new(AppState::new(PathBuf::from(&data_root), llm_config));

    info!("Wiki data root: {data_root}");
    info!("Allowed wiki data roots: {:?}", state.allowed_data_roots);
    info!("Serving frontend from: {static_dir}");

    // CORS — allow all for intranet
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);

    // API routes
    let api = Router::new()
        .route("/health", get(handlers::health::health))
        .route("/config", get(handlers::config::get_config))
        // File system
        .route("/fs/read", post(handlers::fs::read_file))
        .route("/fs/write", post(handlers::fs::write_file))
        .route("/fs/list", post(handlers::fs::list_directory))
        .route("/fs/exists", post(handlers::fs::file_exists))
        .route("/fs/delete", post(handlers::fs::delete_file))
        .route("/fs/mkdir", post(handlers::fs::create_directory))
        .route("/fs/copy", post(handlers::fs::copy_file))
        .route("/fs/copy-dir", post(handlers::fs::copy_directory))
        .route("/fs/preprocess", post(handlers::fs::preprocess_file))
        .route("/fs/read-base64", post(handlers::fs::read_file_base64))
        .route(
            "/fs/related-wiki-pages",
            post(handlers::fs::related_wiki_pages),
        )
        .route("/fs/media", get(handlers::fs::serve_media))
        .route(
            "/fs/clip-server-status",
            get(handlers::fs::clip_server_status),
        )
        // Project
        .route("/project/list", get(handlers::project::list_projects))
        .route("/project/open", post(handlers::project::open_project))
        .route("/project/create", post(handlers::project::create_project))
        .route(
            "/project/create-auto",
            post(handlers::project::create_project_auto),
        )
        // Vector store
        .route(
            "/vector/upsert-chunks",
            post(handlers::vector::upsert_chunks),
        )
        .route(
            "/vector/search-chunks",
            post(handlers::vector::search_chunks),
        )
        .route("/vector/delete-page", post(handlers::vector::delete_page))
        .route("/vector/count-chunks", post(handlers::vector::count_chunks))
        .route("/vector/drop-legacy", post(handlers::vector::drop_legacy))
        .route("/vector/meta", get(handlers::vector::get_meta))
        .route("/vector/update-meta", post(handlers::vector::update_meta))
        // RAG retrieval — backend search pipeline (Phase 1: vector; Phase 2+: BM25+graph)
        .route("/rag/retrieve", post(handlers::rag::retrieve))
        .route("/rag/status", get(handlers::rag::status))
        .route("/chat/stream", post(handlers::chat::stream_chat))
        // Upload — allow up to 200 MB per request (axum default is 2 MB)
        .route("/upload/file", post(handlers::upload::upload_file))
        .route("/upload/files", post(handlers::upload::upload_files))
        // Product-catalog batch ingestion (manual UI and external systems share this API)
        .route(
            "/ingest/product-batches",
            post(handlers::ingest::create_batch).get(handlers::ingest::list_batches),
        )
        .route(
            "/ingest/product-batches/{batch_id}",
            get(handlers::ingest::get_batch),
        )
        .route(
            "/ingest/product-batches/{batch_id}/files",
            post(handlers::ingest::upload_batch_file),
        )
        .route(
            "/ingest/product-batches/{batch_id}/start",
            post(handlers::ingest::start_batch),
        )
        .route(
            "/ingest/product-batches/{batch_id}/retry",
            post(handlers::ingest::retry_batch),
        )
        .route(
            "/ingest/product-batches/events",
            get(handlers::ingest::batch_events),
        )
        .route(
            "/ingest/product-refinements",
            post(handlers::ingest::create_refinement_job),
        )
        .route(
            "/ingest/product-refinements/{job_id}",
            get(handlers::ingest::get_refinement_job),
        )
        // LLM / Embedding proxy (solves Mixed Content + CORS for HTTPS deployments)
        .route("/llm/stream", post(handlers::llm::stream_chat))
        .route(
            "/llm/vision-stream",
            post(handlers::llm::stream_vision_chat),
        )
        .route("/llm/embed", post(handlers::llm::embed))
        // Web search proxy (routes Tavily/Perplexity calls through the server)
        .route("/search/web", post(handlers::search::web_search))
        // Auth (public — no JWT required)
        .route("/auth/register", post(handlers::auth::register))
        .route("/auth/login", post(handlers::auth::login))
        .route("/auth/logout", post(handlers::auth::logout))
        .route("/auth/me", get(handlers::auth::me))
        .with_state(state);

    // SPA fallback — serve React app for all non-API routes
    let spa = ServeDir::new(&static_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeDir::new(&static_dir).append_index_html_on_directories(true));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .layer(DefaultBodyLimit::max(200 * 1024 * 1024)) // 200 MB — covers large PDF uploads
        .layer(middleware::from_fn(no_cache_headers))
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    info!("LLM Wiki server listening on http://{addr}");

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn load_dotenv() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(".env"));
        candidates.push(cwd.join("server-rs").join(".env"));
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(4) {
            candidates.push(ancestor.join(".env"));
        }
    }

    let mut seen = std::collections::HashSet::new();
    for path in candidates {
        if !path.is_file() || !seen.insert(path.clone()) {
            continue;
        }
        match dotenvy::from_path_iter(&path) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let (key, value) = entry;
                    if std::env::var_os(&key).is_none() {
                        std::env::set_var(key, value);
                    }
                }
                return Some(path);
            }
            Err(error) => {
                eprintln!("Failed to load {}: {error}", path.display());
            }
        }
    }
    None
}

async fn no_cache_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
    );
    response
}
