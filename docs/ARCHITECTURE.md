# LLM Wiki — 系统架构与流程图

> 基于 `feature/schema-v2-service-category` 分支（`b6c38cb` 基础）  
> 更新时间：2026-06-09

---

## 一、整体系统架构

```mermaid
graph TB
    subgraph Client["前端 (Tauri + React)"]
        SV["Sources View\n文件导入/管理"]
        WE["Wiki Editor\nMarkdown 编辑器"]
        CP["Chat Panel\n对话界面"]
        AP["Activity Panel\nIngest 进度"]
    end

    subgraph Ingest["Ingest 管道 (TypeScript)"]
        IC["ingest-cache.ts\n内容 Hash 去重"]
        IP["ingest.ts\n主协调器"]
        OCR["pdf-ocr.ts\nOCR / PDF 提取"]
        PP["knowledge-postprocess.ts\n实体规范化"]
        IR["knowledge-identity-resolution.ts\nLLM Identity Pass"]
        GR["knowledge-global-relation.ts\n跨文档关系推断"]
        AQ["extraction-quality-audit.ts\n覆盖率审计"]
    end

    subgraph Storage["存储层"]
        MD["wiki/*.md\n知识页面 (Source of Truth)"]
        LDB["LanceDB\n向量索引 1152维"]
        CACHE[".ingest-cache.json\n入库缓存"]
    end

    subgraph Backend["后端 Rust (8081端口)"]
        RAG["rag.rs\n混合检索引擎"]
        CHAT["chat.rs\n对话流管理"]
        FS["fs.rs\nPDF 4级提取"]
        VEC["vector.rs\n向量读写"]
        BM25["BM25 内存索引\nCJK双字/三字分词"]
        GRAPH["wikilink 图\n1-hop 扩散"]
    end

    subgraph LLM["LLM 服务"]
        LLMP["OpenAI / Claude\n/ Ollama / Custom"]
    end

    User([用户]) -->|上传文件| SV
    User -->|提问| CP
    User -->|编辑 Wiki| WE

    SV --> IC
    IC -->|已缓存 跳过| CACHE
    IC -->|未缓存| IP
    IP --> OCR
    IP --> LLMP
    IP --> PP
    PP --> IR
    IR --> LLMP
    IR --> GR
    GR --> AQ
    IP -->|写入 MD 页面| MD
    IP -->|向量 Upsert| LDB

    CP -->|POST /api/chat/stream| CHAT
    CHAT --> RAG
    RAG -->|向量检索| LDB
    RAG -->|BM25 检索| BM25
    RAG -->|图谱扩展| GRAPH
    GRAPH -->|读取 wikilinks| MD
    BM25 -->|索引来源| MD
    RAG -->|RRF 融合| CHAT
    CHAT -->|组装 Context| LLMP
    LLMP -->|SSE 流式| CP

    FS -->|pdftotext/poppler| IP
    OCR -->|Vision LLM| LLMP
```

---

## 二、Ingest 抽取详细流程

```mermaid
flowchart TD
    START([用户上传文件]) --> HASH{内容 Hash\n命中缓存?}
    HASH -->|已缓存且内容未变| SKIP([跳过 返回缓存路径])
    HASH -->|未缓存 / 内容变更| TYPE{文件类型?}

    TYPE -->|".json"| JSON_PATH["fastIngestJsonSource()\n确定性 JSON 解析\n不调用 LLM"]
    TYPE -->|".pdf"| PDF_PATH["四级 PDF 提取\n①pdf-extract 直接提取\n②pdftotext (≥200字符则用)\n③OCR Vision LLM\n④图片 pages marker"]
    TYPE -->|"图片 .png/.jpg..."| IMG_PATH["ocrImageBytes()\nVision LLM OCR"]
    TYPE -->|"文本 .md/.txt"| TEXT_PATH["直接读取文本"]

    JSON_PATH --> JSON_WRITE["生成确定性 source 页面\n字段表 + 产品元数据"]
    JSON_WRITE --> EMBED_ONLY

    PDF_PATH --> CONTENT["sourceContent = 提取文本"]
    IMG_PATH --> CONTENT
    TEXT_PATH --> CONTENT

    CONTENT --> SIZE{文本长度?}
    SIZE -->|"< 50K 字符"| DIRECT["直接模式\n整体送 LLM"]
    SIZE -->|"> 50K 字符"| HIER["层级分块模式\nchunkMarkdown()\n按语义切 chunk\n每块 10K-22K 字符"]

    DIRECT --> BUILD_CTX["构建 LLM 提示上下文"]
    HIER -->|每块迭代| BUILD_CTX

    BUILD_CTX --> CTX1["Schema 候选清单\nbuildSchemaCandidateManifest()\n最多 80 个候选"]
    BUILD_CTX --> CTX2["文档类型信号检测\nbuildInsuranceExtractionChecklist()\n产品条款/服务手册/案例/话术..."]
    BUILD_CTX --> CTX3["证据层要求\nbuildFactLayerHints()\nOCR/表格行 → 双层结构"]
    BUILD_CTX --> CTX4["服务手册节点指令\nbuildServiceManualNodeDirective()\n28个已知服务权益节点"]

    CTX1 & CTX2 & CTX3 & CTX4 --> STAGE1["LLM Stage 1: 分析\n理解文档类型/重点/结构"]

    STAGE1 --> STAGE2["LLM Stage 2: 生成\n输出 FILE 块格式"]

    STAGE2 --> PARSE["parseFileBlocks()\n解析 ---FILE: path--- 块\n处理 CRLF/截断/fence/路径注入"]

    PARSE --> SAFE{isSafeIngestPath()\n路径安全检查}
    SAFE -->|危险路径| WARN["⚠️ 警告 丢弃此块"]
    SAFE -->|安全路径| WRITE["写入 wiki/*.md"]

    WRITE --> NORM["normalizeEntityBlock()\n实体规范化"]
    NORM --> RESOLVE["resolveIncomingKnowledgePage()\nSource权威性冲突仲裁\nregulatory_doc:100 > product_terms:95"]

    RESOLVE --> OCR_PRESERVE["preserveOcrDetailsInSourcePage()\n追加 原始全文 区块\n最多保留 120K 字符"]

    OCR_PRESERVE --> POST["runKnowledgePostProcess()\nDomainSkillRegistry 分发\nHealthServiceSkill 等"]

    POST --> IDENTITY["runIdentityPass()\nLLM 4阶段身份解析\n① buildIdentityCatalog\n② generateIdentityCandidates\n③ llmJudgeIdentityPairs (15对/次)\n④ applyIdentityJudgments"]

    IDENTITY --> GLOBAL_REL["runGlobalRelationPass()\n跨文档关系推断\n自动生成 has_part / applies_to 等"]

    GLOBAL_REL --> AUDIT["writeExtractionQualityAudit()\n覆盖率分 + 待补全清单\n写入 source 页面"]

    AUDIT --> EMBED_ONLY["embedWrittenIngestPages()\n向量 Upsert 到 LanceDB\n1152维 embedding"]

    EMBED_ONLY --> CACHE_SAVE["saveIngestCache()\ncontent hash 为 key\n保存写入路径"]

    CACHE_SAVE --> DONE([✅ 完成])
```

