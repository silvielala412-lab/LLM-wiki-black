use axum::{
    extract::{Multipart, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::Arc};
use crate::{error::Result, state::AppState};
use tracing::{info, warn};

const ALLOWED_EXTS: &[&str] = &[
    "pdf", "xlsx", "xls", "docx", "doc",
    "pptx", "ppt", "txt", "md", "csv", "json",
    "png", "jpg", "jpeg", "gif", "webp",
    "html", "htm", "rtf", "epub", "yaml", "yml",
    "py", "js", "ts", "mdx",
];
const MAX_MB: u64 = 200;

#[derive(Deserialize)]
pub struct UploadQuery {
    /// Destination directory passed as query param so it's always read
    /// before the multipart body (avoids field-ordering surprises).
    dest: Option<String>,
}

/// Resolve destination_dir relative to data_root; reject path traversal.
fn resolve_upload_dir(destination_dir: &str, data_root: &Path) -> anyhow::Result<PathBuf> {
    if destination_dir.is_empty() {
        anyhow::bail!("destination_dir is empty");
    }
    let joined = if Path::new(destination_dir).is_absolute() {
        PathBuf::from(destination_dir)
    } else {
        data_root.join(destination_dir)
    };

    // Normalise without requiring existence (canonical() would fail)
    let mut canonical = PathBuf::new();
    for component in joined.components() {
        use std::path::Component;
        match component {
            Component::CurDir => {}
            Component::ParentDir => { canonical.pop(); }
            c => canonical.push(c),
        }
    }

    if !canonical.starts_with(data_root) {
        anyhow::bail!(
            "Upload destination '{}' resolves to '{}' which is outside data_root '{}'",
            destination_dir,
            canonical.display(),
            data_root.display()
        );
    }
    Ok(canonical)
}

async fn save_upload(
    file_name: &str,
    destination_dir: &Path,
    data: Vec<u8>,
) -> anyhow::Result<Value> {
    // Strip directory components — only keep the filename portion.
    // webkitdirectory sends plain filenames, but be defensive against
    // any client sending a path component inside the name field.
    let safe_name = Path::new(file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_name);

    let ext = Path::new(safe_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        anyhow::bail!("File type '.{ext}' is not allowed");
    }
    if data.len() as u64 > MAX_MB * 1024 * 1024 {
        anyhow::bail!("File exceeds {MAX_MB} MB limit");
    }

    fs::create_dir_all(destination_dir)?;
    let dest = destination_dir.join(safe_name);
    fs::write(&dest, &data)?;
    info!("Saved upload: {}", dest.display());

    Ok(json!({
        "path": dest.to_string_lossy().replace('\\', "/"),
        "name": safe_name,
        "size": data.len(),
    }))
}

pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut file_name = String::new();
    let mut file_data: Option<Vec<u8>> = None;
    // Prefer query param, fall back to multipart field
    let mut destination_dir_raw = query.dest.unwrap_or_default();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                file_name = field.file_name().unwrap_or("upload").to_string();
                file_data = Some(field.bytes().await?.to_vec());
            }
            "destination_dir" => {
                if destination_dir_raw.is_empty() {
                    destination_dir_raw = field.text().await?;
                }
            }
            _ => {}
        }
    }

    info!("upload_file: dest='{}' file='{}'", destination_dir_raw, file_name);
    let dest_dir = resolve_upload_dir(&destination_dir_raw, &state.data_root)?;
    let data = file_data.ok_or_else(|| anyhow::anyhow!("No file data in request"))?;
    let result = save_upload(&file_name, &dest_dir, data).await?;
    Ok(Json(result))
}

pub async fn upload_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut destination_dir_raw = query.dest.unwrap_or_default();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "files" => {
                let fname = field.file_name().unwrap_or("upload").to_string();
                let data = field.bytes().await?.to_vec();
                files.push((fname, data));
            }
            "destination_dir" => {
                if destination_dir_raw.is_empty() {
                    destination_dir_raw = field.text().await?;
                }
            }
            _ => {}
        }
    }

    info!("upload_files: dest='{}' count={}", destination_dir_raw, files.len());

    let dest_dir = match resolve_upload_dir(&destination_dir_raw, &state.data_root) {
        Ok(d) => d,
        Err(e) => {
            warn!("upload_files resolve_dir failed: {e}");
            return Err(e.into());
        }
    };

    let mut results = Vec::new();
    for (fname, data) in files {
        match save_upload(&fname, &dest_dir, data).await {
            Ok(v) => results.push(v),
            Err(e) => {
                warn!("save_upload failed for '{}': {}", fname, e);
                results.push(json!({ "error": e.to_string(), "name": fname }))
            }
        }
    }
    Ok(Json(json!(results)))
}
