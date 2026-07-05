import { describe, expect, it, vi } from "vitest"

const streamChat = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", () => ({ streamChat }))

import { judgeRelationship } from "./judge-module"

describe("judgeRelationship", () => {
  it("accepts a server-managed LlmConfig without a legacy endpoint property", async () => {
    streamChat.mockImplementation((_config, _messages, callbacks) => {
      callbacks.onToken('{"relation":"same","confidence":"high","reason":"内容一致"}')
      callbacks.onDone()
      return Promise.resolve()
    })

    const result = await judgeRelationship(
      {
        provider: "custom",
        apiKey: "__SERVER_MANAGED__",
        model: "deepseek-chat",
        ollamaUrl: "",
        customEndpoint: "https://api.deepseek.com/v1",
        maxContextSize: 128000,
      },
      "新页面",
      "相同内容",
      "旧页面",
      "相同内容",
    )

    expect(result).toMatchObject({
      relation: "same",
      confidence: "high",
      reason: "内容一致",
    })
    expect(streamChat).toHaveBeenCalledOnce()
  })
})
