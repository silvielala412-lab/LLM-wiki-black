import React, { useState, useEffect, useCallback } from "react"
import {
  FileText, Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, ChevronRight, ChevronDown, Layout, Globe, ShieldCheck, CalendarClock, BriefcaseBusiness,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

interface WikiPageInfo {
  path: string
  title: string
  type: string
  domain: string
  tags: string[]
  origin?: string
}

const TYPE_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string; order: number }> = {
  overview:    { icon: Layout,      label: "Overview",     color: "text-yellow-500", order: 0 },
  entity:      { icon: Users,       label: "Entities",     color: "text-blue-500",   order: 1 },
  concept:     { icon: Lightbulb,   label: "Concepts",     color: "text-purple-500", order: 2 },
  source:      { icon: BookOpen,    label: "Sources",      color: "text-orange-500", order: 3 },
  synthesis:   { icon: GitMerge,    label: "Synthesis",    color: "text-red-500",    order: 4 },
  comparison:  { icon: BarChart3,   label: "Comparisons",  color: "text-emerald-500",order: 5 },
  query:       { icon: HelpCircle,  label: "Queries",      color: "text-green-500",  order: 6 },
}

const DEFAULT_CONFIG = { icon: FileText, label: "Other", color: "text-muted-foreground", order: 99 }

const DOMAIN_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string; order: number }> = {
  product:    { icon: BriefcaseBusiness, label: "产品域",     color: "text-blue-600",    order: 1 },
  customer:   { icon: Users,             label: "客户画像域", color: "text-emerald-600", order: 2 },
  method:     { icon: Lightbulb,         label: "销售方法域", color: "text-amber-600",   order: 3 },
  content:    { icon: FileText,          label: "销售内容域", color: "text-violet-600",  order: 4 },
  activity:   { icon: CalendarClock,     label: "销售活动域", color: "text-orange-600",  order: 5 },
  cases:      { icon: BookOpen,          label: "案例经验域", color: "text-rose-600",    order: 6 },
  compliance: { icon: ShieldCheck,       label: "合规风险域", color: "text-red-600",     order: 7 },
  general:    { icon: FileText,          label: "通用知识",   color: "text-muted-foreground", order: 8 },
}

