import path from "path"
import { defineConfig } from "vite"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "frontend/src") },
  },
  build: {
    ssr: path.resolve(__dirname, "backend/worker/ingest-worker.ts"),
    outDir: path.resolve(__dirname, "worker-dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "ingest-worker.js",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})
