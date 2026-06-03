/**
 * wiki-alias-map.ts
 *
 * Builds a canonical alias map from multiple sources (priority order):
 *   1. manual_override  — wiki/alias-map.json (optional human override)
 *   2. redirect_to      — Identity Pass confirmed merges
 *   3. dedup_canonical  — same dedup_key → canonical title from catalog
 *   4. identity_inferred — alias_of edges written by Identity Pass
 *   5. frontmatter_aliases — user-written `aliases:` frontmatter field
 *   6. title_canonicalizer — brand suffix stripping via canonicalServiceIdentityName
 *
 * Usage:
 *   const aliasMap = await buildAliasMap(projectPath)
 *   const resolved = canonicalizeLinkTarget("家庭医生", aliasMap)
 *   // → "家庭医生服务" (if that's the canonical title)
 *
 * Design:
 *   - Higher-priority sources always win (lower index in ALIAS_SOURCE_PRIORITY)
 *   - Manual override (alias-map.json) always wins over everything
 *   - The map is built ONCE per ingest/postprocess run and passed around
 *   - No LLM calls — pure file scanning
 */

import { listDirectory, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { canonicalServiceIdentityName } from "@/lib/insurance-schema-registry"

// ─── Types ────────────────────────────────────────────────────────────────────

/** Alias source with trust priority (lower index = higher trust). */
export const ALIAS_SOURCE_PRIORITY = [
  "manual_override",    // wiki/alias-map.json — human always wins
  "redirect_to",        // Identity Pass confirmed merge
  "dedup_canonical",    // same dedup_key, canonical was chosen
  "identity_inferred",  // alias_of edges from Identity Pass
  "frontmatter_aliases",// user-written aliases: field in frontmatter
  "title_canonicalizer",// brand/suffix stripping (lowest trust)
] as const

export type AliasSource = (typeof ALIAS_SOURCE_PRIORITY)[number]

/** Maps alias title → canonical title. */
export type AliasMap = Map<string, string>

interface AliasEntry {
  canonical: string
  source: AliasSource
}

// ─── Build ────────────────────────────────────────────────────────────────────

/**
 * Scan the wiki directory and build an alias map.
 * Call once at the start of postprocess or ingest; pass the result around.
 */
export async function buildAliasMap(projectPath: string): Promise<AliasMap> {
  const pp = normalizePath(projectPath)
  // Internal: tracks source for each alias so higher-priority wins
  const entries = new Map<string, AliasEntry>()

  function addAlias(alias: string, canonical: string, source: AliasSource) {
    const a = alias.trim()
    const c = canonical.trim()
    if (!a || !c || a === c) return
    const existing = entries.get(a)
    if (existing) {
      const existPriority = ALIAS_SOURCE_PRIORITY.indexOf(existing.source)
      const newPriority   = ALIAS_SOURCE_PRIORITY.indexOf(source)
      if (newPriority >= existPriority) return // existing source wins
    }
    entries.set(a, { canonical: c, source })
  }

  // ── Source 6: title_canonicalizer (lowest trust — scanned first so higher sources can override) ──
  // Brand-suffix stripping: "家庭医生_臻享家医" → "家庭医生"
  const entityDirs = ["entities", "concepts"]
  for (const dir of entityDirs) {
    try {
      const tree = await listDirectory(`${pp}/wiki/${dir}`)
      for (const node of tree as { path: string; is_dir?: boolean }[]) {
        if (node.is_dir || !node.path.endsWith(".md")) continue
        try {
          const content = await readFile(node.path)
          if (/^redirect_to:\s*".+"/m.test(content)) continue // skip redirected
          const title = content.match(/^title:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
          if (!title) continue
          const canonical = canonicalServiceIdentityName(title)
          if (canonical !== title) addAlias(title, canonical, "title_canonicalizer")
        } catch { /* unreadable — skip */ }
      }
    } catch { /* dir missing — skip */ }
  }

  // ── Source 5: frontmatter_aliases ──────────────────────────────────────────
  for (const dir of entityDirs) {
    try {
      const tree = await listDirectory(`${pp}/wiki/${dir}`)
      for (const node of tree as { path: string; is_dir?: boolean }[]) {
        if (node.is_dir || !node.path.endsWith(".md")) continue
        try {
          const content = await readFile(node.path)
          if (/^redirect_to:\s*".+"/m.test(content)) continue
          const title = content.match(/^title:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
          if (!title) continue

          // Inline aliases: ["alias1", "alias2"]
          const inlineMatch = content.match(/^aliases:\s*\[([^\]]*)\]/m)
          if (inlineMatch) {
            for (const a of inlineMatch[1].split(",").map(s => s.trim().replace(/^"|"$/g, ""))) {
              addAlias(a, title, "frontmatter_aliases")
            }
          }
          // Block aliases:
          //   aliases:
          //     - alias1
          const blockMatch = content.match(/^aliases:\s*\n((?:\s+-\s+.+\n?)+)/m)
          if (blockMatch) {
            for (const a of blockMatch[1].split("\n").map(s => s.replace(/^\s+-\s+/, "").trim()).filter(Boolean)) {
              addAlias(a, title, "frontmatter_aliases")
            }
          }
        } catch { /* unreadable — skip */ }
      }
    } catch { /* dir missing — skip */ }
  }

  // ── Source 4: identity_inferred (alias_of edges) ───────────────────────────
  for (const dir of entityDirs) {
    try {
      const tree = await listDirectory(`${pp}/wiki/${dir}`)
      for (const node of tree as { path: string; is_dir?: boolean }[]) {
        if (node.is_dir || !node.path.endsWith(".md")) continue
        try {
          const content = await readFile(node.path)
          if (/^redirect_to:\s*".+"/m.test(content)) continue
          const title = content.match(/^title:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
          if (!title) continue

          // Compact relation format: - "alias_of: OtherTitle"
          const compactAliasRe = /^\s+-\s+"?alias_of:\s*([^"\n]+)"?\s*$/gm
          for (const m of content.matchAll(compactAliasRe)) {
            addAlias(m[1].trim(), title, "identity_inferred")
          }
          // Structured relation_edges: target: "OtherTitle" type: alias_of
          const edgeBlockMatch = content.match(/^relation_edges:\s*\n((?:[\s\S]*?)(?=\n[a-z_]+:|\n---|\z))/m)
          if (edgeBlockMatch) {
            const edgeBlobs = edgeBlockMatch[1].split(/(?=\n?\s+-\s+target:)/m).filter(Boolean)
            for (const blob of edgeBlobs) {
              const edgeType = blob.match(/type:\s*(\S+)/m)?.[1]?.trim()
              if (edgeType !== "alias_of") continue
              const prov = blob.match(/provenance:\s*(\S+)/m)?.[1]?.trim() ?? ""
              if (!prov.includes("identity")) continue // only identity_inferred edges
              const tgt = blob.match(/target:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
              if (tgt) addAlias(tgt, title, "identity_inferred")
            }
          }
        } catch { /* unreadable — skip */ }
      }
    } catch { /* dir missing — skip */ }
  }

  // ── Source 2+3: redirect_to and dedup_canonical ────────────────────────────
  // redirect_to: "CanonicalTitle" in a page means that page's title is an alias for CanonicalTitle
  for (const dir of entityDirs) {
    try {
      const tree = await listDirectory(`${pp}/wiki/${dir}`)
      for (const node of tree as { path: string; is_dir?: boolean }[]) {
        if (node.is_dir || !node.path.endsWith(".md")) continue
        try {
          const content = await readFile(node.path)
          const redirectTo = content.match(/^redirect_to:\s*"([^"\n]+)"/m)?.[1]?.trim()
          if (!redirectTo) continue
          const title = content.match(/^title:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
          if (title) addAlias(title, redirectTo, "redirect_to")
        } catch { /* unreadable — skip */ }
      }
    } catch { /* dir missing — skip */ }
  }

  // ── Source 1: manual_override (wiki/alias-map.json) ───────────────────────
  // Format: { "old title": "canonical title", ... }
  // This file is optional — absence is not an error.
  try {
    const overrideRaw = await readFile(`${pp}/wiki/alias-map.json`)
    const override = JSON.parse(overrideRaw) as Record<string, string>
    for (const [alias, canonical] of Object.entries(override)) {
      addAlias(alias, canonical, "manual_override")
    }
  } catch { /* file absent or malformed — skip */ }

  // Convert to plain Map
  const result: AliasMap = new Map()
  for (const [alias, entry] of entries.entries()) {
    result.set(alias, entry.canonical)
  }
  return result
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/**
 * Resolve a wikilink target to its canonical title.
 * Returns the original string if no alias mapping is found.
 */
export function canonicalizeLinkTarget(raw: string, aliasMap: AliasMap): string {
  const trimmed = raw.trim()
  // Direct match
  const direct = aliasMap.get(trimmed)
  if (direct) return direct
  // Try canonicalServiceIdentityName normalisation first
  const normalized = canonicalServiceIdentityName(trimmed)
  return aliasMap.get(normalized) ?? trimmed
}

/**
 * Rewrite all [[wikilinks]] in a markdown string using the alias map.
 * Preserves display text: [[OldTitle|Display]] → [[NewTitle|Display]]
 * Plain links: [[OldTitle]] → [[NewTitle]]
 */
export function rewriteWikilinks(markdown: string, aliasMap: AliasMap): string {
  if (aliasMap.size === 0) return markdown
  return markdown.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (match, linkTarget, displayPart) => {
    const resolved = canonicalizeLinkTarget(linkTarget, aliasMap)
    if (resolved === linkTarget) return match // no change
    return displayPart
      ? `[[${resolved}${displayPart}]]`   // preserve display text
      : `[[${resolved}]]`
  })
}
