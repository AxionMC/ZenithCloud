import type { DatabaseSync } from "node:sqlite";
import { getSetting, getSettingBool, newId } from "./database.js";
import { chargedTokensFor, type UsageTokens } from "./pricing.js";
import { consumeQuota, getQuota } from "./quota.js";
import { findSessionUser } from "./session.js";
import { isRelayConfigured, readRelayConfig, type RelayConfig } from "./settings.js";
import {
  normalizeUpstreamBaseUrl,
  refreshUpstreamModelsIfStale,
  resolveServableModels,
} from "./upstreamModels.js";
import type { QuotaSnapshot, ZenithUserRow } from "./types.js";

/**
 * OpenAI 兼容中转：账号登录态鉴权 → 订阅/Auto 策略 → 改写模型 → 透传上游 → 按 usage 计费扣额度。
 * 不向用户发放 API Key：Authorization Bearer 直接使用邮箱账号的登录会话令牌，
 * 同源浏览器也可使用登录时下发的 HttpOnly Cookie。
 */

const AUTO_MODEL_IDS = new Set(["auto", "zenith-auto", "zenithcloud-auto"]);
const AUTO_MODEL_ID = "auto";

/** 内置客户端本地网关的固定标识；仅在 ZENITH_LOCAL_GATEWAY=1 时可用。 */
const LOCAL_GATEWAY_KEY = "zenith-local-gateway";
const LOCAL_GATEWAY_ENV = "ZENITH_LOCAL_GATEWAY";
/**
 * 默认只允许回环地址使用本地网关。客户端与服务器不在同一台机器时，
 * 可显式设置 ZENITH_LOCAL_GATEWAY_ALLOW_REMOTE=1 放行（共享固定标识，风险自担）。
 */
const LOCAL_GATEWAY_ALLOW_REMOTE_ENV = "ZENITH_LOCAL_GATEWAY_ALLOW_REMOTE";

type AutoDifficulty = "simple" | "medium" | "complex";

