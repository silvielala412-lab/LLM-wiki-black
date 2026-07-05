# Repository structure

The repository is organized by deployable responsibility. Product code must live in one of the first four directories below; generated output, experiments, and retired material do not belong beside it.

```text
LLM Wiki/
├── frontend/       React/Vite web application
│   ├── index.html
│   └── src/
├── backend/        Rust HTTP API and Node ingestion worker
│   ├── src/
│   └── worker/
├── desktop/        Tauri desktop shell
├── extensions/     Browser integrations
│   └── browser/
├── deployment/     Docker files, configuration examples, release packages
├── docs/           Architecture, plans, and project history
├── examples/       Demo documents and API examples
├── scripts/        Maintained automation grouped by platform
├── temp/           Legacy, diagnostic, and scratch material
├── assets/         Images used by the repository README files
└── package.json    Shared Node/Vite/Tauri commands
```

## Boundaries

- `frontend/` owns browser UI and browser-side domain logic. It communicates with the backend through `/api`.
- `backend/src/` owns the HTTP API, persistence, server configuration, and static-file hosting.
- `backend/worker/` owns the ingestion worker entry point. It currently imports some shared TypeScript modules from `frontend/src/`; this is a transitional dependency and should move to a future `packages/` workspace when those modules stabilize.
- `desktop/` is an application shell and native adapter. New product logic should not be added there unless it requires a native capability.
- `deployment/` may reference build outputs, but application source must not import deployment files.
- `examples/` is safe to ship as sample input. `temp/` is not production source and must never be imported by product code.

## Standard commands

Run commands from the repository root:

```powershell
npm install
npm run dev
npm run build:frontend
npm run build:worker
npm run typecheck
npm run check:backend
npm run tauri:dev
npm run tauri:build
```

Build the container with the repository root as its context:

```powershell
docker build -t llm-wiki:latest -f deployment/Dockerfile .
docker compose -f deployment/docker-compose.yml up -d
```

Runtime data stays in `wiki-data/`; generated frontend and worker bundles stay in `dist/` and `worker-dist/`. All three are ignored by Git.

## Placement rules

1. Put new UI code under `frontend/src/`.
2. Put new server routes and services under `backend/src/`.
3. Put maintained operational scripts under `scripts/<platform>/`.
4. Put fixtures intended to demonstrate the product under `examples/`.
5. Put one-off diagnostics, retired scripts, copied release artifacts, and investigation notes under the matching `temp/` category.
6. Do not create a new top-level directory without documenting its ownership here.
