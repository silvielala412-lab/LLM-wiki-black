import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST
const frontendRoot = path.resolve(__dirname, "frontend")

// Read version from package.json at config-load time so the Settings
// UI can show the running app version without duplicating the string.
const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  root: frontendRoot,
  cacheDir: path.resolve(__dirname, "node_modules/.vite"),
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { "@": path.resolve(frontendRoot, "src") },
  },

  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
  },

  // Vite dev server config
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 3001 } : undefined,
    watch: { ignored: ["**/desktop/**", "**/backend/**", "**/wiki-data/**", "**/.runtime/**"] },
    // Web mode: proxy /api → Rust backend (llm-wiki-server)
    // Port is read from APP_PORT env var (default 8232) so it stays
    // in sync with scripts/windows/start-server.ps1.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.APP_PORT ?? "8232"}`,
        changeOrigin: true,
      },
    },
  },

  test: {
    environment: "node",
    // Loads .env.test.local into process.env for real-LLM tests.
    // The loader itself is a no-op if the file is absent, so this is
    // safe to keep on for every test run.
    setupFiles: ["./src/test-helpers/load-test-env.ts"],
  },
}))
