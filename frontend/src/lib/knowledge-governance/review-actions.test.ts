import { describe, expect, it } from "vitest"
import { buildMergedReviewContent } from "./review-actions"

describe("buildMergedReviewContent", () => {
  const existing = [
    "---",
    "title: 旧产品页",
    'sources: ["旧条款.md"]',
    "status: active",
    "---",
    "# 旧产品页",
    "",
    "旧页面原有正文。",
    "",
  ].join("\n")

  const incoming = [
    "---",
    "title: 新补充页",
    'sources: ["新说明书.md", "旧条款.md"]',
    "status: candidate",
    "---",
    "# 新补充页",
    "",
    "新增保障责任说明。",
    "",
    "新增服务权益说明。",
    "",
  ].join("\n")

  it("preserves existing body and appends the new body under a review marker", () => {
    const merged = buildMergedReviewContent(existing, incoming, "新补充页")

    expect(merged).toContain("旧页面原有正文。")
    expect(merged).toContain("## 审核合并补充：新补充页")
    expect(merged).toContain("新增保障责任说明。")
    expect(merged).toContain("新增服务权益说明。")
    expect(merged).not.toContain("# 新补充页\n\n新增保障责任说明。")
  })

  it("merges source files onto the existing page", () => {
    const merged = buildMergedReviewContent(existing, incoming, "新补充页")

    expect(merged).toContain('sources: ["旧条款.md", "新说明书.md"]')
  })

  it("does not append the same merged section twice", () => {
    const once = buildMergedReviewContent(existing, incoming, "新补充页")
    const twice = buildMergedReviewContent(once, incoming, "新补充页")

    expect(twice.match(/## 审核合并补充：新补充页/g)).toHaveLength(1)
  })
})
