"""
LLM Wiki API — 接口参考文档
服务器：http://8.148.158.241:8081
项目路径：/llm-wiki-7777/wiki-data/rag

依赖安装：pip install requests

接口一览：
  chat_ask()      ★ 问答接口（推荐）：发问题 → 返回完整答案文本 + 来源列表
  chat_stream()     同上，但实时流式打印（适合人工测试）
  rag_retrieve()    仅检索：返回相关 chunks，不生成答案
  get_status()      检查索引状态

使用建议（批量跑几百个问题）：
  直接调 chat_ask()，它会返回完整答案字符串，方便写入 Excel/CSV。
  多轮对话问题请把历史记录传入 messages 参数（见下方示例）。
"""

import os, sys, json, time, requests

os.environ["PYTHONIOENCODING"] = "utf-8"
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

# ── 配置 ──────────────────────────────────────────────────────────────────────

BASE_URL     = "http://8.148.158.241:8081"
PROJECT_PATH = "/llm-wiki-7777/wiki-data/rag"

# ── 核心接口 ──────────────────────────────────────────────────────────────────

def chat_ask(
    question: str,
    history: list[dict] | None = None,
    top_k: int = 8,
) -> dict:
    """
    问答接口（非流式，阻塞等待完整答案）。
    适合批量测试，返回结构化结果方便写入文件。

    参数：
        question  当前问题文本
        history   可选，多轮对话历史（见下方示例）
        top_k     检索 chunk 数量，默认 8

    返回：
        {
          "answer":          str,   # 完整答案文本
          "sources":         list,  # 引用来源列表 [{number, title, path, score}]
          "retrieval_query": str,   # 后端实际使用的检索词（省略问题会被补全）
          "retrieval_ms":    int,   # 检索耗时（毫秒）
          "error":           str,   # 非空表示出错
        }

    单轮示例：
        result = chat_ask("盛世优享26的险种代码是多少")
        print(result["answer"])
        print(result["sources"])

    多轮示例（省略问题必须传 history，否则后端无法补全上下文）：
        history = [
            {"role": "user",      "content": "平安智盈倍护A01的核保规则是什么"},
            {"role": "assistant", "content": "核保规则为参考重疾审核..."},
        ]
        result = chat_ask("起保点是多少", history=history)
        print(result["answer"])
    """
    messages = list(history) if history else []
    messages.append({"role": "user", "content": question})

    try:
        resp = requests.post(
            f"{BASE_URL}/api/chat/stream",
            json={"project_path": PROJECT_PATH, "messages": messages,
                  "top_k": top_k, "stream": True},
            timeout=90,
            stream=True,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        return {"answer": "", "sources": [], "retrieval_query": "",
                "retrieval_ms": 0, "error": str(e)}

    meta, tokens = {}, []
    buf = b""  # 字节缓冲，防止多字节汉字被截断

    for raw_chunk in resp.iter_content(chunk_size=None):
        buf += raw_chunk
        while b"\n" in buf:
            line_bytes, buf = buf.split(b"\n", 1)
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line or line.startswith("event:") or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                data = json.loads(payload)
            except Exception:
                continue

            if data.get("type") == "chat_meta":
                meta = data
                continue

            token = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
            if token:
                tokens.append(token)

    return {
        "answer":          "".join(tokens),
        "sources":         meta.get("sources", []),
        "retrieval_query": meta.get("retrieval_query", ""),
        "retrieval_ms":    meta.get("retrieval_ms", 0),
        "error":           "",
    }


def chat_stream(
    question: str,
    history: list[dict] | None = None,
    top_k: int = 8,
) -> dict:
    """
    同 chat_ask()，但边生成边打印到终端，适合人工验证单个问题。
    返回格式与 chat_ask() 相同。
    """
    messages = list(history) if history else []
    messages.append({"role": "user", "content": question})

    try:
        resp = requests.post(
            f"{BASE_URL}/api/chat/stream",
            json={"project_path": PROJECT_PATH, "messages": messages,
                  "top_k": top_k, "stream": True},
            timeout=90,
            stream=True,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        return {"answer": "", "sources": [], "retrieval_query": "",
                "retrieval_ms": 0, "error": str(e)}

    meta, tokens = {}, []
    buf = b""

    for raw_chunk in resp.iter_content(chunk_size=None):
        buf += raw_chunk
        while b"\n" in buf:
            line_bytes, buf = buf.split(b"\n", 1)
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line or line.startswith("event:") or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                data = json.loads(payload)
            except Exception:
                continue

            if data.get("type") == "chat_meta":
                meta = data
                print(f"\n[检索耗时 {meta.get('retrieval_ms', 0)}ms]  "
                      f"检索词: {meta.get('retrieval_query', '')}")
                for s in meta.get("sources", []):
                    print(f"  [{s['number']}] {s['title']}")
                print()
                continue

            token = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
            if token:
                tokens.append(token)
                print(token, end="", flush=True)

    print()
    return {
        "answer":          "".join(tokens),
        "sources":         meta.get("sources", []),
        "retrieval_query": meta.get("retrieval_query", ""),
        "retrieval_ms":    meta.get("retrieval_ms", 0),
        "error":           "",
    }


def rag_retrieve(query: str, top_k: int = 8) -> dict:
    """
    仅检索，不生成答案。返回相关 chunks。
    适合调试"后端找到了哪些内容"。

    返回：
        {
          "chunks": [
            {
              "page_title":   str,   # 页面标题
              "page_path":    str,   # 文件路径
              "chunk_text":   str,   # chunk 内容
              "heading_path": str,   # 所在章节标题
              "score":        float, # 综合得分
              "source":       str,   # "vector" | "token" | "hybrid"
            },
            ...
          ],
          "retrieval_ms": int,
        }
    """
    try:
        resp = requests.post(
            f"{BASE_URL}/api/rag/retrieve",
            json={"project_path": PROJECT_PATH, "query": query, "top_k": top_k},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        return {"chunks": [], "retrieval_ms": 0, "error": str(e)}


def get_status() -> dict:
    """检查索引状态，确认服务器和索引是否正常。"""
    try:
        resp = requests.get(
            f"{BASE_URL}/api/rag/status",
            params={"project_path": PROJECT_PATH},
            timeout=10,
        )
        return resp.json()
    except requests.RequestException as e:
        return {"error": str(e)}


# ── 批量测试示例（同事可以参考这段写自己的代码）────────────────────────────────

if __name__ == "__main__":

    # 1. 确认服务正常
    status = get_status()
    print(f"服务状态：dim={status.get('dim')}，"
          f"chunks={status.get('chunk_count')}，"
          f"needs_reindex={status.get('needs_reindex')}")
    print()

    # 2. 单轮问题（最简单的用法）
    q = "盛世优享26的险种代码是多少"
    print(f"问：{q}")
    result = chat_ask(q)
    print(f"答：{result['answer']}")
    print(f"来源：{[s['title'] for s in result['sources']]}")
    print(f"检索耗时：{result['retrieval_ms']}ms")
    print()

    # 3. 多轮对话（省略问题必须传 history）
    history = [
        {"role": "user",      "content": "平安智盈倍护（2026）终身护理保险A01的核保规则是什么"},
        {"role": "assistant", "content": "核保规则为参考重疾审核标准，EM≤150标体，EM>150拒保。"},
    ]
    q2 = "起保点是多少"
    print(f"问（有上下文）：{q2}")
    result2 = chat_ask(q2, history=history)
    print(f"答：{result2['answer']}")
    print(f"实际检索词：{result2['retrieval_query']}")
    print()

    # 4. 批量问题示例（同事可以改成从 Excel/CSV 读取）
    questions = [
        "盛世优享26的险种代码是多少",
        "智盈倍护26最低保费是多少",
        "家庭医生服务包含哪些权益",
        # ... 在这里加入几百个问题
    ]

    print("批量测试开始...")
    results = []
    for i, q in enumerate(questions, 1):
        r = chat_ask(q)
        results.append({
            "序号":       i,
            "问题":       q,
            "答案":       r["answer"],
            "来源数量":   len(r["sources"]),
            "检索耗时ms": r["retrieval_ms"],
            "错误":       r["error"],
        })
        print(f"[{i}/{len(questions)}] {q[:30]}... 耗时={r['retrieval_ms']}ms")
        time.sleep(0.2)  # 礼貌间隔，避免频繁请求

    # 写入 CSV（需要 import csv）
    import csv
    with open("batch_results.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=results[0].keys())
        writer.writeheader()
        writer.writerows(results)
    print(f"\n结果已写入 batch_results.csv，共 {len(results)} 条")
