/**
 * product-catalog-modules.ts
 *
 * 险种产品知识库模块定义。
 * 每个险种对应若干「知识模块」，每个模块独立存为一个 wiki 文件。
 *
 * 文件命名规范（与服务权益一致）：
 *   {险种类别}-{产品名}-{模块名}.md
 *   示例：医疗险-安心百万医疗险2026版-保障责任.md
 *
 * 存储路径：wiki/product_catalog/{文件名}.md（平铺，不嵌套）
 */

// ── 险种大类枚举 ──────────────────────────────────────────────────────────────

export type InsuranceCategoryType =
  | "医疗险"
  | "重疾险"
  | "意外医疗险"
  | "意外险"
  | "寿险"
  | "年金险"

export const INSURANCE_CATEGORIES: InsuranceCategoryType[] = [
  "医疗险",
  "重疾险",
  "意外医疗险",
  "意外险",
  "寿险",
  "年金险",
]

// ── 模块定义 ─────────────────────────────────────────────────────────────────

/** 单个知识模块的元数据 (legacy, kept for backward compat) */
export interface ProductModule {
  /** 模块名，用于文件名生成（如「保障责任」）*/
  moduleName: string
  /** 对应的 schema entity type */
  entityType: string
  /** 该模块优先从哪类原始文档里抽取 */
  sourceDocHints: string[]
  /** 该模块是否是「必须存在」的核心模块 */
  required: boolean
  /** 此模块是否属于险种基础信息（所有险种都有的） */
  isBaseModule: boolean
}

// ── 业务字段定义 (对齐 Excel: 产品知识库字段标签维度) ─────────────────────────

/** 字段值类型: short=表格单行, long=独立段落(保障责任/免责等) */
export type FieldValueType = "short" | "long"

/** 单个业务字段的定义 */
export interface ProductField {
  /** 字段名 (对齐 Excel) */
  fieldName: string
  /** 取值示例 (帮助 LLM 理解期望格式) */
  valueHint?: string
  /** 取值来源 */
  source: string
  /** 说明 */
  description?: string
  /** short=结构化表格值, long=详细文本段落 */
  valueType: FieldValueType
  /** 是否可从条款 PDF 自动抽取 (false = 人工填充) */
  extractable: boolean
}

/** 基础字段 (所有险种通用) — 对齐 Excel "基础字段" sheet */
export const BASE_FIELDS: ProductField[] = [
  { fieldName: "险种代码", source: "官网同步", valueType: "short", extractable: false },
  { fieldName: "险种名称", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "险种简称", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "产品类别", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "产品类型", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "销售渠道", source: "口袋E", valueType: "short", extractable: false },
  { fieldName: "销售状态", source: "官网同步", valueType: "short", extractable: false },
  { fieldName: "主附加险", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "产品简介", source: "产品说明书", valueType: "long", extractable: true },
  { fieldName: "产品特色", source: "产品说明书", valueType: "long", extractable: true },
  { fieldName: "适用人群", source: "人工填写", valueType: "short", extractable: false, description: "与客户收入相关" },
  { fieldName: "保单权益", source: "产品条款", valueType: "long", extractable: true },
  { fieldName: "可享服务", source: "三大服务清单", valueType: "short", extractable: false, valueHint: "臻享RUN健康管理服务、居家养老、高端康养" },
  { fieldName: "交费期限", source: "口袋E/产品说明书", valueType: "short", extractable: true, valueHint: "10/15/20/30年交" },
  { fieldName: "交费方式", source: "口袋E/产品说明书", valueType: "short", extractable: true, valueHint: "趸交、年交、半年交、季交、月交" },
  { fieldName: "犹豫期", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "等待期", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "宽限期", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "保障期间", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "保障期间分类", source: "根据保障期间计算", valueType: "short", extractable: true, valueHint: "短期、长期、终身" },
  { fieldName: "投保年龄", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "投保范围", source: "产品条款", valueType: "long", extractable: true },
  { fieldName: "保险期间和续保", source: "产品说明书", valueType: "long", extractable: true, description: "文本较长" },
  { fieldName: "犹豫期及合同解除（退保）", source: "产品条款", valueType: "long", extractable: true },
  { fieldName: "通用责任免除", source: "产品条款", valueType: "long", extractable: true },
  { fieldName: "专属健康告知", source: "健康告知/投保须知", valueType: "long", extractable: true },
]

