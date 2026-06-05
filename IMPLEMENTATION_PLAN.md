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

---

## Codex Review Notes（给 Claude 实施前参考）

> Codex 更新：2026-06-04。整体同意本计划，但建议把 Step 1 从“动态维度修复”提升为“向量索引协议修复 + 可恢复迁移”。下面是实施时需要额外锁住的细节。

### 1. 不要静默兼容旧 384 表，必须显式判定并要求重建

LanceDB 的 `FixedSizeList` 维度和列结构是表 schema 的一部分。代码改成动态维度以后，已有 `chunks` 表不会自动从 384 变 1152，也不会自动拥有 `page_title/chunk_index/heading_path` 等新列。

实施建议：
- 打开现有表后先读取 schema：校验 `vector` 维度、必需列、字段类型。
- 如发现旧 schema，返回明确错误，例如 `409 index_schema_mismatch`，响应体包含 `expected_dim / actual_dim / missing_columns / reset_required: true`。
- `drop_legacy` 当前实际是在 drop `chunks` 表，建议改名或新增 `POST /api/vector/reset-index`，同时删除 `vector-meta.json`，避免语义误导。
- 禁止继续对旧表 `add()` 新 batch；否则会出现新旧协议混存，后续排查非常困难。

### 2. `score = 1 - distance` 只有在 metric 明确为 cosine 时才成立

LanceDB 返回的 `_distance` 语义取决于向量索引/查询 metric。计划里直接 `1.0 - distance` 有风险。

实施建议：
- 创建/查询向量索引时明确使用 cosine metric；如果当前 lancedb API 不方便设置 metric，就不要承诺 `score` 是相似度。
- 返回字段至少保留 `distance`、`rank`、`score_kind`。
- 如果确认是 cosine distance，`score = clamp(1 - distance, 0, 1)`；否则先用 rank/RRF 排序，不把 distance 伪装成 0-1 置信度。

### 3. 元数据必须记录模型，而模型信息不能只靠 Rust 推断

当前 embedding 可能来自前端设置，也可能来自服务端环境变量。Rust `vector/upsert-chunks` 只收到 vectors，不一定知道这些 vectors 是哪个模型产生的。

实施建议：
- `UpsertBody` 增加 `embedding_model`、`embedding_endpoint` 可选字段，至少记录 `embedding_model` 和 `dim`。
- `vector-meta.json` 建议包含：
  ```json
  {
    "schema_version": 2,
    "dim": 1152,
    "embedding_model": "tongyi-embedding-vision-plus-2026-03-06",
    "embedding_endpoint_fingerprint": "...",
    "metric": "cosine",
    "created_at": "...",
    "updated_at": "..."
  }
  ```
- 查询时如果 query vector 维度或模型与 meta 不一致，返回明确错误，不要 truncate/pad。

### 4. 前后端协议变更要避免部署瞬间破坏旧页面

Step 1 和 Step 2 是破坏性 API 变更。如果后端先上线、浏览器还缓存旧前端，旧请求仍会发送 `{ chunks: string[], vectors: number[][] }`。

实施建议二选一：
- 最稳：新增 `/vector/upsert-chunks-v2` 和 `/vector/search-chunks-v2`，旧端点暂时保留；ChatPanel/embedding.ts 切 v2。
- 或者：同一个端点同时接受 v1/v2 请求体。v1 只作为兼容入口，写入时可以生成 `chunk_index`，`heading_path=""`，但应在响应/日志里提示 deprecated。

### 5. `/api/rag/retrieve` 的 fallback 不应默认回到前端全量扫描

计划中 Step 4 写了 `/api/rag/retrieve` 非 200 时 fallback 回 `searchWiki()`。这对小项目可接受，但对 `rag` 这种 65MB 项目会把几分钟卡顿重新带回来。

实施建议：
- 默认 fallback 应该是后端轻量 token fallback，而不是前端 `searchWiki()`。
- 如果必须临时 fallback 到前端，至少加项目大小阈值：wiki 总字节数或 md 文件数超过阈值时不走前端全量扫描，直接提示“后端检索不可用/索引需要重建”。
- `retrieve` 响应需要带 `timings`：`embed_ms / vector_ms / token_ms / graph_ms / total_ms`，后续排查速度才有抓手。

### 6. 后端检索接口必须做路径边界校验

`project_path` 来自前端请求，后端读 LanceDB、wiki 文件或未来 SQLite 时要避免任意路径访问。

实施建议：
- 将 `project_path` normalize 后校验必须位于 `WIKI_DATA_PATH` 下，或来自已打开/已登记 project 列表。
- 所有新接口都复用同一套 project path guard，不在各 handler 里重复拼字符串。

