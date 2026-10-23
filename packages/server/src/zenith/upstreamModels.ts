import type { DatabaseSync } from "node:sqlite";
import { getSetting, getSettingBool, setSetting } from "./database.js";
import { readRelayConfig, type RelayConfig } from "./settings.js";
import { ZenithError } from "./types.js";

/**
 * 上游模型列表：由服务端调用上游 OpenAI 兼容的 /v1/models 获取，
 * 缓存到 settings 并（默认）同步到 relay_models，客户端请求 /v1/models 时拿到同一份列表。
 */

const MODELS_CACHE_KEY = "upstream_models_cache";
const MODELS_FETCHED_AT_KEY = "upstream_models_fetched_at";
/** 列表超过 30 分钟未更新时，在 /v1/models 请求中尝试自动刷新。 */
const MODELS_CACHE_TTL_MS = 30 * 60 * 1000;

export function normalizeUpstreamBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export interface CachedUpstreamModels {
  models: string[];
  fetchedAt: number;
}

export function readCachedUpstreamModels(db: DatabaseSync): CachedUpstreamModels {
  let models: string[] = [];
  try {
    const parsed = JSON.parse(getSetting(db, MODELS_CACHE_KEY, "[]")) as unknown;
    if (Array.isArray(parsed)) {
      models = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  } catch {
    models = [];
  }
  const fetchedAt = Number.parseInt(getSetting(db, MODELS_FETCHED_AT_KEY, "0"), 10) || 0;
  return { models, fetchedAt };
}

export interface RefreshUpstreamModelsResult {
  models: string[];
  fetchedAt: number;
  syncedAllowlist: boolean;
}

/**
 * 请求上游 /v1/models 并落库。auto_sync_models 开启时同时写入 relay_models，
 * 让服务端允许列表、客户端展示和计费模型保持一致。
 */
export async function refreshUpstreamModels(
  db: DatabaseSync,
  options: { syncAllowlist?: boolean } = {},
): Promise<RefreshUpstreamModelsResult> {
  const config = readRelayConfig(db);
  if (!config.baseUrl || !config.apiKey) {
    throw new ZenithError(503, "请先配置上游 Base URL 与 API Key");
  }

  let payload: unknown;
  try {
    const response = await fetch(`${normalizeUpstreamBaseUrl(config.baseUrl)}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`上游返回 HTTP ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    throw new ZenithError(
      502,
      `获取上游模型失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
  const models = Array.isArray(data)
    ? data
        .map((item) =>
          item && typeof item === "object" ? (item as { id?: unknown }).id : undefined,
        )
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim())
    : [];
  const unique = Array.from(new Set(models)).sort((left, right) => left.localeCompare(right));
  if (unique.length === 0) {
    throw new ZenithError(502, "上游 /v1/models 未返回任何模型");
  }

  const fetchedAt = Date.now();
  setSetting(db, MODELS_CACHE_KEY, JSON.stringify(unique));
  setSetting(db, MODELS_FETCHED_AT_KEY, String(fetchedAt));

  const syncAllowlist =
    options.syncAllowlist ?? getSettingBool(db, "auto_sync_models", true);
  if (syncAllowlist) {
    setSetting(db, "relay_models", unique.join(","));
  }

  return { models: unique, fetchedAt, syncedAllowlist: syncAllowlist };
}

/** 客户端 /v1/models 的模型集合：上游缓存优先，空时回落到手工配置。 */
export function resolveServableModels(db: DatabaseSync, config: RelayConfig): string[] {
  const cached = readCachedUpstreamModels(db).models;
  const base =
    cached.length > 0
      ? cached
      : config.models.length > 0
        ? config.models
        : Object.keys(config.modelMap);
  if (config.models.length === 0) return base;
  return base.filter(
    (model) => config.models.includes(model) || Boolean(config.modelMap[model]),
  );
}

export async function refreshUpstreamModelsIfStale(db: DatabaseSync): Promise<void> {
  const config = readRelayConfig(db);
  if (!config.baseUrl || !config.apiKey) return;
  const cache = readCachedUpstreamModels(db);
  if (Date.now() - cache.fetchedAt < MODELS_CACHE_TTL_MS) return;
  try {
    await refreshUpstreamModels(db);
  } catch {
    // 刷新失败时继续使用旧缓存，模型列表接口不应因此 5xx。
  }
}
