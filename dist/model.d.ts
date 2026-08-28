import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamResult } from "@ai-sdk/provider";
export interface QoderProviderOptions {
    /** Qoder PAT (Personal Access Token) */
    apiKey?: string;
    /** Region: "global" | "cn" */
    region?: string;
    /** 工作目录 */
    cwd?: string;
}
export declare class QoderLanguageModel implements LanguageModelV3 {
    readonly specificationVersion: "v3";
    readonly provider = "qoder";
    readonly modelId: string;
    readonly supportedUrls: Record<string, RegExp[]>;
    private region;
    private pat;
    private cwd?;
    private modelDef?;
    private qoderCliPath;
    constructor(modelId: string, options: QoderProviderOptions);
    /** 确保 PAT 可用（延迟检查，避免初始化时抛异常） */
    private ensurePat;
    /**
     * 为一次调用准备 bridge / prompt / mapper / query。
     * doGenerate 与 doStream 共用，保证两条路径行为一致。
     */
    private prepare;
    doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult>;
    doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult>;
}
