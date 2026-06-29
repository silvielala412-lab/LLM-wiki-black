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
    path::{Path, PathBuf},
    sync::Arc,
};
use crate::{error::Result, state::AppState};

// ── Path safety ──────────────────────────────────────────────────────────────

/// Normalize `.` and `..` components without requiring the target to exist.
fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            c => normalized.push(c),
        }
    }
    normalized
}

fn comparable_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn path_is_inside(candidate: &Path, root: &Path) -> bool {
    let candidate_key = comparable_path(candidate).trim_end_matches('/').to_string();
    let root_key = comparable_path(root).trim_end_matches('/').to_string();
    candidate_key == root_key || candidate_key.starts_with(&format!("{root_key}/"))
}

/// Ensure `path` is within an allowed data root. Returns the normalized absolute path.
/// Rejects path traversal attempts (../../etc/passwd etc.).
fn guard_path(path: &str, roots: &[PathBuf]) -> anyhow::Result<PathBuf> {
    // Resolve the path without requiring it to exist (for write operations)
    // by joining to root and then normalising `.` / `..` segments manually.
    let root = roots.first().map(PathBuf::as_path).unwrap_or_else(|| Path::new("."));
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };

    let canonical = normalize_path(joined);

    for allowed_root in roots {
        let root_abs = if allowed_root.is_absolute() {
            allowed_root.clone()
        } else {
            std::env::current_dir()?.join(allowed_root)
        };
        let normalized_root = normalize_path(root_abs);
        if path_is_inside(&canonical, &normalized_root) {
            return Ok(canonical);
        }
    }

    anyhow::bail!(
        "Path '{}' is outside the allowed data directories: {}",
        path,
        roots
            .iter()
            .map(|root| root.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("; ")
    );
}

// ── Known file type categories (same as Tauri) ──────────────────────────────

const OFFICE_EXTS: &[&str] = &["docx", "pptx", "xlsx", "xls", "odt", "ods", "odp"];
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

fn pdf_image_pages_marker(path: &str, dpi: u32, fallback_text: Option<String>) -> anyhow::Result<String> {
    match pdf_to_images_base64(path, dpi) {
        Ok(pages) if !pages.is_empty() => {
            let marker = serde_json::json!({
                "type": "image_pages",
                "page_count": pages.len(),
                "dpi": dpi,
                "pages": pages,
            });
            Ok(format!("__PDF_IMAGE_PAGES__{}", marker))
        }
        Ok(_) => Ok(fallback_text.unwrap_or_else(|| "(PDF has no extractable text and no pages could be rendered)".into())),
        Err(e) => Ok(fallback_text.unwrap_or_else(|| format!(
            "(PDF has no extractable text — install poppler-utils or configure OCR_ENDPOINT. Error: {e})"
        ))),
    }
}

