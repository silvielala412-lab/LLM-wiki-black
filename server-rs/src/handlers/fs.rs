/*!
 * File system handlers — mirrors Tauri commands in src-tauri/src/commands/fs.rs.
 * Logic is ported directly; only the IPC layer changes (axum instead of tauri::command).
 */

use axum::{
    extract::{Query, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::Arc,
};
use crate::{error::Result, state::AppState};

// ── Known file type categories (same as Tauri) ──────────────────────────────

const OFFICE_EXTS: &[&str] = &["docx", "pptx", "xlsx", "odt", "ods", "odp"];
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "svg",
];
const MEDIA_EXTS: &[&str] = &[
    "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "aac", "m4a",
];

// ── Request / Response types ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PathBody {
    pub path: String,
}

#[derive(Deserialize)]
pub struct WriteBody {
    pub path: String,
    pub contents: String,
}

#[derive(Deserialize)]
pub struct CopyBody {
    pub source: String,
    pub destination: String,
}

#[derive(Deserialize)]
pub struct RelatedBody {
    #[serde(rename = "projectPath")]
    pub project_path: String,
    #[serde(rename = "sourceName")]
    pub source_name: String,
}

#[derive(Deserialize)]
pub struct MediaQuery {
    pub path: String,
}

#[derive(Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Extract text from Excel workbook using calamine (same as Tauri).
fn extract_excel_text(path: &str) -> anyhow::Result<String> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut wb = open_workbook_auto(path)?;
    let mut sections = Vec::new();
    for name in wb.sheet_names().to_owned() {
        if let Ok(range) = wb.worksheet_range(&name) {
            let mut rows = Vec::new();
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => {
                            if f.fract() == 0.0 && f.abs() < 1e15 {
                                format!("{}", *f as i64)
                            } else {
                                format!("{f}")
                            }
                        }
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(dt) => format!("{dt}"),
                        _ => String::new(),
                    })
                    .collect();
                let non_empty: Vec<&str> = cells.iter().map(|s| s.as_str()).filter(|s| !s.trim().is_empty()).collect();
                if !non_empty.is_empty() {
                    rows.push(cells.join(" | "));
                }
            }
            if !rows.is_empty() {
                sections.push(format!("## Sheet: {name}\n\n{}", rows.join("\n")));
            }
        }
    }
    Ok(if sections.is_empty() {
        "(Empty workbook)".into()
    } else {
        sections.join("\n\n")
    })
}

/// Extract text from DOCX using docx-rs (same as Tauri).
fn extract_docx_text(path: &str) -> anyhow::Result<String> {
    use docx_rs::*;
    let data = fs::read(path)?;
    let doc = read_docx(&data).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let mut paragraphs = Vec::new();
    for child in &doc.document.children {
        if let DocumentChild::Paragraph(p) = child {
            let text: String = p
                .children
                .iter()
                .filter_map(|c| {
                    if let ParagraphChild::Run(r) = c {
                        let t: String = r
                            .children
                            .iter()
                            .filter_map(|rc| {
                                if let RunChild::Text(t) = rc {
                                    Some(t.text.clone())
                                } else {
                                    None
                                }
                            })
                            .collect();
                        if !t.is_empty() { Some(t) } else { None }
                    } else {
                        None
                    }
                })
                .collect();
            if !text.trim().is_empty() {
                paragraphs.push(text);
            }
        }
    }
    Ok(if paragraphs.is_empty() {
        "(Empty document)".into()
    } else {
        paragraphs.join("\n\n")
    })
}

