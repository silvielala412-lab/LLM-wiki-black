# LLM Wiki — RAG 后端迁移 + 向量协议修复

> **维护者**：Claude (Antigravity) + Codex
> **分支**：`feature/schema-driven-ingest-compiler`
> **最新提交**：`2f8f2fe` (Codex: preserve structured relation edge metadata)
> **最后更新**：2026-06-04

---

## 背景：当前搜索架构（5层，在浏览器端运行）

当前 `searchWiki()` + chat-panel 组合是一个 5 层检索架构，**质量合理但速度是瓶颈**：

```
chat-panel.tsx 问答流程
  │
  ├─ [Layer 1] Token Search（BM25-like）          ← I/O 瓶颈，每次扫全量 wiki/*.md
  │    listDirectory(wiki/) + 逐文件 readFile + 关键词匹配
  │    输出：tokenRank（按 TF-IDF 近似得分排序）
  │
  ├─ [Layer 2] Schema Field 检索                  ← 隐含在 token search 里
  │    frontmatter attributes 里的 entity_type / knowledge_domain / relations
  │    parseGovernanceSearchMeta：知识状态 / 质量置信度 / 治理权重
  │    governanceScoreMultiplier 加权最终 RRF 分数
  │
  ├─ [Layer 3] Vector 语义检索                    ← 已走后端，但维度截断问题
  │    fetchEmbedding(query) → 百炼 API（~160-350ms）
  │    vectorSearchChunks → LanceDB topK
  │    输出：vectorRank（按 cosine 相似度排序）
  │
  ├─ [Layer 4] RRF 融合                           ← 纯算法，快
  │    score = 1/(K + token_rank) + 1/(K + vector_rank)
  │         × governanceScoreMultiplier
  │    输出：fused SearchResult[]
  │
  └─ [Layer 5] 图谱扩展（graph-relevance.ts）     ← 独立在 chat-panel，又一次全量扫文件
       buildRetrievalGraph()：全量读 wiki/*.md + 解析 frontmatter + 构建关系图
       getRelatedNodes(nodeId, graph, depth=3)：1-hop 扩展，relevance ≥ 2.0 阈值
       输出：graphExpansions（相关但未被 token/vector 命中的页面）
       注意：有内存缓存（dataVersion 版本控制），冷启动仍慢
```

**慢的根因**：Layer 1（token search）和 Layer 5（graph build 冷启动）都需要全量 `readFile` 所有 wiki 文件。rag 项目 65MB、1473 chunks，文件越多越慢，是架构性 I/O 瓶颈。

---

## 已知问题

### P0：向量维度硬编码 384，百炼实际返回 1152

`server-rs/src/handlers/vector.rs:30,85`：

```rust
DataType::FixedSizeList(..., 384),  // schema 写死 384
padded.resize(dim as usize, 0.0);   // 1152 维向量被截断/填零
```

→ 768 个语义维度丢失，语义检索质量严重受损。

### P0：search_chunks 前后端协议不对齐

前端期望（`embedding.ts:257`）：
```typescript
interface ChunkSearchResult {
  chunk_id: string      // Rust 没存
  page_id: string       // Rust 存的是 page_path
  chunk_index: number   // Rust 没存
  chunk_text: string    // ✓
  heading_path: string  // Rust 没存
  score: number         // Rust 没返回
}
```
Rust 实际返回：`{ page_path, chunk_text }` — 协议严重不完整。

### P1：Token Search + Graph Build 在浏览器全量扫文件

