export type FieldImportance = "critical" | "high_confidence" | "recommended" | "auto_derived"

export interface InsuranceFieldSpec {
  name: string
  label: string
  note: string
  importance: FieldImportance
  aliases?: string[]
  semanticGroup?: string
}

export interface InsuranceEntitySchemaSpec {
  schemaKey: string
  label: string
  domain: "product" | "customer" | "method" | "content" | "activity" | "cases" | "compliance" | "service"
  entityType: string
  universalType: "concept" | "entity" | "event" | "process" | "rule" | "data" | "case" | "source"
  purpose: string
  fields: InsuranceFieldSpec[]
  relationHints: string[]
  lintRules?: string[]
}

export type FieldMergePolicy = "append" | "conflict" | "keep_best" | "ignore_empty"

const f = (name: string, label: string, note: string, importance: FieldImportance): InsuranceFieldSpec => ({
  name,
  label,
  note,
  importance,
})

const DEDUP_KEY_FIELDS: Record<string, string[]> = {
  product: ["product_code", "product_name"],
  product_combo: ["combo_name"],
  selling_point: ["related_product", "point_name"],
  regulatory_doc: ["related_product", "doc_type", "effective_version"],
  service_benefit: ["related_product", "service_name"],
  service_plan: ["plan_name", "plan_version"],
  // Service hierarchy v2 (feature/schema-v2-service-category)
  service_series: ["series_name"],
  service_scenario: ["series_name", "scenario_name"],
  service_line: ["series_name", "scenario_name", "line_name"],
  service_line_version: ["line_name", "version_name"],
  service_item: ["line_name", "version_name", "item_name"],
  service_item_concept: ["item_name"],
  persona: ["persona_name"],
  life_stage: ["stage_name"],
  customer_signal: ["signal_type", "signal_description"],
  selling_scenario: ["scenario_name"],
  pitch: ["related_scenario", "pitch_type", "core_message"],
  objection_handling: ["objection_category", "objection_raw"],
  sales_path: ["path_name"],
  sales_playbook: ["playbook_name"],
  referral_method: ["method_name"],
  needs_discovery: ["method_name"],
  asset: ["title", "asset_type"],
  asset_collection: ["name"],
  content_template: ["name", "template_type"],
  presentation_kit: ["kit_name"],
  campaign: ["name", "start_date"],
  incentive: ["name", "start_date"],
  event: ["event_name", "event_date"],
  success_case: ["title"],
  failure_case: ["title"],
  customer_voice: ["voice_type", "raw_text"],
  referral_case: ["title"],
  agent_feedback: ["feedback_type", "content"],
  competitive_insight: ["competitor_name", "insight_type", "capture_date"],
  compliance_rule: ["rule_name"],
  rule: ["rule_name"],
  process: ["process_name", "service_name"],
}

const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  product: {
    product_name: ["official_product_name", "name", "产品名称", "官方完整名称"],
    product_code: ["code", "product_id", "产品代码", "产品编号"],
    product_status: ["status_business", "sale_status", "销售状态", "在售状态"],
    target_age_range: ["age_range", "insured_age", "投保年龄", "投保年龄范围"],
    waiting_period_days: ["waiting_period", "等待期", "等待期天数"],
    payment_period_options: ["payment_period", "缴费期间", "交费期间"],
    coverage_period_options: ["coverage_period", "保障期间"],
    core_responsibilities: ["coverage", "responsibilities", "核心保障", "保险责任"],
    exclusions_official: ["exclusions", "责任免除", "免责条款"],
    selling_points_official: ["selling_points", "卖点", "官方卖点"],
  },
  service_benefit: {
    service_name: ["name", "title", "服务名称", "权益名称"],
    related_product: ["product", "适用产品", "关联产品"],
    service_frequency: ["frequency", "次数", "服务次数", "使用次数"],
    eligible_customers: ["target_customer", "适用对象", "服务对象", "适用客户"],
    application_process: ["process", "流程", "申请流程", "服务流程"],
    service_limits: ["limits", "限制", "使用限制", "服务限制"],
    compliance_notes: ["disclaimer", "免责", "合规提示", "合规说明"],
  },
  // Service hierarchy v2
  service_item: {
    item_name: ["服务项名称", "服务项目", "name", "title"],
    line_name: ["服务线", "service_line", "所属服务线"],
    version_name: ["版本", "version", "服务线版本"],
    scenario_name: ["场景", "scenario", "服务场景"],
    series_name: ["系列", "series"],
    service_frequency: ["frequency", "次数", "服务次数", "使用次数"],
    eligible_customers: ["target_customer", "适用对象", "服务对象", "适用人群"],
    activation_conditions: ["activation", "激活条件", "启动条件", "服务启动条件"],
    service_content: ["content", "服务内容"],
    service_standard: ["standard", "服务标准"],
    coverage_cities: ["cities", "覆盖城市", "服务覆盖城市"],
    usage_process: ["process", "使用流程", "服务项目使用流程"],
    important_notes: ["notes", "重要提示", "注意事项"],
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
  persona: {
    persona_name: ["name", "画像名称", "客户画像"],
    age_band: ["age_range", "年龄", "年龄段"],
    family_structure: ["family", "家庭结构"],
    purchase_signals: ["signals", "购买信号", "客户信号"],
    typical_pain_points: ["pain_points", "痛点", "客户痛点"],
    typical_objections: ["objections", "异议", "典型异议"],
    matching_products: ["recommended_products", "适配产品", "匹配产品"],
  },
  selling_scenario: {
    scenario_name: ["name", "场景名称", "销售场景"],
    business_phases: ["business_phase", "业务阶段", "业务环节"],
    target_personas: ["personas", "目标画像", "适用客户"],
    target_products: ["products", "目标产品", "适用产品"],
  },
  pitch: {
    related_scenario: ["scenario", "关联场景"],
    pitch_type: ["type", "话术类型"],
    script: ["话术", "话术原文", "script_text"],
    core_message: ["核心信息", "核心传递点"],
  },
  objection_handling: {
    objection_raw: ["raw_objection", "客户原话", "异议原话"],
    objection_category: ["category", "异议类别"],
    response_strategy: ["strategy", "应对策略"],
    response_script: ["script", "应对话术"],
  },
  success_case: {
    customer_profile_brief: ["customer_profile", "客户画像", "客户背景"],
    product_or_combo_sold: ["product", "service", "关联产品", "关联服务"],
    approach_summary: ["approach", "服务路径", "销售路径", "核心做法"],
    key_moments: ["turning_points", "关键转折", "关键时刻"],
  },
  customer_voice: {
    raw_text: ["客户原话", "客户反馈", "反馈原文"],
    context: ["场景", "情境", "上下文"],
    related_persona: ["客户画像", "关联画像"],
  },
  compliance_rule: {
    rule_name: ["name", "规则名称", "合规规则"],
    rule_content: ["content", "规则内容", "合规说明"],
    risk_type: ["risk", "风险类型"],
  },
}

const SOURCE_TYPE_WEIGHTS: Record<string, number> = {
  regulatory_doc: 100,
  product_terms: 95,
  product_manual: 85,
  service_manual: 80,
  official_marketing: 70,
  sales_training: 55,
  agent_experience: 40,
  ocr_image: 35,
  unknown: 10,
}

// ─── Service identity canonicalization ───────────────────────────────────────
//
// The goal: two titles that refer to the same real-world service should produce
// the same canonical name so that their dedup_keys match and the conflict-
// resolution layer can merge them rather than creating duplicate entity pages.
//
// Three layers applied in order:
//   1. Brand suffix stripping  ("音视频问诊_臻享家医" → "音视频问诊")
//   2. Confirmed synonym map   ("家庭医生" → "家庭医生服务")
//   3. Discriminator protection (never merge if discriminator words differ)
//
// IMPORTANT: this function is CONSERVATIVE by design.
//   - Only strip suffixes that are known brand labels (not service descriptors).
//   - Only remap titles that are in the confirmed whitelist.
//   - If either title contains a discriminator word the other doesn't, the
//     canonical name is left unchanged so sibling services stay distinct.

/**
 * Known brand/platform suffixes that carry no semantic distinction.
 * Format: separator + brand name. The separator chars are:
 *   _ - （ ） ( )  (ASCII and full-width)
 *
 * These strings match the ACTUAL characters in the codebase (verified manually).
 */
const BRAND_SUFFIX_PATTERNS: RegExp[] = [
  // 臻享家医 variants  ← fixed: was incorrectly 臺享家医
  /[_\-\uff08\uff09()]臻享家医[\s\S]*$/,
  /[_\-\uff08\uff09()]平安臻享[\s\S]*$/,
  // 绿通  ← fixed: was incorrectly 绡通
  /[_\-\uff08\uff09()]绿通[\s\S]*$/,
  // Other common brand suffixes
  /[_\-\uff08\uff09()]平安健康[\s\S]*$/,
  /[_\-\uff08\uff09()]平安保险[\s\S]*$/,
  /[_\-\uff08\uff09()]健康管家[\s\S]*$/,
]

/**
 * Confirmed-safe synonym pairs.  Only titles in this whitelist are remapped.
 * Keys are the alias, values are the canonical (preferred) title.
 *
 * Rules for adding entries here:
 *   - The two services must be provably the same in all source documents.
 *   - Neither contains a discriminator word the other lacks.
 *   - A human has verified this is NOT a sibling-service relationship.
 */
const CONFIRMED_SYNONYMS: Record<string, string> = {
  // Service name variants
  "\u5bb6\u5ead\u533b\u751f": "\u5bb6\u5ead\u533b\u751f\u670d\u52a1",               // 家庭医生 → 家庭医生服务
  "\u5bb6\u5ead\u533b\u751f\u670d\u52a1\u6743\u76ca": "\u5bb6\u5ead\u533b\u751f\u670d\u52a1",  // 家庭医生服务权益 → 家庭医生服务
  "\u91cd\u75be\u4e13\u6848": "\u91cd\u75be\u4e13\u6848\u7ba1\u7406",             // 重疾专案 → 重疾专案管理
  "21\u5929\u8bad\u7ec3\u8425": "21\u5929\u793e\u7fa4\u8bad\u7ec3\u8425",        // 21天训练营 → 21天社群训练营
}

/**
 * Discriminator words: if a title contains one of these and the canonical
 * form does NOT contain the same discriminator (or contains a different one),
 * we abort the synonym remapping to prevent sibling-service merges.
 *
 * Example:
 *   "康复门诊协助" contains "门诊"
 *   "康复住院协助" contains "住院"
 *   → different discriminators → NOT the same service → no merge
 */
const SERVICE_DISCRIMINATORS: string[] = [
  "\u95e8\u8bca",   // 门诊
  "\u4f4f\u9662",   // 住院
  "\u6025\u8bca",   // 急诊
  "\u624b\u672f",   // 手术
  "\u672f\u540e",   // 术后
  "\u9996\u8bbf",   // 首访
  "\u968f\u8bbf",   // 随访
  "\u95ee\u8bca",   // 问诊
  "\u5eb7\u590d",   // 康复  (only discriminating in multi-service context)
  "\u5b89\u7f6e",   // 安置
  "\u56fd\u5185",   // 国内
  "\u6d77\u5916",   // 海外
  "\u5883\u5916",   // 境外
  "\u57fa\u7840",   // 基础
  "\u9ad8\u7ea7",   // 高级
  "\u89e3\u8bfb",   // 解读
  "\u8bad\u7ec3",   // 训练
  "\u62a4\u7406",   // 护理
  "\u966a\u8bca",   // 陪诊
]

/** Extract all discriminator words present in a title. */
function extractDiscriminators(title: string): string[] {
  return SERVICE_DISCRIMINATORS.filter(d => title.includes(d))
}

