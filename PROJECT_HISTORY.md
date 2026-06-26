# LLM Wiki — 项目迭代记录

> 本文档记录 LLM Wiki 项目的每次功能迭代、架构决策和待解决问题。  
> **目的**：为接手者（人工或 AI）提供项目上下文，避免重复踩坑。  
> **规范**：每次功能迭代必须在此追加一条记录。

---

## 项目背景

**项目名称**：LLM Wiki（内部代号）  
**领域**：平安人寿 保险产品知识库 + 销售智能辅助  
**定位**：基于 LLM 的结构化知识抽取、管理与 RAG 检索系统  
**技术栈**：
- 前端：React + TypeScript (Vite)
- 后端：Rust (axum) — `server-rs/`
- 知识存储：Markdown + YAML frontmatter（wiki 目录）
- 嵌入/检索：向量嵌入 + 关系图（wiki-data/）
- LLM：通过 `streamChat` 调用，支持多模型配置

**核心数据源**：平安人寿 保险产品文档（PDF/Word/Excel/JSON）  
包括：服务手册、险种条款、费率表、准入清单、销售话术材料等

---

## 知识域体系（Knowledge Domain）

```
knowledge_domain:
  ├── product          # 服务权益（ServiceBenefit、ServiceItem）
  │                    # 典型文档：服务手册、服务权益清单
  │                    # 答「保单持有人能享受什么服务」
  ├── product_catalog  # 险种产品库 [新增 2026-06-14]
  │                    # 典型文档：险种条款、费率表、产品对比
  │                    # 答「这个险种是什么、怎么配、费率多少」
  ├── method           # 销售方法（话术、QA、异议处理、销售路径）
  ├── cases            # 成交案例、客户原声
  ├── customer         # 客户画像、生命周期、客户信号
  ├── compliance       # 合规规则
  ├── content          # 销售素材、内容模板
  ├── activity         # 活动、激励
  └── general          # 兜底
```

### 核心文件路径映射
```
src/lib/knowledge-schema.ts          # 通用 schema 类型定义、domain 枚举、关系类型
src/lib/insurance-schema-registry.ts # 保险行业实体规格（schema key → 字段清单）
src/lib/ingest.ts                    # 文档摄入 pipeline（OCR → intent识别 → LLM抽取 → wiki写入）
src/lib/knowledge-schema-normalizer.ts # frontmatter 标准化
src/lib/knowledge-postprocess.ts     # 摄入后处理（关系推断、身份解析）
src/lib/knowledge-global-relation.ts # 全局关系 pass
src/lib/knowledge-identity-resolution.ts # 跨文档实体去重/合并
src/lib/service-benefit-enrichment.ts   # 服务权益专项富化
src/lib/insurance-schema-registry.ts    # 服务层级注册（系列>场景>线>版本>服务项）
server-rs/src/handlers/fs.rs         # Rust 后端文件系统 + PDF 读取（4级 OCR fallback）
```

### 服务层级体系（Service Hierarchy）
```
系列 (Series)
  └── 场景 (Scenario): 医健 | 养老 | 家办
        └── 服务线 (ServiceLine): 臻享家医 | 安有医 | 居家养老 ...
              └── 服务线版本 (ServiceLineVersion): V1 | 颐享版 | V2优享 ...
                    └── 服务项 (ServiceItem): 在线问诊 | 家庭医生服务 ...
                          └── 服务项聚合页 (ServiceItemConcept): 跨版本通用定义
```

---

## 迭代记录

---

### [v0.1 ~ v1.x] 初期建设（2026年5月前）

**核心功能奠定**：
- 基础 wiki 知识抽取 pipeline（上传 → OCR → LLM → Markdown 写入）
- 通用 schema v2.1（product / customer / method / cases / compliance 五域）
- 服务权益层级体系（Series > Scenario > ServiceLine > Version > Item）
- RAG 检索基础（向量嵌入 + 关系图展开）
- Tauri 桌面版 + axum HTTP 服务双模式

**关键文件确立**：
- `knowledge-schema.ts`：通用实体/关系类型体系
- `insurance-schema-registry.ts`：保险行业 schema 注册表（含服务层级 v2）
- `ingest.ts`：文档摄入主逻辑

---

### [2026-06-05] 修复知识图谱关系 & RAG 质量回归

**分支**：`feature/schema-v2-service-category`（含多次提交）  
**背景**：服务实体命名混乱、RAG 检索优先级错误、关系写入阈值过高

