/**
 * eval/run-eval.ts
 *
 * Knowledge graph evaluation harness.
 * Run: npx tsx eval/run-eval.ts <projectPath>
 *
 * Prints a structured quality report covering:
 *   1. Identity Pass quality (precision/recall vs golden pairs)
 *   2. Schema completeness (critical field fill rate per entity type)
 *   3. Graph sanity (max edges per entity, broken wikilinks)
 *   4. Data governance (audit contamination in review queue)
 *   5. Canonical direction correctness
 *
 * Exit code 0 = all metrics pass thresholds
 * Exit code 1 = one or more metrics below threshold (CI-friendly)
 */

import * as fs from "fs"
import * as path from "path"

// ─── Config ───────────────────────────────────────────────────────────────────

/** Minimum acceptable values — adjust per project maturity */
const THRESHOLDS = {
  identityPrecision:       0.80,  // 80% of merges must be correct
  identityRecall:          0.70,  // 70% of ground-truth merges must be found
  criticalFieldFillRate:   0.60,  // 60% of critical fields filled on average
  maxEdgesPerEntity:       50,    // entities with more edges than this are flagged
  brokenWikilinks:         10,    // max acceptable broken [[wikilinks]]
  auditContamination:       0,    // audit files in review queue = always 0
  canonicalDirectionErrors: 0,    // wrong-direction redirects = always 0
} as const

// ─── Types ────────────────────────────────────────────────────────────────────

interface GoldenPair {
  id: string
  a: string
  b: string
  expected_verdict: "same_entity" | "alias_of" | "distinct"
  expected_canonical: string | null
  reason: string
}

interface EvalResult {
  identityPrecision:        number
  identityRecall:           number
  criticalFieldFillRate:    number
  maxEdgesPerEntity:        number
  brokenWikilinks:          number
  auditContamination:       number
  canonicalDirectionErrors: number
  details: {
    falsePositiveMerges:    string[]
    missedMerges:           string[]
    flaggedEntities:        string[]
    brokenLinks:            string[]
    canonicalErrors:        string[]
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readMd(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8") } catch { return "" }
}

function scalar(content: string, key: string): string {
  return content.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim() ?? ""
}

function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".md") && !f.endsWith(".md.md"))
    .map(f => path.join(dir, f))
}

// ─── Metric 1: Identity Pass precision/recall ─────────────────────────────────

function evalIdentity(projectPath: string, goldenPairs: GoldenPair[]) {
  const entityDir = path.join(projectPath, "wiki", "entities")
  const redirectMap = new Map<string, string>() // title → canonical (redirect_to)
  const aliasPairs  = new Set<string>()          // "A|||B" for alias_of edges

  for (const f of listMdFiles(entityDir)) {
    const content = readMd(f)
    const title     = scalar(content, "title")
    const redirectTo = content.match(/^redirect_to:\s*"([^"\n]+)"/m)?.[1]?.trim()
    if (title && redirectTo) redirectMap.set(title, redirectTo)

    // Collect alias_of compact relations
    for (const m of content.matchAll(/^\s+-\s+"?alias_of:\s*([^"\n]+)"?\s*$/gm)) {
      const pair = [title, m[1].trim()].sort().join("|||")
      aliasPairs.add(pair)
    }
  }

  let tp = 0, fp = 0, fn = 0
  const falsePositiveMerges: string[] = []
  const missedMerges: string[] = []
  const canonicalErrors: string[] = []

  for (const gp of goldenPairs) {
    const pairKey = [gp.a, gp.b].sort().join("|||")
    const aRedirect = redirectMap.get(gp.a)
    const bRedirect = redirectMap.get(gp.b)
    const isMerged = (aRedirect === gp.b || bRedirect === gp.a ||
                      aRedirect !== undefined && aRedirect === bRedirect) ||
                     aliasPairs.has(pairKey)

    if (gp.expected_verdict === "same_entity") {
      if (isMerged) {
        tp++
        // Check canonical direction
        if (gp.expected_canonical) {
          const redirectedTitle = aRedirect ? gp.a : (bRedirect ? gp.b : null)
          if (redirectedTitle && redirectedTitle === gp.expected_canonical) {
            canonicalErrors.push(`GP${gp.id}: ${gp.expected_canonical} was redirected (should be canonical)`)
          }
        }
      } else {
        fn++
        missedMerges.push(`${gp.id}: ${gp.a} ↔ ${gp.b}`)
      }
    } else if (gp.expected_verdict === "distinct") {
      if (isMerged) {
        fp++
        falsePositiveMerges.push(`${gp.id}: ${gp.a} ↔ ${gp.b} (should NOT have merged)`)
      }
    }
  }

  const totalPositives = goldenPairs.filter(g => g.expected_verdict === "same_entity").length
  const precision = (tp + fp) === 0 ? 1 : tp / (tp + fp)
  const recall    = totalPositives === 0 ? 1 : tp / totalPositives

  return { precision, recall, falsePositiveMerges, missedMerges, canonicalErrors }
}

