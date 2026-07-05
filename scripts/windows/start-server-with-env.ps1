$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverRoot = Join-Path $repoRoot "backend"
$envFile = Join-Path $serverRoot ".env"
$serverExe = Join-Path $serverRoot "target\debug\llm-wiki-server.exe"

if (!(Test-Path -LiteralPath $envFile)) {
  throw "Missing env file: $envFile"
}

if (!(Test-Path -LiteralPath $serverExe)) {
  throw "Missing server executable: $serverExe. Run: cargo build --manifest-path backend/Cargo.toml"
}

foreach ($line in Get-Content -LiteralPath $envFile) {
  $trim = $line.Trim()
  if (!$trim -or $trim.StartsWith("#")) { continue }
  if ($trim -notmatch "^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") { continue }

  $name = $Matches[1]
  $value = $Matches[2].Trim()
  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  Set-Item -Path "Env:$name" -Value $value
}

Set-Location -LiteralPath $repoRoot
& $serverExe
