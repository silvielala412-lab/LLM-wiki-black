/**
 * HealthServiceSkill
 *
 * Domain Skill implementation for health service plans and benefits.
 * Covers entity types: service_plan, service_benefit, process, rule.
 *
 * This is the first concrete DomainSkill implementation. All logic previously
 * hardcoded in knowledge-postprocess.ts (resolveServiceBenefitParent,
 * service-specific alias maps, title normalization) now lives here.
 *
 * Future domains (life insurance, medical insurance, etc.) follow the same
 * pattern without touching the shared pipeline code.
 */

import { INSURANCE_SCHEMA_REGISTRY } from "@/lib/insurance-schema-registry"
import type { DomainSkill, PageContent, PageIndex, RelationSpec, ValidationIssue } from "@/lib/knowledge-domain-skill"
import { DomainSkillRegistry } from "@/lib/knowledge-domain-skill"
import type { RelationType } from "@/lib/knowledge-schema"

// ─── Domain detection signals ─────────────────────────────────────────────────
// Keywords that identify a health service plan document
const HEALTH_SERVICE_SIGNALS = [
  /健康服务计划/,
  /service_plan/,
  /service_benefit/,
  /臻享家医/,
  /家庭医生/,
  /在线问诊/,
  /音视频问诊/,
  /就医陪诊/,
  /重疾专案/,
]

// ─── Title normalization patterns ─────────────────────────────────────────────
// OCR errors and naming noise specific to health service plan documents
const TITLE_NORMALIZATIONS: [RegExp, string][] = [
  // OCR error: 普视频 → 音视频 (misrecognized character)
  [/普视频/g, "音视频"],
  // Suffix noise: _臻享家医, _家医, _平安臻享家医
  [/_(?:平安)?臻享家医(?:健康服务计划)?/g, ""],
  // HTML artifacts
  [/<br\s*\/?>/gi, ""],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  // Version markers in titles
  [/[（(]\d{4}年\d+月版[）)]/g, ""],
  // Trailing/leading whitespace and underscores
  [/^[_\s]+|[_\s]+$/g, ""],
]

// ─── Field aliases specific to health service domain ─────────────────────────
const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  service_benefit: {
    service_name: ["name", "title", "服务名称", "权益名称", "服务项目名称"],
    related_product: ["product", "适用产品", "关联产品"],
    service_category: [
      "category", "scene", "服务场景", "service_scene",
      "service_stage", "服务阶段",
    ],
    service_provider: [
      "provider", "提供方", "服务提供方", "服务方",
      "service_team", "团队", "服务团队",   // service_team → provider (NOT category)
    ],
    service_frequency: ["frequency", "次数", "服务次数", "使用次数", "times"],
    eligible_customers: [
      "target_customer", "target_users", "适用对象",
      "服务对象", "适用客户", "适用人群",
    ],
    application_process: ["process", "流程", "申请流程", "服务流程", "service_process"],
    coverage_scope: ["coverage", "覆盖范围", "服务范围", "scope"],
    service_limits: [
      "limits", "限制", "使用限制", "服务限制",
      "service_content", "sharing_rule",
    ],
    time_limits: [
      "time_limit", "时效", "时限", "response_timeliness",
      "response_time", "完成时效", "响应时效", "appointment_timeline",
    ],
    compliance_notes: ["disclaimer", "免责", "合规提示", "合规说明", "compliance"],
    core_value: ["value", "核心价值", "权益价值"],
  },
  service_plan: {
    plan_name: ["name", "plan_title", "计划名称", "服务计划名称", "服务包名称"],
    plan_version: ["version", "year", "版本", "年份", "版本号"],
    service_scope: ["scope", "服务范围", "权益范围", "服务内容"],
    eligible_customers: ["target_users", "target_customer", "适用对象", "服务对象"],
    activation_conditions: ["activation", "激活条件", "领取条件", "开通条件"],
    service_period: ["period", "服务期限", "有效期", "服务期"],
    service_provider: ["provider", "服务提供方", "服务方"],
    compliance_notes: ["disclaimer", "免责条款", "合规说明"],
  },
  process: {
    process_name: ["name", "title", "流程名称"],
    service_name: ["service", "关联服务"],
  },
}

// ─── Entity types owned by this skill ────────────────────────────────────────
const OWNED_ENTITY_TYPES = new Set([
  "service_plan",
  "service_benefit",
  "process",
  "rule",
])

// Entities where the parent is the service_plan
const CHILD_ENTITY_TYPES_WITH_PLAN_PARENT = new Set([
  "service_benefit",
  "process",
])

// ─── Query affinity: intent → preferred relation types ────────────────────────
const QUERY_AFFINITY: Record<string, RelationType[]> = {
  service_usage: ["part_of", "has_part", "governed_by", "prerequisite"],
  compliance: ["governed_by", "complies_with", "part_of"],
  customer_eligibility: ["recommended_for", "part_of"],
  activation: ["prerequisite", "part_of", "governed_by"],
}

// ─── Helper: normalize titles ─────────────────────────────────────────────────
function normalizeTitle(input: string): string {
  let result = input
  for (const [pattern, replacement] of TITLE_NORMALIZATIONS) {
    result = result.replace(pattern, replacement)
  }
  return result.trim()
}

// ─── Helper: fuzzy title matching ────────────────────────────────────────────
function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-·•]+/g, "").replace(/[（()）]/g, "")
}

