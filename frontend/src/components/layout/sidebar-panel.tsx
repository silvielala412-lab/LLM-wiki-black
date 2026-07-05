import { useState } from "react"
import { Search, X } from "lucide-react"
import { KnowledgeTree } from "./knowledge-tree"
import { FileTree } from "./file-tree"
import { Input } from "@/components/ui/input"

export function SidebarPanel() {
  const [mode, setMode] = useState<"knowledge" | "files">("knowledge")
  const [searchQuery, setSearchQuery] = useState("")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 border-b">
        <button
          onClick={() => setMode("knowledge")}
          className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === "knowledge"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Knowledge
        </button>
        <button
          onClick={() => setMode("files")}
          className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === "files"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Files
        </button>
      </div>
      <div className="shrink-0 border-b px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={mode === "knowledge" ? "搜索知识标题或路径" : "搜索文件名或路径"}
            className="h-8 rounded-md pl-8 pr-8 text-sm"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title="清空搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "knowledge" ? <KnowledgeTree searchQuery={searchQuery} /> : <FileTree searchQuery={searchQuery} />}
      </div>
    </div>
  )
}
