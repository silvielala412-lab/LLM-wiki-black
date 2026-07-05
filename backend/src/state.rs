use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{broadcast, Mutex, Semaphore};

/// Server-level LLM / embedding / vision configuration.
/// Read once at startup from environment variables.
/// Exposed to the frontend via GET /api/config so users only need
/// to pick a model name — endpoints and keys are managed by the admin.
#[derive(Clone, Debug, serde::Serialize)]
pub struct LlmServerConfig {
    // ── Main LLM ──────────────────────────────────────────────────────
    pub provider: Option<String>,
    #[serde(skip)]
    pub api_key: Option<String>,
    pub has_api_key: bool,
    pub model: Option<String>,
    pub endpoint: Option<String>,
    pub api_mode: Option<String>,
    pub max_context_size: Option<u32>,

    // ── Embedding ─────────────────────────────────────────────────────
    pub embedding_endpoint: Option<String>,
    pub embedding_model: Option<String>,
    #[serde(skip)]
    pub embedding_api_key: Option<String>,
    pub has_embedding_api_key: bool,

    // ── Vision / Multimodal (for image-PDF OCR) ───────────────────────
    pub vision_endpoint: Option<String>,
    pub vision_model: Option<String>,
    #[serde(skip)]
    pub vision_api_key: Option<String>,
    pub has_vision_api_key: bool,
    pub pdf_dpi: u32,
    /// PDF OCR mode:
    /// - "auto": extract text first, OCR only scanned/weak PDFs.
    /// - "always": render every PDF page for OCR.
    pub pdf_ocr_mode: String,

    // ── Internal OCR API (custom intranet format) ─────────────────────
    /// POST endpoint for the intranet OCR service.
    /// e.g. http://laip-ivap-python-llm-retriever.example.cn:80/local_file_parser
    /// If set, this takes priority over pdftoppm + vision-model approach.
    #[serde(rename = "ocr_endpoint_configured")]
    pub has_ocr_endpoint: bool,
    #[serde(skip)]
    pub ocr_endpoint: Option<String>,
    /// Optional Bearer token / API key for the OCR service.
    #[serde(skip)]
    pub ocr_api_key: Option<String>,
    pub has_ocr_api_key: bool,
    /// Prompt sent as `user_text` field to the intranet OCR API.
    /// Defaults to "识别文件中的所有文字".
    pub ocr_user_text: Option<String>,
    /// Scene tag sent as `action_scenario` field to the intranet OCR API.
    /// Defaults to "111".
    pub ocr_action_scenario: Option<String>,

    // ── Frontend behaviour ────────────────────────────────────────────
    pub allow_user_override: bool,
}

impl LlmServerConfig {
    pub fn from_env() -> Self {
        let api_key = Self::opt_env("LLM_API_KEY");
        let dashscope_api_key = Self::opt_env("DASHSCOPE_API_KEY");
        let embedding_api_key =
            Self::opt_env("EMBEDDING_API_KEY").or_else(|| dashscope_api_key.clone());
        let vision_endpoint = Self::opt_env("VISION_ENDPOINT");
        let vision_uses_dashscope = vision_endpoint
            .as_deref()
            .map(|endpoint| endpoint.contains("dashscope.aliyuncs.com"))
            .unwrap_or(false);
        let vision_api_key = if vision_uses_dashscope {
            Self::opt_env("VISION_API_KEY")
                .or_else(|| dashscope_api_key.clone())
                .or_else(|| embedding_api_key.clone())
                .or_else(|| Self::opt_env("SEARCH_API_KEY"))
        } else {
            Self::opt_env("VISION_API_KEY")
                .or_else(|| Self::opt_env("SEARCH_API_KEY"))
                .or_else(|| embedding_api_key.clone())
        };
        let ocr_endpoint = Self::opt_env("OCR_ENDPOINT");
        let ocr_api_key = Self::opt_env("OCR_API_KEY");
        let pdf_ocr_mode = Self::opt_env("PDF_OCR_MODE")
            .map(|v| v.to_lowercase())
            .filter(|v| v == "auto" || v == "always")
            .unwrap_or_else(|| "auto".to_string());
        Self {
            provider: Self::opt_env("LLM_PROVIDER"),
            has_api_key: api_key.is_some(),
            api_key,
            model: Self::opt_env("LLM_MODEL"),
            endpoint: Self::opt_env("LLM_ENDPOINT"),
            api_mode: Self::opt_env("LLM_API_MODE"),
            max_context_size: Self::opt_env("LLM_MAX_CONTEXT").and_then(|v| v.parse().ok()),
            embedding_endpoint: Self::opt_env("EMBEDDING_ENDPOINT"),
            embedding_model: Self::opt_env("EMBEDDING_MODEL"),
            has_embedding_api_key: embedding_api_key.is_some(),
            embedding_api_key,
            vision_endpoint,
            vision_model: Self::opt_env("VISION_MODEL"),
            has_vision_api_key: vision_api_key.is_some(),
            vision_api_key,
            pdf_dpi: Self::opt_env("PDF_DPI")
                .and_then(|v| v.parse().ok())
                .unwrap_or(150),
            pdf_ocr_mode,
            has_ocr_endpoint: ocr_endpoint.is_some(),
            ocr_endpoint,
            has_ocr_api_key: ocr_api_key.is_some(),
            ocr_api_key,
            ocr_user_text: Self::opt_env("OCR_USER_TEXT"),
            ocr_action_scenario: Self::opt_env("OCR_ACTION_SCENARIO"),
            allow_user_override: Self::opt_env("SERVER_CONFIG_LOCKED")
                .map(|v| v.to_lowercase() != "true")
                .unwrap_or(true),
        }
    }