/**
 * Strip known brand/platform suffixes from a title.
 *
 * "音视频问诊_臻享家医" → "音视频问诊"
 * "就医陪诊_平安臻享家医" → "就医陪诊"
 *
 * Does NOT remove discriminator words, so sibling services stay distinct.
 */
export function stripBrandSuffix(title: string): string {
  let result = title.trim()
  for (const pattern of BRAND_SUFFIX_PATTERNS) {
    result = result.replace(pattern, "")
  }
  return result.trim()
}

/**
 * Compute the canonical service identity name for dedup key computation.
 *
 * Applies three steps in order:
 *   1. Strip brand suffix  → removes platform labels
 *   2. Apply synonym map   → collapses confirmed-safe aliases
 *   3. Discriminator check → aborts remap if discriminators differ
 *
 * This is the ONLY place where title normalization for dedup should happen.
 * Use this for both the `title` field and the `service_name` attribute.
 *
 * Examples:
 *   "音视频问诊_臻享家医" → "音视频问诊"         (brand suffix stripped)
 *   "家庭医生"           → "家庭医生服务"          (synonym remapped)
 *   "重疾专案"           → "重疾专案管理"          (synonym remapped)
 *   "康复门诊协助"        → "康复门诊协助"          (no change: has discriminator)
 *   "康复住院协助"        → "康复住院协助"          (no change: different discriminator)
 */
export function canonicalServiceIdentityName(title: string): string {
  if (!title) return title

  // Step 1: strip brand suffix
  const stripped = stripBrandSuffix(title)

  // Step 2: look up in confirmed synonym map
  const canonical = CONFIRMED_SYNONYMS[stripped] ?? stripped
  if (canonical === stripped) return stripped

  // Step 3: discriminator protection
  // If the stripped title and its canonical form have DIFFERENT discriminator
  // sets, the synonym mapping is not safe — abort and return the stripped form.
  const fromDiscriminators = extractDiscriminators(stripped)
  const toDiscriminators = extractDiscriminators(canonical)
  const fromSet = new Set(fromDiscriminators)
  const toSet = new Set(toDiscriminators)
  const discriminatorMismatch =
    fromDiscriminators.some(d => !toSet.has(d)) ||
    toDiscriminators.some(d => !fromSet.has(d))

  if (discriminatorMismatch) return stripped

  return canonical
}

