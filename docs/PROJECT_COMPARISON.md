# 五项目知识图谱系统横向对比分析

> **目的**: 梳理 nashsu/llm_wiki（我们的基础）与四个参考项目的差异，指导后续开发方向。
> **更新**: 2026-05-27

---

## 项目定位速览

| 项目 | Stars | 定位 | 技术栈 | 运行方式 |
|------|-------|------|--------|---------|
| **nashsu/llm_wiki** | ⭐9.5k | 跨平台桌面知识库应用（我们的基础） | TypeScript + Tauri + Rust | 桌面 App |
| **我们的系统** | — | 保险领域专业知识图谱 + RAG底座 | TypeScript + Vite + Server | Web服务 |
| **SamurAIGPT/llm-wiki-agent** | — | 通用 Agent Skill（纯 Markdown） | Markdown + Claude/Codex | Agent Skill |
| **AgriciDaniel/claude-obsidian** | — | Claude Code 插件 + Obsidian | Markdown + MCP | Claude 插件 |
| **sdyckjq-lab/llm-wiki-skill** | — | 多平台中文友好 Skill | Markdown + Shell | Agent Skill |

---

## 一、与 nashsu/llm_wiki（原始基础）的关系

### 我们继承了什么

| 功能模块 | nashsu 原版 | 我们的实现 | 状态 |
|---------|-----------|-----------|------|
| 三层架构（源文件→Wiki→Schema） | ✅ | ✅ | 继承 |
| Two-Step CoT Ingest | ✅ | ✅ + 分批三压缩 | 增强 |
| 知识图谱（4信号相关性模型） | ✅ sigma.js | ✅ 自研 relation-index | 并行开发 |
| Louvain 社区检测 | ✅ | ❌ 未实现 | 待补 |
| 向量搜索（LanceDB） | ✅ 可选 | ❌ 待规划 | 待规划 |
| cascade delete（级联删除） | ✅ | ❌ 部分（wiki-page-delete.ts） | 部分继承 |
| Deep Research | ✅ | ✅ deep-research.ts | 继承 |
| YAML frontmatter | ✅ | ✅ 增强（强类型schema） | 增强 |
| Local HTTP API | ✅ 19828端口 | ✅ backend Rust后端 | 增强 |
| Agent Skill | ✅ llm_wiki_skill | ❌ 未暴露 | 待做 |

### 我们超越了什么（保险领域专化）

| 我们独有的能力 | nashsu 原版有无 |
|--------------|---------------|
| **强类型 Schema Registry**（service_plan/service_benefit 等 entity types） | ❌ |
| **DomainSkill 插件系统**（跨险种扩展） | ❌ |
| **Insurance-specific 关系评分**（confidence × strength） | ❌ |
| **Intent-aware 图遍历**（expandGraphFromEntity + queryAffinity） | 部分（4信号） |
| **超长文档分批三压缩抽取**（处理完整保险手册） | 单步/两步，受 context 限制 |
| **ExtractionQualityAudit**（量化审计评分） | ❌ |
| **service_team→service_provider alias 修正** | ❌（无领域 alias） |
| **postprocess materializer**（字段归一 + 关系补全） | ❌ |

### nashsu 有但我们还没完整做的

| 功能 | nashsu | 我们现状 | 优先级 |
|------|--------|---------|--------|
| Louvain 社区检测 | ✅ graphology | ❌ | P1（横向关联的关键） |
| 向量语义搜索（LanceDB） | ✅ 可选 | ❌ | P2 |
| WIKI_STATE 自动更新（overview.md） | ✅ 每次 ingest 后自动重生成 | ❌ | P0 |
| 源文件删除级联清理 | ✅ 完整 | ⚠️ 部分 | P1 |
| Agent Skill 暴露（19828 HTTP API） | ✅ | ⚠️ 有 backend 但未完整对接 | P0 |
| purpose.md（业务方向文件） | ✅ | ⚠️ AGENTS.md 部分替代 | P1 |
| 置信度标注（EXTRACTED/INFERRED） | ❌（nashsu 也没做） | ❌ | P0 |

---

## 二、五项目能力全矩阵

### 抽取层

| 能力 | nashsu | 我们 | SamurAIGPT | claude-obsidian | llm-wiki-skill |
|------|--------|------|------------|-----------------|----------------|
| Two-step CoT | ✅ | ✅ | ❌ | ❌ | ✅ |
| 分批处理超长文档 | ❌ | ✅ | ❌ | ❌ | ❌ |
| Schema 字段约束 | ❌ | ✅ | ❌ | ❌ | ❌ |
| Field alias 映射 | ❌ | ✅ | ❌ | ❌ | ❌ |
| Ingest 即时校验 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 多格式（PDF/DOCX） | ✅ | ⚠️ PDF-OCR | ✅ markitdown | ❌ | ✅ markitdown |
| 图片多模态 | ✅ vision LLM | ✅ image-caption | ❌ | ❌ | ❌ |

