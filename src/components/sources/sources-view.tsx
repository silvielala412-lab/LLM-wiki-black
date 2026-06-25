import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown, Layers, Upload, GitMerge, LayoutList, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { copyFile, listDirectory, readFile, writeFile, deleteFile, findRelatedWikiPages, preprocessFile, fileExists } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { enqueueIngest, enqueueBatch } from "@/lib/ingest-queue"
import { useTranslation } from "react-i18next"
import { normalizePath, getFileName } from "@/lib/path-utils"
import {
  buildDeletedKeys,
  cleanIndexListing,
  stripDeletedWikilinks,
  extractFrontmatterTitle,
  type DeletedPageInfo,
} from "@/lib/wiki-cleanup"
import { parseSources, writeSources } from "@/lib/sources-merge"
import { decidePageFate } from "@/lib/source-delete-decision"
import { removeFromIngestCache } from "@/lib/ingest-cache"
import {
  collectAllFilesIncludingDot,
  decideDeleteClick,
} from "@/lib/sources-tree-delete"
import { SERVICE_HIERARCHY } from "@/lib/insurance-schema-registry"
import type { ServiceHierarchySeries } from "@/lib/insurance-schema-registry"
import {
  INSURANCE_CATEGORIES,
  PRODUCT_FIELDS,
  PRODUCT_CATALOG_MODULES,
  type InsuranceCategoryType,
  buildProductModuleTitle,
  getRequiredModules,
  calcModuleCompleteness,
  parseProductModuleTitle,
  encodeProductCatalogFolderContext,
} from "@/lib/product-catalog-modules"
import { getLogger } from "@/lib/logger"

const log = getLogger("upload")
const logDel = getLogger("delete")

type UploadResult = { path: string; name: string; size: number } | { error: string; name: string }