function buildNormalizedForms(title: string): string[] {
  const forms = new Set<string>()
  const clean = title.trim()
  forms.add(normalizeForMatch(clean))
  forms.add(normalizeForMatch(clean.replace(/[_\s]*(服务计划|健康服务计划|服务手册|健康服务|服务权益|权益|服务)$/, "")))
  forms.add(normalizeForMatch(clean.replace(/[（(][^）)]+[）)]/g, "")))
  forms.add(normalizeForMatch(clean.replace(/_[^_]+$/, "")))
  return Array.from(forms).filter(Boolean)
}

function resolveTargetPage(rawTarget: string, index: PageIndex[]): PageIndex | null {
  const exact = index.find((p) => p.title === rawTarget)
  if (exact) return exact
  const normalized = normalizeForMatch(rawTarget)
  if (!normalized) return null
  const fuzzy = index.find((p) => p.normalizedForms.includes(normalized))
  if (fuzzy) return fuzzy
  const prefix = index.find((p) =>
    p.normalizedForms.some((form) => normalized.startsWith(form) || form.startsWith(normalized))
  )
  return prefix ?? null
}

// ─── HealthServiceSkill implementation ───────────────────────────────────────

class HealthServiceSkill implements DomainSkill {
  readonly domainId = "health_service"
  readonly label = "健康服务计划"

  get schemas() {
    return INSURANCE_SCHEMA_REGISTRY.filter((s) => OWNED_ENTITY_TYPES.has(s.entityType))
  }

  get fieldAliases() {
    return FIELD_ALIASES
  }

  detectDomain(content: string): number {
    let hits = 0
    for (const signal of HEALTH_SERVICE_SIGNALS) {
      if (signal.test(content)) hits++
    }
    // Normalize: max 3 signals = confidence 1.0
    return Math.min(1, hits / 3)
  }

  normalizeTitle(input: string): string {
    return normalizeTitle(input)
  }

  /**
   * Resolve the canonical parent for a child entity.
   *
   * Fixes the PA0526-02 issue where:
   * 1. resolveServiceBenefitParent only checked entityType === "product"
   *    but the plan entity is now service_plan.
   * 2. When related_product is empty/unresolvable, 9 service_benefit pages
   *    had no part_of relation because the fallback didn't find the plan.
   */
  resolveParent(
    childEntityType: string,
    rawParentValue: string,
    index: PageIndex[],
  ): string | null {
    if (!CHILD_ENTITY_TYPES_WITH_PLAN_PARENT.has(childEntityType)) return null

    // 1. Try exact/fuzzy resolution
    const resolved = resolveTargetPage(rawParentValue, index)
    if (resolved && (resolved.entityType === "service_plan" || resolved.entityType === "product")) {
      return resolved.title
    }

    // 2. If rawParentValue looks like a source doc (手册/manual/pdf), fall back
    //    to the single plan in the index
    if (/服务手册|手册|source|\\.pdf$/i.test(rawParentValue)) {
      const plans = index.filter((p) => p.entityType === "service_plan")
      if (plans.length === 1) return plans[0].title
      const products = index.filter((p) => p.entityType === "product")
      if (products.length === 1) return products[0].title
    }

    // 3. Fuzzy partial match against plan/product pages
    const normalized = normalizeForMatch(rawParentValue)
    const parentCandidates = index.filter(
      (p) => p.entityType === "service_plan" || p.entityType === "product"
    )
    const match = parentCandidates.find((p) =>
      p.normalizedForms.some((form) => normalized.startsWith(form) || form.startsWith(normalized))
    )
    if (match) return match.title

    // 4. Last resort: if there's only ONE service_plan in the entire index
    //    and the rawParentValue is non-empty but unresolvable, use the plan.
    //    This covers cases like related_product: "" or some garbled OCR value.
    const allPlans = index.filter((p) => p.entityType === "service_plan")
    if (allPlans.length === 1) return allPlans[0].title

    return null
  }

  /**
   * Infer missing relations for health service pages.
   * Currently handles: service_benefit / process → part_of service_plan
   */
  inferRelations(page: PageContent, index: PageIndex[]): RelationSpec[] {
    const results: RelationSpec[] = []

    if (!CHILD_ENTITY_TYPES_WITH_PLAN_PARENT.has(page.entityType)) return results

    // Find the parent value from the page's attributes
    const parentAttrField = page.entityType === "service_benefit" ? "related_product" : "service_name"
    const rawParentValue = String(page.attributes[parentAttrField] ?? "")

    const parentTitle = this.resolveParent(page.entityType, rawParentValue, index)
    if (!parentTitle) return results

    results.push({
      type: "part_of",
      targetTitle: parentTitle,
    })
    return results
  }

  /**
   * Validate a health service page after materialization.
   * Returns issues for audit reporting.
   */
  validate(page: PageContent): ValidationIssue[] {
    const issues: ValidationIssue[] = []

    if (page.entityType === "service_benefit") {
      if (!page.attributes["service_name"]) {
        issues.push({
          field: "service_name",
          severity: "error",
          message: "service_name is required for service_benefit",
        })
      }
      if (!page.attributes["related_product"]) {
        issues.push({
          field: "related_product",
          severity: "warning",
          message: "related_product is empty — part_of relation may not be inferred",
        })
      }
    }

    if (page.entityType === "service_plan") {
      if (!page.attributes["plan_name"]) {
        issues.push({
          field: "plan_name",
          severity: "error",
          message: "plan_name is required for service_plan",
        })
      }
    }

    return issues
  }

  readonly queryAffinity = QUERY_AFFINITY
}

// ─── Auto-register ────────────────────────────────────────────────────────────
// Import this module once and the skill is available to all pipeline stages.
const healthServiceSkill = new HealthServiceSkill()
DomainSkillRegistry.register(healthServiceSkill)

export { healthServiceSkill, HealthServiceSkill }
