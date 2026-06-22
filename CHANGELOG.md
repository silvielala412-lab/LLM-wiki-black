# LLM Wiki — 项目迭代历程

> 记录所有重大版本变更、架构决策和功能里程碑。  
> 维护者：Claude (Antigravity) + Codex  
> 当前分支：`feature/schema-v2-service-category`（从 `b6c38cb` 切出）

---

## 版本快照索引

| 版本标签 | 对应 Commit | 分支 | 说明 |
|---------|-----------|------|------|
| v0.1 初始骨架 | `ad1f808` | main | Tauri v2 + React + TypeScript 脚手架 |
| v0.2 基础UI | `fddba94..76dd97c` | main | 布局/文件树/聊天栏/编辑器 |
| v0.3 核心功能 | `09fd6eb..97975ae` | main | Ingest/Wiki/引用/来源管理 |
| v1.0 Schema架构 | `feature/schema-driven-ingest-compiler` 早期 | feature | Schema Registry + Identity Pass |
| v1.1 Rust后端RAG | `5141f42..ef503bb` | feature | Vector + BM25 + 混合检索 |
| v1.2 后端对话 | `d757f17..2e8d9d4` | feature | /api/chat/stream SSE 流式对话 |
| **v1.3 当前稳定** | **`b6c38cb`** | **feature** | **PDF强化 + JSON确定性 + RAG证据优先** |
| v2.0 开发中 | `feature/schema-v2-service-category` | **新分支** | ServiceCategory节点 + 知识治理完善 |

---

## v0.1 — 项目初始化（2026年初）

**Commits**: `ad1f808` → `7939b2a`

### 技术栈确定
- Tauri v2 + React + TypeScript（桌面应用框架）
- Tailwind CSS v4 + shadcn/ui（UI组件库）
- Zustand（状态管理）
- Rust 后端命令层（文件系统 + 项目管理）

### 建立的能力
- 项目创建与切换
- 文件树组件
- Icon Sidebar
- 共享 WikiProject / FileNode 类型定义

---

## v0.2 — 基础 UI 与编辑器（2026年初-中期）

**Commits**: `fddba94` → `76dd97c`

### 功能
- 可拖动 Resize 面板（三栏布局：文件树 | 内容区 | 聊天栏）
- Milkdown WYSIWYG Markdown 编辑器（含自动保存）
- 欢迎页 + 项目入口
- 原生文件夹选择器
- LLM 设置页面（多 Provider 支持）

---

## v0.3 — 核心业务功能（2026年中期）

**Commits**: `09fd6eb` → `97975ae`

### 重大功能落地

#### Ingest 管道
- LLM 驱动的 Wiki 页面生成（两步 Chain-of-Thought：先分析，再生成）
- 自动入库：文件导入后触发 ingest
- Ingest 进度迁移至 Activity 面板

#### Chat 对话
- 流式 LLM 客户端（支持所有 Provider）
- 聊天 Store（消息状态 + 流式更新）
- Markdown 渲染 + Wiki 引用 `[[页面名]]`
- 引用验证：防止幻觉 wikilink（验证页面是否真实存在）

#### 来源管理
- Sources 视图（文件导入、预览）
- 多格式文件预览（PDF / 图片 / 文本）
- 来源删除 + 级联 Wiki 页面清理
- 引用锚点：`@filename` 格式点击预览

#### 人工审核
- Review 系统（异步 Human-in-the-loop 确认机制）
- LLM 设置持久化（跨重启保留）

---

## v1.0 — Schema 驱动架构（`feature/schema-driven-ingest-compiler` 早期）

**重大架构升级，建立知识工程基础设施**

### 核心组件
- **`insurance-schema-registry.ts`**：保险领域 Schema 注册表
  - 7 个 domain：product / customer / method / content / activity / cases / compliance
  - 30+ 实体类型，每种含字段规范（critical / high_confidence / recommended / auto_derived）
  - DEDUP_KEY 系统：防止跨产品权益实体被错误合并
  - SOURCE_TYPE_WEIGHTS：条款(95) > 说明书(85) > 宣传材料(70) > 经验(40)