export const INSURANCE_SCHEMA_REGISTRY: InsuranceEntitySchemaSpec[] = [
  {
    schemaKey: "insurance.product.Product",
    label: "保险产品",
    domain: "product",
    entityType: "product",
    universalType: "entity",
    purpose: "一个独立保险产品的完整画像，是所有销售活动的基础底座。",
    fields: [
      f("product_code", "产品代码", "优先使用官方产品代码；没有则使用稳定 dedup_key。", "critical"),
      f("product_name", "官方完整名称", "官方条款或说明书中的完整名称。", "critical"),
      f("product_category", "产品大类", "重疾/医疗/年金/终身寿/定期寿/意外/教育金/养老金等。", "critical"),
      f("product_status", "产品业务状态", "在售/即将停售/已停售/调整中。不要和通用 status 混用。", "critical"),
      f("effective_date", "上线日期", "官方生效或上线日期。", "critical"),
      f("regulatory_filing_no", "监管备案号", "合规必备；缺失进入 knowledge_gaps。", "critical"),
      f("core_responsibilities", "核心保险责任", "结构化列出责任名称、触发条件、给付比例/金额、次数限制。", "critical"),
      f("exclusions_official", "责任免除", "结构化列出官方免责条款。", "critical"),
      f("product_alias", "别名/俗称", "客户或代理人常用叫法。", "high_confidence"),
      f("target_age_range", "投保年龄范围", "例如 18-55 周岁。", "high_confidence"),
      f("waiting_period_days", "等待期天数", "数字字段，能抽数字就抽数字。", "high_confidence"),
      f("payment_period_options", "交费期选项", "趸交/3年/5年/10年/20年/30年/终身等。", "high_confidence"),
      f("coverage_period_options", "保障期间选项", "例如终身、至70岁。", "high_confidence"),
      f("premium_calculation_basis", "费率基础", "性别费率/统一费率/职业类别等。", "high_confidence"),
      f("claim_settlement_logic", "理赔触发逻辑", "确诊、达到状态、实施手术等触发条件。", "high_confidence"),
      f("product_documents", "产品文档", "条款、说明书、费率表、健康告知等来源路径。", "high_confidence"),
      f("underwriting_basics", "核保基本要求", "健康告知、财务核保门槛、职业限制。", "high_confidence"),
      f("selling_points_official", "官方卖点", "总部官方卖点摘要。", "recommended"),
      f("typical_premium_examples", "典型费率示例", "年龄+保额+保费，缺失不要编造。", "recommended"),
      f("related_service_packages", "关联服务权益包", "服务权益用 Product 或 SellingPoint 关系表达。", "recommended"),
      f("usage_count_in_pitches", "被话术引用次数", "业务系统反哺，LLM 不抽取，默认 null。", "auto_derived"),
    ],
    relationHints: [
      "Customer.Persona 用 recommended_for",
      "Method.Pitch / Method.ObjectionHandling 用 applies_to 或 supports",
      "Compliance.ComplianceRule 用 governed_by",
      "Cases.SuccessCase 用 supported_by",
      "Content.Asset 用 uses_asset",
    ],
    lintRules: [
      "product_documents 缺失时阻塞发布到 active。",
      "已停售产品 6 个月后应进入历史产品分区。",
      "产品迭代时旧版本标记 superseded_by，关联 Pitch 进入待审。",
    ],
  },
  {
    schemaKey: "insurance.product.ServicePlan",
    label: "健康服务计划",
    domain: "product",
    entityType: "service_plan",
    universalType: "entity",
    purpose: "打包式健康服务权益包（非保险产品）。与保险产品的核心区别：不涉及保险责任、监管备案、理赔逻辑，而是提供有组织的服务内容和履约流程。例如“平安臻享家医健康服务计划”。",
    fields: [
      f("plan_name", "计划官方名称", "官方完整名称，如“平安臻享家医健康服务计划”。", "critical"),
      f("plan_version", "版本/年份", "如“2025年4月版”；多版本共存时是 dedup_key 的一部分。", "critical"),
      f("service_scope", "服务范围概述", "本计划提供哪些大类服务，一句话概述。", "critical"),
      f("eligible_customers", "适用客户", "谁可以使用本计划（保单持有人/被保险人/家属等）。", "critical"),
      f("activation_conditions", "激活条件", "如何激活/领取本计划的服务，例如“保单生效后30天内在APP激活”。", "high_confidence"),
      f("service_period", "服务有效期", "本计划的服务期限，例如“保单年度内”。", "high_confidence"),
      f("service_provider", "服务提供方", "由哪家机构或平台提供服务。", "high_confidence"),
      f("coverage_regions", "服务覆盖地区", "全国/部分城市/境内外等。", "high_confidence"),
      f("plan_code", "计划代码", "内部编号或SKU代码；无则留空。", "recommended"),
      f("subscription_channel", "服务入口/订阅渠道", "APP入口、客服热线、专属链接等。", "recommended"),
      f("compliance_notes", "合规与免责说明", "服务限制、免责条款摘要。", "recommended"),
      f("related_insurance_products", "关联保险产品", "本计划附属于哪些保险产品。", "recommended"),
    ],
    relationHints: [
      "service_benefit 子服务用 has_part",
      "关联保险产品用 bundled_with 或 part_of",
      "适用客户画像用 recommended_for",
      "来源文档用 sourced_from",
    ],
    lintRules: [
      "plan_name 和 plan_version 必须稳定，是 dedup_key 的基础。",
      "has_part 关系应覆盖全部 service_benefit 子页面。",
    ],
  },
  {
    schemaKey: "insurance.product.ProductCombo",
    label: "产品组合方案",
    domain: "product",
    entityType: "product_combo",
    universalType: "entity",
    purpose: "多个产品的标准搭配方案；实际面访中常卖组合而不是单品。",
    fields: [
      f("combo_name", "方案名", "有画面感的组合名称。", "critical"),
      f("included_products", "包含产品", "产品列表及各自保额/保费配置。", "critical"),
      f("target_customer_profile", "目标客户画像", "适合的客户画像。", "critical"),
      f("core_logic", "配置逻辑", "为什么这样搭配。", "critical"),
      f("typical_premium_total", "典型总保费", "保费总额区间。", "high_confidence"),
      f("coverage_logic", "保障逻辑", "各产品分别承担什么风险。", "high_confidence"),
      f("configuration_priorities", "配置优先级", "先买什么，再买什么。", "high_confidence"),
      f("upgrade_path", "升级路径", "预算增加后如何加保。", "high_confidence"),
      f("downgrade_path", "降级方案", "预算紧张时优先保留/裁剪什么。", "recommended"),
    ],
    relationHints: ["included_products 用 has_part", "target_customer_profile 用 recommended_for"],
  },
  {
    schemaKey: "insurance.product.SellingPoint",
    label: "产品卖点",
    domain: "product",
    entityType: "selling_point",
    universalType: "concept",
    purpose: "产品的独立卖点，可被多个 Pitch 复用，是 Method 域和 Product 域的接口。",
    fields: [
      f("related_product", "关联产品", "卖点对应哪个产品。", "critical"),
      f("point_name", "卖点命名", "简短有力。", "critical"),
      f("core_value", "客户核心价值", "客户为什么在意。", "critical"),
      f("data_support", "支持数据/凭据", "杜绝拍脑袋，缺失则 needs_review。", "critical"),
      f("point_category", "卖点类别", "保障范围/赔付条件/费率优势/服务权益/品牌信任等。", "high_confidence"),
      f("target_persona", "敏感客户画像", "哪类客户最敏感。", "high_confidence"),
      f("sensitivity_level", "合规敏感度", "低/中/高。", "high_confidence"),
      f("common_misconception", "常见误解", "客户可能误解什么。", "high_confidence"),
      f("emotional_hook", "情感钩子", "讲卖点时如何引发共鸣。", "recommended"),
    ],
    relationHints: ["related_product 用 applies_to", "target_persona 用 recommended_for", "高敏感卖点用 governed_by"],
  },
  {
    schemaKey: "insurance.product.RegulatoryDoc",
    label: "监管/官方文件",
    domain: "product",
    entityType: "regulatory_doc",
    universalType: "source",
    purpose: "产品官方法定文档，是唯一真相源。LLM 只能引用和抽取，不能改写为新事实源。",
    fields: [
      f("related_product", "关联产品", "文件对应的产品。", "critical"),
      f("doc_type", "文档类型", "合同条款/说明书/费率表/宣传单页/健康告知/投保提示书。", "critical"),
      f("effective_version", "生效版本", "版本号或版本说明。", "critical"),
      f("file_url", "文件路径", "原始文件路径。", "critical"),
      f("effective_date", "生效日期", "官方生效日期。", "critical"),
      f("regulatory_approval_no", "监管批文号", "如材料提供则抽取。", "high_confidence"),
      f("key_clauses_index", "关键条款索引", "便于代理人定位。", "high_confidence"),
      f("immutable", "不可改写", "固定 true。", "critical"),
    ],
    relationHints: ["related_product 用 describes 或 applies_to"],
  },
  {
    schemaKey: "insurance.product.ServiceBenefit",
    label: "服务权益",
    domain: "product",
    entityType: "service_benefit",
    universalType: "entity",
    purpose: "保险产品附带或独立配置的服务权益，是保单服务、客户经营和销售价值表达的重要产品知识。",
    fields: [
      f("service_name", "服务名称", "官方或材料中的服务/权益名称。", "critical"),
      f("related_product", "关联产品/计划", "服务权益归属的产品、健康服务计划或权益包。", "critical"),
      f("service_category", "服务类别", "家庭医生/问诊/就医协助/住院照护/康复/海外医疗等。", "critical"),
      f("core_value", "核心价值", "这项服务解决客户什么问题。", "critical"),
      f("eligible_customers", "适用对象", "可使用服务的人群、保单/产品条件、权益人范围。", "high_confidence"),
      f("service_frequency", "服务次数", "不限次、每年N次、首年每人N次、服务期内N次等。", "high_confidence"),
      f("application_process", "申请/使用流程", "入口、申请步骤、预约/响应方式。", "high_confidence"),
      f("time_limits", "响应/完成时效", "T+N、工作日、服务窗口、有效期等。", "high_confidence"),
      f("service_provider", "服务提供方", "平安健康、北医医院管理等实际服务方。", "high_confidence"),
      f("coverage_scope", "覆盖范围", "地区、医院、服务内容边界、是否线上/线下。", "high_confidence"),
      f("service_limits", "使用限制", "不适用情形、非共享、等待期、次数限制等。", "high_confidence"),
      f("compliance_notes", "合规提醒", "免责、不保证、不等同保险责任或诊疗承诺等。", "high_confidence"),
      f("customer_scenarios", "客户使用场景", "哪些客户/业务阶段适合讲这项服务。", "recommended"),
      f("related_methods", "关联销售方法", "可关联的话术、异议处理或服务经营方法。", "recommended"),
      f("knowledge_gaps", "待补全信息", "材料未提供但业务需要补齐的字段。", "recommended"),
    ],
    relationHints: [
      "related_product 用 has_part 或 applies_to",
      "Compliance.ComplianceRule 用 governed_by",
      "Method.Pitch / ObjectionHandling 用 supports 或 used_by_pitch",
      "Cases.SuccessCase 用 supported_by",
    ],
    lintRules: [
      "service_name 和 related_product 缺失时不能进入 active。",
      "服务次数、适用对象、使用限制、合规提醒至少应有一类明确证据。",
      "服务权益不能被描述为保险金责任。",
    ],
  },

  // ─── Service Hierarchy v2 ────────────────────────────────────────────────────
  // 五级层级: 系列 > 场景 > 服务线 > 服务线版本 > 服务项
  // 命名约定: {service_line}-{version}-{item_name}（如 臻享家医-V1-在线问诊）
  // 聚合页:  service_item_concept 提供跨版本通用定义
  //
  // 来源：《服务权益知识结构.xlsx》- 服务线视角
  {
    schemaKey: "insurance.service.ServiceSeries",
    label: "服务系列",
    domain: "service",
    entityType: "service_series",
    universalType: "concept",
    purpose: "服务知识体系的顶层分类，如『添平安系列』/『享平安系列』。",
    fields: [
      f("series_name", "系列名称", "如：添平安系列、享平安系列。", "critical"),
      f("series_summary", "系列简介", "本系列的整体定位和覆盖范围。", "high_confidence"),
      f("build_status", "建设状态", "已建设 / 待后续建设。", "recommended"),
    ],
    relationHints: [
      "service_scenario 子节点用 has_part",
    ],
  },
  {
    schemaKey: "insurance.service.ServiceScenario",
    label: "服务场景",
    domain: "service",
    entityType: "service_scenario",
    universalType: "concept",
    purpose: "服务系列下的业务场景分类，如『医健』/『养老』/『家办』。是服务线的上级节点，用于导航型查询。",
    fields: [
      f("scenario_name", "场景名称", "如：医健、养老、家办。", "critical"),
      f("series_name", "所属系列", "所属的服务系列名称。", "critical"),
      f("scenario_summary", "场景简介", "本场景覆盖哪类客户需求。", "high_confidence"),
    ],
    relationHints: [
      "service_line 子节点用 has_part",
      "所属 service_series 用 part_of",
    ],
  },
  {
    schemaKey: "insurance.service.ServiceLine",
    label: "服务线",
    domain: "service",
    entityType: "service_line",
    universalType: "entity",
    purpose: "场景下的具体服务产品线，如『安有医』/『臻享家医』/『居家养老』。一条服务线可有多个版本。",
    fields: [
      f("line_name", "服务线名称", "如：安有医、臻享家医、居家养老。", "critical"),
      f("scenario_name", "所属场景", "医健 / 养老 / 家办。", "critical"),
      f("series_name", "所属系列", "添平安系列 / 享平安系列。", "critical"),
      f("line_summary", "服务线简介", "本服务线的整体定位。", "high_confidence"),
      f("target_customers", "目标客群", "面向的客户类型。", "high_confidence"),
    ],
    relationHints: [
      "service_line_version 子版本用 has_part",
      "所属 service_scenario 用 part_of",
    ],
  },
  {
    schemaKey: "insurance.service.ServiceLineVersion",
    label: "服务线版本",
    domain: "service",
    entityType: "service_line_version",
    universalType: "entity",
    purpose: "服务线的具体版本，如『臻享家医 V1』/『安有医 颐享版』。用户上传文件的最小归属单元。包含准入规则、服务体系等完整版本内容。",
    fields: [
      f("line_name", "服务线名称", "如：臻享家医、安有医、居家养老。", "critical"),
      f("version_name", "版本名称", "如：V1、颐享版、V2优享。", "critical"),
      f("scenario_name", "所属场景", "医健 / 养老 / 家办。", "critical"),
      f("series_name", "所属系列", "添平安系列。", "high_confidence"),
      // 准入规则
      f("admission_rules", "准入规则", "哪些客户可以获得本版本服务。", "high_confidence"),
      f("qualification_threshold", "达标门槛", "如：保费达到X万元。", "high_confidence"),
      f("designated_products", "指定产品", "绑定哪些保险产品可获本版本服务。", "high_confidence"),
      f("effective_date_rule", "生效时间", "服务何时生效，如保单生效后30天内激活。", "high_confidence"),
      f("eligible_persons", "权益人规则", "被保险人/投保人/家属等使用规则。", "high_confidence"),
      f("service_period", "服务期限", "服务有效期，如保单年度内。", "high_confidence"),
      // 服务详情
      f("service_entry", "服务入口", "APP入口、热线、专属链接等。", "high_confidence"),
      f("service_system", "服务体系", "本版本包含哪些服务线和服务项目总览。", "high_confidence"),
      f("coverage_scope", "服务覆盖范围", "地区、城市、线上/线下覆盖。", "high_confidence"),
      f("usage_notes", "注意事项", "使用限制和合规提示。", "high_confidence"),
      f("service_process", "服务流程", "整体服务流程概述。", "recommended"),
      f("compliance_notes", "合规说明", "免责条款和合规提示。", "recommended"),
    ],
    relationHints: [
      "service_item 子服务项用 has_part",
      "所属 service_line 用 part_of",
      "关联保险产品用 bundled_with",
    ],
    lintRules: [
      "line_name 和 version_name 是 DEDUP_KEY，一旦确定不能随意修改。",
      "has_part 关系应覆盖该版本下所有 service_item 实体。",
    ],
  },
  {
    schemaKey: "insurance.service.ServiceItem",
    label: "服务项",
    domain: "service",
    entityType: "service_item",
    universalType: "entity",
    purpose: "服务线版本下的具体服务项目，是服务知识的最小业务单元。命名规范：{service_line}-{version}-{item_name}，如『臻享家医-V1-在线问诊』。",
    fields: [
      // === DEDUP KEY 三元组（必须 critical）===
      f("line_name", "服务线名称", "如：臻享家医、安有医、居家养老。是 DEDUP_KEY 的一部分。", "critical"),
      f("version_name", "服务线版本", "如：V1、颐享版、V2优享。是 DEDUP_KEY 的一部分。", "critical"),
      f("item_name", "服务项名称", "如：在线问诊、家庭医生服务。是 DEDUP_KEY 的一部分。", "critical"),
      // === 层级归属字段 ===
      f("scenario_name", "所属场景", "医健 / 养老 / 家办。", "critical"),
      f("series_name", "所属系列", "添平安系列 / 享平安系列。", "high_confidence"),
      // === 服务内容字段（来自 Sheet 2）===
      f("service_scenario", "服务场景", "此服务项适用的使用场景（用户场景描述）。", "high_confidence"),
      f("service_stage", "服务阶段", "此服务项所属的服务阶段（如：健康管理/就医协助/康复护理）。", "high_confidence"),
      f("service_intro", "服务项目介绍", "对本服务项的整体介绍说明。", "high_confidence"),
      f("service_frequency", "服务次数", "不限次 / 每年N次 / 服务期内N次。", "high_confidence"),
      f("service_content", "服务内容", "本服务项具体提供的内容明细。", "high_confidence"),
      f("service_standard", "服务标准", "服务质量标准和承诺。", "high_confidence"),
      f("activation_conditions", "服务启动条件", "激活/开通本服务项的前提条件。", "high_confidence"),
      f("eligible_customers", "适用人群", "谁可以使用本服务项。", "high_confidence"),
      f("coverage_cities", "服务覆盖城市", "服务可用的城市范围。", "high_confidence"),
      f("usage_process", "服务项目使用流程", "如何申请/使用本服务。", "high_confidence"),
      f("service_notes", "服务说明", "补充说明、限制条件。", "high_confidence"),
      f("important_notes", "重要提示", "使用前需注意的关键信息。", "high_confidence"),
      f("marketing_materials", "触客素材", "关联销售素材、宣传材料路径。", "recommended"),
      f("faq", "常见Q&A", "客户常见问题与解答。", "recommended"),
      f("service_features", "服务特色", "按需扩展字段，如特色优势、独特价值。", "recommended"),
      f("knowledge_gaps", "待补全信息", "材料未提供的缺失字段。", "recommended"),
    ],
    relationHints: [
      "所属 service_line_version 用 part_of",
      "通用概念页 service_item_concept 用 instance_of",
      "ComplianceRule 用 governed_by",
      "Pitch/ObjectionHandling 用 supports",
    ],
    lintRules: [
      "实体标题必须遵循 {line_name}-{version_name}-{item_name} 命名规范。",
      "line_name / version_name / item_name 三字段缺失时不能进入 active。",
      "服务项不能被描述为保险金责任或理赔内容。",
      "service_frequency 和 eligible_customers 至少一项有证据支持。",
    ],
  },
  {
    schemaKey: "insurance.service.ServiceItemConcept",
    label: "服务项聚合页",
    domain: "service",
    entityType: "service_item_concept",
    universalType: "concept",
    purpose: "跨版本的服务项通用概念定义页，提供服务的通用介绍，不含具体版本的次数/限制等参数。通过 has_instance 关系链接到各版本的 service_item 实体。",
    fields: [
      f("item_name", "服务项概念名称", "如：在线问诊、家庭医生服务。", "critical"),
      f("concept_summary", "通用概念简介", "跨版本的通用定义，不写具体次数和限制。", "critical"),
      f("concept_category", "概念类别", "问诊 / 就医协助 / 康复 / 居家护理 / 健康管理等。", "high_confidence"),
      f("common_scenarios", "通用使用场景", "这类服务项的通用适用场景。", "recommended"),
    ],
    relationHints: [
      "各版本具体实例 service_item 用 has_instance（反向为 instance_of）",
    ],
    lintRules: [
      "聚合页只写通用定义，不写具体版本的次数/城市/限制。",
      "has_instance 关系应覆盖所有已知版本实例。",
    ],
  },

  {
    schemaKey: "insurance.customer.Persona",

    label: "客户画像",
    domain: "customer",
    entityType: "persona",
    universalType: "entity",
    purpose: "具有营销意义的客户类型抽象，是销售域最重要的锚点实体。",
    fields: [
      f("persona_name", "画像命名", "具体、有画面感。", "critical"),
      f("persona_level", "画像层级", "L1 大类/L2 子类/L3 细分。", "critical"),
      f("one_line_summary", "一句话识别", "给代理人快速识别用。", "critical"),
      f("age_band", "年龄段", "人口学字段。", "high_confidence"),
      f("income_band", "收入区间", "年家庭收入。", "high_confidence"),
      f("family_structure", "家庭结构", "单身/三口之家/多孩/三代同堂等。", "high_confidence"),
      f("occupation_categories", "职业类别", "职业或行业特征。", "high_confidence"),
      f("housing_status", "居住状态", "自有/租房/有贷款。", "high_confidence"),
      f("existing_insurance", "已有保险", "裸奔/有医疗/有重疾/有全套等。", "high_confidence"),
      f("core_values", "核心价值观", "家庭至上/事业优先/安稳第一等。", "high_confidence"),
      f("risk_preference", "风险偏好", "极保守/保守/中性/激进。", "high_confidence"),
      f("decision_style", "决策风格", "冲动/理性/共识/拖延。", "high_confidence"),
      f("influence_sensitivity", "影响因素", "数据/案例/权威/情感/亲友。", "high_confidence"),
      f("purchase_signals", "购买信号", "语言/行为信号。", "high_confidence"),
      f("channel_preference", "渠道偏好", "线下/微信/电话/视频。", "high_confidence"),
      f("content_preference", "内容偏好", "深度文章/短视频/图文/直播。", "high_confidence"),
      f("typical_pain_points", "典型痛点", "影响需求触发。", "recommended"),
      f("typical_objections", "典型异议", "影响成交的异议。", "recommended"),
      f("matching_products", "匹配产品", "应通过 relations 同步表达。", "recommended"),
    ],
    relationHints: [
      "matching_products 用 has_recommendation 或 recommended_for 的反向关系",
      "SellingScenario 用 applies_to 或 recommended_for",
      "Content.Asset 用 uses_asset",
    ],
    lintRules: [
      "Persona 不应只有人口学层，必须尽量包含行为信号。",
      "必须至少链接 3 个 SellingScenario 才能进入 high confidence。",
      "同名画像出现 2 次以上提示归并。",
    ],
  },
  {
    schemaKey: "insurance.customer.LifeStage",
    label: "生命周期阶段",
    domain: "customer",
    entityType: "life_stage",
    universalType: "event",
    purpose: "客户人生关键节点，是销售切入的最佳时机。",
    fields: [
      f("stage_name", "阶段命名", "新婚/孕期/育儿/购房/晋升/退休临近等。", "critical"),
      f("stage_category", "阶段大类", "家庭/职业/财富/健康。", "critical"),
      f("typical_age_band", "典型年龄段", "进入该阶段的常见年龄。", "critical"),
      f("typical_duration", "持续时长", "几周/几个月/几年。", "critical"),
      f("key_concerns", "核心担忧", "这个阶段最关心什么。", "high_confidence"),
      f("financial_state_changes", "财务状态变化", "收入/支出/储蓄/负债变化。", "high_confidence"),
      f("trigger_signals", "触发信号", "如何识别客户进入该阶段。", "high_confidence"),
      f("approach_principle", "接近原则", "主动/被动，直接/间接。", "high_confidence"),
    ],
    relationHints: ["Persona 用 applies_to", "Product 用 recommended_for", "SellingScenario 用 applies_to"],
  },
  {
    schemaKey: "insurance.customer.CustomerSignal",
    label: "客户信号",
    domain: "customer",
    entityType: "customer_signal",
    universalType: "data",
    purpose: "可观察到的、暗示客户状态的具体信号，是一线经验资产。",
    fields: [
      f("signal_type", "信号类型", "语言/行为/社交/数据信号。", "critical"),
      f("signal_description", "信号描述", "具体可观察表现。", "critical"),
      f("what_it_might_mean", "可能含义", "通常意味着什么。", "critical"),
      f("response_suggestion", "回应建议", "看到信号后该怎么反应。", "critical"),
      f("signal_strength", "信号强度", "弱/中/强。", "high_confidence"),
      f("source_agent", "source agent", "Agent, staff member, or channel that observed or validated this signal.", "high_confidence"),
      f("signal_reliability", "可靠度", "可能/大概率/几乎确定。", "high_confidence"),
      f("false_positive_warning", "误判警告", "什么情况下可能是假的。", "recommended"),
    ],
    relationHints: ["Persona 用 applies_to", "Method.ObjectionHandling 用 supports"],
  },
  {
    schemaKey: "insurance.customer.CustomerRelationship",
    label: "客户关系图",
    domain: "customer",
    entityType: "customer_relationship",
    universalType: "entity",
    purpose: "典型家庭关系网络和决策影响关系，当前作为待定实体谨慎抽取。",
    fields: [
      f("root_customer", "主客户", "脱敏后的主客户。", "critical"),
      f("relationship_type", "关系类型", "配偶/父母/子女/朋友/同事等。", "critical"),
      f("relationship_strength", "关系强度", "强/中/弱。", "high_confidence"),
      f("decision_role", "决策角色", "决策者/影响者/否决者/旁观者。", "high_confidence"),
      f("referral_potential", "转介绍可能性", "评分或定性描述。", "recommended"),
    ],
    relationHints: ["ReferralMethod 用 applies_to", "Persona 用 describes"],
  },
  {
    schemaKey: "insurance.method.SellingScenario",
    label: "销售场景",
    domain: "method",
    entityType: "selling_scenario",
    universalType: "process",
    purpose: "什么样的人、什么时机、什么目标的具体销售场景。",
    fields: [
      f("scenario_name", "场景命名", "画面感强。", "critical"),
      f("business_phases", "业务环节", "获客/触客/邀约/促成/签单/经营/转介绍，可多个。", "critical"),
      f("target_personas", "目标画像", "关联客户画像。", "critical"),
      f("sales_goal", "销售目标", "签首单/加保/转介绍/激活/复购。", "critical"),
      f("life_stage_trigger", "生命周期触发", "如适用则抽取。", "high_confidence"),
      f("typical_context", "具体情境", "地点/方式。", "high_confidence"),
      f("approach_strategy", "接近策略", "如何切入。", "high_confidence"),
      f("success_criteria", "成功标准", "如何判断该场景推进成功。", "high_confidence"),
      f("common_pitfalls", "常见坑", "容易踩的问题。", "high_confidence"),
      f("target_products", "目标产品", "应通过 relations 同步表达。", "recommended"),
      f("typical_objections", "典型异议", "此场景下常见异议。", "recommended"),
    ],
    relationHints: [
      "target_personas 用 applies_to",
      "target_products 用 applies_to",
      "Pitch 用 supports",
      "ObjectionHandling 用 mitigated_by",
      "Content.Asset 用 uses_asset",
    ],
    lintRules: ["至少链接 1 个 Pitch、2 个 ObjectionHandling、1 个 Asset 才能 high confidence。"],
  },
  {
    schemaKey: "insurance.method.Pitch",
    label: "话术",
    domain: "method",
    entityType: "pitch",
    universalType: "process",
    purpose: "在某个场景下具体怎么说。",
    fields: [
      f("related_scenario", "关联场景", "对应哪个 SellingScenario。", "critical"),
      f("pitch_type", "话术类型", "开场/破冰/需求挖掘/产品讲解/异议回应/促成等。", "critical"),
      f("script", "话术原文", "客户可听懂的原话。", "critical"),
      f("core_message", "核心传递点", "这段话要传递什么。", "critical"),
      f("delivery_mode", "交付方式", "面对面/电话/微信/视频/朋友圈。", "high_confidence"),
      f("tone", "语气", "专业/亲和/紧迫/共情/权威。", "high_confidence"),
      f("source_agent", "source agent", "Agent, staff member, or channel that supplied or validated this pitch.", "high_confidence"),
      f("emotional_hook", "情感钩子", "如何引发共鸣。", "high_confidence"),
      f("structure_breakdown", "结构拆解", "开场-钩子-内容-收尾各自作用。", "high_confidence"),
      f("context_constraints", "适用约束", "什么情况下不能用。", "high_confidence"),
      f("personalization_slots", "个性化插槽", "客户姓名/客户痛点等。", "recommended"),
      f("contains_yield_claim", "是否含收益承诺", "自动触发合规审核。", "auto_derived"),
      f("contains_competitor_comparison", "是否含竞品比较", "合规敏感。", "auto_derived"),
    ],
    relationHints: [
      "related_scenario 用 applies_to",
      "Product/SellingPoint 用 supports",
      "Compliance.Rule 用 governed_by",
      "Content.Asset 用 uses_asset",
    ],
  },
  {
    schemaKey: "insurance.method.ObjectionHandling",
    label: "异议处理",
    domain: "method",
    entityType: "objection_handling",
    universalType: "process",
    purpose: "客户提出疑虑或拒绝时怎么回应。",
    fields: [
      f("objection_raw", "客户原话", "客户原话或典型表达。", "critical"),
      f("objection_category", "异议类别", "价格/信任/需求/时机/家庭决策/竞品/服务等。", "critical"),
      f("response_strategy", "应对策略", "先认可、再澄清、再引导等。", "critical"),
      f("response_script", "应对话术", "可直接复用的回应。", "critical"),
      f("objection_root_cause", "真实根因", "LLM 可协助分析，但要标注置信度。", "high_confidence"),
      f("common_disguises", "伪装表达", "同一异议的不同说法。", "high_confidence"),
      f("source_agent", "source agent", "Agent, staff member, or channel that observed or validated this objection handling.", "high_confidence"),
      f("escalation_path", "升级路径", "说服不了如何升级。", "high_confidence"),
      f("acceptable_loss", "放弃条件", "何时不该硬刚。", "high_confidence"),
      f("typical_followup_objection", "后续异议", "过了这一关后常见下一问。", "recommended"),
      f("persona_specificity", "画像特异性", "哪些画像最常提。", "recommended"),
    ],
    relationHints: [
      "Product/SellingPoint 用 applies_to",
      "Persona 用 recommended_for",
      "CustomerVoice 用 has_evidence",
      "Compliance.Rule 用 governed_by",
    ],
  },
  {
    schemaKey: "insurance.method.SalesPath",
    label: "销售路径",
    domain: "method",
    entityType: "sales_path",
    universalType: "process",
    purpose: "从首次接触到成交的完整路径设计，是顶尖代理人的打法沉淀。",
    fields: [
      f("path_name", "路径名称", "打法名称。", "critical"),
      f("target_persona", "目标画像", "适合谁。", "critical"),
      f("target_product_or_combo", "目标产品/组合", "卖什么。", "critical"),
      f("starting_state", "起点", "客户初始状态。", "critical"),
      f("ending_state", "终点", "成交/加保/转介绍等。", "critical"),
      f("steps", "步骤序列", "每步包含动作、话术、素材、预期反应。", "critical"),
      f("critical_milestones", "关键里程碑", "推进判断点。", "high_confidence"),
      f("drop_off_points", "常见流失点", "在哪里掉线。", "high_confidence"),
      f("drop_off_handling", "流失应对", "如何挽回。", "high_confidence"),
    ],
    relationHints: ["Persona 用 applies_to", "ProductCombo/Product 用 applies_to", "Pitch/Asset 用 supports 或 uses_asset"],
  },
  {
    schemaKey: "insurance.method.SalesPlaybook",
    label: "销售剧本",
    domain: "method",
    entityType: "sales_playbook",
    universalType: "process",
    purpose: "企业级可复用完整销售剧本，适用于某活动、产品或客群。",
    fields: [
      f("playbook_name", "剧本名", "剧本名称。", "critical"),
      f("applicable_context", "适用上下文", "产品发布/年末冲刺/活动/客群。", "critical"),
      f("duration", "剧本时长", "整体周期。", "critical"),
      f("scenes", "场景序列", "包含哪些 SellingScenario。", "critical"),
      f("target_persona", "目标画像", "面向谁。", "high_confidence"),
      f("kpi_milestones", "KPI 里程碑", "关键过程指标。", "high_confidence"),
      f("required_resources", "所需资源", "素材/活动支持/审批。", "high_confidence"),
    ],
    relationHints: ["SellingScenario 用 has_part", "Campaign 用 applies_to", "Content.Asset 用 uses_asset"],
  },
  {
    schemaKey: "insurance.method.ReferralMethod",
    label: "转介绍方法",
    domain: "method",
    entityType: "referral_method",
    universalType: "process",
    purpose: "怎么从老客户撬动新客户，是保险业务命脉。",
    fields: [
      f("method_name", "方法名", "方法名称。", "critical"),
      f("timing", "开口时机", "什么时候开口。", "critical"),
      f("opening_script", "开口话术", "怎么开口。", "critical"),
      f("tracking_mechanism", "追踪机制", "如何跟踪转介绍。", "critical"),
      f("target_referrer_profile", "介绍人画像", "适合向谁要转介绍。", "high_confidence"),
      f("typical_referee_profile", "被介绍人画像", "通常介绍谁。", "high_confidence"),
      f("incentive_design", "激励设计", "如有，需合规。", "high_confidence"),
      f("source_agent", "source agent", "Agent, staff member, or channel that supplied or validated this referral method.", "high_confidence"),
      f("thank_you_protocol", "答谢机制", "如何答谢。", "high_confidence"),
      f("taboo", "禁忌做法", "不能怎么做。", "recommended"),
    ],
    relationHints: ["Persona 用 applies_to", "ReferralCase 用 supported_by", "Compliance.Rule 用 governed_by"],
  },
  {
    schemaKey: "insurance.method.NeedsDiscovery",
    label: "需求挖掘方法",
    domain: "method",
    entityType: "needs_discovery",
    universalType: "process",
    purpose: "代理人如何问出客户需求和保障缺口。",
    fields: [
      f("method_name", "方法名", "KYC/财务体检/家庭结构梳理/风险地图等。", "critical"),
      f("discovery_goal", "挖掘目标", "要发现什么。", "critical"),
      f("question_framework", "提问框架", "结构化问题框架。", "high_confidence"),
      f("question_sequence", "提问顺序", "先问什么后问什么。", "high_confidence"),
      f("information_to_collect", "收集信息", "收入/家庭/健康/资产/负债等。", "high_confidence"),
      f("sensitive_question_handling", "敏感问题处理", "收入、家庭、健康问题怎么问。", "high_confidence"),
    ],
    relationHints: ["Persona 用 applies_to", "SellingScenario 用 supports", "Compliance.Rule 用 governed_by"],
  },
  {
    schemaKey: "insurance.cases.SuccessCase",
    label: "成交/服务成功案例",
    domain: "cases",
    entityType: "success_case",
    universalType: "case",
    purpose: "真实发生且可复用的成功案例，沉淀客户背景、关键动作、结果和可复制经验。",
    fields: [
      f("customer_profile_brief", "客户画像简述", "脱敏后的客户年龄、地区、家庭/健康/财富背景。", "critical"),
      f("product_or_combo_sold", "关联产品/服务", "成交或服务案例中涉及的产品、服务权益或组合。", "critical"),
      f("premium_amount_band", "保费区间", "如涉及成交，脱敏到区间；没有则 null。", "critical"),
      f("approach_summary", "核心做法", "代理人或服务团队的关键做法。", "critical"),
      f("key_moments", "关键转折点", "案例中最有复用价值的转折。", "critical"),
      f("life_stage_at_time", "当时生命周期阶段", "如疾病疑似确诊、治疗期、家庭责任高峰等。", "high_confidence"),
      f("background_context", "背景情境", "客户问题、触发事件、时间/地点。", "high_confidence"),
      f("first_contact_to_close_duration", "推进周期", "从首次接触/服务触发到结果的时间。", "high_confidence"),
      f("difficulty_level", "难度评估", "顺水推舟/常规/挑战/极难。", "high_confidence"),
      f("related_personas", "关联画像", "可匹配的客户画像。", "high_confidence"),
      f("related_scenarios", "关联场景", "关联的服务经营、促成、转介绍等场景。", "high_confidence"),
      f("related_pitches", "关联话术", "案例中可复用的话术或解释。", "recommended"),
      f("related_objections", "处理过的异议", "案例中客户提出过的问题或异议。", "recommended"),
      f("related_assets", "使用素材", "如海报、说明页、QA、服务手册。", "recommended"),
      f("lessons_learned", "经验教训", "对代理人/服务人员可复用的经验。", "recommended"),
      f("knowledge_gaps", "待补全信息", "缺失但影响复用的信息。", "recommended"),
    ],
    relationHints: [
      "Product/ServiceBenefit 用 applies_to 或 supported_by",
      "Method.SalesPath/Pitch/ObjectionHandling 用 supports",
      "Customer.Persona 用 applies_to",
      "Compliance.Rule 用 governed_by",
    ],
  },
  {
    schemaKey: "insurance.cases.CustomerVoice",
    label: "客户原声",
    domain: "cases",
    entityType: "customer_voice",
    universalType: "data",
    purpose: "来自客户的真实反馈、表达或原话，是异议库、需求库和画像库的证据来源。",
    fields: [
      f("voice_type", "原声类型", "正面认可/犹豫/异议/拒绝/转介绍意愿/投诉/咨询。", "critical"),
      f("raw_text", "原话/反馈", "脱敏后的客户原话或尽量贴近原文的转述。", "critical"),
      f("context", "发生情境", "客户在什么场景下说出这句话。", "critical"),
      f("related_persona", "关联画像", "客户对应的画像或人群。", "high_confidence"),
      f("capture_date", "捕获日期", "材料提供则抽取。", "high_confidence"),
      f("source_agent", "source agent", "Agent, staff member, or channel that captured or validated this customer voice.", "high_confidence"),
      f("emotional_tone", "情绪基调", "认可/焦虑/怀疑/感谢/抗拒等。", "high_confidence"),
      f("is_verbatim", "是否逐字记录", "true/false/unknown。", "high_confidence"),
      f("what_triggered_it", "触发原因", "是什么服务、话术或事件触发了反馈。", "recommended"),
      f("agent_response_at_time", "当时回应", "代理人/服务人员如何回应。", "recommended"),
      f("subsequent_outcome", "后续结果", "成交、继续服务、拒绝、转介绍等。", "recommended"),
      f("related_objection", "关联异议", "如果是异议，链接到 ObjectionHandling。", "recommended"),
    ],
    relationHints: [
      "ObjectionHandling 用 has_evidence",
      "SuccessCase 用 supported_by",
      "Persona 用 applies_to",
      "Product/ServiceBenefit 用 applies_to",
    ],
  },
  {
    schemaKey: "insurance.cases.FailureCase",
    label: "Failure case",
    domain: "cases",
    entityType: "failure_case",
    universalType: "case",
    purpose: "Reusable failed sales or service case for risk prevention, coaching, and process improvement.",
    fields: [
      f("title", "case title", "Stable anonymized title for this failure case.", "critical"),
      f("customer_profile_brief", "customer profile brief", "Desensitized customer background and persona hints.", "critical"),
      f("failure_context", "failure context", "When, where, and under what business situation the failure happened.", "critical"),
      f("failure_reason", "failure reason", "Direct reason the sale, service, referral, or retention failed.", "critical"),
      f("product_or_service_involved", "product or service involved", "Related product, service benefit, campaign, or method.", "critical"),
      f("consequence", "consequence", "Lost deal, complaint, compliance risk, churn, or service failure outcome.", "critical"),
      f("source_agent", "source agent", "Agent, staff member, or channel that supplied or validated the case.", "high_confidence"),
      f("warning_signals", "warning signals", "Observable early signals before the failure.", "high_confidence"),
      f("root_cause_analysis", "root cause analysis", "Underlying customer, method, product, timing, or compliance cause.", "high_confidence"),
      f("preventable_actions", "preventable actions", "Actions that could have prevented or reduced the failure.", "high_confidence"),
      f("recovery_actions", "recovery actions", "What was done or could be done to recover the relationship.", "high_confidence"),
      f("related_objections", "related objections", "Objections or concerns linked to this failure.", "recommended"),
      f("related_compliance_rules", "related compliance rules", "Compliance rules implicated by the case.", "recommended"),
      f("lessons_learned", "lessons learned", "Reusable lessons for agents or service staff.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts that affect reuse or review.", "recommended"),
      f("recurrence_risk_score", "recurrence risk score", "System-derived recurrence risk for similar contexts.", "auto_derived"),
      f("anonymization_level", "anonymization level", "System-derived privacy masking level.", "auto_derived"),
    ],
    relationHints: [
      "Product/ServiceBenefit 用 applies_to",
      "ObjectionHandling/SalesPath 用 has_evidence 或 mitigates",
      "Compliance.Rule 用 governed_by",
      "Customer.Persona 用 applies_to",
    ],
  },
  {
    schemaKey: "insurance.cases.ReferralCase",
    label: "Referral case",
    domain: "cases",
    entityType: "referral_case",
    universalType: "case",
    purpose: "Reusable referral story that captures trigger, relationship context, method, follow-up, and outcome.",
    fields: [
      f("title", "case title", "Stable anonymized title for this referral case.", "critical"),
      f("referrer_profile", "referrer profile", "Who made the referral and why they were willing to refer.", "critical"),
      f("referee_profile", "referee profile", "Who was referred and what need or signal was present.", "critical"),
      f("referral_trigger", "referral trigger", "Moment or event that triggered the referral request.", "critical"),
      f("referral_method", "referral method", "Method or script used to ask for and handle the referral.", "critical"),
      f("outcome", "outcome", "Meeting, sale, service, churn prevention, or no-conversion result.", "critical"),
      f("source_agent", "source agent", "Agent, staff member, or channel that supplied or validated the case.", "high_confidence"),
      f("referral_timing", "referral timing", "Timing relative to service, signing, claim, event, or relationship milestone.", "high_confidence"),
      f("relationship_context", "relationship context", "Relationship among agent, referrer, and referee.", "high_confidence"),
      f("trust_basis", "trust basis", "Why the referrer trusted the agent or brand.", "high_confidence"),
      f("follow_up_process", "follow-up process", "Follow-up sequence after the referral was made.", "high_confidence"),
      f("thank_you_action", "thank-you action", "How the referrer was thanked or maintained.", "recommended"),
      f("compliance_notes", "compliance notes", "Incentive, privacy, or promise boundaries.", "recommended"),
      f("reusable_script", "reusable script", "Reusable wording from the case.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts that affect reuse or review.", "recommended"),
      f("repeatability_score", "repeatability score", "System-derived score for reuse in similar situations.", "auto_derived"),
      f("conversion_value_band", "conversion value band", "System-derived or business-provided value band when available.", "auto_derived"),
    ],
    relationHints: [
      "ReferralMethod 用 supported_by",
      "Persona/CustomerRelationship 用 applies_to",
      "Product/ServiceBenefit 用 applies_to",
      "Compliance.Rule 用 governed_by",
    ],
  },
  {
    schemaKey: "insurance.cases.AgentFeedback",
    label: "Agent feedback",
    domain: "cases",
    entityType: "agent_feedback",
    universalType: "data",
    purpose: "Frontline agent feedback about product, customer, method, content, campaign, or system execution.",
    fields: [
      f("feedback_type", "feedback type", "Product, customer, method, content, activity, compliance, or system feedback.", "critical"),
      f("content", "feedback content", "Original or faithfully summarized feedback.", "critical"),
      f("source_agent", "source agent", "Agent, staff member, or channel that supplied the feedback.", "critical"),
      f("context", "context", "Business context where the feedback was produced.", "critical"),
      f("related_topic", "related topic", "Product, persona, method, asset, activity, or rule being discussed.", "critical"),
      f("capture_date", "capture date", "When the feedback was captured.", "high_confidence"),
      f("sentiment", "sentiment", "Positive, negative, mixed, urgent, or neutral.", "high_confidence"),
      f("confidence_level", "confidence level", "How reliable or representative the feedback appears.", "high_confidence"),
      f("affected_workflow", "affected workflow", "Sales, service, referral, compliance review, or content workflow affected.", "high_confidence"),
      f("suggested_action", "suggested action", "Agent's suggestion or inferred improvement action.", "recommended"),
      f("related_assets", "related assets", "Assets, scripts, or templates mentioned.", "recommended"),
      f("related_training_need", "related training need", "Training or coaching gap implied by the feedback.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts that affect actionability.", "recommended"),
      f("duplicate_cluster_id", "duplicate cluster id", "System-derived cluster for similar feedback.", "auto_derived"),
      f("priority_score", "priority score", "System-derived priority for review or action.", "auto_derived"),
    ],
    relationHints: [
      "Product/ServiceBenefit/Persona/Method/Asset/Campaign 用 applies_to",
      "Compliance.Rule 用 governed_by",
      "Content.Asset 用 has_evidence",
    ],
  },
  {
    schemaKey: "insurance.cases.CompetitiveInsight",
    label: "Competitive insight",
    domain: "cases",
    entityType: "competitive_insight",
    universalType: "data",
    purpose: "Competitive market signal captured from customers, agents, campaigns, or field comparisons.",
    fields: [
      f("competitor_name", "competitor name", "Competitor, product, channel, or alternative solution.", "critical"),
      f("insight_type", "insight type", "Price, coverage, service, brand, channel, campaign, objection, or claim.", "critical"),
      f("insight_summary", "insight summary", "Concise factual summary of the competitive signal.", "critical"),
      f("capture_date", "capture date", "When the insight was captured.", "critical"),
      f("source_agent", "source agent", "Agent, staff member, or channel that supplied or validated the insight.", "critical"),
      f("compared_product", "compared product", "Our product, service, or package being compared.", "high_confidence"),
      f("customer_context", "customer context", "Customer persona or buying situation where the insight appeared.", "high_confidence"),
      f("evidence_snippet", "evidence snippet", "Customer quote, material excerpt, or field evidence.", "high_confidence"),
      f("reliability_level", "reliability level", "Rumor, anecdotal, repeated field signal, or documented evidence.", "high_confidence"),
      f("response_strategy", "response strategy", "Suggested compliant response or positioning.", "recommended"),
      f("compliance_notes", "compliance notes", "Boundaries for comparison and competitor mentions.", "recommended"),
      f("related_objections", "related objections", "Objections linked to this insight.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts that affect confidence.", "recommended"),
      f("competitive_pressure_score", "competitive pressure score", "System-derived competitive pressure score.", "auto_derived"),
      f("expiry_review_date", "expiry review date", "System-derived review date because competitive facts age quickly.", "auto_derived"),
    ],
    relationHints: [
      "Product/SellingPoint/ServiceBenefit 用 applies_to",
      "ObjectionHandling/Pitch 用 supports",
      "Compliance.Rule 用 governed_by",
    ],
  },
  {
    schemaKey: "insurance.content.Asset",
    label: "Content asset",
    domain: "content",
    entityType: "asset",
    universalType: "entity",
    purpose: "A reusable sales, service, training, or customer-facing content asset.",
    fields: [
      f("title", "asset title", "Stable business title of the asset.", "critical"),
      f("asset_type", "asset type", "Poster, one-pager, brochure, video, script, QA, slide, checklist, or tool.", "critical"),
      f("target_domain", "target domain", "Primary business domain the asset supports.", "critical"),
      f("usage_scenario", "usage scenario", "Where and when this asset should be used.", "critical"),
      f("file_path", "file path", "Original or generated file path.", "critical"),
      f("target_personas", "target personas", "Personas or customer signals the asset fits.", "high_confidence"),
      f("target_products", "target products", "Products, services, or packages the asset supports.", "high_confidence"),
      f("business_phase", "business phase", "Lead generation, first touch, appointment, conversion, signing, service, or referral.", "high_confidence"),
      f("owner_team", "owner team", "Business owner or maintaining team.", "high_confidence"),
      f("compliance_status", "compliance status", "Approved, pending, expired, restricted, or unknown.", "high_confidence"),
      f("key_messages", "key messages", "Main messages or claims carried by the asset.", "recommended"),
      f("distribution_channels", "distribution channels", "WeChat, event, meeting, phone, app, training, or internal channel.", "recommended"),
      f("reusable_components", "reusable components", "Reusable visual, text, table, or pitch fragments.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for use or review.", "recommended"),
      f("usage_count", "usage count", "System-derived usage count.", "auto_derived"),
      f("last_used_at", "last used at", "System-derived last observed usage time.", "auto_derived"),
    ],
    relationHints: [
      "Product/ServiceBenefit/Persona/Method 用 applies_to",
      "Campaign/PresentationKit 用 part_of 或 uses_asset",
      "Compliance.Rule 用 governed_by",
    ],
  },
  {
    schemaKey: "insurance.content.AssetCollection",
    label: "Asset collection",
    domain: "content",
    entityType: "asset_collection",
    universalType: "entity",
    purpose: "A governed bundle of assets for a scenario, product, campaign, or training flow.",
    fields: [
      f("name", "collection name", "Stable name of the collection.", "critical"),
      f("collection_type", "collection type", "Product kit, scenario kit, training pack, campaign pack, or service pack.", "critical"),
      f("included_assets", "included assets", "Assets included in the collection.", "critical"),
      f("campaign_or_scenario", "campaign or scenario", "Campaign, scenario, product, or service context.", "critical"),
      f("owner_team", "owner team", "Business owner or maintaining team.", "critical"),
      f("target_personas", "target personas", "Personas or customer signals the collection supports.", "high_confidence"),
      f("target_products", "target products", "Products, services, or packages the collection supports.", "high_confidence"),
      f("business_phase", "business phase", "Primary phase where this collection is used.", "high_confidence"),
      f("update_cycle", "update cycle", "How frequently the collection should be reviewed.", "high_confidence"),
      f("missing_assets", "missing assets", "Assets that should exist but are absent.", "recommended"),
      f("governance_notes", "governance notes", "Review, ownership, compliance, or version rules.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for use or review.", "recommended"),
      f("asset_count", "asset count", "System-derived number of included assets.", "auto_derived"),
      f("last_refresh_at", "last refresh at", "System-derived last refresh date.", "auto_derived"),
    ],
    relationHints: ["Asset 用 has_part", "Campaign/SalesPlaybook 用 applies_to", "Compliance.Rule 用 governed_by"],
  },
  {
    schemaKey: "insurance.content.ContentTemplate",
    label: "Content template",
    domain: "content",
    entityType: "content_template",
    universalType: "entity",
    purpose: "Reusable template for agent/customer communication, content creation, or workflow output.",
    fields: [
      f("name", "template name", "Stable name of the template.", "critical"),
      f("template_type", "template type", "Message, poster copy, phone script, follow-up note, report, invitation, or checklist.", "critical"),
      f("applicable_scenario", "applicable scenario", "Scenario or workflow where the template applies.", "critical"),
      f("structure", "structure", "Required sections or content blocks.", "critical"),
      f("required_inputs", "required inputs", "Inputs that must be filled before use.", "critical"),
      f("target_channel", "target channel", "WeChat, phone, meeting, event, app, email, or internal system.", "high_confidence"),
      f("target_persona", "target persona", "Persona or customer signal this template fits.", "high_confidence"),
      f("tone", "tone", "Professional, warm, urgent, empathetic, concise, or authoritative.", "high_confidence"),
      f("compliance_constraints", "compliance constraints", "Required disclaimers or prohibited wording.", "high_confidence"),
      f("example_copy", "example copy", "Example content if supplied by source.", "recommended"),
      f("personalization_slots", "personalization slots", "Customer, product, persona, event, and agent variables.", "recommended"),
      f("review_checklist", "review checklist", "Checklist before publishing or using the template.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for use or review.", "recommended"),
      f("reuse_count", "reuse count", "System-derived reuse count.", "auto_derived"),
      f("lint_risk_score", "lint risk score", "System-derived compliance/content lint risk score.", "auto_derived"),
    ],
    relationHints: ["SellingScenario/Pitch/Asset 用 supports 或 uses_asset", "Compliance.Rule 用 governed_by"],
  },
  {
    schemaKey: "insurance.content.PresentationKit",
    label: "Presentation kit",
    domain: "content",
    entityType: "presentation_kit",
    universalType: "entity",
    purpose: "A structured presentation pack for product explanation, service explanation, event conversion, or training.",
    fields: [
      f("kit_name", "kit name", "Stable name of the presentation kit.", "critical"),
      f("target_scenario", "target scenario", "Scenario where the kit should be used.", "critical"),
      f("included_assets", "included assets", "Slides, scripts, videos, posters, QA, or tools included.", "critical"),
      f("presentation_flow", "presentation flow", "Ordered flow of the presentation.", "critical"),
      f("speaker_notes", "speaker notes", "Key notes or talk track for the presenter.", "critical"),
      f("target_personas", "target personas", "Personas or customer signals the kit fits.", "high_confidence"),
      f("target_products", "target products", "Products, services, or packages covered.", "high_confidence"),
      f("duration", "duration", "Expected presentation length.", "high_confidence"),
      f("delivery_mode", "delivery mode", "One-on-one, seminar, livestream, training, or meeting.", "high_confidence"),
      f("owner_team", "owner team", "Business owner or maintaining team.", "high_confidence"),
      f("objection_handling_links", "objection handling links", "Objections addressed by the kit.", "recommended"),
      f("compliance_reminders", "compliance reminders", "Required reminders and prohibited claims.", "recommended"),
      f("backup_materials", "backup materials", "Optional assets to use when more detail is needed.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for use or review.", "recommended"),
      f("usage_count", "usage count", "System-derived usage count.", "auto_derived"),
      f("last_reviewed_at", "last reviewed at", "System-derived or governance review timestamp.", "auto_derived"),
    ],
    relationHints: ["Asset 用 has_part", "SalesPlaybook/Campaign 用 uses_asset", "Compliance.Rule 用 governed_by"],
  },
  {
    schemaKey: "insurance.activity.Campaign",
    label: "Campaign",
    domain: "activity",
    entityType: "campaign",
    universalType: "event",
    purpose: "A time-bound sales, service, referral, retention, or customer-operation campaign.",
    fields: [
      f("name", "campaign name", "Stable campaign name.", "critical"),
      f("campaign_type", "campaign type", "Lead generation, conversion, service, referral, retention, training, or launch.", "critical"),
      f("start_date", "start date", "Campaign start date.", "critical"),
      f("target_audience", "target audience", "Target customer or agent audience.", "critical"),
      f("campaign_goal", "campaign goal", "Business goal and expected outcome.", "critical"),
      f("offer_or_theme", "offer or theme", "Main offer, theme, or message.", "critical"),
      f("end_date", "end date", "Campaign end date if available.", "high_confidence"),
      f("target_products", "target products", "Products, services, or packages promoted.", "high_confidence"),
      f("target_personas", "target personas", "Personas or customer signals targeted.", "high_confidence"),
      f("channels", "channels", "Online, offline, branch, WeChat, phone, event, or app channels.", "high_confidence"),
      f("owner_team", "owner team", "Business owner or operating team.", "high_confidence"),
      f("compliance_status", "compliance status", "Approved, pending, restricted, expired, or unknown.", "high_confidence"),
      f("playbook_links", "playbook links", "Sales playbooks or scenarios supporting the campaign.", "recommended"),
      f("assets", "assets", "Assets or kits used by the campaign.", "recommended"),
      f("incentives", "incentives", "Incentives associated with the campaign.", "recommended"),
      f("success_metrics", "success metrics", "KPIs, tracking method, and review criteria.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for execution or review.", "recommended"),
      f("lead_count", "lead count", "System-derived lead count.", "auto_derived"),
      f("conversion_rate", "conversion rate", "System-derived conversion rate.", "auto_derived"),
      f("roi_estimate", "ROI estimate", "System-derived or business-provided ROI estimate.", "auto_derived"),
    ],
    relationHints: ["SalesPlaybook/SellingScenario 用 applies_to", "Asset/PresentationKit 用 uses_asset", "Incentive 用 has_part"],
  },
  {
    schemaKey: "insurance.activity.Incentive",
    label: "Incentive",
    domain: "activity",
    entityType: "incentive",
    universalType: "event",
    purpose: "Agent, customer, or channel incentive attached to a campaign, referral, or sales behavior.",
    fields: [
      f("name", "incentive name", "Stable incentive name.", "critical"),
      f("incentive_type", "incentive type", "Agent, customer, referral, activity, points, training, or channel incentive.", "critical"),
      f("start_date", "start date", "Incentive start date.", "critical"),
      f("eligibility_rules", "eligibility rules", "Who can participate and under what conditions.", "critical"),
      f("reward_logic", "reward logic", "Reward amount, points, tier, or qualification logic.", "critical"),
      f("end_date", "end date", "Incentive end date if available.", "high_confidence"),
      f("target_agents", "target agents", "Agent group, rank, branch, or team targeted.", "high_confidence"),
      f("target_products", "target products", "Products, services, or campaigns involved.", "high_confidence"),
      f("compliance_constraints", "compliance constraints", "Restrictions, disclosure, privacy, or anti-misleading rules.", "high_confidence"),
      f("measurement_method", "measurement method", "How qualification and reward are measured.", "high_confidence"),
      f("communication_assets", "communication assets", "Assets or templates explaining the incentive.", "recommended"),
      f("risk_notes", "risk notes", "Mis-selling, gaming, privacy, or fairness risks.", "recommended"),
      f("approval_owner", "approval owner", "Approving department or owner.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for execution or review.", "recommended"),
      f("participation_count", "participation count", "System-derived participant count.", "auto_derived"),
      f("payout_estimate", "payout estimate", "System-derived payout estimate.", "auto_derived"),
    ],
    relationHints: ["Campaign 用 part_of", "Compliance.Rule 用 governed_by", "Asset 用 uses_asset"],
  },
  {
    schemaKey: "insurance.activity.Event",
    label: "Event",
    domain: "activity",
    entityType: "event",
    universalType: "event",
    purpose: "A specific customer, agent, training, service, seminar, livestream, or campaign event.",
    fields: [
      f("event_name", "event name", "Stable event name.", "critical"),
      f("event_type", "event type", "Seminar, salon, livestream, training, service day, customer meeting, or campaign event.", "critical"),
      f("event_date", "event date", "Event date or date range.", "critical"),
      f("target_audience", "target audience", "Customers, agents, teams, or partners targeted.", "critical"),
      f("event_goal", "event goal", "Business goal of the event.", "critical"),
      f("location_or_channel", "location or channel", "Venue, online channel, branch, app, or livestream room.", "high_confidence"),
      f("host_agent", "host agent", "Host, speaker, or responsible agent/team.", "high_confidence"),
      f("related_campaign", "related campaign", "Campaign this event belongs to.", "high_confidence"),
      f("target_products", "target products", "Products or services involved.", "high_confidence"),
      f("agenda", "agenda", "Agenda, flow, or key sections.", "high_confidence"),
      f("follow_up_plan", "follow-up plan", "Follow-up action after the event.", "recommended"),
      f("required_assets", "required assets", "Assets, kits, templates, or scripts required.", "recommended"),
      f("compliance_notes", "compliance notes", "Compliance reminders or approval constraints.", "recommended"),
      f("knowledge_gaps", "knowledge gaps", "Missing facts for execution or review.", "recommended"),
      f("attendee_count", "attendee count", "System-derived attendee count.", "auto_derived"),
      f("conversion_count", "conversion count", "System-derived conversion or follow-up result count.", "auto_derived"),
    ],
    relationHints: ["Campaign 用 part_of", "Asset/PresentationKit 用 uses_asset", "Product/Persona/SellingScenario 用 applies_to"],
  },
  {
    schemaKey: "insurance.compliance.ComplianceRule",
    label: "合规与风险规则",
    domain: "compliance",
    entityType: "compliance_rule",
    universalType: "rule",
    purpose: "销售、宣传、服务说明中必须遵守的合规边界和风险提示。",
    fields: [
      f("rule_name", "规则名称", "规则或风险点名称。", "critical"),
      f("rule_content", "规则内容", "禁止、限制、必须说明或免责内容。", "critical"),
      f("risk_type", "风险类型", "收益承诺/服务承诺/医疗诊断/隐私/误导宣传等。", "critical"),
      f("applicable_entities", "适用对象", "适用的产品、服务、话术、素材或场景。", "high_confidence"),
      f("prohibited_wording", "禁用表达", "保证、一定、承诺等具体风险表达。", "high_confidence"),
      f("required_disclaimer", "必要声明", "对外说明中必须补充的免责或边界。", "high_confidence"),
      f("review_required", "是否需要审核", "true/false/conditional。", "high_confidence"),
      f("source_basis", "来源依据", "来自条款、手册、监管文件或总部材料。", "recommended"),
      f("knowledge_gaps", "待补全信息", "缺失的合规来源或审核口径。", "recommended"),
    ],
    relationHints: [
      "Product/ServiceBenefit 用 governs 或 governed_by",
      "Method.Pitch/ObjectionHandling 用 governs",
      "Content.Asset 用 governs",
    ],
  },
]

