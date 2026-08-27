/**
 * cli-path.ts — 解析 qodercli.js 运行时路径
 *
 * opencode 使用 Bun 运行时，SDK 默认的 WorkerTransport 在 Bun 下不兼容
 * （Worker Thread 无法正确启动 qoder-worker-runtime）。
 *
 * 解决方案：强制使用 ProcessTransport，指向 @qoder-ai/qodercli 包内的
 * JS 版 CLI（bundle/qodercli.js），让 Bun/Node 作为解释器运行它。
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { logInfo, logError } from "./logger.js";

let cachedPath: string | null = null;

/**
 * 解析 qodercli.js 的绝对路径。
 *
 * 搜索策略（按优先级）：
 * 1. QODER_CLI_PATH 环境变量（用户显式指定）
 * 2. import.meta.url 相对路径查找（ESM 模式）
 * 3. 常见安装位置兜底
 */
export function resolveQoderCliPath(): string {
  if (cachedPath) return cachedPath;

  // 1. 环境变量
  const envPath = process.env.QODER_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    cachedPath = envPath;
    logInfo(`resolveQoderCliPath: using QODER_CLI_PATH=${cachedPath}`);
    return cachedPath;
  }

  // 2. 从当前模块位置向上查找 node_modules
  try {
    // fileURLToPath 才能在 Windows 上正确处理 file:///C:/... （
    // pathname 在 Windows 会产生 /C:/... 前导斜杠导致 existsSync 失败）
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      // bundle 后位于 dist/，node_modules 在上级（插件包根）
      join(currentDir, "..", "node_modules", "@qoder-ai", "qodercli", "bundle", "qodercli.js"),
      // 向上两级（嵌套安装）
      join(currentDir, "..", "..", "node_modules", "@qoder-ai", "qodercli", "bundle", "qodercli.js"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        cachedPath = c;
        logInfo(`resolveQoderCliPath: found at ${cachedPath}`);
        return cachedPath;
      }
    }
  } catch {
    // import.meta.url 不可用，继续尝试其他方式
  }

  // 3. createRequire.resolve（ESM 中替代 require.resolve）
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@qoder-ai/qodercli/bundle/qodercli.js");
    if (existsSync(resolved)) {
      cachedPath = resolved;
      logInfo(`resolveQoderCliPath: require.resolve found ${cachedPath}`);
      return cachedPath;
    }
  } catch {
    // 模块不可解析
  }

  // 4. 兜底：假设在 PATH 中能找到 qodercli
  const fallback = "qodercli";
  logError(`resolveQoderCliPath: could not resolve qodercli.js, falling back to "${fallback}"`);
  cachedPath = fallback;
  return cachedPath;
}
