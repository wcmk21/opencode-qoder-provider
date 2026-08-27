/**
 * mapper.ts — SDKMessage → LanguageModelV3StreamPart 映射器
 *
 * 将 SDK 的 28 种 SDKMessage 变体映射为 AI SDK 的流式事件。
 * 核心处理 stream_event 的 6 种 BetaRawMessageStreamEvent 变体：
 *   message_start, content_block_start, content_block_delta,
 *   content_block_stop, message_delta, message_stop
 *
 * 每个 Query 对应一个 StreamMapper 实例（per-query state）。
 */

// ─── AI SDK V3 流式事件类型 ────────────────────────────────────────────────────
export type V3StreamPart =
  | { type: "stream-start"; warnings: Array<{ type: string; message: string }> }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string; providerExecuted?: boolean }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string; providerExecuted?: boolean }
  | { type: "finish"; finishReason: V3FinishReason; usage: V3Usage }
  | { type: "error"; error: unknown }
  | { type: "raw"; rawValue: unknown };

export interface V3FinishReason {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
}

export interface V3Usage {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
}

// ─── Content Block 类型跟踪 ─────────────────────────────────────────────────
type BlockType = "text" | "thinking" | "tool_use";

interface BlockState {
  type: BlockType;
  id: string;       // tool_use: call ID; text/thinking: 生成的 ID
  name?: string;    // tool_use: tool name
  accumulatedArgs: string; // tool_use: accumulated JSON args
}

// ─── StreamMapper ───────────────────────────────────────────────────────────
export class StreamMapper {
  /** index → block 状态（per-query） */
  private blocks = new Map<number, BlockState>();
  private messageId = "";
  private modelId = "";
  private emittedFinish = false;
  /** qodercli 侧工具名 → opencode 原名（声明型 MCP 桥接） */
  private toOpencodeName?: (providerName: string) => string | undefined;

  constructor(toOpencodeName?: (providerName: string) => string | undefined) {
    this.toOpencodeName = toOpencodeName;
  }

  /** 工具名映射：未知名转换为安全的占位名，由 opencode 返回 tool not found */
  private mapToolName(providerName: string | undefined): string {
    if (!providerName) return "unknown_tool";
    return this.toOpencodeName?.(providerName) ?? `__qoder_unsupported__${providerName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}`;
  }

  /** 重置状态（新消息开始时） */
  reset(): void {
    this.blocks.clear();
    this.messageId = "";
    this.modelId = "";
    this.emittedFinish = false;
  }

  /**
   * 处理一个 SDKMessage，返回零或多个 LanguageModelV3StreamPart。
   *
   * SDKMessage 类型（来自 @qoder-ai/qoder-agent-sdk）：
   *  - system/init → 跳过
   *  - assistant → 完整消息（非流式场景）
   *  - stream_event → 6 种 BetaRawMessageStreamEvent
   *  - result → 最终结果
   *  - 其他 → 跳过或作为 raw 事件
   */
  map(msg: any): V3StreamPart[] {
    if (!msg || typeof msg !== "object") return [];

    switch (msg.type) {
      case "system":
        // system/init: 提取模型信息，不产生流式事件
        return [];

      case "stream_event":
        return this.mapStreamEvent(msg.event);

      case "assistant":
        // 完整 assistant 消息：本 provider 始终 includePartialMessages: true，
        // stream_event 已覆盖相同内容，这里直接跳过，防止重复的
        // text/reasoning/tool-call 事件（曾导致重复 reasoning block）
        return [];

      case "result":
        return this.mapResult(msg);

      default:
        // 其他 20+ 种消息类型：忽略
        return [];
    }
  }

  // ─── stream_event 处理 ──────────────────────────────────────────────────
  private mapStreamEvent(event: any): V3StreamPart[] {
    if (!event) return [];
    const parts: V3StreamPart[] = [];

    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (message) {
          this.messageId = message.id || "";
          this.modelId = message.model || "";
        }
        parts.push({ type: "stream-start", warnings: [] });
        break;
      }