**变更**：
- 统一实体命名规范（产品和版本前缀强制）
- RAG 检索优化：优先 body 内容、保证结构完整性
- 关系写入阈值从 0.82 降至 0.65
- 修复 rebuild relations 按钮 + 全量 fallback
- 修复 self-recovery heartbeat + watchdog 未定义变量
- 修复 AbortController 超时（5min）+ 服务器创建 dialog 逻辑
- `buildEntityCatalog` 重写为使用 FileNode children 树

**关键提交**：
```
3bcc805 fix: rewrite buildEntityCatalog to use FileNode children tree
5956592 feat: restore rule-based serial concept aggregation for 关联概念
10cf4d7 fix: lower relation write threshold 0.82→0.65 + path normalization
6d48750 fix: rebuild relations button + auto full-pass fallback
```

---

### [2026-06-14] PDF OCR Pipeline 三级 fallback 增强

**分支**：`feature/schema-v2-service-category`  
**提交**：`1c485c5`

**背景**：部分扫描件 PDF 的文字层是乱码（garbled），pdf-extract 读出来全是重复字符，导致摄入内容无效。

**变更（`server-rs/src/handlers/fs.rs`）**：
- 新增 `is_garbled_pdf_text()` 检测函数（unique_char_ratio < 0.015 或 top_word_dominance > 0.20 判定为乱码）
- PDF 读取改为 4 级 fallback pipeline：
  1. 内部 OCR API（`OCR_ENDPOINT` 配置时优先）
  2. pdf-extract（纯 Rust，快速，文字层 PDF）
  3. pdftotext（Poppler fallback，质量更好）
  4. pdftoppm → 图片页面 marker（图片型 PDF 兜底）
- 乱码检测在 Tier 2/3 均生效

**变更（`src/lib/ingest.ts`）**：
- schema 候选识别逻辑增强（+168 行）
- 批次构建逻辑改进

---

### [2026-06-14] 新增 product_catalog 险种产品库领域（插拔式）

**分支**：`feature/product-catalog-domain`  
**提交**：`4025722`

**背景**：
原 `product` domain 同时承载「服务权益」（ServiceBenefit）和「险种知识」（条款、费率），两者在 RAG 检索方向完全不同，导致检索精准度下降。平安人寿险种数量多，需要独立结构化管理。

**方案选择**：方案 B（插拔式独立 domain），而非在 product 下加子字段。

**变更（`src/lib/knowledge-schema.ts`）**：
- `InsuranceKnowledgeDomain` 新增 `"product_catalog"`
- `DOMAIN_LABELS` 新增 `"险种产品库"`
- `INSURANCE_ENTITY_TYPE_DOMAIN` 注册：`product_overview | product_comparison | rate_table`
- `ENTITY_TYPE_TO_UNIVERSAL_TYPE`：`entity | comparison | data`
- `UNIVERSAL_INSURANCE_SCHEMA_PROMPT` knowledge_domain 枚举更新

**变更（`src/lib/insurance-schema-registry.ts`）**：
- `InsuranceEntitySchemaSpec.domain` 扩展支持 `"product_catalog"`
- `InsuranceEntitySchemaSpec.universalType` 扩展支持 `"comparison"`
- 新增 `PRODUCT_CATALOG_SCHEMA` 数组，末尾 push 进主注册表（插拔点）：
  - **`ProductOverview`**（险种总览）：product_code、保险责任、责任免除、等待期、投保年龄
  - **`ProductComparison`**（产品横向对比）：comparison_title、对比表格、选品逻辑
  - **`RateTable`**（费率表）：related_product、rate_table_version、sample_rates

**变更（`src/lib/ingest.ts`）**：
- `SchemaCandidateKind` 新增 3 个值
- `DocumentIntentDocType` 新增 3 个值
- `recognizeDocumentIntent()` 在最前面插入 product_catalog 3 个识别分支（优先于 product domain）：
  1. `rate_table`：触发词 "费率表、每万元、年缴保费..."
  2. `product_comparison`：触发词 "产品对比、险种对比、对比表..."
  3. `product_catalog`：险种大类 + 产品代码/备案号 双信号
  - 全部有 `isNotServiceManual` 守卫防止服务手册误判

**插拔控制**：
```typescript
// 关闭 product_catalog domain（如需要）
// 注释掉 insurance-schema-registry.ts 末尾：
// INSURANCE_SCHEMA_REGISTRY.push(...PRODUCT_CATALOG_SCHEMA)
// 注释掉 ingest.ts 里的三个 product_catalog 识别分支
```

