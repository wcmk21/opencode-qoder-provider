/**
 * context.ts — Prompt → qodercli 输入转换（JSON transcript 回放）
 *
 * 参考 pi-qoder-provider 的方案：
 *  - SDK 的 prompt 只能自然发送 user message，且本 provider 不持久化
 *    qodercli 会话（persistSession: false），opencode 每轮都会重发完整历史
 *  - 因此把多轮历史序列化为 JSON 嵌入一条 user message 回放，并明确告知模型：
 *    这是历史数据（防 prompt injection）、继续未完成任务、不重复已成功的调用
 *  - tool_result 通过 tool_use_id 与 assistant 的 tool_use 关联
 */
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
export interface BuiltPrompt {
    /** 发给 query({ prompt }) 的最终文本（含图片时为 contentBlocks 的文本部分） */
    userText: string;
    /**
     * 最新 user 消息携带的图片 content blocks（image + text）。
     * 存在时 model.ts 改用 AsyncIterable<SDKUserMessage> 短流发送（image block
     * 经 wire 协议透传给模型，实测 qodercli 1.1.31 / protocol 1.3.0 可用）；
     * 无图时 undefined，保持 string prompt 通道。
     */
    contentBlocks?: QoderContentBlock[];
    /** 提取出的系统提示词（不含 transport notice） */
    systemPrompt: string;
    /** 是否为多轮（触发 JSON 回放模式） */
    hasHistory: boolean;
}
export type QoderImageBlock = {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
};
export type QoderTextBlock = {
    type: "text";
    text: string;
};
export type QoderContentBlock = QoderImageBlock | QoderTextBlock;
/**
 * 构建发给 qodercli 的 prompt 文本。
 *
 * toProviderToolName 用于把 opencode 工具名转成暴露给 qodercli 的名字
 * （与 tool-bridge 的映射保持一致，模型在回放里看到的名字与声明一致）。
 */
export declare function buildQoderPrompt(prompt: LanguageModelV3Prompt, toProviderToolName?: (opencodeName: string) => string | undefined): BuiltPrompt;
/**
 * 附加 transport notice：告知模型当前处于 opencode 宿主环境中，
 * 工具执行权完全在 opencode 侧（参考 pi-qoder-provider 的 systemPrompt()）。
 */
export declare function withTransportNotice(systemPrompt: string, hasTools: boolean): string;