/** 医疗险专属字段 — 对齐 Excel "医疗险" sheet */
export const MEDICAL_FIELDS: ProductField[] = [
  { fieldName: "0免赔", source: "人工填充", valueType: "short", extractable: true, valueHint: "是、否" },
  { fieldName: "癌症医疗", source: "产品条款", valueType: "short", extractable: true, description: "保障责任内的癌症相关保险金" },
  { fieldName: "保什么", source: "保险责任", valueType: "long", extractable: true },
  { fieldName: "保障人群", source: "根据投保年龄映射", valueType: "short", extractable: true, valueHint: "儿童(0-17岁)、成人(18-60岁)、老人(60岁以上)" },
  { fieldName: "保证续保", source: "产品条款", valueType: "short", extractable: true, valueHint: "保证续保" },
  { fieldName: "保证续保期", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "不限社保", source: "人工填充", valueType: "short", extractable: true },
  { fieldName: "高危职业", source: "根据投保职业推断", valueType: "short", extractable: false },
  { fieldName: "投保职业", source: "产品核保数据", valueType: "short", extractable: true },
  { fieldName: "额度类型", source: "人工填充", valueType: "short", extractable: true, valueHint: "小额医疗、百万医疗" },
  { fieldName: "免赔额", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "报销门诊住院范围", source: "产品条款", valueType: "short", extractable: true, valueHint: "仅门诊、仅住院、门诊+住院" },
  { fieldName: "增值服务", source: "人工填充", valueType: "short", extractable: true, valueHint: "就医绿通、费用垫付、预赔、闪赔、线上理赔" },
  { fieldName: "核保方式", source: "人工填充", valueType: "short", extractable: false, valueHint: "智能核保、人工核保" },
  { fieldName: "津贴", source: "保险责任", valueType: "short", extractable: true, valueHint: "住院津贴、恶性肿瘤津贴" },
  { fieldName: "给付限额", source: "保险责任", valueType: "short", extractable: true, valueHint: "一般医疗保险金200万" },
  { fieldName: "报销范围", source: "保险责任", valueType: "long", extractable: true },
  { fieldName: "报销比例", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "医院范围", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "补偿原则", source: "人工填充", valueType: "short", extractable: true, description: "能否同类保单重复理赔" },
  { fieldName: "特殊免责", source: "免责条款", valueType: "short", extractable: true, valueHint: "自杀可赔、猝死可赔" },
  { fieldName: "高端医疗", source: "人工填充", valueType: "short", extractable: false, valueHint: "特需病房、私立医院、国际部" },
  { fieldName: "险种转换", source: "人工填充", valueType: "short", extractable: true },
  { fieldName: "费率可调", source: "根据产品名判断", valueType: "short", extractable: true },
]

/** 重疾险专属字段 — 对齐 Excel "重疾险" sheet */
export const CRITICAL_ILLNESS_FIELDS: ProductField[] = [
  { fieldName: "保什么", source: "保险责任", valueType: "long", extractable: true },
  { fieldName: "保障人群", source: "关联投保年龄", valueType: "short", extractable: true },
  { fieldName: "投被保人豁免", source: "保险条款", valueType: "short", extractable: true },
  { fieldName: "疾病分组", source: "保险责任", valueType: "short", extractable: true, valueHint: "分组、不分组" },
  { fieldName: "赔付次数", source: "保险责任", valueType: "short", extractable: true, valueHint: "单次赔付、多次赔付" },
  { fieldName: "满期返还", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "投保职业", source: "产品核保数据", valueType: "short", extractable: true },
  { fieldName: "轻中重症疾病种类", source: "保险责任", valueType: "short", extractable: true, valueHint: "轻症XX种，重症XX种" },
  { fieldName: "重疾赔付", source: "保险责任", valueType: "long", extractable: true },
  { fieldName: "运动达标涨保障", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "特殊保额", source: "保险责任", valueType: "short", extractable: true, valueHint: "特定疾病3倍赔偿" },
  { fieldName: "特疾", source: "保险责任", valueType: "short", extractable: true, valueHint: "少儿特疾、女性特疾" },
  { fieldName: "购买限制", source: "人工填充", valueType: "short", extractable: true },
  { fieldName: "起投金额", source: "人工填充", valueType: "short", extractable: false },
  { fieldName: "保证续保", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "保证续保期", source: "产品条款", valueType: "short", extractable: true },
]