**目录规范**：
```
wiki/
  product/          # 服务权益（现有，不变）
  product_catalog/  # 险种产品库（新增）
    重疾险/
    医疗险/
    年金险/
    ...
```

**TypeScript 检查**：`tsc --noEmit` 零错误 ✅

**待确认（预计 2026-06-15 产品讨论后决定）**：
- [ ] DEDUP_KEY_FIELDS 去重字段：`product_overview: ["product_code"]`？
- [ ] 前端上传：手动选择 domain 还是完全自动识别？
- [ ] 是否新建独立「产品库」浏览页，还是通过 domain 筛选？

---

## 架构关键约束（接手必读）

### 1. 实体命名规范
- **ServiceItem** 标题格式：`{line_name}-{version_name}-{item_name}`（例：`臻享家医-V1-在线问诊`）
- **ProductOverview** 去重键：`product_code`（优先）
- 别名统一走 `canonicalServiceIdentityName()` 处理

### 2. Frontmatter 字段约定
```yaml
schema_version: "2.1"
industry: insurance
knowledge_domain: product | product_catalog | method | cases | ...
entity_type: service_item | product_overview | pitch | ...
dedup_key: 稳定小写key，跨文档身份标识
confidence: 0.0-1.0
status: candidate | active | archived
needs_review: true | false
```

### 3. 关系层级（trust 从高到低）
```
user_confirmed > explicit > explicit_ingest > postprocess_inferred > llm_inferred > field_derived > wikilink
```

### 4. RAG 检索关键参数
- 关系写入阈值：0.65（`knowledge-global-relation.ts`）
- 摄入缓存：`checkIngestCache` / `saveIngestCache`（避免重复处理）
- source page 独立于 wiki entity page（`wiki/sources/` vs `wiki/entities/`）

### 5. PDF 处理 4 级 fallback（`server-rs/src/handlers/fs.rs`）
```
Tier 1: 内部 OCR API（OCR_ENDPOINT 环境变量）
Tier 2: pdf-extract（纯 Rust）+ 乱码检测
Tier 3: pdftotext（poppler-utils）+ 乱码检测
Tier 4: pdftoppm → 图片页面 marker → 前端 VLM OCR
```

---

## 开放问题追踪

