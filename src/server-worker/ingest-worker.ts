import fs from "node:fs/promises"
import process from "node:process"

interface ProductBatchFile {
  stored_path: string
}

interface ProductIngestBatch {
  batch_id: string
  project_id: string
  project_name: string
  project_path: string
  product_name: string
  insurance_category: string
  manifest_path?: string
  files: ProductBatchFile[]
}

interface ProductRefinementJob {
  job_id: string
  project_id: string
  project_name: string
  project_path: string
  insurance_category?: string
  product_name?: string
}

interface RefinementSummary {
  totalModules: number
  refined: number
  fieldsUpdated: number
  skipped: number
  mainFilesRebuilt: number
  fieldGapsAttempted?: number
  fieldGapsRefined?: number
}

interface ProductBatchSummary {
  batch_id: string
  status: string
}

interface WorkerResult {
  written_files: string[]
  warnings: string[]
  error?: string
  refinement?: RefinementSummary
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

function installServerGlobals(): void {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
  Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true })

  const apiBase = (process.env.LLM_WIKI_API_BASE || "http://127.0.0.1:8000").replace(/\/$/, "")
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/")) {
      return nativeFetch(`${apiBase}${input}`, init)
    }
    if (input instanceof URL && input.pathname.startsWith("/") && !input.host) {
      return nativeFetch(new URL(input.pathname + input.search, apiBase), init)
    }
    return nativeFetch(input, init)
  }) as typeof fetch
}

async function writeResult(path: string, result: WorkerResult): Promise<void> {
  await fs.writeFile(path, JSON.stringify(result, null, 2), "utf8")
}

async function shouldFinalizeProject(batch: ProductIngestBatch): Promise<boolean> {
  try {
    const query = new URLSearchParams({ project_name: batch.project_name, limit: "5000" })
    const response = await fetch(`/api/ingest/product-batches?${query.toString()}`)
    if (!response.ok) return true
    const batches = await response.json() as ProductBatchSummary[]
    return !batches.some(item =>
      item.batch_id !== batch.batch_id && (item.status === "queued" || item.status === "processing"),
    )
  } catch {
    return true
  }
}

async function main(): Promise<void> {
  const batchPath = process.argv[2]
  const resultPath = process.argv[3]
  const finalizeOnly = process.argv.includes("--finalize-only")
  const repairScopedFields = process.argv.includes("--repair-scoped-fields")
  const refineMode = process.argv.includes("--refine")
  if (!batchPath || !resultPath) {
    throw new Error("Usage: ingest-worker <batch.json> <worker-result.json>")
  }

  installServerGlobals()
  const payload = JSON.parse(await fs.readFile(batchPath, "utf8")) as ProductIngestBatch | ProductRefinementJob
  const batch = payload as ProductIngestBatch
  if (!refineMode && !finalizeOnly && (!batch.manifest_path || batch.files.length === 0)) {
    throw new Error("Batch has no product manifest or uploaded files")
  }

  const [wikiStoreModule, serverConfigModule, ingestModule, catalogModule] = await Promise.all([
    import("@/stores/wiki-store"),
    import("@/lib/server-config"),
    import("@/lib/ingest"),
    import("@/lib/product-catalog-modules"),
  ])

  const { useWikiStore } = wikiStoreModule
  await serverConfigModule.applyServerConfig()
  const store = useWikiStore.getState()
  store.setProject({
    id: batch.project_id,
    name: batch.project_name,
    path: batch.project_path,
  })
  const llmConfig = useWikiStore.getState().llmConfig
  const canUseLlm = Boolean(
    llmConfig.apiKey || llmConfig.provider === "custom" || llmConfig.provider === "ollama",
  )
  if ((!finalizeOnly || repairScopedFields) && !canUseLlm) {
    throw new Error("Server-managed LLM is not configured")
  }

  let writtenFiles: string[] = []
  const warnings: string[] = []
  if (refineMode) {
    const job = payload as ProductRefinementJob
    const extractor = await import("@/lib/product-catalog-extractor")
    const activityId = `server-refinement-${job.job_id}`
    const refinement = job.insurance_category && job.product_name
      ? await extractor.refineModuleFiles(
          job.project_path,
          job.insurance_category,
          job.product_name,
          llmConfig,
          activityId,
        )
      : await extractor.refineAllProductModules(job.project_path, llmConfig, activityId)
    if (refinement.fieldsUpdated > 0) {
      try {
        const { runConceptAggregator } = await import("@/lib/concept-aggregator")
        await runConceptAggregator(job.project_path)
      } catch (error) {
        warnings.push(`Concept aggregation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await writeResult(resultPath, { written_files: [], warnings, refinement })
    return
  }
  if (!finalizeOnly) {
    const folderContext = catalogModule.encodeProductCatalogFolderContext(
      batch.insurance_category as Parameters<typeof catalogModule.encodeProductCatalogFolderContext>[0],
      batch.product_name,
      [],
      0,
    )
    console.log(`[ingest-worker] batch=${batch.batch_id} project=${batch.project_name} product=${batch.product_name}`)
    writtenFiles = await ingestModule.autoIngest(
      batch.project_path,
      batch.manifest_path!,
      llmConfig,
      undefined,
      folderContext,
      { skipRelationPass: true },
    )
  }

  if (repairScopedFields) {
    try {
      const { repairProductCatalogDocumentScopedFields } = await import("@/lib/product-catalog-extractor")
      const result = await repairProductCatalogDocumentScopedFields(batch.project_path, llmConfig)
      console.log(`[ingest-worker] document-scoped fields repaired ${JSON.stringify(result)}`)
    } catch (error) {
      warnings.push(`Document-scoped field repair failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (finalizeOnly || await shouldFinalizeProject(batch)) {
    try {
      const { backfillProductCatalogAliases } = await import("@/lib/product-catalog-extractor")
      const updated = await backfillProductCatalogAliases(batch.project_path)
      console.log(`[ingest-worker] product aliases synchronized files=${updated}`)
    } catch (error) {
      warnings.push(`Product alias synchronization failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const { runConceptAggregator } = await import("@/lib/concept-aggregator")
      const result = await runConceptAggregator(batch.project_path)
      console.log(`[ingest-worker] concept aggregation complete ${JSON.stringify(result)}`)
    } catch (error) {
      warnings.push(`Concept aggregation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const { sweepResolvedReviews } = await import("@/lib/sweep-reviews")
      await sweepResolvedReviews(batch.project_path)
    } catch (error) {
      warnings.push(`Review sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await writeResult(resultPath, { written_files: writtenFiles, warnings })
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error(`[ingest-worker] ${message}`)
  const resultPath = process.argv[3]
  if (resultPath) {
    await writeResult(resultPath, { written_files: [], warnings: [], error: message }).catch(() => undefined)
  }
  process.exitCode = 1
})
