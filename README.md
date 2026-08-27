# opencode-qoder-provider

基于 `@qoder-ai/qoder-agent-sdk` 的 [OpenCode](https://opencode.ai) Qoder Provider 插件。

把 Qoder 官方 CLI（qodercli）当作**无状态的语言模型后端**接入 opencode：
opencode 保留完整的 agent 循环与工具执行权，qodercli 只负责推理。

## 特性

- **声明型 MCP 工具桥接**：opencode 的工具 schema 通过 SDK 的 `createSdkMcpServer` 声明给模型，
  模型能"看到"工具并发出 tool_use，但 qodercli 侧永不执行（`canUseTool` 永远 deny），
  tool_use 流事件转回 opencode 执行
- **JSON transcript 回放**：多轮历史（含 tool_use / tool_result）序列化为 JSON 嵌入单条
  user message，跨进程传递上下文，并明确标注"非指令"以防 prompt injection
- **无状态单轮**：每次请求独立进程，`maxTurns: 1` + `persistSession: false`，
  多轮上下文由 opencode 管理
- **双区支持**：Global / CN 区域与各自的模型目录
- **动态模型目录**：HTTP API 获取模型列表（1 小时缓存），失败时回退静态列表

## 架构

```
opencode TUI
  │
  │  LanguageModelV3 接口
  ↓
┌──────────────────────────────────────────────┐
│  opencode-qoder-provider                      │
│  ┌────────────────────────────────────────┐  │
│  │  QoderLanguageModel (model.ts)         │  │
│  │  - doStream() / doGenerate()           │  │
│  │  - 工具边界立即终止进程               │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                              │
│  ┌──────────────▼─────────────────────────┐  │
│  │  context.ts   tool-bridge.ts           │  │
│  │  历史 → JSON transcript  opencode 工具 │  │
│  │  回放 + transport notice  → 声明型 MCP │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                              │
│  ┌──────────────▼─────────────────────────┐  │
│  │  mapper.ts                             │  │
│  │  SDKMessage → LanguageModelV3StreamPart│  │
│  │  (stream_event 6 变体 + result)        │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                              │
│  ┌──────────────▼─────────────────────────┐  │
│  │  @qoder-ai/qoder-agent-sdk             │  │
│  │  ProcessTransport（Bun 兼容）          │  │
│  │  认证、COSY、WAF、进程管理由 SDK 处理 │  │
│  └──────────────┬─────────────────────────┘  │
└─────────────────┼────────────────────────────┘
                  │ JSONL over stdin/stdout
                  ↓
            qodercli（无状态推理）
                  ↓
            Qoder Backend
```

**关键设计决策**：

- LLM 交互全部通过 SDK `query()` 完成，不直接调用 HTTP API（仅模型目录获取使用 HTTP）
- 工具边界（`stop_reason = tool_use`）一到立即终止 qodercli 进程，防止 `canUseTool` 的
  deny 结果触发 qodercli 内部 agent loop 的第二轮模型调用
- opencode 是唯一的工具执行者；qodercli 原生工具/技能/插件/用户设置全部禁用

## 安装

无需手动安装。在 `opencode.json` 的 provider 配置中写上 `"npm": "opencode-qoder-provider"`，
opencode 启动时会自动拉取并缓存到 `~/.cache/opencode/packages/`。

也可以手动安装调试：

```bash
npm install opencode-qoder-provider
# 本地开发时可用 file:// 协议直接指向构建产物
# "npm": "file://C:/path/to/opencode-qoder-provider/dist/index.js"
```

## 配置

### 1. 设置 PAT

```bash
# Global 区域
export QODER_PERSONAL_ACCESS_TOKEN=pt-your-token-here

# CN 区域（CN 区优先读取；未设置时回退到 QODER_PERSONAL_ACCESS_TOKEN）
export QODERCN_PERSONAL_ACCESS_TOKEN=pt-your-cn-token-here
```

### 2. opencode.json

完整示例见 [opencode.json.example](./opencode.json.example)。最小配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "qoder": {
      "name": "Qoder",
      "npm": "opencode-qoder-provider",
      "options": { "region": "global" },
      "models": {
        "auto": { "name": "Qoder Auto" },
        "ultimate": { "name": "Qoder Ultimate" }
      }
    }
  },
  "plugin": ["opencode-qoder-provider/plugin"]
}
```

> **重要**：opencode UI 只渲染 `opencode.json` 中 `models` 字段显式声明的模型，
> provider 内部返回的模型目录不会自动出现在模型选择器里。请按需列出要使用的模型 ID。

### 3. 环境变量参考

| 变量 | 说明 |
|------|------|
| `QODER_PERSONAL_ACCESS_TOKEN` | Global 区域 PAT（必需，或由 provider options 提供） |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | CN 区域 PAT（CN 区优先读取） |
| `QODER_REGION` | 默认区域：`global`（默认）/ `cn` |
| `QODER_DEBUG` | 设为 `1` 启用 debug 级日志（见下文"日志"） |
| `QODER_CLI_PATH` | 显式指定 qodercli.js 路径（一般无需设置，插件自带 CLI） |

### 4. 使用

```bash
opencode
# TUI 中：
# /models 选择 Qoder 模型
```

## 可用模型

### Global

| 模型 ID | 名称 | 推理 | 上下文 |
|---------|------|:----:|-------:|
| `auto` | Qoder Auto | ✅ | 180K |
| `ultimate` | Qoder Ultimate | ✅ | 1M |
| `performance` | Qoder Performance | ✅ | 1M |
| `efficient` | Qoder Efficient | ❌ | 180K |
| `lite` | Qoder Lite | ❌ | 180K |
| `qmodel` | Qwen3.7 Plus | ❌ | 1M |
| `qmodel_latest` | Qwen3.7 Max | ❌ | 1M |
| `dmodel` | DeepSeek V4 Pro | ✅ | 1M |
| `kmodel` | Kimi K2.6 | ❌ | 256K |

### CN

| 模型 ID | 名称 | SDK Key | 推理 | 上下文 |
|---------|------|---------|:----:|-------:|
| `auto` | Auto · Qoder CN | auto | ✅ | 180K |
| `qwen3.7-max` | Qwen 3.7 Max | qmodel_latest | ✅ | 1M |
| `qwen3.7-plus` | Qwen 3.7 Plus | qmodel | ✅ | 1M |
| `qwen3.6-flash` | Qwen 3.6 Flash | q36fmodel | ✅ | 1M |
| `deepseek-v4-pro` | DeepSeek V4 Pro | dmodel | ✅ | 1M |
| `deepseek-v4-flash` | DeepSeek V4 Flash | dfmodel | ❌ | 1M |
| `glm-5.2` | GLM 5.2 | gm51model | ✅ | 200K |
| `kimi-k2.6` | Kimi K2.6 | kmodel | ✅ | 256K |
| `minimax-m2.7` | MiniMax M2.7 | mmodel | ❌ | 200K |

动态目录每小时刷新一次；获取失败时自动使用上表静态列表。

## 日志

- 位置：`~/.local/state/opencode/qoder-provider.log`
- 默认记录 INFO / ERROR 级别（`logInfo` / `logError`），**不会污染 TUI 渲染**
- 设置 `QODER_DEBUG=1` 后追加 DEBUG 级日志。**注意**：DEBUG 日志包含发往模型的
  prompt 片段（截断至 300 字符），可能含敏感代码/对话内容，排查后请关闭

## 项目结构

```
src/
├── index.ts        # Provider 工厂入口（opencode package 加载点）
├── model.ts        # LanguageModelV3 实现（核心：SDK query() 调用 + 工具边界终止）
├── mapper.ts       # SDKMessage → LanguageModelV3StreamPart 映射器（含工具名回映射）
├── context.ts      # Prompt → JSON transcript 回放 + transport notice
├── tool-bridge.ts  # 声明型 MCP 工具桥接（opencode 工具 → qodercli 可见不可执行）
├── models.ts       # 模型目录管理（HTTP API + 静态 fallback + 缓存）
├── cli-path.ts     # qodercli.js 路径解析（Windows file:// URL 兼容）
├── logger.ts       # 文件日志（避免污染 TUI）
└── plugin.ts       # opencode Plugin 入口（session 事件 / 缓存刷新）
```

## 与 pi-qoder-provider 的关系

工具桥接与 transcript 回放方案参考了
[marcomishi-dot/pi-qoder-provider](https://github.com/marcomishi-dot/pi-qoder-provider)，
模型目录 HTTP API 参考了
[simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder)。

| 方面 | pi-qoder-provider | 本包 |
|------|-------------------|------|
| 目标平台 | pi | opencode |
| 工具传递 | 声明型 MCP 桥接 | 声明型 MCP 桥接（同方案） |
| 多轮历史 | JSON transcript 回放 | JSON transcript 回放（同方案） |
| 进程终止 | 工具边界立即 terminate | 工具边界立即 close（同策略） |
| 模型目录 | 静态 | HTTP 动态 + 静态 fallback |

## 已知限制

1. **图片输入未实现**：所有模型当前只声明 `text` 输入。opencode 发来的图片/文件
   在 transcript 中降级为 `[file: mediaType]` 占位符，模型收不到图片数据
2. **usage 可能为空**：工具调用轮次的 `message_delta` 事件不携带 usage 信息，
   token 统计可能缺失（SDK 上游行为）
3. **每请求冷启动**：无状态设计意味着每次请求都 spawn 一个新的 qodercli 进程，
   首包延迟高于常驻连接
4. **动态模型目录可能 403**：COSY 签名对部分账号/区域可能被拒绝（排查中），
   此时自动回退静态模型列表，不影响正常使用
5. **Bun 运行时**：opencode 是 Bun 编译二进制，SDK 默认 WorkerTransport 不兼容，
   本包强制使用 ProcessTransport 运行 `@qoder-ai/qodercli` 自带的 JS 版 CLI

## 开发

```bash
npm install        # 安装依赖
npm run check      # TypeScript 类型检查
npm run build      # 构建 dist/（esbuild bundle + tsc 声明文件）
npm test           # 运行单元测试（vitest，无需网络/PAT）
node test-bridge.mjs  # 端到端测试（需要真实 PAT 与网络）
```

## License

MIT — 见 [LICENSE](./LICENSE)