const importanceLabel: Record<FieldImportance, string> = {
  critical: "required_critical",
  high_confidence: "required_for_high_confidence",
  recommended: "recommended",
  auto_derived: "auto_derived",
}

export function renderInsuranceSchemaRegistryPrompt(): string {
  const lines = [
    "## Insurance Schema Registry v0.1",
    "",
    "Use `schema_key = industry + knowledge_domain + entity_type` to decide which extension fields to extract.",
    "Universal fields stay in frontmatter. Business fields go into `attributes`. Cross-entity fields also become `relations`. Evidence goes into `claims`. Quality rules and missing fields become review/gap signals.",
    "",
    "Important output rule: emit `attributes` as ONE-LINE JSON in YAML frontmatter. Use null or [] for missing fields; do not invent missing facts.",
    "Example:",
    'attributes: {"product_name":"安心家庭守护重疾险","product_status":"在售","waiting_period_days":90,"core_responsibilities":[],"knowledge_gaps":["regulatory_filing_no"]}',
    "",
  ]

  for (const spec of INSURANCE_SCHEMA_REGISTRY) {
    lines.push(`### ${spec.schemaKey} - ${spec.label}`)
    lines.push(`purpose: ${spec.purpose}`)
    lines.push(`frontmatter: industry=insurance, knowledge_domain=${spec.domain}, entity_type=${spec.entityType}, type=${spec.universalType}`)
    for (const importance of ["critical", "high_confidence", "recommended", "auto_derived"] as const) {
      const fields = spec.fields.filter((field) => field.importance === importance)
      if (fields.length === 0) continue
      lines.push(`${importanceLabel[importance]}:`)
      for (const field of fields) {
        lines.push(`  - ${field.name}: ${field.label}；${field.note}`)
      }
    }
    if (spec.relationHints.length > 0) {
      lines.push("relation_mapping:")
      for (const hint of spec.relationHints) lines.push(`  - ${hint}`)
    }
    if (spec.lintRules?.length) {
      lines.push("lint_rules:")
      for (const rule of spec.lintRules) lines.push(`  - ${rule}`)
    }
    lines.push("")
  }

  lines.push("## Deferred domains")
  lines.push("Content、Activity can use the same pattern and remain conservative for this demo. Cases and Compliance are enabled for service cases, customer voice, and risk/disclaimer extraction; do not force those facts into Product.")
  return lines.join("\n")
}

