import { useCallback, useState } from "react"
import { queueResearch } from "@/lib/deep-research"
import {
  AlertTriangle,
  Copy,
  FileQuestion,
  FileText,
  CheckCircle2,
  Lightbulb,
  MessageSquare,
  X,
  Check,
  Trash2,
  HelpCircle,
  ArrowRight,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { writeFile, readFile, listDirectory, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { ReviewPanel as GovernanceReviewPanel } from "./review-panel"
import { EvolutionPanel } from "./evolution-panel"
import { useGovernanceStore } from "@/stores/governance-store"
import { applyProductFieldValueUpdate } from "@/lib/product-catalog-sync"

const typeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; label: string; color: string }> = {
  contradiction: { icon: AlertTriangle, label: "Contradiction", color: "text-amber-500" },
  duplicate: { icon: Copy, label: "Possible Duplicate", color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, label: "Missing Page", color: "text-purple-500" },
  confirm: { icon: MessageSquare, label: "Needs Confirmation", color: "text-foreground" },
  suggestion: { icon: Lightbulb, label: "Suggestion", color: "text-emerald-500" },
}

type ProductFieldConflict = NonNullable<ReviewItem["conflict"]>

function isKnowledgeReviewItem(item: ReviewItem): boolean {
  return item.type === "contradiction" || item.type === "confirm"
}

function extractReviewLine(description: string, label: string): string {
  const match = description.match(new RegExp(`^${label}[:：]\\s*(.+)$`, "m"))
  return match?.[1]?.trim() ?? ""
}

function parseLegacyProductConflict(item: ReviewItem): ProductFieldConflict | null {
  if (!item.title.includes("产品字段冲突") && !item.title.includes("产品身份冲突")) return null
  const existingValue = extractReviewLine(item.description, "现有值")
  const incomingValue = extractReviewLine(item.description, "新增值")
  const fieldName = extractReviewLine(item.description, "字段")
  const affectedPath = extractReviewLine(item.description, "页面") || item.affectedPages?.[0] || ""
  if (!existingValue && !incomingValue) return null

  const productLine = extractReviewLine(item.description, "产品")
  const separator = productLine.indexOf("-")
  const category = separator > 0 ? productLine.slice(0, separator) : ""
  const productName = separator > 0 ? productLine.slice(separator + 1) : productLine
  const sourceFileName = item.sourcePath ||
    item.description.match(/增量上传文件「([^」]+)」/)?.[1]?.trim() ||
    "增量上传文件"

  return {
    kind: "product-field",
    category,
    productName,
    fieldName: fieldName || item.title.replace(/^.*?：/, ""),
    pageKind: item.title.includes("产品身份冲突") ? "产品身份" : "字段页",
    existingValue,
    incomingValue,
    sourceFileName,
    affectedPath,
  }
}

function getProductConflict(item: ReviewItem): ProductFieldConflict | null {
  return item.conflict ?? parseLegacyProductConflict(item)
}

function compactPath(path: string): string {
  if (path.length <= 80) return path
  const parts = path.replace(/\\/g, "/").split("/")
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : `...${path.slice(-76)}`
}

async function openWikiPage(projectPath: string, relativeOrAbsolutePath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  const normalized = normalizePath(relativeOrAbsolutePath)
  const fullPath = normalized.startsWith(pp) ? normalized : `${pp}/${normalized}`
  const content = await readFile(fullPath)
  const store = useWikiStore.getState()
  store.setSelectedFile(fullPath)
  store.setFileContent(content)
  store.setActiveView("wiki")
}

async function applyProductConflictIncomingValue(projectPath: string, conflict: ProductFieldConflict): Promise<void> {
  const pp = normalizePath(projectPath)
  const fieldPath = `${pp}/${normalizePath(conflict.affectedPath)}`
  await applyProductFieldValueUpdate(pp, {
    fieldPath,
    category: conflict.category,
    productName: conflict.productName,
    fieldName: conflict.fieldName,
    value: conflict.incomingValue,
  })
}

export function ReviewView() {
  const items = useReviewStore((s) => s.items)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const clearResolved = useReviewStore((s) => s.clearResolved)
  const project = useWikiStore((s) => s.project)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const governancePendingCount = useGovernanceStore((s) => s.pendingCount)
  const [tab, setTab] = useState<"governance" | "evolution" | "ai-suggestions">("governance")

  const handleResolve = useCallback(async (id: string, action: string) => {
    const pp = project ? normalizePath(project.path) : ""
    const reviewItem = items.find((i) => i.id === id)
    const productConflict = reviewItem ? getProductConflict(reviewItem) : null

    if (project && productConflict) {
      if (action === "manual-merge") {
        try {
          await openWikiPage(pp, productConflict.affectedPath)
        } catch (err) {
          console.error("Failed to open conflict page:", err)
        }
        return
      }

      if (action === "accept-incoming") {
        try {
          await applyProductConflictIncomingValue(pp, productConflict)
          const tree = await listDirectory(pp)
          setFileTree(tree)
          useWikiStore.getState().bumpDataVersion()
          resolveItem(id, "已采用新值")
        } catch (err) {
          console.error("Failed to apply incoming product field value:", err)
          window.alert(`采用新值失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      if (action === "keep-existing") {
        resolveItem(id, "已保留旧值")
        return
      }

      if (action === "dismiss") {
        dismissItem(id)
        return
      }
    }

    // Deep Research — must be checked FIRST before any fuzzy matching
    if (action === "__deep_research__" && project) {
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (searchConfig.provider === "none" || !searchConfig.apiKey) {
        window.alert("Web Search not configured. Go to Settings → Web Search to add a Tavily API key first.")
        return
      }
      const item = items.find((i) => i.id === id)
      if (item) {
        const llmConfig = useWikiStore.getState().llmConfig
        // Use pre-generated search queries if available, otherwise fall back to title
        const topic = item.title.replace(/^(Save to Wiki|Create|Research)[:\s]*/i, "").trim() || item.description.split("\n")[0]
        queueResearch(pp, topic, llmConfig, searchConfig, item.searchQueries)
        resolveItem(id, "Queued for research")
      } else {
        resolveItem(id, action)
      }
      return
    }

    if (action.startsWith("save:") && project) {
      // Decode and save the content to wiki
      try {
        const encoded = action.slice(5)
        const content = decodeURIComponent(atob(encoded))

        // Strip hidden comments
        const cleanContent = content
          .replace(/<!--\s*save-worthy:.*?-->/g, "")
          .replace(/<!--\s*sources:.*?-->/g, "")
          .trimEnd()

        // Generate filename
        const firstLine = cleanContent.split("\n").find((l) => l.trim() && !l.startsWith("<!--"))?.replace(/^#+\s*/, "").trim() ?? "Saved Query"
        const title = firstLine.slice(0, 60)
        const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 50)
        const date = new Date().toISOString().slice(0, 10)
        const fileName = `${slug}-${date}.md`
        const filePath = `${pp}/wiki/queries/${fileName}`

        const frontmatter = `---\ntype: query\ntitle: "${title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\n---\n\n`
        await writeFile(filePath, frontmatter + cleanContent)

        // Update index
        const indexPath = `${pp}/wiki/index.md`
        let indexContent = ""
        try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
        const entry = `- [[queries/${slug}-${date}|${title}]]`
        if (indexContent.includes("## Queries")) {
          indexContent = indexContent.replace(/(## Queries\n)/, `$1${entry}\n`)
        } else {
          indexContent = indexContent.trimEnd() + "\n\n## Queries\n" + entry + "\n"
        }
        await writeFile(indexPath, indexContent)

        // Append log
        const logPath = `${pp}/wiki/log.md`
        let logContent = ""
        try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
        await writeFile(logPath, logContent.trimEnd() + `\n- ${date}: Saved query page \`${fileName}\`\n`)

        // Refresh tree
        const tree = await listDirectory(pp)
        setFileTree(tree)

        resolveItem(id, "Saved to Wiki")
      } catch (err) {
        console.error("Failed to save to wiki from review:", err)
        resolveItem(id, "Save failed")
      }
    } else if (action.startsWith("open:") && project) {
      // Open a page for editing
      const page = action.slice(5)
      const candidates = [
        `${pp}/wiki/${page}`,
        `${pp}/wiki/${page}.md`,
      ]
      for (const path of candidates) {
        try {
          const content = await readFile(path)
          useWikiStore.getState().setSelectedFile(path)
          useWikiStore.getState().setFileContent(content)
          useWikiStore.getState().setActiveView("wiki")
          break
        } catch {
          // try next
        }
      }
      resolveItem(id, action)
    } else if (action.startsWith("delete:") && project) {
      // Delete a file
      const filePath = action.slice(7)
      try {
        await deleteFile(filePath)
        const tree = await listDirectory(pp)
        setFileTree(tree)
        resolveItem(id, "Deleted")
      } catch (err) {
        console.error("Failed to delete:", err)
        resolveItem(id, "Delete failed")
      }
    } else if (actionLooksLikeResearch(action) && project) {
      // Actions with "research" trigger deep research, not just page creation
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (searchConfig.provider === "none" || !searchConfig.apiKey) {
        // No search API — fall through to create a page instead
        const item = items.find((i) => i.id === id)
        if (item) {
          handleResolve(id, "__create_page__:" + action)
        }
        return
      }
      const item = items.find((i) => i.id === id)
      if (item) {
        const llmConfig = useWikiStore.getState().llmConfig
        const topic = action.replace(/^research\s*/i, "").trim() || item.description.split("\n")[0]
        queueResearch(pp, topic, llmConfig, searchConfig)
        resolveItem(id, "Queued for deep research")
      } else {
        resolveItem(id, action)
      }
    } else if (
      (action.startsWith("__create_page__:") || actionLooksLikeCreate(action))
      && project
    ) {
      // Create a wiki page from the review item's content. Accepts both
      // the `__create_page__:` sentinel (forced via the "no search API"
      // fallback branch above) and actions that heuristically look like
      // a create instruction.
      const realAction = action.startsWith("__create_page__:")
        ? action.slice("__create_page__:".length)
        : action
      const item = items.find((i) => i.id === id)
      if (item) {
        try {
          const title = item.title.replace(/^(Create|Save|Add)[:\s]*/i, "").trim() || "Untitled"
          const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 50)
          const date = new Date().toISOString().slice(0, 10)

          // Determine page type from review type or action text
          const pageType = detectPageType(realAction, item.type)
          const dir = pageType === "query" ? "queries" : pageType === "entity" ? "entities" : pageType === "concept" ? "concepts" : "queries"
          const fileName = `${slug}-${date}.md`
          const filePath = `${pp}/wiki/${dir}/${fileName}`

          const frontmatter = `---\ntype: ${pageType}\ntitle: "${title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\nrelated: []\n---\n\n`
          const body = `# ${title}\n\n${item.description}\n`
          await writeFile(filePath, frontmatter + body)

          // Update index
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
          const sectionHeader = `## ${dir.charAt(0).toUpperCase() + dir.slice(1)}`
          const entry = `- [[${dir}/${slug}-${date}|${title}]]`
          if (indexContent.includes(sectionHeader)) {
            indexContent = indexContent.replace(new RegExp(`(${sectionHeader}\n)`), `$1${entry}\n`)
          } else {
            indexContent = indexContent.trimEnd() + `\n\n${sectionHeader}\n${entry}\n`
          }
          await writeFile(indexPath, indexContent)

          // Log
          const logPath = `${pp}/wiki/log.md`
          let logContent = ""
          try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
          await writeFile(logPath, logContent.trimEnd() + `\n- ${date}: Created ${pageType} page \`${fileName}\` from review\n`)

          // Refresh
          const tree = await listDirectory(pp)
          setFileTree(tree)
          useWikiStore.getState().bumpDataVersion()

          resolveItem(id, `Created: wiki/${dir}/${fileName}`)
        } catch (err) {
          console.error("Failed to create page from review:", err)
          resolveItem(id, "Create failed")
        }
      } else {
        resolveItem(id, action)
      }
    } else {
      resolveItem(id, action)
    }
  }, [project, items, resolveItem, dismissItem, setFileTree])

  const knowledgeItems = items.filter(isKnowledgeReviewItem)
  const aiItems = items.filter((i) => !isKnowledgeReviewItem(i))
  const knowledgePending = knowledgeItems.filter((i) => !i.resolved)
  const knowledgeResolved = knowledgeItems.filter((i) => i.resolved)
  const aiPending = aiItems.filter((i) => !i.resolved)
  const aiResolved = aiItems.filter((i) => i.resolved)
  const knowledgeTabCount = knowledgePending.length + governancePendingCount

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b">
        <button
          onClick={() => setTab("governance")}
          className={`flex-1 px-2 py-2.5 text-xs font-medium transition-colors ${
            tab === "governance"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          🛡 知识审核
          {knowledgeTabCount > 0 && (
            <span className="ml-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] text-white">
              {knowledgeTabCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("evolution")}
          className={`flex-1 px-2 py-2.5 text-xs font-medium transition-colors ${
            tab === "evolution"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          📈 知识演化
        </button>
        <button
          onClick={() => setTab("ai-suggestions")}
          className={`relative flex-1 px-2 py-2.5 text-xs font-medium transition-colors ${
            tab === "ai-suggestions"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          💡 AI 建议
          {aiPending.length > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
              {aiPending.length}
            </span>
          )}
        </button>
      </div>

      {/* Governance tab */}
      {tab === "governance" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <KnowledgeReviewSection
            pending={knowledgePending}
            resolved={knowledgeResolved}
            onResolve={handleResolve}
            onDismiss={dismissItem}
          />
          <GovernanceReviewPanel />
        </div>
      )}

      {/* Evolution tab */}
      {tab === "evolution" && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <EvolutionPanel />
        </div>
      )}

      {/* AI Suggestions tab */}
      {tab === "ai-suggestions" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {aiResolved.length > 0 && (
            <div className="flex justify-end border-b px-3 py-1.5">
              <Button variant="ghost" size="sm" onClick={clearResolved} className="text-xs">
                <Trash2 className="mr-1 h-3 w-3" />
                Clear resolved
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {aiItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
                <p>暂无 AI 建议</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 p-3">
                {aiPending.map((item) => (
                  <ReviewCard key={item.id} item={item} onResolve={handleResolve} onDismiss={dismissItem} />
                ))}
                {aiResolved.length > 0 && aiPending.length > 0 && (
                  <div className="my-2 text-center text-xs text-muted-foreground">已处理</div>
                )}
                {aiResolved.map((item) => (
                  <ReviewCard key={item.id} item={item} onResolve={handleResolve} onDismiss={dismissItem} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


function KnowledgeReviewSection({
  pending,
  resolved,
  onResolve,
  onDismiss,
}: {
  pending: ReviewItem[]
  resolved: ReviewItem[]
  onResolve: (id: string, action: string) => void
  onDismiss: (id: string) => void
}) {
  if (pending.length === 0 && resolved.length === 0) return null

  return (
    <div className="flex max-h-[58%] min-h-[240px] flex-col border-b bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">字段冲突审核</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            增量上传发现的新旧字段差异。系统已保留旧值，等待管理员判断。
          </p>
        </div>
        {pending.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
            {pending.length} 待处理
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3">
          {pending.map((item) => (
            <ReviewCard key={item.id} item={item} onResolve={onResolve} onDismiss={onDismiss} />
          ))}
          {resolved.length > 0 && pending.length > 0 && (
            <div className="text-center text-xs text-muted-foreground">已处理</div>
          )}
          {resolved.map((item) => (
            <ReviewCard key={item.id} item={item} onResolve={onResolve} onDismiss={onDismiss} />
          ))}
        </div>
      </div>
    </div>
  )
}


function ReviewCard({
  item,
  onResolve,
  onDismiss,
}: {
  item: ReviewItem
  onResolve: (id: string, action: string) => void
  onDismiss: (id: string) => void
}) {
  const config = typeConfig[item.type]
  const Icon = config.icon
  const score = item.aiScore
  const conflict = getProductConflict(item)
  const project = useWikiStore((s) => s.project)
  const displayTitle = conflict ? `字段冲突：${conflict.fieldName}` : item.title

  const openAffectedPage = useCallback(async (page: string) => {
    if (!project) return
    const pp = normalizePath(project.path)
    const normalized = normalizePath(page)
    const fullPath = normalized.startsWith(pp) ? normalized : `${pp}/${normalized}`
    try {
      const content = await readFile(fullPath)
      const store = useWikiStore.getState()
      store.setSelectedFile(fullPath)
      store.setFileContent(content)
      store.setActiveView("wiki")
    } catch (err) {
      console.warn("Failed to open affected review page:", err)
    }
  }, [project])

  // Confidence bar color and verdict icon
  const verdictColor = !score ? "" :
    score.verdict === "reliable" ? "text-emerald-500" :
    score.verdict === "uncertain" ? "text-amber-500" : "text-red-500"
  const verdictBarColor = !score ? "" :
    score.verdict === "reliable" ? "bg-emerald-500" :
    score.verdict === "uncertain" ? "bg-amber-500" : "bg-red-500"
  const VerdictIcon = !score ? null :
    score.verdict === "reliable" ? ShieldCheck :
    score.verdict === "uncertain" ? ShieldAlert : ShieldX

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-opacity ${
        item.resolved ? "opacity-50" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
          <span className="font-medium">{displayTitle}</span>
          {conflict && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              {conflict.pageKind}
            </span>
          )}
        </div>
        <button
          onClick={() => onDismiss(item.id)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {conflict ? (
        <ProductConflictDetails
          conflict={conflict}
          pages={item.affectedPages}
          onOpenPage={openAffectedPage}
        />
      ) : (
        <p className="mb-3 text-xs text-muted-foreground whitespace-pre-wrap">{item.description}</p>
      )}

      {/* AI Score Panel */}
      {score && (
        <div className="mb-3 rounded-lg border border-border/60 bg-muted/30 p-2.5">
          {/* Confidence bar */}
          <div className="mb-2 flex items-center gap-2">
            {VerdictIcon && <VerdictIcon className={`h-3.5 w-3.5 shrink-0 ${verdictColor}`} />}
            <div className="flex-1">
              <div className="mb-0.5 flex items-center justify-between">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">AI Confidence</span>
                <span className={`text-[10px] font-semibold ${verdictColor}`}>
                  {score.confidence}% · {score.verdict}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${verdictBarColor}`}
                  style={{ width: `${score.confidence}%` }}
                />
              </div>
            </div>
          </div>
          {/* Critique */}
          {score.critique && (
            <p className="mb-1.5 text-[11px] text-muted-foreground italic">{score.critique}</p>
          )}
          {/* Questions */}
          {score.questions.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {score.questions.map((q, i) => (
                <div key={i} className="flex items-start gap-1 text-[11px] text-muted-foreground">
                  <HelpCircle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                  <span>{q}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!conflict && item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-3 text-xs text-muted-foreground">
          Pages: {item.affectedPages.join(", ")}
        </div>
      )}

      {!item.resolved ? (
        <div className="flex flex-wrap gap-1.5">
          {(item.type === "suggestion" || item.type === "missing-page") && (
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => onResolve(item.id, "__deep_research__")}
            >
              🔍 Deep Research
            </Button>
          )}
          {item.options.map((opt) => (
            <Button
              key={opt.action}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onResolve(item.id, opt.action)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-emerald-600">
          <Check className="h-3 w-3" />
          {item.resolvedAction}
        </div>
      )}
    </div>
  )
}

function ProductConflictDetails({
  conflict,
  pages,
  onOpenPage,
}: {
  conflict: ProductFieldConflict
  pages?: string[]
  onOpenPage: (page: string) => void
}) {
  const affectedPages = pages?.length ? pages : conflict.affectedPath ? [conflict.affectedPath] : []

  return (
    <div className="mb-3 space-y-3">
      <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
        <InfoPill label="产品" value={`${conflict.category ? `${conflict.category} / ` : ""}${conflict.productName}`} />
        <InfoPill label="字段" value={conflict.fieldName} />
        <InfoPill label="来源文件" value={conflict.sourceFileName} />
        <InfoPill label="处理状态" value="保留旧值，等待人工审核" />
      </div>

      <div className="grid gap-2 lg:grid-cols-[1fr_auto_1fr]">
        <ConflictValueBox
          title="当前知识"
          subtitle="已保留，未被自动覆盖"
          value={conflict.existingValue}
          tone="existing"
        />
        <div className="hidden items-center justify-center lg:flex">
          <ArrowRight className="h-4 w-4 text-muted-foreground/60" />
        </div>
        <ConflictValueBox
          title="增量抽取"
          subtitle="来自本次上传文件"
          value={conflict.incomingValue}
          tone="incoming"
        />
      </div>

      {affectedPages.length > 0 && (
        <div className="rounded-md border bg-muted/20 px-2.5 py-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            影响页面
          </div>
          <div className="flex flex-wrap gap-1.5">
            {affectedPages.map((page) => (
              <button
                key={page}
                type="button"
                onClick={() => onOpenPage(page)}
                title={page}
                className="max-w-full rounded border bg-background px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent"
              >
                {compactPath(page)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-2.5 py-1.5">
      <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">{label}</div>
      <div className="truncate text-xs text-foreground" title={value}>{value || "-"}</div>
    </div>
  )
}

function ConflictValueBox({
  title,
  subtitle,
  value,
  tone,
}: {
  title: string
  subtitle: string
  value: string
  tone: "existing" | "incoming"
}) {
  const toneClasses = tone === "existing"
    ? "border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-950/30"
    : "border-amber-200 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/20"
  const badgeClasses = tone === "existing"
    ? "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
    : "bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-100"

  return (
    <div className={`min-w-0 rounded-md border p-3 ${toneClasses}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold">{title}</div>
          <div className="text-[10px] text-muted-foreground">{subtitle}</div>
        </div>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badgeClasses}`}>
          {tone === "existing" ? "旧值" : "新值"}
        </span>
      </div>
      <div className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background/70 px-2 py-1.5 text-xs leading-relaxed">
        {value || "-"}
      </div>
    </div>
  )
}

/** Detect if an action implies deep research (web search + LLM synthesis) */
function actionLooksLikeResearch(action: string): boolean {
  // Skip internal action identifiers
  if (action.startsWith("__")) return false
  const lower = action.toLowerCase()
  return (
    lower.includes("research") ||
    lower.includes("investigate") ||
    lower.includes("explore") ||
    lower.includes("look into") ||
    lower.includes("研究") ||
    lower.includes("调研") ||
    lower.includes("探索")
  )
}

/** Detect if an action is a dismissal (no-op) or should create a page */
function actionIsDismissal(action: string): boolean {
  const lower = action.toLowerCase()
  return (
    lower === "skip" ||
    lower === "dismiss" ||
    lower === "ignore" ||
    lower === "跳过" ||
    lower === "忽略" ||
    lower === "approve" ||
    lower === "keep existing" ||
    lower === "no"
  )
}

function actionLooksLikeCreate(action: string): boolean {
  // Anything that isn't a dismissal should create a page
  return !actionIsDismissal(action)
}

/** Infer wiki page type from action text and review item type */
function detectPageType(action: string, reviewType: string): string {
  const lower = action.toLowerCase()
  if (lower.includes("entity") || lower.includes("实体")) return "entity"
  if (lower.includes("concept") || lower.includes("概念")) return "concept"
  if (lower.includes("comparison") || lower.includes("compare") || lower.includes("比较")) return "comparison"
  if (lower.includes("synthesis") || lower.includes("综合")) return "synthesis"
  if (reviewType === "missing-page") return "concept"
  if (reviewType === "contradiction") return "query"
  if (reviewType === "suggestion") return "query"
  // Default: research/investigate/create → query
  return "query"
}
