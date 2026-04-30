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
import { Pencil } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

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
}

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = {
    title: "", type: "default", tags: [], related: [], sources: [],
    created: "", updated: "",
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m)
  if (!match) return { fm: { ...fm, title: "Untitled" }, body: content }

  const yamlStr = match[1]
  const body = match[2] ?? ""

  // Simple line-by-line YAML parser (covers list + scalar)
  let currentKey = ""
  for (const line of yamlStr.split(/\r?\n/)) {
    const scalarM = line.match(/^(\w+):\s*"?([^"#\r\n]*)"?\s*$/)
    const listStartM = line.match(/^(\w+):\s*\[(.*)]\s*$/)
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

export function WikiPageViewer({ filePath, content, onEditRequest }: WikiPageViewerProps) {
  const projectPath = useWikiStore(s => s.project?.path ?? null)
  const fileTree = useWikiStore(s => s.fileTree)
  const setSelectedFile = useWikiStore(s => s.setSelectedFile)

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

  const openRelated = useCallback((path: string) => {
    setSelectedFile(path)
  }, [setSelectedFile])

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

        {/* ── Top bar: Edit button ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
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
        </div>

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
              {fm.tags.slice(0, 3).map(tag => (
                <TagBadge key={tag}>{tag}</TagBadge>
              ))}
            </div>
            {(fm.created || fm.updated || filePath) && (
              <div style={{ fontSize: 11, color: "#8B92A0" }}>
                {fm.created && <>创建: {fm.created}</>}
                {fm.updated && fm.updated !== fm.created && <>　更新: {fm.updated}</>}
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
