import { useState } from "react"
import { ChevronRight, ChevronDown, File, Folder } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"

function nodeMatchesSearch(node: FileNode, query: string): boolean {
  if (!query) return true
  return [node.name, node.path].some(value => value.toLowerCase().includes(query))
}

function filterTreeBySearch(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes
  return nodes.flatMap((node) => {
    if (node.is_dir) {
      const children = filterTreeBySearch(node.children ?? [], query)
      if (nodeMatchesSearch(node, query)) return [{ ...node, children: node.children ?? [] }]
      return children.length > 0 ? [{ ...node, children }] : []
    }
    return nodeMatchesSearch(node, query) ? [node] : []
  })
}

function TreeNode({ node, depth, forceExpanded = false }: { node: FileNode; depth: number; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(depth < 1)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)

  const isSelected = selectedFile === node.path
  const paddingLeft = 12 + depth * 16

  if (node.is_dir) {
    const isExpanded = forceExpanded || expanded
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1 py-1 text-sm text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
          style={{ paddingLeft }}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded && node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} forceExpanded={forceExpanded} />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => setSelectedFile(node.path)}
      className={`flex w-full items-center gap-1 py-1 text-sm ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
      }`}
      style={{ paddingLeft: paddingLeft + 14 }}
    >
      <File className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

export function FileTree({ searchQuery = "" }: { searchQuery?: string }) {
  const { t } = useTranslation()
  const fileTree = useWikiStore((s) => s.fileTree)
  const project = useWikiStore((s) => s.project)
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const visibleTree = filterTreeBySearch(fileTree, normalizedSearch)

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("fileTree.noProject")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full min-w-0 overflow-hidden">
      <div className="p-2">
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
          {project.name}
        </div>
        {visibleTree.length > 0 ? (
          visibleTree.map((node) => (
            <TreeNode key={node.path} node={node} depth={0} forceExpanded={!!normalizedSearch} />
          ))
        ) : (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            没有匹配的文件
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
