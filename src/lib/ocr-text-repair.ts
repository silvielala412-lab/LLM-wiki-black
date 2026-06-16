/**
 * ocr-text-repair.ts
 *
 * Pre-processing utilities for OCR-extracted insurance document text.
 *
 * OCR output commonly has:
 * 1. Broken lines — a sentence is split across lines mid-word/mid-clause
 *    (no terminal punctuation at end of line, no paragraph-start signal at next line)
 * 2. Garbled table rows — cell content split across lines
 *
 * These are fixed before chunking so the LLM sees clean, continuous text.
 */

// Characters that indicate end of a complete sentence / clause
const SENTENCE_TERMINATORS = /[。！？；：""…\n\r]$/

// Patterns that mark the START of a new paragraph or structural element:
// - Numbered list: (1) or 1. or 一、 or 第一条 or ① etc.
// - Bullet: • - ·
// - Section heading: ## or # at start
// - Table row: |
// - Empty line (already handled by double-newline logic)
const PARAGRAPH_START = /^(?:\s*(?:[（(【\[]*\d+[）)\]】.、]|\w[.、]|[一二三四五六七八九十百]+[、。]|第[一二三四五六七八九十百\d]+条|[①②③④⑤⑥⑦⑧⑨]|[•\-·]|#{1,3} |\|))/

/**
 * Repair OCR broken lines.
 *
 * Strategy:
 * - Split text into lines
 * - If current line doesn't end with a sentence terminator AND
 *   next line doesn't start with a paragraph-start pattern AND
 *   neither line is empty
 * → join them with no separator (Chinese text) or a space (Latin text)
 *
 * Preserves intentional paragraph breaks (blank lines between paragraphs).
 */
export function repairOcrLineBreaks(text: string): string {
  // Normalize Windows line endings
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

  const lines = normalized.split("\n")
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const current = lines[i]
    const next = i + 1 < lines.length ? lines[i + 1] : null

    // Always keep blank lines as paragraph separators
    if (current.trim() === "") {
      result.push(current)
      i++
      continue
    }

    // If next line exists and is non-blank, check if we should merge
    if (
      next !== null &&
      next.trim() !== "" &&
      !SENTENCE_TERMINATORS.test(current.trimEnd()) &&
      !PARAGRAPH_START.test(next) &&
      // Don't merge if current line itself looks like a heading
      !current.trim().startsWith("#") &&
      // Don't merge table rows
      !current.trim().startsWith("|") &&
      !next.trim().startsWith("|")
    ) {
      // Determine separator: Chinese text → no space; otherwise space
      const lastChar = current.trimEnd().slice(-1)
      const firstChar = next.trimStart()[0] ?? ""
      const isChinese = /[\u4e00-\u9fa5]/.test(lastChar) || /[\u4e00-\u9fa5]/.test(firstChar)
      const sep = isChinese ? "" : " "

      // Merge current + next
      lines[i + 1] = current.trimEnd() + sep + next.trimStart()
      i++ // skip current, re-process merged at i+1
      continue
    }

    result.push(current)
    i++
  }

  return result.join("\n")
}

/**
 * Clean up common OCR artifacts in insurance documents:
 * - Remove page headers/footers that appear mid-text (e.g. "第 3 页 共 25 页")
 * - Normalize full-width punctuation inconsistencies
 * - Remove watermarks / repeated product name lines
 */
export function cleanOcrArtifacts(text: string, productName?: string): string {
  let cleaned = text

  // Remove page number patterns like "第 3 页 共 25 页" or "- 3 -"
  cleaned = cleaned.replace(/第\s*\d+\s*页\s*共\s*\d+\s*页/g, "")
  cleaned = cleaned.replace(/^\s*-\s*\d+\s*-\s*$/gm, "")
  cleaned = cleaned.replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, "")

  // Remove repeated product name headers (common in OCR of multi-page PDFs)
  if (productName) {
    const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    cleaned = cleaned.replace(new RegExp(`^\\s*${escapedName}\\s*$`, "gm"), "")
  }

  // Normalize excessive blank lines (3+ → 2)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n")

  return cleaned.trim()
}

/**
 * Full pre-processing pipeline for OCR text before chunking.
 */
export function preprocessOcrText(text: string, productName?: string): string {
  let result = text
  result = cleanOcrArtifacts(result, productName)
  result = repairOcrLineBreaks(result)
  return result
}