### 关系层

| 能力 | nashsu | 我们 | SamurAIGPT | claude-obsidian | llm-wiki-skill |
|------|--------|------|------------|-----------------|----------------|
| 确定性关系（wikilink解析） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 关系评分模型 | ✅ 4信号 | ✅ confidence×strength | ❌ | ❌ | ❌ |
| 置信度分级 | ❌ | ❌ | ❌ | ❌ | ✅ 4级 |
| 语义INFERRED边 | ❌ | ❌ | ✅ | ❌ | ❌ |
| 横向兄弟关联 | 间接（Louvain） | ❌ | ✅（Louvain） | ❌ | ❌ |
| Intent-aware 图遍历 | ❌ | ✅ | ❌ | ❌ | ❌ |

### 冲突与更新层

| 能力 | nashsu | 我们 | SamurAIGPT | claude-obsidian | llm-wiki-skill |
|------|--------|------|------------|-----------------|----------------|
| 冲突检测 | Step1分析时LLM标注 | audit knowledge_gaps | ingest时标注 | `[!contradiction]` | AI层检查 |
| 冲突解决 | ❌（标注不解决） | ❌ | ❌ | ❌ | ❌ |
| 字段级合并 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 版本追踪 | sources[]字段 | dedup_key | ❌ | ❌ | SHA256 cache |
| 级联删除 | ✅ 完整 | ⚠️ 部分 | ❌ | ❌ | ✅ |

### RAG/Agent 对接层

| 能力 | nashsu | 我们 | SamurAIGPT | claude-obsidian | llm-wiki-skill |
|------|--------|------|------------|-----------------|----------------|
| HTTP API | ✅ 19828 JSON | ✅ backend | ❌ | ❌ | ❌ |
| Agent Skill | ✅ llm_wiki_skill | ❌ 未暴露 | ✅ 即是Skill | ✅ Claude Code插件 | ✅ 即是Skill |
| MCP integration | ❌ | ❌ | ❌ | ✅ | ❌ |
| Vector search | ✅ LanceDB可选 | ❌ | ❌ | ❌ | ❌ |
| 图检索API | ✅（nashsu的graph API） | ✅ expandGraphFromEntity | ❌ | ❌ | ❌ |
| Context budget | ✅ 4K-1M | ✅ context-budget.ts | ❌ | ❌ | ❌ |

---

## 三、关键问题答案（结合原始项目）

### 1. 知识冲突
**全部五个项目的结论一样：只检测，不解决。**
nashsu 在 Two-step Step1 时 LLM 会输出"Contradictions & tensions with existing knowledge"，但这只是 Review 队列里的人工任务，不会自动合并。我们的 `knowledge_gaps` 类似。

真正的冲突解决需要 claim-level provenance（每个字段值知道来自哪个源文件）——五个项目都没有做到。

### 2. RAG/Agent 对接
nashsu 是五个项目中 RAG 对接最完整的：
- 本地 HTTP API（19828端口）：hybrid search + file read + graph traversal + source rescan
- 独立 Agent Skill（llm_wiki_skill）：让 Claude Code/Codex 调用这个API

我们有 backend 后端，但 `expandGraphFromEntity()` 没有通过 HTTP 暴露出去。nashsu 已经解决了这个问题，我们可以直接参考其 API 设计。

### 3. 知识更新融合
nashsu 的 `sources[]` 字段跟踪每个 wiki 页面来自哪些源文件，是最完整的溯源实现。cascade delete 也基于此实现。这是我们应该对齐的。

### 4. 抽取质量
- nashsu 的 Two-step CoT 是所有项目里最系统的抽取框架
- 我们的分批三压缩是超长文档处理上的独有优势，nashsu 没有
- llm-wiki-skill 的 ingest 即时校验是两者都缺的

---

## 四、后续开发优先级（基于完整对比）

### P0（最高，对标 nashsu 已有功能）

1. **WIKI_STATE.md 自动生成**（对标 nashsu overview.md 自动更新）
   - 每次 postprocess 后写运营状态快照
   - 解决 Claude↔Codex 会话间上下文断裂

2. **HTTP API 完整暴露**（对标 nashsu 19828 API）
   - 把 `expandGraphFromEntity()` 暴露为 JSON endpoint
   - 补充 hybrid search endpoint（tokenized + graph）
   - 这是真正的 RAG/Agent 对接的基础

3. **四级置信度标注 EXTRACTED/INFERRED/AMBIGUOUS/UNVERIFIED**
   - 扩展 KnowledgeRelation.source
   - 横向关联（在线问诊↔就医陪诊）立刻可以用 INFERRED 放进图谱

### P1（次高，nashsu 有的我们要补）

