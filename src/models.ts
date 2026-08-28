/**
 * models.ts — Qoder model catalog
 *
 * 模型目录管理：
 *  - 静态模型定义（仅 Qoder 官方路由模型）作为网络不可用时的最后兜底
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
  // CLI 使用 Encode=1 获取完整模型目录；缺少该参数时服务端返回缩减列表
  // （缺少 Cantus/cmodel 等模型）。参考 pi-provider-qoder。
  const url = `${getBaseUrl(region)}algo/api/v2/model/list?Encode=1`;
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
// 静态表只保留 Qoder 官方路由模型，作为网络不可用时的最后兕底；第三方模型
// （Qwen/Kimi/GLM/DeepSeek/MiniMax/Cantus 等）迭代频繁且 ID/上下文随服务端
// 变化，完整目录一律以动态获取（fetchModelCatalog）为准。
// 注意：所有模型统一声明 input: ["text"]——图片数据当前不会向 qodercli 传输
// （context.ts 使用占位符降级），声明 image 会导致 opencode 向模型发送
// 无法被处理的图片。待实现图片传输后再按各模型实际能力放开。
export const staticGlobalModels: QoderModelDef[] = [
  { id: "auto",        name: "Qoder Auto",        reasoning: true,  input: ["text"], contextWindow: 180_000,   maxTokens: 32768, sdkModelId: "auto" },
  { id: "ultimate",    name: "Qoder Ultimate",    reasoning: true,  input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "ultimate" },
  { id: "performance", name: "Qoder Performance", reasoning: true,  input: ["text"], contextWindow: 1_000_000, maxTokens: 32768, sdkModelId: "performance" },
  { id: "efficient",   name: "Qoder Efficient",   reasoning: false, input: ["text"], contextWindow: 180_000,   maxTokens: 32768, sdkModelId: "efficient" },
  { id: "lite",        name: "Qoder Lite",        reasoning: false, input: ["text"], contextWindow: 180_000,   maxTokens: 32768, sdkModelId: "lite" },
];

// CN 静态兕底同样只保留官方路由模型 auto；第三方模型由动态目录提供
export const staticCnModels: QoderModelDef[] = [
  { id: "auto", name: "Auto · Qoder CN", reasoning: true, input: ["text"], contextWindow: 180_000, maxTokens: 32768, sdkModelId: "auto" },
];

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

// ─── COSY Auth Headers（参考 pi-provider-qoder 的完整签名实现）──────────
// 注意：缺少任何一个 Cosy-* 头（尤其 Cosy-Sigpath/Bodyhash/Bodylength）
// 或使用过老的 cosyVersion 都会导致 model list 返回 403 "Signature invalid"。
const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

// 与当前 Qoder CLI 目录协议保持一致；旧值会导致目录缩减或签名校验失败
const QODER_IDE_VERSION = "1.1.3";
const QODER_CLIENT_TYPE = "5";
const QODER_DATA_POLICY = "disagree";
const QODER_LOGIN_VERSION = "v2";
const QODER_MACHINE_TYPE = "5";
const QODER_MACHINE_OS =
  process.platform === "win32"
    ? process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows"
    : process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";

/** 机器 ID：优先读官方 CLI/参考实现已写入的文件，否则生成并持久化 */
function getMachineId(): string {
  const paths = [
    join(homedir(), ".qoder", ".auth", "machine_id"),
    join(homedir(), ".pi", "agent", "qoder-machine-id"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const val = readFileSync(p, "utf8").trim();
        if (val) return val;
      } catch {}
    }
  }
  const newId = crypto.randomUUID();
  try {
    mkdirSync(dirname(paths[1]), { recursive: true });
    writeFileSync(paths[1], newId, "utf8");
  } catch {}
  return newId;
}

function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) {
    sigPath = sigPath.substring("/algo".length);
  }
  return sigPath;
}

interface CosyCredentials {
  userID: string;
  authToken: string;
  name?: string;
  email?: string;
}

function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
): Record<string, string> {
  const parsed = safeValidateURL(requestURL, "buildAuthHeaders");

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || "",
  };
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey),
  ).toString("base64");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadB64 = Buffer.from(JSON.stringify({
    version: "v1",
    requestId: crypto.randomUUID(),
    info: infoB64,
    cosyVersion: QODER_IDE_VERSION,
    ideVersion: "",
  })).toString("base64");
  const sigPath = computeSigPath(requestURL);

  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString("utf8") : body) : "";
  const sig = crypto.createHash("md5")
    .update(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`)
    .digest("hex");

  const bodyHash = crypto.createHash("md5").update(body || "").digest("hex");
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";
  const machineID = getMachineId();

  log("buildAuthHeaders: url=", requestURL, "sigPath=", sigPath);

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": QODER_IDE_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": QODER_MACHINE_TYPE,
    "Cosy-Machineos": QODER_MACHINE_OS,
    "Cosy-Clienttype": QODER_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyLen,
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": QODER_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": QODER_LOGIN_VERSION,
    "X-Request-Id": crypto.randomUUID(),
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
  // COSY info 加密体需要真实 name/email（与 uid 一同参与服务端校验）
  const userName = userInfo?.name || userInfo?.data?.name || userInfo?.user?.name || "";
  const userEmail = userInfo?.email || userInfo?.data?.email || userInfo?.user?.email || "";
  log("fetchModelCatalog: userID=", userID, "name=", userName ? "(set)" : "(empty)", "email=", userEmail ? "(set)" : "(empty)");

  // Step 3: 获取模型列表 (使用 COSY 签名)
  const modelURL = getModelListURL(region);
  log("fetchModelCatalog: fetching model list at", modelURL);
  safeValidateURL(modelURL, "fetchModelCatalog-modelList");

  const headers = buildAuthHeaders(null, modelURL, {
    userID,
    authToken: jobToken,
    name: userName,
    email: userEmail,
  });
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

    // CN 区域用 CN_FRIENDLY 做友好命名；映射未覆盖的新 key 仍收录（以 key/
    // display_name 呈现），保证动态目录完整——第三方模型以服务端返回为准
    const friendly = region === "cn"
      ? Object.values(CN_FRIENDLY).find((f) => f.sdkKey === key)
      : undefined;
    models.push({
      id: friendly?.id ?? key,
      name: friendly?.name ?? display,
      reasoning: isReasoning,
      input: ["text"],
      contextWindow: ctxLen,
      maxTokens: (entry.max_output_tokens as number) || 32768,
      sdkModelId: key,
    });
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