// ─── Metric 2: Schema completeness ────────────────────────────────────────────

function evalSchemaCompleteness(projectPath: string) {
  const entityDir = path.join(projectPath, "wiki", "entities")
  let totalCritical = 0
  let filledCritical = 0

  // Load schema registry from JSON snapshot if available, else estimate from files
  for (const f of listMdFiles(entityDir)) {
    const content = readMd(f)
    if (/^redirect_to:\s*".+"/m.test(content)) continue

    // Count non-null attribute values as a proxy for critical field fill rate
    const attrMatch = content.match(/^attributes:\s*(\{[^}]+\})/m)
    if (attrMatch) {
      try {
        const attrs = JSON.parse(attrMatch[1]) as Record<string, unknown>
        for (const v of Object.values(attrs)) {
          totalCritical++
          if (v !== null && v !== "" && v !== "null") filledCritical++
        }
      } catch { /* malformed attrs */ }
    }
  }

  return totalCritical === 0 ? 1 : filledCritical / totalCritical
}

// ─── Metric 3: Graph sanity ────────────────────────────────────────────────────

function evalGraphSanity(projectPath: string) {
  const entityDir = path.join(projectPath, "wiki", "entities")
  let maxEdges = 0
  const flaggedEntities: string[] = []
  let brokenLinks = 0
  const brokenLinkList: string[] = []

  const allTitles = new Set<string>()
  for (const f of listMdFiles(entityDir)) {
    const t = scalar(readMd(f), "title")
    if (t) allTitles.add(t)
  }

  for (const f of listMdFiles(entityDir)) {
    const content = readMd(f)
    if (/^redirect_to:\s*".+"/m.test(content)) continue
    const title = scalar(content, "title")

    // Count relation_edges
    const edgeBlock = content.match(/^relation_edges:\s*\n((?:[ \t]+-[ \t][\s\S]*?(?=\n[a-z_]+:|\n---|\z))*)/m)
    if (edgeBlock) {
      const edgeCount = (edgeBlock[1].match(/^\s+-\s+target:/gm) ?? []).length
      if (edgeCount > maxEdges) maxEdges = edgeCount
      if (edgeCount > THRESHOLDS.maxEdgesPerEntity) {
        flaggedEntities.push(`${title}: ${edgeCount} edges`)
      }
    }

    // Check wikilinks in body
    const body = content.replace(/^---[\s\S]*?---\n?/, "")
    for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const target = m[1].trim()
      if (!allTitles.has(target)) {
        brokenLinks++
        brokenLinkList.push(`${title} → [[${target}]]`)
      }
    }
  }

  return { maxEdges, flaggedEntities, brokenLinks, brokenLinkList }
}

// ─── Metric 4: Audit contamination ────────────────────────────────────────────

