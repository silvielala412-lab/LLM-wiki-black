import type { KnowledgeStatus } from "@/lib/knowledge-governance"
import { renderInsuranceSchemaRegistryPrompt } from "@/lib/insurance-schema-registry"

export type KnowledgeIndustry = string

export type InsuranceKnowledgeDomain =
  | "product"
  | "customer"
  | "method"
  | "content"
  | "activity"
  | "cases"
  | "compliance"
  | "general"

// Kept open so non-insurance projects and future sub-systems can add domains
// without changing the universal schema package.
export type KnowledgeDomain = string

export type UniversalEntityType =
  | "concept"
  | "entity"
  | "event"
  | "process"
  | "rule"
  | "data"
  | "comparison"
  | "timeline"
  | "case"
  | "source"
  | "query"
  | "synthesis"
  | "general"

// Business-specific type. For the insurance demo this includes product_clause,
// persona, pitch, objection_handling, etc. Keep it open for multi-agent systems.
export type KnowledgeEntityType = string

export type BusinessPhase =
  | "lead_generation"
  | "first_touch"
  | "appointment"
  | "conversion"
  | "signing"
  | "service"
  | "referral"
  | "general"

export type ClaimStatus = "confirmed" | "needs_review" | "conflict"

export interface KnowledgeClaim {
  claim_id: string
  statement: string
  raw_text: string
  source_file: string
  page_num?: number
  chunk_id?: string
  confidence: number
  status: ClaimStatus
}

export type RelationType =
  | "related_to"
  | "mentions"
  | "applies_to"
  | "recommended_for"
  | "supports"
  | "conflicts_with"
  | "updates"
  | "supersedes"
  | "governed_by"
  | "derived_from"
  | "uses_asset"
  | "has_evidence"
  | "parent_of"
  | "child_of"
  | "refines"
  | "maps_to"
  | "fills_gap_for"
  | "describes"
  | "described_by"
  | "part_of"
  | "has_part"
  | "mitigated_by"
  | "mitigates"
  | "governs"
  | "not_recommended_for"
  | "defines"
  | "defined_by"
  | "supported_by"
  | "has_recommendation"
  | "uses_pitch"
  | "used_by_pitch"
  | "uses_objection_handling"
  | "used_by_objection_handling"
  | "targets_persona"
  | "targeted_by"
  | "requires_review"
  | "review_required_by"
  | "bundled_with"
  | "complements"

export interface KnowledgeRelation {
  id: string
  source_id: string
  target_id: string
  source_path?: string
  target_path?: string
  source_title?: string
  target_title?: string
  type: RelationType
  inverse_type?: string
  bidirectional: boolean
  confidence: number
  evidence_refs: string[]
  created_at: string
  created_by: "llm" | "system" | "user"
}

export interface KnowledgeClassification {
  industry: KnowledgeIndustry
  knowledge_domain: KnowledgeDomain
  taxonomy_path: string[]
  schemes: string[]
}

export interface UniversalKnowledgeEntity {
  id: string
  dedup_key: string
  schema_version: string
  industry: KnowledgeIndustry
  knowledge_domain: KnowledgeDomain
  taxonomy_path: string[]
  type: UniversalEntityType
  entity_type: KnowledgeEntityType
  business_phase?: BusinessPhase
  title: string
  summary: string
  body: string
  keywords: string[]
  related: string[]
  parent?: string
  children?: string[]
  source_files: string[]
  source_chunks?: string[]
  confidence: number
  status: KnowledgeStatus
  needs_review: boolean
  created_at: string
  updated_at: string
  created_by: string
  tags: string[]
  attributes: Record<string, unknown>
  claims: KnowledgeClaim[]
  relations: KnowledgeRelation[]

  // Legacy compatibility for pages generated before schema v2.1.
  domain?: KnowledgeDomain
}

export const DOMAIN_LABELS: Record<string, string> = {
  product: "产品域",
  customer: "客户画像域",
  method: "销售方法域",
  content: "销售内容域",
  activity: "销售活动域",
  cases: "案例经验域",
  compliance: "合规风险域",
  general: "通用",
}

