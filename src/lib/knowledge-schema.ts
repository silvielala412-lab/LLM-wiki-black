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
  | "next_step"
  | "same_stage"
  // ── Field-derived lateral relations (FIELD_DERIVED provenance) ──────────────
  // These are inferred from structural fields, not from LLM output.
  // Lower score than explicit relations; used for candidate expansion only.
  | "same_category"          // same service_category value
  | "same_scene"             // same service_scene value
  | "adjacent_in_process"    // same business_phase / sequential in process
  // ── Identity resolution relations (IDENTITY_PASS provenance) ─────────────
  // Written by the Identity Pass after LLM judgment on candidate pairs.
  | "alias_of"               // different name, same service / concept
  | "sibling_of"             // same family, distinct sub-service

/**
 * Provenance of a relation edge: how was it created?
 * This drives confidence weighting and lets agents filter by trust level.
 *
 * Layer mapping (Codex design):
 *   explicit        → Layer 1 (frontmatter relations: / human review)
 *   field_derived   → Layer 2 (structural field matching: service_category, service_scene, etc.)
 *   wikilink        → Layer 2.5 (body [[wikilink]] co-mention)
 *   llm_inferred    → Layer 4 (postprocess LLM semantic pass on candidate pairs)
 *   user_confirmed  → Layer 1 (human override — highest trust)
 */
export type RelationProvenance =
  | "explicit"           // frontmatter relations: list or schema-inferred structural fact
  | "explicit_ingest"    // LLM declared at ingest time from source evidence (relation_candidates)
  | "postprocess_inferred" // structural inference during postprocess (e.g. part_of from related_product)
  | "field_derived"      // computed from matching field values (same_category, same_scene, etc.)
  | "wikilink"           // body [[wikilink]] co-mention
  | "llm_inferred"       // postprocess LLM semantic pass (must carry confidence + reason)
  | "user_confirmed"     // human-annotated or human-approved

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
  /**
   * confidence: factual reliability of this relation edge.
   * "Is this relation actually true?" — determined by evidence quality and source.
   * Range 0.0–1.0.
   */
  confidence: number
  /**
   * strength: business importance of this relation type for reasoning/retrieval.
   * "How much should RAG/Agent weight this edge when expanding the graph?"
   * Determined by relation type semantics, not evidence. Range 0.0–1.0.
   */
  strength: number
  /**
   * Composite retrieval score for graph expansion priority.
   * score = confidence * strength. Pre-computed to avoid recalculation.
   */
  score: number
  evidence_refs: string[]
  created_at: string
  /** @deprecated use provenance instead; kept for backward compatibility */
  created_by: "llm" | "system" | "user"
  /**
   * Provenance: which layer produced this edge.
   * Agents can filter by provenance to control trust level.
   * e.g. minProvenance: ["explicit", "user_confirmed"] for high-trust path only.
   */
  provenance?: RelationProvenance
  /**
   * For llm_inferred edges only: reason string from the LLM that produced this edge.
   * Enables transparency and debugging of inferred relations.
   */
  inferred_reason?: string
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
  next_step: "previous_step",
  same_stage: "same_stage",
  same_category: "same_category",
  same_scene: "same_scene",
  adjacent_in_process: "adjacent_in_process",
  alias_of: "alias_of",
  sibling_of: "sibling_of",
}

// ─── Relation Scoring Constants ───────────────────────────────────────────────
// These constants encode the four-layer schema's relation layer contract.
// Used at index-build time (knowledge-relation-index.ts) and by the RAG API.

/**
 * Confidence modifier by relation provenance layer.
 * Governance Layer (Layer 4): source metadata → confidence modifier.
 * Ordered from highest to lowest trust.
 */
export const RELATION_SOURCE_CONFIDENCE: Record<"system" | "llm" | "user" | RelationProvenance, number> = {
  // Legacy created_by values (backward compat)
  system: 1.00,
  user:   1.00,
  llm:    0.85,
  // New provenance levels (ordered highest → lowest trust)
  user_confirmed:        1.00, // human ground truth
  explicit_ingest:       0.92, // LLM declared at ingest time from source document evidence
  explicit:              0.92, // frontmatter schema-declared or postprocess structural fact
  postprocess_inferred:  0.88, // structural inference in postprocess (e.g. part_of from related_product)
  llm_inferred:          0.70, // LLM semantic judgment on candidate pair
  field_derived:         0.55, // structural field match — plausible but not confirmed
  wikilink:              0.45, // body co-mention — weak signal
}

/**
 * Per-relation-type base scores.
 * confidence_base: reliability of this relation type as a fact.
 * strength: business importance for RAG/Agent graph expansion.
 * Relation Layer (Layer 3): type semantics → retrieval weight
 */
