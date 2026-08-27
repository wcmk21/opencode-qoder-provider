/**
 * plugin.ts — OpenCode Plugin 入口
 *
 * 作为 opencode 插件注册 Hook 事件：
 *  - event: 监听 session 相关事件
 *  - provider: 动态模型发现
 *
 * opencode.json 配置：
 * {
 *   "plugin": ["opencode-qoder-provider/plugin"]
 * }
 */
import type { Plugin, ProviderHook } from "@opencode-ai/plugin";

// ─── Plugin 函数 ────────────────────────────────────────────────────────────
/**
 * opencode 插件入口。
 * 导出一个函数，接收 context，返回 hooks 对象。
 */
export const QoderPlugin: Plugin = async (ctx) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    ctx.client.app.log({
      body: { service: "qoder-provider", level, message, extra },
    }).catch(() => {});

  // Provider hook：动态模型发现
  const provider: ProviderHook = {
    id: "qoder",
    models: async (providerInfo, providerCtx) => {
      // 动态返回模型列表（可选）
      // 目前模型目录通过 index.ts 的 provider factory 管理
      return {};
    },
  };

  return {
    // ── Provider hook ──
    provider,

    // ── 通用事件处理 ──
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await log("info", "Qoder provider active", {
          directory: ctx.directory,
        });
      }

      if (event.type === "session.idle") {
        // 会话空闲时刷新模型缓存
        const { fetchModelCatalog, resolveRegion } = await import("./models.js");
        const region = resolveRegion();
        const pat = process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODER_PERSONAL_ACCESS_TOKEN || "";
        if (pat) {
          try {
            await fetchModelCatalog(pat, region);
            await log("debug", "Model cache refreshed");
          } catch {
            await log("debug", "Model cache refresh skipped");
          }
        }
      }

      if (event.type === "session.error") {
        await log("warn", "Session error detected");
      }
    },
  };
};

export default QoderPlugin;
