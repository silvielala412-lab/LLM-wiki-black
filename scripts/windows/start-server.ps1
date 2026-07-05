$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverExe = Join-Path $repoRoot "backend\target\debug\llm-wiki-server.exe"

if (!(Test-Path -LiteralPath $serverExe)) {
  throw "Missing server executable: $serverExe. Run: cargo build --manifest-path backend/Cargo.toml"
}

$env:APP_HOST = "127.0.0.1"
$env:APP_PORT = "8232"
$env:WIKI_DATA_PATH = Join-Path $repoRoot "wiki-data"
$env:STATIC_DIR = Join-Path $repoRoot "dist"
$env:INGEST_WORKER_PATH = Join-Path $repoRoot "worker-dist\ingest-worker.js"
$env:INGEST_WORKER_CONCURRENCY = "2"
$env:INGEST_SECTION_PARALLEL = "4"
$env:RUST_LOG = "llm_wiki_server=info,tower_http=warn"

Set-Location -LiteralPath $repoRoot
& $serverExe