### 7. Step 3 第一版不要只做向量检索

向量索引损坏、未重建、embedding 临时关闭时，纯 vector retrieve 会无结果。迁后端的核心目标是“不要让浏览器扫 65MB”，因此第一版也应该有后端 token fallback。

实施建议：
- Phase 1 最小可用：`vector topK + server-side token fallback + RRF by rank`。
- server-side token fallback 可以先扫描 wiki，但扫描发生在服务器并加缓存/manifest；不要再让浏览器逐文件 `readFile`。
- graph 扩展可以 Phase 2，但 `retrieve` 响应结构先预留 `related` 或 `sources` 字段。

### 8. KnowledgeTree 可以独立提前修

`KnowledgeTree` 的实体/七大域显示问题和 RAG 后端迁移解耦，改动小、风险低。

建议作为单独小提交先做：
- `/wiki/entities/` 路径优先归入 Entities。
- `domain` 同时兼容 `knowledge_domain` 和 `domain`。
- 七大域固定显示 7 个桶，空桶显示 0。

### 9. 验证清单

最低验证建议：
- Rust：`cargo check`，最好加 vector handler 单测覆盖维度不一致、旧 schema、返回 `_distance` 解析。
- 前端：`tsc --noEmit` 或现有 `npm run build`。
- 数据：reset `rag` 的旧 `chunks` 表后重新 embed，确认 chunk count、meta dim=1152。
- 接口：`/api/vector/search-chunks` 返回完整字段；`/api/rag/retrieve` 在 embedding 可用/不可用两种状态下都不会触发浏览器全量扫文件。
- 服务：7777 当前运行态之前曾临时关闭 embedding。重建索引前要用 `start-7777.ps1` 恢复百炼配置，确认 `/api/config` 中 embedding endpoint/model/key 均存在。

---

## Codex Deployment Gate（5141f42 后补充）

> Codex 更新：2026-06-04。已拉取并检查 Claude 提交 `5141f42 feat: vector protocol v2 + /api/rag/retrieve endpoint + port 8081 dev script`。结论：这版完成了后端方向的一部分，但还没有形成“用户可验证对话框提速”的闭环。

### 当前不建议直接部署给用户验证对话框速度

原因：
- `server-rs` 已新增 `/api/rag/retrieve`，但前端 `src/components/chat/chat-panel.tsx` 仍在调用 `searchWiki(pp, text)` 和 `buildRetrievalGraph(pp, dataVersion)`。
- 也就是说，浏览器对话框提问仍会走旧链路：前端全量扫 `wiki/*.md` + 冷启动构建 retrieval graph。
- 因此即使启动 8081，用户在 `rag` 项目对话框里提问，大概率仍会慢；这不能验证 `/api/rag/retrieve` 的效果。
- 8081 当前只适合做后端接口 smoke test，不适合交给用户验证“rag 对话框搜索和回答速度是否变快”。

### 什么时候可以部署 8081 给用户验证

满足以下条件后再部署：
1. `ChatPanel` 已优先调用 `/api/rag/retrieve`。
2. `/api/rag/retrieve` 成功时，不再执行 `searchWiki()` 和 `buildRetrievalGraph()`。
3. `/api/rag/retrieve` 失败时，大项目不能 fallback 到前端全量扫描；应提示索引/检索不可用，或走后端轻量 token fallback。
4. 前端能把 `chunks/sources/timings` 转成现有 prompt context 和 source chips。
5. `rag` 项目旧 384 维 LanceDB 表已 reset，并用百炼 1152 维重新 embed。
6. 8081 的 `/api/config` 显示 embedding endpoint/model/key 均已配置。

### Claude 下一步建议

优先补齐前端接线，而不是继续扩后端功能：
- 新增 `src/lib/rag-client.ts` 或在 `src/commands/api-client.ts` 增加 `retrieveRagContext()`。
- 在 `chat-panel.tsx` 中替换问答主链路的 retrieval 阶段：
  - 调 `/api/rag/retrieve`
  - 用返回 chunks 组装 context
  - 填充 `queryRefs`
  - 记录并展示/打印 `retrieval_ms` 和分项 timings
- 保留 `searchWiki()` 给顶部搜索页或小项目 fallback，但不要在 `rag` 这类大项目默认走它。
- `buildRetrievalGraph()` 暂时只保留给图谱视图或后端 graph phase，不要再放在每次对话提问主链路。

### 只有一种情况现在可以部署

如果目标只是验证“后端接口能否启动、`/api/rag/retrieve` 能否返回 chunks”，可以启动 8081 做接口测试。但要对用户说明：
- 这不是最终体验验证。
- 对话框速度不会因为只启动 8081 自动变快。
- 需要用 curl/HTTP 请求直接打 `/api/rag/retrieve`，而不是在前端对话框里测试。

