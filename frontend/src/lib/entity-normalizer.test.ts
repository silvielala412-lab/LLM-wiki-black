import { describe, expect, it } from "vitest"
import { inferBusinessSignature } from "./entity-normalizer"

const page = (frontmatter: string, body: string) => [
  "---",
  frontmatter.trim(),
  "---",
  "",
  body,
].join("\n")

describe("entity normalizer business signature", () => {
  it("does not classify a life stage as the product just because the body mentions the product", () => {
    const content = page(`
schema_version: "2.1"
entity_type: life_stage
title: 父母养老阶段
`, "父母养老阶段可能关联安心家庭守护重疾险，但它不是产品实体。")

    expect(inferBusinessSignature(content, "父母养老阶段")).toBe("")
  })

  it("classifies the actual product by entity type and title", () => {
    const content = page(`
schema_version: "2.1"
entity_type: product
title: 安心家庭守护重疾险
`, "产品定位、基础规则、核心保障。")

    expect(inferBusinessSignature(content, "安心家庭守护重疾险")).toBe(
      "product.anxin_family_guard_critical_illness",
    )
  })

  it("does not classify a generic method page as an objection by body-only keywords", () => {
    const content = page(`
schema_version: "2.1"
entity_type: selling_scenario
title: 家庭现金流保护
`, "场景中可能出现医保和保费太贵等异议，需要后续处理。")

    expect(inferBusinessSignature(content, "家庭现金流保护")).toBe("")
  })
})
