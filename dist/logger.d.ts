export declare const DEBUG: boolean;
/** debug 级别日志（需 QODER_DEBUG=1） */
export declare function log(...args: unknown[]): void;
/** 错误日志（始终写入） */
export declare function logError(...args: unknown[]): void;
/** 信息日志（始终写入） */
export declare function logInfo(...args: unknown[]): void;
