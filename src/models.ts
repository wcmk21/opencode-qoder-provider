/**
 * models.ts — Qoder model catalog
 *
 * 模型目录管理：
 *  - 静态模型定义（Global + CN）作为 fallback
 *  - 从 Qoder HTTP API 动态获取模型列表（参考 pi-provider-qoder）
 *  - 本地文件缓存，1小时过期
 *
 * 注意：模型列表通过 HTTP API 获取，但 LLM 交互通过 SDK query() 完成。
 */
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log, logError, DEBUG } from "./logger.js";

/** 防御性 URL 校验：先尝试构造 URL 对象，失败时打印详细诊断 */
function safeValidateURL(url: string, context: string): URL {
  try {
    const parsed = new URL(url);
    log(`URL OK [${context}]:`, url);
    return parsed;
  } catch (err) {
    logError(`[qoder-models] Invalid URL [${context}]:`, url);
    logError("[qoder-models]   Error:", (err as Error).message);
    if (DEBUG && (err as Error).stack) logError((err as Error).stack);
    throw err;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────
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

// ─── Region ─────────────────────────────────────────────────────────────────
export type QoderRegion = "global" | "cn";

export function resolveRegion(override?: string): QoderRegion {
  const env =
    process.env.QODER_REGION ||
    process.env.QODER_BACKEND ||
    process.env.QODER_MODE ||
    "";
  const mode = (override || env).toLowerCase();
  if (["cn", "china", "qodercn", "qoder-cn"].includes(mode)) return "cn";
  return "global";
}

// ─── Endpoints (参考 pi-provider-qoder) ─────────────────────────────────────
function getBaseUrl(region: QoderRegion): string {
  const url = region === "cn"
    ? "https://gateway.qoder.com.cn/"
    : "https://api3.qoder.sh/";
  log(`getBaseUrl(${region}):`, url);
  return url;
}

function getModelListURL(region: QoderRegion): string {
  const url = `${getBaseUrl(region)}algo/api/v2/model/list`;
  log(`getModelListURL(${region}):`, url);
  return url;
}

function getOpenApiUrl(region: QoderRegion): string {
  const url = region === "cn"
    ? "https://openapi.qoder.com.cn"
    : "https://openapi.qoder.sh";
  log(`getOpenApiUrl(${region}):`, url);
  return url;
}

function getExchangeURL(region: QoderRegion): string {
  const url = `${getOpenApiUrl(region)}/api/v1/jobToken/exchange`;
  log(`getExchangeURL(${region}):`, url);
  return url;
}

// ─── CN Model Aliases (参考 pi-provider-qoder) ──────────────────────────────
const CN_FRIENDLY: Record<string, { id: string; name: string; sdkKey: string }> = {
  auto:            { id: "auto",            name: "Auto · Qoder CN",            sdkKey: "auto" },
  "qwen3.7-max":   { id: "qwen3.7-max",    name: "Qwen 3.7 Max · Qoder CN",    sdkKey: "qmodel_latest" },
  "qwen3.7-plus":  { id: "qwen3.7-plus",   name: "Qwen 3.7 Plus · Qoder CN",   sdkKey: "qmodel" },
  "qwen3.6-flash": { id: "qwen3.6-flash",  name: "Qwen 3.6 Flash · Qoder CN",  sdkKey: "q36fmodel" },
  "deepseek-v4-pro":  { id: "deepseek-v4-pro",  name: "DeepSeek V4 Pro · Qoder CN",  sdkKey: "dmodel" },
  "deepseek-v4-flash": { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · Qoder CN", sdkKey: "dfmodel" },
  "glm-5.2":       { id: "glm-5.2",        name: "GLM 5.2 · Qoder CN",         sdkKey: "gm51model" },
  "kimi-k2.6":     { id: "kimi-k2.6",      name: "Kimi K2.6 · Qoder CN",       sdkKey: "kmodel" },
  "minimax-m2.7":  { id: "minimax-m2.7",   name: "MiniMax M2.7 · Qoder CN",    sdkKey: "mmodel" },
};

// ─── Static Fallback Models ─────────────────────────────────────────────────
// 注意：所有模型统一声明 input: ["text"]——图片数据当前不会向 qodercli 传输
// （context.ts 使用占位符降级），声明 image 会导致 opencode 向模型发送
// 无法被处理的图片。待实现图片传输后再按各模型实际能力放开。
export const staticGlobalModels: QoderModelDef[] = [
  { id: "auto",        name: "Qoder Auto",        reasoning: true,  input: ["text"], contextWindow: 180_000,  maxTokens: 32768, sdkModelId: "auto" },
  { id: "ultimate",    name: "Qoder Ultimate",    reasoning: true,  input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "ultimate" },
  { id: "performance", name: "Qoder Performance", reasoning: true,  input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "performance" },
  { id: "efficient",   name: "Qoder Efficient",   reasoning: false, input: ["text"], contextWindow: 180_000,  maxTokens: 32768, sdkModelId: "efficient" },
  { id: "lite",        name: "Qoder Lite",        reasoning: false, input: ["text"],          contextWindow: 180_000,  maxTokens: 32768, sdkModelId: "lite" },
  { id: "qmodel",      name: "Qwen3.7 Plus",      reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "qmodel" },
  { id: "qmodel_latest", name: "Qwen3.7 Max",     reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "qmodel_latest" },
  { id: "dmodel",      name: "DeepSeek V4 Pro",   reasoning: true,  input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "dmodel" },
  { id: "kmodel",      name: "Kimi K2.6",         reasoning: false, input: ["text"], contextWindow: 256_000,  maxTokens: 32768, sdkModelId: "kmodel" },
];

export const staticCnModels: QoderModelDef[] = Object.values(CN_FRIENDLY).map((f) => ({
  id: f.id,
  name: f.name,
  reasoning: ["auto", "qmodel_latest", "qmodel", "q36fmodel", "dmodel", "gm51model", "kmodel"].includes(f.sdkKey),
  input: ["text"],
  contextWindow: f.sdkKey === "gm51model" || f.sdkKey === "mmodel" ? 200_000 : f.sdkKey === "kmodel" ? 256_000 : 1_000_000,
  maxTokens: 32768,
  sdkModelId: f.sdkKey,
}));

// ─── Cache (参考 pi-provider-qoder 的缓存模式) ──────────────────────────────
function getCachePath(region: QoderRegion): string {
  return join(
    homedir(),
    ".opencode",
    region === "cn" ? "qoder-cn-models.json" : "qoder-models.json",
  );
}

interface ModelCache {
  updatedAt: number;
  models: QoderModelDef[];
}

export function getCachedModels(region: QoderRegion): QoderModelDef[] {
  const p = getCachePath(region);
  if (existsSync(p)) {
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (data?.models?.length) return data.models;
    } catch {}
  }
  return region === "cn" ? staticCnModels : staticGlobalModels;
}

function isCacheStale(region: QoderRegion): boolean {
  const p = getCachePath(region);
  if (!existsSync(p)) return true;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return Date.now() - (data.updatedAt || 0) > 3_600_000;
  } catch {
    return true;
  }
}

// ─── Fetch with timeout helper ────────────────────────────────────────────────
function fetchWithTimeout(url: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = 10_000, ...fetchInit } = init;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...fetchInit, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

// ─── PAT → Job Token Exchange (参考 pi-provider-qoder) ──────────────────────
async function exchangePatForJobToken(
  pat: string,
  region: QoderRegion,
): Promise<string> {
  const exchangeURL = getExchangeURL(region);
  log("exchangePatForJobToken: exchanging PAT for jobToken at", exchangeURL);
  safeValidateURL(exchangeURL, "exchangePatForJobToken");

  let res: Response;
  try {
    res = await fetchWithTimeout(exchangeURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "opencode-qoder-provider",
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
      body: JSON.stringify({ personal_token: pat }),
    });
  } catch (err) {
    logError("[qoder-models] exchangePatForJobToken fetch failed:");
    logError("[qoder-models]   URL:", exchangeURL);
    logError("[qoder-models]   Error:", (err as Error).message);
    if (DEBUG && (err as Error).stack) logError((err as Error).stack);
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PAT exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("PAT exchange returned no token");
  log("exchangePatForJobToken: success, got jobToken");
  return data.token;
}

// ─── COSY Auth Headers (参考 pi-provider-qoder，仅用于模型列表请求) ─────────
const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function buildMinimalAuthHeaders(
  requestURL: string,
  userID: string,
  authToken: string,
): Record<string, string> {
  log("buildMinimalAuthHeaders: requestURL=", requestURL, "userID=", userID);

  // 防御性 URL 校验
  const parsed = safeValidateURL(requestURL, "buildMinimalAuthHeaders");

  // 简化的 COSY 签名——仅用于模型列表 GET 请求
  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = { uid: userID, security_oauth_token: authToken, name: "", aid: "", email: "" };
  const infoB64 = crypto
    .createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey))
    .update(JSON.stringify(userInfo), "utf8", "base64");
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey),
  ).toString("base64");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) sigPath = sigPath.substring(5);
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: crypto.randomUUID(), info: infoB64, cosyVersion: "1.0.0", ideVersion: "" }),
  ).toString("base64");
  const sig = crypto
    .createHash("md5")
    .update(`${payload}\n${cosyKey}\n${timestamp}\n\n${sigPath}`)
    .digest("hex");

  return {
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": "1.0.0",
    "Cosy-Clienttype": "5",
    "Login-Version": "v2",
  };
}

