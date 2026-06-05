/*!
 * Backend chat pipeline.
 *
 * POST /api/chat/stream is the server-side equivalent of the frontend
 * ChatPanel question-answer path. It keeps retrieval and prompt assembly
 * in one API so external scripts and agents get the same behavior as the UI.
 */

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::Arc};

use crate::{
    handlers::rag::{self, RetrievedChunk},
    state::AppState,
};

const DEFAULT_MAX_CTX: usize = 204_800;
const DEFAULT_TOP_K: usize = 8;
const DEFAULT_MAX_HISTORY_MESSAGES: usize = 12;
const DEFAULT_MAX_TOKENS: u32 = 1600;
const DEFAULT_TEMPERATURE: f32 = 0.2;

#[derive(Deserialize)]
pub struct ChatStreamRequest {
    pub project_path: String,
    pub messages: Vec<Value>,
    pub top_k: Option<usize>,
    pub max_history_messages: Option<usize>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub model: Option<String>,
    pub stream: Option<bool>,
}

#[derive(Clone)]
struct PageEntry {
    title: String,
    path: String,
    content: String,
    best_score: f64,
}

#[derive(Serialize)]
struct SourcePage {
    number: usize,
    title: String,
    path: String,
    score: f64,
}

struct ContextBudget {
    index_budget: usize,
    page_budget: usize,
    max_page_size: usize,
}

pub async fn stream_chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatStreamRequest>,
) -> Response {
    let last_user = match last_user_text(&body.messages) {
        Some(text) if !text.trim().is_empty() => text,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "messages must contain a non-empty user message"})),
            )
                .into_response();
        }
    };

    let top_k = body.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 32);
    if body.stream == Some(false) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "/api/chat/stream only supports stream=true"})),
        )
            .into_response();
    }

    let retrieval_query = build_retrieval_query(&body.messages, &last_user);
    let (chunks, retrieval_ms) = match rag::retrieve_chunks_for_query(
        &state,
        &body.project_path,
        &retrieval_query,
        top_k,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            tracing::warn!("[Chat] retrieval failed: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("Chat retrieval failed: {e}")})),
            )
                .into_response();
        }
    };

    let budget = compute_context_budget(state.llm_config.max_context_size);
    let purpose = read_optional_project_file(&body.project_path, &["purpose.md"]).await;
    let raw_index = read_optional_project_file(&body.project_path, &["wiki", "index.md"]).await;
    let index = raw_index
        .as_deref()
        .map(|raw| trim_index(raw, &retrieval_query, budget.index_budget))
        .filter(|s| !s.trim().is_empty());

    let mut pages = build_pages_from_chunks(chunks, budget.page_budget, budget.max_page_size);
    if pages.is_empty() {
        if let Some(overview) = read_optional_project_file(&body.project_path, &["wiki", "overview.md"]).await {
            pages.push(PageEntry {
                title: "Overview".to_string(),
                path: "wiki/overview.md".to_string(),
                content: trim_to_chars(&overview, budget.max_page_size),
                best_score: 0.0,
            });
        }
    }

    let output_language = detect_output_language(&last_user);
    let system_prompt = build_system_prompt(
        purpose.as_deref(),
        index.as_deref(),
        &pages,
        output_language,
    );
    let mut llm_messages = build_llm_messages(
        &body.messages,
        system_prompt,
        body.max_history_messages
            .unwrap_or(DEFAULT_MAX_HISTORY_MESSAGES)
            .clamp(1, 64),
    );
    inject_language_reminder(&mut llm_messages, output_language);

    let cfg = &state.llm_config;
    let endpoint = match &cfg.endpoint {
        Some(e) => e.trim_end_matches('/').to_string(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "LLM endpoint not configured. Set LLM_ENDPOINT env var."})),
            )
                .into_response();
        }
    };

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
        "messages": llm_messages,
        "stream": true,
    });
    req_body["temperature"] = json!(body.temperature.unwrap_or(DEFAULT_TEMPERATURE));
    req_body["max_tokens"] = json!(body.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS));
    if let Some(top_p) = body.top_p {
        req_body["top_p"] = json!(top_p);
    }

    let url = format!("{endpoint}/chat/completions");
    tracing::info!(
        "[Chat] model={} query_len={} rewritten_len={} sources={} retrieval_ms={}",
        model,
        last_user.len(),
        retrieval_query.len(),
        pages.len(),
        retrieval_ms,
    );

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
            tracing::error!("[Chat] LLM request failed: {e}");
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
        tracing::warn!("[Chat] LLM upstream HTTP {status}: {body_text}");
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({"error": body_text})),
        )
            .into_response();
    }

    let sources = source_pages(&pages);
    let meta_event = serde_json::to_string(&json!({
        "type": "chat_meta",
        "retrieval_query": retrieval_query,
        "retrieval_ms": retrieval_ms,
        "top_k": top_k,
        "sources": sources,
    }))
    .unwrap_or_else(|_| "{}".to_string());
    let meta = format!("event: meta\ndata: {meta_event}\n\n");

    let meta_stream = futures::stream::once(async move {
        Ok::<Bytes, std::io::Error>(Bytes::from(meta))
    });
    let upstream_stream = upstream
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let stream = meta_stream.chain(upstream_stream);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn content_text(message: &Value) -> String {
    value_text(message.get("content").unwrap_or(&Value::Null))
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(value_text)
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("content"))
            .map(value_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn last_user_text(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|m| role(m) == Some("user"))
        .map(content_text)
}

