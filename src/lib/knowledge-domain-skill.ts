/**
 * Domain Skill Plugin System
 *
 * Each insurance knowledge domain (health service, life insurance, medical
 * insurance, property insurance, ...) implements the DomainSkill interface.
 * The shared ingest/postprocess pipeline dispatches to the correct skill
 * through DomainSkillRegistry — without any domain-specific hardcoding in
 * the common code paths.
 *
 * Architecture:
 *   DomainSkillRegistry          ← registration / discovery
 *       └─ DomainSkill[]         ← one per domain
 *             ├─ HealthServiceSkill    (health service plans & benefits)
 *             ├─ LifeInsuranceSkill    (future)
 *             ├─ MedicalInsuranceSkill (future)
 *             └─ ...
 *
 * The skills are pure TypeScript — deterministic, testable, no LLM calls.
 * LLM agents can later be layered on top as thin orchestration wrappers.
 */

import type { InsuranceEntitySchemaSpec } from "@/lib/insurance-schema-registry"
import type { RelationType } from "@/lib/knowledge-schema"

// ─── Core types ───────────────────────────────────────────────────────────────

export interface PageContent {
  /** Raw markdown text including frontmatter. */
  raw: string
  /** Page file name (basename), e.g. "家庭医生服务.md". */
  fileName: string
  /** Resolved entity_type from frontmatter, e.g. "service_benefit". */
  entityType: string
  /** Resolved title from frontmatter. */
  title: string
  /** Parsed attributes object (already run through parseYamlAttributes). */
  attributes: Record<string, unknown>
}

export interface PageIndex {
  title: string
  relativePath: string
  entityType: string
  normalizedForms: string[]
}

export interface RelationSpec {
  type: RelationType
  targetTitle: string
  /** Optional: if known, pass to skip index lookup. */
  targetId?: string
}

export interface ValidationIssue {
  field: string
  severity: "error" | "warning" | "info"
  message: string
}

// ─── DomainSkill interface ────────────────────────────────────────────────────

/**
 * Contract that every domain plugin must implement.
 * Optional methods are progressively applied — if not implemented, the shared
 * pipeline default logic is used.
 */
export interface DomainSkill {
  /** Stable identifier, e.g. "health_service", "life_insurance". */
  readonly domainId: string
  /** Human-readable label for logging/UI. */
  readonly label: string

  /**
   * Returns a 0–1 confidence that the given page content belongs to this
   * domain. The registry picks the skill with the highest score.
   * Return 0 if definitely not this domain.
   */
  detectDomain(content: string): number

  /** Entity type specs this skill owns. Used by materializer + audit. */
  readonly schemas: InsuranceEntitySchemaSpec[]

  /**
   * Field alias map: canonical_field → [alias, alias, ...].
   * Merged with the global alias map during materialization.
   * Keyed by entity_type.
   */
  readonly fieldAliases: Record<string, Record<string, string[]>>

  /**
   * Normalize an entity title for this domain.
   * E.g. strip "_臻享家医", OCR noise, version markers.
   * Return the original string if no normalization needed.
   */
  normalizeTitle(input: string): string

  /**
   * Given a page and the full page index, return relation specs that should
   * be inferred and added to the page (e.g. part_of, applies_to).
   * Return empty array if no relations can be inferred.
   */
  inferRelations(page: PageContent, index: PageIndex[]): RelationSpec[]

  /**
   * Resolve the canonical "parent" title for a child entity.
   * E.g. for service_benefit: find the service_plan that owns it.
   * Return null if no parent can be determined.
   */
  resolveParent(
    childEntityType: string,
    rawParentValue: string,
    index: PageIndex[],
  ): string | null

  /**
   * Optional field-level validation after materialization.
   * Return issues for the caller to log or surface in audit.
   */
  validate?(page: PageContent): ValidationIssue[]

  /**
   * Optional: query intent → preferred relation types for graph expansion.
   * Merged with the global RELATION_QUERY_AFFINITY.
   */
  queryAffinity?: Record<string, RelationType[]>
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _registry: DomainSkill[] = []

export const DomainSkillRegistry = {
  /** Register a skill. Called once at module init time. */
  register(skill: DomainSkill): void {
    const existing = _registry.findIndex((s) => s.domainId === skill.domainId)
    if (existing >= 0) {
      _registry[existing] = skill // allow hot-swap in tests
    } else {
      _registry.push(skill)
    }
  },

  /** All registered skills. */
  get all(): readonly DomainSkill[] {
    return _registry
  },

  /**
   * Find the best skill for the given page content.
   * Returns the skill with the highest detectDomain() score, or null if
   * no skill claims this content (score === 0 for all).
   */
  detect(content: string): DomainSkill | null {
    let best: DomainSkill | null = null
    let bestScore = 0
    for (const skill of _registry) {
      const score = skill.detectDomain(content)
      if (score > bestScore) {
        bestScore = score
        best = skill
      }
    }
    return bestScore > 0 ? best : null
  },

  /**
   * Find a skill by its entityType ownership.
   * Returns the first skill whose schemas include the given entityType.
   */
  forEntityType(entityType: string): DomainSkill | null {
    return _registry.find((s) =>
      s.schemas.some((spec) => spec.entityType === entityType)
    ) ?? null
  },

  /** Find a skill by domainId. */
  get(domainId: string): DomainSkill | null {
    return _registry.find((s) => s.domainId === domainId) ?? null
  },
}