// ─── 动态获取模型列表 (参考 pi-provider-qoder 的 API 调用方式) ──────────────
export async function fetchModelCatalog(
  pat: string,
  region: QoderRegion,
): Promise<QoderModelDef[]> {
  log("fetchModelCatalog: start, region=", region, "pat=", pat ? pat.slice(0, 4) + "..." : "(empty)");

  // 缓存新鲜（<1h）时跳过远端 3 步请求（exchange → userinfo → model list），
  // 避免 provider 启动与每次 session.idle 都白打一轮请求（403 场景尤其浪费）
  if (!isCacheStale(region)) {
    const cached = getCachedModels(region);
    log(`fetchModelCatalog: cache fresh (${cached.length} models), skipping remote fetch`);
    return cached;
  }

  // Step 1: PAT → job token
  const jobToken = await exchangePatForJobToken(pat, region);

  // Step 2: 获取 user info (需要 userID 来构建 COSY headers)
  const openApi = getOpenApiUrl(region);
  const userInfoURL = `${openApi}/api/v1/userinfo`;
  log("fetchModelCatalog: fetching userinfo at", userInfoURL);
  safeValidateURL(userInfoURL, "fetchModelCatalog-userinfo");

  let userRes: Response;
  try {
    userRes = await fetchWithTimeout(userInfoURL, {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": "opencode-qoder-provider",
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
    });
  } catch (err) {
    logError("[qoder-models] fetchModelCatalog userinfo fetch failed:");
    logError("[qoder-models]   URL:", userInfoURL);
    logError("[qoder-models]   Error:", (err as Error).message);
    if (DEBUG && (err as Error).stack) logError((err as Error).stack);
    throw err;
  }

  const userInfo = userRes.ok ? await userRes.json() : {};
  // userinfo 响应结构未完全确认，逐层探测常见字段，避免认证异常时
  // 静默落 "unknown" 导致 COSY 签名携带无效 uid
  const userID =
    userInfo?.id ||
    userInfo?.data?.id ||
    userInfo?.user?.id ||
    userInfo?.uid ||
    userInfo?.data?.uid ||
    "unknown";
  log("fetchModelCatalog: userID=", userID);

  // Step 3: 获取模型列表 (使用 COSY 签名)
  const modelURL = getModelListURL(region);
  log("fetchModelCatalog: fetching model list at", modelURL);
  safeValidateURL(modelURL, "fetchModelCatalog-modelList");

  const headers = buildMinimalAuthHeaders(modelURL, userID, jobToken);
  let modelRes: Response;
  try {
    modelRes = await fetchWithTimeout(modelURL, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
    });
  } catch (err) {
    logError("[qoder-models] fetchModelCatalog model list fetch failed:");
    logError("[qoder-models]   URL:", modelURL);
    logError("[qoder-models]   Error:", (err as Error).message);
    if (DEBUG && (err as Error).stack) logError((err as Error).stack);
    throw err;
  }

  if (!modelRes.ok) {
    log("fetchModelCatalog: model list response not ok, status=", modelRes.status);
    return getCachedModels(region);
  }

  const data = (await modelRes.json()) as { chat?: Array<Record<string, unknown>> };
  const chatModels = data.chat || [];
  if (!chatModels.length) return getCachedModels(region);

  const models: QoderModelDef[] = [];
  for (const entry of chatModels) {
    const key = entry.key as string;
    if (!key || !entry.enable) continue;
    const display = (entry.display_name as string) || key;
    // is_vl 字段暂不启用（图片传输未实现，所有模型声明 text-only）
    const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;

    let ctxLen = (entry.max_input_tokens as number) || 180_000;
    if (entry.context_config && typeof entry.context_config === "object") {
      for (const v of Object.values(entry.context_config as Record<string, { token_count?: number }>)) {
        if (v?.token_count && v.token_count > ctxLen) ctxLen = v.token_count;
      }
    }

    if (region === "cn") {
      // CN: 使用友好名称映射
      const friendly = Object.values(CN_FRIENDLY).find((f) => f.sdkKey === key);
      if (friendly) {
        models.push({
          id: friendly.id,
          name: friendly.name,
          reasoning: isReasoning,
          input: ["text"],
          contextWindow: ctxLen,
          maxTokens: (entry.max_output_tokens as number) || 32768,
          sdkModelId: key,
        });
      }
    } else {
      models.push({
        id: key,
        name: display,
        reasoning: isReasoning,
        input: ["text"],
        contextWindow: ctxLen,
        maxTokens: (entry.max_output_tokens as number) || 32768,
        sdkModelId: key,
      });
    }
  }

  // 确保 auto 存在
  if (!models.some((m) => m.id === "auto")) {
    models.unshift({
      id: "auto",
      name: region === "cn" ? "Auto · Qoder CN" : "Qoder Auto",
      reasoning: true,
      input: ["text"],
      contextWindow: 180_000,
      maxTokens: 32768,
      sdkModelId: "auto",
    });
  }

  // 缓存
  if (models.length > 0) {
    const cache: ModelCache = { updatedAt: Date.now(), models };
    try {
      const p = getCachePath(region);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(cache), "utf-8");
    } catch {}
  }

  log("fetchModelCatalog: done, total models=", models.length);
  return models;
}

/** 查找模型定义 */
export function findModel(
  modelId: string,
  region: QoderRegion,
): QoderModelDef | undefined {
  const models = getCachedModels(region);
  return models.find((m) => m.id === modelId);
}
