import { readFile, writeFile } from "@/commands/fs"
import { mergeSourcesLists, parseSources, writeSources } from "@/lib/sources-merge"

export function buildMergedReviewContent(
  existingContent: string,
  newContent: string,
  newPageTitle: string,
): string {
  const mergedSources = mergeSourcesLists(
    parseSources(existingContent),
    parseSources(newContent),
  )
  const withSources = mergedSources.length > 0
    ? writeSources(existingContent, mergedSources)
    : existingContent
  const marker = `## 审核合并补充：${newPageTitle}`
  const newBody = stripFrontmatter(newContent).replace(/^#\s+.+\r?\n?/, "").trim()

  if (!newBody || withSources.includes(marker)) {
    return withSources
  }

  return [
    withSources.trimEnd(),
    "",
    marker,
    "",
    newBody,
    "",
  ].join("\n")
}

export async function mergeReviewPageIntoExisting(
  existingPagePath: string,
  newPagePath: string,
  newPageTitle: string,
): Promise<void> {
  if (normalizeFsPath(existingPagePath) === normalizeFsPath(newPagePath)) {
    throw new Error("新旧页面路径相同，无法合并")
  }

  const [existingContent, newContent] = await Promise.all([
    readFile(existingPagePath),
    readFile(newPagePath),
  ])
  await writeFile(
    existingPagePath,
    buildMergedReviewContent(existingContent, newContent, newPageTitle),
  )
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase()
}