export function getInsuranceSchemaSpec(entityType: string): InsuranceEntitySchemaSpec | undefined {
  const normalized = normalizeToken(entityType)
  return INSURANCE_SCHEMA_REGISTRY.find((spec) => normalizeToken(spec.entityType) === normalized)
}

export function getInsuranceFieldMergePolicy(entityType: string, fieldName: string): FieldMergePolicy {
  const spec = getInsuranceSchemaSpec(entityType)
  const field = spec?.fields.find((item) => item.name === fieldName)
  if (!field) return "conflict"
  if (field.importance === "recommended") return "append"
  if (field.importance === "auto_derived") return "keep_best"
  return "conflict"
}

export function getInsuranceFieldImportance(entityType: string, fieldName: string): FieldImportance | undefined {
  return getInsuranceSchemaSpec(entityType)?.fields.find((item) => item.name === fieldName)?.importance
}

export function getCanonicalInsuranceFieldName(entityType: string, fieldName: string): string {
  const normalizedEntityType = normalizeToken(entityType)
  const normalizedField = normalizeToken(fieldName)
  const spec = getInsuranceSchemaSpec(normalizedEntityType)
  if (spec?.fields.some((field) => field.name === normalizedField)) return normalizedField

  const aliases = FIELD_ALIASES[normalizedEntityType] ?? {}
  for (const [canonical, values] of Object.entries(aliases)) {
    if (values.some((alias) => normalizeToken(alias) === normalizedField)) return canonical
  }
  return normalizedField
}

