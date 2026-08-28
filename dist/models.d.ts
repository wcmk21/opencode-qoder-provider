export interface QoderModelDef {
    /** opencode 中显示的模型 ID */
    id: string;
    /** 显示名称 */
    name: string;
    /** 是否支持推理/思考 */
    reasoning: boolean;
    /** 支持的输入类型 */
    input: ("text" | "image")[];
    /** 上下文窗口大小 */
    contextWindow: number;
    /** 最大输出 token */
    maxTokens: number;
    /** Qoder 内部模型 key（传给 SDK 的 model 参数） */
    sdkModelId: string;
}
export type QoderRegion = "global" | "cn";
export declare function resolveRegion(override?: string): QoderRegion;
export declare const staticGlobalModels: QoderModelDef[];
export declare const staticCnModels: QoderModelDef[];
export declare function getCachedModels(region: QoderRegion): QoderModelDef[];
export declare function fetchModelCatalog(pat: string, region: QoderRegion): Promise<QoderModelDef[]>;
/** 查找模型定义 */
export declare function findModel(modelId: string, region: QoderRegion): QoderModelDef | undefined;