- **`knowledge-domain-skill.ts`**：DomainSkill 插件接口
  - 可插拔的领域技能系统
  - 支持多领域（健康服务 / 寿险 / 医疗险）独立扩展

- **`knowledge-identity-resolution.ts`**：LLM Identity Pass（4阶段去重）
  - Phase 1：buildIdentityCatalog — 全量读取 canonical dedup_key
  - Phase 2：generateIdentityCandidates — 规则N-reduction（R1-R4）
  - Phase 3：llmJudgeIdentityPairs — LLM 批量判决（15对/次）
  - Phase 4：applyIdentityJudgments — 写关系边 + merge_suggestion

- **`canonicalServiceIdentityName()`**：服务名称规范化
  - 品牌后缀剥离（"音视频问诊_臻享家医" → "音视频问诊"）
  - 判别词保护（"康复门诊" ≠ "康复住院"，防止错误合并）
  - 同义词白名单映射

- **Authority-weighted 冲突解决**（`knowledge-resolution.ts`）：
  - Source 权威性权重驱动字段冲突仲裁

### 架构决策（不可推翻）
1. Relations 存储格式保持 YAML 字符串（Obsidian 兼容）
2. DomainSkill 是扩展单元，不是 Sub-agent
3. `expandGraphFromEntity()` 是 Agent/RAG 的规范 API
4. 每个新实体类型必须先在 schema registry 有 spec

---

## v1.1 — Rust 后端 RAG（`5141f42` → `ef503bb`）

**性能关键升级：前端检索 → 后端 Rust 引擎**

### 背景
前端文件扫描（TypeScript 扫 md 文件）在 wiki > 100 个文件时明显卡顿。

### 技术实现
- **`server-rs/`**：Rust Axum HTTP 服务，监听 8081 端口
- **向量检索**：LanceDB（1152维 embedding）
- **BM25 Token 检索**：内存索引，CJK 双字/三字分词
- **`/api/rag/retrieve`** 端点：向量 + BM25 基础混合检索
- **前端向量协议 v2**：前端继续负责 embedding 写入，后端负责检索

---

## v1.2 — 混合检索 + 后端对话（`ef503bb` → `2e8d9d4`）

**检索质量与对话架构全面升级**

### 后端检索升级（`rag.rs`）
- **RRF 融合**（Reciprocal Rank Fusion）：向量 + BM25 + 图谱扩展三路融合
- **Graph Expansion**：基于 wiki wikilinks 建图，1-hop 扩散
- **quality_multiplier**：active/superseded/rejected 页面差异化权重
- **`schema_lower` BM25 字段**：frontmatter 字段值加入检索索引

### 后端对话（`/api/chat/stream`）
- SSE 流式输出（Server-Sent Events）
- Multi-turn 对话 + Query Rewrite（省略主语自动补全）
- 系统 prompt 与前端完全对齐
- 前端强制 `isLargeProject = true`：所有项目走后端检索

### 前端变更（`chat-panel.tsx`）
- 废弃前端文件扫描路径（代码保留但不再执行）
- SSE 流式接收 + chat_meta（retrieval_ms、sources 列表）

---

## v1.3 — 当前稳定版（`b6c38cb`）

**4个 Commits，管道健壮性全面提升**

### Commit `3e94168`：RAG 证据行优先
- `expand_insurance_query()`：检索前自动扩展保险术语变体
  ```
  "投保人和被保险人" → ["投、被保险人关系", "投被保险人关系", ...]
  ```
- `best_evidence_anchor()`：命中页面后按行扫描，找最佳证据行
- `insurance_evidence_score()`：表格行+8分，投被保关系行+120分
- **解决了**：简称检索失效、答案在表格里但 chunk 没命中 的两个问题

### Commit `d512915`：JSON 确定性入库
- JSON 文件走 `fastIngestJsonSource()` 快速路径，**不再送给 LLM**
- 直接解析字段生成确定性 source 页面（字段表 + 产品元数据）
- **解决了**：LLM 对结构化 JSON 数据的幻觉问题

