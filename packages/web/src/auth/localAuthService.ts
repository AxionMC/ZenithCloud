/**
 * ZenithCloud 本地账号客户端。
 * 会话与设备 ID 存在 localStorage；服务端返回的 token 作为管理自身额度与订阅的凭据。
 * 与现有 z.ai OAuth 登录并存，互不覆盖。
 */

export interface LocalAuthUser {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: number;
  lastLoginAt: number | null;
}

export interface LocalQuotaSnapshot {
  bonusQuota: number;
  bonusUsed: number;
  bonusRemaining: number;
  subscriptionActive: boolean;
  subscriptionPlanId: string | null;
  subscriptionWeeklyQuota: number;
  subscriptionUsed: number;
  subscriptionRemaining: number;
  subscriptionExpiresAt: number;
  weekStart: number;
  totalRemaining: number;
}

export interface LocalAuthSession {
  token: string;
  user: LocalAuthUser;
  quota?: LocalQuotaSnapshot;
  bonus?: number;
}

export interface LocalAuthConfig {
  registrationEnabled: boolean;
  signupBonusQuota: number;
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
  smtpConfigured: boolean;
  epayConfigured: boolean;
  requireSubscription: boolean;
  freeUsersAutoOnly: boolean;
  autoModelId: string;
}

export interface LocalPlan {
  id: string;
  name: string;
  description: string;
  /** 价格，单位：分（人民币）。 */
  priceCents: number;
  currency?: "CNY";
  durationDays: number;
  weeklyQuota: number;
  sort: number;
  enabled: boolean;
}

const SESSION_KEY = "zenith.cloud.session.v1";
const DEVICE_KEY = "zenith.cloud.device.v1";

let memoryDeviceId = "";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写入失败时退回内存态，不影响当前页面使用。
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** 稳定的设备标识：同一浏览器只注册一次赠送资格。 */
export function getDeviceId(): string {
  const existing = readStorage(DEVICE_KEY)?.trim();
  if (existing) return existing;
  if (memoryDeviceId) return memoryDeviceId;
  const generated =
    globalThis.crypto?.randomUUID?.() ??
    `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  memoryDeviceId = generated;
  writeStorage(DEVICE_KEY, generated);
  return generated;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new Error("无法连接 ZenithCloud 服务端");
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export async function fetchAuthConfig(): Promise<LocalAuthConfig> {
  return request<LocalAuthConfig>("/api/auth/config");
}

export async function sendEmailCode(
  email: string,
  purpose: "register" | "reset",
  turnstileToken: string,
): Promise<void> {
  await request("/api/auth/send-code", {
    method: "POST",
    body: { email, purpose, turnstileToken },
  });
}

export interface RegisterAccountInput {
  email: string;
  password: string;
  code: string;
  turnstileToken: string;
}

export async function registerAccount(input: RegisterAccountInput): Promise<LocalAuthSession> {
  const result = await request<LocalAuthSession>("/api/auth/register", {
    method: "POST",
    body: {
      email: input.email,
      password: input.password,
      code: input.code,
      deviceId: getDeviceId(),
      turnstileToken: input.turnstileToken,
    },
  });
  saveSession(result);
  return result;
}

export async function loginAccount(input: {
  email: string;
  password: string;
  turnstileToken: string;
}): Promise<LocalAuthSession> {
  const result = await request<LocalAuthSession>("/api/auth/login", {
    method: "POST",
    body: {
      email: input.email,
      password: input.password,
      turnstileToken: input.turnstileToken,
    },
  });
  saveSession(result);
  return result;
}

export async function fetchMe(
  token: string,
): Promise<{ user: LocalAuthUser; quota: LocalQuotaSnapshot | null }> {
  return request("/api/auth/me", { token });
}

export async function fetchAvailableModels(
  token: string,
): Promise<{ models: string[]; autoOnly: boolean }> {
  return request("/api/auth/models", { token });
}

export async function logoutAccount(token: string): Promise<void> {
  try {
    await request("/api/auth/logout", { method: "POST", token });
  } finally {
    clearSession();
  }
}

export async function listPlans(): Promise<LocalPlan[]> {
  const result = await request<{ plans: LocalPlan[] }>("/api/billing/plans");
  return result.plans;
}

export async function createSubscriptionOrder(
  token: string,
  planId: string,
): Promise<{ outTradeNo: string; payUrl: string; amountCents: number; currency?: "CNY" }> {
  return request("/api/billing/orders", { method: "POST", token, body: { planId } });
}

function isValidSession(value: unknown): value is LocalAuthSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["token"] === "string" && Boolean(record["user"]);
}

export function loadSession(): LocalAuthSession | null {
  const raw = readStorage(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: LocalAuthSession): void {
  writeStorage(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  removeStorage(SESSION_KEY);
}

export function formatQuota(value: number | undefined): string {
  const numeric = Number(value ?? 0);
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(2)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}K`;
  return String(numeric);
}
