/**
 * WikiPageViewer — Rich card-style renderer for wiki/*.md files.
 *
 * Parses YAML frontmatter (title, type, tags, sources, related) and
 * the markdown body sections, then renders them in the reference
 * design: colored section bars, badge tags, wikilink card grid,
 * source file chips, and a fade-in animation.
 *
 * Activated for any file under wiki/ — raw sources use FilePreview.
 */

import { useMemo, useState, useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { Pencil, Trash2, Plus } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { cascadeDeleteWikiPage } from "@/lib/wiki-page-delete"
import { listDirectory, writeFile } from "@/commands/fs"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { StatusBadge } from "@/components/review/status-badge"
import { setPageStatus, parseStatusFromContent } from "@/lib/knowledge-governance"
import type { KnowledgeStatus } from "@/lib/knowledge-governance"

// ── Type icons & colours ─────────────────────────────────────────────────────

const TYPE_META: Record<string, { icon: string; color: string; bg: string }> = {
  concept: { icon: "💡", color: "#7C3AED", bg: "#F0E8FD" },
  entity:  { icon: "💎", color: "#0891B2", bg: "#E4F7FA" },
  source:  { icon: "📄", color: "#0DAB5C", bg: "#E6F9EF" },
  query:   { icon: "🔍", color: "#E67E22", bg: "#FDF4E8" },
  default: { icon: "📖", color: "#2B5CE6", bg: "#EBF0FD" },
}

// ── Frontmatter parser ───────────────────────────────────────────────────────

interface Frontmatter {
  title: string
  type: string
  tags: string[]
  related: string[]
  sources: string[]
  created: string
  updated: string
  ingested_at: string
  ingested_by: string
  ingested_by_user: string
  status: string
}


function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = {
    title: "", type: "default", tags: [], related: [], sources: [],
    created: "", updated: "", ingested_at: "", ingested_by: "", ingested_by_user: "", status: "",
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m)
  if (!match) return { fm: { ...fm, title: "Untitled" }, body: content }

  const yamlStr = match[1]
  const body = match[2] ?? ""

  const asList = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.map(String).map(s => s.trim()).filter(Boolean)
    }
    if (typeof value !== "string") return []
    const trimmed = value.trim()
    if (!trimmed) return []
    const bracketed = trimmed.match(/^\[(.*)]$/)
    const raw = bracketed ? bracketed[1] : trimmed
    return raw
      .split(",")
      .map(s => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }

  // Simple line-by-line YAML parser (covers list + scalar)
  let currentKey = ""
  for (const line of yamlStr.split(/\r?\n/)) {
    const listStartM = line.match(/^(\w+):\s*\[(.*)]\s*$/)
    const scalarM = line.match(/^(\w+):\s*"?([^"#\r\n]*)"?\s*$/)
    const listItemM = line.match(/^\s*-\s+"?([^"]*)"?\s*$/)

    if (listStartM) {
      currentKey = listStartM[1]
      const items = listStartM[2].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
      ;(fm as Record<string, unknown>)[currentKey] = items
    } else if (scalarM) {
      currentKey = scalarM[1]
      ;(fm as Record<string, unknown>)[scalarM[1]] = scalarM[2].trim()
    } else if (listItemM && currentKey) {
      const arr = (fm as Record<string, unknown>)[currentKey]
      if (Array.isArray(arr)) arr.push(listItemM[1].trim())
    }
  }

  // Derive title from body H1 if not in frontmatter
  if (!fm.title) {
    const h1 = body.match(/^#\s+(.+)$/m)
    fm.title = h1 ? h1[1].trim() : "Untitled"
  }
  fm.tags = asList(fm.tags)
  fm.related = asList(fm.related)
  fm.sources = asList(fm.sources)

  return { fm, body }
}

// ── Section splitter ─────────────────────────────────────────────────────────

interface Section {
  heading: string   // "" for content before first heading
  level: number
  content: string
}