### Commit `80c7eb7`：启动脚本修复
- `start-8081.ps1` 指向正确的 enhanced server 二进制

### Commit `b6c38cb`：PDF Ingest 管道强化
- PDF 提取新增四级梯度：
  ```
  直接提取 → pdftotext(≥200字符) → OCR → 图片pages marker
  ```
- Ingest 缓存从 filename key 改为 **content hash key**
  - 文件名改了但内容没变 → 跳过重新入库（正确）
  - 内容改了但文件名没变 → 触发重新入库（正确）
- ingest-queue.ts 并发控制优化

### 我方贡献（同期）
- `ingest.ts`：所有入库文件（含纯文字 PDF）都保留原始全文到 source 页面
  - 移除了只保留 OCR 来源和表格型来源的限制
  - Section 标签：`原始OCR明细` → `原始全文`

---

## v2.0 — 开发中（`feature/schema-v2-service-category`）

**当前开发分支，从 `b6c38cb` 切出**

### 计划改进

#### 高优先级
- [ ] **ServiceCategory 节点**：新增实体类型，作为"产品→类目→服务"图谱中间层
  - 解决三维约束查询（产品 + 类目 + 服务）的可靠性问题
  - 当前用 `service_category` 字段（自由文本）导致词汇不一致，靠字段值匹配不稳定
- [ ] **`product_alias` 提升为 `critical`**：确保产品简称被 ingest 时强制抽取
- [ ] **通用 `aliases` 字段**：ServicePlan 等 canonical entity 也需要 aliases

#### 中优先级
- [ ] **Claim-level provenance**：每条 claim 记录 `source_doc`，支持精确撤回证据
- [ ] **删除策略改为软删除**：删源文件 → 标记 claims 为 needs_review，不级联删实体
- [ ] **ServiceBenefit 产品作用域明确**：命名规范 `在线问诊-盛世优享26.md`，防止跨产品实体混用

#### 架构升级
- [ ] **Cases 域字段改回中文**：与 product / customer 域语言一致
- [ ] **lintRules 机制化**：ingest 时实际拦截，不只是文档注释

---

## 知识治理设计决策记录

> 详见 `schema_design_analysis.md`（存于 .gemini/antigravity/brain/）

| 决策 | 结论 | 原因 |
|------|------|------|
| 层级命名（居家养老-在线问诊）vs 图谱关系 | 选图谱关系 | 类目改名不影响实体名；跨类目服务可共享节点 |
| 实体文件粒度 | 在线问诊-盛世优享26.md（产品作用域） | RAG chunk 精确；更新隔离清晰；匹配 DEDUP_KEY 设计 |
| 删源文件后知识处理 | 软删除（撤回 claims，不删实体） | 产品实体生命周期应由业务决策，不由文件删除驱动 |
| 简称/alias 字段位置 | 只加在 canonical entity 页面（不是所有 md） | 避免污染检索；source 页面不需要 alias |
| 是否需要独立 Product Identity Catalog | 不需要 | entity 页本身就是目录；维护两份数据反而增加不一致风险 |

---

## v2.1 — 险种产品知识库（Product Catalog Pipeline）
**分支**：`feature/product-catalog-domain`  
**Commits**：`74ddd07` → `637adcc`  
**时间**：2026-06-14 ~ 2026-06-15  
**目标**：从无到有构建险种产品文档的自动化摄入与管理体系，支持上传 → 分批提取 → 模块化存储 → 前端浏览全链路

---

### 新增文件

| 文件 | 作用 |
|------|------|
| `src/lib/product-catalog-modules.ts` | 险种模块定义注册表（6险种 × 20-30模块） |

---

### 核心架构：方案A（险种-产品-模块 三段命名）

```
wiki/product_catalog/{险种类别}-{产品名}-{模块名}.md
示例：wiki/product_catalog/医疗险-安心百万医疗险2026版-保障责任.md
```

**为什么不用嵌套目录**：平铺 + Scheme A 名称使 RAG 能直接从文件名获得完整上下文（险种 + 产品 + 模块），无需读取 frontmatter。

