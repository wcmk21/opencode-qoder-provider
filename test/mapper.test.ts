import { describe, it, expect } from "vitest";
import { StreamMapper } from "../src/mapper.js";

// ─── qodercli stream_event 构造工具 ─────────────────────────────────────────
const messageStart = () => ({
  type: "stream_event",
  event: { type: "message_start", message: { id: "msg_1", model: "auto" } },
});
const blockStart = (index: number, block: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "content_block_start", index, content_block: block },
});
const blockDelta = (index: number, delta: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index, delta },
});
const blockStop = (index: number) => ({
  type: "stream_event",
  event: { type: "content_block_stop", index },
});
const messageDelta = (stopReason: string | null, usage?: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "message_delta", delta: { stop_reason: stopReason }, usage },
});
const messageStop = { type: "stream_event", event: { type: "message_stop" } };

describe("StreamMapper 工具名映射", () => {
  it("映射函数命中时使用 opencode 原名", () => {
    const m = new StreamMapper((p) => (p === "decl_0_abc" ? "bash" : undefined));
    const parts = m.map(blockStart(0, { type: "tool_use", id: "call_1", name: "decl_0_abc" }));
    expect(parts[0]).toMatchObject({ type: "tool-input-start", toolName: "bash", providerExecuted: false });
  });

  it("映射函数未命中时回退 __qoder_unsupported__ 占位名", () => {
    const m = new StreamMapper(() => undefined);
    const parts = m.map(blockStart(0, { type: "tool_use", id: "call_1", name: "unknown_thing" }));
    expect(parts[0]).toMatchObject({ type: "tool-input-start", toolName: "__qoder_unsupported__unknown_thing" });
  });

  it("无映射函数且名称含非法字符时做安全替换", () => {
    const m = new StreamMapper();
    const parts = m.map(blockStart(0, { type: "tool_use", id: "call_1", name: "weird name!" }));
    expect(parts[0]).toMatchObject({ type: "tool-input-start", toolName: "__qoder_unsupported__weird_name_" });
  });

  it("tool_use 缺名时 tool-call 使用 unknown_tool", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "tool_use", id: "c1" }));
    const stopParts = m.map(blockStop(0));
    expect(stopParts[1]).toMatchObject({ type: "tool-call", toolName: "unknown_tool", input: "{}" });
  });
});

describe("StreamMapper 事件映射", () => {
  it("message_start → stream-start", () => {
    const m = new StreamMapper();
    expect(m.map(messageStart())).toEqual([{ type: "stream-start", warnings: [] }]);
  });

  it("完整 text 块：text-start → text-delta → text-end", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    expect(m.map(blockStart(0, { type: "text" }))).toEqual([{ type: "text-start", id: "t0" }]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: "hello" }))).toEqual([
      { type: "text-delta", id: "t0", delta: "hello" },
    ]);
    expect(m.map(blockStop(0))).toEqual([{ type: "text-end", id: "t0" }]);
  });

  it("thinking 块映射为 reasoning 事件", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "thinking" }));
    expect(m.map(blockDelta(0, { type: "thinking_delta", thinking: "hmm" }))).toEqual([
      { type: "reasoning-delta", id: "r0", delta: "hmm" },
    ]);
    expect(m.map(blockStop(0))).toEqual([{ type: "reasoning-end", id: "r0" }]);
  });

  it("signature_delta 不产生事件", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "thinking" }));
    expect(m.map(blockDelta(0, { type: "signature_delta", signature: "x" }))).toEqual([]);
  });

  it("tool_use 块结束时发出 tool-input-end + tool-call（累积 input JSON）", () => {
    // 模拟 bridge 回映射成功（真实路径由 model.ts 注入）
    const m = new StreamMapper((p) => (p === "bash" ? "bash" : undefined));
    m.map(messageStart());
    m.map(blockStart(0, { type: "tool_use", id: "call_9", name: "bash" }));
    m.map(blockDelta(0, { type: "input_json_delta", partial_json: '{"command":' }));
    m.map(blockDelta(0, { type: "input_json_delta", partial_json: '"ls"}' }));
    const stopParts = m.map(blockStop(0));
    expect(stopParts).toHaveLength(2);
    expect(stopParts[0]).toEqual({ type: "tool-input-end", id: "call_9" });
    expect(stopParts[1]).toEqual({
      type: "tool-call",
      toolCallId: "call_9",
      toolName: "bash",
      input: '{"command":"ls"}',
      providerExecuted: false,
    });
  });

  it("message_delta 映射 stop_reason=tool_use → unified tool-calls", () => {
    const m = new StreamMapper();
    const parts = m.map(messageDelta("tool_use", { input_tokens: 10, output_tokens: 5 }));
    expect(parts[0]).toEqual({
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    });
  });

  it("max_tokens → length", () => {
    const m = new StreamMapper();
    const parts = m.map(messageDelta("max_tokens"));
    expect(parts[0].type === "finish" && parts[0].finishReason.unified).toBe("length");
  });

  it("message_stop 在无 finish 时补发 stop，且只补发一次", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    const first = m.map(messageStop);
    expect(first).toHaveLength(1);
    expect(first[0].type).toBe("finish");
    // 第二次 message_stop（异常重复流）不再补发
    expect(m.map(messageStop)).toEqual([]);
  });

  it("assistant 完整消息跳过（includePartialMessages 恒 true，防重复事件）", () => {
    const m = new StreamMapper();
    expect(m.map({ type: "assistant", message: { content: [] } })).toEqual([]);
  });

  it("system 与未知消息类型跳过", () => {
    const m = new StreamMapper();
    expect(m.map({ type: "system", subtype: "init" })).toEqual([]);
    expect(m.map({ type: "mystery" })).toEqual([]);
    expect(m.map(null)).toEqual([]);
  });

  it("result error → error part（拼接错误消息）", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "error", errors: [{ message: "boom" }] });
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("error");
    expect((parts[0] as { error: Error }).error.message).toBe("boom");
  });

  it("result success 在无 finish 时补发 stop", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "success", usage: { input_tokens: 3 } });
    expect(parts[0].type).toBe("finish");
  });

  it("finish 已发出的 result success 不再重复发 finish", () => {
    const m = new StreamMapper();
    m.map(messageDelta("end_turn"));
    expect(m.map({ type: "result", subtype: "success" })).toEqual([]);
  });

  it("reset() 清空块状态", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.reset();
    expect(m.map(blockStop(0))).toEqual([]);
  });
});