---

## 三、RAG 检索与对话流程

```mermaid
flowchart TD
    Q([用户提问]) --> REWRITE["多轮上下文\nQuery Rewrite\n补充省略主语"]

    REWRITE --> EXPAND["expand_insurance_query()\n保险术语变体扩展\n'投被保' → 4种写法"]

    EXPAND --> PARALLEL["并行检索"]

    PARALLEL --> VEC_S["向量检索\nLanceDB cosine similarity\ntop_k = 12-15"]
    PARALLEL --> BM25_S["BM25 检索\n内存索引\nCJK 双字/三字分词\nschema_lower 字段加权"]
    PARALLEL --> GRAPH_S["图谱扩展\nwikilink 1-hop\n从高分实体出发"]

    VEC_S & BM25_S & GRAPH_S --> RRF["RRF 融合\nReciprocal Rank Fusion\nquality_multiplier 权重\nactive > superseded > rejected"]

    RRF --> ANCHOR["best_evidence_anchor()\n逐行扫描命中页面\n找最佳证据行\n表格行+8分 投被保关系+120分"]

    ANCHOR --> SCORE["insurance_evidence_score()\n保险字段特异性评分\n投保年龄+80 交费+60 领取+60"]

    SCORE --> EXCERPT["page_excerpt()\n以证据行为中心\n截取 1800 字符上下文"]

    EXCERPT --> CONTEXT["组装 RAG Context\n含引用编号 [1][2]...\n含 source_type 权重标注"]

    CONTEXT --> SYS_PROMPT["系统 Prompt 注入\n知识库角色定义\n引用格式要求\n简称识别提示"]

    SYS_PROMPT --> LLM["LLM 推理\n(OpenAI/Claude/Ollama)"]

    LLM -->|SSE 流式| STREAM["Server-Sent Events\nchat_meta: retrieval_ms\nsources: 引用列表"]

    STREAM --> UI["Chat Panel\nMarkdown 渲染\nWiki 引用 [[页面名]]\n@filename 来源预览"]
```

---

## 四、知识存储与文件结构

```mermaid
graph LR
    subgraph WikiDir["wiki/ 目录结构"]
        ENT["entities/\n在线问诊-盛世优享26.md\n家庭医生服务-盛世优享26.md\n盛世优享26.md\n..."]
        SRC["sources/\n盛世优享26-投保规则.md\n盛世优享26-费率表.md\n..."]
        CON["concepts/\n(待建) 在线问诊.md\n(待建) 居家养老.md"]
    end

    subgraph MDStructure["MD 文件结构"]
        FM["YAML frontmatter\ntitle / type / entity_type\nrelated_product / service_category\nstatus / confidence\naliases / relations"]
        BODY["正文\n原文事实清单\n结构化抽取结果\n覆盖审计 / 待补全信息"]
        FULL["原始全文（自动保留）\n<!-- LLM_WIKI_OCR_DETAIL_START -->\n完整原始文本\n最多 120K 字符"]
        CAND["候选覆盖审计\n<!-- LLM_WIKI_SCHEMA_CANDIDATE_AUDIT_START -->\n必须覆盖候选点 × 状态"]
    end

    ENT & SRC --> FM & BODY
    SRC --> FULL & CAND
```

---

> 图表基于 v1.3（`b6c38cb`）代码实际实现绘制，不含 v2.0 计划功能（ServiceCategory 节点等）。  
> 维护者：Claude (Antigravity)