- Token search 每次问答扫全部 wiki/*.md
- `buildRetrievalGraph()` 冷启动读全量 md 建图（有缓存，首次慢）
- 用户文件越多，问答越慢，是架构必然结果

---

## 实施计划

### Step 1：修 vector.rs — 动态维度 + 完整协议 + 元数据

**文件**：`server-rs/src/handlers/vector.rs`

#### 1a. LanceDB schema 改动态维度 + 完整字段
```rust
fn schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_path",    DataType::Utf8, false),
        Field::new("page_title",   DataType::Utf8, false),
        Field::new("chunk_index",  DataType::Int32, false),
        Field::new("heading_path", DataType::Utf8, false),
        Field::new("chunk_text",   DataType::Utf8, false),
        Field::new("vector", DataType::FixedSizeList(
            Arc::new(Field::new("item", DataType::Float32, true)), dim
        ), true),
    ]))
}
```

#### 1b. UpsertBody 改结构化 chunks
```rust
#[derive(Deserialize)]
pub struct ChunkInput {
    pub chunk_index: i32,
    pub heading_path: String,
    pub chunk_text: String,
    pub vector: Vec<f32>,
}

#[derive(Deserialize)]
pub struct UpsertBody {
    pub project_path: String,
    pub page_path: String,
    pub page_title: String,
    pub chunks: Vec<ChunkInput>,
}
```

#### 1c. 维度校验（同批必须一致，禁止 resize）
```rust
let dim = body.chunks.first()
    .map(|c| c.vector.len() as i32)
    .ok_or_else(|| AppError::bad_request("empty chunks"))?;
for (i, chunk) in body.chunks.iter().enumerate() {
    if chunk.vector.len() as i32 != dim {
        return Err(AppError::bad_request(format!(
            "chunk[{}] dim={} != batch dim={}", i, chunk.vector.len(), dim
        )));
    }
}
```

#### 1d. 维度元数据记录（`.llm-wiki/vector-meta.json`）
```json
{ "dim": 1152, "model": "tongyi-embedding-vision-plus-2026-03-06", "indexed_at": "..." }
```
新建表前读取此文件：如已有表 dim 与新 dim 不一致 → 返回错误，提示先 drop_legacy。

#### 1e. search_chunks 返回完整字段 + score
```rust
results.push(json!({
    "page_path":    page_path.value(i),
    "page_title":   page_title.value(i),
    "chunk_index":  chunk_idx.value(i),
    "heading_path": heading.value(i),
    "chunk_text":   text.value(i),
    "distance":     dist.value(i),          // LanceDB 自动附加 _distance
    "score":        1.0_f64 - dist.value(i) as f64,
}));
```

**完成后操作**：
1. `cargo build --release -p llm-wiki-server`
2. 调 `POST /api/vector/drop-legacy` 删旧表（384 维坏数据）
3. Settings → Embedding → Re-index All（重新 embed rag 项目）

---

### Step 2：对齐前端 embedding.ts upsert 调用

**文件**：`src/lib/embedding.ts`、`src/commands/fs.ts`

`vectorUpsertChunks()` 改传结构体（含 `chunkIndex / headingPath / chunkText / vector`），`apiVectorUpsert` 类型签名对应更新。

---

### Step 3：新增 `/api/rag/retrieve` — 模块化后端检索端点

> **设计原则**：Rust 后端只做通用检索引擎，不感知保险领域业务知识。
> 业务语义通过请求参数传入，不 hardcode。

**目录结构**：
```
server-rs/src/
  handlers/
    rag.rs             ← 薄层 HTTP handler，参数解析 + 调 retrieval 层
  retrieval/           ← NEW: 检索核心逻辑（无业务耦合）
    mod.rs
    vector.rs          ← 封装 LanceDB 检索
    token.rs           ← 封装 BM25/FTS（Phase 2）
    rrf.rs             ← RRF 融合算法（纯算法）
    graph.rs           ← 图谱扩展（Phase 2）
```

**Phase 1 接口**：
```
POST /api/rag/retrieve
请求：{ project_path, query, top_k?, context_budget_tokens? }
响应：{
  "chunks": [{
    page_path, page_title, chunk_index, heading_path,
    chunk_text, score, distance, source
  }],
  "retrieval_ms": 145
}
```

**Phase 2 扩展参数**：`use_token`, `use_graph`, `entity_type_filter`, `governance_min_score`

**修改**：`server-rs/src/main.rs` 添加 `.route("/rag/retrieve", post(handlers::rag::retrieve))`

---

### Step 4：ChatPanel 改调 `/api/rag/retrieve`

**文件**：`src/components/chat/chat-panel.tsx`

```typescript
const ragResp = await fetch('/api/rag/retrieve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ project_path: pp, query: text, top_k: 8 }),
})
const { chunks, retrieval_ms } = await ragResp.json()
// chunks 转为 context 传 LLM
```

- `buildRetrievalGraph()` 从问答主链路移除（保留用于图谱可视化）
- 降级策略：`/api/rag/retrieve` 非 200 时 fallback 回 `searchWiki()`

---

### Step 5：修 KnowledgeTree 显示问题（前端）

1. `/wiki/entities/` 路径下文件强制归 Entities 桶，不被 frontmatter `type: rule/process` 覆盖
2. domain 字段同时兼容 `knowledge_domain` 和 `domain`
3. 七大域固定显示 7 个桶，空桶显示 0 而非隐藏

---

## 开发节奏

```
Step 1 (Rust vector.rs) + Step 2 (TS embedding.ts) — 可并行
  ↓
  Rust rebuild → drop old LanceDB → re-embed rag
  ↓
Step 3: /api/rag/retrieve
  ↓
Step 4: ChatPanel 切换（验证 rag 问答从分钟级 → 秒级）
  ↓
Step 5: KnowledgeTree UI
```

---

## 后续迭代路线

| 阶段 | 内容 | 触发条件 |
|------|------|----------|
| Phase 2 | SQLite FTS5 BM25 + 图谱扩展加入 `/api/rag/retrieve` | Step 4 稳定后 |
| Phase 3 | 索引增量更新（ingest 后自动刷新） | 项目 > 500 实体 |
| Phase 4 | 多路并行检索 + retrieval 耗时面板 | 用户反馈 |
| Phase 5 | Sub-agent 接入（Extraction/Validation/RelationAgent） | 实体 > 2000 |

---

## 预期效果

| 指标 | 修复前 | 修复后（Step 1-4） |
|------|--------|-------------------|
| 向量维度 | ❌ 1152→384 截断 | ✅ 完整 1152 维 |
| search_chunks 字段 | ❌ 2 字段，无 score | ✅ 7 字段含 score/heading |
| rag 问答延迟 | 几分钟（扫 65MB markdown） | 1~3 秒（向量检索 topK） |
| 浏览器 I/O | 全量扫 wiki/*.md | 只发 1 个 HTTP 请求 |
| 向量协议 | ❌ 前后端不对齐 | ✅ 统一结构化 chunk |
| API 模块化 | ❌ 检索逻辑在前端，耦合业务 | ✅ Rust 通用检索层，零业务耦合 |