---

### product-catalog-modules.ts 设计

```
PRODUCT_CATALOG_MODULES: Record<InsuranceCategoryType, ProductModule[]>
  医疗险: [...BASE_MODULES, ...MEDICAL_MODULES]   // ~40 个模块
  重疾险: [...BASE_MODULES, ...CI_MODULES]         // ~35 个模块
  意外险 / 寿险 / 年金险 / 意外医疗险: 同上

BASE_MODULES (所有险种共有):
  产品基础信息, 投保年龄, 专属健康告知, 疾病等待期, 犹豫期,
  通用责任免除, 理赔报案, 分年龄保费费率表, ...

inferModulesFromSourceFileName(fileName, category):
  条款.pdf  → 条款相关模块清单
  费率表.xlsx → [分年龄保费费率表]
  核保.pdf   → 核保相关模块清单
  →  用于驱动模块批次划分

getModuleBatchesForFile(fileName, category, batchSize=2):
  将 inferModulesFromSourceFileName 结果按 batchSize 切分
  →  用于 handleProductUpload 多任务排队

encodeProductCatalogFolderContext(category, product, modules[], idx):
  → "product_catalog > 医疗险 > XX > batch:0:产品基础信息,投保年龄"
```

---

### ingest.ts 关键改动

#### 1. parseProductCatalogCtxFromFolderContext（扩展）
```typescript
// 原格式（向下兼容）: "product_catalog > 医疗险 > 产品名"
// 新格式: "product_catalog > 医疗险 > 产品名 > batch:0:模块1,模块2"
返回: { category, productName, batchIndex?, batchModules? }
```

#### 2. buildProductCatalogGenerationOverride（新增，System Prompt 级别拦截）
- 注入位置：`buildGenerationPrompt` 的 **最前面**，覆盖 "You are a wiki maintainer" 角色
- 批次模式：只列出本批次的 2 个模块，明确禁止生成其他模块
- 路径规则：
  - ✅ ALLOWED: `wiki/product_catalog/{scheme A path}`
  - ✅ ALLOWED: `wiki/sources/…` (仅 batch 0)
  - ❌ FORBIDDEN: `wiki/entities/` / `wiki/concepts/`
  - ❌ FORBIDDEN: 为「交费方式」「等待期」等字段值创建独立实体页

#### 3. extractSchemaDrivenCandidates 跳过（关键 Bug Fix）
```typescript
// product_catalog 文档跳过候选实体扫描
// 原因：该扫描会把「等待期」「交费方式」等字段值作为独立候选
// 结果：LLM 据此在 wiki/entities/ 生成大量无效实体页
const schemaCandidates = productCtxForIngest ? [] : extractSchemaDrivenCandidates(...)
```

#### 4. 模块批次策略（核心性能/质量决策）

**问题**：一次 LLM call 要求生成 30+ 文件 → 文件名混乱、内容不完整、路径偏移。

**方案**：每个文件 → N 个队列任务（每任务 2 个模块）：
```
产品条款.pdf → inferModulesFromSourceFileName → 6个模块
  任务0: batch:0:产品基础信息,投保年龄
  任务1: batch:1:疾病等待期,犹豫期
  任务2: batch:2:通用责任免除,一般住院医疗
```
每个 LLM call 只生成 2 个文件 → 精准、完整、命名正确。

---

### knowledge-tree.tsx 改动（产品库 Tab）

```
知识面板 Tab:
  类型  |  服务线  |  产品库   ← 新增第三个 tab
```

产品库视图结构：
```
险种类别（医疗险 · 2产品 · 12页）        [ShieldCheck 蓝色图标]
  └─ 安心百万医疗险2026版  [5模块 绿色]  [FolderOpen 琥珀色]
      ├─ 医疗险-安心百万医疗险2026版-产品基础信息
      ├─ 医疗险-安心百万医疗险2026版-保障责任
      └─ ...（每个模块可点击预览）
```

新增 `parseProductCatalogTitle(filename)` 解析 Scheme A 文件名 → `{ category, product, module }`，用于前端分组展示。

