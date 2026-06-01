# LLM Wiki — Agent & Multi-Domain Development Roadmap

> **Purpose**: This document records the agreed architecture decisions, pending
> implementation items, and design constraints for the Codex team and future
> developers. Last updated: 2026-05-29. Update this file whenever a major
> decision is made or a phase is completed.

---

## Current State (as of 2026-05-29)

### What's working
- **DomainSkill plugin interface** (`knowledge-domain-skill.ts`) — extensibility contract for all future domains
- **HealthServiceSkill** (`health-service-skill.ts`) — first domain implementation, covers `service_plan` / `service_benefit` / `process` / `rule`
- **DomainSkillRegistry** — auto-registration, domain detection, entity-type dispatch
- **knowledge-postprocess.ts** wired to use skill dispatch (`DomainSkillRegistry.forEntityType()`)
- `service_plan` entity type in `insurance-schema-registry.ts`
- YAML-format attributes parsing (`parseYamlAttributes`) — fixes the core materializer bug
- Wikilink normalization (`normalizeBodyWikilinks`) — body text `[[旧名_臻享家医]]` → `[[规范名]]`
- Reconcile drops unresolvable relation targets (no more broken links in frontmatter)
- **Relation scoring layer** (`RELATION_TYPE_SCORES`, `RELATION_SOURCE_CONFIDENCE`, `RELATION_QUERY_AFFINITY`) with `expandGraphFromEntity()` API
- **Authority-weighted conflict resolution** (`knowledge-resolution.ts`) — source_type weights, user_locked_fields, version audit trail
- **`canonicalServiceIdentityName()`** — brand suffix stripping + discriminator-protected synonym map (28/28 tests pass)
- **`knowledge-identity-resolution.ts`** — full 4-phase LLM Identity Pass:
  - Phase 1: `buildIdentityCatalog()` — reads all entity pages with canonical dedup_key
  - Phase 2: `generateIdentityCandidates()` — rule-based N-reduction (R1:dedup_key / R2:canonical_title / R3:prefix-suffix / R4:source+type)
  - Phase 3: `llmJudgeIdentityPairs()` — LLM batch verdict (same_entity/alias_of/sibling_of/parent_child/distinct), 15 pairs/call
  - Phase 4: `applyIdentityJudgments()` — writes relation edges + merge_suggestion frontmatter comments
- **Ingest pipeline ordering**: postprocess → Identity Pass → Global Relation Pass → audit (correct sequence)

### Known remaining gaps
| Issue | Severity | Owner |
|-------|----------|-------|
| service_plan candidate compiler still uses `Product` schema | P0 | Codex (ingest-side change) |
| Candidate title normalization happens after audit (OCR noise visible in audit) | P0 | Codex |
| 特色体检 — body has info but canonical fields are null (extra_attributes not re-salvaged) | P1 | Claude or Codex |
| high_confidence field completeness only 29% | P1 | LLM prompt improvement |
| 7 remaining broken wikilinks in source pages (compliance/声明 pages not generated) | P1 | Codex |
| Audit counts frontmatter + wikilinks + related as "relations" (misleading) | P2 | Either |
| Identity Pass: merge_suggestion not yet auto-resolved on subsequent ingest | P2 | Future: add dedup pass in postprocess |
| ReviewStore not yet accessible from lib — queued judgments (0.65-0.82) are discarded | P2 | Future: expose ReviewStore to lib layer |

---

## Architecture: What Was Decided

### Decision 1: Relations storage format — DO NOT MIGRATE

```yaml
# Keep as-is — lightweight, Obsidian-friendly
relations:
  - "has_part: 家庭医生服务"
  - "governed_by: 重疾服务等待期与非共享规则"
```

**Rationale**: `expandGraphFromEntity()` already returns fully structured data
with `targetPage`, `relation.score`, and `direction`. Agents MUST go through
this API — they must NOT parse `.md` frontmatter strings directly.

If a future Agent requires raw `.md` as its only input, revisit this decision
then. Until that day, format migration is not worth the cost.

### Decision 2: DomainSkill is the extensibility unit, NOT sub-agents

```
DomainSkill (deterministic TypeScript plugin)
    ↓  optional future wrapper
LLM Agent (thin orchestration shell)
```

Sub-agents are deferred because:
- Main ingest pipeline must be deterministic and reproducible
- Sub-agents add cost, latency, and debugging complexity
- Skills are already detachable — any skill can be tested in isolation

### Decision 3: Sub-agents are the audit/arbitration layer (future)

When multi-domain knowledge reaches sufficient scale, three agents will be layered on top:

| Agent | Role | Wraps |
|-------|------|-------|
| `ExtractionAgent` | LLM-driven entity extraction from raw docs | `skill.extractCandidates()` |
| `ValidationAgent` | Quality audit, flag anomalies, generate gaps report | `skill.validate()` |
| `RelationAgent` | Infer and arbitrate conflicting relations | `skill.inferRelations()` |

These agents do NOT replace the deterministic postprocess pipeline — they augment it as a review/arbitration layer, run on-demand or on a schedule.

---

## Phase Roadmap