| 编号 | 问题 | 状态 | 记录时间 |
|---|---|---|---|
| Q001 | product_catalog 前端上传时是否需要手动选择 domain | ✅ 已确认：手动选择险种类型 | 2026-06-14 |
| Q002 | 是否需要新建独立「产品库」浏览页面 | ✅ 已确认：需要，包含文件上传界面 | 2026-06-14 |
| Q003 | DEDUP_KEY_FIELDS | ✅ 已确认 | 2026-06-14 |
| Q004 | 险种产品和服务手册重叠时合并还是分页关联？ | ✅ 已确认：wikilink 关联，不合并 | 2026-06-14 |
| Q005 | LLM 推断型字段标注策略 | ✅ 已确认：标注 `confidence: inferred` | 2026-06-15 |
| Q006 | comparisons / synthesis 层触发机制 | ✅ 已确认：Phase 2 | 2026-06-15 |
| Q007 | `shouldReplaceFieldValue` informationScore 权重验证 | 🔲 待验证 | 2026-06-21 |
| Q008 | Refine regex `[^|]*` 是否会误覆盖已正确的值 | 🔲 待验证 | 2026-06-21 |
| Q009 | LIFE_INSURANCE / ANNUITY 缺失字段补齐 | ✅ 主要字段已补齐，继续样本观察 | 2026-06-21 |
| Q010 | 意外医疗险是否需要独立字段数组 | 🔲 待决定 | 2026-06-21 |
| Q011 | 年金险生成越域 md（如孕妇投保限制） | ✅ 后续代码已按险种白名单阻断 | 2026-06-22 |
| Q012 | 寿险 `费用` 被 `退保费用` 误回填 | ✅ 后续代码已阻断，历史样本不清理 | 2026-06-22 |
| Q013 | 编辑字段页后预览/产品树不实时刷新 | ✅ 已修复：保存后同步当前内容、切预览前 flush、知识树监听 dataVersion | 2026-06-25 |
| Q014 | 删除源文件后旧 product_catalog 派生页残留 | ✅ 已修复：补来源路径变体匹配 + 产品级 orphan cleanup | 2026-06-25 |
| Q015 | 已删除 md 的后端 `File does not exist` 错误暴露到前端 | ✅ 已修复：API 错误规范化 + 预览/viewer 双层兜底 | 2026-06-25 |
| Q016 | 冲突 review 采用新值后只改模块摘要，字段页/主产品页未同步 | ✅ 已修复：识别模块页冲突字段，回写模块表格、字段页、主产品页与概念页 | 2026-06-25 |
| Q017 | `身故保险金` 模块冲突采用新值时报缺少 `字段-身故保险金.md` | ✅ 已修复：模块字段先更新模块页，再按真实存在的产品字段页候选同步；不存在字段页时不再中断 | 2026-06-25 |
| Q018 | 点击 review「采用新值」后 UI 没有明显反馈 | ✅ 已修复：按钮增加采用中状态；文件树刷新失败不再阻止 review 标记为已采用 | 2026-06-25 |
| Q019 | review「采用新值」速度偏慢 | ✅ 已优化：md 回写完成后立即更新 review 状态，concept/embedding 派生刷新改为后台执行 | 2026-06-25 |
| Q020 | 产品目录只剩一个真实源文件时删除后派生 md 未清理 | ✅ 已修复：`product_meta.json` 不再算作有效源资料；最后一个真实源文件删除后清理产品派生页和空源目录 | 2026-06-25 |
| Q021 | 源文件删除后前端仍需手动刷新页面 | ✅ 已修复：删除中按钮态 + 成功后乐观剪枝 source tree、清空右侧预览，并用后台列表刷新做校准 | 2026-06-25 |
| Q022 | 左侧 Knowledge/Files 列表标题过长且文档多时难查找 | ✅ 已优化：左侧面板可拖拽宽度上限放大；Knowledge/Files 增加标题、文件名、路径本地搜索 | 2026-06-25 |
| Q023 | 字段冲突处理完成后没有出现在「知识演化」Tab | ✅ 已修复：知识演化面板直接读取 `.llm-wiki/review.json` 中 resolved 的知识冲突/更新记录 | 2026-06-26 |
| Q024 | 单个产品源文件删除速度慢，尤其是费率表/补充文件 | ✅ 已优化：产品单文件删除走产品上下文快路径，不再先做全库 loose-match 关联扫描 | 2026-06-26 |
| Q025 | 删除单个文件后应只清掉该文件独占支撑的字段值 | ✅ 已实现基础版：基于字段页 `value_sources` 清空失去来源的字段，保留其它文件支撑的字段 | 2026-06-26 |
| Q026 | 增量 mock 文件导致 QA、额度类型、免赔额等弱值产生过多冲突 | ✅ 已优化：弱值/占位值过滤、QA 直接问答块优先、比旧值更粗略的新值不再生成冲突 | 2026-06-26 |
| Q027 | 基础字段缺少「产品别称」「QA」 | ✅ 已补齐：加入基础字段、QA 基础模块、抽取关键词、精炼字段和 long field 聚合映射 | 2026-06-26 |

---

### [2026-06-15 ~ 2026-06-17] Section-Scan 抽取架构重写

**提交**：`b9a61eb` → `b225d73`（26 个提交）

**背景**：v2.1 的"LLM 生成整个文件"导致险种代码/简称缺失、原文被截断。

**架构变更**：
- 新 Pipeline：`OCR全文 → splitIntoSections → group-round LLM → parseModuleBlocks → mergeFragmentContents → 注入原文 → Phase 5 精炼`
- LLM 只输出关键字段表格，原文由代码端 100% 注入
- Group-Round 分组抽取，每轮 5-8 模块，LLM 调用次数减少 70%
- Phase 5 精炼：对"未明确"字段做二次聚焦 LLM 调用
- Concept 聚合系统：`concept-aggregator.ts`，队列清空后自动生成跨产品关联页

**关键提交**：`b9a61eb`(concept), `209dca3`(group-round), `a0c01e3`(Phase5), `ebdcac4`(streamChat fix), `b225d73`(原文注入)

---

### [2026-06-17] DeepSeek v4 迁移 + 路径自动检测

- `deepseek-chat` → `deepseek-v4-pro` 自动迁移
- `ingest.ts`：路径匹配 `产品/{category}/{productName}/xx.pdf` → 自动推断 `folderContext`

---

### [2026-06-21] Codex 字段质量优化 + Excel 字段对齐

