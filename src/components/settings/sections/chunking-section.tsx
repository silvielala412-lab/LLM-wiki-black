/**
 * chunking-section.tsx
 * Per-project knowledge chunking customization settings panel (中文版)
 * Uses only native HTML + existing button/label/input UI components
 */
import { useState } from "react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronUp, Sliders, Sparkles } from "lucide-react"
import type { ChunkingConfig } from "@/types/wiki"
import { DEFAULT_CHUNKING_CONFIG } from "@/types/wiki"

interface ChunkingSectionProps {
  config: ChunkingConfig
  onChange: (config: ChunkingConfig) => void
}

export function ChunkingSection({ config, onChange }: ChunkingSectionProps) {
  const [expanded, setExpanded] = useState(config.enabled)

  function update(patch: Partial<ChunkingConfig>) {
    onChange({ ...config, ...patch })
  }

  function handleToggle() {
    const enabled = !config.enabled
    update({ enabled })
    setExpanded(enabled)
  }

  function handleReset() {
    onChange({ ...DEFAULT_CHUNKING_CONFIG, enabled: config.enabled })
  }

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10">
            <Sliders className="h-4 w-4 text-violet-400" />
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              知识切分配置
              {config.enabled && (
                <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-400">
                  已启用
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              自定义 AI 在导入文件时如何切分和组织知识
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Toggle switch */}
          <button
            type="button"
            role="switch"
            aria-checked={config.enabled}
            onClick={handleToggle}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none ${
              config.enabled ? "bg-violet-500" : "bg-input"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                config.enabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
          {config.enabled && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {/* Expanded config */}
      {config.enabled && expanded && (
        <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
          {/* Granularity */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              知识粒度
            </Label>
            <select
              value={config.granularity}
              onChange={(e) => update({ granularity: e.target.value as ChunkingConfig["granularity"] })}
              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="fine">精细 — 每页只包含一个原子概念</option>
              <option value="standard">标准 — 均衡分配（默认）</option>
              <option value="coarse">粗粒度 — 将相关概念归并为大主题页</option>
            </select>
          </div>

          {/* Style */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              写作风格
            </Label>
            <select
              value={config.style}
              onChange={(e) => update({ style: e.target.value as ChunkingConfig["style"] })}
              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="engineering">工程风格 — 实用简洁，以代码为主</option>
              <option value="academic">学术风格 — 正式语言，含方法论与引用</option>
              <option value="bullet_points">要点列表 — 结构化列表，易于扫读</option>
              <option value="narrative">叙事风格 — 流畅散文，故事性强</option>
            </select>
          </div>

          {/* Toggles */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="chunking-examples" className="cursor-pointer text-sm">
                  强制包含示例
                </Label>
                <p className="text-xs text-muted-foreground">每个概念页面必须附带代码或使用示例</p>
              </div>
              <button
                id="chunking-examples"
                type="button"
                role="switch"
                aria-checked={config.include_examples}
                onClick={() => update({ include_examples: !config.include_examples })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
                  config.include_examples ? "bg-violet-500" : "bg-input"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    config.include_examples ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="chunking-refs" className="cursor-pointer text-sm">
                  保留来源引用
                </Label>
                <p className="text-xs text-muted-foreground">在每个页面保留原始文件的引用标注</p>
              </div>
              <button
                id="chunking-refs"
                type="button"
                role="switch"
                aria-checked={config.include_references}
                onClick={() => update({ include_references: !config.include_references })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
                  config.include_references ? "bg-violet-500" : "bg-input"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    config.include_references ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Custom instruction */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-violet-400" />
              <Label className="text-xs font-medium text-muted-foreground">
                自定义指令
                <span className="ml-1 text-muted-foreground/60">({config.custom_instruction.length}/500)</span>
              </Label>
            </div>
            <textarea
              value={config.custom_instruction}
              onChange={(e) => update({ custom_instruction: e.target.value.slice(0, 500) })}
              placeholder="例如：每个知识点请附上适用场景和常见误区，用中文输出..."
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Reset */}
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs text-muted-foreground">
              恢复默认值
            </Button>
          </div>
        </div>
      )}

      {/* Disabled hint */}
      {!config.enabled && (
        <p className="mt-2 text-xs text-muted-foreground">
          开启后可自定义 AI 在导入文件时切分知识的方式（粒度/风格/示例等）。
        </p>
      )}
    </div>
  )
}
