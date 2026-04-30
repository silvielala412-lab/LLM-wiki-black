/**
 * Resolve markdown image `src` attributes so they actually load in
 * the Tauri webview.
 *
 * The problem: ingest writes images to `<project>/wiki/media/<slug>/`
 * and embeds them in generated wiki pages as
 * `![](media/<slug>/img-1.png)`. A markdown renderer interprets that
 * relative to the rendering page's URL — but in Tauri there IS no
 * URL context for arbitrary file paths, AND the wiki page may be
 * located deeper than `wiki/concepts/foo.md` so naive `../media/...`
 * fixups don't generalize.
 *
 * Convention we settle on:
 *
 *   - Any src starting with `http://`, `https://`, `data:`, `blob:`,
 *     `file:`, `tauri://` is passed through unchanged.
 *   - Any src starting with `/` (absolute) is wrapped with
 *     `convertFileSrc` directly — the path is the filesystem
 *     absolute path.
 *   - **Anything else is treated as relative to the project's
 *     `wiki/` root.** Generated content uses this form
 *     (`media/foo/img-1.png`); user-written content can use it too.
 *
 * The resolver returns a string that React's <img src=...> can load:
 * the appropriate `convertFileSrc(...)` URL or the original src
 * verbatim.
 */
import { normalizePath } from "@/lib/path-utils"

const PASSTHROUGH_RE = /^(https?:|data:|blob:|file:|tauri:)/i

/** Web-mode replacement for Tauri's convertFileSrc — routes through FastAPI media endpoint. */
function convertFileSrc(path: string): string {
  return `/api/fs/media?path=${encodeURIComponent(path)}`
}

export function resolveMarkdownImageSrc(
  rawSrc: string,
  projectPath: string | null,
): string {
  if (!rawSrc) return rawSrc
  if (PASSTHROUGH_RE.test(rawSrc)) return rawSrc
  if (!projectPath) return rawSrc
  const pp = normalizePath(projectPath)
  const isAbsolute = rawSrc.startsWith("/") || /^[a-zA-Z]:/.test(rawSrc) || rawSrc.startsWith("\\\\")
  if (isAbsolute) return convertFileSrc(rawSrc)
  const cleaned = rawSrc.replace(/^\.\//,"")
  const absolute = `${pp}/wiki/${cleaned}`
  return convertFileSrc(absolute)
}
