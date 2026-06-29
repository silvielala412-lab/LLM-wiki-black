import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  searchByEmbedding: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
}))

vi.mock("@/lib/embedding", () => ({
  searchByEmbedding: mocks.searchByEmbedding,
}))

import { findSimilarByTitle, findSimilarByVector } from "./conflict-detector"

function page(title: string): string {
  return `---\ntitle: "${title}"\ntype: entity\n---\n\n# ${title}\n\n正文内容。`
}

describe("conflict detector path guards", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("does not compare a page with itself when path separators differ", async () => {
    mocks.listDirectory.mockResolvedValue([
      {
        name: "same.md",
        path: "C:\\project\\wiki\\entities\\same.md",
        is_dir: false,
      },
    ])

    const result = await findSimilarByTitle(
      "C:/project",
      "Same Page",
      "C:/project/wiki/entities/same.md",
    )

    expect(result).toEqual([])
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("does not run conflict detection for audit pages", async () => {
    const result = await findSimilarByTitle(
      "C:/project",
      "抽取质量审计",
      "C:/project/wiki/audits/source-抽取质量审计.md",
    )

    expect(result).toEqual([])
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("filters the current page from vector results resolved by basename", async () => {
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "same", score: 0.99 },
    ])
    mocks.readFile.mockRejectedValue(new Error("not found"))

    const result = await findSimilarByVector(
      "C:/project",
      "entities/same",
      page("Same Page"),
      { enabled: true, model: "test" },
    )

    expect(result).toEqual([])
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(mocks.readFile).toHaveBeenCalledWith("C:/project/wiki/concepts/same.md")
  })
})
