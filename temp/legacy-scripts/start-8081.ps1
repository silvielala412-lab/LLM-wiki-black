# start-8081.ps1 — RAG dev server on port 8081
# 和 7777 完全独立，不影响现有服务
# 用于开发和测试新的 /api/rag/retrieve + 修复后的 vector 协议

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe      = Join-Path $root "server-rs\target\release\llm-wiki-server-8081.exe"
$stdout   = Join-Path $root "server-8081.log"
$stderr   = Join-Path $root "server-8081.err.log"
$localEnv = Join-Path $root "server-env.local.ps1"

if (-not (Test-Path $exe)) {
  throw "Server binary not found: $exe. Build the enhanced 8081 binary first."
}

$existing = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $pidList = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  throw "Port 8081 is already in use. PID(s): $pidList"
}

if (Test-Path $localEnv) {
  . $localEnv
}

$command = @"
`$env:APP_HOST='0.0.0.0'
`$env:APP_PORT='8081'
`$env:WIKI_DATA_PATH='$root\wiki-data'
`$env:STATIC_DIR='$root\dist'
`$env:RUST_LOG='info'
`$env:Path='$root\.runtime\poppler\poppler-26.02.0\Library\bin;' + `$env:Path
& '$exe'
"@

Write-Host "[8081] Starting RAG dev server..." -ForegroundColor Cyan

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr

Start-Sleep -Seconds 2

$listening = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "[8081] Server running on http://localhost:8081" -ForegroundColor Green
  $listening | Select-Object LocalAddress, LocalPort, OwningProcess
} else {
  Write-Warning "[8081] Server may not have started. Check server-8081.err.log"
}