export function normalizeInsuranceAttributes(
  entityType: string,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(attributes)) {
    const canonical = getCanonicalInsuranceFieldName(entityType, field)
    if (normalized[canonical] === undefined) {
      normalized[canonical] = value
    } else if (Array.isArray(normalized[canonical])) {
      normalized[canonical] = [...normalized[canonical] as unknown[], value]
    } else {
      normalized[canonical] = [normalized[canonical], value]
    }
  }
  return normalized
}

export function inferStableInsuranceDedupKey(input: {
  entityType: string
  title: string
  attributes?: Record<string, unknown>
  fallback?: string
}): string {
  const entityType = normalizeToken(input.entityType || "general")
  const attrs = input.attributes ?? {}
  const keyFields = DEDUP_KEY_FIELDS[entityType] ?? ["title"]
  const parts: string[] = [entityType]

  // Fields where we apply canonicalServiceIdentityName (brand suffix + synonym map).
  // Include both title and service_name so service_benefit entities are normalized
  // regardless of whether their dedup key is derived from title or from service_name.
  const IDENTITY_NORMALIZE_FIELDS = new Set(["title", "service_name"])

  for (const field of keyFields) {
    let value = field === "title" ? input.title : attrs[field]
    if (IDENTITY_NORMALIZE_FIELDS.has(field) && typeof value === "string") {
      value = canonicalServiceIdentityName(value)
    }
    const normalized = normalizeDedupPart(value)
    if (normalized) parts.push(normalized)
  }

  if (parts.length === 1) {
    const rawTitle = canonicalServiceIdentityName(input.title || "")
    const fallback = normalizeDedupPart(input.fallback) || normalizeDedupPart(rawTitle) || "untitled"
    parts.push(fallback)
  }

  return parts.join(".")
}

