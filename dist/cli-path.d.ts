/**
 * 解析 qodercli.js 的绝对路径。
 *
 * 搜索策略（按优先级）：
 * 1. QODER_CLI_PATH 环境变量（用户显式指定）
 * 2. import.meta.url 相对路径查找（ESM 模式）
 * 3. 常见安装位置兜底
 */
export declare function resolveQoderCliPath(): string;