export function KnowledgeTree() {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const fileTree = useWikiStore((s) => s.fileTree)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [groupMode, setGroupMode] = useState<"type" | "domain">("type")
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["overview", "entity", "concept", "source"]))
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set(["product", "customer", "method"]))

  // Multi-select state
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set())
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const loadPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const wikiTree = await listDirectory(`${pp}/wiki`)
      const mdFiles = flattenMdFiles(wikiTree)

      const pageInfos: WikiPageInfo[] = []
      for (const file of mdFiles) {
        if (file.name === "index.md" || file.name === "log.md") continue
        if (!shouldReadPageMetadata(file.path)) {
          pageInfos.push(parsePageInfo(file.path, file.name, ""))
          continue
        }
        try {
          const content = await readFile(file.path)
          const info = parsePageInfo(file.path, file.name, content)
          pageInfos.push(info)
        } catch {
          pageInfos.push({
            path: file.path,
            title: file.name.replace(".md", "").replace(/-/g, " "),
            type: "other",
            domain: "general",
            tags: [],
          })
        }
      }
      setPages(pageInfos)
    } catch {
      setPages([])
    }
  }, [project])

  useEffect(() => { loadPages() }, [loadPages, fileTree])

  const toggleCheck = useCallback((path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCheckedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleBulkDelete = useCallback(async () => {
    if (!project || checkedPaths.size === 0) return
    setIsDeleting(true)
    const pp = normalizePath(project.path)
    const { cascadeDeleteWikiPage } = await import("@/lib/wiki-page-delete")
    for (const path of checkedPaths) {
      try { await cascadeDeleteWikiPage(pp, path) } catch { /* continue */ }
    }
    const tree = await listDirectory(pp)
    setFileTree(tree)
    bumpDataVersion()
    if (checkedPaths.has(selectedFile ?? "")) setSelectedFile(null)
    setCheckedPaths(new Set())
    setShowBulkConfirm(false)
    setIsDeleting(false)
  }, [project, checkedPaths, selectedFile, setFileTree, bumpDataVersion, setSelectedFile])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No project open
      </div>
    )
  }

  const grouped = new Map<string, WikiPageInfo[]>()
  for (const page of pages) {
    const key = groupMode === "domain" ? page.domain : page.type
    const list = grouped.get(key) ?? []
    list.push(page)
    grouped.set(key, list)
  }

  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const configMap = groupMode === "domain" ? DOMAIN_CONFIG : TYPE_CONFIG
    const orderA = configMap[a[0]]?.order ?? DEFAULT_CONFIG.order
    const orderB = configMap[b[0]]?.order ?? DEFAULT_CONFIG.order
    return orderA - orderB
  })

  function toggleGroup(type: string) {
    const setExpanded = groupMode === "domain" ? setExpandedDomains : setExpandedTypes
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const checkedCount = checkedPaths.size

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
            {project.name}
          </div>

          <div className="mb-2 grid grid-cols-2 gap-1 px-1">
            <button
              onClick={() => setGroupMode("type")}
              className={`rounded-md px-2 py-1 text-xs ${groupMode === "type" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
            >
              类型
            </button>
            <button
              onClick={() => setGroupMode("domain")}
              className={`rounded-md px-2 py-1 text-xs ${groupMode === "domain" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
            >
              七大域
            </button>
          </div>

          {checkedCount > 0 && (
            <div className="mb-2 flex items-center justify-between rounded-md bg-red-50 border border-red-200 px-2 py-1.5">
              <span className="text-xs text-red-600 font-medium">已选 {checkedCount} 项</span>
              <div className="flex gap-1">
                <button onClick={() => setCheckedPaths(new Set())} className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded">取消</button>
                <button onClick={() => setShowBulkConfirm(true)} className="text-xs text-white bg-red-500 hover:bg-red-600 px-2 py-0.5 rounded font-medium">删除所选</button>
              </div>
            </div>
          )}

          {sortedGroups.length === 0 && (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              No wiki pages yet. Import sources to get started.
            </div>
          )}

          {sortedGroups.map(([type, items]) => {
            const config = (groupMode === "domain" ? DOMAIN_CONFIG[type] : TYPE_CONFIG[type]) ?? DEFAULT_CONFIG
            const Icon = config.icon
            const isExpanded = (groupMode === "domain" ? expandedDomains : expandedTypes).has(type)

            return (
              <div key={type} className="mb-1">
                <button
                  onClick={() => toggleGroup(type)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                  <span className="flex-1 text-left font-medium">{config.label}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </button>

                {isExpanded && (
                  <div className="ml-3">
                    {items.map((page) => {
                      const isSelected = selectedFile === page.path
                      const isChecked = checkedPaths.has(page.path)
                      return (
                        <div
                          key={page.path}
                          className={`group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm ${
                            isChecked
                              ? "bg-red-50 text-red-700"
                              : isSelected
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                          }`}
                        >
                          {/* Checkbox */}
                          <button
                            onClick={(e) => toggleCheck(page.path, e)}
                            className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-opacity ${
                              isChecked
                                ? "opacity-100 border-red-400 bg-red-100"
                                : "opacity-0 group-hover:opacity-100 border-muted-foreground/40"
                            }`}
                            title="选中删除"
                          >
                            {isChecked && <span className="text-red-500" style={{ fontSize: 8, lineHeight: 1 }}>✓</span>}
                          </button>

                          {/* Page title */}
                          <button
                            onClick={() => setSelectedFile(page.path)}
                            className="flex-1 flex items-center gap-1 truncate min-w-0"
                            title={page.path}
                          >
                            {page.origin === "web-clip" && <Globe className="h-3 w-3 shrink-0 text-blue-400" />}
                            <span className="truncate">{page.title}</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          <RawSourcesSection />
        </div>
      </ScrollArea>

      {/* Bulk delete confirmation dialog */}
      {showBulkConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm rounded-lg">
          <div className="bg-background border rounded-xl shadow-xl p-5 mx-4 max-w-xs w-full">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🗑️</span>
              <h3 className="font-semibold text-sm">确认批量删除</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              将永久删除 <span className="font-bold text-red-500">{checkedCount}</span> 个页面及其向量索引，此操作不可撤销。
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowBulkConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-md border hover:bg-accent"
              >取消</button>
              <button
                onClick={handleBulkDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 text-xs rounded-md bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
              >
                {isDeleting ? "删除中..." : `确认删除 ${checkedCount} 项`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


function RawSourcesSection() {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`)
      .then((tree) => setSources(flattenAllFiles(tree)))
      .catch(() => setSources([]))
  }, [project])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="flex-1 text-left font-medium text-muted-foreground">Raw Sources</span>
        <span className="text-xs text-muted-foreground">{sources.length}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {sources.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => setSelectedFile(file.path)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function shouldReadPageMetadata(path: string): boolean {
  const normalized = normalizePath(path)
  if (normalized.includes("/wiki/sources/")) return false
  if (normalized.includes("/wiki/audits/")) return false
  if (normalized.includes("/wiki/media/")) return false
  return true
}

function parsePageInfo(path: string, fileName: string, content: string): WikiPageInfo {
  let type = "other"
  let title = fileName.replace(".md", "").replace(/-/g, " ")
  const tags: string[] = []
  let origin: string | undefined

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const fm = fmMatch[1]
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    if (typeMatch) type = typeMatch[1].trim().toLowerCase()

    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch) title = titleMatch[1].trim()

    const tagsMatch = fm.match(/^tags:\s*\[(.+?)\]/m)
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(",").map((t) => t.trim().replace(/["']/g, "")))
    }

    const originMatch = fm.match(/^origin:\s*(.+)$/m)
    if (originMatch) origin = originMatch[1].trim()
  }

  // Fallback: try first heading if no frontmatter title
  if (title === fileName.replace(".md", "").replace(/-/g, " ")) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    if (headingMatch) title = headingMatch[1].trim()
  }

  // Fallback: infer type from path
  if (type === "other") {
    if (path.includes("/entities/")) type = "entity"
    else if (path.includes("/concepts/")) type = "concept"
    else if (path.includes("/sources/")) type = "source"
    else if (path.includes("/queries/")) type = "query"
    else if (path.includes("/comparisons/")) type = "comparison"
    else if (path.includes("/synthesis/")) type = "synthesis"
    else if (fileName === "overview.md") type = "overview"
  }

  let domain = "general"
  if (fmMatch) {
    const domainMatch = fmMatch[1].match(/^knowledge_domain:\s*["']?(.+?)["']?\s*$/m)
    if (domainMatch) domain = domainMatch[1].trim().toLowerCase()
  }

  return { path, title, type, domain, tags, origin }
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

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
