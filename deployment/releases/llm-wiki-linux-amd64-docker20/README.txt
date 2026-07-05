LLM Wiki Linux Docker 20 deployment bundle
Target: Linux x86_64 / amd64, Docker Engine 20.10+

Files:
  llm-wiki-image.tar.gz   Docker image archive
  llm-wiki-image.sha256   SHA-256 checksum
  docker-compose.yml      Runtime definition
  .env.example            Model/API configuration template
  deploy.sh               Load and start script
  DEPLOYMENT.md           Detailed Chinese deployment guide
  API_REFERENCE.md        Frontend/backend and external API reference

Deployment:
  1. Copy this whole directory to the Linux server.
  2. Run: cp .env.example .env
  3. Edit .env and set LLM_ENDPOINT, LLM_API_KEY and LLM_MODEL.
  4. Make the script executable: chmod +x deploy.sh
  5. Run: ./deploy.sh (verifies SHA-256 before loading the image)
  6. Check: curl http://127.0.0.1:8231/api/health

Notes:
  - The real .env is created beside docker-compose.yml during deployment.
  - See DEPLOYMENT.md for model, OCR, networking, backup and troubleshooting.
  - See API_REFERENCE.md for all /api routes and external model contracts.
  - deploy.sh makes ./data writable by the container user (UID 1001).
  - API keys are not included in the image.
  - The model endpoint must be reachable from inside the container.
  - The image includes Node.js 20 for server-side product batch ingestion.
  - INGEST_WORKER_CONCURRENCY controls concurrent extraction jobs (default: 2).
  - localhost inside the container means the container itself. Use an intranet IP,
    a Compose service name, or host.docker.internal on Docker 20.10+.
  - Persistent project data is stored in ./data.