fn build_retrieval_query(messages: &[Value], last_user: &str) -> String {
    if !looks_context_dependent(last_user) {
        return trim_to_chars(last_user, 1000);
    }

    let last_user_index = messages
        .iter()
        .rposition(|m| role(m) == Some("user"))
        .unwrap_or(messages.len());
    let mut previous_users = Vec::new();
    for message in messages[..last_user_index].iter().rev() {
        if role(message) != Some("user") {
            continue;
        }
        let text = content_text(message);
        if !text.trim().is_empty() {
            previous_users.push(trim_to_chars(&text, 400));
        }
        if previous_users.len() >= 2 {
            break;
        }
    }
    previous_users.reverse();
    previous_users.push(last_user.to_string());
    trim_to_chars(&previous_users.join("\n"), 1000)
}

fn looks_context_dependent(text: &str) -> bool {
    let normalized = text.trim();
    if normalized.chars().count() > 28 {
        return false;
    }
    if normalized.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    let self_contained_clues = [
        "\u{4fdd}\u{9669}", // insurance
        "\u{9669}\u{79cd}", // product code/type
        "\u{4ea7}\u{54c1}", // product
        "\u{5e73}\u{5b89}", // Ping An
        "\u{667a}\u{76c8}", // Zhiying
        "\u{76db}\u{4e16}", // Shengshi
        "\u{6761}\u{6b3e}", // clause/terms
        "\u{6295}\u{4fdd}", // application/insurance purchase
        "A0",
        "B0",
    ];
    !self_contained_clues.iter().any(|clue| normalized.contains(clue))
}

async fn read_optional_project_file(project_path: &str, parts: &[&str]) -> Option<String> {
    let mut path = Path::new(project_path).to_path_buf();
    for part in parts {
        path.push(part);
    }
    tokio::fs::read_to_string(path).await.ok()
}

fn compute_context_budget(max_context_size: Option<u32>) -> ContextBudget {
    let max_ctx = max_context_size
        .filter(|v| *v > 0)
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_MAX_CTX);
    let index_budget = max_ctx * 5 / 100;
    let page_budget = max_ctx * 50 / 100;
    let max_page_size = page_budget.min(5_000.max(page_budget * 30 / 100));

    ContextBudget {
        index_budget,
        page_budget,
        max_page_size,
    }
}