**Codex 改动**：`shouldReplaceFieldValue()` 智能值替换、`FIELD_EXTRACTION_HINTS` 模块级提示、"未明确" → 空值  
---

### [2026-06-22] v2.3 抽取质量优化 + 前端卡住 bug 修复

**问题**：
1. 主文件 50%+ 字段为空（抽取不全）
2. OCR 完成后前端 Activity Panel 显示卡住不动
3. 产品目录抽取路径无 try-catch，异常时 UI 静默失败

**改动（`product-catalog-extractor.ts`）**：
- **Section 粒度增大**：`targetChars: 25000 → 6000`，sections 从 65 个降至 ~10 个，LLM 调用从 ~200 降至 ~30
- **模块→主文件字段桥接**：新增 `MODULE_TO_FIELD_BRIDGE` 映射 11 个模块 → 20+ 个主文件字段（犹豫期、免赔额、续保等）
- **长文本字段自动合成**：新增 `LONG_FIELD_MODULE_MAP`，从多模块聚合 保什么/报销范围/投保范围 等长字段
- **Prompt 增强**：字段列表附带 valueHint 格式提示、强制跨章节基础信息提取、长文本字段允许 100-300 字
- **Fuzzy match 扩展**：去掉 `sf.valueType !== "short"` 限制，长文本字段也参与模糊匹配
- **Heartbeat 计时器**：每 5 秒更新 Activity Panel 显示已耗时，防止 UI 看起来冻住

**改动（`ingest.ts`）**：
- 产品目录抽取路径包裹 try-catch，异常时设置 `status: "error"` 并显示错误信息

**效果预估**：
- 空字段率从 ~50% 降至 ~25%（剩余为运营数据/人工字段，原文不存在）
- 抽取耗时从 20-30 分钟降至 3-5 分钟
- Activity Panel 不再出现"冻住"现象

---

### [2026-06-22] v2.4 产品字段页、越域治理与寿险质量修复

**背景**：
1. 需要按 Excel 基础字段 + 险种专属字段生成可检索 md，未抽到值先留空，供后续精炼或补充资料填充。
2. 年金险曾生成不属于本险种的模块页（如孕妇投保限制），会污染给检索老师使用的 md。
3. `0622-06/0622-07` 验证中发现寿险 `保什么` 已在身故模块有证据但主字段未接上，`费用` 又被 `退保费用` 误回填。
4. 精炼阶段偶发把“未提及/未明确”的变体写成字段值，需要统一过滤为空。

**代码变更**：
- `product-catalog-modules.ts`
  - 增加险种级基础模块白名单，`PRODUCT_CATALOG_MODULES` 不再给所有险种套用全量 `BASE_MODULES`。
  - 新增 `isModuleAllowedForCategory()`，供抽取、搜索、embedding、concept 聚合统一判断模块是否越域。
  - 年金险补齐 `高流动性`、`教育金`、`领钱时间早`、`投保门槛低`、`契调限制` 等字段。
  - `getExtractableFields()` 改为返回 Excel schema 全字段；原文没有的字段仍生成字段页但值为空。
- `product-catalog-extractor.ts`
  - 新增 `product_catalog_field` 字段页生成：每个产品按 `PRODUCT_FIELDS[category]` 生成 `字段-{field}.md`。
  - 字段页增加 `status`、`extraction_state`、`value_source`、`evidence_modules`、`source_hint`、知识缺口等元信息。
  - 空值字段页标记 `rejected/needs_refinement`，有值字段页标记 `candidate/has_values`。
  - 主产品 md 增加“已有知识清单 / 知识缺口清单”，字段层和模块层分开展示。
  - 精炼支持把缺失字段追加回模块关键字段表，并在精炼后重建主文件和字段页。
  - 占位文本清洗从只处理“未明确”扩展到“证据片段中未提及 / 未在证据片段 / 原文中未”等变体。
  - 寿险 `身故保险金` 模块补充 `保什么 / 全残保障 / 意外身故 / 疾病身故` 目标字段，并桥接到主字段 `保什么`。
  - 年金险 `年金给付规则 / 领取期间 / 保单贷款 / 万能账户规则` 增加字段回填与长文本合成。
  - `费用` 字段质量防护：`退保` 精炼不再主动补抽基础字段 `费用`；`extractable: false` 字段不允许通过子串模糊回填；“退保会造成损失”类提示会从主字段中过滤。
