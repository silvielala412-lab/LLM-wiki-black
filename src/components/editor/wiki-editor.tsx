import { useEffect, useMemo, useRef, useState } from "react"
import { Code2, Eye, Plus, Trash2 } from "lucide-react"
import "katex/dist/katex.min.css"

interface WikiEditorProps {
  content: string
  onSave: (markdown: string) => void
}

type EditableBlock =
  | { id: string; type: "heading"; level: number; text: string }
  | { id: string; type: "table"; rows: string[][] }
  | { id: string; type: "text"; text: string }

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(?:\r?\n)?/)
  if (!match) return { frontmatter: "", body: content }
  return {
    frontmatter: match[1],
    body: content.slice(match[0].length),
  }
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) backslashes++
  return backslashes % 2 === 1
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null

  const cells: string[] = []
  let current = ""
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i]
    if (ch === "|" && !isEscapedAt(trimmed, i)) {
      cells.push(current.trim().replace(/\\\|/g, "|"))
      current = ""
    } else {
      current += ch
    }
  }
  cells.push(current.trim().replace(/\\\|/g, "|"))
  return cells
}

function isTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line)
  return !!cells && cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
}

function tableCell(value: string): string {
  return value.replace(/\n/g, "<br>").replace(/\|/g, "\\|")
}

function tableRow(cells: string[]): string {
  return `| ${cells.map(tableCell).join(" | ")} |`
}

function parseBlocks(body: string): EditableBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n")
  const blocks: EditableBlock[] = []
  let i = 0

  const pushText = (textLines: string[]) => {
    const text = textLines.join("\n").trim()
    if (!text) return
    blocks.push({ id: `b${blocks.length}`, type: "text", text })
  }

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++
      continue
    }

    const heading = lines[i].match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({
        id: `b${blocks.length}`,
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      })
      i++
      continue
    }

    const row = splitMarkdownTableRow(lines[i])
    if (row && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [row]
      i += 2
      while (i < lines.length) {
        const nextRow = splitMarkdownTableRow(lines[i])
        if (!nextRow) break
        rows.push(nextRow)
        i++
      }
      blocks.push({ id: `b${blocks.length}`, type: "table", rows })
      continue
    }

    const textLines: string[] = []
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) break
      if (/^#{1,6}\s+/.test(line)) break
      if (splitMarkdownTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break
      textLines.push(line)
      i++
    }
    pushText(textLines)
  }

  return blocks.length > 0 ? blocks : [{ id: "b0", type: "text", text: "" }]
}

function blocksToMarkdown(blocks: EditableBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "heading") {
        return `${"#".repeat(Math.max(1, Math.min(6, block.level)))} ${block.text.trim()}`
      }
      if (block.type === "table") {
        const rows = block.rows.length > 0 ? block.rows : [["", ""]]
        const width = Math.max(...rows.map(row => row.length), 1)
        const normalizedRows = rows.map(row => {
          const next = [...row]
          while (next.length < width) next.push("")
          return next
        })
        const separator = Array.from({ length: width }, () => "---")
        return [tableRow(normalizedRows[0]), tableRow(separator), ...normalizedRows.slice(1).map(tableRow)].join("\n")
      }
      return block.text.trim()
    })
    .filter(Boolean)
    .join("\n\n")
}

function combineMarkdown(frontmatter: string, body: string): string {
  const cleanBody = body.trimEnd()
  if (!frontmatter) return `${cleanBody}\n`
  return `${frontmatter.trimEnd()}\n\n${cleanBody}\n`
}

function resizeRows(value: string): number {
  return Math.min(10, Math.max(1, value.split("\n").length))
}

