"""
LLM Wiki API — Python 请求示例 v3
服务器：http://8.148.158.241:8081
项目路径：/llm-wiki-7777/wiki-data/rag

新版能力（Codex ef503bb）：
  /api/rag/retrieve  ★ 已升级为 hybrid 检索（vector + BM25 + RRF 融合）
  /api/chat/stream   ★ 对话框等效 API（multi-turn + query rewrite + hybrid + LLM）
  /api/rag/status    索引健康检查
"""

import sys, json, requests

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BASE_URL     = "http://8.148.158.241:8081"
PROJECT_PATH = "/llm-wiki-7777/wiki-data/rag"


# ─── 1. 对话框等效 API ★（多轮 + query rewrite + hybrid 检索 + LLM）────────────

def chat_stream(messages: list[dict], top_k: int = 8) -> tuple[str, dict]:
    """
    调 /api/chat/stream，返回 (answer, meta)
    meta 包含：retrieval_query（实际检索词）、retrieval_ms、sources（引用来源列表）

    messages 格式：
    [
        {"role": "user",      "content": "平安智盈倍护A01的核保规则"},
        {"role": "assistant", "content": "..."},
        {"role": "user",      "content": "起保点是多少"},  ← 省略问题自动补全
    ]
    """
    resp = requests.post(
        f"{BASE_URL}/api/chat/stream",
        json={"project_path": PROJECT_PATH, "messages": messages,
              "top_k": top_k, "stream": True},
        timeout=90, stream=True,
    )
    resp.raise_for_status()

    meta, tokens = {}, []
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        payload = raw[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except Exception:
            continue

        if data.get("type") == "chat_meta":
            meta = data
            print(f"\n[Chat] 检索耗时 {data.get('retrieval_ms', 0)}ms")
            print(f"[Chat] 实际检索词: {data.get('retrieval_query', '')}")
            for s in data.get("sources", []):
                print(f"  [{s['number']}] {s['title']}  score={s['score']:.3f}")
            print()
            continue

        token = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
        if token:
            tokens.append(token)
            print(token, end="", flush=True)

    print()
    return "".join(tokens), meta


# ─── 2. Hybrid 检索（vector + BM25 + RRF，不调 LLM）────────────────────────────

def rag_retrieve(query: str, top_k: int = 8, use_token: bool = True) -> dict:
    """
    调 /api/rag/retrieve，返回 hybrid 融合后的 chunks。
    每个 chunk 的 source 字段说明来源：
      "vector"  - 只被向量搜索命中
      "token"   - 只被 BM25 命中（精确词）
      "hybrid"  - 两者都命中（最可信）
    """
    resp = requests.post(
        f"{BASE_URL}/api/rag/retrieve",
        json={"project_path": PROJECT_PATH, "query": query,
              "top_k": top_k, "use_token": use_token},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def show_chunks(result: dict, max_text: int = 120):
    """格式化打印 chunks"""
    chunks = result.get("chunks", [])
    ms     = result.get("retrieval_ms", 0)
    print(f"  耗时 {ms}ms，命中 {len(chunks)} 个 chunks")
    for i, c in enumerate(chunks, 1):
        print(f"  [{i}] [{c['source']:6s}] score={c['score']:.3f}  {c['page_title']}")
        if c.get("heading_path"):
            print(f"       heading: {c['heading_path']}")
        print(f"       {c['chunk_text'][:max_text]}...")
    print()


# ─── 工具接口 ──────────────────────────────────────────────────────────────────

def get_config():
    return requests.get(f"{BASE_URL}/api/config", timeout=10).json()

def get_rag_status():
    return requests.get(f"{BASE_URL}/api/rag/status",
        params={"project_path": PROJECT_PATH}, timeout=10).json()


# ─── 运行验证 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":

    # 0. 状态检查
    print("=" * 60)
    cfg    = get_config()
    status = get_rag_status()
    print(f"LLM   : {cfg['llm']['model']}")
    print(f"Embed : {cfg['embedding']['model']}")
    print(f"索引  : dim={status['dim']}，共 {status['chunk_count']} chunks，"
          f"needs_reindex={status['needs_reindex']}")
    print()

    # ─────────────────────────────────────────────────────────────────────────
    # 测试 1：精确词检索（险种代码）
    # 验证 BM25 是否能命中精确产品代码，这是纯 vector 做不好的
    # ─────────────────────────────────────────────────────────────────────────
    print("=" * 60)
    print("【测试 1】精确词检索 — 盛世优享26的险种代码")
    q = "盛世优享26的险种代码是多少"
    r = rag_retrieve(q, top_k=5)
    show_chunks(r)
    # 关注：有没有 source=token 或 hybrid 的结果（有说明 BM25 生效）

    # ─────────────────────────────────────────────────────────────────────────
    # 测试 2：语义模糊检索
    # vector 擅长，BM25 不一定命中，两路互补
    # ─────────────────────────────────────────────────────────────────────────
    print("=" * 60)
    print("【测试 2】语义检索 — 退休后每月能领多少钱")
    r2 = rag_retrieve("退休后每年能领多少养老金", top_k=5)
    show_chunks(r2)

    # ─────────────────────────────────────────────────────────────────────────
    # 测试 3：多轮对话 + 省略问题（核心验证）
    # 先问核保规则，再问"起保点"
    # 后端 query rewrite 应补全产品名再检索
    # ─────────────────────────────────────────────────────────────────────────
    print("=" * 60)
    print("【测试 3】多轮对话 + 省略问题")

    q1 = "平安智盈倍护（2026）终身护理保险A01的核保规则是什么"
    print(f"\n轮次 1：{q1}")
    a1, _ = chat_stream([{"role": "user", "content": q1}], top_k=8)

    q2 = "起保点是多少"
    print(f"\n轮次 2（省略问题）：{q2}")
    a2, meta2 = chat_stream([
        {"role": "user",      "content": q1},
        {"role": "assistant", "content": a1},
        {"role": "user",      "content": q2},
    ], top_k=8)
    print(f"\n[诊断] 后端实际检索词：{meta2.get('retrieval_query', 'N/A')}")
    print("（若补全正确，应包含'智盈倍护'或'A01'，不只是'起保点是多少'）")

    # ─────────────────────────────────────────────────────────────────────────
    # 测试 4：source 字段分布（查看 hybrid 效果）
    # ─────────────────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("【测试 4】各来源分布 — 查看 vector/token/hybrid 比例")
    r4 = rag_retrieve("家庭医生权益次数限制", top_k=10)
    ms   = r4.get("retrieval_ms", 0)
    src_count = {}
    for c in r4.get("chunks", []):
        src_count[c["source"]] = src_count.get(c["source"], 0) + 1
    print(f"  耗时 {ms}ms，来源分布：", src_count)
    print("  （hybrid 占比越高，说明两路检索互相印证，结果越可信）")