      case "content_block_start": {
        const idx = event.index as number;
        const block = event.content_block;
        if (block && typeof idx === "number") {
          const state: BlockState = {
            type: block.type as BlockType,
            id: "",
            name: undefined,
            accumulatedArgs: "",
          };

          switch (block.type) {
            case "text":
              state.id = `t${idx}`;
              parts.push({ type: "text-start", id: state.id });
              break;

            case "thinking":
              state.id = `r${idx}`;
              parts.push({ type: "reasoning-start", id: state.id });
              break;

            case "tool_use":
              state.id = block.id || `tc${idx}`;
              state.name = this.mapToolName(block.name);
              parts.push({
                type: "tool-input-start",
                id: state.id,
                toolName: state.name || "",
                providerExecuted: false,
              });
              break;
          }

          this.blocks.set(idx, state);
        }
        break;
      }

      case "content_block_delta": {
        const idx = event.index as number;
        const delta = event.delta;
        if (delta && typeof idx === "number") {
          const state = this.blocks.get(idx);

          switch (delta.type) {
            case "text_delta":
              if (state) {
                parts.push({ type: "text-delta", id: state.id, delta: delta.text || "" });
              }
              break;

            case "thinking_delta":
              if (state) {
                parts.push({
                  type: "reasoning-delta",
                  id: state.id,
                  delta: delta.thinking || "",
                });
              }
              break;

            case "input_json_delta":
              if (state) {
                const jsonDelta = delta.partial_json || "";
                state.accumulatedArgs += jsonDelta;
                parts.push({
                  type: "tool-input-delta",
                  id: state.id,
                  delta: jsonDelta,
                });
              }
              break;

            case "signature_delta":
              // thinking signature — 不映射到 AI SDK 事件
              break;
          }
        }
        break;
      }

      case "content_block_stop": {
        const idx = event.index as number;
        const state = this.blocks.get(idx);
        if (state) {
          switch (state.type) {
            case "text":
              parts.push({ type: "text-end", id: state.id });
              break;
            case "thinking":
              parts.push({ type: "reasoning-end", id: state.id });
              break;
            case "tool_use":
              parts.push({ type: "tool-input-end", id: state.id });
              // 同时发出 tool-call 事件（V3 格式）
              parts.push({
                type: "tool-call",
                toolCallId: state.id,
                toolName: state.name || "",
                input: state.accumulatedArgs || "{}",
                providerExecuted: false,
              });
              break;
          }
          this.blocks.delete(idx);
        }
        break;
      }

      case "message_delta": {
        const stopReason = event.delta?.stop_reason;
        const usage = event.usage;
        parts.push({
          type: "finish",
          finishReason: this.mapStopReason(stopReason),
          usage: this.mapUsage(usage),
        });
        this.emittedFinish = true;
        break;
      }

      case "message_stop":
        // 流结束——如果不曾发过 finish，补一个
        // （置位 emittedFinish，避免后续 result 消息再次补发导致重复 finish 事件）
        if (!this.emittedFinish) {
          parts.push({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: this.emptyUsage(),
          });
          this.emittedFinish = true;
        }
        break;
    }

    return parts;
  }

  // （assistant 完整消息处理已移除：includePartialMessages 恒为 true 时，
  //   stream_event 与 assistant 完整消息内容重复，统一只走 stream_event 路径）

  // ─── result 消息处理 ─────────────────────────────────────────────────────
  private mapResult(msg: any): V3StreamPart[] {
    if (msg.subtype === "error") {
      const errors = msg.errors || [];
      return [{
        type: "error",
        error: new Error(errors.map((e: any) => e.message).join("; ") || "Unknown error"),
      }];
    }
    // result/success — 如果不曾发过 finish，补一个
    if (!this.emittedFinish) {
      return [{
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: this.mapUsage(msg.usage),
      }];
    }
    return [];
  }

  // ─── stop_reason 映射 ───────────────────────────────────────────────────
  private mapStopReason(reason: string | null | undefined): V3FinishReason {
    if (!reason) return { unified: "stop", raw: undefined };
    switch (reason) {
      case "end_turn":
      case "stop":
      case "stop_sequence":
        return { unified: "stop", raw: reason };
      case "max_tokens":
        return { unified: "length", raw: reason };
      case "tool_use":
        return { unified: "tool-calls", raw: reason };
      case "content_filter":
        return { unified: "content-filter", raw: reason };
      default:
        return { unified: "other", raw: reason };
    }
  }

  // ─── Usage 映射 ─────────────────────────────────────────────────────────
  private mapUsage(usage: any): V3Usage {
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    return {
      inputTokens: { total: inputTokens || undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: outputTokens || undefined, text: outputTokens || undefined, reasoning: undefined },
    };
  }

  private emptyUsage(): V3Usage {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }
}
