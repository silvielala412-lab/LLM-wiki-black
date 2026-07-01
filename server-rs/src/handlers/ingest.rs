use axum::{
    extract::{Multipart, Path as AxumPath, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::{io::AsyncWriteExt, process::Command};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::state::AppState;

const ALLOWED_CATEGORIES: &[&str] = &["医疗险", "重疾险", "意外医疗险", "意外险", "寿险", "年金险"];
const ALLOWED_EXTENSIONS: &[&str] = &[
    "pdf", "xlsx", "xls", "docx", "doc", "pptx", "ppt", "txt", "md", "mdx", "csv", "json", "png",
    "jpg", "jpeg", "gif", "webp", "html", "htm", "rtf", "epub", "yaml", "yml",
];
const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
const BATCHES_DIR: &str = ".llm-wiki/ingest-batches";
const BATCH_FILE: &str = "batch.json";
const RESULT_FILE: &str = "worker-result.json";
const PRODUCT_MANIFEST: &str = "__product_bundle__.json";

#[derive(Debug)]
pub struct IngestApiError {
    status: StatusCode,
    message: String,
}

impl IngestApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl IntoResponse for IngestApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

type ApiResult<T> = std::result::Result<T, IngestApiError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProductBatchStatus {
    Uploading,
    Ready,
    Queued,
    Processing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductBatchFile {
    pub file_id: String,
    pub name: String,
    pub relative_path: String,
    pub stored_path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductIngestBatch {
    pub batch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_batch_id: Option<String>,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub product_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_code: Option<String>,
    pub insurance_category: String,
    pub duplicate_policy: String,
    pub status: ProductBatchStatus,
    pub files: Vec<ProductBatchFile>,
    #[serde(default)]
    pub written_files: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProductBatchRequest {
    pub project_name: String,
    pub product_name: String,
    pub insurance_category: String,
    pub product_code: Option<String>,
    pub client_batch_id: Option<String>,
    pub duplicate_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UploadBatchFileQuery {
    pub relative_path: Option<String>,
    pub document_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListBatchesQuery {
    pub project_name: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct BatchEventsQuery {
    pub project_name: String,
}

#[derive(Debug, Deserialize)]
struct ProjectIdentity {
    id: String,
}

#[derive(Debug, Serialize)]
struct NewProjectIdentity {
    id: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
}

#[derive(Debug, Deserialize)]
struct WorkerResult {
    #[serde(default)]
    written_files: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
    error: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn emit_batch_event(state: &AppState, batch: &ProductIngestBatch) {
    if let Ok(payload) = serde_json::to_string(batch) {
        let _ = state.ingest_events.send(payload);
    }
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn validate_name(label: &str, value: &str, max_chars: usize) -> ApiResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(IngestApiError::bad_request(format!("{label} is required")));
    }
    if trimmed.chars().count() > max_chars {
        return Err(IngestApiError::bad_request(format!("{label} is too long")));
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(IngestApiError::bad_request(format!(
            "{label} contains invalid path characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn project_display_name(path: &Path) -> String {
    let project_file = path.join("project.json");
    if let Ok(raw) = fs::read_to_string(project_file) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if let Some(name) = value.get("name").and_then(Value::as_str) {
                return name.to_string();
            }
        }
    }
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn ensure_project_identity(project_path: &Path) -> ApiResult<String> {
    let identity_path = project_path.join(".llm-wiki/project.json");
    if let Ok(raw) = fs::read_to_string(&identity_path) {
        if let Ok(identity) = serde_json::from_str::<ProjectIdentity>(&raw) {
            if !identity.id.trim().is_empty() {
                return Ok(identity.id);
            }
        }
    }

    let id = Uuid::new_v4().to_string();
    let identity = NewProjectIdentity {
        id: id.clone(),
        created_at: Utc::now().timestamp_millis(),
    };
    let parent = identity_path
        .parent()
        .ok_or_else(|| IngestApiError::internal("Invalid project identity path"))?;
    fs::create_dir_all(parent).map_err(IngestApiError::internal)?;
    fs::write(
        identity_path,
        serde_json::to_vec_pretty(&identity).map_err(IngestApiError::internal)?,
    )
    .map_err(IngestApiError::internal)?;
    Ok(id)
}

fn resolve_project(data_root: &Path, project_name: &str) -> ApiResult<(PathBuf, String)> {
    let requested = project_name.trim();
    if requested.is_empty() {
        return Err(IngestApiError::bad_request("project_name is required"));
    }
    let entries = fs::read_dir(data_root).map_err(IngestApiError::internal)?;
    let mut matches = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let hidden = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.starts_with('.'))
            .unwrap_or(false);
        if hidden {
            continue;
        }
        if project_display_name(&path).eq_ignore_ascii_case(requested) {
            matches.push(path);
        }
    }
    match matches.len() {
        0 => Err(IngestApiError::not_found(format!(
            "Project '{requested}' does not exist"
        ))),
        1 => {
            let path = matches.remove(0);
            let id = ensure_project_identity(&path)?;
            Ok((path, id))
        }
        _ => Err(IngestApiError::conflict(format!(
            "Project name '{requested}' is ambiguous; project names must be globally unique"
        ))),
    }
}

fn batch_file(project_path: &Path, batch_id: &str) -> PathBuf {
    project_path
        .join(BATCHES_DIR)
        .join(batch_id)
        .join(BATCH_FILE)
}

fn find_batch_file(data_root: &Path, batch_id: &str) -> ApiResult<PathBuf> {
    if Uuid::parse_str(batch_id).is_err() {
        return Err(IngestApiError::bad_request("Invalid batch_id"));
    }
    for entry in fs::read_dir(data_root)
        .map_err(IngestApiError::internal)?
        .flatten()
    {
        if !entry.path().is_dir() {
            continue;
        }
        let candidate = batch_file(&entry.path(), batch_id);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(IngestApiError::not_found(format!(
        "Batch '{batch_id}' was not found"
    )))
}

fn read_batch(path: &Path) -> ApiResult<ProductIngestBatch> {
    let raw = fs::read(path).map_err(IngestApiError::internal)?;
    serde_json::from_slice(&raw).map_err(IngestApiError::internal)
}

fn write_batch(path: &Path, batch: &ProductIngestBatch) -> ApiResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| IngestApiError::internal("Invalid batch path"))?;
    fs::create_dir_all(parent).map_err(IngestApiError::internal)?;
    fs::write(
        path,
        serde_json::to_vec_pretty(batch).map_err(IngestApiError::internal)?,
    )
    .map_err(IngestApiError::internal)
}

fn list_project_batches(project_path: &Path) -> ApiResult<Vec<ProductIngestBatch>> {
    let root = project_path.join(BATCHES_DIR);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut batches = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(IngestApiError::internal)?
        .flatten()
    {
        let path = entry.path().join(BATCH_FILE);
        if let Ok(batch) = read_batch(&path) {
            batches.push(batch);
        }
    }
    batches.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(batches)
}

fn safe_relative_upload_path(
    requested: Option<&str>,
    fallback_name: &str,
    product_name: &str,
) -> ApiResult<PathBuf> {
    let raw = requested
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name);
    let normalized = raw.replace('\\', "/");
    let mut parts: Vec<String> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if parts
        .first()
        .map(|part| part == product_name)
        .unwrap_or(false)
        && parts.len() > 1
    {
        parts.remove(0);
    }
    if parts.is_empty() {
        return Err(IngestApiError::bad_request("relative_path is empty"));
    }
    let mut result = PathBuf::new();
    for part in parts {
        if part == "."
            || part == ".."
            || Path::new(&part)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return Err(IngestApiError::bad_request(
                "relative_path contains invalid components",
            ));
        }
        result.push(part);
    }
    Ok(result)
}

async fn sha256_file(path: &Path) -> ApiResult<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(IngestApiError::internal)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = tokio::io::AsyncReadExt::read(&mut file, &mut buffer)
            .await
            .map_err(IngestApiError::internal)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub async fn create_batch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProductBatchRequest>,
) -> ApiResult<impl IntoResponse> {
    let product_name = validate_name("product_name", &body.product_name, 160)?;
    let category = body.insurance_category.trim().to_string();
    if !ALLOWED_CATEGORIES.contains(&category.as_str()) {
        return Err(IngestApiError::bad_request(format!(
            "Unsupported insurance_category '{}'; allowed values: {}",
            category,
            ALLOWED_CATEGORIES.join(", ")
        )));
    }
    let duplicate_policy = body.duplicate_policy.unwrap_or_else(|| "merge".to_string());
    if !matches!(duplicate_policy.as_str(), "reject" | "merge") {
        return Err(IngestApiError::bad_request(
            "duplicate_policy must be reject or merge",
        ));
    }
    let project_name = body.project_name.trim().to_string();
    let (project_path, project_id) = resolve_project(&state.data_root, &project_name)?;

    let _store_guard = state.ingest_store_lock.lock().await;
    if let Some(client_batch_id) = body
        .client_batch_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if let Some(existing) = list_project_batches(&project_path)?
            .into_iter()
            .find(|batch| batch.client_batch_id.as_deref() == Some(client_batch_id))
        {
            return Ok((StatusCode::OK, Json(existing)));
        }
    }

    let batch_id = Uuid::new_v4().to_string();
    let timestamp = now();
    let batch = ProductIngestBatch {
        batch_id: batch_id.clone(),
        client_batch_id: body
            .client_batch_id
            .filter(|value| !value.trim().is_empty()),
        project_id,
        project_name,
        project_path: normalized_path(&project_path),
        product_name,
        product_code: body.product_code.filter(|value| !value.trim().is_empty()),
        insurance_category: category,
        duplicate_policy,
        status: ProductBatchStatus::Uploading,
        files: Vec::new(),
        written_files: Vec::new(),
        warnings: Vec::new(),
        manifest_path: None,
        error: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        started_at: None,
        completed_at: None,
    };
    write_batch(&batch_file(&project_path, &batch_id), &batch)?;
    emit_batch_event(&state, &batch);
    Ok((StatusCode::CREATED, Json(batch)))
}

pub async fn list_batches(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListBatchesQuery>,
) -> ApiResult<Json<Vec<ProductIngestBatch>>> {
    let (project_path, _) = resolve_project(&state.data_root, &query.project_name)?;
    let _store_guard = state.ingest_store_lock.lock().await;
    let mut batches = list_project_batches(&project_path)?;
    batches.truncate(query.limit.unwrap_or(50).clamp(1, 5000));
    Ok(Json(batches))
}

pub async fn get_batch(
    State(state): State<Arc<AppState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> ApiResult<Json<ProductIngestBatch>> {
    let path = find_batch_file(&state.data_root, &batch_id)?;
    let _store_guard = state.ingest_store_lock.lock().await;
    Ok(Json(read_batch(&path)?))
}

pub async fn batch_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BatchEventsQuery>,
) -> ApiResult<impl IntoResponse> {
    let (_, _) = resolve_project(&state.data_root, &query.project_name)?;
    let project_name = query.project_name.trim().to_string();
    let receiver = state.ingest_events.subscribe();
    let stream = futures::stream::unfold(
        (receiver, project_name),
        |(mut receiver, project_name)| async move {
            loop {
                match receiver.recv().await {
                    Ok(payload) => {
                        let matches_project = serde_json::from_str::<ProductIngestBatch>(&payload)
                            .map(|batch| batch.project_name.eq_ignore_ascii_case(&project_name))
                            .unwrap_or(false);
                        if matches_project {
                            let event = Event::default().event("batch").data(payload);
                            return Some((Ok::<Event, Infallible>(event), (receiver, project_name)));
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn upload_batch_file(
    State(state): State<Arc<AppState>>,
    AxumPath(batch_id): AxumPath<String>,
    Query(query): Query<UploadBatchFileQuery>,
    mut multipart: Multipart,
) -> ApiResult<impl IntoResponse> {
    let path = find_batch_file(&state.data_root, &batch_id)?;
    let batch = {
        let _store_guard = state.ingest_store_lock.lock().await;
        read_batch(&path)?
    };
    if !matches!(
        batch.status,
        ProductBatchStatus::Uploading | ProductBatchStatus::Ready | ProductBatchStatus::Failed
    ) {
        return Err(IngestApiError::conflict(
            "Files cannot be uploaded after processing has started",
        ));
    }

    let mut uploaded: Option<ProductBatchFile> = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(IngestApiError::internal)?
    {
        if field.name() != Some("file") {
            continue;
        }
        let original_name = field.file_name().unwrap_or("upload").to_string();
        let relative_path = safe_relative_upload_path(
            query.relative_path.as_deref(),
            &original_name,
            &batch.product_name,
        )?;
        let extension = relative_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
            return Err(IngestApiError::bad_request(format!(
                "File type '.{extension}' is not allowed"
            )));
        }

        let project_path = PathBuf::from(&batch.project_path);
        let product_root = project_path
            .join("raw/sources/产品")
            .join(&batch.insurance_category)
            .join(&batch.product_name);
        let destination = product_root.join(&relative_path);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(IngestApiError::internal)?;
        }
        let temp_path = destination.with_extension(format!("{}.uploading", extension));
        let mut output = tokio::fs::File::create(&temp_path)
            .await
            .map_err(IngestApiError::internal)?;
        let mut size = 0_u64;
        let mut hasher = Sha256::new();
        while let Some(chunk) = field.chunk().await.map_err(IngestApiError::internal)? {
            size += chunk.len() as u64;
            if size > MAX_FILE_BYTES {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(IngestApiError::bad_request("File exceeds 200 MB limit"));
            }
            hasher.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(IngestApiError::internal)?;
        }
        output.flush().await.map_err(IngestApiError::internal)?;
        drop(output);
        let digest = hex::encode(hasher.finalize());

        if destination.is_file() {
            let existing_digest = sha256_file(&destination).await?;
            if existing_digest == digest {
                let _ = tokio::fs::remove_file(&temp_path).await;
            } else if batch.duplicate_policy == "reject" {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(IngestApiError::conflict(format!(
                    "File '{}' already exists with different content",
                    relative_path.display()
                )));
            } else {
                tokio::fs::remove_file(&destination)
                    .await
                    .map_err(IngestApiError::internal)?;
                tokio::fs::rename(&temp_path, &destination)
                    .await
                    .map_err(IngestApiError::internal)?;
            }
        } else {
            tokio::fs::rename(&temp_path, &destination)
                .await
                .map_err(IngestApiError::internal)?;
        }

        uploaded = Some(ProductBatchFile {
            file_id: Uuid::new_v4().to_string(),
            name: destination
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&original_name)
                .to_string(),
            relative_path: normalized_path(&relative_path),
            stored_path: normalized_path(&destination),
            size,
            sha256: digest,
            document_type: query
                .document_type
                .clone()
                .filter(|value| !value.trim().is_empty()),
        });
        break;
    }

    let file = uploaded
        .ok_or_else(|| IngestApiError::bad_request("Multipart field 'file' is required"))?;
    let updated = {
        let _store_guard = state.ingest_store_lock.lock().await;
        let mut current = read_batch(&path)?;
        current
            .files
            .retain(|item| item.stored_path != file.stored_path);
        current.files.push(file.clone());
        current.status = ProductBatchStatus::Ready;
        current.error = None;
        current.updated_at = now();
        write_batch(&path, &current)?;
        current
    };
    emit_batch_event(&state, &updated);
    info!(batch_id = %batch_id, file = %file.name, size = file.size, "Product batch file uploaded");
    Ok((
        StatusCode::CREATED,
        Json(json!({ "batch": updated, "file": file })),
    ))
}

fn write_product_manifest(batch: &mut ProductIngestBatch) -> ApiResult<PathBuf> {
    if batch.files.is_empty() {
        return Err(IngestApiError::bad_request(
            "At least one file must be uploaded before start",
        ));
    }
    let project_path = PathBuf::from(&batch.project_path);
    let product_root = project_path
        .join("raw/sources/产品")
        .join(&batch.insurance_category)
        .join(&batch.product_name);
    fs::create_dir_all(&product_root).map_err(IngestApiError::internal)?;
    let manifest_path = product_root.join(PRODUCT_MANIFEST);
    let files: Vec<Value> = batch
        .files
        .iter()
        .map(|file| {
            let stored = PathBuf::from(&file.stored_path);
            let relative_to_project = stored
                .strip_prefix(&project_path)
                .map(normalized_path)
                .unwrap_or_else(|_| file.stored_path.clone());
            json!({
                "name": file.name,
                "path": relative_to_project,
                "size": file.size,
                "original_relative_path": file.relative_path,
                "sha256": file.sha256,
                "document_type": file.document_type,
            })
        })
        .collect();
    let manifest = json!({
        "kind": "product_catalog_bundle",
        "version": 1,
        "batch_id": batch.batch_id,
        "project_id": batch.project_id,
        "insurance_category": batch.insurance_category,
        "product_name": batch.product_name,
        "product_code": batch.product_code,
        "created_at": batch.created_at,
        "files": files,
    });
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).map_err(IngestApiError::internal)?,
    )
    .map_err(IngestApiError::internal)?;
    batch.manifest_path = Some(normalized_path(&manifest_path));
    Ok(manifest_path)
}

async fn queue_batch(
    state: Arc<AppState>,
    path: PathBuf,
    allow_retry: bool,
) -> ApiResult<ProductIngestBatch> {
    let batch = {
        let _store_guard = state.ingest_store_lock.lock().await;
        let mut batch = read_batch(&path)?;
        let allowed = matches!(
            batch.status,
            ProductBatchStatus::Ready | ProductBatchStatus::Uploading
        ) || (allow_retry && batch.status == ProductBatchStatus::Failed);
        if !allowed {
            return Err(IngestApiError::conflict(format!(
                "Batch cannot start from status {:?}",
                batch.status
            )));
        }
        write_product_manifest(&mut batch)?;
        batch.status = ProductBatchStatus::Queued;
        batch.error = None;
        batch.warnings.clear();
        batch.written_files.clear();
        batch.updated_at = now();
        batch.started_at = None;
        batch.completed_at = None;
        write_batch(&path, &batch)?;
        batch
    };
    emit_batch_event(&state, &batch);
    tokio::spawn(run_batch_worker(state, path));
    Ok(batch)
}

pub async fn start_batch(
    State(state): State<Arc<AppState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> ApiResult<impl IntoResponse> {
    let path = find_batch_file(&state.data_root, &batch_id)?;
    let batch = queue_batch(state, path, false).await?;
    Ok((StatusCode::ACCEPTED, Json(batch)))
}

pub async fn retry_batch(
    State(state): State<Arc<AppState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> ApiResult<impl IntoResponse> {
    let path = find_batch_file(&state.data_root, &batch_id)?;
    let batch = queue_batch(state, path, true).await?;
    Ok((StatusCode::ACCEPTED, Json(batch)))
}

fn worker_path() -> PathBuf {
    if let Ok(configured) = std::env::var("INGEST_WORKER_PATH") {
        return PathBuf::from(configured);
    }
    let production = PathBuf::from("/app/worker/ingest-worker.js");
    if production.is_file() {
        return production;
    }
    PathBuf::from("worker-dist/ingest-worker.js")
}

async fn finish_batch(
    state: &AppState,
    path: &Path,
    status: ProductBatchStatus,
    result: Option<WorkerResult>,
    error_message: Option<String>,
) {
    let _store_guard = state.ingest_store_lock.lock().await;
    match read_batch(path) {
        Ok(mut batch) => {
            batch.status = status;
            batch.updated_at = now();
            batch.completed_at = Some(batch.updated_at.clone());
            if let Some(result) = result {
                batch.written_files = result.written_files;
                batch.warnings = result.warnings;
                batch.error = result.error;
            } else {
                batch.error = error_message;
            }
            if let Err(err) = write_batch(path, &batch) {
                error!(batch_id = %batch.batch_id, error = %err.message, "Failed to persist final batch status");
            } else {
                emit_batch_event(state, &batch);
            }
        }
        Err(err) => error!(error = %err.message, "Failed to read batch while finishing worker"),
    }
}

async fn run_batch_worker(state: Arc<AppState>, path: PathBuf) {
    let initial = match read_batch(&path) {
        Ok(batch) => batch,
        Err(err) => {
            error!(error = %err.message, "Cannot start product ingestion worker");
            return;
        }
    };
    let _global_permit = match state.ingest_workers.clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => return,
    };
    let project_semaphore = state.project_ingest_semaphore(&initial.project_id).await;
    let _project_permit = match project_semaphore.acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => return,
    };

    {
        let _store_guard = state.ingest_store_lock.lock().await;
        if let Ok(mut batch) = read_batch(&path) {
            batch.status = ProductBatchStatus::Processing;
            batch.started_at = Some(now());
            batch.updated_at = batch.started_at.clone().unwrap_or_else(now);
            if let Err(err) = write_batch(&path, &batch) {
                error!(batch_id = %batch.batch_id, error = %err.message, "Failed to mark batch processing");
                return;
            }
            emit_batch_event(&state, &batch);
        }
    }

    let worker = worker_path();
    if !worker.is_file() {
        finish_batch(
            &state,
            &path,
            ProductBatchStatus::Failed,
            None,
            Some(format!("Ingestion worker not found: {}", worker.display())),
        )
        .await;
        return;
    }
    let result_path = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(RESULT_FILE);
    let _ = tokio::fs::remove_file(&result_path).await;
    let port = std::env::var("APP_PORT").unwrap_or_else(|_| "8000".to_string());
    let api_base =
        std::env::var("INGEST_API_BASE").unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
    let node = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string());

    info!(
        batch_id = %initial.batch_id,
        project = %initial.project_name,
        product = %initial.product_name,
        "Starting server-side product ingestion"
    );
    let status = Command::new(node)
        .arg(worker)
        .arg(&path)
        .arg(&result_path)
        .env("LLM_WIKI_API_BASE", api_base)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await;

    match status {
        Ok(exit) if exit.success() => match tokio::fs::read(&result_path).await {
            Ok(raw) => match serde_json::from_slice::<WorkerResult>(&raw) {
                Ok(result) if result.error.is_none() => {
                    info!(batch_id = %initial.batch_id, written = result.written_files.len(), "Product ingestion completed");
                    finish_batch(
                        &state,
                        &path,
                        ProductBatchStatus::Completed,
                        Some(result),
                        None,
                    )
                    .await;
                }
                Ok(result) => {
                    let message = result
                        .error
                        .clone()
                        .unwrap_or_else(|| "Worker failed".to_string());
                    warn!(batch_id = %initial.batch_id, error = %message, "Product ingestion worker reported failure");
                    finish_batch(
                        &state,
                        &path,
                        ProductBatchStatus::Failed,
                        Some(result),
                        None,
                    )
                    .await;
                }
                Err(err) => {
                    finish_batch(
                        &state,
                        &path,
                        ProductBatchStatus::Failed,
                        None,
                        Some(format!("Invalid worker result: {err}")),
                    )
                    .await;
                }
            },
            Err(err) => {
                finish_batch(
                    &state,
                    &path,
                    ProductBatchStatus::Failed,
                    None,
                    Some(format!("Worker result missing: {err}")),
                )
                .await;
            }
        },
        Ok(exit) => {
            finish_batch(
                &state,
                &path,
                ProductBatchStatus::Failed,
                None,
                Some(format!("Ingestion worker exited with {exit}")),
            )
            .await;
        }
        Err(err) => {
            finish_batch(
                &state,
                &path,
                ProductBatchStatus::Failed,
                None,
                Some(format!("Failed to launch ingestion worker: {err}")),
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_supported_product_names() {
        assert_eq!(
            validate_name("product_name", "平安福2026", 160).unwrap(),
            "平安福2026"
        );
        assert!(validate_name("product_name", "../bad", 160).is_err());
        assert!(validate_name("product_name", "bad/name", 160).is_err());
    }

    #[test]
    fn strips_product_folder_from_relative_upload_path() {
        let result = safe_relative_upload_path(
            Some("平安福2026/条款/产品条款.pdf"),
            "产品条款.pdf",
            "平安福2026",
        )
        .unwrap();
        assert_eq!(normalized_path(&result), "条款/产品条款.pdf");
    }

    #[test]
    fn rejects_relative_path_traversal() {
        assert!(safe_relative_upload_path(Some("../secret.pdf"), "secret.pdf", "产品").is_err());
    }
}
