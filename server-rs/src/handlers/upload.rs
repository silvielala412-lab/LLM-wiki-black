use axum::{
    extract::Multipart,
    Json,
};
use serde_json::{json, Value};
use std::{fs, path::Path};
use crate::error::Result;

const ALLOWED_EXTS: &[&str] = &[
    "pdf", "xlsx", "xls", "docx", "doc",
    "pptx", "ppt", "txt", "md", "csv", "json",
    "png", "jpg", "jpeg", "gif", "webp",
];
const MAX_MB: u64 = 200;

async fn save_upload(
    file_name: &str,
    destination_dir: &str,
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
    let dest = Path::new(destination_dir).join(file_name);
    fs::write(&dest, &data)?;

    Ok(json!({
        "path": dest.to_string_lossy().replace('\\', "/"),
        "name": file_name,
        "size": data.len(),
    }))
}

pub async fn upload_file(mut multipart: Multipart) -> Result<Json<Value>> {
    let mut file_name = String::new();
    let mut file_data: Option<Vec<u8>> = None;
    let mut destination_dir = String::new();

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
                destination_dir = field.text().await?;
            }
            _ => {}
        }
    }

    let data = file_data.ok_or_else(|| anyhow::anyhow!("No file provided"))?;
    let result = save_upload(&file_name, &destination_dir, data).await?;
    Ok(Json(result))
}

pub async fn upload_files(mut multipart: Multipart) -> Result<Json<Value>> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut destination_dir = String::new();

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
                destination_dir = field.text().await?;
            }
            _ => {}
        }
    }

    let mut results = Vec::new();
    for (fname, data) in files {
        match save_upload(&fname, &destination_dir, data).await {
            Ok(v) => results.push(v),
            Err(e) => results.push(json!({ "error": e.to_string(), "name": fname })),
        }
    }
    Ok(Json(json!(results)))
}
