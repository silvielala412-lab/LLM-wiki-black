import { useRef, useEffect, useCallback, useState } from "react"
import { BookOpen, Plus, Trash2, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile, deleteFile, writeFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"
import { cascadeDeleteWikiPage } from "@/lib/wiki-page-delete"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import type { FileNode } from "@/types/wiki"

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []

interface BackendChatSource {
  title?: string
  path?: string
}

interface BackendChatMeta {
  retrieval_ms?: number
  sources?: BackendChatSource[]
}

interface BackendChatCallbacks {
  onMeta: (meta: BackendChatMeta) => void
  onToken: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

function parseBackendChatData(data: string): { meta?: BackendChatMeta; token?: string } {
  if (data === "[DONE]") return {}
  try {
    const json = JSON.parse(data)
    if (json?.type === "chat_meta") return { meta: json as BackendChatMeta }
    const token = json?.choices?.[0]?.delta?.content
    return typeof token === "string" ? { token } : {}
  } catch {
    return {}
  }
}

function backendSourcesToReferences(sources: BackendChatSource[] | undefined): MessageReference[] {
  return (sources ?? [])
    .filter((source) => source.path || source.title)
    .map((source) => ({
      title: source.title || source.path || "Source",
      path: source.path || source.title || "",
    }))
}

async function streamBackendProjectChat(
  projectPath: string,
  messages: LLMMessage[],
  options: {
    maxHistoryMessages: number
    model?: string
    temperature?: number
    maxTokens?: number
    topK?: number
  },
  callbacks: BackendChatCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: projectPath,
        messages,
        stream: true,
        top_k: options.topK ?? 8,
        max_history_messages: options.maxHistoryMessages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 1600,
        model: options.model,
      }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) {
      callbacks.onDone()
      return
    }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText)
    callbacks.onError(new Error(`HTTP ${response.status}: ${detail || response.statusText}`))
    return
  }

  if (!response.body) {
    callbacks.onError(new Error("Response body is null"))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const parsed = parseBackendChatData(trimmed.slice(5).trim())
        if (parsed.meta) callbacks.onMeta(parsed.meta)
        if (parsed.token) callbacks.onToken(parsed.token)
      }
    }

    if (buffer.trim().startsWith("data:")) {
      const parsed = parseBackendChatData(buffer.trim().slice(5).trim())
      if (parsed.meta) callbacks.onMeta(parsed.meta)
      if (parsed.token) callbacks.onToken(parsed.token)
    }
    callbacks.onDone()
  } catch (err) {
    if (signal?.aborted) {
      callbacks.onDone()
      return
    }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
  }
}

type ChatDeleteItem = { name: string; path: string }

function flattenMarkdownFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMarkdownFiles(node.children))
    } else if (!node.is_dir && node.name.toLowerCase().endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractPageTitle(fileName: string, content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  const titleMatch = fm?.[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
  if (titleMatch) return titleMatch[1].trim()

  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  return fileName.replace(/\.md$/i, "").replace(/-/g, " ")
}

function parseBulkTitleDeleteKeyword(text: string): string | null {
  const lower = text.toLowerCase()
  const wantsDelete = /delete/.test(lower) || /删除|删掉|移除|清理/.test(text)
  const mentionsTitle = /title/.test(lower) || /标题/.test(text)
  if (!wantsDelete || !mentionsTitle) return null

  const patterns = [
    /标题\s*(?:中)?\s*(?:含有|包含|包括|带有|有)\s*["'`“”]?(.+?)["'`“”]?\s*(?:的)?\s*(?:所有|全部)?\s*(?:文档|页面|资料|文件|wiki)/i,
    /title\s*(?:contains|including|includes|with)\s*["'`]?(.+?)["'`]?\s*(?:documents|pages|files|wiki)?/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const keyword = match[1]
      .trim()
      .replace(/^["'`“”]+|["'`“”]+$/g, "")
      .replace(/\s*(?:的)?\s*(?:所有|全部)?\s*(?:文档|页面|资料|文件|wiki).*$/i, "")
      .trim()
    if (keyword) return keyword
  }

  return null
}

async function findWikiPagesByTitleKeyword(projectPath: string, keyword: string): Promise<ChatDeleteItem[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(`${pp}/wiki`) as FileNode[]
  const mdFiles = flattenMarkdownFiles(tree)
  const needle = keyword.toLowerCase()
  const matches: ChatDeleteItem[] = []

  for (const file of mdFiles) {
    if (file.name === "index.md" || file.name === "log.md") continue
    try {
      const content = await readFile(file.path)
      const title = extractPageTitle(file.name, content)
      if (title.toLowerCase().includes(needle) || file.name.toLowerCase().includes(needle)) {
        matches.push({ name: title, path: file.path })
      }
    } catch {
      const fallbackTitle = file.name.replace(/\.md$/i, "").replace(/-/g, " ")
      if (fallbackTitle.toLowerCase().includes(needle) || file.name.toLowerCase().includes(needle)) {
        matches.push({ name: fallbackTitle, path: file.path })
      }
    }
  }

  return matches.sort((a, b) => a.name.localeCompare(b.name))
}

function formatDeletePreview(items: ChatDeleteItem[]): string {
  return items
    .slice(0, 20)
    .map((item) => `- ${item.name}`)
    .join("\n")
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function ConversationSidebar() {
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  return (
    <div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => createConversation()}
        >
          <Plus className="h-3.5 w-3.5" />
          New Chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            No conversations yet
          </p>
        ) : (
          sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const msgCount = getMessageCount(conv.id)
            return (
              <div
                key={conv.id}
                className={`group relative mx-1 my-0.5 flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => setActiveConversation(conv.id)}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">
                    {conv.title}
                  </span>
                  {hoveredId === conv.id && (
                    <button
                      className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                        // Delete persisted chat file
                        const proj = useWikiStore.getState().project
                        if (proj) {
                          deleteFile(`${proj.path}/.llm-wiki/chats/${conv.id}.json`).catch(() => {})
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>{formatDate(conv.updatedAt)}</span>
                  {msgCount > 0 && (
                    <>
                      <span>·</span>
                      <span>{msgCount} msgs</span>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function ChatPanel() {
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // State for chat-triggered page deletions (supports batch)
  const [pendingChatDeletes, setPendingChatDeletes] = useState<ChatDeleteItem[]>([])

  const handleChatDeleteConfirm = useCallback(async () => {
    if (pendingChatDeletes.length === 0 || !project) return
    const pp = normalizePath(project.path)
    let deletedCount = 0
    const failed: ChatDeleteItem[] = []
    for (const item of pendingChatDeletes) {
      try {
        await cascadeDeleteWikiPage(pp, item.path)
        deletedCount += 1
      } catch (err) {
        failed.push(item)
        console.error('[ChatPanel] Chat delete failed:', item.path, err)
      }
    }
    try {
      const tree = await listDirectory(pp) as FileNode[]
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      useWikiStore.getState().setSelectedFile(null)
    } catch {}
    addMessage(
      "assistant",
      failed.length === 0
        ? `Deleted ${deletedCount} wiki page(s).`
        : `Deleted ${deletedCount} wiki page(s). Failed to delete ${failed.length}: ${failed.map((item) => item.name).join(", ")}`,
    )
    setPendingChatDeletes([])
  }, [addMessage, pendingChatDeletes, project])

  const handleAssistantActions = useCallback(async (content: string) => {
    if (!project) return
    const pp = normalizePath(project.path)

    const deleteTagRe = /<!-- action:delete\s+page="([^"]+)"\s+path="([^"]+)"\s*-->/g
    const deleteItems: ChatDeleteItem[] = []
    for (const m of content.matchAll(deleteTagRe)) {
      deleteItems.push({ name: m[1], path: `${pp}/${m[2]}` })
    }
    if (deleteItems.length > 0) {
      setPendingChatDeletes(deleteItems)
    }

    const fileBlockMatch = content.match(/---FILE:\s*(.+?)\s*---\n([\s\S]*?)---END FILE---/)
    if (fileBlockMatch) {
      const relPath = fileBlockMatch[1].trim()
      let fileContent = fileBlockMatch[2]
      if (!fileContent.includes("ingested_by:")) {
        fileContent = fileContent.replace("---\n\n", `ingested_at: "${new Date().toISOString()}"\ningested_by: "chat"\n---\n\n`)
      }
      try {
        await writeFile(`${pp}/${relPath}`, fileContent)
        const tree = await listDirectory(pp) as FileNode[]
        useWikiStore.getState().setFileTree(tree)
        useWikiStore.getState().bumpDataVersion()
      } catch (err) {
        console.error("[ChatPanel] Create page from chat failed:", err)
      }
    }
  }, [project])

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [activeMessages, streamingContent])

  const handleSend = useCallback(
    async (text: string) => {
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      addMessage("user", text)

      const bulkDeleteKeyword = parseBulkTitleDeleteKeyword(text)
      if (bulkDeleteKeyword && project) {
        try {
          const matches = await findWikiPagesByTitleKeyword(project.path, bulkDeleteKeyword)
          if (matches.length === 0) {
            addMessage(
              "assistant",
              `No wiki pages have a title containing "${bulkDeleteKeyword}". Nothing was deleted.`,
            )
            return
          }

          setPendingChatDeletes(matches)
          const overflow = matches.length > 20 ? `\n\n...and ${matches.length - 20} more.` : ""
          addMessage(
            "assistant",
            [
              `Found ${matches.length} wiki page(s) with titles or filenames containing "${bulkDeleteKeyword}".`,
              "",
              formatDeletePreview(matches) + overflow,
              "",
              "Use the confirmation dialog to delete them. This will remove the page files and their vector index entries.",
            ].join("\n"),
          )
          return
        } catch (err) {
          addMessage(
            "assistant",
            `I could not scan wiki page titles for "${bulkDeleteKeyword}": ${err instanceof Error ? err.message : String(err)}`,
          )
          return
        }
      }

      setStreaming(true)

      const greetingOnly = isGreeting(text)
      if (project && !greetingOnly && mode === "chat") {
        const pp = normalizePath(project.path)
        const controller = new AbortController()
        abortRef.current = controller

        let accumulated = ""
        let queryRefs: MessageReference[] = []
        lastQueryPages = []

        const backendMessages = chatMessagesToLLM(
          useChatStore.getState().getActiveMessages()
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-maxHistoryMessages)
        )

        await streamBackendProjectChat(
          pp,
          backendMessages,
          {
            maxHistoryMessages,
            model: llmConfig.model,
            temperature: 0.2,
            maxTokens: 1600,
            topK: 8,
          },
          {
            onMeta: (meta) => {
              queryRefs = backendSourcesToReferences(meta.sources)
              lastQueryPages = queryRefs
              console.log(`[Chat] backend stream retrieval: ${meta.retrieval_ms ?? 0}ms, sources=${queryRefs.length}`)
            },
            onToken: (token) => {
              accumulated += token
              appendStreamToken(token)
            },
            onDone: () => {
              finalizeStream(accumulated, queryRefs.length > 0 ? queryRefs : undefined)
              abortRef.current = null
              void handleAssistantActions(accumulated)
            },
            onError: (err) => {
              finalizeStream(`Error: ${err.message}`, undefined)
              abortRef.current = null
            },
          },
          controller.signal,
        )
        return
      }

      // Build system prompt with wiki context using graph-enhanced retrieval
      const systemMessages: LLMMessage[] = []
      let queryRefs: { title: string; path: string }[] = []
      let langReminder: string | undefined
      // Pure greetings ("hi", "你好", "嗨") don't warrant running the whole
      // retrieval pipeline — it's slow, costs context, and drags in random
      // wiki pages the user clearly didn't ask about. Short-circuit with a
      // minimal system prompt and let the model reply conversationally.
      if (project && greetingOnly) {
        const outLang = getOutputLanguage(text)
        systemMessages.push({
          role: "system",
          content: [
            `You are a wiki assistant for the project "${project.name}".`,
            "The user sent a casual greeting — reply briefly and naturally, in one or two sentences.",
            "Do NOT invent wiki content or pretend to have retrieved pages. Invite the user to ask a concrete question if they want information from the wiki.",
            "",
            `Respond in ${outLang}.`,
          ].join("\n"),
        })
        // Skip retrieval; queryRefs stays empty so no "Sources" chip is shown.
      } else if (project) {
        const pp = normalizePath(project.path)
        const dataVersion = useWikiStore.getState().dataVersion

        // ── Budget allocation (see context-budget.ts) ─────────
        // Page budget scales with the LLM's context window; we now
        // also reserve ~15% as headroom for the response so the
        // model isn't truncated mid-sentence on a packed prompt.
        const {
          indexBudget: INDEX_BUDGET,
          pageBudget: PAGE_BUDGET,
          maxPageSize: MAX_PAGE_SIZE,
        } = computeContextBudget(llmConfig.maxContextSize)

        const [rawIndex, purpose] = await Promise.all([
          readFile(`${pp}/wiki/index.md`).catch(() => ""),
          readFile(`${pp}/purpose.md`).catch(() => ""),
        ])

        // ── Retrieval: try backend /api/rag/retrieve first ─────────
        // Large projects (>100 wiki files): backend-only, NO frontend fallback.
        // Small projects (<= 100 files): fallback to legacy searchWiki() if
        //   the backend is unavailable or returns no chunks.
        let usedBackendRetrieval = false
        let ragChunks: Array<{ page_path: string; page_title: string; chunk_text: string; heading_path: string; score: number; source: string }> = []
        let retrievalMs = 0
        let backendReturnedEmpty = false

        // Backend retrieval is mandatory for chat. The legacy browser-side
        // fallback can scan many markdown files and rebuild graph state.
        const isLargeProject = true

        try {
          const ragRes = await fetch('/api/rag/retrieve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: pp, query: text, top_k: 6 }),
            signal: AbortSignal.timeout(15000),
          })
          if (ragRes.ok) {
            const ragData = await ragRes.json()
            retrievalMs = ragData.retrieval_ms ?? 0
            if (Array.isArray(ragData.chunks) && ragData.chunks.length > 0) {
              ragChunks = ragData.chunks
              usedBackendRetrieval = true
              console.log(`[RAG] backend retrieve: ${ragChunks.length} chunks in ${retrievalMs}ms`)
            } else {
              backendReturnedEmpty = true
              console.warn('[RAG] backend returned 0 chunks')
            }
          } else {
            console.warn(`[RAG] backend returned HTTP ${ragRes.status}`)
          }
        } catch (err) {
          console.warn('[RAG] backend unavailable:', err)
        }

        // ── Large project guard: block frontend file scanning ────────
        // If backend failed and project is large, abort with a clear message
        // instead of triggering a multi-minute browser file scan.
        if (isLargeProject && !usedBackendRetrieval) {
          let reason = "后端检索服务不可用"
          if (backendReturnedEmpty) {
            // Try to get index status
            try {
              const statusRes = await fetch(`/api/rag/status?project_path=${encodeURIComponent(pp)}`)
              if (statusRes.ok) {
                const status = await statusRes.json()
                if (!status.indexed || status.chunk_count === 0) {
                  reason = `向量索引为空（0 chunks）。请前往 Settings → Embedding → Re-index All 重建索引`
                } else if (status.needs_reindex) {
                  reason = `索引需要重建（${status.reason ?? 'schema mismatch'}）。请前往 Settings → Embedding → Re-index All`
                } else {
                  reason = `未检索到相关内容（索引共 ${status.chunk_count} chunks，dim=${status.dim}）`
                }
              }
            } catch { /* /api/rag/status not yet deployed, use generic message */ }
          }
          setStreaming(false)
          addMessage("assistant",
            `⚠️ **后端检索不可用**（已阻止前端全量扫描）\n\n` +
            `原因：${reason}\n\n` +
            `请确认后端服务（8081）正常运行并完成索引重建后重试。`
          )
          return
        }

        let topSearchResults: Awaited<ReturnType<typeof searchWiki>> = []
        const graphExpansions: { title: string; path: string; relevance: number }[] = []

        if (!usedBackendRetrieval) {
          // ── Small project fallback: legacy frontend token+vector search ──
          const searchResults = await searchWiki(pp, text)
          topSearchResults = searchResults.slice(0, 10)

          // Graph expansion — only in fallback mode to avoid double latency
          const graph = await buildRetrievalGraph(pp, dataVersion)
          const expandedIds = new Set<string>()
          const searchHitPaths = new Set(topSearchResults.map((r) => r.path))

          for (const result of topSearchResults) {
            const fileName = getFileName(result.path)
            const nodeId = fileName.replace(/\.md$/, '')
            const related = getRelatedNodes(nodeId, graph, 3)
            for (const { node, relevance } of related) {
              if (relevance < 2.0) continue
              if (searchHitPaths.has(node.path)) continue
              if (expandedIds.has(node.id)) continue
              expandedIds.add(node.id)
              graphExpansions.push({ title: node.title, path: node.path, relevance })
            }
          }
          graphExpansions.sort((a, b) => b.relevance - a.relevance)
        }

        // ── Context assembly ─────────────────────────────────────
        let usedChars = 0
        type PageEntry = { title: string; path: string; content: string; priority: number }
        const relevantPages: PageEntry[] = []

        // Trim index by relevance if over budget (shared by both paths)
        let index = rawIndex
        if (rawIndex.length > INDEX_BUDGET) {
          const { tokenizeQuery } = await import("@/lib/search")
          const tokens = tokenizeQuery(text)
          const lines = rawIndex.split("\n")
          const keptLines: string[] = []
          let keptSize = 0
          for (const line of lines) {
            const isHeader = line.startsWith("##")
            const isRelevant = tokens.some((t) => line.toLowerCase().includes(t))
            if ((isHeader || isRelevant) && keptSize + line.length + 1 <= INDEX_BUDGET) {
              keptLines.push(line)
              keptSize += line.length + 1
            }
          }
          index = keptLines.join("\n")
          if (index.length < rawIndex.length) index += "\n\n[...index trimmed to relevant entries...]"
        }

        if (usedBackendRetrieval) {
          // ── Backend RAG path: use chunks directly, no file reads ──
          // Deduplicate by page, group chunks per page, respect PAGE_BUDGET
          const seenPages = new Map<string, { title: string; chunks: string[] }>()
          for (const chunk of ragChunks) {
            const key = chunk.page_path
            if (!seenPages.has(key)) seenPages.set(key, { title: chunk.page_title || key, chunks: [] })
            seenPages.get(key)!.chunks.push(
              chunk.heading_path ? `**${chunk.heading_path}**\n${chunk.chunk_text}` : chunk.chunk_text
            )
          }
          let priority = 0
          for (const [pagePath, { title, chunks }] of seenPages) {
            const content = chunks.join("\n\n")
            const relativePath = getRelativePath(`${pp}/${pagePath}`, pp)
            if (usedChars + content.length > PAGE_BUDGET) break
            usedChars += content.length
            relevantPages.push({ title, path: relativePath, content, priority: priority++ })
          }
          // Fallback if chunks gave nothing
          if (relevantPages.length === 0) {
            const overview = await readFile(`${pp}/wiki/overview.md`).catch(() => "")
            if (overview) relevantPages.push({ title: "Overview", path: "wiki/overview.md", content: overview.slice(0, MAX_PAGE_SIZE), priority: 99 })
          }
        } else {
          // ── Legacy fallback: read full pages from disk ────────────
          const tryAddPage = async (title: string, filePath: string, priority: number): Promise<boolean> => {
            if (usedChars >= PAGE_BUDGET) return false
            try {
              const raw = await readFile(filePath)
              const relativePath = getRelativePath(filePath, pp)
              const truncated = raw.length > MAX_PAGE_SIZE ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]" : raw
              if (usedChars + truncated.length > PAGE_BUDGET) return false
              usedChars += truncated.length
              relevantPages.push({ title, path: relativePath, content: truncated, priority })
              return true
            } catch { return false }
          }
          for (const r of topSearchResults.filter((r) => r.titleMatch)) await tryAddPage(r.title, r.path, 0)
          for (const r of topSearchResults.filter((r) => !r.titleMatch)) await tryAddPage(r.title, r.path, 1)
          for (const exp of graphExpansions) await tryAddPage(exp.title, exp.path, 2)
          if (relevantPages.length === 0) await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
        }

        const pagesContext = relevantPages.length > 0
          ? relevantPages.map((p, i) =>
              `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
            ).join("\n\n---\n\n")
          : "(No wiki pages found)"

        const pageList = relevantPages.map((p, i) =>
          `[${i + 1}] ${p.title} (${p.path})`
        ).join("\n")

        const outLang = getOutputLanguage(text)

        systemMessages.push({
          role: "system",
          content: [
            "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
            "",
            "## Rules",
            "- Answer based ONLY on the numbered wiki pages provided below.",
            "- If the provided pages don't contain enough information, say so honestly.",
            "- Use [[wikilink]] syntax to reference wiki pages.",
            "- When citing information, use the page number in brackets, e.g. [1], [2].",
            "- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
            "  <!-- cited: 1, 3, 5 -->",
            "",
            "Use markdown formatting for clarity.",
            "",
            "",
            "## Wiki Management Actions",
            "If the user explicitly asks to DELETE a wiki page, output this action tag at the end of your reply:",
            "  <!-- action:delete page=\"page-name\" path=\"wiki/entities/page-name.md\" -->",
            "Always warn the user about consequences BEFORE outputting the action tag.",
            "",
            "If the user asks to CREATE a new wiki page, output a FILE block:",
            '  ---FILE: wiki/entities/<name>.md---',
            '  (YAML frontmatter + markdown content)',
            '  ---END FILE---',
            "",
            purpose ? `## Wiki Purpose\n${purpose}` : "",
            index ? `## Wiki Index\n${index}` : "",
            relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
            `## Wiki Pages\n\n${pagesContext}`,
            "",
            "---",
            "",
            `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${outLang}`,
            "",
            `You MUST write your entire response in **${outLang}**.`,
            `The wiki content above may be in a different language, but this is IRRELEVANT to your output language.`,
            `Ignore the language of the wiki content. Write in ${outLang} only.`,
            `Even proper nouns should use standard ${outLang} transliteration when appropriate.`,
            `DO NOT use any other language. This overrides all other instructions.`,
          ].filter(Boolean).join("\n"),
        })

        // Reminder injected later, right before the user's current message
        langReminder = buildLanguageReminder(text)

        lastQueryPages = relevantPages.map((p) => ({ title: p.title, path: p.path }))
        queryRefs = [...lastQueryPages]
      }

      // ── Conversation history with count limit ────────────────
      // Only include messages from the active conversation, last N messages
      const activeConvMessages = useChatStore.getState().getActiveMessages()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-maxHistoryMessages)

      // Prepend the language reminder onto the final user turn rather than
      // inserting a second {role:"system"} between history and the final
      // user message. vLLM / llama.cpp / Ollama drive their chat templates
      // from HF Jinja, and Qwen3-family templates enforce "system only at
      // index 0" — a mid-conversation system message gets rejected with
      // "System message must be at the beginning." (HTTP 400). OpenAI and
      // Anthropic are more lenient, but keeping a single system at the top
      // is the safest shape across every OpenAI-compatible backend.
      const historyMessages = chatMessagesToLLM(activeConvMessages)
      let llmMessages: LLMMessage[] = [...systemMessages, ...historyMessages]
      if (langReminder && historyMessages.length > 0) {
        const lastIdx = llmMessages.length - 1
        const last = llmMessages[lastIdx]
        if (last && last.role === "user") {
          llmMessages = [
            ...llmMessages.slice(0, lastIdx),
            { role: "user", content: `[${langReminder}]\n\n${last.content}` },
          ]
        }
      }

      const controller = new AbortController()
      abortRef.current = controller

      let accumulated = ""

      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            accumulated += token
            appendStreamToken(token)
          },
          onDone: async () => {
            finalizeStream(accumulated, queryRefs)
            abortRef.current = null
            await handleAssistantActions(accumulated)
          },
          onError: (err) => {
            finalizeStream(`Error: ${err.message}`, undefined)
            abortRef.current = null
          },
        },
        controller.signal,
        { temperature: 0.2, max_tokens: 1600 },
      )
    },
    [llmConfig, addMessage, setStreaming, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages, project, mode, handleAssistantActions],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return
    // Find the last user message in active conversation
    const active = useChatStore.getState().getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Small delay to let state update
    await new Promise((r) => setTimeout(r, 50))
    // Trigger send with the same text (handleSend will add a new user message,
    // so also remove the original to avoid duplication)
    // Actually: just call handleSend — but it adds a user message. To avoid dupe,
    // we remove the last user message too and let handleSend re-add it.
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    if (lastUser) {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== lastUser.id),
      }))
    }
    handleSend(lastUserMsg.content)
  }, [isStreaming, removeLastAssistantMessage, handleSend])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      try {
        const tree = await listDirectory(pp) as FileNode[]
        setFileTree(tree)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig, setFileTree])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-row overflow-hidden">
      <ConversationSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {!activeConversationId ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">Start a new conversation</p>
              <p className="mt-1 text-xs opacity-60">Click "New Chat" to begin</p>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-3 py-2"
            >
              <div className="flex flex-col gap-3">
                {activeMessages.map((msg, idx) => {
                  // Check if this is the last assistant message
                  const isLastAssistant = msg.role === "assistant" &&
                    !activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
                  return (
                    <ChatMessage
                      key={msg.id}
                      message={msg}
                      isLastAssistant={isLastAssistant && !isStreaming}
                      onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                    />
                  )
                })}
                {isStreaming && <StreamingMessage content={streamingContent} />}
                <div ref={bottomRef} />
              </div>
            </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4" />
                  Write to Wiki
                </Button>
              </div>
            )}
          </>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          placeholder={
            mode === "ingest"
              ? "Discuss the source or ask follow-up questions..."
              : "Type a message..."
          }
        />
      </div>

      {/* Batch delete confirmation dialog for chat-triggered deletions */}
      <ConfirmDialog
        open={pendingChatDeletes.length > 0}
        title={pendingChatDeletes.length === 1 ? "Confirm page deletion?" : `Confirm deleting ${pendingChatDeletes.length} pages?`}
        description={
          pendingChatDeletes.length === 1
            ? `This will permanently delete "${pendingChatDeletes[0]?.name}", including its vector index entry. This cannot be undone.`
            : `This will permanently delete these ${pendingChatDeletes.length} pages, including their vector index entries:\n${pendingChatDeletes.map(d => `- ${d.name}`).join('\n')}`
        }
        confirmLabel={pendingChatDeletes.length === 1 ? "Delete page" : `Delete ${pendingChatDeletes.length} pages`}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={handleChatDeleteConfirm}
        onCancel={() => setPendingChatDeletes([])}
      />
    </div>
  )
}