export function SourcesView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [ingestingPath, setIngestingPath] = useState<string | null>(null)
  /** "files" = classic flat file tree; "hierarchy" = 5-level service hierarchy upload; "products" = insurance product catalog upload */
  const [viewMode, setViewMode] = useState<"files" | "hierarchy" | "products">("files")
  /**
   * Path of the source-tree node currently in "click again to
   * confirm delete" state. Lifted up here (rather than living
   * inside SourceTree) for two reasons:
   *   1. Only one button can be armed at a time across the whole
   *      tree — clicking another delete disarms the prior one.
   *      Lifting state to the common ancestor makes that natural.
   *   2. The auto-disarm timer (5s) needs to survive across re-
   *      renders triggered by tree mutation; useEffect cleanup
   *      anchored here is the right scope.
   */
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null)

  // Auto-disarm: 5 seconds without a second click resets the
  // pending state. Prevents a stale armed button from firing if
  // the user walked away and came back. Cleared whenever the
  // pending path changes (so a fresh arm restarts the clock).
  useEffect(() => {
    if (!pendingDeletePath) return
    const t = setTimeout(() => setPendingDeletePath(null), 5000)
    return () => clearTimeout(t)
  }, [pendingDeletePath])

  /** Auto-clear upload error after 8 s so it doesn't linger forever */
  useEffect(() => {
    if (!importError) return
    const t = setTimeout(() => setImportError(null), 8000)
    return () => clearTimeout(t)
  }, [importError])

  /** Extract a human-readable message from any caught value */
  function extractErrMsg(err: unknown): string {
    if (err instanceof Error) {
      return err.message.trim() || `未知错误 (${err.name})`
    }
    const s = String(err)
    return s === "[object Object]" || !s ? "上传失败，请检查服务器连接" : s
  }

  async function uploadFilesOneByOne(
    files: File[],
    destDir: string,
    statusText: (file: File, index: number, total: number) => string,
  ): Promise<UploadResult[]> {
    const { uploadFile } = await import("@/commands/fs")
    const results: UploadResult[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setImportStatus(statusText(file, i + 1, files.length))
      try {
        results.push(await uploadFile(file, destDir))
      } catch (err) {
        const message = extractErrMsg(err)
        results.push({ error: message, name: file.name })
        log.warn("upload file failed", { dest: destDir, file: file.name, error: message })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    return results
  }

  const loadSources = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const tree = await listDirectory(`${pp}/raw/sources`)
      // Filter out hidden files/dirs and cache
      const filtered = filterTree(tree)
      setSources(filtered)
    } catch {
      setSources([])
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources])

  /**
   * Upload files into a specific service line version directory.
   * Destination: raw/sources/{lineName}/{versionName}/
   * The ingest pipeline will detect the path and inject service line context.
   */
  async function handleVersionUpload(lineName: string, versionName: string) {
    if (!project) return
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.accept = ".pdf,.md,.mdx,.txt,.docx,.xlsx,.png,.jpg,.jpeg"
    input.onchange = async () => {
      const files = Array.from(input.files ?? [])
      if (!files.length) return
      setImporting(true)
      setImportError(null)
      setImportStatus(`正在上传到 ${lineName}-${versionName}...`)
      const pp = normalizePath(project.path)
      // Upload destination encodes the service line context in the path
      const destDir = `${pp}/raw/sources/${lineName}/${versionName}`
      try {
        log.info("upload start", { dest: `${lineName}/${versionName}`, files: files.length })
        const results = await uploadFilesOneByOne(
          files,
          destDir,
          (file, index, total) => `正在逐个上传 ${lineName}-${versionName} ${index}/${total}: ${file.name}`,
        )
        const importedPaths: string[] = results
          .filter((r): r is { path: string; name: string; size: number } => "path" in r)
          .map((r) => r.path)
        const errorCount = results.filter((r) => "error" in r).length
        log.info("upload done", { dest: `${lineName}/${versionName}`, success: importedPaths.length, errors: errorCount })
        setImportStatus(
          errorCount > 0
            ? `上传完成：${importedPaths.length} 成功，${errorCount} 失败`
            : `✓ ${lineName}-${versionName}: ${importedPaths.length} 个文件已上传`
        )
        await loadSources()
        const canIngest = !!(llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")
        if (canIngest && importedPaths.length > 0) {
          setImportStatus(`正在排队解析 ${importedPaths.length} 个文件 (${lineName}-${versionName})...`)
          const tasks = importedPaths.map((absPath) => ({
            sourcePath: absPath.startsWith(pp + "/") ? absPath.slice(pp.length + 1) : absPath,
            folderContext: `${lineName} > ${versionName}`,
          }))
          log.info("enqueue batch", { project: project.id, count: tasks.length, context: `${lineName}>${versionName}` })
          enqueueBatch(project.id, tasks).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            log.error("enqueue batch failed", { error: msg })
            setImportError(`⚠️ 排队失败: ${msg}（请刷新页面后重试）`)
          })
        } else if (!canIngest) {
          setImportError("⚠️ LLM 未配置，文件已上传但无法自动解析。请在设置中配置 API Key 后手动触发解析。")
        }
        setTimeout(() => setImportStatus(null), 5000)
      } catch (err) {
        log.error("upload failed", { dest: destDir, error: extractErrMsg(err) })
        setImportError(`上传失败: ${extractErrMsg(err)}`)
        console.error("[handleVersionUpload] upload error:", err)
      } finally {
        setImporting(false)
      }
    }
    input.click()
  }

  const PRODUCT_UPLOAD_ACCEPT = ".pdf,.md,.mdx,.txt,.docx,.xlsx,.xls,.csv,.json,.png,.jpg,.jpeg"
  const PRODUCT_UPLOAD_EXTS = new Set(PRODUCT_UPLOAD_ACCEPT.split(",").map((ext) => ext.slice(1)))
  const PRODUCT_BUNDLE_MANIFEST_NAME = "__product_bundle__.json"

  function isSupportedProductUploadFile(file: File): boolean {
    if (file.name.startsWith("~$")) return false
    const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
    return PRODUCT_UPLOAD_EXTS.has(ext)
  }

  /**
   * Upload files for a specific insurance product (product catalog domain).
   * Destination: raw/sources/产品/{category}/{productName}/
   * folderContext: "product_catalog > {category} > {productName}"
   * The ingest pipeline detects this folderContext and routes to product catalog extraction.
   */
  async function handleProductUpload(category: InsuranceCategoryType, productName: string, mode: "files" | "folder" = "files") {
    if (!project || !productName.trim()) return
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.accept = PRODUCT_UPLOAD_ACCEPT
    if (mode === "folder") {
      // @ts-expect-error — webkitdirectory is not in TS types but works in all modern browsers
      input.webkitdirectory = true
    }
    input.onchange = async () => {
      const selectedFiles = Array.from(input.files ?? [])
      const files = selectedFiles.filter(isSupportedProductUploadFile)
      if (!files.length) return
      setImporting(true)
      setImportError(null)
      const pp = normalizePath(project.path)
      const destDir = `${pp}/raw/sources/产品/${category}/${productName.trim()}`
      setImportStatus(
        mode === "folder"
          ? `正在上传产品文件夹到 ${category} > ${productName}...`
          : `正在上传到 ${category} > ${productName}...`
      )
      try {
        log.info("product upload start", { dest: `产品/${category}/${productName}`, files: files.length, mode })
        const { writeFile } = await import("@/commands/fs")
        const results = await uploadFilesOneByOne(
          files,
          destDir,
          (file, index, total) =>
            mode === "folder"
              ? `正在逐个上传产品文件夹 ${index}/${total}: ${file.name}`
              : `正在逐个上传 ${index}/${total}: ${file.name}`,
        )
        const importedPaths: string[] = results
          .filter((r): r is { path: string; name: string; size: number } => "path" in r)
          .map((r) => r.path)
        const errorCount = results.filter((r) => "error" in r).length
        log.info("product upload done", { dest: destDir, success: importedPaths.length, errors: errorCount })
        setImportStatus(
          errorCount > 0
            ? `上传完成：${importedPaths.length} 成功，${errorCount} 失败`
            : `✓ ${category} > ${productName}：${importedPaths.length} 个文件已上传`
        )
        await loadSources()
        const canIngest = !!(llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")
        if (canIngest && importedPaths.length > 0) {
          const tasks_pc: Array<{ sourcePath: string; folderContext: string }> = []
          const folderContext = encodeProductCatalogFolderContext(category, productName.trim(), [], 0)
          if (mode === "folder" || importedPaths.length > 1) {
            const uploadedByPath = new Map(
              results
                .filter((r): r is { path: string; name: string; size: number } => "path" in r)
                .map((r) => [normalizePath(r.path), r])
            )
            const manifestPath = `${destDir}/${PRODUCT_BUNDLE_MANIFEST_NAME}`
            const manifest = {
              kind: "product_catalog_bundle",
              version: 1,
              insurance_category: category,
              product_name: productName.trim(),
              created_at: new Date().toISOString(),
              upload_mode: mode,
              files: importedPaths.map((absPath, index) => {
                const normalized = normalizePath(absPath)
                const uploaded = uploadedByPath.get(normalized)
                const selected = files[index]
                return {
                  name: uploaded?.name ?? selected?.name ?? getFileName(normalized),
                  path: normalized.startsWith(pp + "/") ? normalized.slice(pp.length + 1) : normalized,
                  size: uploaded?.size ?? selected?.size ?? 0,
                  original_relative_path: (selected as File & { webkitRelativePath?: string } | undefined)?.webkitRelativePath ?? "",
                }
              }),
            }
            await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
            const manifestSourcePath = manifestPath.startsWith(pp + "/") ? manifestPath.slice(pp.length + 1) : manifestPath
            tasks_pc.push({
              sourcePath: manifestSourcePath,
              folderContext,
            })
          } else {
            for (const absPath of importedPaths) {
              const sourcePath = absPath.startsWith(pp + "/") ? absPath.slice(pp.length + 1) : absPath
              tasks_pc.push({ sourcePath, folderContext })
            }
          }
          log.info("product enqueue batch", { project: project.id, files: importedPaths.length, tasks: tasks_pc.length })
          enqueueBatch(project.id, tasks_pc).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            log.error("product enqueue failed", { error: msg })
            setImportError(`\u26a0\ufe0f \u6392\u961f\u5931\u8d25: ${msg}`)
          })
        } else if (!canIngest) {
          setImportError("\u26a0\ufe0f LLM \u672a\u914d\u7f6e\uff0c\u6587\u4ef6\u5df2\u4e0a\u4f20\u4f46\u65e0\u6cd5\u81ea\u52a8\u89e3\u6790\u3002")
        }
        setTimeout(() => setImportStatus(null), 5000)
      } catch (err) {
        log.error("product upload failed", { dest: destDir, error: extractErrMsg(err) })
        setImportError(`上传失败: ${extractErrMsg(err)}`)
      } finally {
        setImporting(false)
      }
    }
    input.click()
  }

  async function handleImport() {
    if (!project) return
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.accept = ".md,.mdx,.txt,.rtf,.pdf,.html,.htm,.xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.epub,.json,.csv,.yaml,.yml,.py,.js,.ts,.png,.jpg,.jpeg,.gif,.webp"
    input.onchange = async () => {
      const files = Array.from(input.files ?? [])
      if (!files.length) return
      setImporting(true)
      setImportError(null)
      setImportStatus(`正在上传 ${files.length} 个文件...`)
      const pp = normalizePath(project.path)
      const destDir = `${pp}/raw/sources`
      try {
        log.info("upload start", { dest: "raw/sources", files: files.length })
        const results = await uploadFilesOneByOne(
          files,
          destDir,
          (file, index, total) => `正在逐个上传 ${index}/${total}: ${file.name}`,
        )
        const importedPaths: string[] = results
          .filter((r): r is { path: string; name: string; size: number } => "path" in r)
          .map((r) => r.path)
        const errorCount = results.filter((r) => "error" in r).length
        log.info("upload done", { dest: "raw/sources", success: importedPaths.length, errors: errorCount })
        setImportStatus(
          errorCount > 0
            ? `上传完成：${importedPaths.length} 成功，${errorCount} 失败`
            : `上传成功：${importedPaths.length} 个文件`
        )
        await loadSources()
        // Trigger ingest: works whether key is local or server-managed (__SERVER_MANAGED__)
        const canIngest = !!(llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")
        if (canIngest && importedPaths.length > 0) {
          setImportStatus(`正在排队解析 ${importedPaths.length} 个文件...`)
          // Convert absolute server paths to relative sourcePaths for the queue
          const tasks = importedPaths.map((absPath) => ({
            sourcePath: absPath.startsWith(pp + "/") ? absPath.slice(pp.length + 1) : absPath,
            folderContext: "",
          }))
          log.info("enqueue batch", { project: project.id, count: tasks.length })
          enqueueBatch(project.id, tasks).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            log.error("enqueue batch failed", { error: msg })
            setImportError(`⚠️ 排队失败: ${msg}（请刷新页面后重试）`)
          })
        } else if (!canIngest) {
          setImportError("⚠️ LLM 未配置，文件已上传但无法自动解析。请在设置中配置 API Key 后手动触发解析。")
        }
        setTimeout(() => setImportStatus(null), 4000)
      } catch (err) {
        log.error("upload failed", { dest: destDir, error: extractErrMsg(err) })
        setImportError(`上传失败: ${extractErrMsg(err)}`)
        console.error("[handleImport] upload error:", err)
      } finally {
        setImporting(false)
      }
    }
    input.click()
  }

  async function handleImportFolder() {
    if (!project) return
    const input = document.createElement("input")
    input.type = "file"
    // @ts-expect-error — webkitdirectory is not in TS types but works in all modern browsers
    input.webkitdirectory = true
    input.multiple = true
    input.onchange = async () => {
      const files = Array.from(input.files ?? [])
      if (!files.length) return
      setImporting(true)
      setImportError(null)
      setImportStatus(`正在分析文件夹结构 (${files.length} 个文件)...`)
      const pp = normalizePath(project.path)
      try {
      const { SERVICE_HIERARCHY, resolveCanonicalVersionName } = await import("@/lib/insurance-schema-registry")

      /** Try to match a filename or relative path against known service lines/versions */
      function detectLineVersion(file: File): { lineName: string; versionName: string } | null {
        const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ""
        const parts = relPath.split("/").filter(Boolean)
        const name = file.name

        for (const ser of SERVICE_HIERARCHY) {
          for (const sc of ser.scenarios) {
            for (const ln of sc.lines) {
              for (const vn of ln.versions) {
                // 1. Exact path segment match
                if (parts.some(p => p === ln.lineName) && parts.some(p => p === vn.versionName)) {
                  return { lineName: ln.lineName, versionName: vn.versionName }
                }
                // 2. Filename contains both line and version (exact)
                if (name.includes(ln.lineName) && name.includes(vn.versionName)) {
                  return { lineName: ln.lineName, versionName: vn.versionName }
                }
              }

              // 3. Check path/name for version aliases (e.g. 易核版 → 尊享易核版)
              for (const vn of ln.versions) {
                // Try alias variants in path segments
                const aliasMatch = parts.find(p => {
                  const resolved = resolveCanonicalVersionName(ln.lineName, p)
                  return resolved === vn.versionName && resolved !== p
                })
                if (parts.some(p => p === ln.lineName) && aliasMatch) {
                  return { lineName: ln.lineName, versionName: vn.versionName }
                }
                // Try alias in filename parentheses: （易核版）
                const bracketMatch = name.match(/[（(]([^）)]+)[）)]/g)?.some(m => {
                  const inner = m.replace(/[（(）)]/g, "").trim()
                  return resolveCanonicalVersionName(ln.lineName, inner) === vn.versionName
                })
                if (name.includes(ln.lineName) && bracketMatch) {
                  return { lineName: ln.lineName, versionName: vn.versionName }
                }
              }
            }
          }
        }
        return null
      }

      /** Detect line-only match (no specific version identified) */
      function detectLineOnly(file: File): string | null {
        const name = file.name
        const parts = ((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").split("/").filter(Boolean)
        for (const ser of SERVICE_HIERARCHY) {
          for (const sc of ser.scenarios) {
            for (const ln of sc.lines) {
              if (parts.some(p => p === ln.lineName) || name.includes(ln.lineName)) {
                return ln.lineName
              }
            }
          }
        }
        return null
      }

      // Group files by detected destination
      const groups = new Map<string, { files: File[]; lineName: string; versionName: string }>()
      // Line-only files: service line identified but no specific version
      const lineOnlyGroups = new Map<string, { files: File[]; lineName: string; allVersions: string[] }>()
      const unclassified: File[] = []
      for (const f of files) {
        const detected = detectLineVersion(f)
        if (detected) {
          const key = `${detected.lineName}/${detected.versionName}`
          if (!groups.has(key)) groups.set(key, { files: [], ...detected })
          groups.get(key)!.files.push(f)
        } else {
          // Try line-only detection
          const { findServiceLine } = await import("@/lib/insurance-schema-registry")
          const line = detectLineOnly(f)
          if (line) {
            const lineInfo = findServiceLine(line)
            if (lineInfo) {
              if (!lineOnlyGroups.has(line)) lineOnlyGroups.set(line, { files: [], lineName: line, allVersions: lineInfo.versions })
              lineOnlyGroups.get(line)!.files.push(f)
            } else {
              unclassified.push(f)
            }
          } else {
            unclassified.push(f)
          }
        }
      }


      const allImportedTasks: Array<{ sourcePath: string; folderContext: string }> = []
      let successCount = 0, failCount = 0

      // Upload each group to its hierarchy destination
      for (const [, grp] of groups) {
        const destDir = `${pp}/raw/sources/${grp.lineName}/${grp.versionName}`
        setImportStatus(`正在上传到 ${grp.lineName}-${grp.versionName} (${grp.files.length} 个文件)...`)
        try {
          const results = await uploadFilesOneByOne(
            grp.files,
            destDir,
            (file, index, total) => `正在逐个上传 ${grp.lineName}-${grp.versionName} ${index}/${total}: ${file.name}`,
          )
          for (const r of results) {
            if ("path" in r) {
              successCount++
              allImportedTasks.push({
                sourcePath: r.path.startsWith(pp + "/") ? r.path.slice(pp.length + 1) : r.path,
                folderContext: `${grp.lineName} > ${grp.versionName}`,
              })
            } else failCount++
          }
        } catch (err) {
          log.error("upload failed", { dest: `${grp.lineName}/${grp.versionName}`, error: extractErrMsg(err) })
          console.error(`Upload to ${grp.lineName}/${grp.versionName} failed:`, err)
          failCount += grp.files.length
        }
      }

      // Upload cross-version (line-only) files to EACH version of that line
      // e.g. 平安臻享家医服务手册.pdf → raw/sources/臻享家医/V1/, V2/, V3/
      for (const [, grp] of lineOnlyGroups) {
        for (const versionName of grp.allVersions) {
          const destDir = `${pp}/raw/sources/${grp.lineName}/${versionName}`
          setImportStatus(`正在上传通用手册到 ${grp.lineName}-${versionName} (${grp.files.length} 个文件)...`)
          try {
            const results = await uploadFilesOneByOne(
              grp.files,
              destDir,
              (file, index, total) => `正在逐个上传 ${grp.lineName}-${versionName} ${index}/${total}: ${file.name}`,
            )
            for (const r of results) {
              if ("path" in r) {
                successCount++
                allImportedTasks.push({
                  sourcePath: r.path.startsWith(pp + "/") ? r.path.slice(pp.length + 1) : r.path,
                  folderContext: `${grp.lineName} > ${versionName}`,
                })
              } else failCount++
            }
          } catch (err) {
            log.error("upload failed", { dest: `${grp.lineName}/${versionName}`, error: extractErrMsg(err) })
            console.error(`Upload line-only to ${grp.lineName}/${versionName} failed:`, err)
            failCount += grp.files.length
          }
        }
      }

      // Upload unclassified files to flat raw/sources/
      if (unclassified.length > 0) {
        setImportStatus(`正在上传 ${unclassified.length} 个未识别文件...`)
        try {
          const results = await uploadFilesOneByOne(
            unclassified,
            `${pp}/raw/sources`,
            (file, index, total) => `正在逐个上传未分类文件 ${index}/${total}: ${file.name}`,
          )
          for (const r of results) {
            if ("path" in r) {
              successCount++
              allImportedTasks.push({
                sourcePath: r.path.startsWith(pp + "/") ? r.path.slice(pp.length + 1) : r.path,
                folderContext: "",
              })
            } else failCount++
          }
        } catch (err) { failCount += unclassified.length; console.error("[handleImportFolder] unclassified upload error:", err) }
      }

      const lineOnlyCount = [...lineOnlyGroups.values()].reduce((s, g) => s + g.files.length, 0)
      log.info("folder upload done", { success: successCount, errors: failCount, exactGroups: groups.size, lineOnly: lineOnlyGroups.size, unclassified: unclassified.length })
      setImportStatus(failCount > 0
        ? `上传完成：${successCount} 成功，${failCount} 失败。${groups.size} 个精确版本，${lineOnlyGroups.size} 个通用手册（已分发至全版本），${unclassified.length} 个未分类`
        : `✓ 上传成功：${successCount} 个任务。精确版本 ${groups.size} 个，通用手册 ${lineOnlyCount} 个文件×${lineOnlyGroups.size} 条服务线，未分类 ${unclassified.length} 个`)

      await loadSources()
      const canIngest = !!(llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")
      if (canIngest && allImportedTasks.length > 0) {
        setImportStatus(`正在排队解析 ${allImportedTasks.length} 个文件...`)
        log.info("enqueue batch", { project: project.id, count: allImportedTasks.length })
        enqueueBatch(project.id, allImportedTasks).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.error("enqueue batch failed", { error: msg })
          setImportError(`⚠️ 排队失败: ${msg}（请刷新页面后重试）`)
        })
      } else if (!canIngest) {
        setImportError("⚠️ LLM 未配置，文件已上传但无法自动解析。请在设置中配置 API Key 或刷新页面后重试。")
      } else if (allImportedTasks.length === 0) {
        setImportError("⚠️ 无文件成功上传，请检查文件格式或服务器连接。")
      }
      setTimeout(() => setImportStatus(null), 6000)
    } catch (err) {
      log.error("folder upload failed", { error: extractErrMsg(err) })
      setImportError(`文件夹上传失败: ${extractErrMsg(err)}`)
      console.error("[handleImportFolder] unexpected error:", err)
    } finally {
      setImporting(false)
    }
    }
    input.click()
  }


  async function handleOpenSource(node: FileNode) {
    const targetPath = project ? await resolveSourcePreviewPath(normalizePath(project.path), node) : node.path
    setSelectedFile(targetPath)
    try {
      const content = await readFile(targetPath)
      setFileContent(content)
    } catch (err) {
      console.error("Failed to read source:", err)
    }
  }

  async function handleDelete(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    // Confirmation now lives in the SourceTree component as a
    // two-stage button (click once = "Confirm", click again =
    // delete). Reaching this handler means the user has already
    // confirmed via the inline UI, so we proceed unconditionally.
    try {
      logDel.info("cascade delete start", { file: node.path })
      const result = await deleteSourceWithCascade(pp, node)
      // Step 8: Refresh everything (UI side — must run with parent
      // context, hence kept here rather than inside the helper).
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      if (
        selectedFile === node.path ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
      logDel.info("cascade delete done", { file: node.path, wikiPagesRemoved: result.deletedWikiPaths.length })
    } catch (err) {
      logDel.error("delete failed", { file: node.path, error: err instanceof Error ? err.message : String(err) })
      console.error("Failed to delete source:", err)
      window.alert(`Failed to delete: ${err}`)
    }
  }

  /**
   * Recursive folder delete. Walks the folder tree, runs the
   * wiki-cascade for every individual file inside (so any
   * derived wiki pages, embeddings, log entries get cleaned up
   * the same way as a single-file delete), then removes the
   * folder itself with `deleteFile` — which dispatches to
   * `remove_dir_all` Rust-side, taking the now-empty (or near-
   * empty) directory tree with it including any leftover dotdir
   * cache files we didn't explicitly target.
   *
   * Errors on individual files are logged and skipped; the batch
   * keeps going so partial cleanup is preferred over an all-or-
   * nothing failure that leaves the tree half-deleted.
   */
  async function handleDeleteFolder(folder: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const allFiles = collectAllFilesIncludingDot(folder)
      logDel.info("folder delete start", { folder: folder.path, fileCount: allFiles.length })
      const allDeletedWikiPaths: string[] = []
      for (const file of allFiles) {
        try {
          const r = await deleteSourceWithCascade(pp, file)
          allDeletedWikiPaths.push(...r.deletedWikiPaths)
        } catch (err) {
          logDel.warn("file delete error (skipped)", { file: file.path, error: err instanceof Error ? err.message : String(err) })
          console.warn(`Failed to delete ${file.path} during folder delete:`, err)
        }
      }
      // Now remove the folder (and any leftover empty subdirs / dot
      // cache dirs) in one shot. Files we just deleted above are
      // gone; this call mostly tears down empty directories.
      try {
        logDel.info("folder remove", { folder: folder.path })
        await deleteFile(folder.path)
      } catch (err) {
        logDel.warn("folder remove error", { folder: folder.path, error: err instanceof Error ? err.message : String(err) })
        console.warn(`Failed to remove folder ${folder.path}:`, err)
      }
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      if (
        selectedFile?.startsWith(folder.path + "/") ||
        allDeletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      logDel.error("folder delete failed", { folder: folder.path, error: err instanceof Error ? err.message : String(err) })
      console.error("Failed to delete folder:", err)
      window.alert(`Failed to delete folder: ${err}`)
    }
  }

  /**
   * Per-file deletion: the wiki cascade portion (steps 1-7 of the
   * old handleDelete), without the confirmation dialog or the
   * UI-state refresh (callers do those once at the end of a batch).
   *
   * Returns the wiki page paths we actually removed so the caller
   * can reset selectedFile if one of them was open.
   */
  async function deleteSourceWithCascade(
    pp: string,
    node: FileNode,
  ): Promise<{ deletedWikiPaths: string[] }> {
    const fileName = node.name
    // Step 1: Find related wiki pages before deleting
    const relatedPages = await findRelatedWikiPages(pp, fileName)

    // Step 2: Delete the source file
    await deleteFile(node.path)

    // Step 3: Delete preprocessed cache
    try {
      await deleteFile(`${pp}/raw/sources/.cache/${fileName}.txt`)
    } catch {
      // cache file may not exist
    }

      // Step 4: For each page that findRelatedWikiPages surfaced,
      // consult decidePageFate to pick one of three actions:
      //
      //   keep   — page has OTHER sources too; just drop this one from
      //            its sources[] list and rewrite.
      //   delete — this was the page's sole source; remove the page
      //            and record { slug, title } so downstream cleanup
      //            can wipe every stale reference to it.
      //   skip   — the page's sources[] doesn't actually include the
      //            file being deleted. Must have been surfaced by the
      //            Rust findRelatedWikiPages loose-match path (fs.rs
      //            Strategy 3 — substring of title / description /
      //            elsewhere in the frontmatter). Leaving the page
      //            alone prevents silent data loss when a filename
      //            happens to appear in an unrelated page's metadata.
      const actuallyDeleted: string[] = []
      const deletedInfos: DeletedPageInfo[] = []
      for (const pagePath of relatedPages) {
        try {
          const content = await readFile(pagePath)
          const sourcesList = parseSources(content)
          const decision = decidePageFate(sourcesList, fileName)

          if (decision.action === "skip") {
            // Nothing to do — page isn't really derived from this source.
            continue
          }

          if (decision.action === "keep") {
            // Multi-source page — rewrite sources with the deleted one
            // filtered out. writeSources preserves every other
            // frontmatter field and position.
            const updated = writeSources(content, decision.updatedSources)
            await writeFile(pagePath, updated)
            continue
          }

          // action === "delete": the page's sole source was this file.
          // Capture slug + title before deletion so stale references
          // can be cleaned from index / overview / sibling pages.
          const slug = getFileName(pagePath).replace(/\.md$/, "")
          const title = extractFrontmatterTitle(content)
          deletedInfos.push({ slug, title })
          // cascadeDeleteWikiPage = deleteFile(...) + drop the page's
          // embedding chunks so future searches don't return phantom
          // hits pointing at a file that no longer exists.
          const { cascadeDeleteWikiPage } = await import("@/lib/wiki-page-delete")
          await cascadeDeleteWikiPage(pp, pagePath)
          actuallyDeleted.push(pagePath)
        } catch (err) {
          console.error(`Failed to process wiki page ${pagePath}:`, err)
        }
      }

      // Steps 5 & 6: clean stale references from every wiki file.
      //
      // index.md  → drop list-item lines whose primary `[[target]]` is
      //             a deleted page (title OR slug form matches).
      // overview.md + everything else → strip `[[deleted]]` occurrences
      //             in prose, replacing them with plain text (or with
      //             the pipe display when present).
      //
      // Using normalized-key matching rather than the old substring
      // `includes` check avoids two classes of real bugs: stale
      // title-form refs surviving (`[[KV Cache]]` vs slug `kv-cache`),
      // and innocent siblings getting wiped collaterally (deleting
      // `ai.md` must not take `[[OpenAI]]` / `[[AI Safety]]` down).
      const deletedKeys = buildDeletedKeys(deletedInfos)
      if (deletedKeys.size > 0) {
        try {
          const wikiTree = await listDirectory(`${pp}/wiki`)
          const allMdFiles = flattenMdFiles(wikiTree)
          for (const file of allMdFiles) {
            try {
              const content = await readFile(file.path)
              const isIndex = file.path === `${pp}/wiki/index.md` ||
                file.name === "index.md"
              // For index: first drop whole entry lines for deleted
              // pages, then still strip any secondary `[[...]]` refs
              // to deleted pages that may appear in surviving rows.
              const afterListing = isIndex
                ? cleanIndexListing(content, deletedKeys)
                : content
              const updated = stripDeletedWikilinks(afterListing, deletedKeys)
              if (updated !== content) {
                await writeFile(file.path, updated)
              }
            } catch {
              // skip individual file failures — best-effort cleanup
            }
          }
        } catch {
          // non-critical
        }
      }

    // Step 7: Append deletion record to log.md
    try {
      const logPath = `${pp}/wiki/log.md`
      const logContent = await readFile(logPath).catch(() => "# Wiki Log\n")
      const date = new Date().toISOString().slice(0, 10)
      const keptCount = relatedPages.length - actuallyDeleted.length
      const logEntry = `\n## [${date}] delete | ${fileName}\n\nDeleted source file and ${actuallyDeleted.length} wiki pages.${keptCount > 0 ? ` ${keptCount} shared pages kept (have other sources).` : ""}\n`
      await writeFile(logPath, logContent.trimEnd() + logEntry)
    } catch {
      // non-critical
    }

    // Step 8: Drop the source's ingest-cache entry so a future
    // re-import doesn't hit a stale "already ingested" record.
    // The cache's existence-check fallback would have caught this
    // anyway (it falls through to re-ingest when wiki/sources/<slug>.md
    // is gone), but removing the entry up front keeps the cache
    // file small and avoids confusing log lines like "cache miss
    // for foo.pdf: wiki/sources/foo.md no longer on disk" on
    // every search after a delete.
    try {
      await removeFromIngestCache(pp, fileName)
    } catch {
      // non-critical
    }

    return { deletedWikiPaths: actuallyDeleted }
  }

  async function handleIngest(node: FileNode) {
    if (!project || ingestingPath) return
    // Re-ingest goes through the same automated queue path as a fresh
    // import (`handleImport` above). Earlier this used `startIngest`,
    // which opens an interactive chat → user clicks "Save to Wiki" →
    // `executeIngestWrites`. That had two problems: (a) it duplicated
    // the auto-pipeline so features like image cascade had to be
    // wired in twice, and (b) the interactive flow surprised users
    // who expected a fresh-import re-run. One button, one path now.
    setIngestingPath(node.path)
    try {
      await enqueueIngest(project.id, node.path, inferProductCatalogFolderContext(node.path))
    } catch (err) {
      console.error("Failed to enqueue ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  function inferProductCatalogFolderContext(sourcePath: string): string {
    const match = normalizePath(sourcePath).match(/(?:^|\/)产品\/([^/]+)\/([^/]+)\/[^/]+\.pdf$/i)
    if (!match) return ""
    const category = match[1] as InsuranceCategoryType
    const productName = match[2]
    if (!INSURANCE_CATEGORIES.includes(category) || !productName) return ""
    return encodeProductCatalogFolderContext(category, productName, [], 0)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          {/* View mode toggle */}
          <Button
            variant={viewMode === "files" ? "secondary" : "ghost"}
            size="icon"
            title="文件视图"
            onClick={() => setViewMode("files")}
          >
            <LayoutList className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "hierarchy" ? "secondary" : "ghost"}
            size="icon"
            title="服务层级上传"
            onClick={() => setViewMode("hierarchy")}
          >
            <Layers className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "products" ? "secondary" : "ghost"}
            size="icon"
            title="险种产品上传"
            onClick={() => setViewMode("products")}
          >
            <ShieldCheck className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={loadSources} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          {viewMode === "files" && (
            <>
              <Button size="sm" onClick={handleImport} disabled={importing}>
                {importing ? (
                  <><RefreshCw className="mr-1 h-4 w-4 animate-spin" />上传中...</>
                ) : (
                  <><Plus className="mr-1 h-4 w-4" />{t("sources.import")}</>
                )}
              </Button>
              <Button size="sm" variant="outline" onClick={handleImportFolder} disabled={importing}>
                <Folder className="mr-1 h-4 w-4" />
                Folder
              </Button>
              <Button
                size="sm" variant="outline" title="重建概念索引：扫描所有实体，生成跨版本服务项概念页"
                disabled={importing}
                onClick={async () => {
                  if (!project) return
                  setImporting(true)
                  setImportStatus("正在重建概念索引...")
                  try {
                    const { buildServiceConceptIndex } = await import("@/lib/concept-aggregator")
                    const { created, updated } = await buildServiceConceptIndex(project.path)
                    setImportStatus(`✓ 概念索引重建完成：新建 ${created} 个，更新 ${updated} 个`)
                    await loadSources()
                  } catch (err) {
                    setImportError(`概念重建失败: ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setImporting(false)
                    setTimeout(() => setImportStatus(null), 5000)
                  }
                }}
              >
                <GitMerge className="mr-1 h-4 w-4" />
                概念
              </Button>
              <Button
                type="button"
                size="sm" variant="outline" title="精炼模块：对已有模块的原文做二次LLM提取，补充缺失的关键字段"
                disabled={importing}
                onClick={async () => {
                  if (!project) return
                  setImporting(true)
                  setImportStatus("正在精炼模块关键字段...")
                  setImportError(null)
                  try {
                    const { refineAllProductModules } = await import("@/lib/product-catalog-extractor")
                    const { useWikiStore } = await import("@/stores/wiki-store")
                    const llmConfig = useWikiStore.getState().llmConfig
                    const { useActivityStore } = await import("@/stores/activity-store")
                    const actId = useActivityStore.getState().addItem({
                      type: "ingest",
                      title: "精炼模块关键字段",
                      detail: "正在启动...",
                      status: "running",
                      filesWritten: [],
                    })
                    const result = await refineAllProductModules(project.path, llmConfig, actId)
                    useActivityStore.getState().updateItem(actId, { status: "done" })
                    const rebuildSuffix = result.mainFilesRebuilt > 0
                      ? `，刷新 ${result.mainFilesRebuilt} 个主文件`
                      : ""
                    const fieldGapSuffix = result.fieldGapsAttempted
                      ? `，字段缺口补抽 ${result.fieldGapsRefined ?? 0}/${result.fieldGapsAttempted} 个`
                      : ""
                    setImportStatus(`✓ 精炼完成：${result.refined}/${result.totalModules} 个模块更新${fieldGapSuffix}，补充 ${result.fieldsUpdated} 个字段${rebuildSuffix}`)
                    await loadSources()
                  } catch (err) {
                    console.error("Refine failed:", err)
                    setImportError(`精炼失败: ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setImporting(false)
                    setTimeout(() => setImportStatus(null), 8000)
                  }
                }}
              >
                <RefreshCw className="mr-1 h-4 w-4" />
                精炼
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Upload status bar */}
      {(importStatus || importError) && (
        <div className={`px-4 py-2 text-xs border-b ${
          importError
            ? "bg-destructive/10 text-destructive"
            : "bg-blue-500/10 text-blue-700 dark:text-blue-300"
        }`}>
          {importError ?? importStatus}
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0">
        {viewMode === "hierarchy" ? (
          <ServiceHierarchyPanel
            sources={sources}
            onVersionUpload={handleVersionUpload}
            onOpen={handleOpenSource}
            onIngest={handleIngest}
            importing={importing}
          />
        ) : viewMode === "products" ? (
          <ProductCatalogPanel
            sources={sources}
            onProductUpload={handleProductUpload}
            onOpen={handleOpenSource}
            onIngest={handleIngest}
            importing={importing}
          />
        ) : sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <p>{t("sources.noSources")}</p>
            <p>{t("sources.importHint")}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleImport}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFiles")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportFolder}>
                <Folder className="mr-1 h-4 w-4" />
                导入文件夹
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={sources}
              onOpen={handleOpenSource}
              onIngest={handleIngest}
              onDelete={handleDelete}
              onDeleteFolder={handleDeleteFolder}
              pendingDeletePath={pendingDeletePath}
              setPendingDeletePath={setPendingDeletePath}
              ingestingPath={ingestingPath}
              depth={0}
            />
          </div>
        )}
      </ScrollArea>

      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {t("sources.sourceCount", { count: countFiles(sources) })}
      </div>
    </div>
  )
}

/**
 * Generate a unique destination path. If file already exists, adds date/counter suffix.
 * "file.pdf" → "file.pdf" (first time)
 * "file.pdf" → "file-20260406.pdf" (conflict)
 * "file.pdf" → "file-20260406-2.pdf" (second conflict same day)
 */
async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`

  // Check if file exists by trying to read it
  try {
    await readFile(basePath)
  } catch {
    // File doesn't exist — use original name
    return basePath
  }

  // File exists — add date suffix
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")

  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  try {
    await readFile(withDate)
  } catch {
    return withDate
  }

  // Date suffix also exists — add counter
  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    try {
      await readFile(withCounter)
    } catch {
      return withCounter
    }
  }

  // Shouldn't happen, but fallback
  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

function filterTree(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((n) => !n.name.startsWith("."))
    .map((n) => {
      if (n.is_dir && n.children) {
        return { ...n, children: filterTree(n.children) }
      }
      return n
    })
    .filter((n) => !n.is_dir || (n.children && n.children.length > 0))
}

function countFiles(nodes: FileNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      count += countFiles(node.children)
    } else if (!node.is_dir) {
      count++
    }
  }
  return count
}

async function resolveSourcePreviewPath(projectPath: string, node: FileNode): Promise<string> {
  if (node.is_dir) return node.path
  const sourceBaseName = getFileName(node.path).replace(/\.[^.]+$/, "")
  const parsedSourcePath = `${projectPath}/wiki/sources/${sourceBaseName}.md`
  try {
    if (await fileExists(parsedSourcePath)) return parsedSourcePath
  } catch {
    // Fall back to the uploaded raw source.
  }
  return node.path
}


function SourceTree({
  nodes,
  onOpen,
  onIngest,
  onDelete,
  onDeleteFolder,
  pendingDeletePath,
  setPendingDeletePath,
  ingestingPath,
  depth,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onDeleteFolder: (node: FileNode) => void
  /** Path of the node currently in "click again to confirm" state.
   *  Lifted to the parent so only ONE button is armed at a time
   *  across the whole tree — clicking another delete arms that one
   *  and disarms the previous. */
  pendingDeletePath: string | null
  setPendingDeletePath: (path: string | null) => void
  ingestingPath: string | null
  depth: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  /**
   * Two-stage delete handler. Decision logic lives in
   * `decideDeleteClick` (pure, unit-tested in
   * `sources-tree-delete.test.ts`); this wrapper just dispatches
   * the resulting action onto the React state + handler props.
   */
  const handleDeleteClick = (node: FileNode) => {
    const action = decideDeleteClick(pendingDeletePath, node)
    switch (action.kind) {
      case "arm":
        setPendingDeletePath(action.path)
        return
      case "fire-file":
        setPendingDeletePath(null)
        onDelete(action.node)
        return
      case "fire-folder":
        setPendingDeletePath(null)
        onDeleteFolder(action.node)
        return
    }
  }

  // Sort: folders first, then files, alphabetical within each group
  const sorted = [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {sorted.map((node) => {
        const isPendingDelete = pendingDeletePath === node.path
        if (node.is_dir && node.children) {
          const isCollapsed = collapsed[node.path] ?? false
          return (
            <div key={node.path}>
              <div
                className="group flex w-full items-center gap-1 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
              >
                <button
                  onClick={() => toggle(node.path)}
                  className="flex flex-1 items-center gap-1.5 px-1 py-1 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="truncate font-medium">{node.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">
                    {countFiles(node.children)}
                  </span>
                </button>
                <DeleteButton
                  isPending={isPendingDelete}
                  onClick={() => handleDeleteClick(node)}
                  hint={
                    isPendingDelete
                      ? `Click again to delete folder ${node.name} and ALL its contents`
                      : `Delete folder ${node.name} (recursive)`
                  }
                />
              </div>
              {!isCollapsed && (
                <SourceTree
                  nodes={node.children}
                  onOpen={onOpen}
                  onIngest={onIngest}
                  onDelete={onDelete}
                  onDeleteFolder={onDeleteFolder}
                  pendingDeletePath={pendingDeletePath}
                  setPendingDeletePath={setPendingDeletePath}
                  ingestingPath={ingestingPath}
                  depth={depth + 1}
                />
              )}
            </div>
          )
        }

        return (
          <div
            key={node.path}
            className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <button
              onClick={() => onOpen(node)}
              className="flex flex-1 items-center gap-2 truncate px-2 py-1 text-left"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title="Ingest"
              disabled={ingestingPath === node.path}
              onClick={() => onIngest(node)}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
            <DeleteButton
              isPending={isPendingDelete}
              onClick={() => handleDeleteClick(node)}
              hint={
                isPendingDelete
                  ? `Click again to delete ${node.name}`
                  : `Delete ${node.name}`
              }
            />
          </div>
        )
      })}
    </>
  )
}

/**
 * Two-stage delete button. Default = ghost trash icon (subtle).
 * Armed = solid red "Confirm" pill with the icon — visually
 * unmistakable, so the user can't miss the second-click warning.
 *
 * Same component is used for both files and folders; the parent
 * decides which delete handler to call from the click. The pending
 * state is owned by SourceTree (lifted to its parent SourcesView)
 * so only one button is armed across the entire tree at a time.
 */
function DeleteButton({
  isPending,
  onClick,
  hint,
}: {
  isPending: boolean
  onClick: () => void
  hint: string
}) {
  if (isPending) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className="h-7 shrink-0 px-2 text-[11px] font-semibold animate-pulse"
        title={hint}
        onClick={onClick}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        Confirm
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
      title={hint}
      onClick={onClick}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  )
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

// ─── Service Hierarchy Panel ─────────────────────────────────────────────────
// Renders the 5-level service knowledge tree (系列 > 场景 > 服务线 > 版本)
// with per-version upload buttons. Files uploaded here go to:
//   raw/sources/{lineName}/{versionName}/
// The ingest pipeline detects this path and injects service line context.

function ServiceHierarchyPanel({
  sources,
  onVersionUpload,
  onOpen,
  onIngest,
  importing,
}: {
  sources: FileNode[]
  onVersionUpload: (lineName: string, versionName: string) => void
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  importing: boolean
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  // Count files under a specific path in the sources tree
  function countInPath(pathSuffix: string): number {
    function walk(nodes: FileNode[], depth = 0): number {
      let n = 0
      for (const node of nodes) {
        if (node.is_dir && node.children) {
          if (node.path.endsWith(pathSuffix) || node.path.includes(`/${pathSuffix}/`)) {
            n += countFiles(node.children)
          } else {
            n += walk(node.children, depth + 1)
          }
        }
      }
      return n
    }
    return walk(sources)
  }

  // Find files under a version directory
  function findVersionFiles(lineName: string, versionName: string): FileNode[] {
    function walk(nodes: FileNode[]): FileNode[] {
      for (const node of nodes) {
        if (node.is_dir && node.children) {
          // Check if this directory matches lineName/versionName
          const parts = node.path.replace(/\\/g, "/").split("/")
          const lastTwo = parts.slice(-2)
          if (lastTwo[0] === lineName && lastTwo[1] === versionName) {
            return node.children.filter((c) => !c.is_dir)
          }
          const found = walk(node.children)
          if (found.length > 0) return found
        }
      }
      return []
    }
    return walk(sources)
  }

  return (
    <div className="p-2 space-y-1">
      {/* Header hint */}
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground bg-muted/40 rounded-md mb-2">
        <span className="font-medium text-foreground/70">服务层级上传</span>
        　在版本下上传文件，系统自动识别服务线归属，抽取实体命名如
        <code className="mx-1 text-[10px] bg-muted px-1 rounded">臻享家医-V1-在线问诊</code>
      </div>

      {SERVICE_HIERARCHY.map((series) => {
        const seriesKey = `series-${series.seriesName}`
        const isSeriesCollapsed = collapsed[seriesKey] ?? false
        return (
          <div key={seriesKey}>
            {/* L1: 系列 */}
            <button
              onClick={() => toggle(seriesKey)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent"
            >
              {isSeriesCollapsed
                ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <span className="text-xs font-bold tracking-wide text-foreground/80 uppercase">
                {series.seriesName}
              </span>
              {series.status === "pending" && (
                <span className="ml-1 text-[10px] text-muted-foreground/50 border border-dashed border-muted-foreground/30 rounded px-1">
                  待建设
                </span>
              )}
            </button>

            {!isSeriesCollapsed && series.scenarios.map((scenario) => {
              const scenarioKey = `scenario-${series.seriesName}-${scenario.scenarioName}`
              const isScenarioCollapsed = collapsed[scenarioKey] ?? false
              return (
                <div key={scenarioKey} className="ml-4">
                  {/* L2: 场景 */}
                  <button
                    onClick={() => toggle(scenarioKey)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent"
                  >
                    {isScenarioCollapsed
                      ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    <span className="font-medium text-foreground/70">{scenario.scenarioName}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/50">
                      {scenario.lines.length} 条服务线
                    </span>
                  </button>

                  {!isScenarioCollapsed && scenario.lines.map((line) => {
                    const lineKey = `line-${line.lineName}`
                    const isLineCollapsed = collapsed[lineKey] ?? false
                    return (
                      <div key={lineKey} className="ml-4">
                        {/* L3: 服务线 */}
                        <button
                          onClick={() => toggle(lineKey)}
                          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent"
                        >
                          {isLineCollapsed
                            ? <ChevronRight className="h-3 w-3 shrink-0 text-amber-500" />
                            : <ChevronDown className="h-3 w-3 shrink-0 text-amber-500" />}
                          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                          <span className="font-medium">{line.lineName}</span>
                          <span className="ml-auto text-[10px] text-muted-foreground/50">
                            {line.versions.length} 版
                          </span>
                        </button>

                        {!isLineCollapsed && line.versions.map((version) => {
                          const versionKey = `version-${line.lineName}-${version.versionName}`
                          const isVersionCollapsed = collapsed[versionKey] ?? false
                          const versionFiles = findVersionFiles(line.lineName, version.versionName)
                          const fileCount = versionFiles.length
                          return (
                            <div key={versionKey} className="ml-4">
                              {/* L4: 版本 */}
                              <div className="flex items-center gap-1 group rounded-md px-2 py-1 hover:bg-accent/60">
                                <button
                                  onClick={() => toggle(versionKey)}
                                  className="flex flex-1 items-center gap-1.5 text-sm text-left min-w-0"
                                >
                                  {isVersionCollapsed
                                    ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                    : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
                                  <span className="text-blue-600 dark:text-blue-400 font-mono text-[11px] shrink-0">
                                    {version.versionName}
                                  </span>
                                  {fileCount > 0 && (
                                    <span className="ml-1 text-[10px] bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded px-1">
                                      {fileCount}
                                    </span>
                                  )}
                                </button>
                                {/* Upload button */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                                  title={`上传到 ${line.lineName}-${version.versionName}`}
                                  disabled={importing}
                                  onClick={() => onVersionUpload(line.lineName, version.versionName)}
                                >
                                  <Upload className="h-3.5 w-3.5" />
                                </Button>
                              </div>

                              {/* L5: Files already uploaded to this version */}
                              {!isVersionCollapsed && versionFiles.length > 0 && (
                                <div className="ml-6 space-y-0.5">
                                  {versionFiles.map((file) => (
                                    <div
                                      key={file.path}
                                      className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground group"
                                    >
                                      <FileText className="h-3 w-3 shrink-0" />
                                      <button
                                        className="flex-1 truncate text-left"
                                        onClick={() => onOpen(file)}
                                      >
                                        {file.name}
                                      </button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                                        title="重新解析"
                                        onClick={() => onIngest(file)}
                                      >
                                        <BookOpen className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Empty version prompt */}
                              {!isVersionCollapsed && versionFiles.length === 0 && (
                                <div
                                  className="ml-6 flex items-center gap-1.5 rounded border border-dashed border-muted-foreground/20 px-2 py-1.5 text-[11px] text-muted-foreground/50 cursor-pointer hover:border-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                  onClick={() => onVersionUpload(line.lineName, version.versionName)}
                                >
                                  <Upload className="h-3 w-3" />
                                  点击上传 {line.lineName}-{version.versionName} 的服务材料
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─── Product Catalog Panel ────────────────────────────────────────────────────
// Renders the insurance product catalog upload UI.
// Users select: 险种类别 → 产品名称 → 上传文件
// Files go to: raw/sources/产品/{category}/{productName}/
// folderContext: "product_catalog > {category} > {productName}"
// Ingest pipeline extracts to: wiki/product_catalog/{category}-{productName}-{module}.md

function ProductCatalogPanel({
  sources,
  onProductUpload,
  onOpen,
  onIngest,
  importing,
}: {
  sources: FileNode[]
  onProductUpload: (category: InsuranceCategoryType, productName: string, mode?: "files" | "folder") => void
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  importing: boolean
}) {
  const [selectedCategory, setSelectedCategory] = useState<InsuranceCategoryType>(INSURANCE_CATEGORIES[0])
  const [productName, setProductName] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  function findProductFiles(category: InsuranceCategoryType, product: string): FileNode[] {
    function walk(nodes: FileNode[]): FileNode[] {
      for (const node of nodes) {
        if (node.is_dir && node.children) {
          const parts = node.path.replace(/\\/g, "/").split("/")
          const lastThree = parts.slice(-3)
          if (lastThree[0] === "产品" && lastThree[1] === category && lastThree[2] === product) {
            return node.children.filter((c) => !c.is_dir)
          }
          const found = walk(node.children)
          if (found.length > 0) return found
        }
      }
      return []
    }
    return walk(sources)
  }

  function findCategoryProducts(category: InsuranceCategoryType): string[] {
    const products: string[] = []
    function walk(nodes: FileNode[]) {
      for (const node of nodes) {
        if (node.is_dir && node.children) {
          const parts = node.path.replace(/\\/g, "/").split("/")
          const lastTwo = parts.slice(-2)
          if (lastTwo[0] === category) {
            products.push(node.name)
          }
          walk(node.children)
        }
      }
    }
    walk(sources)
    return [...new Set(products)]
  }

  const existingProducts = findCategoryProducts(selectedCategory)

  return (
    <div className="p-2 space-y-3">
      {/* Header hint */}
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground bg-muted/40 rounded-md">
        <span className="font-medium text-foreground/70">险种产品知识库上传</span>
        　选择险种后上传产品文档，系统按模块自动抽取到
        <code className="mx-1 text-[10px] bg-muted px-1 rounded">wiki/product_catalog/</code>
      </div>

      {/* Category selector */}
      <div className="px-2 space-y-2">
        <div className="text-[11px] font-medium text-muted-foreground">险种类别</div>
        <div className="flex flex-wrap gap-1">
          {INSURANCE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${
                selectedCategory === cat
                  ? "bg-blue-600 text-white border-blue-600"
                  : "border-border text-muted-foreground hover:border-blue-400 hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Product name input + upload */}
        <div className="flex gap-1.5 items-center">
          <input
            type="text"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="产品名称，如：安心百万医疗险2026版"
            className="flex-1 min-w-0 rounded border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/30 placeholder:text-muted-foreground/50"
          />
          <Button
            size="sm"
            disabled={importing || !productName.trim()}
            onClick={() => onProductUpload(selectedCategory, productName, "files")}
            className="shrink-0"
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            上传文件
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={importing || !productName.trim()}
            onClick={() => onProductUpload(selectedCategory, productName, "folder")}
            className="shrink-0"
          >
            <Folder className="mr-1 h-3.5 w-3.5" />
            上传文件夹
          </Button>
        </div>

        {/* Module count hint */}
        {productName.trim() && (
          <div className="rounded border border-dashed border-muted-foreground/20 bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground/70 space-y-0.5">
            <div className="font-medium text-muted-foreground mb-1">
              将生成 {PRODUCT_FIELDS[selectedCategory].length} 个字段页 +
              {PRODUCT_CATALOG_MODULES[selectedCategory].length} 个模块页
            </div>
            <div className="text-muted-foreground/60">
              字段页对齐基础字段和{selectedCategory}字段，未抽到值时先留空并标记待精炼。
            </div>
            <div className="font-medium text-muted-foreground/80 pt-1">
              必填模块 {PRODUCT_CATALOG_MODULES[selectedCategory].filter(m => m.required).length} 个
            </div>
            {PRODUCT_CATALOG_MODULES[selectedCategory].filter(m => m.required).map(m => (
              <div key={m.moduleName} className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                <span>{m.moduleName}</span>
                <span className="text-muted-foreground/40 ml-1">→ {m.entityType}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Existing products list */}
      {existingProducts.length > 0 && (
        <div className="px-2 space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">
            已有产品（{selectedCategory}）
          </div>
          {existingProducts.map((product) => {
            const productKey = `product-${selectedCategory}-${product}`
            const isCollapsed = collapsed[productKey] ?? true
            const files = findProductFiles(selectedCategory, product)

            return (
              <div key={productKey} className="rounded-md border border-border bg-background">
                <div className="flex items-center gap-1.5 px-2 py-1.5 group">
                  <button
                    onClick={() => toggle(productKey)}
                    className="flex flex-1 items-center gap-1.5 text-sm text-left min-w-0"
                  >
                    {isCollapsed
                      ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    <span className="truncate font-medium text-[12px]">{product}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/50 shrink-0">
                      {files.length} 文件
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                    title={`继续上传 ${product} 的文档`}
                    disabled={importing}
                    onClick={() => onProductUpload(selectedCategory, product)}
                  >
                    <Upload className="h-3 w-3" />
                  </Button>
                </div>

                {!isCollapsed && files.length > 0 && (
                  <div className="border-t px-2 py-1 space-y-0.5">
                    {files.map((file) => (
                      <div
                        key={file.path}
                        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground group"
                      >
                        <FileText className="h-3 w-3 shrink-0" />
                        <button
                          className="flex-1 truncate text-left"
                          onClick={() => onOpen(file)}
                        >
                          {file.name}
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                          title="重新解析"
                          onClick={() => onIngest(file)}
                        >
                          <BookOpen className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {!isCollapsed && files.length === 0 && (
                  <div
                    className="border-t mx-2 my-1 flex items-center gap-1.5 rounded border border-dashed border-muted-foreground/20 px-2 py-1.5 text-[11px] text-muted-foreground/50 cursor-pointer hover:border-muted-foreground/40"
                    onClick={() => onProductUpload(selectedCategory, product)}
                  >
                    <Upload className="h-3 w-3" />
                    上传 {product} 的产品文档
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Empty state */}
      {existingProducts.length === 0 && (
        <div className="px-4 py-6 text-center text-[12px] text-muted-foreground/60">
          <ShieldCheck className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
          <p>还没有 {selectedCategory} 的产品</p>
          <p className="text-[11px] mt-0.5">输入产品名称后上传文档开始构建</p>
        </div>
      )}
    </div>
  )
}