function errorResponse(status: number, message: string, type = "invalid_request_error"): Response {
  return new Response(
    JSON.stringify({ error: { message, type, code: `zenith_${status}` } }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function extractUsageBreakdown(payload: unknown): UsageTokens | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;

  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens;
  const total = (usage as { total_tokens?: unknown }).total_tokens;

  const promptTokens =
    typeof prompt === "number" && Number.isFinite(prompt) ? Math.max(0, Math.floor(prompt)) : null;
  const completionTokens =
    typeof completion === "number" && Number.isFinite(completion)
      ? Math.max(0, Math.floor(completion))
      : null;
  const totalTokens =
    typeof total === "number" && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : null;

  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  if (promptTokens !== null && completionTokens !== null) {
    return {
      promptTokens,
      completionTokens,
      totalTokens: totalTokens ?? promptTokens + completionTokens,
    };
  }
  if (totalTokens === null) {
    const resolvedPrompt = promptTokens ?? 0;
    const resolvedCompletion = completionTokens ?? 0;
    return {
      promptTokens: resolvedPrompt,
      completionTokens: resolvedCompletion,
      totalTokens: resolvedPrompt + resolvedCompletion,
    };
  }
  // 上游只给 total 时按 50/50 拆分，避免把输出按输入价低估。
  const half = Math.floor(totalTokens / 2);
  return { promptTokens: half, completionTokens: totalTokens - half, totalTokens };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface AutoModelLadder {
  simple: string;
  medium: string;
  complex: string;
}

function readAutoModelLadder(db: DatabaseSync): AutoModelLadder {
  const parsed = parseJsonObject(getSetting(db, "auto_model_ladder", "{}"));
  const read = (key: string): string =>
    typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
  return { simple: read("simple"), medium: read("medium"), complex: read("complex") };
}

/**
 * 难度评分只使用请求本身的结构特征，不调用额外模型：
 * 上下文长度、消息轮数、是否带工具、代码块数量。分数越高越可能走强模型。
 */
export function estimateAutoDifficulty(payload: Record<string, unknown> | null): AutoDifficulty {
  if (!payload) return "simple";
  const messages = Array.isArray(payload["messages"]) ? payload["messages"] : [];
  const text = JSON.stringify(payload["messages"] ?? payload["input"] ?? "");
  const chars = text.length;
  const messageCount = messages.length;
  const hasTools =
    (Array.isArray(payload["tools"]) && payload["tools"].length > 0) ||
    payload["tool_choice"] !== undefined;
  const codeFences = (text.match(/```/g) ?? []).length;

  let score = 0;
  if (chars > 60_000) score += 3;
  else if (chars > 20_000) score += 2;
  else if (chars > 6_000) score += 1;
  if (messageCount > 40) score += 2;
  else if (messageCount > 12) score += 1;
  if (hasTools) score += 1;
  if (codeFences >= 4) score += 1;

  return score >= 3 ? "complex" : score >= 1 ? "medium" : "simple";
}

function resolveAutoModel(
  db: DatabaseSync,
  difficulty: AutoDifficulty,
  config: RelayConfig,
): string | null {
  const ladder = readAutoModelLadder(db);
  const chosen = ladder[difficulty].trim();
  if (chosen) return chosen;
  const fallback = ladder.medium || ladder.simple || ladder.complex;
  if (fallback) return fallback;
  return config.models[0] ?? null;
}

function recordUsage(
  db: DatabaseSync,
  input: {
    userId: string;
    apiKeyId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    chargedTokens: number;
    source: string;
  },
): void {
  db.prepare(
    "INSERT INTO usage_logs (id, user_id, api_key_id, model, prompt_tokens, completion_tokens, total_tokens, charged_tokens, source, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    newId("use"),
    input.userId,
    input.apiKeyId,
    input.model,
    input.promptTokens,
    input.completionTokens,
    input.totalTokens,
    input.chargedTokens,
    input.source,
    Date.now(),
  );
}

/**
 * 扣费失败（本次用量超过剩余额度）时把剩余额度全部扣完，
 * 不能因为单次超量就变成免费调用。
 */
function chargeQuota(db: DatabaseSync, userId: string, amount: number): void {
  if (amount <= 0) return;
  const result = consumeQuota(db, userId, amount);
  if (!result.ok && result.snapshot.totalRemaining > 0) {
    consumeQuota(db, userId, result.snapshot.totalRemaining);
  }
}

function readRequestToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;

  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("zenith_session=")) continue;
    try {
      return decodeURIComponent(trimmed.slice("zenith_session=".length));
    } catch {
      return "";
    }
  }
  return "";
}

interface RelayIdentity {
  user: ZenithUserRow;
  viaLocalGateway: boolean;
}

export interface RelayRequestOptions {
  /** 请求来自本机回环地址时才允许固定本地网关标识。 */
  localGatewayAllowed?: boolean;
}

function resolveRelayIdentity(
  db: DatabaseSync,
  request: Request,
  localGatewayAllowed: boolean,
): RelayIdentity | null {
  const token = readRequestToken(request);
  if (!token) return null;

  // 内置客户端本地网关：固定标识 + 环境变量显式开启；
  // 默认只接受回环地址，远程客户端需额外开启 ALLOW_REMOTE。
  // 使用最近一次邮箱登录的账号计费，避免客户端再次暴露 Key。
  const gatewayEnabled = process.env[LOCAL_GATEWAY_ENV]?.trim() === "1";
  const remoteGatewayAllowed =
    process.env[LOCAL_GATEWAY_ALLOW_REMOTE_ENV]?.trim() === "1";
  if (
    token === LOCAL_GATEWAY_KEY &&
    gatewayEnabled &&
    (localGatewayAllowed || remoteGatewayAllowed)
  ) {
    const userId = getSetting(db, "last_active_user_id").trim();
    if (!userId) return null;
    const row = db
      .prepare("SELECT * FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as unknown as ZenithUserRow | undefined;
    return row ? { user: row, viaLocalGateway: true } : null;
  }

  const user = findSessionUser(db, token);
  return user ? { user, viaLocalGateway: false } : null;
}

function isAutoOnlyUser(
  db: DatabaseSync,
  quota: QuotaSnapshot,
): boolean {
  return getSettingBool(db, "free_users_auto_only", true) && !quota.subscriptionActive;
}

function modelResponseHeaders(resolvedModel: string, auto: boolean): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "x-zenith-model": resolvedModel,
    "x-zenith-auto": auto ? "1" : "0",
  };
}

function listModelsResponse(
  db: DatabaseSync,
  config: RelayConfig,
  autoOnly: boolean,
): Response {
  const allowed = resolveServableModels(db, config);
  const ids = autoOnly ? [AUTO_MODEL_ID] : [AUTO_MODEL_ID, ...allowed];
  return new Response(
    JSON.stringify({
      object: "list",
      data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "zenithcloud" })),
    }),
    { headers: modelResponseHeaders(AUTO_MODEL_ID, true) },
  );
}

export async function handleRelayRequest(
  db: DatabaseSync,
  request: Request,
  options: RelayRequestOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const identity = resolveRelayIdentity(db, request, options.localGatewayAllowed === true);
  if (!identity) {
    return errorResponse(401, "请先使用邮箱账号登录客户端", "authentication_error");
  }
  const userId = identity.user.id;

  if (!isRelayConfigured(db)) {
    return errorResponse(503, "服务端尚未配置上游中转", "server_error");
  }

  const quota = getQuota(db, userId);
  if (!quota) {
    return errorResponse(401, "登录已失效，请重新登录", "authentication_error");
  }
  if (getSettingBool(db, "require_subscription_for_relay", false) && !quota.subscriptionActive) {
    return errorResponse(403, "模型访问需要先购买订阅", "subscription_required");
  }
  if (quota.totalRemaining <= 0) {
    return errorResponse(402, "额度不足，请购买订阅或联系管理员", "insufficient_quota");
  }

  const config = readRelayConfig(db);
  const autoOnly = isAutoOnlyUser(db, quota);

  if (url.pathname === "/v1/models" || url.pathname === "/v1/models/") {
    // 客户端每次打开模型列表时顺带同步上游；失败继续用缓存。
    await refreshUpstreamModelsIfStale(db);
    return listModelsResponse(db, readRelayConfig(db), autoOnly);
  }

  const upstreamPath = url.pathname.replace(/^\/v1/, "");
  const method = request.method.toUpperCase();
  const rawBody = method === "GET" || method === "HEAD" ? "" : await request.text();

  let requestPayload: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        requestPayload = parsed as Record<string, unknown>;
      }
    } catch {
      requestPayload = null;
    }
  }

  const requestedModel =
    requestPayload && typeof requestPayload["model"] === "string"
      ? requestPayload["model"].trim()
      : "";
  const requestedAuto = !requestedModel || AUTO_MODEL_IDS.has(requestedModel);
  // 免费用户无法通过改请求绕过：服务端强制按 Auto 处理。
  const useAuto = requestedAuto || autoOnly;

  let upstreamModel = "";
  if (useAuto) {
    const difficulty = estimateAutoDifficulty(requestPayload);
    const resolved = resolveAutoModel(db, difficulty, config);
    if (!resolved) {
      return errorResponse(
        503,
        "服务端未配置 Auto 模型阶梯（auto_model_ladder）",
        "server_error",
      );
    }
    upstreamModel = resolved;
  } else {
    if (config.models.length > 0 && !config.models.includes(requestedModel)) {
      return errorResponse(400, `模型 ${requestedModel} 不在允许列表中`);
    }
    upstreamModel = requestedModel;
  }

  // Auto 选出的模型同样要受允许列表约束，避免配置错误绕过模型白名单。
  if (config.models.length > 0 && !config.models.includes(upstreamModel)) {
    return errorResponse(400, `模型 ${upstreamModel} 不在允许列表中`);
  }
  const mappedModel = config.modelMap[upstreamModel] ?? upstreamModel;

  if (requestPayload) {
    requestPayload["model"] = mappedModel;
    if (requestPayload["stream"] === true && upstreamPath === "/chat/completions") {
      const streamOptions =
        requestPayload["stream_options"] && typeof requestPayload["stream_options"] === "object"
          ? (requestPayload["stream_options"] as Record<string, unknown>)
          : {};
      requestPayload["stream_options"] = { ...streamOptions, include_usage: true };
    }
  }

  const forwardBody = requestPayload ? JSON.stringify(requestPayload) : rawBody || undefined;
  const promptTokens = estimateTokens(
    typeof requestPayload?.["messages"] === "object"
      ? JSON.stringify(requestPayload["messages"])
      : typeof requestPayload?.["input"] === "string"
        ? String(requestPayload["input"])
        : rawBody,
  );

  const upstreamUrl = `${normalizeUpstreamBaseUrl(config.baseUrl)}${upstreamPath}${url.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        accept: request.headers.get("accept") ?? "*/*",
      },
      ...(forwardBody ? { body: forwardBody } : {}),
    });
  } catch (error) {
    return errorResponse(
      502,
      `上游中转不可用：${error instanceof Error ? error.message : String(error)}`,
      "upstream_error",
    );
  }

  const upstreamType = upstream.headers.get("content-type") ?? "application/json";
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstreamType },
    });
  }

  const wantsStream =
    upstreamType.includes("text/event-stream") || requestPayload?.["stream"] === true;
  const responseSource = useAuto ? "relay-auto" : "relay";

  if (!wantsStream) {
    const text = await upstream.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const usage =
      extractUsageBreakdown(parsed) ?? {
        promptTokens,
        completionTokens: estimateTokens(text),
        totalTokens: promptTokens + estimateTokens(text),
      };
    const chargedTokens = chargedTokensFor(db, upstreamModel, usage);
    chargeQuota(db, userId, chargedTokens);
    recordUsage(db, {
      userId,
      apiKeyId: "",
      model: upstreamModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      chargedTokens,
      source: responseSource,
    });

    let responseText = text;
    if (useAuto && parsed && typeof parsed === "object") {
      // 客户端按请求的模型展示；实际使用的上游模型放在响应头 x-zenith-model。
      (parsed as Record<string, unknown>)["model"] = AUTO_MODEL_ID;
      responseText = JSON.stringify(parsed);
    }

    return new Response(responseText, {
      status: upstream.status,
      headers: {
        ...modelResponseHeaders(upstreamModel, useAuto),
        "x-zenith-charged-tokens": String(chargedTokens),
      },
    });
  }

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let tail = "";
  let usageFromStream: UsageTokens | null = null;
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    const usage =
      usageFromStream ?? {
        promptTokens,
        completionTokens: estimateTokens(tail),
        totalTokens: promptTokens + estimateTokens(tail),
      };
    const chargedTokens = chargedTokensFor(db, upstreamModel, usage);
    chargeQuota(db, userId, chargedTokens);
    recordUsage(db, {
      userId,
      apiKeyId: "",
      model: upstreamModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      chargedTokens,
      source: responseSource,
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize();
          controller.close();
          return;
        }
        const text = decoder.decode(value, { stream: true });
        tail = (tail + text).slice(-200_000);
        const matches = [...tail.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)];
        if (matches.length > 0) {
          const candidate = matches[matches.length - 1]?.[1];
          if (candidate) {
            try {
              usageFromStream = extractUsageBreakdown({ usage: JSON.parse(candidate) });
            } catch {
              // 流式块可能被截断，等后续块再解析。
            }
          }
        }
        controller.enqueue(value);
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    cancel(reason) {
      finalize();
      void reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      ...modelResponseHeaders(upstreamModel, useAuto),
      "content-type": upstreamType,
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