export function inferStrongInsuranceIdentityKeys(input: {
  entityType: string
  title: string
  attributes?: Record<string, unknown>
  dedupKey?: string
}): string[] {
  const entityType = normalizeToken(input.entityType || "general")
  const attrs = normalizeInsuranceAttributes(entityType, input.attributes ?? {})
  const keys = new Set<string>()
  if (input.dedupKey) keys.add(`dedup:${normalizeDedupPart(input.dedupKey)}`)

  const addFieldKey = (field: string, prefix = field) => {
    const normalized = normalizeDedupPart(attrs[field])
    if (normalized) keys.add(`${entityType}.${prefix}.${normalized}`)
  }
  const addCompositeKey = (fields: string[], prefix: string) => {
    const parts = fields.map((field) => normalizeDedupPart(attrs[field]))
    if (parts.every(Boolean)) keys.add(`${entityType}.${prefix}.${parts.join(".")}`)
  }

  if (entityType === "product") {
    addFieldKey("product_code", "code")
    addFieldKey("product_name", "name")
    const titleKey = normalizeBusinessTitle(input.title, "product")
    if (titleKey) keys.add(`${entityType}.title.${titleKey}`)
  } else if (entityType === "service_benefit") {
    addCompositeKey(["related_product", "service_name"], "product_service")
    addFieldKey("service_name", "service")
    const titleKey = normalizeBusinessTitle(input.title, "service_benefit")
    if (titleKey) keys.add(`${entityType}.title.${titleKey}`)
  } else if (entityType === "persona") {
    addFieldKey("persona_name", "name")
    const titleKey = normalizeBusinessTitle(input.title, "persona")
    if (titleKey) keys.add(`${entityType}.title.${titleKey}`)
  } else if (entityType === "selling_scenario") {
    addFieldKey("scenario_name", "name")
  } else if (entityType === "pitch") {
    addCompositeKey(["related_scenario", "pitch_type", "core_message"], "scenario_type_message")
  } else if (entityType === "objection_handling") {
    addCompositeKey(["objection_category", "objection_raw"], "category_raw")
  } else {
    const stable = inferStableInsuranceDedupKey({
      entityType,
      title: input.title,
      attributes: attrs,
    })
    if (stable && !stable.endsWith(".untitled")) keys.add(`dedup:${normalizeDedupPart(stable)}`)
  }

  return Array.from(keys).filter((key) => key.length > 0)
}

