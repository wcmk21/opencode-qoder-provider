/**
 * index.ts — OpenCode Qoder Provider 入口
 *
 * 导出 opencode 可加载的 provider 工厂函数。
 * 内部使用 @qoder-ai/qoder-agent-sdk 的 query() API。
 *
 * opencode.json 配置示例：
 * {
 *   "provider": {
 *     "qoder": {
 *       "npm": "github:wcmk21/opencode-qoder-provider",
 *       "name": "Qoder",
 *       "options": { "region": "global" },
 *       "models": {
 *         "auto": { "name": "Qoder Auto" },
 *         "performance": { "name": "Qoder Performance" }
 *       }
 *     }
 *   }
 * }
 */
import { QoderLanguageModel, type QoderProviderOptions } from "./model.js";
import { getCachedModels, fetchModelCatalog, resolveRegion, type QoderRegion, type QoderModelDef } from "./models.js";
/**
 * opencode 加载此包时调用。
 * `settings` 来自 opencode.json 的 `settings` 字段。
 * `apiKey` 来自 opencode 的 /connect 或 env 字段指定的环境变量。
 *
 * 动态模型发现：
 *  - 同步读取本地缓存（上次 fetchModelCatalog 的结果）
 *  - 异步刷新远端缓存（下次启动生效）
 *  - 注意：opencode 不读取 factory 返回的 models 对象（只调用 languageModel()），
 *    模型列表由 plugin.ts 的 config hook 注入 opencode.json 的 provider.models
 */
declare function createQoderProvider(options?: QoderProviderOptions): {
    /**
     * 所有已知模型定义（缓存 + 静态 fallback）。
     * 注意：opencode 不读取此字段——模型选择器的数据源是 opencode.json 中
     * provider.models 的声明，本包通过 plugin.ts 的 config hook 自动注入。
     * 此 map 仅供测试与编程式调用使用。
     */
    models: Record<string, {
        name: string;
        reasoning?: boolean;
        input?: string[];
        contextWindow?: number;
        maxTokens?: number;
    }>;
    /**
     * opencode 为每个模型调用此方法。
     * 返回 LanguageModelV3 兼容实例。
     */
    languageModel(modelId: string): QoderLanguageModel;
};
export default createQoderProvider;
export { createQoderProvider, QoderLanguageModel };
export type { QoderProviderOptions, QoderModelDef, QoderRegion };
export { getCachedModels, fetchModelCatalog, resolveRegion };
