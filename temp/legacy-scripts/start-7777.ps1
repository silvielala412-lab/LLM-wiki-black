$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "server-rs\target\release\llm-wiki-server.exe"
$stdout = Join-Path $root "server-7777.log"
$stderr = Join-Path $root "server-7777.err.log"
$localEnv = Join-Path $root "server-env.local.ps1"

if (-not (Test-Path $exe)) {
  throw "Server binary not found: $exe"
}

$existing = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $pidList = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  throw "Port 7777 is already listening. Owning process: $pidList"
}

if (Test-Path $localEnv) {
  . $localEnv
}

$command = @"
`$env:APP_HOST='0.0.0.0'
`$env:APP_PORT='7777'
`$env:WIKI_DATA_PATH='$root\wiki-data'
`$env:STATIC_DIR='$root\dist'
`$env:RUST_LOG='info'
`$env:Path='$root\.runtime\poppler\poppler-26.02.0\Library\bin;' + `$env:Path
& '$exe'
"@

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr

Start-Sleep -Seconds 2
Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
