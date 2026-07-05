export type FrontmatterValue = string | string[]

export interface ParsedMarkdownFrontmatter {
  frontmatter: Record<string, FrontmatterValue>
  body: string
}

export function parseMarkdownFrontmatter(content: string): ParsedMarkdownFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, FrontmatterValue> = {}
  const yaml = match[1]
  const body = match[2] ?? ""
  let currentKey = ""

  for (const line of yaml.split(/\r?\n/)) {
    const listStart = line.match(/^([A-Za-z_][\w-]*):\s*\[(.*)]\s*$/)
    const scalar = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/)
    const listItem = line.match(/^\s*-\s+(.*?)\s*$/)

    if (listStart) {
      currentKey = listStart[1]
      frontmatter[currentKey] = splitInlineList(listStart[2])
    } else if (scalar) {
      currentKey = scalar[1]
      const raw = scalar[2].trim()
      frontmatter[currentKey] = trimQuotes(raw)
    } else if (listItem && currentKey) {
      const existing = frontmatter[currentKey]
      const next = trimQuotes(listItem[1].trim())
      frontmatter[currentKey] = Array.isArray(existing)
        ? [...existing, next]
        : existing
          ? [String(existing), next]
          : [next]
    }
  }

  return { frontmatter, body }
}

export function frontmatterString(fm: Record<string, FrontmatterValue>, key: string): string {
  const value = fm[key]
  if (Array.isArray(value)) return value[0] ?? ""
  return typeof value === "string" ? value : ""
}

export function frontmatterList(fm: Record<string, FrontmatterValue>, key: string): string[] {
  const value = fm[key]
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value !== "string") return []
  const trimmed = value.trim()
  if (!trimmed) return []
  const bracketed = trimmed.match(/^\[(.*)]$/)
  return splitInlineList(bracketed ? bracketed[1] : trimmed)
}

function splitInlineList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => trimQuotes(item.trim()))
    .filter(Boolean)
}

function trimQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim()
}
