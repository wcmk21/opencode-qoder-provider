/**
 * plugin.ts — OpenCode Plugin 入口
 *
 * opencode 的模型列表只来自 config（opencode.json 中 provider.models 的显式声明）。
 * provider factory 返回的 models 对象不会被 opencode 读取（opencode 加载 provider
 * 包时只调用其 languageModel()），因此本插件通过 config hook 在启动时把动态模型
 * 目录（HTTP API + 静态 fallback）注入 provider.models，实现"零声明"模型列表：
 * 无需在 opencode.json 中逐个手写模型 ID。
 *
 * 注意：不用 plugin 的 provider.models hook——它要求 provider 已存在于 models.dev
 * 数据库（opencode 源码 provider.ts 中 `if (!provider) continue`），qoder 不在其中，
 * 该 hook 永远不会被调用。
 *
 * opencode.json 配置：
 * {
 *   "provider": {
 *     "qoder": {
 *       "npm": "file://C:/path/to/opencode-qoder-provider/dist/index.js",
 *       "name": "Qoder",
 *       "options": { "region": "global" }
 *     }
 *   },
 *   "plugin": ["C:/path/to/opencode-qoder-provider/dist/plugin.js"]
 * }
 */
import type { Plugin, Config } from "@opencode-ai/plugin";
import {
  fetchModelCatalog,
  getCachedModels,
  resolveRegion,
  type QoderModelDef,
  type QoderRegion,
} from "./models.js";
import { logInfo, logError } from "./logger.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** PAT 解析：options.apiKey → 区域专属 env → 全局 env */
function resolvePat(options: Record<string, any> | undefined, region: QoderRegion): string {
  return (
    options?.apiKey ||
    (region === "cn" ? process.env.QODERCN_PERSONAL_ACCESS_TOKEN : undefined) ||
    process.env.QODER_PERSONAL_ACCESS_TOKEN ||
    ""
  );
}

/**
 * 获取当前区域的模型目录。
 * fetchModelCatalog 在缓存新鲜（<1h）时不发起网络请求；缓存过期时走远端，
 * 整体限时 8s（避免拖慢 opencode 启动），失败/超时回退到本地缓存或静态列表。
 */
async function loadCatalog(
  options: Record<string, any> | undefined,
  region: QoderRegion,
): Promise<QoderModelDef[]> {
  const pat = resolvePat(options, region);
  if (!pat) return getCachedModels(region);
  try {
    return await withTimeout(fetchModelCatalog(pat, region), 8_000, "model catalog fetch");
  } catch (err) {
    logError("[qoder-plugin] model catalog fetch failed, falling back to local cache:",
      (err as Error)?.message || err);
    return getCachedModels(region);
  }
}

/** QoderModelDef → opencode config 中的模型声明（models.dev 风格字段） */
function toModelSpec(m: QoderModelDef) {
  return {
    name: m.name,
    reasoning: m.reasoning,
    tool_call: true,
    // attachment/modalities 必须跟随模型目录的 input 声明：声明 image 的模型
    // opencode 才会把用户消息中的图片作为 file part 传给 provider，
    // 进而由 context.ts 转成 image block 透传给模型；硬编码 text-only 会让
    // opencode 在宿主层剥掉图片，模型只能看到占位文本
    attachment: m.input.includes("image"),
    status: "active" as const,
    modalities: { input: [...m.input], output: ["text"] },
    limit: { context: m.contextWindow, output: m.maxTokens },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };
}

/** 通过 npm 字段识别本包声明的 provider（npm / file:// 均命中） */
function isQoderProvider(npm: unknown): boolean {
  return typeof npm === "string" && npm.includes("opencode-qoder-provider");
}

// ─── Plugin ─────────────────────────────────────────────────────────────────
/**
 * opencode 插件入口。
 * 导出一个函数，接收 context，返回 hooks 对象。
 */
export const QoderPlugin: Plugin = async (ctx) => {
  const clientLog = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    ctx.client.app.log({
      body: { service: "qoder-provider", level, message, extra },
    }).catch(() => {});

  return {
    // ── Config hook：动态模型目录注入 ──
    // opencode 在读取 cfg.provider 之前运行所有插件的 config hook，
    // 此处写入的 provider.models 会在随后被解析进模型数据库（模型选择器数据源）。
    config: async (config: Config) => {
      const providers = config.provider as Record<string, any> | undefined;
      if (!providers) return;

      for (const [providerID, p] of Object.entries(providers)) {
        if (!p || !isQoderProvider(p.npm)) continue;

        const region = resolveRegion(p.options?.region);
        const models = await loadCatalog(p.options, region);
        if (!models.length) {
          logInfo(`[qoder-plugin] no models resolved for provider "${providerID}" (region=${region})`);
          continue;
        }

        // 动态目录为基础；用户在 opencode.json 中显式声明的字段优先覆盖
        const declared = (p.models ?? {}) as Record<string, Record<string, unknown>>;
        const injected: Record<string, Record<string, unknown>> = {};
        for (const m of models) injected[m.id] = toModelSpec(m);
        for (const [id, spec] of Object.entries(declared)) {
          injected[id] = { ...injected[id], ...spec };
        }
        p.models = injected;

        logInfo(`[qoder-plugin] injected ${Object.keys(injected).length} models into provider "${providerID}" (region=${region})`);
      }
    },

    // ── 通用事件处理 ──
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await clientLog("info", "Qoder provider active", {
          directory: ctx.directory,
        });
      }

      if (event.type === "session.idle") {
        // 会话空闲时后台刷新模型缓存（下次启动生效）
        const region = resolveRegion();
        const pat = resolvePat(undefined, region);
        if (pat) {
          try {
            await fetchModelCatalog(pat, region);
            await clientLog("debug", "Model cache refreshed");
          } catch {
            await clientLog("debug", "Model cache refresh skipped");
          }
        }
      }

      if (event.type === "session.error") {
        await clientLog("warn", "Session error detected");
      }
    },
  };
};

export default QoderPlugin;
