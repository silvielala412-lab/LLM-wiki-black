# Deployment

Docker commands use the repository root as their build context:

```powershell
docker build -t llm-wiki:latest -f deployment/Dockerfile .
docker compose -f deployment/docker-compose.yml up -d
```

Copy `deployment/config/server-env.local.example.ps1` to the ignored root file `server-env.local.ps1` for machine-specific PowerShell configuration. Historical distributable packages live under `deployment/releases/`; generated image archives and runtime data are intentionally ignored.