function splitSections(body: string): Section[] {
  const lines = body.split(/\r?\n/)
  const sections: Section[] = []
  let current: Section = { heading: "", level: 0, content: "" }

  for (const line of lines) {
    const hm = line.match(/^(#{1,3})\s+(.+)$/)
    if (hm) {
      if (current.content.trim() || current.heading) sections.push(current)
      current = { heading: hm[2].trim(), level: hm[1].length, content: "" }
    } else {
      current.content += line + "\n"
    }
  }
  if (current.content.trim() || current.heading) sections.push(current)
  return sections
}

// ── Colour helpers ────────────────────────────────────────────────────────────

const SECTION_COLORS: Record<number, string> = {
  1: "#2B5CE6",
  2: "#7C3AED",
  3: "#0891B2",
}
function sectionColor(idx: number) {
  return Object.values(SECTION_COLORS)[idx % 3]
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Badge({
  children, color, bg,
}: { children: React.ReactNode; color: string; bg: string }) {
  return (
    <span
      style={{
        background: bg,
        color,
        border: `1px solid ${color}30`,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 600,
        display: "inline-block",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  )
}

function TagBadge({ tag }: { tag: string }) {
  return <Badge color="#7C3AED" bg="#F0E8FD">{tag}</Badge>
}

function SourceChip({ src }: { src: string }) {
  const ext = src.split(".").pop()?.toUpperCase() ?? "FILE"
  const extColors: Record<string, { color: string; bg: string }> = {
    XLSX: { color: "#0DAB5C", bg: "#E6F9EF" },
    XLS:  { color: "#0DAB5C", bg: "#E6F9EF" },
    DOCX: { color: "#2B5CE6", bg: "#EBF0FD" },
    DOC:  { color: "#2B5CE6", bg: "#EBF0FD" },
    PDF:  { color: "#E53935", bg: "#FDECEB" },
    PPTX: { color: "#E67E22", bg: "#FDF4E8" },
    MD:   { color: "#8B92A0", bg: "#F5F6F8" },
  }
  const { color, bg } = extColors[ext] ?? { color: "#8B92A0", bg: "#F5F6F8" }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: "var(--card, #fff)",
        border: "1px solid #E2E5EA",
        borderRadius: 8,
        marginBottom: 6,
      }}
    >
      <div
        style={{
          width: 32, height: 32, borderRadius: 6,
          background: bg, color, display: "flex",
          alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 700, flexShrink: 0,
        }}
      >
        {ext}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "#15181E" }} className="truncate">{src}</div>
        <div style={{ fontSize: 10, color: "#8B92A0", marginTop: 1 }}>引用来源</div>
      </div>
      <Badge color={color} bg={bg}>来源</Badge>
    </div>
  )
}

