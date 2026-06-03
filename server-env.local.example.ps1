# Copy this file to server-env.local.ps1 and fill local-only secrets.
# Do not commit or share the local file.

$env:LLM_PROVIDER = "deepseek"
$env:LLM_ENDPOINT = "https://api.deepseek.com/v1"
$env:LLM_MODEL = "deepseek-chat"
$env:LLM_API_MODE = "chat_completions"
$env:LLM_MAX_CONTEXT = "64000"
$env:LLM_API_KEY = ""

$env:SEARCH_PROVIDER = "perplexity"
$env:SEARCH_API_KEY = ""

$env:EMBEDDING_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
$env:EMBEDDING_MODEL = "tongyi-embedding-vision-plus-2026-03-06"
$env:EMBEDDING_API_KEY = ""