模块数量色彩：绿色(≥5) / 蓝色(≥2) / 灰色(< 2)，直观反映知识完整度。

---

### sources-view.tsx 改动（Product Catalog Upload Panel）

- Shield 图标按钮 → 打开产品库上传面板
- 险种类别选择（6 险种 tabs）
- 产品名输入框 + 文件上传
- **排队状态展示**：「已排队 N 个模块批次任务（M 文件 × 分批）」

---

### knowledge-schema-normalizer.ts 改动

```typescript
// 新增路径识别
if (path.includes("/wiki/product_catalog/")) return "product"
```

---

### 待测试项

- [ ] 上传一个「产品条款.pdf」到 医疗险 > [产品名]
  - 验证：队列显示 N 个批次任务
  - 验证：生成的文件路径以 `wiki/product_catalog/医疗险-产品名-` 开头
  - 验证：无 `wiki/entities/` 输出
  - 验证：每批文件数量 ≤ 2
- [ ] 验证产品库 Tab 能正确展示抽取结果（按险种→产品→模块分组）
- [ ] 上传费率表 XLSX → 验证只触发费率相关模块的批次任务

---

### 已知限制 / 后续优化

- 批次之间独立调用：同一文档被读取多次（性能可优化：先缓存 OCR 结果）
- `inferModulesFromSourceFileName` 基于文件名关键词，对自定义文件名可能误推断
  → 后续可在上传面板让用户手动选「文档类型」
- wiki/overview.md 每个批次都会更新（冗余）
  → 后续可只在最后一个批次触发 overview 更新

---

---

## v2.2 — Section-Scan 抽取架构 + 知识缺口分析（2026-06-15 ~ 2026-06-21）

**分支**：`feature/product-catalog-domain`  
**Commits**：`b9a61eb` → `b225d73`（26 个提交）  
**维护者**：Claude (Antigravity) + Codex  
**目标**：将产品知识库从"LLM 生成整个文件"改为"OCR 全文切分 → 按组扫描 → 字段级合并"的高保真管线

---

### 架构重大变更：Section-Scan-Merge Pipeline

**问题**：v2.1 让 LLM 一次性生成 2 个模块文件，但 LLM 经常：
- 丢失原文关键数据（险种代码、简称等）
- 表格结构被摘要化
- 原文不完整（只有片段不是全文）

**新架构（`product-catalog-extractor.ts` 重写）**：
```
PDF → OCR 全文 → splitIntoSections(25000字/块, 500字重叠)
  → 每组5-8个模块并发送 LLM（group-round）
  → parseModuleBlocks 解析响应
  → mergeFragmentContents 字段级合并（best-value）
  → 服务端注入 100% 原文到 "## 详细条款原文"
  → Phase 5: refineSingleModule 精炼未明确字段
```

**关键设计决策**：
| 决策 | 结论 | 原因 |
|------|------|------|
| LLM 输出格式 | 只输出关键字段表格，禁止摘抄原文 | 原文由代码注入，避免 LLM 篡改/遗漏 |
| 原文注入方式 | 每个 section 的完整文本注入到对应模块 | 确保 100% 数据保真 |
| 字段合并策略 | best-value merge：取第一个非"未明确"值 | 跨 section 同一模块的字段互补 |
| 并发模型 | 8 并发 LLM 调用 | 速度 vs 成本平衡 |

---

### 核心提交详解

#### Concept 聚合系统 (`concept-aggregator.ts`)
**Commits**: `b9a61eb`, `716d579`

- `scanProductConcepts()`：扫描 `wiki/product_catalog/` 下所有模块文件，从 frontmatter 提取 `module_name`
- `buildProductConceptIndex()`：为每个 module_name 生成 `wiki/concepts/{模块名}.md` 聚合页
- 每个 concept 页列出所有包含该模块的产品（跨产品关联表）
- **触发时机**：`ingest-queue.ts` 的 `onQueueDrained`（所有文件处理完后自动触发）

#### Group-Round 分组抽取
**Commits**: `209dca3`, `c8f4075`

