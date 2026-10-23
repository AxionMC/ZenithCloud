import { getSetting, getSettingBool, getSettingInt, setSetting } from "./database.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * 服务端可配置项的唯一清单。新增配置必须同时加入 DEFAULT_SETTINGS，
 * 管理端 PUT /api/admin/settings 只接受这里的 key。
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  registration_enabled: "true",
  signup_bonus_quota: "500000",
  public_base_url: "",

  smtp_enabled: "false",
  smtp_host: "",
  smtp_port: "465",
  smtp_secure: "true",
  smtp_username: "",
  smtp_password: "",
  smtp_from_address: "",
  smtp_from_name: "ZenithCloud",

  turnstile_enabled: "false",
  turnstile_site_key: "",
  turnstile_secret_key: "",

  epay_enabled: "false",
  epay_gateway: "",
  epay_pid: "",
  epay_key: "",
  epay_type: "alipay",

  relay_base_url: "",
  relay_api_key: "",
  relay_models: "",
  relay_model_map: "{}",
  /** 关闭后仅保留额度限制（允许用赠送额度试用，不需要订阅）。 */
  require_subscription_for_relay: "false",
  /** 免费用户只能使用 Auto，服务端强制覆盖请求里的 model，客户端无法关闭。 */
  free_users_auto_only: "true",
  /** Auto 按难度选择上游模型：simple / medium / complex。 */
  auto_model_ladder: JSON.stringify({
    simple: "gpt-4o-mini",
    medium: "gpt-4o-mini",
    complex: "gpt-4o",
  }),
  /** 按模型系数计费：扣减额度 = 上游 tokens × 系数；default 为兜底系数。 */
  relay_model_rates: "{}",
  /** 后台自定义模型价格（人民币元 / 1M tokens）：{ "gpt-4o": {"input":18,"output":72} }。 */
  model_pricing: "{}",
  /** 计费加价倍率：在内置模型价格表结果上再乘该系数。 */
  billing_markup: "1",
  /** 从上游 /v1/models 拉取后是否同步写入 relay_models。 */
  auto_sync_models: "true",
  /** 上游模型列表缓存（内部字段）。 */
  upstream_models_cache: "[]",
  upstream_models_fetched_at: "0",
  /** 内置客户端本地网关用于计费的最近登录账号（内部字段）。 */
  last_active_user_id: "",
};

export function ensureDefaultSettings(db: DatabaseSync): void {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (getSetting(db, key, "\u0000") === "\u0000") {
      setSetting(db, key, value);
    }
  }
}

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

export function readSmtpConfig(db: DatabaseSync): SmtpConfig {
  return {
    enabled: getSettingBool(db, "smtp_enabled"),
    host: getSetting(db, "smtp_host"),
    port: getSettingInt(db, "smtp_port", 465),
    secure: getSettingBool(db, "smtp_secure", true),
    username: getSetting(db, "smtp_username"),
    password: getSetting(db, "smtp_password"),
    fromAddress: getSetting(db, "smtp_from_address"),
    fromName: getSetting(db, "smtp_from_name", "ZenithCloud"),
  };
}

export function isSmtpConfigured(db: DatabaseSync): boolean {
  const config = readSmtpConfig(db);
  return Boolean(config.enabled && config.host && config.fromAddress);
}

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
  secretKey: string;
}

export function readTurnstileConfig(db: DatabaseSync): TurnstileConfig {
  return {
    enabled: getSettingBool(db, "turnstile_enabled"),
    siteKey: getSetting(db, "turnstile_site_key"),
    secretKey: getSetting(db, "turnstile_secret_key"),
  };
}

export interface EpayConfig {
  enabled: boolean;
  gateway: string;
  pid: string;
  key: string;
  type: string;
  publicBaseUrl: string;
}

export function readEpayConfig(db: DatabaseSync): EpayConfig {
  return {
    enabled: getSettingBool(db, "epay_enabled"),
    gateway: getSetting(db, "epay_gateway").replace(/\/+$/, ""),
    pid: getSetting(db, "epay_pid"),
    key: getSetting(db, "epay_key"),
    type: getSetting(db, "epay_type", "alipay"),
    publicBaseUrl: getSetting(db, "public_base_url").replace(/\/+$/, ""),
  };
}

export function isEpayConfigured(db: DatabaseSync): boolean {
  const config = readEpayConfig(db);
  return Boolean(config.enabled && config.gateway && config.pid && config.key);
}

export interface RelayConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMap: Record<string, string>;
}

export function readRelayConfig(db: DatabaseSync): RelayConfig {
  const rawMap = getSetting(db, "relay_model_map", "{}");
  let modelMap: Record<string, string> = {};
  try {
    const parsed = JSON.parse(rawMap) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      modelMap = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, value]) => [key.trim(), value.trim()]),
      );
    }
  } catch {
    modelMap = {};
  }

  return {
    baseUrl: getSetting(db, "relay_base_url").replace(/\/+$/, ""),
    apiKey: getSetting(db, "relay_api_key"),
    models: getSetting(db, "relay_models")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    modelMap,
  };
}

export function isRelayConfigured(db: DatabaseSync): boolean {
  const config = readRelayConfig(db);
  return Boolean(config.baseUrl && config.apiKey);
}

/** 前端可见的公开配置子集，绝不包含密钥。 */
export function readPublicSettings(db: DatabaseSync) {
  const turnstile = readTurnstileConfig(db);
  return {
    registrationEnabled: getSettingBool(db, "registration_enabled", true),
    signupBonusQuota: getSettingInt(db, "signup_bonus_quota", 500000),
    turnstileEnabled: turnstile.enabled,
    turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : "",
    smtpConfigured: isSmtpConfigured(db),
    epayConfigured: isEpayConfigured(db),
    requireSubscription: getSettingBool(db, "require_subscription_for_relay", false),
    freeUsersAutoOnly: getSettingBool(db, "free_users_auto_only", true),
    autoModelId: "auto",
  };
}

/** 管理端写配置时过滤未知 key 并记录更新时间。 */
export function applySettings(db: DatabaseSync, values: Record<string, unknown>): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (value === undefined || value === null) continue;
    setSetting(db, key, typeof value === "boolean" ? String(value) : String(value));
    applied.push(key);
  }
  return applied;
}