4. **Louvain 社区检测**（对标 nashsu graphology-communities-louvain）
   - 替代硬编码的服务分组
   - knowledge-relation-index.ts 构建的图结构可以直接加这一步

5. **sources[] 字段 + cascade delete 完整化**（对标 nashsu 级联删除）
   - 每个 wiki 页面的 YAML frontmatter 记录 `sources: []`
   - 删除源文件时自动清理关联页面、断链

6. **service_category 字段填充率提升**（内部问题，非对标）
   - Codex 端 ingest 提示词改进
   - 这是所有横向关联的前提

### P2（中期）

7. **向量语义搜索**（对标 nashsu LanceDB 可选层）
   - 用任何 OpenAI 兼容 endpoint 做 embedding
   - 与 graph expansion 合并为 hybrid search

8. **Agent Skill 发布**（对标 nashsu llm_wiki_skill）
   - 基于 HTTP API 写一个 AGENTS.md skill
   - 让 Claude Code/Codex 一键安装

9. **purpose.md 业务方向文件**（对标 nashsu purpose.md）
   - 补充现有 AGENTS.md，专注业务目标而非技术指令

### P3（长期）

10. **MCP Server**（对标 claude-obsidian，超过 nashsu）
11. **Parallel Ingest Agent**（多险种同时处理时）
12. **Claim-level provenance + 冲突仲裁**（超过所有现有项目）

---

## 五、我们的核心差异化（所有项目都没做到的）

1. **保险领域强类型 Schema** — InsuranceEntitySchemaSpec，字段有 importance 级别
2. **DomainSkill 插件架构** — 跨险种扩展不改公共代码
3. **Intent-aware 图遍历** — queryAffinity 让 Agent 按业务问题走不同关系路径
4. **超长文档分批三压缩** — 完整保险手册不截断，其他项目都受 context window 限制
5. **ExtractionQualityAudit** — 量化评分 + knowledge_gaps 报告

这五点是我们的护城河，不要因为借鉴其他项目而削弱它们。

---

## 六、与腾讯 WeKnora 深度对比（2026-06-22 新增）

> **WeKnora**: ⭐16.9k | 腾讯开源 | Go + Vue + PostgreSQL | Docker 部署
> **GitHub**: https://github.com/Tencent/WeKnora

### 定位差异

| 维度 | WeKnora | 我们 |
|------|---------|------|
| **定位** | 通用企业知识平台 | 保险领域专用知识图谱 |
| **抽取哲学** | "切块→向量→检索时再理解" | "上传时就精确提取每个字段" |
| **产出物** | 概述性 Wiki 页面 + 向量 chunks | 结构化字段表（字段=值）+ 模块文件 |
| **技术栈** | Go + Vue + PostgreSQL + Neo4j | TypeScript + Vite + Rust |

### 知识抽取对比（核心环节）

| 抽取能力 | WeKnora | 我们 | 谁更优 |
|---------|---------|------|-------|
| 文档格式覆盖 | 10+ 格式 | PDF only (4级 OCR) | 🏆 WeKnora |
| Schema 约束 | ❌ 无 | ✅ 47字段×6险种 | 🏆 我们 |
| 模块化抽取 | ❌ 通用 Agent | ✅ 30+ 专业模块 | 🏆 我们 |
| 多轮精炼 | ❌ 一次性 | ✅ N 次精炼 | 🏆 我们 |
| 占位符清洗 | ❌ | ✅ 30+ regex 模式 | 🏆 我们 |
| 跨模块桥接 | ❌ | ✅ MODULE_TO_FIELD_BRIDGE | 🏆 我们 |
| 向量 Embedding | ✅ HNSW + 多 provider | ⚠️ 基础 | 🏆 WeKnora |
| 知识图谱基础设施 | ✅ Neo4j | ✅ relation-index | 🏆 WeKnora |
| 可观测性 | ✅ Langfuse | ⚠️ log only | 🏆 WeKnora |

**结论：在保险领域知识抽取环节，我们的 schema-driven + module-based 方案明确更优。但在检索引擎和企业级基础设施方面，WeKnora 更成熟。**

### WeKnora 值得借鉴的能力

| 能力 | WeKnora 实现 | 借鉴优先级 |
|------|-------------|-----------|
| Langfuse 全链路 trace | 解析→分块→向量→推理的 span tree | **P0** |
| Hybrid Search | BM25 + Vector + GraphRAG | **P0** |
| MCP Server | 标准化 Agent 工具协议 | P1 |
| IM 对接 | 企微/飞书/Slack | P2 |
| 自适应分块 | chunk_size 可配 + preview | P2 |
| 多租户 RBAC | 4级角色矩阵 | P3 |

### 推荐策略

**不替换，要互补。** 知识抽取用我们的管线（Schema-Driven），检索和可观测性借鉴 WeKnora。

---

*文档维护：Claude（Antigravity）*
*最后对比时间：2026-06-22*