export const INSURANCE_ENTITY_TYPE_DOMAIN: Record<string, InsuranceKnowledgeDomain> = {
  product: "product",
  product_clause: "product",
  product_combo: "product",
  selling_point: "product",
  service_benefit: "product",
  coverage_rule: "product",
  persona: "customer",
  customer_persona: "customer",
  life_stage: "customer",
  customer_signal: "customer",
  selling_scenario: "method",
  pitch: "method",
  objection_handling: "method",
  sales_path: "method",
  sales_playbook: "method",
  referral_method: "method",
  asset: "content",
  asset_collection: "content",
  campaign: "activity",
  event: "activity",
  success_case: "cases",
  failure_case: "cases",
  customer_voice: "cases",
  referral_case: "cases",
  agent_feedback: "cases",
  competitive_insight: "cases",
  compliance_rule: "compliance",
  regulatory_doc: "product",
  needs_discovery: "method",
  customer_relationship: "customer",
  content_template: "content",
  presentation_kit: "content",
  incentive: "activity",
}

export const ENTITY_TYPE_DOMAIN = INSURANCE_ENTITY_TYPE_DOMAIN

export const ENTITY_TYPE_TO_UNIVERSAL_TYPE: Record<string, UniversalEntityType> = {
  source: "source",
  concept: "concept",
  entity: "entity",
  product: "entity",
  product_clause: "rule",
  product_combo: "entity",
  selling_point: "concept",
  service_benefit: "entity",
  coverage_rule: "rule",
  persona: "entity",
  customer_persona: "entity",
  life_stage: "event",
  customer_signal: "data",
  selling_scenario: "process",
  pitch: "process",
  objection_handling: "process",
  sales_path: "process",
  sales_playbook: "process",
  referral_method: "process",
  asset: "entity",
  asset_collection: "entity",
  campaign: "event",
  event: "event",
  success_case: "case",
  failure_case: "case",
  customer_voice: "data",
  referral_case: "case",
  agent_feedback: "data",
  competitive_insight: "data",
  compliance_rule: "rule",
  regulatory_doc: "source",
  needs_discovery: "process",
  customer_relationship: "entity",
  content_template: "entity",
  presentation_kit: "entity",
  incentive: "event",
}

export const RELATION_INVERSE_LABELS: Partial<Record<RelationType, string>> = {
  related_to: "related_to",
  mentions: "mentioned_by",
  applies_to: "has_applicable_item",
  recommended_for: "has_recommendation",
  supports: "supported_by",
  conflicts_with: "conflicts_with",
  updates: "updated_by",
  supersedes: "superseded_by",
  governed_by: "governs",
  derived_from: "derived_to",
  uses_asset: "used_by",
  has_evidence: "evidence_for",
  parent_of: "child_of",
  child_of: "parent_of",
  refines: "refined_by",
  maps_to: "mapped_from",
  fills_gap_for: "gap_filled_by",
  describes: "described_by",
  described_by: "describes",
  part_of: "has_part",
  has_part: "part_of",
  mitigated_by: "mitigates",
  mitigates: "mitigated_by",
  governs: "governed_by",
  not_recommended_for: "not_recommended_for",
  defines: "defined_by",
  defined_by: "defines",
  supported_by: "supports",
  has_recommendation: "recommended_for",
  uses_pitch: "used_by_pitch",
  used_by_pitch: "uses_pitch",
  uses_objection_handling: "used_by_objection_handling",
  used_by_objection_handling: "uses_objection_handling",
  targets_persona: "targeted_by",
  targeted_by: "targets_persona",
  requires_review: "review_required_by",
  review_required_by: "requires_review",
  bundled_with: "bundled_with",
  complements: "complements",
}

