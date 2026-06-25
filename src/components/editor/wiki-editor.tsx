import { useEffect, useState } from "react"
import "katex/dist/katex.min.css"

interface WikiEditorProps {
  content: string
  onSave: (markdown: string) => void
}

export function WikiEditor({ content, onSave }: WikiEditorProps) {
  const [draft, setDraft] = useState(content)

  useEffect(() => {
    setDraft(content)
  }, [content])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b px-3 py-2 text-xs text-muted-foreground">
        原始 Markdown 编辑模式。内容会自动保存，YAML frontmatter 会按原文保留。
      </div>
      <textarea
        value={draft}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          onSave(next)
        }}
        spellCheck={false}
        className="h-full min-h-0 w-full flex-1 resize-none bg-background p-4 font-mono text-sm leading-6 text-foreground outline-none"
      />
    </div>
  )
}
