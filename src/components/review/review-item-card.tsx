/**
 * review-item-card.tsx
 *
 * Decision card for a single Review Queue item.
 * Shows: new page info, existing page info (if any), LLM judgement, action buttons.
 */

import { useState } from "react"
import { FileText, GitMerge, XCircle, CheckCircle, ChevronDown, ChevronUp, Clock } from "lucide-react"
import type { ReviewItem } from "@/lib/knowledge-governance"

interface ReviewItemCardProps {
  item: ReviewItem
  onResolve: (id: string, resolution: "accepted" | "rejected" | "merged" | "superseded") => void
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

  const relation = item.judgement?.relation
  const relConfig = relation ? RELATION_LABEL[relation] : null
  const confidence = item.judgement?.confidence
  const createdDate = new Date(item.createdAt).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  })

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
            <p className="mt-0.5 text-xs text-muted-foreground">
              与「{item.existingPageTitle}」存在关联
            </p>
          )}
          <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {createdDate}
          </div>
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
          确认为有效
        </button>
        {item.existingPagePath && (
          <>
            <button
              onClick={() => onResolve(item.id, "superseded")}
              className="flex items-center gap-1 rounded-lg bg-blue-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-blue-600 transition-colors"
            >
              <GitMerge className="h-3 w-3" />
              替代旧版本
            </button>
            <button
              onClick={() => onResolve(item.id, "merged")}
              className="flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent transition-colors"
            >
              合并到旧页面
            </button>
          </>
        )}
        <button
          onClick={() => onResolve(item.id, "rejected")}
          className="flex items-center gap-1 rounded-lg border border-red-200 bg-background px-2.5 py-1.5 text-[11px] font-medium text-red-500 hover:bg-red-50 transition-colors"
        >
          <XCircle className="h-3 w-3" />
          拒绝
        </button>
        <button
          onClick={() => onDismiss(item.id)}
          className="ml-auto rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          暂不处理
        </button>
      </div>
    </div>
  )
}
