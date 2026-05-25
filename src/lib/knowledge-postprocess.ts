/**
 * knowledge-postprocess.ts
 *
 * Post-generation pass that runs after all wiki pages have been written to disk.
 * Fixes two systemic issues found in PA0525-05:
 *
 * 1. RELATION RECONCILIATION
 *    LLM writes relation targets that don't match actual page titles (e.g.
 *    `has_part: 在线问诊_臻享家医` when the page is titled `在线问诊`).
 *    This pass builds a canonical title index from all generated pages and
 *    rewrites broken relation targets to match real page titles.
 *
 * 2. SCHEMA MATERIALIZATION
 *    LLM omits fields it can't find values for. This pass ensures every
 *    entity page's `attributes` JSON contains ALL fields defined in the
 *    Insurance Schema Registry for its entity_type, with null for missing
 *    values. This makes `knowledge_gaps` deterministic and makes RAG field
 *    queries reliable.
 */

import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { INSURANCE_SCHEMA_REGISTRY } from "@/lib/insurance-schema-registry"

// ─── Types ───────────────────────────────────────────────────────────────────

interface PageIndex {
  /** Canonical title as written in the frontmatter `title` field */
  title: string
  /** Relative path from projectPath, e.g. wiki/entities/在线问诊.md */
  relativePath: string
  /** Normalized forms for fuzzy lookup */
  normalizedForms: string[]
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runKnowledgePostProcess(projectPath: string): Promise<{
  reconciled: number
  materialized: number
  errors: string[]
}> {
  const errors: string[] = []
  let reconciled = 0
  let materialized = 0

  try {
    // Step 1: build canonical title index from all entity pages
    const index = await buildPageIndex(projectPath)

    // Step 2: reconcile relations + materialize schema for each entity page
    const entityFiles = await safeList(`${projectPath}/wiki/entities`)
    for (const file of entityFiles) {
      if (file.is_dir || !file.name.endsWith(".md")) continue
      const filePath = `${projectPath}/wiki/entities/${file.name}`
      try {
        const original = await readFile(filePath)
        let updated = reconcileRelations(original, index)
        updated = materializeAttributes(updated)
        if (updated !== original) {
          await writeFile(filePath, updated)
          if (updated.includes("reconciled_relations") || relationsDiffer(original, updated)) reconciled++
          if (attributesDiffer(original, updated)) materialized++
        }
      } catch (err) {
        errors.push(`${file.name}: ${String(err)}`)
      }
    }
  } catch (err) {
    errors.push(`post-process init: ${String(err)}`)
  }

  return { reconciled, materialized, errors }
}

// ─── Page Index ───────────────────────────────────────────────────────────────

async function buildPageIndex(projectPath: string): Promise<PageIndex[]> {
  const index: PageIndex[] = []
  const dirs = [
    `${projectPath}/wiki/entities`,
    `${projectPath}/wiki/concepts`,
  ]
  for (const dir of dirs) {
    const files = await safeList(dir)
    for (const file of files) {
      if (file.is_dir || !file.name.endsWith(".md")) continue
      try {
        const content = await readFile(`${dir}/${file.name}`)
        const title = extractScalar(content, "title")
        if (!title) continue
        const relativePath = dir.replace(projectPath + "/", "") + "/" + file.name
        index.push({
          title,
          relativePath,
          normalizedForms: buildNormalizedForms(title),
        })
      } catch {
        // ignore unreadable files
      }
    }
  }
  return index
}

function buildNormalizedForms(title: string): string[] {
  const forms = new Set<string>()
  const clean = title.trim()
  forms.add(normalizeTitle(clean))
  // without common suffixes that LLM sometimes appends
  forms.add(normalizeTitle(clean.replace(/[_\s]*(服务计划|健康服务计划|服务手册|健康服务|服务权益|权益|服务)$/, "")))
  // without parenthetical qualifiers like (2025年4月版)
  forms.add(normalizeTitle(clean.replace(/[（(][^）)]+[）)]/g, "")))
  // without product name suffixes that LLM appends after underscore
  forms.add(normalizeTitle(clean.replace(/_[^_]+$/, "")))
  return Array.from(forms).filter(Boolean)
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-·•]+/g, "").replace(/[（()）]/g, "")
}

// ─── Relation Reconciliation ──────────────────────────────────────────────────