### Phase 1 — Current (Health Service Plan)
**Status**: In progress. Commit `53f9acd` completes most of this phase.

- [x] `service_plan` entity type in schema registry
- [x] `HealthServiceSkill` with correct 4-tier `resolveParent` fallback
- [x] `service_team` → `service_provider` alias fix
- [x] YAML attributes parsing (`parseYamlAttributes`)
- [x] `.md.md` double-extension rename pass
- [x] Body wikilink normalization (`normalizeBodyWikilinks`)
- [x] Broken relation target drop in `reconcileRelations`
- [x] `DomainSkill` interface + `DomainSkillRegistry`
- [x] Fix candidate compiler to use `service_plan` schema (Codex: ingest-side)
- [x] `canonicalServiceIdentityName()` — brand suffix stripping + discriminator protection
- [x] **LLM Identity Pass** (`knowledge-identity-resolution.ts`) — 4-phase pipeline:
  - same_entity / alias_of / sibling_of / parent_child detection
  - Candidate pair generation with 4 rules (no N²)
  - LLM batch judgment with discriminator guards and confidence thresholds
  - Non-destructive apply: merge_suggestion for human review, relation edges for graph connectivity
  - Integrated in ingest: Step 3.4c (after postprocess, before Global Relation Pass)
- [ ] Re-salvage `extra_attributes` into canonical fields (特色体检 fix)
- [ ] Audit: count only frontmatter `relations` (not body wikilinks)
- [ ] Validate PA0526-02 → target: audit score ≥ 75, has_part coverage = 100%
- [ ] Identity Pass: auto-resolve `merge_suggestion` on subsequent ingest (postprocess dedup)
- [ ] ReviewStore bridge: expose low-confidence judgments (0.65-0.82) to review queue

### Phase 2 — Life Insurance Domain
**Status**: Not started. Trigger: when first life insurance source doc is ingested.

Steps:
1. Add `LifeInsuranceSkill` implementing `DomainSkill`
   - Entity types: `product`, `product_combo`, `selling_point`, `regulatory_doc`, `product_clause`
   - Field aliases for life insurance terminology
   - `detectDomain()`: look for 保险责任/理赔/等待期/被保险人 etc.
   - `inferRelations()`: `product_clause` → `part_of` product, `selling_point` → `applies_to` product
2. Register via `DomainSkillRegistry.register(new LifeInsuranceSkill())`
3. No changes to shared pipeline code needed

### Phase 3 — Medical Insurance Domain
**Status**: Not started.

Similar to Phase 2. Additional complexity:
- `medical_coverage_item` entity type (per-item benefit structure)
- Deductible / co-pay / OOP max as structured fields
- Network hospital relations (`covered_at`, `preferred_provider`)

### Phase 4 — GraphRAG / Hybrid Retrieval
**Status**: Infrastructure exists, not fully activated.

What's already built:
- `expandGraphFromEntity(index, entityId, queryIntent, topK)` — intent-aware graph traversal ✅
- `RELATION_QUERY_AFFINITY` — intent → relation type mapping ✅
- `RELATION_TYPE_SCORES` — confidence × strength scoring ✅

What needs to be added:
- Vector store integration (seed entities via embedding similarity, then expand via graph)
- BM25 / keyword retrieval as fallback for sparse domains
- Reranker for final result ordering
- Metapath support: pre-defined traversal paths per query type
  ```
  service_usage:   service_plan → has_part → service_benefit → governed_by → rule
  compliance:      service_benefit → governed_by → compliance_rule
  sales:           persona → recommended_for → service_plan → has_part → service_benefit
  ```

### Phase 5 — Sub-Agent Layer
**Status**: Deferred. Activate when multi-domain scale justifies it.

### Phase 6 — Storage Scaling (Large-Scale Graph Database)
**Status**: Deferred. Trigger: entities > 10,000 OR query latency > 500ms.