### 构建环境备注

本机依赖并非完全缺失，但默认 shell 环境未必带齐 PATH：
- `protoc.exe` 可用位置：`C:\tools\protoc-25.3-win64\bin\protoc.exe` 或 `C:\llm-wiki\.runtime\protoc\bin\protoc.exe`
- `perl.exe` 可用位置：`C:\Program Files\Git\usr\bin\perl.exe` 或 `C:\llm-wiki\.runtime\strawberry-perl\perl\bin\perl.exe`

若 `cargo check/build` 报 `protoc` 或 `perl` 找不到，不代表代码一定错；应先用带好 PATH/PROTOC 的构建脚本或 shell。建议把 8081 构建/启动脚本也显式设置这些路径，避免不同终端环境行为不一致。

---

## Codex Review（2026-06-05）：搜索 API 当前状态与 Claude 执行清单

> 当前分支：`feature/schema-driven-ingest-compiler`
> 当前远端业务分支最新提交：`02f2490 fix: align frontend vector upsert protocol`
> 结论：`/api/rag/retrieve` 已经接入前端对话框主链路，但还不能说与旧前端搜索能力完全等效。

### 1. 当前搜索 API 是否已经有了？

已经有。

- 后端路由：`POST /api/rag/retrieve`
- 前端调用位置：`src/components/chat/chat-panel.tsx`
- 当前流程：
  1. 前端对话框发送问题。
  2. ChatPanel 优先调用 `/api/rag/retrieve`。
  3. 后端调用 embedding endpoint 生成 query vector。
  4. 后端用 LanceDB 搜索 chunks。
  5. 前端用返回的 chunks 组装 prompt context。
  6. 再调用 `/api/llm/stream` 生成回答。

这条链路已经避免了每次问题都在浏览器里全量扫描 `wiki/*.md`。

### 2. 是否已经和旧前端对话框搜索完全等效？

还没有。当前只能算“速度主链路已迁移”，不是“能力完全等效”。

旧前端 `searchWiki()` + `buildRetrievalGraph()` 里有 5 层能力：

- token/BM25-like 关键词检索
- frontmatter schema 字段参与检索
- governance / confidence 加权
- vector 语义检索
- graph relevance 扩展

当前 `/api/rag/retrieve` 后端 Phase 1 只有：

- query embedding
- LanceDB vector search
- 返回 top chunks

因此当前 API 与旧前端搜索相比：

| 能力 | 旧前端搜索 | 当前 `/api/rag/retrieve` |
|---|---:|---:|
| 向量语义检索 | 有 | 有 |
| chunk 级返回 | 有 | 有 |
| score / distance | 有 | 有 |
| token/BM25-like | 有 | 没有 |
| schema/governance 加权 | 有 | 没有 |
| graph 扩展 | 有 | 没有 |
| 浏览器全量扫文件 | 有，慢 | 主链路没有 |

所以回答用户时要避免说“完全等效”。准确表述是：

> 对话框已经有后端搜索 API，当前能覆盖快速语义检索主链路；但要达到旧前端搜索的完整召回能力，还需要把 token 检索、治理加权、图谱扩展迁入后端。

### 3. 当前仍存在的问题

#### P0：fallback 仍可能回到前端全量扫描

`chat-panel.tsx` 当前逻辑是：

```ts
try /api/rag/retrieve
if success and chunks.length > 0:
  use backend chunks
else:
  searchWiki(pp, text)
  buildRetrievalGraph(pp, dataVersion)
```

问题：

- 如果向量索引为空、embedding 失败、LanceDB schema mismatch、后端返回空 chunks，就会退回旧前端链路。
- 对 `rag` 这种大项目，这会重新出现分钟级卡顿。

Claude 执行建议：

- 大项目禁止默认 fallback 到前端全量扫描。
- 增加项目规模判断，例如 md 文件数或 wiki 总字节数超过阈值时：
  - 不调用 `searchWiki()`
  - 返回明确提示：后端索引不可用，请重建索引
  - 或调用后端 token fallback

#### P1：`/api/rag/retrieve` 只有 vector，没有 token/BM25

问题：

- 对精确词、产品名、条款编号、服务入口等问题，纯 vector 可能不如 token 检索稳定。
- 旧前端的 tokenRank 和 vectorRank RRF 融合还没迁移。

Claude 执行建议：

- 在后端新增 token retrieval：
  - 第一版可用 server-side markdown scan + 缓存
  - 稳定版改 SQLite FTS5
- 在 `/api/rag/retrieve` 内做 RRF：
  - vector rank
  - token rank
  - 后续 graph rank
