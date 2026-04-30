import { useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createProjectAuto, writeFile, createDirectory } from "@/commands/fs"
import { getTemplate } from "@/lib/templates"
import { TemplatePicker } from "@/components/project/template-picker"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { OUTPUT_LANGUAGE_OPTIONS } from "@/lib/output-language-options"
import { useWikiStore, type OutputLanguage } from "@/stores/wiki-store"
import { saveOutputLanguage } from "@/lib/project-store"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: WikiProject) => void
}

export function CreateProjectDialog({ open: isOpen, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState("general")
  const [language, setLanguage] = useState<string>("")
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)

  async function handleCreate() {
    if (!name.trim()) {
      setError("请输入项目名称")
      return
    }
    if (!language) {
      setError("请选择 AI 输出语言")
      return
    }
    setCreating(true)
    setError("")
    try {
      // Web mode: server auto-creates project under WIKI_DATA_PATH/<name>
      const project = await createProjectAuto(name.trim())
      const pp = normalizePath(project.path)

      const template = getTemplate(selectedTemplate)
      await writeFile(`${pp}/schema.md`, template.schema)
      await writeFile(`${pp}/purpose.md`, template.purpose)
      for (const dir of template.extraDirs) {
        await createDirectory(`${pp}/${dir}`)
      }

      const lang = language as OutputLanguage
      setOutputLanguage(lang)
      await saveOutputLanguage(lang)

      onCreated(project)
      onOpenChange(false)
      setName("")
      setSelectedTemplate("general")
      setLanguage("")
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>创建新 Wiki 项目</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">项目名称</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：marketing-wiki"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              项目将在服务器 <code>WIKI_DATA_PATH/{name || "项目名称"}</code> 下自动创建，无需手动指定路径。
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>模板</Label>
            <TemplatePicker selected={selectedTemplate} onSelect={setSelectedTemplate} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="language">
              AI 输出语言 <span className="text-destructive">*</span>
            </Label>
            <select
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="" disabled>选择语言…</option>
              {OUTPUT_LANGUAGE_OPTIONS.filter((l) => l.value !== "auto").map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? "创建中…" : "创建项目"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
