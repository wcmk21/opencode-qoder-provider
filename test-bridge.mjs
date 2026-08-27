/**
 * test-bridge.mjs — 端到端验证声明型 MCP 工具桥接
 *
 * 模拟 opencode 的完整调用链：
 *  1. 传入 opencode 风格的工具定义（function + JSONSchema7）
 *  2. 验证模型发出的 tool_use 被映射回 opencode 原工具名
 *  3. 验证 finishReason = tool-calls
 */
import { QoderLanguageModel } from "./dist/index.js";

const model = new QoderLanguageModel("lite", {
  apiKey: process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT,
  cwd: process.cwd(),
});

// 模拟 opencode 传入的工具定义（bash，小写名与 qodercli 保留名 Bash 不冲突）
const options = {
  tools: [
    {
      type: "function",
      name: "bash",
      description: "Run a shell command in the workspace",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ],
  prompt: [
    { role: "system", content: "You are a coding assistant running inside OpenCode." },
    { role: "user", content: [{ type: "text", text: "Use the bash tool to run: echo hello-bridge" }] },
  ],
  abortSignal: undefined,
};

console.log("=== doGenerate with tool bridge ===");
const result = await model.doGenerate(options);
console.log("finishReason:", JSON.stringify(result.finishReason));
console.log("usage:", JSON.stringify(result.usage));
for (const part of result.content) {
  if (part.type === "tool-call") {
    console.log("TOOL-CALL:", part.toolName, part.toolCallId, "input:", part.input);
  } else if (part.type === "text") {
    console.log("TEXT:", part.text.slice(0, 300));
  } else if (part.type === "reasoning") {
    console.log("REASONING:", part.text.slice(0, 120), "...");
  } else {
    console.log(part.type);
  }
}

// 第二轮：模拟 opencode 执行完工具后回传 tool-result（JSON transcript 回放路径）
if (result.content.some((p) => p.type === "tool-call")) {
  const call = result.content.find((p) => p.type === "tool-call");
  console.log("\n=== doGenerate round 2 with tool-result replay ===");
  const round2 = await model.doGenerate({
    ...options,
    prompt: [
      ...options.prompt,
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "hello-bridge" } }],
      },
    ],
  });
  console.log("finishReason:", JSON.stringify(round2.finishReason));
  for (const part of round2.content) {
    if (part.type === "text") console.log("TEXT:", part.text.slice(0, 300));
    else console.log(part.type);
  }
}
