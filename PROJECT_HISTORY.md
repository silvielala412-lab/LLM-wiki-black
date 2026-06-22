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
| Q009 | LIFE_INSURANCE / ANNUITY 缺失字段补齐 | 🔲 待完成 | 2026-06-21 |
| Q010 | 意外医疗险是否需要独立字段数组 | 🔲 待决定 | 2026-06-21 |

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

## 分支约定

| 分支 | 用途 |
|---|---|
| `main` | 稳定版本，可部署 |
| `feature/schema-v2-service-category` | 服务层级 v2 + schema 增强（正在合并中） |
| `feature/product-catalog-domain` | 险种产品库新 domain（当前活跃） |

---

*最后更新：2026-06-22*
