#!/usr/bin/env pwsh
# build-for-intranet.ps1
# 在有外网的 Windows 机器上运行，产出可离线传输到内网的 .tar 包

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$IMAGE  = "llm-wiki:latest"
$OUTPUT = "llm-wiki-intranet.tar"

Write-Host "==> [1/3] Building Docker image (first run ~20-40 min due to Rust compilation)..." -ForegroundColor Cyan
docker build -t $IMAGE -f Dockerfile .

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed. Check output above."
    exit 1
}

Write-Host "==> [2/3] Saving image to $OUTPUT ..." -ForegroundColor Cyan
docker save $IMAGE -o $OUTPUT

$sizeMB = [math]::Round((Get-Item $OUTPUT).Length / 1MB, 1)
Write-Host "==> [3/3] Done! Package: $OUTPUT ($sizeMB MB)" -ForegroundColor Green

Write-Host @"

---- 接下来的步骤 ----
1. 将以下两个文件传到内网服务器:
   - $OUTPUT
   - docker-compose.yml

2. 在内网服务器上执行:
   docker load -i $OUTPUT
   mkdir -p wiki-data
   docker-compose up -d

3. 用户访问:
   http://<服务器IP>:8000
"@
