/**
 * pdf-ocr.ts
 *
 * Handles image-based (scanned) PDFs that have no text layer.
 *
 * When the Rust server detects a PDF with no extractable text, it converts
 * each page to a JPEG via pdftoppm and returns a JSON marker:
 *
 *   __PDF_IMAGE_PAGES__{"type":"image_pages","page_count":N,"dpi":150,"pages":["<base64>", ...]}
 *
 * This module detects that marker, calls the configured vision model
 * (multimodal LLM), and returns OCR text for the ingest pipeline.
 */

import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { createDirectory, readFile, writeFile } from "@/commands/fs"

const MARKER = "__PDF_IMAGE_PAGES__"
const OCR_PAGE_TIMEOUT_MS = 180_000
const OCR_PDF_PAGE_CONCURRENCY = 3

const TABLE_OCR_PROMPT = [
  "请对这张图片做高精度 OCR，直接输出可供知识库入库的原文。",
  "必须遵守：",
  "1. 提取所有可见文字，不要摘要、不要概括、不要省略。",
  "2. 如果包含表格，必须逐行保留表格结构；序号、产品名称、代码、交期、1、1*、N、是、空白单元格、备注都要尽量原样保留。",
  "3. 对长表格，不要只输出示例行；必须从第一行连续输出到最后一行。",
  "4. 保持标题、页码、注释、表头、换行和列顺序。",
  "5. 看不清的单元格用 [无法识别] 标注，不要猜测。",
  "6. 输出纯文本或 Markdown 表格，不要添加解释性前言。",
].join("\n")

export interface ImagePagePayload {
  type: "image_pages"
  page_count: number
  dpi: number
  pages: string[]
}

export function isImagePdf(content: string): boolean {
  return content.startsWith(MARKER)
}

export function parseImagePdfPayload(content: string): ImagePagePayload {
  const json = content.slice(MARKER.length)
  const payload = JSON.parse(json) as ImagePagePayload
  if (payload.type !== "image_pages" || !Array.isArray(payload.pages)) {
    throw new Error("Invalid image_pages payload")
  }
  return payload
}

function pageCachePath(cacheDir: string, pageIndex: number): string {
  return `${cacheDir}/page-${String(pageIndex + 1).padStart(4, "0")}.md`
}

async function ensureCacheDir(cacheDir?: string): Promise<void> {
  if (!cacheDir) return
  try {
    const parent = cacheDir.slice(0, cacheDir.lastIndexOf("/"))
    if (parent) await createDirectory(parent).catch(() => {})
    await createDirectory(cacheDir)
  } catch {
    // Directory may already exist, or the server may create parents on write.
  }
}

async function readCachedPage(cacheDir: string | undefined, pageIndex: number): Promise<string | null> {
  if (!cacheDir) return null
  try {
    const cached = await readFile(pageCachePath(cacheDir, pageIndex))
    return cached.trim() ? cached : null
  } catch {
    return null
  }
}

async function writeCachedPage(cacheDir: string | undefined, pageIndex: number, pageText: string): Promise<void> {
  if (!cacheDir || !pageText.trim()) return
  try {
    await writeFile(pageCachePath(cacheDir, pageIndex), pageText)
  } catch (err) {
    console.warn(`[pdf-ocr] failed to persist page ${pageIndex + 1} OCR cache:`, err)
  }
}

function createTimedSignal(parent?: AbortSignal): {
  signal: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
} {
  let timeoutFired = false
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => {
    timeoutFired = true
    controller.abort()
  }, OCR_PAGE_TIMEOUT_MS)
  const abortFromParent = () => controller.abort()
  parent?.addEventListener("abort", abortFromParent, { once: true })

  return {
    signal: controller.signal,
    timedOut: () => timeoutFired,
    cleanup: () => {
      globalThis.clearTimeout(timeout)
      parent?.removeEventListener("abort", abortFromParent)
    },
  }
}