- 按 `ModuleGroup` 分组：`basic_info` → `exclusion_uw` → `coverage` → `cost_rules` → `contract_admin` → `claim_service` → `disease_definition`
- 每组 5-8 个模块并发送给 LLM，相比 v2.1 每次 2 个模块，LLM 调用次数减少 70%
- `MAX_SECTION_PARALLEL` 控制 section 级并发

#### Phase 5: 模块精炼
**Commits**: `a0c01e3`, `d2f5e60`, `94be1ee`, `ebdcac4`, `f631377`

- `refineSingleModule()`：对每个模块文件的原文做聚焦 LLM 调用，补充"未明确"字段
- 并发 10，每次只发 ≤8000 字原文 + 字段列表
- `refineAllProductModules()`：独立入口，UI 按钮触发（不需要重新上传 PDF）
- **Bug Fix**：`streamChat` 使用 callback 而非 AsyncIterable（`ebdcac4`，CRITICAL）

#### DeepSeek v4 模型迁移
**Commits**: `2017b42`, `5f3c2fc`

- `llm-presets.ts` 更新 DeepSeek preset：`deepseek-chat` → `deepseek-v4-pro`
- `wiki-store.ts` 添加自动迁移：加载配置时检测旧模型名并替换

#### 源文件路径自动检测
**Commit**: `85de3e8`

- `ingest.ts` 新增路径匹配：`产品/{category}/{productName}/xx.pdf` → 自动生成 `folderContext`
- 解决手动放文件到 `raw/sources/产品/` 目录时不走产品管线的问题

#### 原文注入防截断
**Commit**: `b225d73`

- Prompt 改为"只输出表格，禁止摘抄原文"
- `parseModuleBlocks` 自动注入 `sectionText` 作为 `## 详细条款原文`
- 防御性清理：LLM 不听话输出原文时自动剥离

---

### Codex 改动（2026-06-21，未提交）

**改动文件**：`product-catalog-extractor.ts`

| 改动 | 说明 |
|------|------|
| `EMPTY_FIELD_VALUE = ""`  | "未明确" → 空值，对齐 Excel 规范 |
| `shouldReplaceFieldValue()` | 智能值替换判断（informationScore 评分） |
| `FIELD_EXTRACTION_HINTS` | 模块级字段抽取提示（解决"只取第 1 条"问题） |
| `FIELD_NAME_ALIASES` | 字段名别名映射（LLM 输出名 ↔ 模板名） |
| Prompt 规则 5-7 | 取值来源不跳过、枚举完整、核心值简洁 |
| 主文件 "已有知识/知识缺口" 清单 | 可视化字段和模块完整度 |
| Refine regex `[^|]*` | 允许覆盖已有值（需观察效果） |

---

### Excel 字段对齐（2026-06-21）

**参考文件**：《产品知识库字段标签维度-20240205.xlsx》

`product-catalog-modules.ts` 新增字段：

| 位置 | 新增字段 |
|------|---------|
| BASE_FIELDS (+11) | 开始/结束使用时间、发布外网、可覆盖风险、产品搭配规则、费用、产品档次、保单件数、退保率、理赔件数/金额 |
| CRITICAL_ILLNESS (+2) | 高危职业、核保方式 |
| ACCIDENT (+1) | 高危职业 |
| LIFE_INSURANCE (+3) | 高危职业、起投金额、契调限制（待完成） |
| ANNUITY (+5) | 高流动性、教育金、领钱时间早、投保门槛低、契调限制（待完成） |

---

### 已知问题 / 后续优化

- [ ] `shouldReplaceFieldValue` 的 `informationScore` 权重需实际验证
- [ ] Refine 阶段新 regex 可能覆盖已正确的值（高风险）
- [ ] LIFE_INSURANCE_FIELDS / ANNUITY_FIELDS 缺失字段待补齐
- [ ] 意外医疗险需要独立字段数组（当前复用 MEDICAL_FIELDS）
- [ ] `onQueueDrained` 在中途中断后不会触发 concept aggregator

---

*最后更新：2026-06-21*  
*维护者：Claude (Antigravity) + Codex*
