import { useEffect, useCallback, useRef, useState } from "react"
import { X } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { WikiPageViewer } from "@/components/editor/wiki-page-viewer"
import { getFileName, normalizePath } from "@/lib/path-utils"

function isWikiMarkdown(filePath: string): boolean {
  const np = normalizePath(filePath)
  return np.includes("/wiki/") && !np.includes("/wiki/media/") && np.endsWith(".md")
}

export function PreviewPanel() {
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLoadedRef = useRef<string>("")
  const [editMode, setEditMode] = useState(false)

  useEffect(() => { setEditMode(false) }, [selectedFile])

  useEffect(() => {
    if (!selectedFile) { setFileContent(""); lastLoadedRef.current = ""; return }
    const category = getFileCategory(selectedFile)
    if (isBinary(category)) { setFileContent(""); lastLoadedRef.current = ""; return }
    readFile(selectedFile)
      .then((c) => { lastLoadedRef.current = c; setFileContent(c) })
      .catch((err) => { lastLoadedRef.current = ""; setFileContent(`Error: ${err}`) })
  }, [selectedFile, setFileContent])

  const handleSave = useCallback((markdown: string) => {
    if (!selectedFile) return
    if (markdown === lastLoadedRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      writeFile(selectedFile, markdown)
        .then(() => { lastLoadedRef.current = markdown })
        .catch((err) => console.error("Failed to save:", err))
    }, 1000)
  }, [selectedFile])

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }, [])

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
          {isWiki && (
            <button onClick={() => setEditMode((m) => !m)} className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent transition-colors">
              {editMode ? "👁 预览" : "✏️ 编辑"}
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
    </div>
  )
}