export const RELATION_TYPE_SCORES: Record<RelationType, { confidence_base: number; strength: number }> = {
  // Structural composition
  part_of:               { confidence_base: 0.95, strength: 0.95 },
  has_part:              { confidence_base: 0.95, strength: 0.95 },
  parent_of:             { confidence_base: 0.92, strength: 0.90 },
  child_of:              { confidence_base: 0.92, strength: 0.90 },
  // Regulatory / compliance
  governed_by:           { confidence_base: 0.90, strength: 0.92 },
  governs:               { confidence_base: 0.90, strength: 0.92 },
  defines:               { confidence_base: 0.88, strength: 0.85 },
  defined_by:            { confidence_base: 0.88, strength: 0.85 },
  mitigates:             { confidence_base: 0.85, strength: 0.80 },
  mitigated_by:          { confidence_base: 0.85, strength: 0.80 },
  not_recommended_for:   { confidence_base: 0.85, strength: 0.75 },
  // Evidence / provenance
  has_evidence:          { confidence_base: 0.88, strength: 0.82 },
  derived_from:          { confidence_base: 0.85, strength: 0.80 },
  described_by:          { confidence_base: 0.82, strength: 0.75 },
  describes:             { confidence_base: 0.82, strength: 0.75 },
  // Business application
  applies_to:            { confidence_base: 0.82, strength: 0.85 },
  recommended_for:       { confidence_base: 0.80, strength: 0.82 },
  has_recommendation:    { confidence_base: 0.80, strength: 0.82 },
  targets_persona:       { confidence_base: 0.80, strength: 0.80 },
  targeted_by:           { confidence_base: 0.80, strength: 0.80 },
  // Sales / method
  supports:              { confidence_base: 0.78, strength: 0.75 },
  supported_by:          { confidence_base: 0.78, strength: 0.75 },
  uses_pitch:            { confidence_base: 0.82, strength: 0.80 },
  used_by_pitch:         { confidence_base: 0.82, strength: 0.80 },
  uses_objection_handling:      { confidence_base: 0.82, strength: 0.80 },
  used_by_objection_handling:   { confidence_base: 0.82, strength: 0.80 },
  uses_asset:            { confidence_base: 0.78, strength: 0.72 },
  fills_gap_for:         { confidence_base: 0.75, strength: 0.70 },
  // Product / versioning
  complements:           { confidence_base: 0.78, strength: 0.75 },
  next_step:             { confidence_base: 0.82, strength: 0.82 },
  same_stage:            { confidence_base: 0.76, strength: 0.72 },
  bundled_with:          { confidence_base: 0.80, strength: 0.78 },
  supersedes:            { confidence_base: 0.88, strength: 0.85 },
  updates:               { confidence_base: 0.85, strength: 0.82 },
  refines:               { confidence_base: 0.78, strength: 0.72 },
  maps_to:               { confidence_base: 0.75, strength: 0.68 },
  conflicts_with:        { confidence_base: 0.82, strength: 0.78 },
  // Governance
  requires_review:       { confidence_base: 0.90, strength: 0.60 },
  review_required_by:    { confidence_base: 0.90, strength: 0.60 },
  // Soft / supplementary
  related_to:            { confidence_base: 0.60, strength: 0.45 },
  mentions:              { confidence_base: 0.70, strength: 0.35 },
  // Field-derived lateral (FIELD_DERIVED layer) — lower scores keep them below explicit edges
  same_category:         { confidence_base: 0.50, strength: 0.40 },
  same_scene:            { confidence_base: 0.48, strength: 0.38 },
  adjacent_in_process:   { confidence_base: 0.55, strength: 0.50 },
  // Identity resolution (IDENTITY_PASS layer)
  alias_of:              { confidence_base: 0.85, strength: 0.80 }, // same service, different name
  sibling_of:            { confidence_base: 0.75, strength: 0.65 }, // same family, different scope
}

/**
 * Query-intent → high-priority relation types for RAG graph expansion.
 * RAG/Agent uses this to route which edges to follow per query intent.
 * Relation Layer (Layer 3): query-time routing contract.
 */
export const RELATION_QUERY_AFFINITY: Record<string, RelationType[]> = {
  composition:   ["has_part", "part_of", "defined_by", "describes"],
  compliance:    ["governed_by", "governs", "defines", "mitigated_by", "not_recommended_for"],
  suitability:   ["recommended_for", "applies_to", "targets_persona", "not_recommended_for"],
  sales:         ["uses_pitch", "uses_objection_handling", "supports", "targets_persona"],
  evidence:      ["has_evidence", "derived_from", "described_by", "describes"],
  combination:   ["bundled_with", "complements", "recommended_for"],
  versioning:    ["supersedes", "updates", "refines"],
  // service_nav: lateral navigation between sibling services
  // Agent uses this when user asks "what other services are related to X?"
  service_nav:   ["next_step", "same_stage", "same_category", "same_scene", "adjacent_in_process", "complements", "bundled_with"],
  general:       ["part_of", "has_part", "governed_by", "applies_to", "recommended_for"],
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
  "Allowed relation types include: related_to, mentions, applies_to, recommended_for, not_recommended_for, supports, supported_by, conflicts_with, updates, supersedes, governed_by, governs, derived_from, uses_asset, has_evidence, parent_of, child_of, refines, maps_to, fills_gap_for, describes, described_by, part_of, has_part, mitigated_by, mitigates, defines, defined_by, bundled_with, complements, next_step, same_stage.",
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