fn extract_pdf_text_with_pdftotext(path: &str) -> anyhow::Result<String> {
    use std::process::Command;

    let output = Command::new("pdftotext")
        .args(["-layout", "-enc", "UTF-8", path, "-"])
        .output()
        .map_err(|e| anyhow::anyhow!("pdftotext not found or failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow::anyhow!("pdftotext exited with status {}: {}", output.status, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // ── PDF: async pipeline with OCR API priority ─────────────────────
    if ext == "pdf" {
        let content = extract_pdf_content_async(&path, &state).await?;
        return Ok(Json(json!(content)));
    }

    // ── All other file types: sync worker thread ──────────────────────
    let dpi = state.llm_config.pdf_dpi;
    let content = tokio::task::spawn_blocking(move || read_file_sync(&path, dpi))
        .await??;
    Ok(Json(json!(content)))
}

/// Detect garbled PDF text layers — scanned PDFs often have a corrupt embedded
/// text layer (characters extracted but scrambled / heavily repeated).
///
/// A text is considered garbled if ANY of the following is true:
///   1. Unique char ratio < 0.015  (e.g. "居家会员" repeated 500×)
///   2. Top-1 word accounts for > 20% of all words (extreme repetition)
///   3. Average word length < 1.3 chars (Chinese text with no spaces would
///      normally produce CJK tokens; this catches mojibake-style output)
fn is_garbled_pdf_text(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let total_chars = chars.len();
    if total_chars < 50 {
        return false; // too short to judge
    }

    // 1. Unique character ratio
    let unique_chars: std::collections::HashSet<char> = chars
        .iter()
        .filter(|c| !c.is_whitespace())
        .cloned()
        .collect();
    let non_ws_total = chars.iter().filter(|c| !c.is_whitespace()).count();
    if non_ws_total > 0 {
        let unique_ratio = unique_chars.len() as f64 / non_ws_total as f64;
        if unique_ratio < 0.015 {
            tracing::warn!(
                "PDF text quality: unique_char_ratio={:.4} < 0.015 — treating as garbled",
                unique_ratio
            );
            return true;
        }
    }

    // 2. Top word dominance
    let words: Vec<&str> = text.split_whitespace().collect();
    let total_words = words.len();
    if total_words > 20 {
        let mut freq: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for w in &words {
            *freq.entry(w).or_insert(0) += 1;
        }
        if let Some(max_count) = freq.values().copied().max() {
            let dominance = max_count as f64 / total_words as f64;
            if dominance > 0.20 {
                tracing::warn!(
                    "PDF text quality: top_word_dominance={:.4} > 0.20 — treating as garbled",
                    dominance
                );
                return true;
            }
        }
    }

    false
}

/// Async PDF content extraction with three-tier fallback:
///   1. Internal OCR API  (if OCR_ENDPOINT configured) — handles all PDFs
///   2. pdf-extract       (pure Rust, fast)             — text-layer PDFs only
///   3. pdftotext         (Poppler fallback)            — text-layer PDFs pdf-extract cannot decode
///   4. pdftoppm marker   (poppler-utils)               — image-PDF fallback
async fn extract_pdf_content_async(path: &str, state: &AppState) -> anyhow::Result<String> {
    // ── Tier 1: internal OCR API ──────────────────────────────────────
    if let Some(ocr_endpoint) = &state.llm_config.ocr_endpoint {
        tracing::info!("PDF OCR: calling internal OCR API for {path}");
        match call_intranet_ocr_api(path, ocr_endpoint, state).await {
            Ok(text) => {
                tracing::info!("PDF OCR: success, {} chars", text.len());
                return Ok(text);
            }
            Err(e) => {
                tracing::warn!("PDF OCR: internal API failed ({e}), falling back to pdf-extract");
            }
        }
    }

    let dpi = state.llm_config.pdf_dpi;
    if state.llm_config.pdf_ocr_mode == "always" {
        // "always" is intended to force OCR for scanned PDFs, but many product
        // rate tables are digital PDFs with a high-quality text layer. For those,
        // pdftotext preserves numeric tables far better than vision OCR and avoids
        // sending large page-image payloads to the browser.
        let path_for_pdftotext = path.to_string();
        match tokio::task::spawn_blocking(move || extract_pdf_text_with_pdftotext(&path_for_pdftotext)).await {
            Ok(Ok(text)) if !text.trim().is_empty() => {
                let trimmed = text.trim().to_string();
                let char_count = trimmed.chars().count();
                if char_count >= 200 && !is_garbled_pdf_text(&trimmed) {
                    tracing::info!(
                        "pdf-ocr-mode=always: using text layer for {path} ({char_count} chars)"
                    );
                    return Ok(trimmed);
                }
                tracing::warn!(
                    "pdf-ocr-mode=always: text layer unusable for {path} ({char_count} chars), falling through to image OCR"
                );
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                tracing::warn!("pdf-ocr-mode=always: pdftotext failed for {path}: {e}, using image OCR");
            }
            Err(e) => {
                tracing::warn!("pdf-ocr-mode=always: pdftotext worker failed for {path}: {e}, using image OCR");
            }
        }
        let path_owned = path.to_string();
        return tokio::task::spawn_blocking(move || pdf_image_pages_marker(&path_owned, dpi, None))
            .await?;
    }

    // ── Tier 2: pdf-extract (text-layer PDFs) ─────────────────────────
    // Use catch_unwind to prevent pdf-extract panics (malformed PDFs can
    // trigger internal assertions in the library) from killing the request.
    let path_owned = path.to_string();
    let bytes = tokio::fs::read(&path_owned).await
        .map_err(|e| anyhow::anyhow!("Cannot read PDF file '{}': {e}", path_owned))?;

    let text_result = tokio::task::spawn_blocking(move || {
        use std::panic::catch_unwind;
        catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes))
    }).await;

    let mut short_text_fallback: Option<String> = None;
    match text_result {
        Ok(Ok(Ok(text))) if !text.trim().is_empty() => {
            let trimmed = text.trim().to_string();
            let char_count = trimmed.chars().count();
            if char_count >= 200 && !is_garbled_pdf_text(&trimmed) {
                return Ok(trimmed);
            }
            if char_count >= 200 {
                tracing::warn!(
                    "pdf-extract: {char_count} chars but text quality check failed for {path}; falling through to OCR"
                );
            } else {
                tracing::warn!(
                    "pdf-extract returned only {char_count} chars for {path}; trying image fallback in case this is a scanned/image PDF with a weak text layer"
                );
            }
            short_text_fallback = Some(trimmed);
        }
        Ok(Ok(Err(e))) => {
            tracing::warn!("pdf-extract failed for {path}: {e}, trying image fallback");
        }
        Ok(Err(_)) => {
            tracing::warn!("pdf-extract panicked for {path} (malformed PDF?), trying image fallback");
        }
        Err(e) => {
            tracing::warn!("spawn_blocking failed for {path}: {e}");
        }
        _ => {} // empty text → fall through to Tier 3
    }

    // ── Tier 3: pdftotext fallback before OCR ────────────────────────
    let path_for_pdftotext = path.to_string();
    match tokio::task::spawn_blocking(move || extract_pdf_text_with_pdftotext(&path_for_pdftotext)).await {
        Ok(Ok(text)) if !text.trim().is_empty() => {
            let trimmed = text.trim().to_string();
            let char_count = trimmed.chars().count();
            if char_count >= 200 && !is_garbled_pdf_text(&trimmed) {
                tracing::info!("pdftotext extracted {char_count} chars for {path}");
                return Ok(trimmed);
            }
            if char_count >= 200 {
                tracing::warn!(
                    "pdftotext: {char_count} chars but text quality check failed for {path}; falling through to OCR"
                );
            } else {
                tracing::warn!(
                    "pdftotext returned only {char_count} chars for {path}; trying image fallback"
                );
            }
            if short_text_fallback
                .as_ref()
                .map(|existing| trimmed.len() > existing.len())
                .unwrap_or(true)
            {
                short_text_fallback = Some(trimmed);
            }
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            tracing::warn!("pdftotext failed for {path}: {e}, trying image fallback");
        }
        Err(e) => {
            tracing::warn!("pdftotext worker failed for {path}: {e}, trying image fallback");
        }
    }

    // ── Tier 4: pdftoppm → image pages marker ─────────────────────────
    let path_owned = path.to_string();
    let marker = tokio::task::spawn_blocking(move || {
        pdf_image_pages_marker(&path_owned, dpi, short_text_fallback)
    }).await??;

    Ok(marker)
}