/** 意外险专属字段 — 对齐 Excel "意外险" sheet */
export const ACCIDENT_FIELDS: ProductField[] = [
  { fieldName: "特殊免责", source: "免责条款", valueType: "short", extractable: true },
  { fieldName: "保什么", source: "保险责任", valueType: "long", extractable: true },
  { fieldName: "保障人群", source: "根据投保年龄映射", valueType: "short", extractable: true },
  { fieldName: "不限社保", source: "人工填充", valueType: "short", extractable: true },
  { fieldName: "满期返还", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "生效时间", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "投保职业", source: "产品核保数据", valueType: "short", extractable: true },
  { fieldName: "住院津贴", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "综合意外", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "意外身故", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "意外伤残", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "特殊保额", source: "保险责任", valueType: "short", extractable: true, valueHint: "公共交通意外额外赔、自驾" },
  { fieldName: "购买限制", source: "人工填充", valueType: "short", extractable: true },
]

/** 寿险专属字段 — 对齐 Excel "寿险" sheet */
export const LIFE_INSURANCE_FIELDS: ProductField[] = [
  { fieldName: "保什么", source: "保险责任", valueType: "long", extractable: true, description: "身故/全残保额" },
  { fieldName: "保障人群", source: "根据投保年龄映射", valueType: "short", extractable: true },
  { fieldName: "健康告知", source: "人工填充", valueType: "long", extractable: true },
  { fieldName: "免责少", source: "免责条款", valueType: "short", extractable: true },
  { fieldName: "全残保障", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "意外身故", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "疾病身故", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "满期返还", source: "保险责任", valueType: "short", extractable: true },
  { fieldName: "是否可加保", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "投保职业", source: "产品核保数据", valueType: "short", extractable: true },
  { fieldName: "最高保额", source: "人工填充", valueType: "short", extractable: false },
  { fieldName: "部分领取", source: "产品说明书", valueType: "short", extractable: true, valueHint: "支持、不支持" },
  { fieldName: "保证利率", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "保单贷款", source: "产品说明书", valueType: "short", extractable: true, valueHint: "利率、比例、期限" },
  { fieldName: "特殊免责", source: "免责条款", valueType: "short", extractable: true },
  { fieldName: "购买限制", source: "人工填充", valueType: "short", extractable: true },
  { fieldName: "有分红", source: "保单红利", valueType: "short", extractable: true },
  { fieldName: "现金价值", source: "人工填充", valueType: "short", extractable: false },
  { fieldName: "初始费用", source: "产品说明书", valueType: "short", extractable: true, description: "万能险需填写" },
  { fieldName: "领取手续费", source: "产品说明书", valueType: "short", extractable: true, description: "万能险需填写" },
]

/** 年金险专属字段 — 对齐 Excel "年金险" sheet */
export const ANNUITY_FIELDS: ProductField[] = [
  { fieldName: "保什么", source: "保险责任", valueType: "long", extractable: true },
  { fieldName: "保障人群", source: "根据投保年龄映射", valueType: "short", extractable: true },
  { fieldName: "保证领取", source: "人工填充", valueType: "short", extractable: true },
  { fieldName: "双被保人", source: "产品条款", valueType: "short", extractable: true },
  { fieldName: "万能账户", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "养老金", source: "保险金", valueType: "short", extractable: true },
  { fieldName: "有分红", source: "保单红利", valueType: "short", extractable: true },
  { fieldName: "部分领取", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "领取规则", source: "保险条款", valueType: "short", extractable: true, valueHint: "月领、年领" },
  { fieldName: "产品利率", source: "保险条款", valueType: "short", extractable: true },
  { fieldName: "保证利率", source: "保险条款", valueType: "short", extractable: true },
  { fieldName: "保单贷款", source: "保单贷款", valueType: "short", extractable: true },
  { fieldName: "起投金额", source: "人工填充", valueType: "short", extractable: false },
  { fieldName: "现金价值", source: "人工填充", valueType: "short", extractable: false },
  { fieldName: "初始费用", source: "产品说明书", valueType: "short", extractable: true, description: "万能险需填写" },
  { fieldName: "领取手续费", source: "产品说明书", valueType: "short", extractable: true },
  { fieldName: "领取期间", source: "保险条款", valueType: "short", extractable: true },
]

