/**
 * claude-cli-transport.ts — Web mode stub.
 * Claude Code CLI is a desktop-only feature; in web mode all operations are no-ops.
 */

export type ClaudeCliOptions = Record<string, unknown>
export type ClaudeCliResponse = { content: string }

export async function claudeCliStream(
  _options: ClaudeCliOptions,
  _onChunk: (chunk: string) => void,
): Promise<ClaudeCliResponse> {
  throw new Error("Claude Code CLI is not available in web mode.")
}

export async function claudeCliKill(_streamId: string): Promise<void> {}

export async function claudeCliDetect(): Promise<{
  installed: boolean; version: string | null; path: string | null; error: string | null
}> {
  return { installed: false, version: null, path: null, error: "Not available in web mode" }
}