/// Call the intranet OCR API.
///
/// API contract (POST multipart/form-data):
///   - file:            binary  (PDF or image bytes)
///   - user_text:       string  识别指令（由 OCR_USER_TEXT 配置，默认"识别文件中的所有文字"）
///   - action_scenario: string  场景标识（由 OCR_ACTION_SCENARIO 配置，默认"111"）
///
/// Response JSON:
///   { "code": 0, "message": "操作成功", "data": { "trace_id": "...", "robot_text": "全文..." } }
async fn call_intranet_ocr_api(
    path: &str,
    endpoint: &str,
    state: &AppState,
) -> anyhow::Result<String> {
    let cfg = &state.llm_config;

    // Read file bytes (PDF or image)
    let bytes = tokio::fs::read(path).await
        .map_err(|e| anyhow::anyhow!("Cannot read file for OCR: {e}"))?;

    let filename = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "document.pdf".to_string());

    // Determine MIME type from extension
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png"          => "image/png",
        "webp"         => "image/webp",
        _              => "application/pdf",
    };

    // Build multipart form — matches intranet OCR API contract
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(mime)
        .map_err(|e| anyhow::anyhow!("MIME error: {e}"))?;

    let user_text = cfg.ocr_user_text.clone()
        .unwrap_or_else(|| "识别文件中的所有文字".to_string());
    let action_scenario = cfg.ocr_action_scenario.clone()
        .unwrap_or_else(|| "111".to_string());

    let form = reqwest::multipart::Form::new()
        .text("user_text", user_text)
        .text("action_scenario", action_scenario)
        .part("file", file_part);

    // Build request
    let mut req = state.http_client.post(endpoint).multipart(form);

    if let Some(key) = cfg.ocr_api_key() {
        req = req.bearer_auth(key);
    }

    // Send and parse
    let resp = req.send().await
        .map_err(|e| anyhow::anyhow!("OCR API request failed: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await
        .map_err(|e| anyhow::anyhow!("OCR API response not JSON (HTTP {status}): {e}"))?;

    // Validate response code
    let code = body["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = body["message"].as_str().unwrap_or("unknown error");
        return Err(anyhow::anyhow!("OCR API returned error code {code}: {msg}"));
    }

    // Extract full-document text
    let robot_text = body["data"]["robot_text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("OCR API response missing data.robot_text field"))?;

    if robot_text.trim().is_empty() {
        return Err(anyhow::anyhow!("OCR API returned empty robot_text"));
    }

    Ok(robot_text.to_string())
}


pub async fn write_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WriteBody>,
) -> Result<Json<Value>> {
    guard_path(&body.path, &state.allowed_data_roots)?;
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

pub async fn delete_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PathBody>,
) -> Result<Json<Value>> {
    guard_path(&body.path, &state.allowed_data_roots)?;
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

pub async fn preprocess_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PathBody>,
) -> Result<Json<Value>> {
    // Same as read_file — preprocess just warms the cache in Tauri, here we return text directly
    let path = body.path.clone();
    let dpi = state.llm_config.pdf_dpi;
    let content = tokio::task::spawn_blocking(move || read_file_sync(&path, dpi))
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

/// Clip-server status stub.
/// In the Tauri desktop build a local clip-server daemon runs on 127.0.0.1:19827
/// and tracks clipboard history. The web/Docker deployment doesn't need this
/// (users upload files via the browser upload dialog instead), so we return
/// "disabled" — the frontend already handles this gracefully.
pub async fn clip_server_status() -> Json<Value> {
    Json(json!("disabled"))
}
