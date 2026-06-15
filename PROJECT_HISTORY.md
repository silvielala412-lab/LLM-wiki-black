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
| Q003 | DEDUP_KEY_FIELDS：`product_overview: ["product_code"]`，`rate_table: ["related_product","rate_table_version"]` | ✅ 已确认 | 2026-06-14 |
| Q004 | 险种产品和服务手册重叠时合并还是分页关联？ | ✅ 已确认：wikilink 关联，不合并 | 2026-06-14 |
| Q005 | LLM 推断型字段（如「额度类型」、「核保方式」）标注策略 | ✅ 已确认：标注 `confidence: inferred`，进入 needs_review 队列 | 2026-06-15 |
| Q006 | comparisons / synthesis 层的触发机制何时实现 | ✅ 已确认：Phase 2，先做核心摄入链路 | 2026-06-15 |

---

### [2026-06-15] 产品知识库架构设计讨论（业务方案 vs LLM 自动化方案）

**背景**：业务方提供了《产品知识库字段标签维度-20240205.xlsx》，包含 9 个 sheet：
基础字段 / 医疗险 / 重疾险 / 意外医疗险 / 意外险 / 寿险 / 年金险 / 专业术语目录 / 保险产品知识库示例

**Excel 结构理解（已确认）**：
- `基础字段` sheet = 所有险种公共字段（险种代码、销售状态、交费期、保障期间等）
- 其余 6 个险种 sheet = 该险种在基础字段之外的**专属扩展字段**
- 结构等价于「基类 + 子类扩展」，一个 ProductOverview schema + 险种类型控制必填字段

**当前代码 ProductOverview 缺失的重要字段（已分析）**：

| 字段 | 来源 | 优先级 |
|---|---|---|
| 主附加险 | 基础字段 | 高（产品搭配核心） |
| 销售渠道 | 基础字段 | 高 |
| 犹豫期 / 宽限期 | 基础字段 | 高 |
| 不限社保（医疗险） | 医疗险 | 高 |
| 额度类型（百万/小额） | 医疗险 | 高 |
| 报销比例 / 医院范围 | 医疗险 | 高 |
| 赔付次数（单次/多次） | 重疾险 | 高 |
| 疾病分组 | 重疾险 | 高 |
| 保证利率 / 保单贷款 | 寿险/年金险 | 高 |
| 领取规则 / 领取期间 | 年金险 | 高 |

**架构方案选择**：
- 业务方案：30+ 文件/产品，模板驱动，目录嵌套
- 我的方案：6 文件/产品，模块聚合，平铺命名，带 `_extract_schemas/`
- **用户决定**：先按业务方案来，不行再调整

**关键架构决策（已确认）**：

| 决策点 | 结论 |
|---|---|
| 文件命名规则 | 方案 A：`{险种类别}-{产品名}-{模块名}.md`（和权益命名规则一致） |
| 目录位置 | `wiki/product_catalog/` 平铺存放 |
| 险种类型选择 | 上传时手动选择（医疗险/重疾险/寿险/意外险/年金险） |
| 多文件关联 | 同一产品的多个文件（条款+费率表+问答）通过 product_code 关联 |
| LLM 推断字段 | 标注 `confidence: inferred`，进入 needs_review |
| 维护模式 | LLM 自动化为主，人工审核为辅 |
| comparisons/synthesis | Phase 2 实现，Phase 1 专注摄入链路 |

**命名示例**：
```
wiki/product_catalog/
  医疗险-安心百万医疗险2026版-产品基础信息.md
  医疗险-安心百万医疗险2026版-投保年龄.md
  医疗险-安心百万医疗险2026版-专属健康告知.md
  医疗险-安心百万医疗险2026版-标体承保.md
  医疗险-安心百万医疗险2026版-保障责任.md
  医疗险-安心百万医疗险2026版-年度免赔额.md
  医疗险-安心百万医疗险2026版-通用责任免除.md
  医疗险-安心百万医疗险2026版-理赔报案.md
  医疗险-安心百万医疗险2026版-费率表.md
```

**代码回滚点**：
- Tag: `v0.3-product-catalog-domain`
- Commit: `aa59484`
- 分支: `feature/product-catalog-domain`

---

## 分支约定

| 分支 | 用途 |
|---|---|
| `main` | 稳定版本，可部署 |
| `feature/schema-v2-service-category` | 服务层级 v2 + schema 增强（正在合并中） |
| `feature/product-catalog-domain` | 险种产品库新 domain（当前活跃） |

---

*最后更新：2026-06-15*
