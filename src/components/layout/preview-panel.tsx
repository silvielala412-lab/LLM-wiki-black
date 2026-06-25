import { useEffect, useCallback, useRef, useState } from "react"
import { X, Trash2, Plus } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { WikiPageViewer } from "@/components/editor/wiki-page-viewer"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { cascadeDeleteWikiPage } from "@/lib/wiki-page-delete"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useAuthStore } from "@/stores/auth-store"
import { syncProductFieldPageAfterEdit } from "@/lib/product-catalog-sync"

const LARGE_PREVIEW_CHAR_LIMIT = 160000

function isWikiMarkdown(filePath: string): boolean {
  const np = normalizePath(filePath)
  return np.includes("/wiki/") && !np.includes("/wiki/media/") && np.endsWith(".md")
}

export function PreviewPanel() {
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const project = useWikiStore((s) => s.project)
  const username = useAuthStore((s) => s.user?.username ?? "unknown")
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLoadedRef = useRef<string>("")
  const [editMode, setEditMode] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const [previewTruncated, setPreviewTruncated] = useState(false)

  useEffect(() => { setEditMode(false) }, [selectedFile])

  useEffect(() => {
    if (!selectedFile) { setFileContent(""); lastLoadedRef.current = ""; setPreviewTruncated(false); return }
    const category = getFileCategory(selectedFile)
    if (isBinary(category)) { setFileContent(""); lastLoadedRef.current = ""; setPreviewTruncated(false); return }
    readFile(selectedFile)
      .then((c) => {
        const truncated = c.length > LARGE_PREVIEW_CHAR_LIMIT
        const content = c.length > LARGE_PREVIEW_CHAR_LIMIT
          ? `${c.slice(0, LARGE_PREVIEW_CHAR_LIMIT)}\n\n> 文件内容较大，预览已截断以保持界面响应。完整内容仍保存在文件中，截断预览不会覆盖原文。`
          : c
        lastLoadedRef.current = content
        setPreviewTruncated(truncated)
        setFileContent(content)
      })
      .catch((err) => { lastLoadedRef.current = ""; setPreviewTruncated(false); setFileContent(`Error: ${err}`) })
  }, [selectedFile, dataVersion, setFileContent])

  const handleSave = useCallback((markdown: string) => {
    if (!selectedFile) return
    if (markdown === lastLoadedRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      writeFile(selectedFile, markdown)
        .then(async () => {
          let savedContent = markdown
          if (project?.path) {
            const syncResult = await syncProductFieldPageAfterEdit(project.path, selectedFile, markdown)
            savedContent = syncResult.content
            if (syncResult.isProductFieldPage) {
              setFileContent(savedContent)
              bumpDataVersion()
            }
          }
          lastLoadedRef.current = savedContent
        })
        .catch((err) => console.error("Failed to save:", err))
    }, 1000)
  }, [selectedFile, project, setFileContent, bumpDataVersion])

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }, [])

  // ── Delete handler ──
  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedFile || !project) return
    setShowDeleteConfirm(false)
    try {
      const pp = normalizePath(project.path)
      await cascadeDeleteWikiPage(pp, selectedFile)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
      setSelectedFile(null)
    } catch (err) {
      console.error("[PreviewPanel] Delete failed:", err)
    }
  }, [selectedFile, project, setFileTree, bumpDataVersion, setSelectedFile])

  // ── Create page handler ──
  const handleCreatePage = useCallback(async (type: "entity" | "concept") => {
    if (!project) return
    setShowCreateMenu(false)
    const name = prompt(type === "entity" ? "输入实体名称:" : "输入概念名称:")
    if (!name?.trim()) return
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, "").replace(/\s+/g, "-")
    const dir = type === "entity" ? "entities" : "concepts"
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${dir}/${slug || name.trim()}.md`
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const template = [
      "---",
      `type: ${type}`,
      `title: "${name.trim()}"`,
      `created: ${dateStr}`,
      `updated: ${dateStr}`,
      `tags: []`,
      `related: []`,
      `sources: ["手动创建"]`,
      `ingested_at: "${now.toISOString()}"`,
      `ingested_by: "manual"`,
      `ingested_by_user: "${username}"`,
      "---",
      "",
      `# ${name.trim()}`,
      "",
      "（在此编写内容）",
      "",
    ].join("\n")
    try {
      await writeFile(pagePath, template)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
      setSelectedFile(pagePath)
    } catch (err) {
      console.error("[PreviewPanel] Create failed:", err)
    }
  }, [project, username, setFileTree, bumpDataVersion, setSelectedFile])

  if (!selectedFile) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to preview</div>
  }

  const category = getFileCategory(selectedFile)
  const fileName = getFileName(selectedFile)
  const isWiki = isWikiMarkdown(selectedFile)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>{fileName}</span>
        <div className="flex items-center gap-1 shrink-0">
          {/* New page dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowCreateMenu(!showCreateMenu)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-emerald-600 hover:bg-emerald-50 transition-colors"
              title="新建页面"
            >
              <Plus className="h-3 w-3" /> 新建
            </button>
            {showCreateMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 w-32 rounded-lg border bg-popover shadow-lg py-1">
                <button
                  onClick={() => handleCreatePage("entity")}
                  className="block w-full text-left px-3 py-1.5 text-xs text-cyan-600 hover:bg-cyan-50 transition-colors"
                >
                  💎 新建实体
                </button>
                <button
                  onClick={() => handleCreatePage("concept")}
                  className="block w-full text-left px-3 py-1.5 text-xs text-violet-600 hover:bg-violet-50 transition-colors"
                >
                  💡 新建概念
                </button>
              </div>
            )}
          </div>

          {/* Edit toggle */}
          {isWiki && (
            <button
              onClick={() => !previewTruncated && setEditMode((m) => !m)}
              disabled={previewTruncated}
              className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              title={previewTruncated ? "大文件预览已截断，暂不允许直接编辑以避免覆盖完整内容" : undefined}
            >
              {editMode ? "👁 预览" : "✏️ 编辑"}
            </button>
          )}

          {/* Delete button — only for wiki markdown */}
          {isWiki && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-red-500 hover:bg-red-50 transition-colors"
              title="删除此页面"
            >
              <Trash2 className="h-3 w-3" /> 删除
            </button>
          )}

          <button onClick={() => setSelectedFile(null)} className="rounded p-1 text-muted-foreground hover:bg-accent">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        {isWiki && !editMode ? (
          <WikiPageViewer key={selectedFile} filePath={selectedFile} content={fileContent} onEditRequest={() => setEditMode(true)} />
        ) : category === "markdown" ? (
          <WikiEditor key={selectedFile} content={fileContent} onSave={handleSave} />
        ) : (
          <FilePreview key={selectedFile} filePath={selectedFile} textContent={fileContent} />
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除此页面？"
        description={`将永久删除「${fileName}」，包括其关联的向量索引和媒体文件。此操作不可撤销。`}
        confirmLabel="确认删除"
        cancelLabel="取消"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  )
}
