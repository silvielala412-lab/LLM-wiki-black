use std::path::PathBuf;

/// Server-level LLM / embedding / vision configuration.
/// Read once at startup from environment variables.
/// Exposed to the frontend via GET /api/config so users only need
/// to pick a model name — endpoints and keys are managed by the admin.
#[derive(Clone, Debug, serde::Serialize)]
pub struct LlmServerConfig {
    // ── Main LLM ──────────────────────────────────────────────────────
    /// e.g. "custom" / "openai" — maps to a frontend preset id
    pub provider: Option<String>,
    /// API key (never sent to frontend — only presence is indicated)
    #[serde(skip)]
    pub api_key: Option<String>,
    /// Whether an API key is configured (safe to send to frontend)
    pub has_api_key: bool,
    /// Default model name shown in frontend picker
    pub model: Option<String>,
    /// Base URL for chat completions (e.g. http://192.168.1.10:8080/v1)
    pub endpoint: Option<String>,
    /// Wire protocol: "chat_completions" | "anthropic_messages"
    pub api_mode: Option<String>,
    /// Context window size hint for the frontend
    pub max_context_size: Option<u32>,

    // ── Embedding ─────────────────────────────────────────────────────
    pub embedding_endpoint: Option<String>,
    pub embedding_model: Option<String>,

    // ── Vision / Multimodal (for image-PDF OCR) ───────────────────────
    pub vision_endpoint: Option<String>,
    pub vision_model: Option<String>,
    /// DPI for PDF-to-image conversion (default 150)
    pub pdf_dpi: u32,

    // ── Frontend behaviour ────────────────────────────────────────────
    /// If true the frontend shows server-supplied values as defaults but
    /// still allows the user to override them in Settings.
    pub allow_user_override: bool,
}

impl LlmServerConfig {
    pub fn from_env() -> Self {
        let api_key = Self::opt_env("LLM_API_KEY");
        Self {
            provider: Self::opt_env("LLM_PROVIDER"),
            has_api_key: api_key.is_some(),
            api_key,
            model: Self::opt_env("LLM_MODEL"),
            endpoint: Self::opt_env("LLM_ENDPOINT"),
            api_mode: Self::opt_env("LLM_API_MODE"),
            max_context_size: Self::opt_env("LLM_MAX_CONTEXT")
                .and_then(|v| v.parse().ok()),
            embedding_endpoint: Self::opt_env("EMBEDDING_ENDPOINT"),
            embedding_model: Self::opt_env("EMBEDDING_MODEL"),
            vision_endpoint: Self::opt_env("VISION_ENDPOINT"),
            vision_model: Self::opt_env("VISION_MODEL"),
            pdf_dpi: Self::opt_env("PDF_DPI")
                .and_then(|v| v.parse().ok())
                .unwrap_or(150),
            allow_user_override: Self::opt_env("SERVER_CONFIG_LOCKED")
                .map(|v| v.to_lowercase() != "true")
                .unwrap_or(true),
        }
    }

    fn opt_env(key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }

    /// Return the API key for use in proxied requests (never logged).
    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub data_root: PathBuf,
    pub llm_config: LlmServerConfig,
}