fn trim_index(raw: &str, query: &str, budget: usize) -> String {
    if raw.chars().count() <= budget {
        return raw.to_string();
    }

    let tokens = tokenize(query);
    let mut kept = Vec::new();
    let mut used = 0usize;
    for line in raw.lines() {
        let lower = line.to_lowercase();
        let is_header = line.starts_with("##");
        let is_relevant = tokens.iter().any(|token| lower.contains(token));
        let line_len = line.chars().count() + 1;
        if (is_header || is_relevant) && used + line_len <= budget {
            kept.push(line);
            used += line_len;
        }
    }

    if kept.is_empty() {
        return trim_to_chars(raw, budget);
    }

    let mut trimmed = kept.join("\n");
    if trimmed.len() < raw.len() {
        trimmed.push_str("\n\n[...index trimmed to relevant entries...]");
    }
    trimmed
}

fn tokenize(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in query.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else {
            if current.len() >= 2 {
                tokens.push(current.clone());
            }
            current.clear();
            if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                tokens.push(ch.to_string());
            }
        }
    }
    if current.len() >= 2 {
        tokens.push(current);
    }

    tokens
}

fn build_pages_from_chunks(
    chunks: Vec<RetrievedChunk>,
    page_budget: usize,
    max_page_size: usize,
) -> Vec<PageEntry> {
    let mut pages: Vec<PageEntry> = Vec::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut used = 0usize;

    for chunk in chunks {
        let block = format_chunk(&chunk);
        if block.trim().is_empty() {
            continue;
        }
        let block = trim_to_chars(&block, max_page_size);
        let block_len = block.chars().count();

        if let Some(index) = by_path.get(&chunk.page_path).copied() {
            let page = &mut pages[index];
            if page.content.chars().count() + block_len > max_page_size {
                continue;
            }
            if used + block_len > page_budget {
                break;
            }
            page.content.push_str("\n\n");
            page.content.push_str(&block);
            page.best_score = page.best_score.max(chunk.score);
            used += block_len;
            continue;
        }

        if used + block_len > page_budget {
            break;
        }
        let index = pages.len();
        by_path.insert(chunk.page_path.clone(), index);
        pages.push(PageEntry {
            title: if chunk.page_title.trim().is_empty() {
                chunk.page_path.clone()
            } else {
                chunk.page_title.clone()
            },
            path: chunk.page_path.clone(),
            content: block,
            best_score: chunk.score,
        });
        used += block_len;
    }

    pages
}

fn format_chunk(chunk: &RetrievedChunk) -> String {
    let heading = chunk.heading_path.trim();
    if heading.is_empty() {
        chunk.chunk_text.clone()
    } else {
        format!("#### {heading}\n{}", chunk.chunk_text)
    }
}

