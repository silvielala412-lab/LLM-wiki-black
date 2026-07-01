import path from "path"
import { defineConfig } from "vite"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    ssr: path.resolve(__dirname, "src/server-worker/ingest-worker.ts"),
    outDir: "worker-dist",
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