- `concept-aggregator.ts`
  - 概念页同时聚合模块实体和字段实体；字段实体只收录有值字段页。
  - 跳过 `status: rejected` 字段页，避免空字段污染概念检索。
  - 模块聚合按 `isModuleAllowedForCategory()` 过滤越域模块。
- `embedding.ts` / `search.ts`
  - 跳过 `status: rejected` 的知识页。
  - 跳过险种不允许的越域产品模块页，降低错误 md 对检索结果的影响。
- `sources-view.tsx` / `knowledge-tree.tsx`
  - 上传面板显示“字段页 + 模块页”的生成规模，解释字段页会先留空待精炼。
  - 产品树计数从“模块”改为“页”，避免字段页加入后文案误导。

**验证样本结论**：
- `0622-06`：寿险 `身故保险金` 原文和模块值存在，但 `保什么` 主字段未接上；v2.4 已增加桥接。
- `0622-07`：字段页证据模块已正确指向寿险 `身故保险金`，不再指向年金模块；但 `保什么` 摘要偏短，后续可继续优化“优先采用详细给付规则”。
- `0622-07`：`字段-费用.md` 的值“犹豫期后退保会给您造成一定的损失”属于误回填；v2.4 已阻断后续生成，不清理当前样本。

**验证命令**：
- `npx tsc --noEmit --pretty false`
- `git diff --check`

**注意**：本次只修后续代码路径，不自动清理已有 `wiki-data/0622-06` / `wiki-data/0622-07` 产物；需要重新上传或触发重建后生效。

---

### [2026-06-24 ~ 2026-06-25] v2.5 增量产品库抽取、编辑同步与删除体验治理

**当前分支**：`feature/product-catalog-domain`
**关键提交**：`99fdcf5 feat: incremental product catalog extraction + OOM fixes`
**补充改动**：2026-06-25 多处未提交修复（编辑保存、删除级联、错误兜底、后端数据根 guard）

**背景**：
1. 用户开始按“一个产品多次补充资料”的方式上传产品条款/补充材料，需要增量合并而不是每次重建全量产物。
2. 产品库字段页支持人工编辑后，主产品 md、字段页摘要、concept/embedding 需要同步刷新。
3. 删除源文件后，老版本生成的 product_catalog 页面可能缺 `sources/value_sources`，导致派生 md 残留。
4. 删除后如果右侧仍选中已不存在的 md，后端 `{"error":"File does not exist..."}` 不应作为 markdown 内容暴露给用户。

**代码变更**：
- `product-catalog-extractor.ts`
  - 新增增量写入路径：已有产品主文件存在时，增量上传只补空字段/新模块，已有非空值不被自动覆盖。
  - 字段冲突进入 review queue，保留旧值，避免新资料误覆盖已确认知识。
  - 增量 source_text 使用 `增量原文-{sourceStem}.md`，保留来源可追溯。
  - OOM 优化：抽取队列与写入流程减少一次性大文本/大任务堆积。
  - 精炼流程扩展到字段页缺口：模块精炼后按字段页补抽，并重建主文件。
- `product-catalog-sync.ts`
  - 新增字段页编辑后的同步模块。
  - 人工改字段页后同步主产品表格、字段搜索摘要、concept 与 embedding。
  - 删除来源时可清理字段页 value/source lineage；若字段值失去来源则标记 `needs_refinement`。
  - 修复冲突 review「采用新值」指向模块页时只更新摘要的问题：现在会识别 `投保年龄.最低投保年龄` 这类子字段，回写模块关键字段表，并同步聚合后的字段页、主产品页、concept 与 embedding。
  - 修复模块名不等于产品字段名时的同步失败：如 `身故保险金.身故保险金` 只存在模块页，不存在 `字段-身故保险金.md`，现在会先更新模块页，再尝试同步到真实存在的 `保什么`、`意外身故`、`疾病身故`、`特殊免责` 等字段页；无可同步字段页时也不会让「采用新值」失败。
- `preview-panel.tsx` / `wiki-editor.tsx` / `knowledge-tree.tsx`
  - 自动保存成功后同步当前预览内容，不再只在产品字段分支刷新。
  - 从编辑态切回预览前强制 flush pending save，避免看到旧内容。
  - 编辑器避免因父级内容相同而重复解析，减少光标跳动。
  - 知识树监听 `dataVersion`，字段页/产品库信息保存后实时重读。