fn build_system_prompt(
    purpose: Option<&str>,
    index: Option<&str>,
    pages: &[PageEntry],
    output_language: &str,
) -> String {
    let page_list = pages
        .iter()
        .enumerate()
        .map(|(i, p)| format!("[{}] {} ({})", i + 1, p.title, p.path))
        .collect::<Vec<_>>()
        .join("\n");

    let pages_context = if pages.is_empty() {
        "(No wiki pages found)".to_string()
    } else {
        pages
            .iter()
            .enumerate()
            .map(|(i, p)| format!("### [{}] {}\nPath: {}\n\n{}", i + 1, p.title, p.path, p.content))
            .collect::<Vec<_>>()
            .join("\n\n---\n\n")
    };

    [
        "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.".to_string(),
        String::new(),
        "## Rules".to_string(),
        "- Answer based ONLY on the numbered wiki pages provided below.".to_string(),
        "- If the provided pages don't contain enough information, say so honestly.".to_string(),
        "- Use [[wikilink]] syntax to reference wiki pages.".to_string(),
        "- When citing information, use the page number in brackets, e.g. [1], [2].".to_string(),
        "- At the VERY END of your response, add a hidden comment listing which page numbers you used:".to_string(),
        "  <!-- cited: 1, 3, 5 -->".to_string(),
        String::new(),
        "Use markdown formatting for clarity.".to_string(),
        String::new(),
        "## Wiki Management Actions".to_string(),
        "If the user explicitly asks to DELETE a wiki page, output this action tag at the end of your reply:".to_string(),
        "  <!-- action:delete page=\"page-name\" path=\"wiki/entities/page-name.md\" -->".to_string(),
        "Always warn the user about consequences BEFORE outputting the action tag.".to_string(),
        String::new(),
        "If the user asks to CREATE a new wiki page, output a FILE block:".to_string(),
        "  ---FILE: wiki/entities/<name>.md---".to_string(),
        "  (YAML frontmatter + markdown content)".to_string(),
        "  ---END FILE---".to_string(),
        purpose
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("## Wiki Purpose\n{s}"))
            .unwrap_or_default(),
        index
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("## Wiki Index\n{s}"))
            .unwrap_or_default(),
        if pages.is_empty() {
            String::new()
        } else {
            format!("## Page List\n{page_list}")
        },
        format!("## Wiki Pages\n\n{pages_context}"),
        String::new(),
        "---".to_string(),
        String::new(),
        format!("## MANDATORY OUTPUT LANGUAGE: {output_language}"),
        String::new(),
        format!("You MUST write your entire response in **{output_language}**."),
        "The wiki content above may be in a different language, but this is IRRELEVANT to your output language.".to_string(),
        format!("Ignore the language of the wiki content. Write in {output_language} only."),
        format!("Even proper nouns should use standard {output_language} transliteration when appropriate."),
        "DO NOT use any other language. This overrides all other instructions.".to_string(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_llm_messages(messages: &[Value], system_prompt: String, max_history: usize) -> Vec<Value> {
    let mut history = messages
        .iter()
        .filter(|m| matches!(role(m), Some("user") | Some("assistant")))
        .rev()
        .take(max_history)
        .cloned()
        .collect::<Vec<_>>();
    history.reverse();

    let mut llm_messages = vec![json!({
        "role": "system",
        "content": system_prompt,
    })];
    llm_messages.extend(history);
    llm_messages
}

fn inject_language_reminder(messages: &mut [Value], output_language: &str) {
    let reminder = format!("REMINDER: All output must be in {output_language}. Do not use any other language.");
    for message in messages.iter_mut().rev() {
        if role(message) != Some("user") {
            continue;
        }
        let text = content_text(message);
        message["content"] = json!(format!("{reminder}\n\n{text}"));
        break;
    }
}

fn detect_output_language(text: &str) -> &'static str {
    let mut cjk = 0usize;
    let mut japanese = 0usize;
    let mut korean = 0usize;

    for ch in text.chars() {
        let cp = ch as u32;
        if (0x4E00..=0x9FFF).contains(&cp) || (0x3400..=0x4DBF).contains(&cp) {
            cjk += 1;
        } else if (0x3040..=0x30FF).contains(&cp) {
            japanese += 1;
        } else if (0xAC00..=0xD7AF).contains(&cp) {
            korean += 1;
        }
    }

    if japanese > 0 {
        "Japanese"
    } else if korean > 0 {
        "Korean"
    } else if cjk >= 2 {
        "Chinese"
    } else {
        "English"
    }
}

fn source_pages(pages: &[PageEntry]) -> Vec<SourcePage> {
    pages
        .iter()
        .enumerate()
        .map(|(i, page)| SourcePage {
            number: i + 1,
            title: page.title.clone(),
            path: page.path.clone(),
            score: page.best_score,
        })
        .collect()
}

fn trim_to_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out = text.chars().take(max_chars).collect::<String>();
    out.push_str("\n\n[...truncated...]");
    out
}