/** 每个险种的完整字段列表（基础 + 专属） */
export const PRODUCT_FIELDS: Record<InsuranceCategoryType, ProductField[]> = {
  "医疗险": [...BASE_FIELDS, ...MEDICAL_FIELDS],
  "重疾险": [...BASE_FIELDS, ...CRITICAL_ILLNESS_FIELDS],
  "意外医疗险": [...BASE_FIELDS, ...MEDICAL_FIELDS],
  "意外险": [...BASE_FIELDS, ...ACCIDENT_FIELDS],
  "寿险": [...BASE_FIELDS, ...LIFE_INSURANCE_FIELDS],
  "年金险": [...BASE_FIELDS, ...ANNUITY_FIELDS],
}

/** Get extractable field names for a category (used by extractor prompt) */
export function getExtractableFields(category: InsuranceCategoryType): ProductField[] {
  return PRODUCT_FIELDS[category].filter(f => f.extractable)
}

// ── 各险种模块列表 ────────────────────────────────────────────────────────────

/** 所有险种共有的基础模块 */
const BASE_MODULES: ProductModule[] = [
  // 一、产品基础信息
  {
    moduleName: "产品基础信息",
    entityType: "product_overview",
    sourceDocHints: ["产品说明书", "产品简介", "投保须知"],
    required: true,
    isBaseModule: true,
  },

  // 二、投保基础约束
  {
    moduleName: "投保年龄",
    entityType: "underwriting_age_rule",
    sourceDocHints: ["产品条款", "投保须知", "产品说明书"],
    required: true,
    isBaseModule: true,
  },
  {
    moduleName: "投保职业",
    entityType: "underwriting_occupation_rule",
    sourceDocHints: ["核保数据", "产品条款", "投保须知"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "投保人群",
    entityType: "underwriting_target_group",
    sourceDocHints: ["产品说明书", "投保须知"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "未成年人保额限制",
    entityType: "underwriting_minor_sum_insured_limit",
    sourceDocHints: ["产品条款", "投保须知", "核保数据"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "孕妇投保限制",
    entityType: "underwriting_pregnant_restriction",
    sourceDocHints: ["产品条款", "投保须知", "核保数据"],
    required: false,
    isBaseModule: true,
  },

  // 三、核保相关
  {
    moduleName: "专属健康告知",
    entityType: "health_disclosure",
    sourceDocHints: ["健康告知", "投保须知", "核保材料"],
    required: true,
    isBaseModule: true,
  },
  {
    moduleName: "标体承保",
    entityType: "underwriting_decision_standard",
    sourceDocHints: ["核保数据", "核保手册"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "加费承保",
    entityType: "underwriting_decision_surcharge",
    sourceDocHints: ["核保数据", "核保手册"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "除外承保",
    entityType: "underwriting_decision_exclusion",
    sourceDocHints: ["核保数据", "核保手册"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "延期承保",
    entityType: "underwriting_decision_postpone",
    sourceDocHints: ["核保数据", "核保手册"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "拒保判定",
    entityType: "underwriting_decision_decline",
    sourceDocHints: ["核保数据", "核保手册", "健康告知"],
    required: false,
    isBaseModule: true,
  },

  // 四、时间周期约束
  {
    moduleName: "疾病等待期",
    entityType: "waiting_period_rule",
    sourceDocHints: ["产品条款", "投保须知"],
    required: true,
    isBaseModule: true,
  },
  {
    moduleName: "犹豫期",
    entityType: "free_look_period_rule",
    sourceDocHints: ["产品条款", "投保须知", "产品说明书"],
    required: true,
    isBaseModule: true,
  },

  // 七、免责约束
  {
    moduleName: "通用责任免除",
    entityType: "general_exclusion_rule",
    sourceDocHints: ["产品条款"],
    required: true,
    isBaseModule: true,
  },
  {
    moduleName: "既往症免责",
    entityType: "preexisting_condition_exclusion",
    sourceDocHints: ["产品条款"],
    required: false,
    isBaseModule: true,
  },

  // 八、保单保全变更
  {
    moduleName: "投保人变更",
    entityType: "policy_change_policyholder",
    sourceDocHints: ["产品条款", "产品说明书"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "受益人变更",
    entityType: "policy_change_beneficiary",
    sourceDocHints: ["产品条款", "产品说明书"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "退保",
    entityType: "policy_surrender",
    sourceDocHints: ["产品条款", "产品说明书"],
    required: false,
    isBaseModule: true,
  },
  {
    moduleName: "保单复效",
    entityType: "policy_reinstatement",
    sourceDocHints: ["产品条款"],
    required: false,
    isBaseModule: true,
  },

  // 九、理赔（通用部分）
  {
    moduleName: "理赔报案",
    entityType: "claim_reporting",
    sourceDocHints: ["服务与理赔指南", "产品条款", "理赔材料"],
    required: true,
    isBaseModule: true,
  },
  {
    moduleName: "常见拒赔原因",
    entityType: "claim_denial_reasons",
    sourceDocHints: ["服务与理赔指南", "产品条款"],
    required: false,
    isBaseModule: true,
  },

  // 十一、量化数据
  {
    moduleName: "分年龄保费费率表",
    entityType: "rate_table",
    sourceDocHints: ["费率表", "费率数据"],
    required: false,
    isBaseModule: true,
  },
]

/** 医疗险（含意外医疗险）专属模块 */
const MEDICAL_MODULES: ProductModule[] = [
  // 五、保障责任
  { moduleName: "一般住院医疗",     entityType: "coverage_general_hospitalization",      sourceDocHints: ["产品条款"], required: true,  isBaseModule: false },
  { moduleName: "特殊门诊医疗",     entityType: "coverage_special_outpatient",           sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "住院前后门急诊",   entityType: "coverage_pre_post_hospitalization",      sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "门诊手术医疗",     entityType: "coverage_outpatient_surgery",           sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "重大疾病医疗",     entityType: "coverage_critical_illness_medical",     sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "院外特定药品",     entityType: "coverage_outpatient_drugs",             sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "质子重离子医疗",   entityType: "coverage_proton_therapy",               sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "恶性肿瘤赴日医疗", entityType: "coverage_japan_cancer_treatment",       sourceDocHints: ["产品条款"], required: false, isBaseModule: false },

  // 六、费用与续保约束
  { moduleName: "年度免赔额",       entityType: "deductible_rule",                       sourceDocHints: ["产品条款", "产品说明书"], required: true,  isBaseModule: false },
  { moduleName: "有社保费率",       entityType: "premium_rate_with_social_insurance",    sourceDocHints: ["费率表", "产品说明书"],   required: false, isBaseModule: false },
  { moduleName: "无社保费率上浮",   entityType: "premium_rate_without_social_insurance", sourceDocHints: ["费率表", "产品说明书"],   required: false, isBaseModule: false },
  { moduleName: "6年保证续保",      entityType: "guaranteed_renewal_rule",               sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },

  // 九、理赔（医疗专属）
  { moduleName: "住院理赔材料",     entityType: "claim_documents_hospitalization",       sourceDocHints: ["服务与理赔指南", "理赔材料清单"], required: false, isBaseModule: false },
  { moduleName: "重疾理赔材料",     entityType: "claim_documents_critical",              sourceDocHints: ["服务与理赔指南", "理赔材料清单"], required: false, isBaseModule: false },
  { moduleName: "社保后赔付比例",   entityType: "reimbursement_rate_with_social",        sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "无社保赔付比例",   entityType: "reimbursement_rate_without_social",     sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "第三方报销分摊",   entityType: "third_party_coordination_rule",         sourceDocHints: ["产品条款"],              required: false, isBaseModule: false },

  // 十、增值医疗服务
  { moduleName: "住院垫付",         entityType: "value_added_cashless_hospitalization",  sourceDocHints: ["服务与理赔指南", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "重疾就医绿通",     entityType: "value_added_green_channel",             sourceDocHints: ["服务与理赔指南", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "异地就医医院限制", entityType: "hospital_scope_rule",                  sourceDocHints: ["产品条款", "服务与理赔指南"],    required: false, isBaseModule: false },
]

/** 重疾险专属模块 */
const CRITICAL_ILLNESS_MODULES: ProductModule[] = [
  // 五、保障责任（重疾专属）
  { moduleName: "重大疾病保险金",   entityType: "coverage_critical_illness_benefit",    sourceDocHints: ["产品条款"], required: true,  isBaseModule: false },
  { moduleName: "轻症保险金",       entityType: "coverage_mild_illness_benefit",         sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "中症保险金",       entityType: "coverage_moderate_illness_benefit",     sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "重疾分组",         entityType: "critical_illness_grouping",             sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "重疾多次赔付",     entityType: "critical_illness_multiple_claims",      sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "特定重疾额外赔付", entityType: "critical_illness_special_benefit",      sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "身故保险金",       entityType: "coverage_death_benefit",               sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "被保人保费豁免",   entityType: "premium_waiver_insured",               sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "投保人保费豁免",   entityType: "premium_waiver_policyholder",          sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  // 费率
  { moduleName: "保费调整",         entityType: "premium_adjustment_rule",              sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  // 保全（重疾险特有）
  { moduleName: "加保",             entityType: "policy_additional_purchase",           sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "减保",             entityType: "policy_reduction",                     sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "保单贷款",         entityType: "policy_loan",                          sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  // 理赔（重疾专属）
  { moduleName: "重疾理赔材料",     entityType: "claim_documents_critical",             sourceDocHints: ["服务与理赔指南"], required: false, isBaseModule: false },
  { moduleName: "身故理赔材料",     entityType: "claim_documents_death",                sourceDocHints: ["服务与理赔指南"], required: false, isBaseModule: false },
  // 数据表
  { moduleName: "年度现金价值表",   entityType: "cash_value_table",                     sourceDocHints: ["产品条款", "现金价值表"], required: false, isBaseModule: false },
]

/** 意外险专属模块 */
const ACCIDENT_MODULES: ProductModule[] = [
  // 保障责任
  { moduleName: "意外身故",         entityType: "coverage_accidental_death",            sourceDocHints: ["产品条款"], required: true,  isBaseModule: false },
  { moduleName: "意外伤残",         entityType: "coverage_accidental_disability",        sourceDocHints: ["产品条款"], required: true,  isBaseModule: false },
  { moduleName: "意外医疗",         entityType: "coverage_accidental_medical",           sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  { moduleName: "交通意外额外赔付", entityType: "coverage_traffic_accident_extra",       sourceDocHints: ["产品条款"], required: false, isBaseModule: false },
  // 理赔（意外险专属）
  { moduleName: "意外身故理赔材料", entityType: "claim_documents_accidental_death",      sourceDocHints: ["服务与理赔指南"], required: false, isBaseModule: false },
  { moduleName: "意外医疗理赔材料", entityType: "claim_documents_accidental_medical",    sourceDocHints: ["服务与理赔指南"], required: false, isBaseModule: false },
]

/** 寿险专属模块 */
const LIFE_INSURANCE_MODULES: ProductModule[] = [
  // 保障责任
  { moduleName: "身故保险金",       entityType: "coverage_death_benefit",               sourceDocHints: ["产品条款"], required: true,  isBaseModule: false },
  // 保全（寿险特有）
  { moduleName: "减保",             entityType: "policy_reduction",                     sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "保单贷款",         entityType: "policy_loan",                          sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  // 理赔
  { moduleName: "身故理赔材料",     entityType: "claim_documents_death",                sourceDocHints: ["服务与理赔指南"], required: false, isBaseModule: false },
  // 数据表
  { moduleName: "年度现金价值表",   entityType: "cash_value_table",                     sourceDocHints: ["产品条款", "现金价值表"], required: false, isBaseModule: false },
]

/** 年金险专属模块 */
const ANNUITY_MODULES: ProductModule[] = [
  { moduleName: "年金给付规则", entityType: "annuity_payment_rule", sourceDocHints: ["产品条款", "产品说明书"], required: true, isBaseModule: false },
  { moduleName: "领取期间", entityType: "annuity_payout_period", sourceDocHints: ["产品条款"], required: true, isBaseModule: false },
  { moduleName: "万能账户规则", entityType: "universal_account_rule", sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "保证利率", entityType: "guaranteed_interest_rate", sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "初始费用", entityType: "initial_fee_rule", sourceDocHints: ["产品说明书"], required: false, isBaseModule: false },
  { moduleName: "领取手续费", entityType: "withdrawal_fee_rule", sourceDocHints: ["产品说明书"], required: false, isBaseModule: false },
  { moduleName: "保单贷款", entityType: "policy_loan", sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "减保", entityType: "policy_reduction", sourceDocHints: ["产品条款", "产品说明书"], required: false, isBaseModule: false },
  { moduleName: "年度现金价值表", entityType: "cash_value_table", sourceDocHints: ["产品条款", "现金价值表"], required: false, isBaseModule: false },
  { moduleName: "领取明细示例", entityType: "annuity_illustration", sourceDocHints: ["产品说明书", "产品问答"], required: false, isBaseModule: false },
]

// ── 全量模块注册表 ────────────────────────────────────────────────────────────

/** 每个险种的完整模块列表（基础模块 + 专属模块） */
export const PRODUCT_CATALOG_MODULES: Record<InsuranceCategoryType, ProductModule[]> = {
  "医疗险": [...BASE_MODULES, ...MEDICAL_MODULES],
  "重疾险": [...BASE_MODULES, ...CRITICAL_ILLNESS_MODULES],
  "意外医疗险": [...BASE_MODULES, ...MEDICAL_MODULES],  // 意外医疗险复用医疗险模块
  "意外险": [...BASE_MODULES, ...ACCIDENT_MODULES],
  "寿险": [...BASE_MODULES, ...LIFE_INSURANCE_MODULES],
  "年金险": [...BASE_MODULES, ...ANNUITY_MODULES],
}

// ── 命名规则函数 ──────────────────────────────────────────────────────────────

/**
 * 生成产品知识库文件的标准标题（不含 .md 后缀）。
 * 规则：{险种类别}-{产品名}-{模块名}
 *
 * 示例：
 *   buildProductModuleTitle("医疗险", "安心百万医疗险2026版", "保障责任")
 *   → "医疗险-安心百万医疗险2026版-保障责任"
 */
export function buildProductModuleTitle(
  category: InsuranceCategoryType,
  productName: string,
  moduleName: string,
): string {
  return `${category.trim()}-${productName.trim()}-${moduleName.trim()}`
}

/**
 * 解析产品模块标题，提取 category / productName / moduleName 三元组。
 * 格式：{险种类别}-{产品名}-{模块名}
 *
 * 注意：产品名和模块名本身不含 "-"（或者含连字符时取第一段为 category，
 * 最后一段为 moduleName，中间全部为 productName）。
 */
export function parseProductModuleTitle(
  title: string,
): { category: InsuranceCategoryType; productName: string; moduleName: string } | null {
  const parts = title.split("-")
  if (parts.length < 3) return null
  const category = parts[0] as InsuranceCategoryType
  if (!INSURANCE_CATEGORIES.includes(category)) return null
  const moduleName = parts[parts.length - 1]
  const productName = parts.slice(1, -1).join("-")
  if (!productName || !moduleName) return null
  return { category, productName, moduleName }
}

/**
 * 根据原始文档的文件名推断最可能属于的模块名列表（提示，不是强制）。
 * 例如：「产品条款.pdf」→ 可能涉及多个模块（保障责任、免责条款等）
 *        「费率表.xlsx」→ 只涉及「分年龄保费费率表」模块
 */
export function inferModulesFromSourceFileName(
  fileName: string,
  category: InsuranceCategoryType,
): string[] {
  const name = fileName.toLowerCase()
  const allModules = PRODUCT_CATALOG_MODULES[category]

  if (name.includes("费率") || name.includes("rate")) {
    return allModules
      .filter(m => m.sourceDocHints.some(h => h.includes("费率")))
      .map(m => m.moduleName)
  }
  if (name.includes("条款") || name.includes("clause")) {
    return allModules
      .filter(m => m.sourceDocHints.some(h => h.includes("条款")))
      .map(m => m.moduleName)
  }
  if (name.includes("核保") || name.includes("underwriting")) {
    return allModules
      .filter(m => m.sourceDocHints.some(h => h.includes("核保") || h.includes("健康告知")))
      .map(m => m.moduleName)
  }
  if (name.includes("理赔") || name.includes("claim")) {
    return allModules
      .filter(m => m.sourceDocHints.some(h => h.includes("理赔")))
      .map(m => m.moduleName)
  }
  if (name.includes("说明书") || name.includes("manual")) {
    return allModules
      .filter(m => m.sourceDocHints.some(h => h.includes("产品说明书")))
      .map(m => m.moduleName)
  }
  // 无法识别 → 返回所有 required 模块
  return allModules.filter(m => m.required).map(m => m.moduleName)
}

/**
 * 获取一个险种的所有「必须」模块名列表，
 * 用于前端展示模块完整度（哪些模块缺失）。
 */
export function getRequiredModules(category: InsuranceCategoryType): string[] {
  return PRODUCT_CATALOG_MODULES[category]
    .filter(m => m.required)
    .map(m => m.moduleName)
}

/**
 * 从一组已存在的文件名里，提取属于特定产品的模块列表。
 * 输入：wiki/product_catalog/ 目录下的所有文件名
 * 输出：该产品已有的模块名列表
 */
export function getExistingModules(
  existingFileNames: string[],
  category: InsuranceCategoryType,
  productName: string,
): string[] {
  const prefix = `${category}-${productName}-`
  return existingFileNames
    .filter(n => n.startsWith(prefix) && n.endsWith(".md"))
    .map(n => n.slice(prefix.length, -3))  // 去掉前缀和 .md
}

/**
 * 计算一个产品的模块完整度（0-1）。
 * 基于「必须模块」的覆盖率计算。
 */
export function calcModuleCompleteness(
  existingModules: string[],
  category: InsuranceCategoryType,
): number {
  const required = getRequiredModules(category)
  if (required.length === 0) return 1
  const covered = required.filter(m => existingModules.includes(m)).length
  return covered / required.length
}

/**
 * Given a source file name, compute the list of module batches to extract.
 *
 * Batch size guidelines (auto-selected based on filename):
 * - \u6761\u6b3e/\u8bf4\u660e\u4e66/\u624b\u518c (comprehensive docs): 4 modules/batch \u2192 ~7 tasks for medical
 * - \u8d39\u7387/\u6838\u4fdd/\u7406\u8d54 (specialist docs): 3 modules/batch \u2192 precise focus
 *
 * Source summary (wiki/sources/) is generated only in batch 0.
 */
export function getModuleBatchesForFile(
  sourceFileName: string,
  category: InsuranceCategoryType,
  batchSize?: number,
): string[][] {
  const name = sourceFileName.toLowerCase()
  // Auto-select batch size based on document type
  const effectiveBatchSize = batchSize ?? (
    (name.includes("\u6761\u6b3e") || name.includes("clause") || name.includes("\u8bf4\u660e\u4e66") || name.includes("\u624b\u518c"))
      ? 4  // Comprehensive docs: 4/batch \u2192 ~7 tasks instead of 14
      : 3  // Specialist docs: 3/batch
  )

  const candidateModules = inferModulesFromSourceFileName(sourceFileName, category)
  const allModuleNames = PRODUCT_CATALOG_MODULES[category].map(m => m.moduleName)

  // Use the inferred modules, fall back to required-only if infer returns nothing
  let targetModules = candidateModules.length > 0 ? candidateModules : allModuleNames.filter(n =>
    PRODUCT_CATALOG_MODULES[category].find(m => m.moduleName === n)?.required
  )

  // Deduplicate while preserving order
  targetModules = [...new Set(targetModules)]

  // Split into batches
  const batches: string[][] = []
  for (let i = 0; i < targetModules.length; i += effectiveBatchSize) {
    batches.push(targetModules.slice(i, i + effectiveBatchSize))
  }
  return batches.length > 0 ? batches : [targetModules]
}

/**
 * Encode product catalog context + batch into a folderContext string.
 * Format: "product_catalog > {category} > {productName} > batch:{n}:{mod1},{mod2}"
 *
 * The batch encoding is backwards-compatible: if no batch segment is found,
 * parseProductCatalogCtxFromFolderContext returns batchModules: null (means "all modules").
 */
export function encodeProductCatalogFolderContext(
  category: InsuranceCategoryType,
  productName: string,
  batchModules: string[],
  batchIndex: number,
): string {
  const encoded = batchModules.join(",")
  return `product_catalog > ${category} > ${productName} > batch:${batchIndex}:${encoded}`
}
