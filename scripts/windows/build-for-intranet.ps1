#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$dockerfile = Join-Path $repoRoot "deployment\Dockerfile"
$composeFile = Join-Path $repoRoot "deployment\docker-compose.yml"
$artifactDir = Join-Path $repoRoot "temp\artifacts"
$output = Join-Path $artifactDir "llm-wiki-intranet.tar"
$image = "llm-wiki:latest"

New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

Write-Host "==> [1/3] Building Docker image..." -ForegroundColor Cyan
docker build -t $image -f $dockerfile $repoRoot
if ($LASTEXITCODE -ne 0) {
  throw "Docker build failed."
}

Write-Host "==> [2/3] Saving image to $output ..." -ForegroundColor Cyan
docker save $image -o $output
if ($LASTEXITCODE -ne 0) {
  throw "Docker image export failed."
}

$sizeMB = [math]::Round((Get-Item -LiteralPath $output).Length / 1MB, 1)
Write-Host "==> [3/3] Done: $output ($sizeMB MB)" -ForegroundColor Green
Write-Host "Copy the image archive and $composeFile to the intranet host, then run docker load and docker compose up -d."
