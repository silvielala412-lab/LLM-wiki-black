/**
 * Project identity: stable UUID per project + global registry mapping
 * `UUID → current filesystem path`.
 *
 * Why: absolute paths are unstable (users move / rename project folders).
 * Queue tasks reference projects by UUID and look up the current path
 * via the registry at run time, so a moved folder doesn't orphan tasks.
 *
 * Storage:
 * - Per-project identity: `{project}/.llm-wiki/project.json`
 *     `{ "id": "<uuid>", "createdAt": <ms> }`
 * - Global registry: Tauri plugin-store `app-state.json` key `projectRegistry`
 *     `{ [id]: { id, path, name, lastOpened } }`
 */

import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const REGISTRY_KEY = "llm-wiki:projectRegistry"

/**
 * UUID v4 generator that works in both secure (HTTPS) and non-secure (HTTP)
 * contexts. `crypto.randomUUID()` is only available in secure contexts
 * (HTTPS or localhost); intranet HTTP deployments need the Math.random fallback.
 */
function generateUUID(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  // RFC 4122 v4 UUID fallback — sufficient for project identity keys
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function lsGet<T>(key: string): T | null {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null } catch { return null }
}
function lsSet(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch {}
}

export interface ProjectIdentity {
  id: string
  createdAt: number
}

export interface ProjectRegistryEntry {
  id: string
  path: string       // latest known filesystem path (normalized forward slashes)
  name: string
  lastOpened: number
}

export type ProjectRegistry = Record<string, ProjectRegistryEntry>

// ── Per-project identity (reads/creates `.llm-wiki/project.json`) ─────────

function identityPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/project.json`
}

/**
 * Return the project's stable UUID. Generates + writes one on first call
 * for a project that doesn't have `.llm-wiki/project.json` yet.
 */
export async function ensureProjectId(projectPath: string): Promise<string> {
  const path = identityPath(projectPath)
  try {
    const raw = await readFile(path)
    const parsed = JSON.parse(raw) as ProjectIdentity
    if (parsed?.id && typeof parsed.id === "string") {
      return parsed.id
    }
  } catch {
    // missing or corrupt — fall through to create
  }
  const identity: ProjectIdentity = {
    id: generateUUID(),
    createdAt: Date.now(),
  }
  try {
    await writeFile(path, JSON.stringify(identity, null, 2))
  } catch (err) {
    console.warn("[project-identity] failed to write identity file:", err)
  }
  return identity.id
}


export async function loadRegistry(): Promise<ProjectRegistry> {
  return lsGet<ProjectRegistry>(REGISTRY_KEY) ?? {}
}

async function saveRegistry(registry: ProjectRegistry): Promise<void> {
  lsSet(REGISTRY_KEY, registry)
}


/**
 * Create or update the registry entry for this project. Call on open /
 * create / switch so the path always reflects the latest known location.
 */
export async function upsertProjectInfo(
  id: string,
  path: string,
  name: string,
): Promise<void> {
  const registry = await loadRegistry()
  registry[id] = {
    id,
    path: normalizePath(path),
    name,
    lastOpened: Date.now(),
  }
  await saveRegistry(registry)
}

/**
 * Look up the current filesystem path by UUID. Returns null if the
 * project isn't in the registry (e.g. was deleted or never opened).
 */
export async function getProjectPathById(id: string): Promise<string | null> {
  const registry = await loadRegistry()
  return registry[id]?.path ?? null
}

/**
 * Reverse lookup: given a path, find the UUID of a known project at
 * that exact location. Used by the clip watcher to translate
 * clip-server-supplied paths back to stable project ids.
 */
export async function getProjectIdByPath(path: string): Promise<string | null> {
  const normalized = normalizePath(path)
  const registry = await loadRegistry()
  for (const entry of Object.values(registry)) {
    if (entry.path === normalized) return entry.id
  }
  return null
}
