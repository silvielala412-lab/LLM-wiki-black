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
