import { describe, expect, it } from "vitest"

import { parseProductModuleTitle } from "../product-catalog-modules"

describe("parseProductModuleTitle", () => {
  it("keeps field pages under the original product", () => {
    expect(parseProductModuleTitle("医疗险-平安e生保（加享版）医疗保险-字段-投保年龄")).toEqual({
      category: "医疗险",
      productName: "平安e生保（加享版）医疗保险",
      moduleName: "字段-投保年龄",
    })
  })

  it("supports product names containing hyphens", () => {
    expect(parseProductModuleTitle("医疗险-平安e生保-2026-投保年龄")).toEqual({
      category: "医疗险",
      productName: "平安e生保-2026",
      moduleName: "投保年龄",
    })
  })

  it("recognizes the product overview page", () => {
    expect(parseProductModuleTitle("医疗险-平安e生保（加享版）医疗保险")).toEqual({
      category: "医疗险",
      productName: "平安e生保（加享版）医疗保险",
      moduleName: "",
    })
  })
})
