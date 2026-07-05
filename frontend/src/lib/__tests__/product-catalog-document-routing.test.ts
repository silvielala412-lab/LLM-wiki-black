import { describe, expect, it } from "vitest"

import {
  documentScopedSource,
  isProductDescriptionDocumentName,
  isQaDocumentName,
} from "../product-catalog-extractor"

describe("product catalog document routing", () => {
  it("only recognizes explicit QA documents", () => {
    expect(isQaDocumentName("平安e生保产品QA.pdf")).toBe(true)
    expect(isQaDocumentName("常见问答手册.docx")).toBe(true)
    expect(isQaDocumentName("产品说明书.pdf")).toBe(false)
    expect(isQaDocumentName("保险条款.pdf")).toBe(false)
  })

  it("recognizes product description documents for product features", () => {
    expect(isProductDescriptionDocumentName("产品说明书.pdf")).toBe(true)
    expect(isProductDescriptionDocumentName("产品手册-2026.pdf")).toBe(true)
    expect(isProductDescriptionDocumentName("保险条款.pdf")).toBe(false)
  })

  it("keeps only matching files and their source references", () => {
    const source = [
      "<!-- PRODUCT_SOURCE_BEGIN: 产品说明书.pdf -->",
      "路径：raw/product/产品说明书.pdf",
      "产品特色：住院保障。",
      "<!-- PRODUCT_SOURCE_END: 产品说明书.pdf -->",
      "<!-- PRODUCT_SOURCE_BEGIN: 产品QA.pdf -->",
      "路径：raw/product/产品QA.pdf",
      "Q：是否保证续保？\nA：以产品约定为准。",
      "<!-- PRODUCT_SOURCE_END: 产品QA.pdf -->",
    ].join("\n")

    const selected = documentScopedSource(source, "bundle", isQaDocumentName)
    expect(selected.content).toContain("是否保证续保")
    expect(selected.content).not.toContain("产品特色")
    expect(selected.refs).toEqual(["raw/product/产品QA.pdf"])
  })

  it("accepts an explicit document_type hint when the filename is generic", () => {
    const source = [
      "<!-- PRODUCT_SOURCE_BEGIN: 资料01.pdf -->",
      "路径：raw/product/资料01.pdf",
      "文档类型：产品QA",
      "Q：可以续保吗？\nA：按产品约定执行。",
      "<!-- PRODUCT_SOURCE_END: 资料01.pdf -->",
    ].join("\n")

    const selected = documentScopedSource(source, "bundle", isQaDocumentName)
    expect(selected.content).toContain("可以续保吗")
    expect(selected.refs).toEqual(["raw/product/资料01.pdf"])
  })
})
