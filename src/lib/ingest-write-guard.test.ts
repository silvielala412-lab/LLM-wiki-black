import { describe, expect, it } from "vitest"
import { shouldSkipUnsafeKnowledgeWrite } from "./ingest"

const page = (frontmatter: string, body = "# Page\n\nContent") => [
  "---",
  frontmatter.trim(),
  "---",
  "",
  body,
].join("\n")

describe("ingest write guard", () => {
  it("skips meta validation sources that try to write business entities", () => {
    const incoming = page(`
schema_version: "2.1"
industry: insurance
knowledge_domain: product
type: entity
entity_type: product
title: 安心家庭守护重疾险
source_files: ["README.md"]
sources: ["01_产品条款.md", "README.md"]
`)

    expect(shouldSkipUnsafeKnowledgeWrite(
      "wiki/entities/安心家庭守护重疾险.md",
      incoming,
      "",
    )).toContain("meta validation source")
  })

  it("skips entity pages incorrectly typed as source", () => {
    const incoming = page(`
schema_version: "2.1"
industry: insurance
knowledge_domain: product
type: entity
entity_type: source
title: 安心家庭守护重疾险
source_files: ["02_产品说明书.md"]
`)

    expect(shouldSkipUnsafeKnowledgeWrite(
      "wiki/entities/安心家庭守护重疾险.md",
      incoming,
      "",
    )).toContain("source entity_type")
  })

  it("protects existing business pages from placeholder overwrites", () => {
    const existing = page(`
schema_version: "2.1"
industry: insurance
knowledge_domain: product
type: entity
entity_type: insurance_product
title: 安心家庭守护重疾险
source_files: ["01_产品条款.md"]
`)
    const incoming = page(`
schema_version: "2.1"
industry: insurance
knowledge_domain: product
type: entity
entity_type: product
title: 安心家庭守护重疾险
source_files: ["README.md"]
`, "# 安心家庭守护重疾险\n\n这是一个知识缺口占位页面，尚未处理。")

    expect(shouldSkipUnsafeKnowledgeWrite(
      "wiki/entities/安心家庭守护重疾险.md",
      incoming,
      existing,
    )).toBeTruthy()
  })
})
