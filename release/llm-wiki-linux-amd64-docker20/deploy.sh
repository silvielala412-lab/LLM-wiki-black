#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env. Fill in LLM_ENDPOINT, LLM_API_KEY and LLM_MODEL, then run this script again."
  exit 1
fi

if grep -Eq '^(LLM_ENDPOINT=http://YOUR_|LLM_API_KEY=REPLACE_ME|LLM_MODEL=REPLACE_ME)$' .env; then
  echo "Edit .env and provide the required LLM settings before deployment."
  exit 1
fi

sha256sum -c llm-wiki-image.sha256
gzip -dc llm-wiki-image.tar.gz | docker load
mkdir -p data

if docker compose version >/dev/null 2>&1; then
  docker compose up -d
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d
else
  echo "Docker Compose is not installed."
  exit 1
fi

echo "LLM Wiki is starting on port $(grep '^HOST_PORT=' .env | cut -d= -f2 || echo 8231)."