- `review-view.tsx`
  - 冲突 review 点击「采用新值」后增加处理中状态，当前卡片按钮禁用并显示「采用中...」。
  - 采用新值成功后先标记 review 为已处理并触发 dataVersion 刷新；文件树刷新改为非关键步骤，失败只记录 warning，不再让用户感觉点击无响应。
  - 「采用新值」不触发 AI 重新抽取；现在关键路径只做确定性 md 回写与产品字段同步，concept/embedding 派生刷新后台执行。
- `sources-view.tsx`
  - 删除源文件时按多个来源 ref 查找关联页：相对路径、文件名、Windows 中文路径编码变体均参与匹配。
  - 识别 `raw/sources/产品/{险种}/{产品名}` 产品上下文。
  - 删除产品最后一个有效源文件或空产品文件夹时，产品级清理 `wiki/product_catalog` 与 `wiki/source_text` 残留产物。
  - 产品源目录中的 `product_meta.json` 仅作为系统 manifest，不再视为真实源资料；删除最后一个真实源文件后会一并清理空产品源目录。
  - 删除按钮增加执行态：二次确认后显示“删除中...”，删除成功后立即从 source tree 乐观移除源文件/空产品源目录，并清空右侧已删除预览；`loadSources()` 与全局 file tree 刷新仅作为后台校准，不再要求用户手动刷新页面。
  - 删除后清理 index/concept 中指向已删除页面的 wikilink，刷新 concepts。
- `api-client.ts` / `fs-errors.ts` / `preview-panel.tsx` / `wiki-page-viewer.tsx`
  - 后端错误体优先解析为干净 message，不再把 `{"error": ...}` 原样抛给 UI。
  - `readFile()` 若收到兼容路径返回的后端错误字符串，会转成异常。
  - 预览面板遇到“文件已不存在”会清空选中、刷新文件树，而不是渲染错误文本。
  - `WikiPageViewer` 增加兜底：即便旧状态把错误字符串塞进 `fileContent`，也只显示“页面已删除，正在刷新列表”，不再出现 `Untitled/default/路径/Error...` 的假 md 卡片。
- `server-rs/src/state.rs` / `server-rs/src/handlers/fs.rs` / `server-rs/src/main.rs`
  - 后端数据目录 guard 从单一 `WIKI_DATA_PATH` 扩展为允许多根目录。
  - 支持主数据目录、`WIKI_EXTRA_DATA_PATHS`、以及仓库祖先层级下的 `wiki-data`。
  - 启动日志打印允许数据根，便于排查“读得到但写不了”的运行态问题。

**用户体验结果**：
- 删除某个源文件后，如果对应 md 已被删，右侧预览会自动退出/刷新，不再把后端接口错误当成 markdown 展示。
- 源文件/文件夹删除成功后，左侧 source tree 会立即移除对应节点，按钮显示删除进度；用户不需要手动刷新页面才能看到结果。
- 左侧 Knowledge/Files 面板可继续向右拖宽，并支持本地搜索标题、文件名和路径，长标题与大量文档场景更容易定位。
- 单文件上传后再删除，派生的产品字段页、模块页、原文页会按产品上下文清理；旧数据缺 lineage 时也有产品级兜底。
- 人工编辑字段页后，主产品文件与产品树能更快看到新值，减少“编辑了但好像没更新”的错觉。

**验证说明**：
- 2026-06-25 已针对 `api-client.ts`、`preview-panel.tsx`、`wiki-page-viewer.tsx` 做缺失文件错误兜底。
- 全项目 `tsc --noEmit` 仍可能被历史类型问题阻塞；本轮需要重点筛查新增文件/改动文件。
- 后端多根目录源码已写入；运行态是否生效取决于 release 二进制是否已重新构建并重启。

---

### [2026-06-26] v2.6 知识更新闭环、产品单文件删除快路径与抽取质量收敛

**当前分支**：`feature/product-catalog-domain`

**背景**：
1. `0626` mock 验证发现：字段冲突处理完成后仍没有在「知识演化」Tab 里可见，管理员很难回看“采用新值/保留旧值”的决策。
2. 删除产品文件夹已有优化，但删除单个产品源文件仍走通用全库关联扫描，`费率表.pdf` 等文件删除速度慢。
3. 产品资料增量上传需要“只清掉该文件独占支撑的字段值”，不能删除其它文件仍支撑的字段。
4. mock 验证暴露抽取噪音：`QA` 被产品基础字段汇总污染；`需核对具体条款`、`仅门诊`、`小额医疗` 等弱值会制造不必要冲突。
5. 基础字段需要增加「产品别称」「QA」，并能在后续抽取/精炼/概念聚合中生效。

