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
 *       "npm": "opencode-qoder-provider",
 *       "name": "Qoder",
 *       "options": { "region": "global" }
 *     }
 *   },
 *   "plugin": ["opencode-qoder-provider/plugin"]
 * }
 */
import type { Plugin } from "@opencode-ai/plugin";
/**
 * opencode 插件入口。
 * 导出一个函数，接收 context，返回 hooks 对象。
 */
export declare const QoderPlugin: Plugin;
export default QoderPlugin;
