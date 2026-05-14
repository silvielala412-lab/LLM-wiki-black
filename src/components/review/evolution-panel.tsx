/**
 * EvolutionPanel — Knowledge evolution timeline view.
 *
 * Shows how a knowledge concept evolved over time:
 * - Version chain (oldest → newest)
 * - For each transition: added / removed / changed points
 * - Visual diff inspired by GitHub's diff view
 */

import { useState, useEffect, useCallback } from "react"
import { GitCommitHorizontal, ChevronDown, ChevronRight, Clock, ArrowRight, FileSearch, RefreshCw } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import type { KnowledgeTransition } from "@/lib/knowledge-governance/lineage-tracker"
import { loadLineage, buildVersionChain } from "@/lib/knowledge-governance/lineage-tracker"

// ── Sub-components ────────────────────────────────────────────────────────────

function DiffPoint({ type, text }: { type: "added" | "removed" | "changed"; text: string }) {
  const cfg = {
    added:   { bg: "bg-emerald-50 dark:bg-emerald-950/40", border: "border-emerald-200 dark:border-emerald-800", dot: "bg-emerald-500", prefix: "+", color: "text-emerald-700 dark:text-emerald-400" },
    removed: { bg: "bg-red-50 dark:bg-red-950/40",     border: "border-red-200 dark:border-red-800",     dot: "bg-red-500",     prefix: "−", color: "text-red-700 dark:text-red-400" },
    changed: { bg: "bg-blue-50 dark:bg-blue-950/40",   border: "border-blue-200 dark:border-blue-800",   dot: "bg-blue-500",   prefix: "≈", color: "text-blue-700 dark:text-blue-400" },
  }[type]

  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 ${cfg.bg} ${cfg.border}`}>
      <span className={`mt-0.5 shrink-0 text-[11px] font-bold ${cfg.color}`}>{cfg.prefix}</span>
      <span className={`text-xs leading-relaxed ${cfg.color}`}>{text}</span>
    </div>
  )
}

function TransitionCard({
  transition,
  isLatest,
  onOpenPage,
}: {
  transition: KnowledgeTransition
  isLatest: boolean
  onOpenPage: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const date = new Date(transition.effectiveDate)
  const dateStr = date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
  const timeStr = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })

  const hasChanges = transition.addedPoints.length > 0
    || transition.removedPoints.length > 0
    || transition.changedPoints.length > 0

  return (
    <div className="relative pl-8">
      {/* Timeline vertical bar */}
      {!isLatest && (
        <div className="absolute left-[14px] top-8 bottom-0 w-0.5 bg-border" />
      )}

      {/* Timeline dot */}
      <div className="absolute left-2 top-4 flex h-5 w-5 items-center justify-center rounded-full border-2 border-primary bg-background">
        <div className="h-2 w-2 rounded-full bg-primary" />
      </div>

      <div className="mb-6 rounded-xl border bg-card shadow-sm">
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors rounded-t-xl"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground">{dateStr} {timeStr}</span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                transition.relation === "supersedes"   ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400" :
                transition.relation === "updates"      ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400" :
                "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-400"
              }`}>
                {transition.relation === "supersedes" ? "替代" : transition.relation === "updates" ? "更新" : "合并"}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <button
                onClick={(e) => { e.stopPropagation(); onOpenPage(transition.fromPagePath) }}
                className="truncate max-w-[160px] text-muted-foreground hover:text-foreground hover:underline transition-colors"
                title={transition.fromPageTitle}
              >
                {transition.fromPageTitle}
              </button>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <button
                onClick={(e) => { e.stopPropagation(); onOpenPage(transition.toPagePath) }}
                className="truncate max-w-[160px] font-medium text-foreground hover:text-primary hover:underline transition-colors"
                title={transition.toPageTitle}
              >
                {transition.toPageTitle}
              </button>
            </div>
            {transition.summary && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-1">{transition.summary}</p>
            )}
          </div>
          <div className="shrink-0 mt-1">
            {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>

        {/* Diff detail */}
        {expanded && (
          <div className="border-t px-4 py-3">
            {!hasChanges ? (
              <p className="text-xs text-muted-foreground text-center py-2">暂无详细变更记录（LLM 分析未运行或无变更点）</p>
            ) : (
              <div className="flex flex-col gap-4">
                {transition.addedPoints.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">新增知识点</span>
                      <span className="ml-auto text-[10px] text-emerald-600">+{transition.addedPoints.length}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {transition.addedPoints.map((pt, i) => <DiffPoint key={i} type="added" text={pt} />)}
                    </div>
                  </div>
                )}
                {transition.removedPoints.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">删除知识点</span>
                      <span className="ml-auto text-[10px] text-red-600">−{transition.removedPoints.length}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {transition.removedPoints.map((pt, i) => <DiffPoint key={i} type="removed" text={pt} />)}
                    </div>
                  </div>
                )}
                {transition.changedPoints.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-full bg-blue-500" />
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">变更知识点</span>
                      <span className="ml-auto text-[10px] text-blue-600">≈{transition.changedPoints.length}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {transition.changedPoints.map((pt, i) => <DiffPoint key={i} type="changed" text={pt} />)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ hasProject }: { hasProject: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground h-full">
      <div className="rounded-full bg-muted p-4">
        <GitCommitHorizontal className="h-6 w-6 text-muted-foreground/60" />
      </div>
      <div>
        <p className="font-medium">暂无知识演化记录</p>
        <p className="text-xs mt-1 text-muted-foreground/70">
          {hasProject
            ? "当用户在「知识审核」中确认「替代旧版本」时，变更记录将出现在这里"
            : "请先打开一个项目"
          }
        </p>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function EvolutionPanel() {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)

  const [allTransitions, setAllTransitions] = useState<KnowledgeTransition[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  const pp = project ? normalizePath(project.path) : null

  const load = useCallback(async () => {
    if (!pp) return
    setLoading(true)
    try {
      const records = await loadLineage(pp)
      // Sort newest first
      records.sort((a, b) => new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime())
      setAllTransitions(records)
    } catch (err) {
      console.warn("[EvolutionPanel] Failed to load lineage:", err)
    } finally {
      setLoading(false)
    }
  }, [pp])

  useEffect(() => { load() }, [load])

  const openPage = useCallback(async (pagePath: string) => {
    try {
      const { readFile } = await import("@/commands/fs")
      const content = await readFile(pagePath)
      setSelectedFile(pagePath)
      setFileContent(content)
      setActiveView("wiki")
    } catch {
      // File may no longer exist
    }
  }, [setSelectedFile, setFileContent, setActiveView])

  // Filter by search query
  const filtered = searchQuery.trim()
    ? allTransitions.filter((t) =>
        t.fromPageTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.toPageTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.summary.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allTransitions

  // Group into chains for rendering
  // For the list view we just render sorted by date
  const stats = {
    added: allTransitions.reduce((s, t) => s + t.addedPoints.length, 0),
    removed: allTransitions.reduce((s, t) => s + t.removedPoints.length, 0),
    changed: allTransitions.reduce((s, t) => s + t.changedPoints.length, 0),
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <GitCommitHorizontal className="h-4 w-4 text-primary" />
            知识演化
            {allTransitions.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {allTransitions.length} 条记录
              </span>
            )}
          </h2>
          <button
            onClick={load}
            disabled={loading}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40"
            title="刷新"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Stats row */}
        {allTransitions.length > 0 && (
          <div className="mt-2 flex gap-3">
            <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              +{stats.added} 新增
            </span>
            <span className="flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400">
              <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
              −{stats.removed} 删除
            </span>
            <span className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400">
              <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              ≈{stats.changed} 变更
            </span>
          </div>
        )}
      </div>

      {/* Search */}
      {allTransitions.length > 0 && (
        <div className="shrink-0 border-b px-3 py-2">
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
            <FileSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              type="text"
              placeholder="搜索知识演化记录..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      )}

      {/* Timeline body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState hasProject={!!project} />
        ) : (
          <div className="p-4">
            {/* Sorted timeline */}
            {filtered.map((t, idx) => (
              <TransitionCard
                key={t.id}
                transition={t}
                isLatest={idx === filtered.length - 1}
                onOpenPage={openPage}
              />
            ))}

            {/* Bottom spacer */}
            <div className="flex items-center gap-2 pl-8 pb-2">
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-muted-foreground/30 bg-background ml-[-24px]">
                <Clock className="h-2.5 w-2.5 text-muted-foreground/50" />
              </div>
              <span className="text-xs text-muted-foreground/50">知识历史起点</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