export function WikiEditor({ content, onSave }: WikiEditorProps) {
  const [mode, setMode] = useState<"visual" | "source">("visual")
  const [draft, setDraftState] = useState(content)
  const draftRef = useRef(content)

  const setDraft = (next: string) => {
    draftRef.current = next
    setDraftState(next)
  }

  const parsed = useMemo(() => splitFrontmatter(draft), [draft])
  const [blocks, setBlocks] = useState<EditableBlock[]>(() => parseBlocks(parsed.body))

  useEffect(() => {
    if (content === draftRef.current) return
    setDraft(content)
    const next = splitFrontmatter(content)
    setBlocks(parseBlocks(next.body))
  }, [content])

  const saveBlocks = (nextBlocks: EditableBlock[]) => {
    setBlocks(nextBlocks)
    const nextMarkdown = combineMarkdown(parsed.frontmatter, blocksToMarkdown(nextBlocks))
    setDraft(nextMarkdown)
    onSave(nextMarkdown)
  }

  const updateBlock = (index: number, updater: (block: EditableBlock) => EditableBlock) => {
    saveBlocks(blocks.map((block, i) => (i === index ? updater(block) : block)))
  }

  const removeBlock = (index: number) => {
    const next = blocks.filter((_, i) => i !== index)
    saveBlocks(next.length > 0 ? next : [{ id: "b0", type: "text", text: "" }])
  }

  const addTextBlock = () => {
    saveBlocks([...blocks, { id: `b${Date.now()}`, type: "text", text: "" }])
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
        <span>{mode === "visual" ? "可视化编辑，元数据会自动保留。" : "Markdown 源码编辑，适合高级修正。"}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode("visual")}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 ${mode === "visual" ? "bg-accent text-foreground" : "hover:bg-accent"}`}
          >
            <Eye className="h-3.5 w-3.5" /> 可视化
          </button>
          <button
            type="button"
            onClick={() => setMode("source")}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 ${mode === "source" ? "bg-accent text-foreground" : "hover:bg-accent"}`}
          >
            <Code2 className="h-3.5 w-3.5" /> 源码
          </button>
        </div>
      </div>

      {mode === "source" ? (
        <textarea
          value={draft}
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            setBlocks(parseBlocks(splitFrontmatter(next).body))
            onSave(next)
          }}
          spellCheck={false}
          className="h-full min-h-0 w-full flex-1 resize-none bg-background p-4 font-mono text-sm leading-6 text-foreground outline-none"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-[#fafafa] p-4">
          <div className="mx-auto max-w-4xl space-y-3">
            {parsed.frontmatter && (
              <div className="rounded border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
                页面元数据已隐藏并保留，编辑正文不会破坏 title、status、sources 等字段。
              </div>
            )}

            {blocks.map((block, index) => (
              <div key={block.id} className="group rounded border bg-background p-3 shadow-sm">
                <div className="mb-2 flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => removeBlock(index)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 删除块
                  </button>
                </div>

                {block.type === "heading" && (
                  <input
                    value={block.text}
                    onChange={(event) => updateBlock(index, current => ({ ...current, text: event.target.value } as EditableBlock))}
                    className="w-full border-0 bg-transparent text-xl font-bold outline-none"
                  />
                )}

                {block.type === "text" && (
                  <textarea
                    value={block.text}
                    rows={resizeRows(block.text)}
                    onChange={(event) => updateBlock(index, current => ({ ...current, text: event.target.value } as EditableBlock))}
                    className="w-full resize-y rounded border bg-background p-2 text-sm leading-6 outline-none focus:border-primary"
                  />
                )}

                {block.type === "table" && (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-sm">
                      <tbody>
                        {block.rows.map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                              <td key={cellIndex} className={`border p-1 align-top ${rowIndex === 0 ? "bg-muted font-medium" : ""}`}>
                                <textarea
                                  value={cell}
                                  rows={resizeRows(cell)}
                                  onChange={(event) => updateBlock(index, current => {
                                    if (current.type !== "table") return current
                                    const rows = current.rows.map((r, rIndex) =>
                                      rIndex === rowIndex ? r.map((c, cIndex) => (cIndex === cellIndex ? event.target.value : c)) : r
                                    )
                                    return { ...current, rows }
                                  })}
                                  className="min-w-28 w-full resize-y border-0 bg-transparent p-1 outline-none"
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={addTextBlock}
              className="inline-flex items-center gap-1 rounded border bg-background px-3 py-2 text-sm hover:bg-accent"
            >
              <Plus className="h-4 w-4" /> 添加文本块
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