/// Extract text from PDF using pdf-extract (pure Rust, no system libs).
/// When the PDF has no text layer (image-based / scanned), falls back to
/// converting each page to a JPEG via `pdftoppm` (poppler-utils) and returns
/// a special JSON marker that the frontend intercepts to run VLM OCR.
fn extract_pdf_text(path: &str, pdf_dpi: u32) -> anyhow::Result<String> {
    let bytes = fs::read(path)?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| anyhow::anyhow!("PDF extraction failed: {e}"))?;
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }

    // ── Fallback: image-based PDF → convert pages to JPEG ────────────
    // Uses `pdftoppm` from poppler-utils (installed in the Docker runtime
    // image). If pdftoppm is not found, we return a descriptive error
    // message instead of crashing so text-only ingestion keeps working.
    match pdf_to_images_base64(path, pdf_dpi) {
        Ok(pages) if !pages.is_empty() => {
            let marker = serde_json::json!({
                "type": "image_pages",
                "page_count": pages.len(),
                "dpi": pdf_dpi,
                "pages": pages,
            });
            Ok(format!("__PDF_IMAGE_PAGES__{}", marker))
        }
        Ok(_) => Ok("(PDF has no extractable text and no pages could be rendered)".into()),
        Err(e) => {
            tracing::warn!("pdf_to_images failed for {path}: {e}");
            Ok(format!(
                "(PDF has no extractable text — may be image-based. \
                 Install poppler-utils in the container to enable OCR. Error: {e})"
            ))
        }
    }
}

/// Convert a PDF to per-page JPEG images using `pdftoppm` (poppler-utils).
/// Returns a Vec of base64-encoded JPEG strings, one per page.
fn pdf_to_images_base64(path: &str, dpi: u32) -> anyhow::Result<Vec<String>> {
    use std::process::Command;

    // Write output to a temp directory so we can glob the results.
    let tmp = tempfile::tempdir()?;
    let out_prefix = tmp.path().join("page");
    let out_prefix_str = out_prefix.to_string_lossy();

    let status = Command::new("pdftoppm")
        .args([
            "-jpeg",
            "-r", &dpi.to_string(),
            path,
            &out_prefix_str,
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("pdftoppm not found or failed to start: {e}. \
            Ensure poppler-utils is installed."))?;

    if !status.success() {
        return Err(anyhow::anyhow!("pdftoppm exited with status {status}"));
    }

    // Collect output files (pdftoppm names them page-1.jpg, page-2.jpg …)
    let mut entries: Vec<_> = fs::read_dir(tmp.path())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("jpg") || x.eq_ignore_ascii_case("jpeg"))
                .unwrap_or(false)
        })
        .collect();

    // Sort by filename to preserve page order.
    entries.sort_by_key(|e| e.file_name());

    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let data = fs::read(entry.path())?;
        result.push(B64.encode(&data));
    }
    Ok(result)
}

/// Read and preprocess a file — returns text content (same behaviour as Tauri read_file).
fn read_file_sync(path: &str, pdf_dpi: u32) -> anyhow::Result<String> {
    let p = Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

    match ext.as_str() {
        e if OFFICE_EXTS.contains(&e) => {
            match e {
                "xlsx" | "xls" | "ods" => extract_excel_text(path),
                "docx" | "odt" => extract_docx_text(path),
                _ => Ok(format!("[Document: {} — extraction not supported for .{e}]",
                    p.file_name().unwrap_or_default().to_string_lossy())),
            }
        }
        "pdf" => extract_pdf_text(path, pdf_dpi),
        e if IMAGE_EXTS.contains(&e) => {
            let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(format!("[Image: {} ({:.1} KB)]",
                p.file_name().unwrap_or_default().to_string_lossy(),
                size as f64 / 1024.0))
        }
        e if MEDIA_EXTS.contains(&e) => {
            let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(format!("[Media: {} ({:.1} MB)]",
                p.file_name().unwrap_or_default().to_string_lossy(),
                size as f64 / 1_048_576.0))
        }
        _ => {
            fs::read_to_string(path)
                .map_err(|e| {
                    if !p.exists() {
                        anyhow::anyhow!("File does not exist: '{path}'")
                    } else {
                        anyhow::anyhow!("Failed to read '{}': {e}", path)
                    }
                })
        }
    }
}

/// Recursively build a FileNode tree.
fn list_dir_recursive(path: &Path) -> anyhow::Result<Vec<FileNode>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let full_path = entry.path().to_string_lossy().replace('\\', "/");
        if meta.is_dir() {
            let children = list_dir_recursive(&entry.path()).unwrap_or_default();
            entries.push(FileNode { name, path: full_path, is_dir: true, children: Some(children) });
        } else {
            entries.push(FileNode { name, path: full_path, is_dir: false, children: None });
        }
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(entries)
}

