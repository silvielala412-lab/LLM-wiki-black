use axum::{
    Router,
    routing::{get, post},
    extract::State,
    response::{Json, IntoResponse},
    http::{StatusCode, Method, header},
};
use tower_http::{
    cors::{CorsLayer, Any},
    fs::ServeDir,
};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::net::TcpListener;
use tracing::info;

mod handlers;
mod state;
mod error;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env if present
    let _ = dotenvy::dotenv();

    // Tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "llm_wiki_server=info,tower_http=warn".into()),
        )
        .init();

    let port: u16 = std::env::var("APP_PORT")
        .unwrap_or_else(|_| "8000".into())
        .parse()
        .unwrap_or(8000);

    let host = std::env::var("APP_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let data_root = std::env::var("WIKI_DATA_PATH").unwrap_or_else(|_| "./data".into());
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "./dist".into());

    let state = Arc::new(AppState {
        data_root: PathBuf::from(&data_root),
    });

    info!("Wiki data root: {data_root}");
    info!("Serving frontend from: {static_dir}");

    // CORS — allow all for intranet
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);

    // API routes
    let api = Router::new()
        .route("/health", get(handlers::health::health))
        // File system
        .route("/fs/read",     post(handlers::fs::read_file))
        .route("/fs/write",    post(handlers::fs::write_file))
        .route("/fs/list",     post(handlers::fs::list_directory))
        .route("/fs/exists",   post(handlers::fs::file_exists))
        .route("/fs/delete",   post(handlers::fs::delete_file))
        .route("/fs/mkdir",    post(handlers::fs::create_directory))
        .route("/fs/copy",     post(handlers::fs::copy_file))
        .route("/fs/copy-dir", post(handlers::fs::copy_directory))
        .route("/fs/preprocess", post(handlers::fs::preprocess_file))
        .route("/fs/read-base64", post(handlers::fs::read_file_base64))
        .route("/fs/related-wiki-pages", post(handlers::fs::related_wiki_pages))
        .route("/fs/media",    get(handlers::fs::serve_media))
        // Project
        .route("/project/list",        get(handlers::project::list_projects))
        .route("/project/open",        post(handlers::project::open_project))
        .route("/project/create",      post(handlers::project::create_project))
        .route("/project/create-auto", post(handlers::project::create_project_auto))
        // Vector store
        .route("/vector/upsert-chunks",  post(handlers::vector::upsert_chunks))
        .route("/vector/search-chunks",  post(handlers::vector::search_chunks))
        .route("/vector/delete-page",    post(handlers::vector::delete_page))
        .route("/vector/count-chunks",   post(handlers::vector::count_chunks))
        .route("/vector/drop-legacy",    post(handlers::vector::drop_legacy))
        // Upload
        .route("/upload/file",  post(handlers::upload::upload_file))
        .route("/upload/files", post(handlers::upload::upload_files))
        .with_state(state);

    // SPA fallback — serve React app for all non-API routes
    let spa = ServeDir::new(&static_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeDir::new(&static_dir).append_index_html_on_directories(true));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .layer(cors);

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    info!("LLM Wiki server listening on http://{addr}");

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