function WikiLinkCard({
  name, onClick, exists,
}: { name: string; onClick: () => void; exists: boolean }) {
  const icons = ["💎", "📊", "👥", "🏆", "⚡", "🔗", "📌", "🗂️"]
  const icon = icons[Math.abs(name.charCodeAt(0)) % icons.length]

  if (!exists) {
    return (
      <div
        title={`「${name}」页面尚未创建，可在 Review 中使用 Deep Research 生成`}
        style={{
          background: "#FDECEB",
          border: "1px dashed #F5A3A1",
          borderRadius: 8,
          padding: "9px 11px",
          cursor: "default",
          opacity: 0.75,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#E53935" }}>🔴 {name}</div>
        <div style={{ fontSize: 10, color: "#E53935", marginTop: 2 }}>页面待创建</div>
      </div>
    )
  }

  return (
    <div
      onClick={onClick}
      style={{
        background: "#F5F6F8",
        border: "1px solid #E2E5EA",
        borderRadius: 8,
        padding: "9px 11px",
        cursor: "pointer",
        transition: "box-shadow 0.15s, border-color 0.15s",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.borderColor = "#2B5CE6"
        ;(e.currentTarget as HTMLElement).style.boxShadow = "0 2px 8px rgba(43,92,230,0.12)"
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.borderColor = "#E2E5EA"
        ;(e.currentTarget as HTMLElement).style.boxShadow = "none"
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: "#2B5CE6" }}>{icon} {name}</div>
      <div style={{ fontSize: 10, color: "#8B92A0", marginTop: 2 }}>点击跳转</div>
    </div>
  )
}

// ── Rich Markdown renderer ────────────────────────────────────────────────────

function BodyMarkdown({ content, projectPath }: { content: string; projectPath: string | null }) {
  return (
    <div className="wiki-body-md prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          img: ({ src, alt, ...props }) => (
            <img
              src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined}
              alt={alt ?? ""}
              className="max-w-full rounded border"
              loading="lazy"
              {...props}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface WikiPageViewerProps {
  filePath: string
  content: string
  onEditRequest: () => void
  onDeleteComplete?: () => void
}

/** Recursively flatten a FileNode tree into a list of file paths (forward-slash). */
function flattenTree(nodes: FileNode[]): string[] {
  const result: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      result.push(...flattenTree(node.children))
    } else if (!node.is_dir) {
      result.push(normalizePath(node.path))
    }
  }
  return result
}

/**
 * Given a related-page name from frontmatter, find the actual file path
 * in the project file tree. Returns null if not found.
 *
 * Matching strategy (case-insensitive, in order):
 *   1. Exact filename match: `<name>.md`
 *   2. Kebab-slug match: `<name-with-spaces-to-dashes>.md`
 *   3. Partial match: any wiki file whose stem contains the name
 */
function findWikiPage(name: string, allPaths: string[]): string | null {
  const wikiPaths = allPaths.filter(p => p.includes("/wiki/") && !p.includes("/wiki/media/") && p.endsWith(".md"))
  const nameLower = name.toLowerCase()
  const nameSlug = nameLower.replace(/\s+/g, "-")

  // 1. Exact stem match
  for (const p of wikiPaths) {
    const stem = p.split("/").pop()!.replace(/\.md$/, "").toLowerCase()
    if (stem === nameLower || stem === nameSlug) return p
  }

  // 2. Partial match (name is contained in stem or stem in name)
  for (const p of wikiPaths) {
    const stem = p.split("/").pop()!.replace(/\.md$/, "").toLowerCase()
    if (stem.includes(nameLower) || nameLower.includes(stem)) return p
  }

  return null
}

export function WikiPageViewer({ filePath, content, onEditRequest, onDeleteComplete }: WikiPageViewerProps) {
  const projectPath = useWikiStore(s => s.project?.path ?? null)
  const fileTree = useWikiStore(s => s.fileTree)
  const setSelectedFile = useWikiStore(s => s.setSelectedFile)
  const setFileTree = useWikiStore(s => s.setFileTree)
  const bumpDataVersion = useWikiStore(s => s.bumpDataVersion)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showCreateMenu, setShowCreateMenu] = useState(false)

  const { fm, sections } = useMemo(() => {
    const { fm, body } = parseFrontmatter(content)
    const sections = splitSections(body).filter(s => s.heading !== fm.title)
    return { fm, sections }
  }, [content])

  const typeMeta = TYPE_META[fm.type] ?? TYPE_META.default

  // Pre-compute the flat list of all wiki paths for link resolution
  const allPaths = useMemo(() => flattenTree(fileTree), [fileTree])

  // Map each related name to its resolved path (or null if not found)
  const relatedResolved = useMemo(() => {
    return fm.related.map(name => ({
      name,
      path: findWikiPage(name, allPaths),
    }))
  }, [fm.related, allPaths])

  const status: KnowledgeStatus = (parseStatusFromContent(content) as KnowledgeStatus)

  const handleMarkActive = useCallback(async () => {
    if (!projectPath) return
    try {
      await setPageStatus(filePath, "active")
      bumpDataVersion()
    } catch (err) {
      console.error("[WikiPageViewer] Failed to mark active:", err)
    }
  }, [filePath, projectPath, bumpDataVersion])

  const openRelated = useCallback((path: string) => {
    setSelectedFile(path)
  }, [setSelectedFile])

  // ── Delete handler ──
  const handleDeleteConfirm = useCallback(async () => {
    if (!projectPath) return
    setShowDeleteConfirm(false)
    try {
      await cascadeDeleteWikiPage(projectPath, filePath)
      // Refresh file tree
      const tree = await listDirectory(normalizePath(projectPath))
      setFileTree(tree)
      bumpDataVersion()
      setSelectedFile(null)
      onDeleteComplete?.()
    } catch (err) {
      console.error("[WikiPageViewer] Delete failed:", err)
    }
  }, [projectPath, filePath, setFileTree, bumpDataVersion, setSelectedFile, onDeleteComplete])

  // ── Create page handler ──
  const handleCreatePage = useCallback(async (type: "entity" | "concept") => {
    if (!projectPath) return
    setShowCreateMenu(false)
    const name = prompt(type === "entity" ? "输入实体名称:" : "输入概念名称:")
    if (!name?.trim()) return
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, "").replace(/\s+/g, "-")
    const dir = type === "entity" ? "entities" : "concepts"
    const pp = normalizePath(projectPath)
    const pagePath = `${pp}/wiki/${dir}/${slug || name.trim()}.md`
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const template = [
      "---",
      `type: ${type}`,
      `title: "${name.trim()}"`,
      `created: ${dateStr}`,
      `updated: ${dateStr}`,
      `tags: []`,
      `related: []`,
      `sources: ["手动创建"]`,
      `ingested_at: "${now.toISOString()}"`,
      `ingested_by: "manual"`,
      "---",
      "",
      `# ${name.trim()}`,
      "",
      "（在此编写内容）",
      "",
    ].join("\n")
    try {
      await writeFile(pagePath, template)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
      setSelectedFile(pagePath)
    } catch (err) {
      console.error("[WikiPageViewer] Create failed:", err)
    }
  }, [projectPath, setFileTree, bumpDataVersion, setSelectedFile])

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        fontFamily: "'Geist Variable', 'Noto Sans SC', system-ui, sans-serif",
        animation: "wiki-fadein 0.2s ease",
      }}
    >
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 36px 48px" }}>

        {/* ── Top bar: Edit / Delete / Create buttons ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          {/* Left: Create page */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowCreateMenu(!showCreateMenu)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 12px", borderRadius: 5, fontSize: 11,
                background: "#E6F9EF", border: "1px solid #0DAB5C30",
                color: "#0DAB5C", cursor: "pointer", transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#D0F4E0")}
              onMouseLeave={e => (e.currentTarget.style.background = "#E6F9EF")}
            >
              <Plus size={11} /> 新建页面
            </button>
            {showCreateMenu && (
              <div
                style={{
                  position: "absolute", top: "100%", left: 0, marginTop: 4,
                  background: "var(--popover, #fff)", border: "1px solid #E2E5EA",
                  borderRadius: 8, padding: 4, zIndex: 50, minWidth: 140,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                }}
              >
                <button
                  onClick={() => handleCreatePage("entity")}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "6px 10px", borderRadius: 5, fontSize: 11,
                    background: "transparent", border: "none", cursor: "pointer",
                    color: "#0891B2",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#E4F7FA")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  💎 新建实体
                </button>
                <button
                  onClick={() => handleCreatePage("concept")}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "6px 10px", borderRadius: 5, fontSize: 11,
                    background: "transparent", border: "none", cursor: "pointer",
                    color: "#7C3AED",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#F0E8FD")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  💡 新建概念
                </button>
              </div>
            )}
          </div>

          {/* Right: Edit + Delete */}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={onEditRequest}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 12px", borderRadius: 5, fontSize: 11,
                background: "#F5F6F8", border: "1px solid #E2E5EA",
                color: "#4A5060", cursor: "pointer", transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#EBF0FD")}
              onMouseLeave={e => (e.currentTarget.style.background = "#F5F6F8")}
            >
              <Pencil size={11} /> 编辑
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 12px", borderRadius: 5, fontSize: 11,
                background: "#FDECEB", border: "1px solid #E5393530",
                color: "#E53935", cursor: "pointer", transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FADDD9")}
              onMouseLeave={e => (e.currentTarget.style.background = "#FDECEB")}
            >
              <Trash2 size={11} /> 删除
            </button>
          </div>
        </div>

        {/* Delete confirmation dialog */}
        <ConfirmDialog
          open={showDeleteConfirm}
          title="确认删除此页面？"
          description={`将永久删除「${fm.title || "Untitled"}」（类型: ${fm.type}），包括其关联的向量索引和媒体文件。此操作不可撤销。`}
          confirmLabel="确认删除"
          cancelLabel="取消"
          variant="destructive"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteConfirm(false)}
        />

        {/* ── Page header ── */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 20 }}>
          <div
            style={{
              width: 44, height: 44, borderRadius: 10,
              background: typeMeta.bg,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, flexShrink: 0,
            }}
          >
            {typeMeta.icon}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <h1 style={{
                fontSize: 22, fontWeight: 900, color: "#15181E",
                letterSpacing: "-0.02em", margin: 0,
                borderLeft: "none", paddingLeft: 0,
              }}>
                {fm.title || "Untitled"}
              </h1>
              <Badge color={typeMeta.color} bg={typeMeta.bg}>
                {fm.type}
              </Badge>
              {/* Knowledge status badge */}
              <StatusBadge status={status} />
              {status === "candidate" && (
                <button
                  onClick={handleMarkActive}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 transition-colors dark:bg-emerald-950/40 dark:border-emerald-700 dark:text-emerald-400"
                  title="确认为有效知识"
                >
                  ✓ 标记为已确认
                </button>
              )}
              {fm.tags.slice(0, 3).map(tag => (
                <TagBadge key={tag}>{tag}</TagBadge>
              ))}
            </div>
            {(fm.created || fm.updated || filePath) && (
              <div style={{ fontSize: 11, color: "#8B92A0" }}>
                {fm.created && <>创建: {fm.created}</>}
                {fm.updated && fm.updated !== fm.created && <>　更新: {fm.updated}</>}
                {fm.ingested_at && <>　导入: {fm.ingested_at.length > 10 ? new Date(fm.ingested_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : fm.ingested_at}</>}
                {fm.ingested_by && <>　方式: {({"file-upload": "文件上传", "deep-research": "深度研究", "manual": "手动创建", "chat": "对话生成"} as Record<string, string>)[fm.ingested_by] ?? fm.ingested_by}</>}
                {fm.ingested_by_user && fm.ingested_by_user !== "unknown" && <>　<span style={{ display: "inline-flex", alignItems: "center", gap: 2, background: "#EEF2FF", color: "#4F46E5", borderRadius: 4, padding: "0 5px", fontSize: 10, fontWeight: 600 }}>👤 {fm.ingested_by_user}</span></>}
                　路径: {filePath.split(/[/\\]/).slice(-3).join(" / ")}
              </div>
            )}
          </div>
        </div>

        {/* ── AI Source banner (if has sources) ── */}
        {fm.sources.length > 0 && (
          <div
            style={{
              background: "#F0E8FD",
              border: "1px solid #D4BFFF",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 22,
              fontSize: 12,
              display: "flex", alignItems: "center", gap: 8,
            }}
          >
            <span style={{ fontSize: 16 }}>🤖</span>
            <span style={{ color: "#4A5060" }}>
              <b style={{ color: "#7C3AED" }}>AI 编译</b>
              {" — "}从 {fm.sources.map(s => `《${s}》`).join("、")} 自动抽取，关联 {fm.related.length} 个概念实体。
            </span>
          </div>
        )}

        {/* ── Body sections ── */}
        {sections.map((sec, idx) => (
          <div key={idx} style={{ marginBottom: 28 }}>
            {sec.heading && (
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    width: 4, height: 16, borderRadius: 2,
                    background: sectionColor(idx), flexShrink: 0,
                  }}
                />
                <h2
                  style={{
                    fontSize: 14, fontWeight: 700, color: "#15181E",
                    margin: 0, borderLeft: "none", paddingLeft: 0,
                  }}
                >
                  {sec.heading}
                </h2>
              </div>
            )}
            <div
              style={{
                background: "var(--card, #fff)",
                border: "1px solid #E2E5EA",
                borderRadius: 8,
                padding: "14px 18px",
              }}
            >
              <BodyMarkdown content={sec.content} projectPath={projectPath} />
            </div>
          </div>
        ))}

        {/* ── Related pages (wikilinks) ── */}
        {fm.related.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <div style={{ width: 4, height: 16, borderRadius: 2, background: "#0891B2" }} />
              <h2 style={{ fontSize: 14, fontWeight: 700, color: "#15181E", margin: 0, borderLeft: "none", paddingLeft: 0 }}>
                关联概念 (Wiki Links)
              </h2>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: 8,
              }}
            >
              {relatedResolved.map(({ name, path }) => (
                <WikiLinkCard
                  key={name}
                  name={name}
                  exists={path !== null}
                  onClick={() => path && openRelated(path)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Sources ── */}
        {fm.sources.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <div style={{ width: 4, height: 16, borderRadius: 2, background: "#E67E22" }} />
              <h2 style={{ fontSize: 14, fontWeight: 700, color: "#15181E", margin: 0, borderLeft: "none", paddingLeft: 0 }}>
                引用来源
              </h2>
            </div>
            {fm.sources.map(src => <SourceChip key={src} src={src} />)}
          </div>
        )}

        {/* ── Tags footer ── */}
        {fm.tags.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 16, borderTop: "1px solid #E2E5EA" }}>
            <span style={{ fontSize: 11, color: "#8B92A0", marginRight: 4 }}>标签:</span>
            {fm.tags.map(tag => <TagBadge key={tag}>{tag}</TagBadge>)}
          </div>
        )}

      </div>
    </div>
  )
}