**代码变更**：
- `product-catalog-modules.ts`
  - 基础字段新增 `产品别称`、`QA`。
  - 基础模块新增 `QA`，并加入全险种通用基础模块集合。
- `product-catalog-extractor.ts`
  - 新增 `产品别称`、`QA` 抽取关键词、精炼字段和字段提示。
  - `QA` 加入 long field 聚合映射。
  - 增量上传新增弱值过滤：`需核对具体条款`、`以合同约定为准`、纯引用/占位值统一视为空。
  - 增量冲突判断新增“新值比旧值更粗略则忽略”的保护，减少低信息值冲突。
  - `QA` 只接受明确问答/客户异议/话术形态；`## QA`、`Q&A`、`产品问答` 原文块优先直读，避免把字段汇总拼成 QA。
- `product-catalog-sync.ts`
  - 字段页同步选项新增 `skipDerivedRefresh`，支持批量删除时先集中清字段、最后统一刷新 concepts/embeddings。
  - `clearProductFieldValueForDeletedSource()` 支持跳过派生刷新，避免删除一个文件时几十个字段页重复跑 concept 聚合。
- `sources-view.tsx`
  - 产品单文件删除新增快路径：
    1. 删除原始源文件；
    2. 并发清理预处理缓存与 ingest cache；
    3. 扫描该产品相关 `product_catalog` 字段页，根据 `value_sources` 只清掉由该文件独占支撑的字段值；
    4. 清理 `source_text` 中的增量原文页或 OCR 原文内对应 `PRODUCT_SOURCE_BEGIN/END` 块；
    5. 统一刷新 concepts。
  - 若删除后产品文件夹只剩 `product_meta.json` 或系统 manifest，则删除整套产品派生知识和空源目录。
  - 产品文件夹删除继续保留批量快路径：递归删除源目录、批量清缓存、产品级清派生 md、统一跑一次 concept 聚合。
- `review-view.tsx`
  - 「知识审核」只显示待处理的知识冲突/更新，避免已完成卡片继续占用审核队列。
  - 「采用新值」继续走确定性字段/模块回写，并将派生刷新延后到后台。
- `evolution-panel.tsx`
  - 「知识演化」不再只依赖 `knowledge-lineage.json`。
  - 直接读取 `.llm-wiki/review.json` 中 `resolved=true` 的 contradiction/confirm 项，展示已完成的知识冲突与更新。
  - 卡片展示字段名、原知识、新增知识、处理动作、关联页面，并支持打开关联页。

**验证样本：0626 mock**
- `产品别称` 当前为空，上传 mock 后成功补为 `学生门急诊、学门急、学生门诊急诊险`，并写入字段页与主产品页。
- `销售状态=已停售`、`开始使用时间=2026-06-26` 与既有值冲突，系统没有自动覆盖旧值，进入 review。
- 已处理 review 记录实际存在于 `wiki-data/0626/.llm-wiki/review.json`；v2.6 后「知识演化」可直接读取展示。
- 旧 run 已产生的 QA/弱值冲突不会自动删除；后续重新上传/增量抽取会按新过滤规则减少无意义冲突。
- 删除 `费率表.pdf` 后，原始源文件已删除；后续删除同类产品单文件会走快路径，清理只由该文件支撑的字段和 source_text 块。

**验证命令**：
- `npm run typecheck 2>&1 | Select-String -Pattern 'product-catalog-extractor\\.ts|product-catalog-sync\\.ts|sources-view\\.tsx|evolution-panel\\.tsx|review-view\\.tsx'`
- 结果：未发现本轮新增的 extractor/sync/evolution 语法错误；全项目仍有既有 TS 错误，主要是 `review-view.tsx`、`sources-view.tsx` 中旧的 `listDirectory` unknown[] 类型、未使用导入与旧 `@ts-expect-error`。

**运行态**：
- 已重启 Vite 前端服务：`http://127.0.0.1:1420/`
- 浏览器当前项目若不是 `0626`，需要切回 `0626` 才能看到本项目的已完成演化记录。

---

## 分支约定

| 分支 | 用途 |
|---|---|
| `main` | 稳定版本，可部署 |
| `feature/schema-v2-service-category` | 服务层级 v2 + schema 增强（正在合并中） |
| `feature/product-catalog-domain` | 险种产品库新 domain（当前活跃） |

---

*最后更新：2026-06-26*
