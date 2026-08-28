/**
 * model.ts — LanguageModelV3 实现
 *
 * 参考 pi-qoder-provider 的架构：把 qodercli 当作无状态的语言模型后端，
 * 而不是 agent：
 *  - opencode 工具通过声明型 MCP 桥接给 qodercli（tool-bridge.ts）：
 *    模型能"看到"工具并发出 tool_use，但 qodercli 侧永不执行，
 *    tool_use 流事件转成 AI SDK tool-call 交回 opencode 执行
 *  - 多轮历史用 JSON transcript 回放（context.ts）
 *  - 每次请求：tools:[]（原生全禁）、maxTurns:1、persistSession:false
 *  - 收到权威工具边界（stop_reason=tool_use）后立即终止子进程，
 *    防止 canUseTool 的 deny 结果触发 qodercli 第二轮模型调用
 */
import {
  query,
  accessToken,
  ProcessTransport,
} from "@qoder-ai/qoder-agent-sdk";
import { log, logInfo, logError } from "./logger.js";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { StreamMapper, type V3FinishReason, type V3Usage, type V3ProviderMetadata } from "./mapper.js";
import { findModel, type QoderModelDef, type QoderRegion } from "./models.js";
import { resolveQoderCliPath } from "./cli-path.js";
import { buildQoderToolBridge, OPENCODE_MCP_SERVER_KEY, type QoderToolBridge } from "./tool-bridge.js";
import { buildQoderPrompt, withTransportNotice, type BuiltPrompt } from "./context.js";

// ─── Provider Options ───────────────────────────────────────────────────────
export interface QoderProviderOptions {
  /** Qoder PAT (Personal Access Token) */
  apiKey?: string;
  /** Region: "global" | "cn" */
  region?: string;
  /** 工作目录 */
  cwd?: string;
}

