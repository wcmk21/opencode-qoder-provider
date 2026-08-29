import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamResult } from "@ai-sdk/provider";
export interface QoderProviderOptions {
    /** Qoder PAT (Personal Access Token) */
    apiKey?: string;
    /** Region: "global" | "cn" */
    region?: string;
    /** 工作目录 */
    cwd?: string;
}
/**
 * 请求超时上限（与 pi-qoder-provider 的 DEFAULT_TIMEOUT_MS 对齐）。
 * CLI 挂死（存活但不输出）且宿主未取消时，SDK 的 for-await 会永久 pending，
 * 超时 abort 是最后一道兜底。
 */
export declare const REQUEST_TIMEOUT_MS: number;
export interface LinkedAbort {
    controller: AbortController;
    /** 移除转发监听；query 结束后调用，避免 timeout signal 上的监听残留 */
    cleanup(): void;
}
/**
 * 创建内部 AbortController，把「宿主取消信号」与「请求超时」统一转发给 SDK。
 *
 * SDK 的 query options 只接受 abortController（AbortController 实例，
 * abort() 时 SDK close 并三阶段终止子进程）；AI SDK 传入的是 abortSignal，
 * 此前以 abortSignal 键透传会被 SDK 静默忽略，abort 时只剩
 * ReadableStream.cancel() 单保险（doGenerate 路径完全没有兜底）。
 */
export declare function createLinkedAbortController(hostSignal?: AbortSignal, timeoutMs?: number): LinkedAbort;
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
