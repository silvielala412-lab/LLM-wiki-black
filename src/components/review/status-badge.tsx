/**
 * status-badge.tsx — Knowledge status indicator chip.
 *
 * candidate  → amber  ⏳ 待确认
 * active     → emerald ✓ 已确认
 * superseded → slate  ↩ 已替代
 * rejected   → red    ✗ 已拒绝
 */

import type { KnowledgeStatus } from "@/lib/knowledge-governance"

interface StatusBadgeProps {
  status: KnowledgeStatus
  /** Show a compact dot-only version (for tree lists) */
  compact?: boolean
}

const CONFIG: Record<KnowledgeStatus, { label: string; icon: string; classes: string }> = {
  candidate:  { label: "待确认", icon: "⏳", classes: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800" },
  active:     { label: "已确认", icon: "✓",  classes: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800" },
  superseded: { label: "已替代", icon: "↩",  classes: "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700" },
  rejected:   { label: "已拒绝", icon: "✗",  classes: "bg-red-50 text-red-600 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800" },
}

/** Dot-only indicator for use in tight spaces (tree list rows) */
const DOT_CLASSES: Record<KnowledgeStatus, string> = {
  candidate:  "bg-amber-400",
  active:     "bg-emerald-500",
  superseded: "bg-slate-400",
  rejected:   "bg-red-500",
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const cfg = CONFIG[status]

  if (compact) {
    return (
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${DOT_CLASSES[status]}`}
        title={cfg.label}
      />
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${cfg.classes}`}
    >
      <span style={{ fontSize: 10 }}>{cfg.icon}</span>
      {cfg.label}
    </span>
  )
}
