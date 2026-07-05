export function fileMissingErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "")
  return extractFileMissingErrorMessage(message) ?? message
}

export function isFileMissingError(err: unknown): boolean {
  return extractFileMissingErrorMessage(err instanceof Error ? err.message : String(err ?? "")) !== null
}

export function isFileMissingErrorContent(content: string): boolean {
  const text = String(content ?? "").trim()
  if (text.length > 3000) return false
  if (!/file does not exist|no such file|not found|os error 2/i.test(text)) return false
  if (parseJsonError(text)) return true
  if (/^\s*(Error:\s*){1,2}/i.test(text)) return true
  return /^\s*(file does not exist|no such file|not found|os error 2)/i.test(text)
}

export function extractFileMissingErrorMessage(value: string): string | null {
  const normalized = normalizeErrorText(value)
  if (!/file does not exist|no such file|not found|os error 2/i.test(normalized)) {
    return null
  }

  const parsed = parseJsonError(normalized)
  if (parsed) return parsed

  return normalized
    .replace(/^\s*Error:\s*/i, "")
    .replace(/^\s*Error:\s*/i, "")
    .trim()
}

function normalizeErrorText(value: string): string {
  return String(value ?? "").trim()
}

function parseJsonError(value: string): string | null {
  const candidates = [
    value,
    value.replace(/^\s*Error:\s*/i, "").replace(/^\s*Error:\s*/i, ""),
  ]

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { error?: unknown; message?: unknown }
      const message = typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : ""
      if (message.trim()) return message.trim()
    } catch {
      // Not a JSON error envelope.
    }
  }

  const objectStart = value.indexOf("{")
  if (objectStart <= 0) return null
  return parseJsonError(value.slice(objectStart))
}
