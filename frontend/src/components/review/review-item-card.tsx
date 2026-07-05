/**
 * review-item-card.tsx
 *
 * Decision card for a single Review Queue item.
 * Shows: new page info, existing page info (if any), LLM judgement, action buttons.
 */

import { useState } from "react"
import { FileText, GitMerge, XCircle, CheckCircle, ChevronDown, ChevronUp, Clock, Eye, X } from "lucide-react"
import type { ReviewItem, ReviewResolution } from "@/lib/knowledge-governance"
import { readFile } from "@/commands/fs"

interface ReviewItemCardProps {
  item: ReviewItem
  onResolve: (id: string, resolution: ReviewResolution) => void
  onDismiss: (id: string) => void
}

const RELATION_LABEL: Record<string, { label: string; color: string }> = {
  same:        { label: "重复内容",   color: "text-red-500" },
  update:      { label: "内容更新",   color: "text-blue-500" },
  conflict:    { label: "内容冲突",   color: "text-orange-500" },
  complement:  { label: "补充信息",   color: "text-emerald-500" },
  unrelated:   { label: "无关联",     color: "text-slate-400" },
  uncertain:   { label: "待判断",     color: "text-amber-500" },
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high:   "高置信",
  medium: "中置信",
  low:    "低置信",
}

export function ReviewItemCard({ item, onResolve, onDismiss }: ReviewItemCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [newContent, setNewContent] = useState("")
  const [existingContent, setExistingContent] = useState("")

  const relation = item.judgement?.relation
  const relConfig = relation ? RELATION_LABEL[relation] : null
  const confidence = item.judgement?.confidence
  const createdDate = new Date(item.createdAt).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  })

  async function openDetail() {
    setDetailOpen(true)
    setDetailLoading(true)
    try {
      const [nextNew, nextExisting] = await Promise.all([
        readFile(item.newPagePath).catch(() => item.newPageExcerpt ?? ""),
        item.existingPagePath
          ? readFile(item.existingPagePath).catch(() => item.existingPageExcerpt ?? "")
          : Promise.resolve(""),
      ])
      setNewContent(nextNew)
      setExistingContent(nextExisting)
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden transition-shadow hover:shadow-md">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950/50">
          <FileText className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm truncate">{item.newPageTitle}</span>
            {relConfig && (
              <span className={`text-xs font-medium ${relConfig.color}`}>
                {relConfig.label}
              </span>
            )}
            {confidence && (
              <span className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                {CONFIDENCE_LABEL[confidence]}
              </span>
            )}
          </div>
          {item.existingPageTitle && (
            <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
              系统判断新知识可能与「{item.existingPageTitle}」重复、冲突、补充或更新，请选择如何处理新知识与这条候选关联。
            </p>
          )}
          {!item.existingPageTitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              这是一条待确认的新知识，请确认是否采纳。
            </p>
          )}
          <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {createdDate}
          </div>
          <button
            onClick={openDetail}
            className="mt-2 inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Eye className="h-3 w-3" />
            查看详情/对比
          </button>
        </div>
      </div>

      {/* LLM Reason (collapsible) */}
      {item.judgement?.reason && (
        <div className="mx-4 mb-3 rounded-lg bg-muted/60 border text-xs">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center justify-between px-3 py-2 text-muted-foreground hover:text-foreground"
          >
            <span className="font-medium">AI 分析</span>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expanded && (
            <p className="px-3 pb-3 text-muted-foreground leading-relaxed">
              {item.judgement.reason}
            </p>
          )}
        </div>
      )}

      {/* Content preview (new vs existing) */}
      {(item.newPageExcerpt || item.existingPageExcerpt) && expanded && (
        <div className="mx-4 mb-3 grid grid-cols-2 gap-2">
          {item.newPageExcerpt && (
            <div className="rounded-lg border border-blue-100 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-900 p-2">
              <p className="text-[10px] font-medium text-blue-600 dark:text-blue-400 mb-1">新内容</p>
              <p className="text-[11px] text-muted-foreground line-clamp-4 leading-relaxed">{item.newPageExcerpt}</p>
            </div>
          )}
          {item.existingPageExcerpt && (
            <div className="rounded-lg border border-slate-100 bg-slate-50/50 dark:bg-slate-800/20 dark:border-slate-700 p-2">
              <p className="text-[10px] font-medium text-slate-500 mb-1">现有内容</p>
              <p className="text-[11px] text-muted-foreground line-clamp-4 leading-relaxed">{item.existingPageExcerpt}</p>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 border-t px-4 py-2.5 bg-muted/30 flex-wrap">
        <button
          onClick={() => onResolve(item.id, "accepted")}
          className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-600 transition-colors"
        >
          <CheckCircle className="h-3 w-3" />
          采纳为新知识
        </button>
        <button
          onClick={openDetail}
          className="flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent transition-colors"
        >
          <Eye className="h-3 w-3" />
          详情对比
        </button>
        {item.existingPagePath && (
          <>
            <button
              onClick={() => onResolve(item.id, "superseded")}
              className="flex items-center gap-1 rounded-lg bg-blue-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-blue-600 transition-colors"
            >
              <GitMerge className="h-3 w-3" />
              作为新版替代旧页
            </button>
            <button
              onClick={() => onResolve(item.id, "merged")}
              className="flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent transition-colors"
            >
              合并进旧页
            </button>
            <button
              onClick={() => onResolve(item.id, "unrelated")}
              className="flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent transition-colors"
            >
              不是关联，保留新知识
            </button>
          </>
        )}
        <button
          onClick={() => onResolve(item.id, "rejected")}
          className="flex items-center gap-1 rounded-lg border border-red-200 bg-background px-2.5 py-1.5 text-[11px] font-medium text-red-500 hover:bg-red-50 transition-colors"
        >
          <XCircle className="h-3 w-3" />
          不采纳新知识
        </button>
        <button
          onClick={() => onDismiss(item.id)}
          className="ml-auto rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          暂不处理
        </button>
      </div>

      {detailOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold">审核详情 / 内容对比</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  新页面：{item.newPageTitle}
                  {item.existingPageTitle ? ` · 候选关联页面：${item.existingPageTitle}` : " · 无旧页面，仅需确认新知识"}
                </div>
              </div>
              <button
                onClick={() => setDetailOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-4 lg:grid-cols-2">
              <ReviewDetailColumn
                title="新知识"
                path={item.newPagePath}
                content={newContent}
                fallback={item.newPageExcerpt}
                loading={detailLoading}
                tone="new"
              />
              <ReviewDetailColumn
                title={item.existingPageTitle ? "现有知识" : "现有知识（无）"}
                path={item.existingPagePath}
                content={existingContent}
                fallback={item.existingPageExcerpt}
                loading={detailLoading}
                tone="old"
              />
            </div>

            {item.judgement?.reason && (
              <div className="border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">AI 判断：</span>
                {item.judgement.reason}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewDetailColumn({
  title,
  path,
  content,
  fallback,
  loading,
  tone,
}: {
  title: string
  path?: string
  content: string
  fallback?: string
  loading: boolean
  tone: "new" | "old"
}) {
  const displayContent = content || fallback || "暂无内容"
  const body = stripFrontmatter(displayContent)
  return (
    <div className={`min-h-[360px] overflow-hidden rounded-lg border ${tone === "new" ? "border-blue-200" : "border-slate-200"}`}>
      <div className={`${tone === "new" ? "bg-blue-50 text-blue-700" : "bg-slate-50 text-slate-700"} border-b px-3 py-2`}>
        <div className="text-xs font-semibold">{title}</div>
        {path && <div className="mt-0.5 truncate text-[10px] opacity-75">{path}</div>}
      </div>
      <div className="max-h-[58vh] overflow-auto p-3">
        {loading ? (
          <div className="py-12 text-center text-xs text-muted-foreground">正在读取完整内容...</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
            {body}
          </pre>
        )}
      </div>
    </div>
  )
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
}