function reconcileRelations(content: string, index: PageIndex[]): string {
  const fm = extractFrontmatter(content)
  if (!fm) return content

  const relationsMatch = fm.match(/^relations:\s*\n((?:\s+-\s+.*\n?)*)/m)
  if (!relationsMatch) return content

  const originalBlock = relationsMatch[0]
  const lines = relationsMatch[1].split("\n").filter(Boolean)

  const reconciledLines = lines.map((line) => {
    const item = line.match(/^(\s+-\s+)"?([a-z_]+)\s*:\s*([^"]+)"?\s*$/i)
    if (!item) return line
    const indent = item[1]
    const relType = item[2]
    const rawTarget = item[3].trim().replace(/^["']|["']$/g, "")

    // Don't touch source-document references in source pages
    if (rawTarget.endsWith(".md") || rawTarget.endsWith(".pdf")) return line

    const resolved = resolveTarget(rawTarget, index)
    if (resolved && resolved !== rawTarget) {
      return `${indent}"${relType}: ${resolved}"`
    }
    return line
  })

  const newBlock = `relations:\n${reconciledLines.join("\n")}\n`
  if (newBlock === originalBlock) return content
  return content.replace(originalBlock, newBlock)
}

function resolveTarget(rawTarget: string, index: PageIndex[]): string | null {
  // Exact match first
  const exact = index.find((p) => p.title === rawTarget)
  if (exact) return exact.title

  // Normalized fuzzy match
  const normalized = normalizeTitle(rawTarget)
  if (!normalized) return null

  // Try all normalized forms
  const fuzzy = index.find((p) => p.normalizedForms.includes(normalized))
  if (fuzzy) return fuzzy.title

  // Try prefix match (rawTarget starts with a known title)
  const prefix = index.find((p) =>
    p.normalizedForms.some(
      (form) => normalized.startsWith(form) || form.startsWith(normalized)
    )
  )
  if (prefix) return prefix.title

  return null
}

// ─── Schema Materialization ───────────────────────────────────────────────────

function materializeAttributes(content: string): string {
  const entityType = extractScalar(content, "entity_type")
  if (!entityType) return content

  const spec = INSURANCE_SCHEMA_REGISTRY.find((s) => s.entityType === entityType)
  if (!spec) return content

  // Extract current attributes
  const attrsMatch = content.match(/^attributes:\s*(\{.*\})\s*$/m)
  if (!attrsMatch) return content

  let attrs: Record<string, unknown>
  try {
    attrs = JSON.parse(attrsMatch[1])
    if (typeof attrs !== "object" || Array.isArray(attrs) || attrs === null) {
      attrs = {}
    }
  } catch {
    // If the current value can't be parsed (raw_attributes fallback), leave it
    return content
  }

  // Remove raw_attributes fallback key if present alongside real fields
  const hasRealFields = spec.fields.some((f) => f.name in attrs)
  if ("raw_attributes" in attrs && hasRealFields) {
    delete attrs["raw_attributes"]
  }

  // Add null for every schema field not yet present
  let changed = false
  for (const field of spec.fields) {
    if (field.importance === "auto_derived") continue // never fill auto_derived
    if (!(field.name in attrs)) {
      attrs[field.name] = null
      changed = true
    }
  }

  if (!changed) return content

  // Recompute knowledge_gaps from null fields
  const nullFields = spec.fields
    .filter((f) => f.importance !== "auto_derived" && attrs[f.name] === null)
    .map((f) => f.name)
  attrs["knowledge_gaps"] = nullFields

  const newAttrs = JSON.stringify(attrs)
  return content.replace(/^attributes:\s*\{.*\}\s*$/m, `attributes: ${newAttrs}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFrontmatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1] : null
}

function extractScalar(content: string, key: string): string {
  const m = content.match(new RegExp(`^${escapeRe(key)}:\\s*"?([^"\\n]+)"?\\s*$`, "m"))
  return m ? m[1].trim() : ""
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function relationsDiffer(a: string, b: string): boolean {
  return extractRelationsBlock(a) !== extractRelationsBlock(b)
}

function attributesDiffer(a: string, b: string): boolean {
  const ma = a.match(/^attributes:\s*(.+)$/m)
  const mb = b.match(/^attributes:\s*(.+)$/m)
  return (ma?.[1] ?? "") !== (mb?.[1] ?? "")
}

function extractRelationsBlock(content: string): string {
  return content.match(/^relations:[\s\S]*?(?=\n\w|\n---)/m)?.[0] ?? ""
}

async function safeList(path: string): Promise<{ name: string; is_dir?: boolean }[]> {
  try {
    return await listDirectory(path)
  } catch {
    return []
  }
}
