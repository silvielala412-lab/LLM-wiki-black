/**
 * fs.ts — Web mode
 * Re-exports all functions from api-client.ts so that the rest of the
 * codebase keeps its existing `import { readFile } from "@/commands/fs"`
 * imports without any changes.
 */
export {
  readFile,
  writeFile,
  listDirectory,
  fileExists,
  deleteFile,
  createDirectory,
  copyFile,
  copyDirectory,
  preprocessFile,
  readFileAsBase64,
  findRelatedWikiPages,
  clipServerStatus,
  listProjects,
  createProject,
  createProjectAuto,
  openProject,
  vectorUpsertChunks,
  vectorSearchChunks,
  vectorDeletePage,
  vectorCountChunks,
  vectorDropLegacy,
  uploadFile,
  uploadFiles,
  createProductIngestBatch,
  uploadProductIngestFile,
  startProductIngestBatch,
  retryProductIngestBatch,
  getProductIngestBatch,
  listProductIngestBatches,
  createProductRefinementJob,
  getProductRefinementJob,
  convertFileSrc,
} from "@/commands/api-client"

export type {
  FileBase64,
  ProductIngestBatch,
  ProductIngestBatchFile,
  ProductIngestBatchStatus,
  CreateProductIngestBatchInput,
  ProductRefinementJob,
  ProductRefinementJobStatus,
  ProductRefinementSummary,
  CreateProductRefinementJobInput,
} from "@/commands/api-client"