export function inferSourceTypeFromSourceName(sourceName = ""): string {
  const name = sourceName.toLowerCase()
  if (!name) return "unknown"
  if (/监管|批复|备案|条款|合同|费率|投保提示|健康告知|regulatory|clause|terms/.test(name)) return "regulatory_doc"
  if (/说明书|产品手册|product.*manual|manual/.test(name)) return "product_manual"
  if (/案例|客户故事|服务故事|case/.test(name)) return "agent_experience"
  if (/话术|销售|培训|训练|异议|qa|q&a|问答/.test(name)) return "sales_training"
  if (/宣传|海报|折页|单页|marketing|poster|brochure/.test(name)) return "official_marketing"
  if (/服务手册|服务权益|家医|绿通|service/.test(name)) return "service_manual"
  if (/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(name)) return "ocr_image"
  return "unknown"
}

export function sourceTypeWeight(sourceType = "unknown"): number {
  return SOURCE_TYPE_WEIGHTS[sourceType] ?? SOURCE_TYPE_WEIGHTS.unknown
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_")
}

function normalizeDedupPart(value: unknown): string {
  if (value == null) return ""
  const raw = Array.isArray(value) ? value.join("_") : String(value)
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s/\\|,，、;；:：()[\]{}'"“”‘’]+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
}

function normalizeBusinessTitle(value: string, entityType: string): string {
  let title = String(value ?? "").trim().toLowerCase()
  if (!title) return ""
  title = title
    .replace(/\.(md|pdf|docx?|xlsx?|png|jpe?g)$/i, "")
    .replace(/[\s/\\|,，、;；:：()[\]{}'"“”‘’]+/g, "")

  if (entityType === "product") {
    title = title
      .replace(/重大疾病/g, "重疾")
      .replace(/重疾险/g, "重疾")
      .replace(/产品说明书|产品说明|说明书|合同条款|保险条款|条款|宣传单页|宣传材料|费率表|准入清单|清单|pdf|文档/g, "")
      .replace(/保险产品|产品$/g, "")
      .replace(/保险$/g, "")
  } else if (entityType === "service_benefit") {
    title = title
      .replace(/服务权益名称|服务名称|权益名称|服务项目名称/g, "")
      .replace(/服务权益|权益服务|服务项目|服务说明|流程说明|说明|规则|pdf|文档/g, "")
  } else if (entityType === "service_item") {
    // service_item 标题格式为 {line}-{version}-{item}，不做过度归一化，保留分隔符
    title = title
      .replace(/服务项名称|服务项目名称|服务项目|服务名称/g, "")
      .replace(/pdf|文档|说明/g, "")
  } else if (entityType === "persona") {
    title = title.replace(/客户画像|画像|客户|人群/g, "")
  }

  return title.length >= 4 ? normalizeDedupPart(title) : ""
}

// ─── Service Hierarchy Constant ───────────────────────────────────────────────
// 完整五级层级数据，来源：《服务权益知识结构.xlsx》- 服务线视角
// 用于前端导航树、ingest 路径解析、候选命名等

export interface ServiceHierarchyVersion {
  versionName: string
}

export interface ServiceHierarchyLine {
  lineName: string
  versions: ServiceHierarchyVersion[]
}

export interface ServiceHierarchyScenario {
  scenarioName: string
  lines: ServiceHierarchyLine[]
}

export interface ServiceHierarchySeries {
  seriesName: string
  status: "active" | "pending"
  scenarios: ServiceHierarchyScenario[]
}

export const SERVICE_HIERARCHY: ServiceHierarchySeries[] = [
  {
    seriesName: "添平安系列",
    status: "active",
    scenarios: [
      {
        scenarioName: "医健",
        lines: [
          {
            lineName: "安有医",
            versions: [
              { versionName: "颐享版" },
              { versionName: "尊享版" },
              { versionName: "悦享版" },
              { versionName: "惠享版" },
              { versionName: "尊享易核版" },
            ],
          },
          {
            lineName: "安有护",
            versions: [
              { versionName: "国际" },
              { versionName: "国内" },
            ],
          },
          {
            lineName: "就医通",
            versions: [
              { versionName: "就医通" },
            ],
          },
          {
            lineName: "臻享家医",
            versions: [
              { versionName: "V1" },
              { versionName: "V2" },
              { versionName: "V3" },
            ],
          },
          {
            lineName: "御享国医",
            versions: [
              { versionName: "御享国医" },
            ],
          },
          {
            lineName: "私董保健医",
            versions: [
              { versionName: "京华版" },
              { versionName: "繁华版" },
            ],
          },
        ],
      },
      {
        scenarioName: "养老",
        lines: [
          {
            lineName: "居家养老",
            versions: [
              { versionName: "V1" },
              { versionName: "V1优享" },
              { versionName: "V2" },
              { versionName: "V2优享" },
            ],
          },
          {
            lineName: "高端康养",
            versions: [
              { versionName: "逸享" },
              { versionName: "逸享PLUS" },
              { versionName: "颐享家" },
              { versionName: "臻享V1" },
              { versionName: "臻享V2" },
              { versionName: "臻享V3" },
            ],
          },
        ],
      },
      {
        scenarioName: "家办",
        lines: [
          {
            lineName: "家族办公室",
            versions: [
              { versionName: "准会员" },
              { versionName: "正式会员" },
              { versionName: "尊享会员" },
              { versionName: "至尊会员" },
            ],
          },
        ],
      },
    ],
  },
  {
    seriesName: "享平安系列",
    status: "pending",
    scenarios: [],
  },
]

/**
 * 根据服务线和版本构建服务项实体标题。
 *
 * 命名规范：{lineName}-{versionName}-{itemName}
 * 示例：
 *   buildServiceItemTitle("臻享家医", "V1", "在线问诊")
 *   → "臻享家医-V1-在线问诊"
 *
 *   buildServiceItemTitle("安有医", "颐享版", "家庭医生服务")
 *   → "安有医-颐享版-家庭医生服务"
 */
export function buildServiceItemTitle(
  lineName: string,
  versionName: string,
  itemName: string,
): string {
  return `${lineName.trim()}-${versionName.trim()}-${itemName.trim()}`
}

/**
 * 解析服务项实体标题，提取 line / version / item 三元组。
 * 如果标题不符合三段格式，返回 null。
 *
 * 注意：仅做简单分割，不做业务验证。
 * 对于 "臻享家医-V1-在线问诊" → { lineName: "臻享家医", versionName: "V1", itemName: "在线问诊" }
 */
export function parseServiceItemTitle(
  title: string,
): { lineName: string; versionName: string; itemName: string } | null {
  const parts = title.split("-")
  if (parts.length < 3) return null
  // item_name 本身可能含连字符，所以 itemName = 剩余所有部分
  const [lineName, versionName, ...rest] = parts
  const itemName = rest.join("-")
  if (!lineName || !versionName || !itemName) return null
  return { lineName, versionName, itemName }
}

/**
 * Canonical version name aliases: abbreviated / alternative names → canonical names.
 * Keyed by lineName → { alias → canonicalVersionName }
 */
export const CANONICAL_VERSION_ALIASES: Record<string, Record<string, string>> = {
  "安有医": {
    "易核版": "尊享易核版",
    "尊享易核": "尊享易核版",
  },
  "高端康养": {
    "逸享plus": "逸享PLUS",
    "逸享Plus": "逸享PLUS",
  },
  "居家养老": {
    "v1优享": "V1优享",
    "v2优享": "V2优享",
  },
}

/**
 * Resolve a potentially abbreviated/alias version name to its canonical form.
 * Falls back to the input if no alias is found.
 */
export function resolveCanonicalVersionName(lineName: string, versionName: string): string {
  const lineAliases = CANONICAL_VERSION_ALIASES[lineName]
  if (lineAliases) {
    const exact = lineAliases[versionName]
    if (exact) return exact
    // Case-insensitive fallback
    const lower = versionName.toLowerCase()
    for (const [alias, canonical] of Object.entries(lineAliases)) {
      if (alias.toLowerCase() === lower) return canonical
    }
  }
  return versionName
}

/**
 * 在 SERVICE_HIERARCHY 中查找某个服务线版本是否存在。
 * 支持别名解析（如"易核版" → "尊享易核版"）。
 * 用于 ingest 时快速校验上传路径的合法性。
 */
export function findServiceLineVersion(
  lineName: string,
  versionName: string,
): { series: string; scenario: string; canonicalVersionName: string } | null {
  const canonical = resolveCanonicalVersionName(lineName, versionName)
  for (const series of SERVICE_HIERARCHY) {
    for (const scenario of series.scenarios) {
      for (const line of scenario.lines) {
        if (line.lineName === lineName) {
          const version = line.versions.find(v =>
            v.versionName === canonical || v.versionName === versionName
          )
          if (version) {
            return { series: series.seriesName, scenario: scenario.scenarioName, canonicalVersionName: version.versionName }
          }
        }
      }
    }
  }
  return null
}

/**
 * Find a service line by name only (no version required).
 * Returns all versions for that line, or null if not found.
 */
export function findServiceLine(
  lineName: string,
): { series: string; scenario: string; versions: string[] } | null {
  for (const series of SERVICE_HIERARCHY) {
    for (const scenario of series.scenarios) {
      for (const line of scenario.lines) {
        if (line.lineName === lineName) {
          return {
            series: series.seriesName,
            scenario: scenario.scenarioName,
            versions: line.versions.map(v => v.versionName),
          }
        }
      }
    }
  }
  return null
}

