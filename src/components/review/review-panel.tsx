/**
 * review-panel.tsx
 *
 * Review Queue sidebar panel — shows all pending knowledge governance items.
 * Loaded when the user clicks the review icon in the icon sidebar.
 */

import { useEffect } from "react"
import { ShieldCheck, Inbox } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { useGovernanceStore } from "@/stores/governance-store"
import { setPageStatus } from "@/lib/knowledge-governance"
import { ReviewItemCard } from "./review-item-card"
import { normalizePath } from "@/lib/path-utils"
import type { ReviewResolution } from "@/lib/knowledge-governance"

export function ReviewPanel() {
  const project = useWikiStore((s) => s.project)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const { items, isLoading, loadQueue, resolve, dismiss } = useGovernanceStore()

  const pp = project ? normalizePath(project.path) : null

  useEffect(() => {
    if (pp) loadQueue(pp)
  }, [pp, loadQueue])

  const pendingItems = items.filter((i) => i.status === "pending")
  const resolvedItems = items.filter((i) => i.status === "resolved")

  const handleResolve = async (id: string, resolution: ReviewResolution) => {
    if (!pp) return
    const item = items.find((i) => i.id === id)
    if (!item) return

    // Apply status change to the actual file
    try {
      if (resolution === "accepted") {
        await setPageStatus(item.newPagePath, "active")
      } else if (resolution === "rejected") {
        await setPageStatus(item.newPagePath, "rejected")
      } else if (resolution === "superseded" && item.existingPagePath) {
        await setPageStatus(item.existingPagePath, "superseded")
        await setPageStatus(item.newPagePath, "active")

        // ── Phase 3: Record knowledge transition + generate semantic diff ───
        // Fire-and-forget so the UI is not blocked.
        ;(async () => {
          try {
            const { readFile } = await import("@/commands/fs")
            const { generateSemanticDiff } = await import("@/lib/knowledge-governance/diff-engine")
            const { recordTransition } = await import("@/lib/knowledge-governance/lineage-tracker")
            const llmConfig = (await import("@/stores/wiki-store")).useWikiStore.getState().llmConfig

            const [oldContent, newContent] = await Promise.all([
              readFile(item.existingPagePath!).catch(() => ""),
              readFile(item.newPagePath).catch(() => ""),
            ])

            const diffResult = await generateSemanticDiff(
              llmConfig,
              item.existingPageTitle,
              oldContent,
              item.newPageTitle,
              newContent,
            )

            await recordTransition(
              pp,
              item.existingPagePath!,
              item.existingPageTitle,
              item.newPagePath,
              item.newPageTitle,
              diffResult,
              "supersedes",
            )

            console.log(`[ReviewPanel] Lineage recorded for "${item.newPageTitle}" ← "${item.existingPageTitle}"`)
          } catch (err) {
            console.warn("[ReviewPanel] Failed to record transition:", err)
          }
        })()
      } else if (resolution === "merged") {
        await setPageStatus(item.newPagePath, "rejected")
      }
    } catch (err) {
      console.error("[ReviewPanel] Failed to update page status:", err)
    }

    await resolve(pp, id, resolution)
    bumpDataVersion()  // Refresh WikiPageViewer status badge
  }

  const handleDismiss = async (id: string) => {
    if (!pp) return
    await dismiss(pp, id)
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        请先打开一个项目
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <ShieldCheck className="h-4 w-4 text-amber-500" />
        <h2 className="font-semibold text-sm">知识审核队列</h2>
        {pendingItems.length > 0 && (
          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
            {pendingItems.length} 待处理
          </span>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {isLoading && (
            <div className="flex justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-amber-500" />
            </div>
          )}

          {!isLoading && pendingItems.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/40">
                <Inbox className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-medium">知识库状态良好</p>
                <p className="text-xs text-muted-foreground mt-1">暂无待确认的知识更新</p>
              </div>
            </div>
          )}

          {pendingItems.map((item) => (
            <ReviewItemCard
              key={item.id}
              item={item}
              onResolve={handleResolve}
              onDismiss={handleDismiss}
            />
          ))}

          {/* Resolved section */}
          {resolvedItems.length > 0 && (
            <div className="mt-4">
              <p className="px-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                已处理 ({resolvedItems.length})
              </p>
              {resolvedItems.slice(-5).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                      item.resolution === "accepted" || item.resolution === "superseded"
                        ? "bg-emerald-500"
                        : item.resolution === "rejected"
                        ? "bg-red-400"
                        : "bg-blue-400"
                    }`}
                  />
                  <span className="truncate flex-1">{item.newPageTitle}</span>
                  <span className="flex-shrink-0 text-[10px]">
                    {{ accepted: "已确认", rejected: "已拒绝", merged: "已合并", superseded: "已替代" }[item.resolution!] ?? ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
