import { describe, expect, it } from "vitest"
import { cleanupKnowledgeFrontmatter } from "./knowledge-frontmatter-cleanup"

describe("knowledge frontmatter cleanup", () => {
  it("deduplicates repeated list/scalar fields and preserves meaningful values", () => {
    const cleaned = cleanupKnowledgeFrontmatter([
      "---",
      "schema_version: \"2.1\"",
      "knowledge_domain: product",
      "type: concept",
      "entity_type: selling_point",
      "title: 家庭医生在线咨询服务",
      "tags: [服务权益]",
      "relations:",
      "  - applies_to: 安心家庭守护重疾险",
      "status: active",
      "tags: []",
      "relations: []",
      "status: candidate",
      "attributes: {\"point_name\":\"家庭医生在线咨询服务\"}",
      "ingested_by: file-upload",
      "---",
      "# 家庭医生在线咨询服务",
      "服务权益，不承诺诊断结果。",
    ].join("\n"))

    expect(cleaned).toContain("entity_type: service_benefit")
    expect(cleaned).toContain("knowledge_domain: product")
    expect(cleaned).toContain("status: candidate")
    expect(cleaned).toContain('tags: ["服务权益"]')
    expect(cleaned).toContain('relations:\n  - "applies_to:')
    expect(cleaned.match(/^tags:/gm)).toHaveLength(1)
    expect(cleaned.match(/^relations:/gm)).toHaveLength(1)
    expect(cleaned.match(/^status:/gm)).toHaveLength(1)
  })

  it("rewrites product-to-product recommended_for into complements", () => {
    const cleaned = cleanupKnowledgeFrontmatter([
      "---",
      "schema_version: \"2.1\"",
      "knowledge_domain: product",
      "entity_type: product",
      "type: entity",
      "title: 安心家庭守护重疾险",
      "relations:",
      "  - recommended_for: 百万医疗险",
      "  - recommended_for: 家庭经济支柱",
      "attributes: {}",
      "---",
      "# 安心家庭守护重疾险",
    ].join("\n"))

    expect(cleaned).toContain("complements: 百万医疗险")
    expect(cleaned).toContain("recommended_for: 家庭经济支柱")
  })

  it("forces ingested pages to candidate and mirrors source_files into sources", () => {
    const cleaned = cleanupKnowledgeFrontmatter([
      "---",
      "schema_version: \"2.1\"",
      "knowledge_domain: method",
      "entity_type: objection_handling",
      "type: process",
      "title: 我已经有医保了",
      "source_files: [\"05_销售方法.md\"]",
      "sources: []",
      "status: \"active\"",
      "ingested_by: file-upload",
      "---",
      "# 我已经有医保了",
    ].join("\n"))

    expect(cleaned).toContain("status: candidate")
    expect(cleaned).toContain('sources: ["05_销售方法.md"]')
  })

  it("rewrites customer-to-product recommendations and non-compliance governed_by links", () => {
    const cleaned = cleanupKnowledgeFrontmatter([
      "---",
      "schema_version: \"2.1\"",
      "knowledge_domain: customer",
      "entity_type: persona",
      "type: entity",
      "title: 家庭经济支柱",
      "relations:",
      "  - recommended_for: 安心家庭守护重疾险",
      "  - governed_by: 家庭现金流中断风险",
      "related: [家庭支柱]",
      "attributes: {}",
      "---",
      "# 家庭经济支柱",
    ].join("\n"))

    expect(cleaned).toContain("has_recommendation: 安心家庭守护重疾险")
    expect(cleaned).toContain("supported_by: 家庭现金流中断风险")
    expect(cleaned).toContain('related: ["家庭经济支柱"]')
  })

  it("keeps selling points from being classified as objection handling", () => {
    const cleaned = cleanupKnowledgeFrontmatter([
      "---",
      "schema_version: \"2.1\"",
      "knowledge_domain: method",
      "entity_type: objection_handling",
      "type: process",
      "title: 家庭现金流保护",
      "attributes: {\"core_value\":\"重疾险确诊后赔付的一笔钱可保护家庭现金流\",\"point_name\":\"家庭现金流保护\"}",
      "---",
      "# 家庭现金流保护",
      "这是一个核心卖点。",
    ].join("\n"))

    expect(cleaned).toContain("entity_type: selling_point")
    expect(cleaned).toContain("knowledge_domain: product")
  })

  it("materializes attributes knowledge_gaps into the markdown body", () => {
    const cleaned = cleanupKnowledgeFrontmatter([
      "---",
      "schema_version: \"2.1\"",
      "knowledge_domain: product",
      "entity_type: product",
      "type: entity",
      "title: 安心家庭守护重疾险",
      "attributes: {\"knowledge_gaps\":[\"regulatory_filing_no\",\"费率表\"]}",
      "---",
      "# 安心家庭守护重疾险",
      "",
      "## 产品定位",
      "",
      "这是产品说明。",
    ].join("\n"))

    expect(cleaned).toContain("## 缺失知识 / 待补全信息")
    expect(cleaned).toContain("- regulatory_filing_no")
    expect(cleaned).toContain("- 费率表")
  })
})