export const UNIVERSAL_INSURANCE_SCHEMA_PROMPT = [
  "## Universal Knowledge Schema v2.1",
  "",
  "Use a universal knowledge layer plus an insurance taxonomy layer. The first demo focuses on Product + Customer + Method, but the schema must support seven insurance domains, deeper subdomains, cross-domain links, multiple systems, and multiple agents.",
  "",
  "Every durable knowledge page must use these frontmatter fields:",
  "```yaml",
  "schema_version: \"2.1\"",
  "industry: insurance",
  "knowledge_domain: product | customer | method | content | activity | cases | compliance | general",
  "taxonomy_path: []  # path from the top insurance domain to the fine-grained subdomain, e.g. [product, service_benefit, family_doctor]",
  "type: concept | entity | event | process | rule | data | comparison | timeline | case | source",
  "entity_type: business-specific subtype, e.g. product_clause | service_benefit | persona | customer_signal | selling_scenario | pitch | objection_handling",
  "business_phase: lead_generation | first_touch | appointment | conversion | signing | service | referral | general",
  "dedup_key: stable lowercase key for cross-system identity",
  "title: Human-readable title",
  "summary: <=200 Chinese characters for retrieval",
  "keywords: []",
  "tags: []",
  "related: []",
  "relations: []",
  "parent: \"\"",
  "children: []",
  "source_files: []",
  "source_chunks: []",
  "confidence: 0.0-1.0",
  "status: candidate",
  "needs_review: true | false",
  "created_at: YYYY-MM-DD",
  "updated_at: YYYY-MM-DD",
  "created_by: system | llm | username",
  "attributes: {}",
  "claims: []",
  "```",
  "",
  "Legacy compatibility: also emit `domain` with the same value as `knowledge_domain`, and `sources` with the same filenames as `source_files` until all old pages are migrated.",
  "",
  "## Demo extraction scope",
  "",
  "Start with these three insurance knowledge domains:",
  "1. Product: product clauses, product manuals, coverage rules, responsibilities, exclusions, service benefits, eligibility, trigger conditions, waiting periods, regions, versions, and selling points.",
  "2. Customer: customer personas, life stages, observable signals, needs, objections, risk preferences, purchase triggers, and matching logic.",
  "3. Method: selling scenarios, pitches, objection handling, sales paths, playbooks, referral methods, and phase-specific execution steps.",
  "",
  "## Required relation patterns for the demo",
  "",
  "- Product selling points and service benefits should link to suitable Customer personas or signals with `recommended_for`.",
  "- Customer personas, life stages, and customer signals should point back to suitable products with `has_recommendation`; do not use `recommended_for` from Customer pages to Product pages.",
  "- Product-to-product or product-combo recommendations must use `complements`, `bundled_with`, `has_part`, or `part_of`; never use `recommended_for` for another product.",
  "- Method pitches and objection handling should link to the Product clause, service benefit, or selling point they rely on with `applies_to` or `supports`.",
  "- Selling scenarios should link to both Customer and Product pages.",
  "- Any compliance-sensitive phrase, promise, benefit, or restriction should create a `governed_by` link to a Compliance missing-page review if no compliance page exists.",
  "- If a useful target page is missing, still emit the relation target text and create a REVIEW missing-page item. This drives knowledge gap completion.",
  "- Emit one canonical relation only; the app renders the inverse relation automatically.",
  "",
  "Relation frontmatter must use compact strings for now:",
  "```yaml",
  "relations:",
  "  - recommended_for: high_income_family_persona",
  "  - applies_to: family_doctor_service_benefit",
  "  - governed_by: service_benefit_compliance_review",
  "```",
  "",
  "Allowed relation types include: related_to, mentions, applies_to, recommended_for, not_recommended_for, supports, supported_by, conflicts_with, updates, supersedes, governed_by, governs, derived_from, uses_asset, has_evidence, parent_of, child_of, refines, maps_to, fills_gap_for, describes, described_by, part_of, has_part, mitigated_by, mitigates, defines, defined_by, bundled_with, complements.",
  "",
  "Do not use `entity_type: source` for pages under wiki/entities/ or wiki/concepts/. Source documents belong under wiki/sources/ with `type: source` and `entity_type: source`.",
  "",
  "If the source filename is README, validation material, a test question file, or a quality-evaluation checklist, do not create or overwrite Product/Customer/Method business entities. Create only source, query, or general evaluation pages.",
  "",
  "## Claim guidance",
  "",
  "For important factual statements, add compact claim strings in frontmatter and quote the evidence in the page body. Future versions will migrate claims to structured objects.",
  "",
  renderInsuranceSchemaRegistryPrompt(),
].join("\n")

export function schemaGuidance(projectSchema: string): string {
  const trimmed = projectSchema.trim()
  if (!trimmed) return UNIVERSAL_INSURANCE_SCHEMA_PROMPT
  return [UNIVERSAL_INSURANCE_SCHEMA_PROMPT, "## Project Schema Override", trimmed].join("\n\n")
}