    fn opt_env(key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }

    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    pub fn embedding_api_key(&self) -> Option<&str> {
        self.embedding_api_key
            .as_deref()
            .or_else(|| self.api_key.as_deref())
    }

    pub fn ocr_api_key(&self) -> Option<&str> {
        self.ocr_api_key.as_deref()
    }

    pub fn vision_api_key(&self) -> Option<&str> {
        self.vision_api_key.as_deref()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub data_root: PathBuf,
    pub allowed_data_roots: Vec<PathBuf>,
    pub llm_config: LlmServerConfig,
    /// Shared HTTP client — reuse connection pools across requests.
    pub http_client: reqwest::Client,
    /// Limits expensive server-side ingestion workers across all projects.
    pub ingest_workers: Arc<Semaphore>,
    /// Serializes ingestion inside one project while allowing different projects to run concurrently.
    pub ingest_project_locks: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    /// Protects read-modify-write updates to persisted batch JSON files.
    pub ingest_store_lock: Arc<Mutex<()>>,
    /// Broadcasts persisted ingestion status changes to browser clients.
    pub ingest_events: broadcast::Sender<String>,
}

impl AppState {
    pub fn new(data_root: PathBuf, llm_config: LlmServerConfig) -> Self {
        let allowed_data_roots = allowed_data_roots(&data_root);
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300)) // 5 min for large PDFs
            .build()
            .expect("Failed to build HTTP client");
        let worker_concurrency = std::env::var("INGEST_WORKER_CONCURRENCY")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(2);
        let (ingest_events, _) = broadcast::channel(512);
        Self {
            data_root,
            allowed_data_roots,
            llm_config,
            http_client,
            ingest_workers: Arc::new(Semaphore::new(worker_concurrency)),
            ingest_project_locks: Arc::new(Mutex::new(HashMap::new())),
            ingest_store_lock: Arc::new(Mutex::new(())),
            ingest_events,
        }
    }

    pub async fn project_ingest_semaphore(&self, project_id: &str) -> Arc<Semaphore> {
        let mut locks = self.ingest_project_locks.lock().await;
        locks
            .entry(project_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }
}

fn allowed_data_roots(primary: &PathBuf) -> Vec<PathBuf> {
    let mut roots = vec![primary.clone()];

    if let Ok(extra) = std::env::var("WIKI_EXTRA_DATA_PATHS") {
        roots.extend(
            extra
                .split(';')
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(PathBuf::from),
        );
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(4) {
            roots.push(ancestor.join("wiki-data"));
        }
    }

    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|root| {
            let key = root.to_string_lossy().replace('\\', "/").to_lowercase();
            seen.insert(key)
        })
        .collect()
}