function evalAuditContamination(projectPath: string): number {
  const queuePath = path.join(projectPath, ".llm-wiki", "review-queue.json")
  if (!fs.existsSync(queuePath)) return 0
  try {
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf-8")) as { filePath?: string }[]
    const auditSegments = ["/wiki/audits/", "/wiki/sources/", "/wiki/.identity-audit/"]
    return queue.filter(item =>
      item.filePath && auditSegments.some(seg => item.filePath!.replace(/\\/g, "/").includes(seg))
    ).length
  } catch { return 0 }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const projectPath = process.argv[2] ?? process.cwd()
  const goldenPath  = path.join(__dirname, "golden-pairs.json")

  console.log(`\n🔍 LLM Wiki Knowledge Graph Eval Harness`)
  console.log(`   Project: ${projectPath}`)
  console.log(`   Golden pairs: ${goldenPath}\n`)

  if (!fs.existsSync(goldenPath)) {
    console.error("❌ golden-pairs.json not found. Create eval/golden-pairs.json first.")
    process.exit(1)
  }

  const goldenPairs: GoldenPair[] = JSON.parse(fs.readFileSync(goldenPath, "utf-8"))
  const { precision, recall, falsePositiveMerges, missedMerges, canonicalErrors } = evalIdentity(projectPath, goldenPairs)
  const criticalFillRate = evalSchemaCompleteness(projectPath)
  const { maxEdges, flaggedEntities, brokenLinks, brokenLinkList } = evalGraphSanity(projectPath)
  const auditContamination = evalAuditContamination(projectPath)

  const result: EvalResult = {
    identityPrecision:        precision,
    identityRecall:           recall,
    criticalFieldFillRate:    criticalFillRate,
    maxEdgesPerEntity:        maxEdges,
    brokenWikilinks:          brokenLinks,
    auditContamination,
    canonicalDirectionErrors: canonicalErrors.length,
    details: {
      falsePositiveMerges,
      missedMerges,
      flaggedEntities,
      brokenLinks: brokenLinkList,
      canonicalErrors,
    },
  }

  // ── Print report ──
  const pass = (v: boolean) => v ? "✅" : "❌"
  const pct  = (n: number) => `${(n * 100).toFixed(1)}%`

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("  METRIC                        VALUE   THRESHOLD  STATUS")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  const rows = [
    ["Identity Precision",          pct(precision),        `≥${pct(THRESHOLDS.identityPrecision)}`,       pass(precision        >= THRESHOLDS.identityPrecision)],
    ["Identity Recall",             pct(recall),           `≥${pct(THRESHOLDS.identityRecall)}`,          pass(recall           >= THRESHOLDS.identityRecall)],
    ["Critical Field Fill Rate",    pct(criticalFillRate), `≥${pct(THRESHOLDS.criticalFieldFillRate)}`,   pass(criticalFillRate >= THRESHOLDS.criticalFieldFillRate)],
    ["Max Edges Per Entity",        String(maxEdges),      `≤${THRESHOLDS.maxEdgesPerEntity}`,            pass(maxEdges         <= THRESHOLDS.maxEdgesPerEntity)],
    ["Broken Wikilinks",            String(brokenLinks),   `≤${THRESHOLDS.brokenWikilinks}`,              pass(brokenLinks      <= THRESHOLDS.brokenWikilinks)],
    ["Audit Contamination",         String(auditContamination), `=${THRESHOLDS.auditContamination}`,      pass(auditContamination <= THRESHOLDS.auditContamination)],
    ["Canonical Direction Errors",  String(canonicalErrors.length), `=${THRESHOLDS.canonicalDirectionErrors}`, pass(canonicalErrors.length <= THRESHOLDS.canonicalDirectionErrors)],
  ]

  for (const [label, value, threshold, status] of rows) {
    console.log(`  ${label.padEnd(30)} ${value.padEnd(8)} ${threshold.padEnd(12)} ${status}`)
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

  if (result.details.falsePositiveMerges.length > 0) {
    console.log("\n⚠️  False positive merges:")
    result.details.falsePositiveMerges.forEach(s => console.log(`   ${s}`))
  }
  if (result.details.missedMerges.length > 0) {
    console.log("\n⚠️  Missed merges (false negatives):")
    result.details.missedMerges.forEach(s => console.log(`   ${s}`))
  }
  if (result.details.canonicalErrors.length > 0) {
    console.log("\n⚠️  Canonical direction errors:")
    result.details.canonicalErrors.forEach(s => console.log(`   ${s}`))
  }
  if (result.details.flaggedEntities.length > 0) {
    console.log("\n⚠️  High edge-count entities:")
    result.details.flaggedEntities.forEach(s => console.log(`   ${s}`))
  }
  if (result.details.brokenLinks.length > 0) {
    console.log(`\n⚠️  Broken wikilinks (first 10):`)
    result.details.brokenLinks.slice(0, 10).forEach(s => console.log(`   ${s}`))
  }

  // Write JSON report for CI/programmatic consumption
  const reportPath = path.join(projectPath, ".llm-wiki", "eval-report.json")
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), thresholds: THRESHOLDS, result }, null, 2))
  console.log(`\n📄 Full report saved: ${reportPath}`)

  // Exit 1 if any threshold violated (CI-friendly)
  const passing = Object.entries(THRESHOLDS).every(([key, threshold]) => {
    const v = result[key as keyof typeof THRESHOLDS] as number
    return key.startsWith("max") || key.startsWith("broken") || key.startsWith("audit") || key.startsWith("canonical")
      ? v <= threshold
      : v >= threshold
  })

  if (!passing) {
    console.log("\n❌ One or more metrics below threshold. See details above.")
    process.exit(1)
  } else {
    console.log("\n✅ All metrics pass thresholds.")
  }
}

main()