fn copy_dir_recursive(src: &Path, dst: &Path, collected: &mut Vec<String>) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dst.join(entry.file_name());
        if entry.metadata()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path, collected)?;
        } else {
            fs::copy(&entry.path(), &dest_path)?;
            collected.push(dest_path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

// ── Handlers ─────────────────────────────────────────────────────────────────

pub async fn read_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PathBody>,
) -> Result<Json<Value>> {
    let path = body.path.clone();
    let dpi = state.llm_config.pdf_dpi;
    let content = tokio::task::spawn_blocking(move || read_file_sync(&path, dpi))
        .await??;
    Ok(Json(json!(content)))
}

pub async fn write_file(Json(body): Json<WriteBody>) -> Result<Json<Value>> {
    let p = Path::new(&body.path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&body.path, &body.contents)?;
    Ok(Json(json!(null)))
}

pub async fn list_directory(Json(body): Json<PathBody>) -> Result<Json<Value>> {
    let path = body.path.clone();
    let nodes = tokio::task::spawn_blocking(move || {
        list_dir_recursive(Path::new(&path))
    }).await??;
    Ok(Json(serde_json::to_value(nodes)?))
}

pub async fn file_exists(Json(body): Json<PathBody>) -> Result<Json<Value>> {
    Ok(Json(json!(Path::new(&body.path).exists())))
}

pub async fn delete_file(Json(body): Json<PathBody>) -> Result<Json<Value>> {
    let p = Path::new(&body.path);
    if p.is_dir() {
        fs::remove_dir_all(&body.path)?;
    } else {
        fs::remove_file(&body.path)?;
    }
    Ok(Json(json!(null)))
}

pub async fn create_directory(Json(body): Json<PathBody>) -> Result<Json<Value>> {
    fs::create_dir_all(&body.path)?;
    Ok(Json(json!(null)))
}

pub async fn copy_file(Json(body): Json<CopyBody>) -> Result<Json<Value>> {
    if let Some(parent) = Path::new(&body.destination).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&body.source, &body.destination)?;
    Ok(Json(json!(null)))
}

pub async fn copy_directory(Json(body): Json<CopyBody>) -> Result<Json<Value>> {
    let src = body.source.clone();
    let dst = body.destination.clone();
    let paths = tokio::task::spawn_blocking(move || {
        let mut collected = Vec::new();
        copy_dir_recursive(Path::new(&src), Path::new(&dst), &mut collected)?;
        Ok::<Vec<String>, anyhow::Error>(collected)
    }).await??;
    Ok(Json(serde_json::to_value(paths)?))
}

pub async fn preprocess_file(Json(body): Json<PathBody>) -> Result<Json<Value>> {
    // Same as read_file — preprocess just warms the cache in Tauri, here we return text directly
    let path = body.path.clone();
    let content = tokio::task::spawn_blocking(move || read_file_sync(&path))
        .await??;
    Ok(Json(json!(content)))
}

pub async fn read_file_base64(Json(body): Json<PathBody>) -> Result<Json<Value>> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let data = fs::read(&body.path)?;
    let ext = Path::new(&body.path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };
    Ok(Json(json!({
        "base64": STANDARD.encode(&data),
        "mimeType": mime,
    })))
}

pub async fn related_wiki_pages(Json(body): Json<RelatedBody>) -> Result<Json<Value>> {
    let pp = Path::new(&body.project_path);
    let wiki_dir = pp.join("wiki");
    let target_source = &body.source_name;
    let mut related = Vec::new();

    fn scan_for_source(dir: &Path, source: &str, found: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_for_source(&path, source, found);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if content.contains(source) {
                        found.push(path.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
    }

    if wiki_dir.is_dir() {
        scan_for_source(&wiki_dir, target_source, &mut related);
    }
    Ok(Json(serde_json::to_value(related)?))
}

/// Serve binary files (images, media) via HTTP GET ?path=...
pub async fn serve_media(
    Query(q): Query<MediaQuery>,
) -> impl axum::response::IntoResponse {
    use axum::response::Response;
    use axum::http::{StatusCode, header};
    use axum::body::Body;

    let path = &q.path;
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };
    match fs::read(path) {
        Ok(data) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .body(Body::from(data))
            .unwrap(),
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap(),
    }
}
