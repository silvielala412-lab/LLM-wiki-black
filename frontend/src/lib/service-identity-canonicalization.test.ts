import { describe, it, expect } from "vitest"
import {
  canonicalServiceIdentityName,
  stripBrandSuffix,
  inferStableInsuranceDedupKey,
} from "@/lib/insurance-schema-registry"

// ─── stripBrandSuffix ─────────────────────────────────────────────────────────

describe("stripBrandSuffix", () => {
  it("strips 臻享家医 suffix with underscore separator", () => {
    expect(stripBrandSuffix("音视频问诊_臻享家医")).toBe("音视频问诊")
  })

  it("strips 平安臻享 suffix with underscore separator", () => {
    expect(stripBrandSuffix("就医陪诊_平安臻享家医")).toBe("就医陪诊")
  })

  it("strips 绿通 suffix (not 绡通)", () => {
    expect(stripBrandSuffix("住院安排协助_绿通")).toBe("住院安排协助")
  })

  it("strips suffix with full-width parentheses", () => {
    expect(stripBrandSuffix("特色体检服务（臻享家医）")).toBe("特色体检服务")
  })

  it("strips 平安健康 suffix", () => {
    expect(stripBrandSuffix("重疾专案管理_平安健康")).toBe("重疾专案管理")
  })

  it("leaves discriminator words intact — 门诊 is NOT a brand suffix", () => {
    expect(stripBrandSuffix("康复门诊协助")).toBe("康复门诊协助")
  })

  it("leaves titles without brand suffix unchanged", () => {
    expect(stripBrandSuffix("家庭医生服务")).toBe("家庭医生服务")
  })

  it("returns empty string for empty input", () => {
    expect(stripBrandSuffix("")).toBe("")
  })
})

// ─── canonicalServiceIdentityName ────────────────────────────────────────────

describe("canonicalServiceIdentityName", () => {
  // Brand suffix stripping
  it("音视频问诊_臻享家医 → 音视频问诊", () => {
    expect(canonicalServiceIdentityName("音视频问诊_臻享家医")).toBe("音视频问诊")
  })

  it("就医陪诊_平安臻享家医 → 就医陪诊", () => {
    expect(canonicalServiceIdentityName("就医陪诊_平安臻享家医")).toBe("就医陪诊")
  })

  // Confirmed synonyms → should merge
  it("家庭医生 → 家庭医生服务 (confirmed synonym)", () => {
    expect(canonicalServiceIdentityName("家庭医生")).toBe("家庭医生服务")
  })

  it("家庭医生服务权益 → 家庭医生服务 (confirmed synonym)", () => {
    expect(canonicalServiceIdentityName("家庭医生服务权益")).toBe("家庭医生服务")
  })

  it("重疾专案 → 重疾专案管理 (confirmed synonym)", () => {
    expect(canonicalServiceIdentityName("重疾专案")).toBe("重疾专案管理")
  })

  it("21天训练营 → 21天社群训练营 (confirmed synonym)", () => {
    expect(canonicalServiceIdentityName("21天训练营")).toBe("21天社群训练营")
  })

  // Sibling services → discriminator protection, must NOT merge
  it("康复门诊协助 → stays as-is (discriminator: 门诊)", () => {
    expect(canonicalServiceIdentityName("康复门诊协助")).toBe("康复门诊协助")
  })

  it("康复住院协助 → stays as-is (discriminator: 住院)", () => {
    expect(canonicalServiceIdentityName("康复住院协助")).toBe("康复住院协助")
  })

  it("音视频首访 → stays as-is (discriminator: 首访)", () => {
    expect(canonicalServiceIdentityName("音视频首访")).toBe("音视频首访")
  })

  it("音视频随访 → stays as-is (discriminator: 随访)", () => {
    expect(canonicalServiceIdentityName("音视频随访")).toBe("音视频随访")
  })

  it("国内住院安排协助 → stays as-is (discriminator: 国内 + 住院)", () => {
    expect(canonicalServiceIdentityName("国内住院安排协助")).toBe("国内住院安排协助")
  })

  it("海外重疾住院安排协助 → stays as-is (discriminator: 海外 + 住院)", () => {
    expect(canonicalServiceIdentityName("海外重疾住院安排协助")).toBe("海外重疾住院安排协助")
  })

  it("体检报告解读 → stays as-is (discriminator: 解读)", () => {
    expect(canonicalServiceIdentityName("体检报告解读")).toBe("体检报告解读")
  })

  // Chain: brand strip then synonym
  it("家庭医生_臻享家医 → 家庭医生服务 (strip then synonym)", () => {
    expect(canonicalServiceIdentityName("家庭医生_臻享家医")).toBe("家庭医生服务")
  })

  it("重疾专案_平安健康 → 重疾专案管理 (strip then synonym)", () => {
    expect(canonicalServiceIdentityName("重疾专案_平安健康")).toBe("重疾专案管理")
  })
})

// ─── inferStableInsuranceDedupKey (service_benefit) ─────────────────────────

describe("inferStableInsuranceDedupKey — service_benefit", () => {
  const base = { entityType: "service_benefit", title: "", attributes: {} }

  it("service_name with brand suffix produces same dedup key as canonical name", () => {
    const withBrand = inferStableInsuranceDedupKey({
      ...base,
      title: "音视频问诊_臻享家医",
      attributes: { related_product: "臻享家医", service_name: "音视频问诊_臻享家医" },
    })
    const canonical = inferStableInsuranceDedupKey({
      ...base,
      title: "音视频问诊",
      attributes: { related_product: "臻享家医", service_name: "音视频问诊" },
    })
    expect(withBrand).toBe(canonical)
  })

  it("家庭医生 and 家庭医生服务 produce the same dedup key", () => {
    const short = inferStableInsuranceDedupKey({
      ...base,
      title: "家庭医生",
      attributes: { related_product: "臻享家医", service_name: "家庭医生" },
    })
    const full = inferStableInsuranceDedupKey({
      ...base,
      title: "家庭医生服务",
      attributes: { related_product: "臻享家医", service_name: "家庭医生服务" },
    })
    expect(short).toBe(full)
  })

  it("重疾专案 and 重疾专案管理 produce the same dedup key", () => {
    const short = inferStableInsuranceDedupKey({
      ...base,
      title: "重疾专案",
      attributes: { related_product: "产品A", service_name: "重疾专案" },
    })
    const full = inferStableInsuranceDedupKey({
      ...base,
      title: "重疾专案管理",
      attributes: { related_product: "产品A", service_name: "重疾专案管理" },
    })
    expect(short).toBe(full)
  })

  it("康复门诊协助 and 康复住院协助 produce DIFFERENT dedup keys (sibling protection)", () => {
    const outpatient = inferStableInsuranceDedupKey({
      ...base,
      title: "康复门诊协助",
      attributes: { related_product: "产品A", service_name: "康复门诊协助" },
    })
    const inpatient = inferStableInsuranceDedupKey({
      ...base,
      title: "康复住院协助",
      attributes: { related_product: "产品A", service_name: "康复住院协助" },
    })
    expect(outpatient).not.toBe(inpatient)
  })

  it("音视频首访 and 音视频随访 produce DIFFERENT dedup keys (sibling protection)", () => {
    const first = inferStableInsuranceDedupKey({
      ...base,
      title: "音视频首访",
      attributes: { service_name: "音视频首访" },
    })
    const followup = inferStableInsuranceDedupKey({
      ...base,
      title: "音视频随访",
      attributes: { service_name: "音视频随访" },
    })
    expect(first).not.toBe(followup)
  })
})
