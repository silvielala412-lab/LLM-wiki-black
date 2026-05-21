import { describe, expect, it } from "vitest"
import {
  normalizeSchemaFrontmatter,
  shouldNormalizeKnowledgePage,
} from "./knowledge-schema-normalizer"

describe("knowledge schema normalizer", () => {
  it("adds missing universal fields to a generated wiki page", () => {
    const normalized = normalizeSchemaFrontmatter(
      [
        "---",
        "type: concept",
        "title: 家庭医生服务流程",
        "---",
        "",
        "# 家庭医生服务流程",
        "",
        "正文",
      ].join("\n"),
      { relativePath: "wiki/concepts/family-doctor.md", defaultStatus: "candidate" },
    )

    expect(normalized).toContain('schema_version: "2.1"')
    expect(normalized).toContain('industry: "insurance"')
    expect(normalized).toContain('knowledge_domain: "general"')
    expect(normalized).toContain('domain: "general"')
    expect(normalized).toContain('taxonomy_path: ["concept"]')
    expect(normalized).toContain('entity_type: "concept"')
    expect(normalized).toContain('business_phase: "general"')
    expect(normalized).toContain('dedup_key: "family-doctor"')
    expect(normalized).toContain("source_files: []")
    expect(normalized).toContain("relations: []")
    expect(normalized).toContain('status: "candidate"')
    expect(normalized).toContain("needs_review: true")
    expect(normalized).toContain("attributes: {}")
    expect(normalized).toContain("claims: []")
  })

  it("preserves explicit classification fields", () => {
    const normalized = normalizeSchemaFrontmatter(
      [
        "---",
        "type: process",
        "industry: insurance",
        "knowledge_domain: product",
        "domain: product",
        "entity_type: selling_point",
        "business_phase: conversion",
        "status: active",
        "confidence: 0.95",
        "---",
        "",
        "# 高端医疗卖点",
      ].join("\n"),
      { relativePath: "wiki/entities/high-medical.md" },
    )

    expect(normalized).toContain("industry: insurance")
    expect(normalized).toContain("knowledge_domain: product")
    expect(normalized).toContain("domain: product")
    expect(normalized).toContain("entity_type: selling_point")
    expect(normalized).toContain("type: process")
    expect(normalized).toContain("business_phase: conversion")
    expect(normalized).toContain("status: active")
    expect(normalized).toContain("confidence: 0.95")
  })

  it("identifies structural pages that should not be normalized", () => {
    expect(shouldNormalizeKnowledgePage("wiki/index.md")).toBe(false)
    expect(shouldNormalizeKnowledgePage("wiki/log.md")).toBe(false)
    expect(shouldNormalizeKnowledgePage("wiki/overview.md")).toBe(false)
    expect(shouldNormalizeKnowledgePage("wiki/entities/product.md")).toBe(true)
  })
})