**当前方案（< 1万实体）**：
- 关系边存 `.md` frontmatter YAML → 启动时全量读取建内存索引
- 向量存本地 JSON 文件
- 全文搜索：实时扫描 wiki/*.md 文件（16并发）

**规模化后需要迁移的组件**：

| 组件 | 当前 | 迁移目标 | 触发条件 |
|------|------|---------|---------|
| 全文检索 | 实时文件扫描 | SQLite FTS5 | 实体 > 1000 |
| 关系图存储 | 内存索引（启动重建）| SQLite（nodes + edges 表）| 实体 > 2000，重启体验差 |
| 向量检索 | 本地 JSON 文件 | Qdrant（本地部署）| 实体 > 5000 |
| 图遍历引擎 | 内存 Map 遍历 | **Neo4j** 或 **NebulaGraph** | 实体 > 10万 |

**推荐图数据库选型**：
- **中等规模（< 100万实体）**：Neo4j Community Edition（免费，Cypher 语法，GraphRAG 生态最好）
- **大规模（> 100万实体）**：NebulaGraph（字节/美团在用，分布式，性能最强）
- **极速内存图（< 1000万边）**：FalkorDB（基于 Redis，图遍历 < 1ms）

**迁移策略**：
- `knowledge-relation-index.ts` 的 `buildKnowledgeRelationIndex()` 已经是统一入口，迁移时只需替换这一层的实现，上层 `expandGraphFromEntity()` API 不变
- `.md` frontmatter 保持不变（Obsidian 兼容、Git 版本控制），数据库作为**读取加速层**，`.md` 文件仍是 source of truth



Architecture:
```
OrchestratorAgent
  ├── ExtractionAgent   (wraps DomainSkill.extractCandidates)
  ├── ValidationAgent   (wraps DomainSkill.validate + audit reporter)
  └── RelationAgent     (wraps DomainSkill.inferRelations + conflict resolution)
```

Each agent:
- Is independently deployable and testable
- Shares the same `DomainSkillRegistry` for domain dispatch
- Can be called in parallel for multi-domain documents
- Reports results back to orchestrator for merge/conflict resolution

---

## File Map

```
src/lib/
├── knowledge-domain-skill.ts         ← DomainSkill interface + DomainSkillRegistry
├── health-service-skill.ts           ← HealthServiceSkill (Phase 1)
├── knowledge-postprocess.ts          ← main postprocess pipeline (skill-dispatched)
├── knowledge-relation-index.ts       ← graph index + expandGraphFromEntity API
├── knowledge-schema.ts               ← RelationType, RELATION_QUERY_AFFINITY, scoring constants
├── knowledge-global-relation.ts      ← Global Relation Pass (cross-doc lateral relations)
├── knowledge-identity-resolution.ts  ← Identity Pass (same_entity/alias_of/sibling_of)
├── knowledge-resolution.ts           ← authority-weighted conflict resolution
├── insurance-schema-registry.ts      ← entity type specs + canonicalServiceIdentityName()
├── service-benefit-enrichment.ts     ← LLM extraction helpers (health service specific)
└── ingest.ts                         ← main pipeline: postprocess → identity → relation → audit

Future:
├── life-insurance-skill.ts           ← LifeInsuranceSkill (Phase 2)
├── medical-insurance-skill.ts        ← MedicalInsuranceSkill (Phase 3)
└── agent/
    ├── orchestrator-agent.ts         ← OrchestratorAgent (Phase 5)
    ├── extraction-agent.ts           ← ExtractionAgent (Phase 5)
    ├── validation-agent.ts           ← ValidationAgent (Phase 5)
    └── relation-agent.ts             ← RelationAgent (Phase 5)
```

---

## DomainSkill Quick-Start (for adding a new domain)

```typescript
// 1. Create your skill file: src/lib/life-insurance-skill.ts

import { DomainSkillRegistry } from "@/lib/knowledge-domain-skill"
import type { DomainSkill, PageContent, PageIndex, RelationSpec } from "@/lib/knowledge-domain-skill"
import { INSURANCE_SCHEMA_REGISTRY } from "@/lib/insurance-schema-registry"

class LifeInsuranceSkill implements DomainSkill {
  readonly domainId = "life_insurance"
  readonly label = "寿险产品"

  get schemas() {
    return INSURANCE_SCHEMA_REGISTRY.filter(s =>
      ["product", "product_combo", "selling_point", "regulatory_doc"].includes(s.entityType)
    )
  }

  detectDomain(content: string): number {
    const signals = [/保险责任/, /理赔/, /等待期/, /被保险人/, /受益人/]
    const hits = signals.filter(s => s.test(content)).length
    return Math.min(1, hits / 3)
  }

  readonly fieldAliases = {
    product: {
      product_name: ["官方产品名称", "产品全称"],
      // ...
    }
  }

  normalizeTitle(input: string): string {
    return input.trim()
  }

  resolveParent(childEntityType: string, rawParentValue: string, index: PageIndex[]): string | null {
    if (childEntityType === "selling_point" || childEntityType === "product_clause") {
      const match = index.find(p => p.entityType === "product" && p.title === rawParentValue)
      return match?.title ?? null
    }
    return null
  }

  inferRelations(page: PageContent, index: PageIndex[]): RelationSpec[] {
    const parent = this.resolveParent(page.entityType, String(page.attributes["related_product"] ?? ""), index)
    if (!parent) return []
    return [{ type: "part_of", targetTitle: parent }]
  }
}

// 2. Auto-register
DomainSkillRegistry.register(new LifeInsuranceSkill())
export { LifeInsuranceSkill }

// 3. Import in knowledge-postprocess.ts:
// import "@/lib/life-insurance-skill"
```

---

## Constraints & Non-Negotiables

1. **Skills are pure TypeScript** — no LLM calls inside a DomainSkill
2. **Agents are optional wrappers** — the pipeline must work without any agent active
3. **Relations storage stays as `"type: title"` strings** — do not migrate to structured objects until agents require direct `.md` parsing
4. **`expandGraphFromEntity()` is the canonical Agent API** — all RAG/Agent queries go through it
5. **Every new entity type must have a schema spec** in `insurance-schema-registry.ts` before extraction can run
6. **Postprocess runs BEFORE audit** — audit scores reflect the final clean state, not raw LLM output

---

*Document maintained by: Claude (Antigravity) + Codex*
*Branch: `feature/schema-driven-ingest-compiler`*