// ─── QoderLanguageModel ─────────────────────────────────────────────────────
export class QoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "qoder";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private region: QoderRegion;
  private pat: string;
  private cwd?: string;
  private modelDef?: QoderModelDef;
  private qoderCliPath: string;

  constructor(modelId: string, options: QoderProviderOptions) {
    this.modelId = modelId;
    this.region = (options.region === "cn" ? "cn" : "global") as QoderRegion;
    // CN 区优先读 QODERCN_PERSONAL_ACCESS_TOKEN（与 README / ensurePat 错误消息一致），
    // 否则回退到全局 QODER_PERSONAL_ACCESS_TOKEN
    this.pat = options.apiKey
      || (this.region === "cn" ? process.env.QODERCN_PERSONAL_ACCESS_TOKEN : undefined)
      || process.env.QODER_PERSONAL_ACCESS_TOKEN
      || process.env.QODER_PAT
      || "";
    this.cwd = options.cwd;

    // 查找模型定义
    this.modelDef = findModel(modelId, this.region);

    // 解析 qodercli.js 路径（用于 ProcessTransport，绕过 Bun 下 WorkerTransport 的兼容性问题）
    this.qoderCliPath = resolveQoderCliPath();
    logInfo(`QoderLanguageModel created: model=${modelId}, cliPath=${this.qoderCliPath}`);
  }

  /** 确保 PAT 可用（延迟检查，避免初始化时抛异常） */
  private ensurePat(): void {
    if (!this.pat) {
      throw new Error(
        this.region === "cn"
          ? "Qoder CN: Set QODERCN_PERSONAL_ACCESS_TOKEN or QODER_PERSONAL_ACCESS_TOKEN."
          : "Qoder: Set QODER_PERSONAL_ACCESS_TOKEN.",
      );
    }
  }

  /**
   * 为一次调用准备 bridge / prompt / mapper / query。
   * doGenerate 与 doStream 共用，保证两条路径行为一致。
   */
  private prepare(options: LanguageModelV3CallOptions) {
    this.ensurePat();

    // 1. 声明型 MCP 工具桥接：把 opencode 工具 schema 暴露给 qodercli（不执行）
    const bridge = buildQoderToolBridge(options.tools as any);

    // 2. Prompt 构建：多轮历史 → JSON transcript 回放
    const built = buildQoderPrompt(options.prompt, (name) => bridge?.toProviderName(name));

    // 3. 系统提示词 = opencode 提示词 + transport notice
    const systemPrompt = withTransportNotice(built.systemPrompt, bridge !== undefined);

    const q = query({
      prompt: built.userText,
      options: {
        auth: accessToken(this.pat),
        model: this.modelDef?.sdkModelId || this.modelId,
        cwd: this.cwd,
        transport: new ProcessTransport({ pathToQoderCLIExecutable: this.qoderCliPath, stderr: "ignore" }),
        // qodercli 原生工具/技能/插件/用户设置全禁
        tools: [],
        skills: [],
        plugins: [],
        settingSources: [],
        // 无状态单轮：不持久化 qodercli 会话（opencode 每轮重发完整历史）
        persistSession: false,
        maxTurns: 1,
        // 用 opencode 的系统提示词（+ transport notice）替换 qodercli 默认的
        systemPrompt,
        includePartialMessages: true,
        // opencode 工具经声明型 MCP 桥接；canUseTool 永远 deny，执行权在 opencode
        ...(bridge ? {
          mcpServers: { [OPENCODE_MCP_SERVER_KEY]: bridge.server },
          allowedMcpServerNames: [OPENCODE_MCP_SERVER_KEY],
          strictMcpConfig: true,
          canUseTool: bridge.canUseTool,
          permissionMode: "default" as const,
        } : { permissionMode: "acceptEdits" as const }),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      },
    });

    // 4. mapper：qodercli 侧工具名 → opencode 原名；传入 contextWindow 供
    //    usage 的 context_usage_ratio 估算输入 token
    const mapper = new StreamMapper((providerName) => bridge?.toOpencodeName(providerName), this.modelDef?.contextWindow);

    return { q, mapper, built, bridge };
  }

  // ── doGenerate (非流式) ──────────────────────────────────────────────────
  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { q, mapper, built, bridge } = this.prepare(options);
    logInfo(`doGenerate called: model=${this.modelId}, history=${built.hasHistory}, tools=${bridge?.toolCount ?? 0}`);

    const content: LanguageModelV3Content[] = [];
    let finishReason: V3FinishReason = { unified: "stop", raw: undefined };
    let usage: V3Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
    let providerMetadata: V3ProviderMetadata | undefined;

    let textBuffer = "";
    let reasoningBuffer = "";
    let toolBoundary = false;

    try {
      for await (const msg of q) {
        const parts = mapper.map(msg);
        for (const part of parts) {
          switch (part.type) {
            case "text-delta":
              textBuffer += part.delta;
              break;
            case "reasoning-delta":
              reasoningBuffer += part.delta;
              break;
            case "tool-call":
              content.push({
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                providerExecuted: part.providerExecuted,
              });
              break;
            case "finish":
              finishReason = part.finishReason;
              usage = part.usage;
              providerMetadata = part.providerMetadata;
              break;
            case "error":
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }
        // 权威工具边界：立即终止，防止 deny 触发 qodercli 第二轮模型调用
        if (mapper.isToolBoundary()) {
          toolBoundary = true;
          break;
        }
      }
      // 补发 finish（幂等）：result 已发过时为空；工具边界终止时 result 不会
      // 到达，用累积 usage 发出——保证 usage 不因提前终止而丢失
      for (const part of mapper.flushFinish()) {
        if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = part.usage;
          providerMetadata = part.providerMetadata;
        }
      }
    } finally {
      await q.close().catch(() => {});
    }
    logInfo(`doGenerate completed: finish=${finishReason.unified}, toolBoundary=${toolBoundary}`);

    // 构建 content 数组：reasoning → text → tool-calls
    if (reasoningBuffer) {
      content.unshift({ type: "reasoning", text: reasoningBuffer });
    }
    if (textBuffer) {
      // text 放在 reasoning 之后、tool-calls 之前
      const insertIdx = reasoningBuffer ? 1 : 0;
      content.splice(insertIdx, 0, { type: "text", text: textBuffer });
    }

    return {
      content,
      finishReason,
      usage,
      providerMetadata,
      warnings: [],
    };
  }

  // ── doStream ─────────────────────────────────────────────────────────────
  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const self = this;
    // q 提升到闭包外层：cancel() 时可主动终止 qodercli 子进程，
    // 避免 start() 卡在迭代/背压上导致 finally 永不执行、进程残留
    let q: ReturnType<typeof query> | undefined;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        // 流被取消（TUI 中断）后 controller.enqueue/close 会抛 TypeError，
        // 统一包装为安全调用，避免取消路径上的 unhandled rejection
        const safeEnqueue = (part: LanguageModelV3StreamPart): void => {
          try { controller.enqueue(part); } catch { /* stream cancelled */ }
        };
        const safeClose = (): void => {
          try { controller.close(); } catch { /* stream cancelled */ }
        };
        try {
          const prepared = self.prepare(options);
          q = prepared.q;
          const { mapper, built, bridge } = prepared;
          logInfo(`doStream: starting query() for model=${self.modelDef?.sdkModelId || self.modelId}, history=${built.hasHistory}, tools=${bridge?.toolCount ?? 0}`);
          log(`doStream: prompt=${JSON.stringify(built.userText).slice(0, 300)}`);

          let msgCount = 0;
          let partCount = 0;
          for await (const msg of q) {
            msgCount++;
            const parts = mapper.map(msg);
            if (parts.length > 0) {
              log(`doStream: msg#${msgCount} type=${(msg as any)?.type || 'unknown'} → ${parts.map(p => p.type).join(',')}`);
            }
            for (const part of parts) {
              partCount++;
              safeEnqueue(part as LanguageModelV3StreamPart);
            }
            // 权威工具边界：立即终止，防止 deny 触发 qodercli 第二轮模型调用
            if (mapper.isToolBoundary()) {
              logInfo(`doStream: tool boundary reached, terminating qodercli (msgs=${msgCount})`);
              break;
            }
          }
          // 补发 finish（幂等）：result 已发过时为空；工具边界/提前终止时
          // 携带累积 usage 发出——保证 opencode 每轮都能拿到 token 统计
          for (const part of mapper.flushFinish()) {
            partCount++;
            safeEnqueue(part as LanguageModelV3StreamPart);
          }
          logInfo(`doStream: query completed for model=${self.modelId}, msgs=${msgCount}, parts=${partCount}`);
          safeClose();
        } catch (error) {
          logError(`doStream: query error for model=${self.modelId}:`, error instanceof Error ? error.message : String(error));
          safeEnqueue({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          } as LanguageModelV3StreamPart);
          safeClose();
        } finally {
          if (q) await q.close().catch(() => {});
        }
      },

      async cancel() {
        // TUI 中断（ESC）：abortSignal 之外的双保险，主动终止 qodercli 子进程
        if (q) await q.close().catch(() => {});
      },
    });

    return { stream };
  }
}
