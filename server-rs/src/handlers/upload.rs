use axum::{
    extract::{Multipart, State},
    Json,
};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::Arc};
use crate::{error::Result, state::AppState};

const ALLOWED_EXTS: &[&str] = &[
    "pdf", "xlsx", "xls", "docx", "doc",
    "pptx", "ppt", "txt", "md", "csv", "json",
    "png", "jpg", "jpeg", "gif", "webp",
];
const MAX_MB: u64 = 200;

/// Resolve destination_dir relative to data_root; reject traversal.
fn resolve_upload_dir(destination_dir: &str, data_root: &Path) -> anyhow::Result<PathBuf> {
    let joined = if Path::new(destination_dir).is_absolute() {
        PathBuf::from(destination_dir)
    } else {
        data_root.join(destination_dir)
    };

    // Normalise without requiring existence
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
            "Upload destination '{}' is outside the allowed data directory",
            destination_dir
        );
    }
    Ok(canonical)
}

async fn save_upload(
    file_name: &str,
    destination_dir: &Path,
    data: Vec<u8>,
) -> anyhow::Result<Value> {
    let ext = Path::new(file_name)
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
    let dest = destination_dir.join(file_name);
    fs::write(&dest, &data)?;

    Ok(json!({
        "path": dest.to_string_lossy().replace('\\', "/"),
        "name": file_name,
        "size": data.len(),
    }))
}

pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut file_name = String::new();
    let mut file_data: Option<Vec<u8>> = None;
    let mut destination_dir_raw = String::new();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                file_name = field
                    .file_name()
                    .unwrap_or("upload")
                    .to_string();
                file_data = Some(field.bytes().await?.to_vec());
            }
            "destination_dir" => {
                destination_dir_raw = field.text().await?;
            }
            _ => {}
        }
    }

    let dest_dir = resolve_upload_dir(&destination_dir_raw, &state.data_root)?;
    let data = file_data.ok_or_else(|| anyhow::anyhow!("No file provided"))?;
    let result = save_upload(&file_name, &dest_dir, data).await?;
    Ok(Json(result))
}

pub async fn upload_files(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut destination_dir_raw = String::new();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "files" => {
                let fname = field
                    .file_name()
                    .unwrap_or("upload")
                    .to_string();
                let data = field.bytes().await?.to_vec();
                files.push((fname, data));
            }
            "destination_dir" => {
                destination_dir_raw = field.text().await?;
            }
            _ => {}
        }
    }

    let dest_dir = resolve_upload_dir(&destination_dir_raw, &state.data_root)?;

    let mut results = Vec::new();
    for (fname, data) in files {
        match save_upload(&fname, &dest_dir, data).await {
            Ok(v) => results.push(v),
            Err(e) => results.push(json!({ "error": e.to_string(), "name": fname })),
        }
    }
    Ok(Json(json!(results)))
}