- 响应 chunks 增加：
  - `source: "vector" | "token" | "hybrid" | "graph"`
  - `rank`
  - `scores: { vector?, token?, rrf? }`

#### P1：graph relevance 还没有服务化

问题：

- 旧前端会在 fallback 模式下调用 `buildRetrievalGraph()`，冷启动要读全量 wiki。
- 当前后端 RAG 没有图谱扩展，相关页面召回能力下降。

Claude 执行建议：

- 不要把 graph build 放回对话框前端主链路。
- 后端新增 graph index/cache：
  - 启动或首次请求时构建
  - 按 `dataVersion` 或文件 mtime 失效
  - 返回 related chunks/pages
- `/api/rag/retrieve` 增加 `use_graph` 参数并真正生效。

#### P1：缺少索引状态 API

问题：

- 用户不知道当前项目是否已经 re-index。
- 也不知道当前 LanceDB 是不是 1152 维、模型是否匹配、chunk count 是否为 0。

Claude 执行建议：

新增或增强：

```http
GET /api/rag/status?project_path=...
```

返回：

```json
{
  "indexed": true,
  "chunk_count": 713,
  "dim": 1152,
  "embedding_model": "...",
  "schema_version": 2,
  "needs_reindex": false,
  "reason": null
}
```

ChatPanel 在 `/api/rag/retrieve` 返回空时应读取 status，并给用户明确错误，而不是静默 fallback。

#### P1：后端 RAG 需要 timings

问题：

当前只返回 `retrieval_ms`。排查慢问题时不够。

Claude 执行建议：

`/api/rag/retrieve` 返回：

```json
{
  "timings": {
    "embed_ms": 180,
    "vector_ms": 40,
    "token_ms": 15,
    "graph_ms": 0,
    "total_ms": 240
  }
}
```

前端 console 打印：

```ts
console.log("[RAG]", ragData.timings)
```

#### P2：把 `handlers/rag.rs` 拆成 retrieval 模块

当前功能集中在 `server-rs/src/handlers/rag.rs`。短期可用，但后续加 token、RRF、graph 后会变大。

Claude 执行建议：

拆成：

```text
server-rs/src/retrieval/
  mod.rs
  vector.rs
  token.rs
  rrf.rs
  graph.rs
```

`handlers/rag.rs` 只保留 HTTP request/response。

### 4. Claude 推荐执行顺序

#### Step A：先修 fallback 策略

目标：保证大项目不会再回到前端全量扫描。

验收：

- 手动让 `/api/rag/retrieve` 返回空或 500。
- `rag` 项目对话框不能再卡到分钟级。
- 前端应提示“后端检索不可用/索引需要重建”，或走后端 token fallback。

#### Step B：实现后端 token fallback

目标：即使 vector index 不可用，也不让浏览器扫文件。

第一版可以简单：

- 后端扫描 wiki markdown
- 用内存缓存 `project_path + mtime/version`
- 返回 token top chunks

稳定版：

- SQLite FTS5
- ingest/re-index 时同步写入

#### Step C：实现 vector + token RRF

目标：让 `/api/rag/retrieve` 质量接近旧前端 `searchWiki()`。

验收：

- 精确产品名、服务名、条款词能稳定命中。
- 泛语义问题仍能靠 vector 命中。
- response 中能看出 chunk 来自 vector/token/hybrid。

#### Step D：实现 graph 后端扩展

目标：迁移旧前端 graph relevance 能力。

验收：

- `buildRetrievalGraph()` 不再出现在 ChatPanel 问答主链路。
- `/api/rag/retrieve` 可以返回直接命中 chunk + related chunks/pages。

#### Step E：补 `/api/rag/status`

目标：把“索引缺失、维度不一致、需要 re-index”变成可见状态。

验收：

- Settings 和 ChatPanel 都能读到 index status。
- 用户不再看到无意义的空回答或长时间等待。

### 5. 当前 Codex 本机备注

Codex 在 8081 上已经验证：

- `/api/rag/retrieve` 对 `rag` 项目通常 200-300ms 返回 chunks。
- 8081 完整 RAG + LLM 流式测试可在数秒内返回。
- KnowledgeTree 的 Entities/七大域显示问题已在 Codex 本机源码修过并部署到 `dist-8081`，但该源码修复尚未提交到 GitHub，Claude 从 GitHub 拉代码时默认看不到这三处本地改动。

这三处本地改动涉及：

- `src/components/layout/knowledge-tree.tsx`
- `src/components/chat/chat-panel.tsx`
- `src/components/chat/chat-message.tsx`

如果 Claude 继续开发，建议先从 GitHub 最新分支拉取，再根据本节内容决定是否由 Claude 复现/合并这些前端修复。
