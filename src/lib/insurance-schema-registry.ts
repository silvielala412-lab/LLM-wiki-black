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
  domain: "product" | "customer" | "method" | "content" | "activity" | "cases" | "compliance"
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
    purpose: "打包式健康服务权益包（非保险产品）。与保险产品的核心区别：不涉及保险责任、监管备案、理赔逻辑，而是提供有组织的服务内容和履约流程。例如"平安臻享家医健康服务计划"。",
    fields: [
      f("plan_name", "计划官方名称", "官方完整名称，如"平安臻享家医健康服务计划"。", "critical"),
      f("plan_version", "版本/年份", "如"2025年4月版"；多版本共存时是 dedup_key 的一部分。", "critical"),
      f("service_scope", "服务范围概述", "本计划提供哪些大类服务，一句话概述。", "critical"),
      f("eligible_customers", "适用客户", "谁可以使用本计划（保单持有人/被保险人/家属等）。", "critical"),
      f("activation_conditions", "激活条件", "如何激活/领取本计划的服务，例如"保单生效后30天内在APP激活"。", "high_confidence"),
      f("service_period", "服务有效期", "本计划的服务期限，例如"保单年度内"。", "high_confidence"),
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

  for (const field of keyFields) {
    const value = field === "title" ? input.title : attrs[field]
    const normalized = normalizeDedupPart(value)
    if (normalized) parts.push(normalized)
  }

  if (parts.length === 1) {
    const fallback = normalizeDedupPart(input.fallback) || normalizeDedupPart(input.title) || "untitled"
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
  } else if (entityType === "persona") {
    title = title.replace(/客户画像|画像|客户|人群/g, "")
  }

  return title.length >= 4 ? normalizeDedupPart(title) : ""
}
