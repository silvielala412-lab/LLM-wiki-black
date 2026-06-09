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

*最后更新：2026-06-09*  
*维护者：Claude (Antigravity) + Codex*
