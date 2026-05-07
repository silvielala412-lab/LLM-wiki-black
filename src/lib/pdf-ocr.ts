/**
 * pdf-ocr.ts
 *
 * Handles image-based (scanned) PDFs that have no text layer.
 *
 * When the Rust server detects a PDF with no extractable text, it converts
 * each page to a JPEG via pdftoppm and returns a JSON marker:
 *
 *   __PDF_IMAGE_PAGES__{"type":"image_pages","page_count":N,"dpi":150,"pages":["<base64>",…]}
 *
 * This module detects that marker, calls the configured vision model
 * (multimodal LLM) page-by-page, and returns the combined OCR text so
 * the rest of the ingest pipeline can process it normally.
 */

import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

const MARKER = "__PDF_IMAGE_PAGES__"

export interface ImagePagePayload {
  type: "image_pages"
  page_count: number
  dpi: number
  pages: string[] // base64-encoded JPEG strings
}

/** Returns true when the content string contains the image-PDF marker. */
export function isImagePdf(content: string): boolean {
  return content.startsWith(MARKER)
}

/**
 * Parse the JSON payload embedded after the marker.
 * Throws if parsing fails.
 */
export function parseImagePdfPayload(content: string): ImagePagePayload {
  const json = content.slice(MARKER.length)
  const payload = JSON.parse(json) as ImagePagePayload
  if (payload.type !== "image_pages" || !Array.isArray(payload.pages)) {
    throw new Error("Invalid image_pages payload")
  }
  return payload
}

/**
 * OCR a single base64-encoded JPEG using the vision LLM.
 * Returns the extracted text for that page.
 */
async function ocrPage(
  pageBase64: string,
  pageIndex: number,
  totalPages: number,
  visionConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  let text = ""

  await streamChat(
    visionConfig,
    [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${pageBase64}`,
              detail: "high",
            },
          },
          {
            type: "text",
            text: `这是第 ${pageIndex + 1} 页（共 ${totalPages} 页）扫描文档。请提取图中所有可见文字，保持原始格式（包括换行、标题层级、表格结构等），不要添加任何解释或额外内容，直接输出提取到的文字。`,
          },
        ] as unknown as string,
      },
    ],
    {
      onToken: (token) => { text += token },
      onDone: () => {},
      onError: (err) => {
        console.warn(`[pdf-ocr] page ${pageIndex + 1} OCR error:`, err.message)
      },
    },
    signal,
    { temperature: 0 },
  )

  return text.trim()
}

/**
 * Run OCR on all pages of an image-based PDF using the vision model.
 *
 * @param content   Raw content from readFile() — must start with __PDF_IMAGE_PAGES__
 * @param visionConfig  LLM config pointing to the vision/multimodal model
 * @param options   Optional progress callback and abort signal
 * @returns  Combined OCR text across all pages
 */
export async function ocrImagePdf(
  content: string,
  visionConfig: LlmConfig,
  options?: {
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
  },
): Promise<string> {
  const payload = parseImagePdfPayload(content)
  const { pages } = payload
  const total = pages.length

  const pageTexts: string[] = []

  for (let i = 0; i < total; i++) {
    if (options?.signal?.aborted) break

    options?.onProgress?.(i, total)

    const pageText = await ocrPage(
      pages[i],
      i,
      total,
      visionConfig,
      options?.signal,
    )

    if (pageText) {
      pageTexts.push(`<!-- Page ${i + 1} -->\n${pageText}`)
    }
  }

  options?.onProgress?.(total, total)

  if (pageTexts.length === 0) {
    return "(OCR 未能提取到任何文字 — 请确认视觉模型已正确配置)"
  }

  return pageTexts.join("\n\n")
}