async function ocrPage(
  pageBase64: string,
  pageIndex: number,
  totalPages: number,
  visionConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  let text = ""
  const timed = createTimedSignal(signal)

  try {
    await streamChat(
      visionConfig,
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `这是第 ${pageIndex + 1} 页（共 ${totalPages} 页）扫描文档。\n\n${TABLE_OCR_PROMPT}`,
            },
            {
              type: "image",
              mediaType: "image/jpeg",
              dataBase64: pageBase64,
            },
          ],
        },
      ],
      {
        onToken: (token) => { text += token },
        onDone: () => {},
        onError: (err) => {
          throw err
        },
      },
      timed.signal,
      { temperature: 0 },
    )
  } finally {
    timed.cleanup()
  }

  if (timed.timedOut()) {
    throw new Error(`page OCR timed out after ${Math.round(OCR_PAGE_TIMEOUT_MS / 1000)}s`)
  }

  return text.trim()
}

export async function ocrImageBytes(
  imageBase64: string,
  mediaType: string,
  visionConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  let text = ""
  const timed = createTimedSignal(signal)

  try {
    await streamChat(
      visionConfig,
      [
        {
          role: "user",
          content: [
            { type: "text", text: TABLE_OCR_PROMPT },
            { type: "image", mediaType, dataBase64: imageBase64 },
          ],
        },
      ],
      {
        onToken: (token) => { text += token },
        onDone: () => {},
        onError: (err) => {
          throw err
        },
      },
      timed.signal,
      { temperature: 0 },
    )
  } finally {
    timed.cleanup()
  }

  if (timed.timedOut()) {
    throw new Error(`image OCR timed out after ${Math.round(OCR_PAGE_TIMEOUT_MS / 1000)}s`)
  }

  return text.trim()
}

export async function ocrImagePdf(
  content: string,
  visionConfig: LlmConfig,
  options?: {
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
    cacheDir?: string
  },
): Promise<string> {
  const payload = parseImagePdfPayload(content)
  const { pages } = payload
  const total = pages.length
  const results = new Array<string>(total)
  const concurrency = Math.min(OCR_PDF_PAGE_CONCURRENCY, total)
  const pendingPages: number[] = []
  let nextIndex = 0
  let completed = 0

  await ensureCacheDir(options?.cacheDir)
  for (let pageIndex = 0; pageIndex < total; pageIndex++) {
    const cachedPage = await readCachedPage(options?.cacheDir, pageIndex)
    if (cachedPage) {
      results[pageIndex] = cachedPage
      completed++
    } else {
      pendingPages.push(pageIndex)
    }
  }

  async function worker(): Promise<void> {
    while (!options?.signal?.aborted) {
      const pageIndex = pendingPages[nextIndex++]
      if (pageIndex === undefined) return

      try {
        const pageText = await ocrPage(
          pages[pageIndex],
          pageIndex,
          total,
          visionConfig,
          options?.signal,
        )
        const pageResult = pageText
          ? `<!-- Page ${pageIndex + 1} -->\n${pageText}`
          : `<!-- Page ${pageIndex + 1} OCR returned empty text -->`
        results[pageIndex] = pageResult
        await writeCachedPage(options?.cacheDir, pageIndex, pageResult)
      } catch (err) {
        if (options?.signal?.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[pdf-ocr] page ${pageIndex + 1}/${total} failed:`, message)
        results[pageIndex] = `<!-- Page ${pageIndex + 1} OCR failed: ${message} -->`
      } finally {
        completed++
        options?.onProgress?.(completed, total)
      }
    }
  }

  options?.onProgress?.(completed, total)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const pageTexts = results.filter((text): text is string => Boolean(text))
  if (pageTexts.length === 0) {
    return "(OCR 未能提取到任何文字，请确认视觉模型已正确配置)"
  }

  return pageTexts.join("\n\n")
}
