import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSettingBool, getSettingInt } from "./database.js";
import { isSmtpConfigured, readSmtpConfig, readTurnstileConfig } from "./settings.js";
import { hashPassword, validateEmail, validatePassword, verifyPassword } from "./password.js";
import {
  createSession,
  deleteSession,
  sha256Hex,
} from "./session.js";
import { buildVerificationMail, sendSmtpMail } from "./smtp.js";
import { verifyTurnstile } from "./turnstile.js";
import { getQuota, quotaSnapshot, refreshSubscriptionWindow } from "./quota.js";
import { newId, transaction } from "./database.js";
import { ZenithError } from "./types.js";
import type { PublicUser, QuotaSnapshot, ZenithUserRow } from "./types.js";
import { toPublicUser } from "./types.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_MAX_PER_DAY = 20;

export type EmailCodePurpose = "register" | "reset";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 记录最近一次邮箱登录的账号。内置客户端的本地网关没有独立凭据，
 * 用它把请求归属到当前登录账号，保证客户端用量仍然计费。
 */
function rememberActiveUser(db: DatabaseSync, userId: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('last_active_user_id', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(userId, Date.now());
}

export function computeDeviceHash(deviceId: string | undefined, ip: string, userAgent: string): string {
  const trimmed = deviceId?.trim();
  const source = trimmed ? `device:${trimmed}` : `ipua:${ip}|${userAgent}`;
  return sha256Hex(source);
}

function findUserByEmail(db: DatabaseSync, email: string): ZenithUserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as unknown as
    | ZenithUserRow
    | undefined;
  return row ?? null;
}

export function findUserById(db: DatabaseSync, id: string): ZenithUserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as
    | ZenithUserRow
    | undefined;
  return row ?? null;
}

async function verifyHuman(db: DatabaseSync, token: string | undefined, ip: string): Promise<void> {
  const config = readTurnstileConfig(db);
  if (!config.enabled) return;
  if (!config.secretKey) {
    throw new ZenithError(503, "Turnstile 已启用但未配置 Secret Key");
  }
  const result = await verifyTurnstile(config.secretKey, token ?? "", ip);
  if (!result.ok) {
    throw new ZenithError(400, `人机验证失败（${result.errorCodes.join(",") || "unknown"}）`);
  }
}

export interface SendCodeInput {
  email: string;
  purpose: EmailCodePurpose;
  ip: string;
  userAgent: string;
  turnstileToken?: string;
}

export async function sendVerificationCode(db: DatabaseSync, input: SendCodeInput): Promise<void> {
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ZenithError(400, "邮箱格式不正确");
  if (input.purpose === "register" && !getSettingBool(db, "registration_enabled", true)) {
    throw new ZenithError(403, "注册功能已关闭");
  }
  if (input.purpose === "register" && findUserByEmail(db, email)) {
    throw new ZenithError(409, "该邮箱已注册，请直接登录");
  }
  if (input.purpose === "reset" && !findUserByEmail(db, email)) {
    // 不暴露邮箱是否存在，但也不发送邮件。
    return;
  }
  if (!isSmtpConfigured(db)) {
    throw new ZenithError(503, "服务端尚未配置 SMTP 发信");
  }

  const now = Date.now();
  const last = db
    .prepare(
      "SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(email, input.purpose) as unknown as { created_at?: number } | undefined;
  if (last?.created_at && now - last.created_at < CODE_COOLDOWN_MS) {
    throw new ZenithError(429, "发送过于频繁，请稍后再试");
  }
  const daily = db
    .prepare("SELECT COUNT(*) AS count FROM email_codes WHERE email = ? AND created_at > ?")
    .get(email, now - 24 * 60 * 60 * 1000) as unknown as { count?: number } | undefined;
  if ((daily?.count ?? 0) >= EMAIL_CODE_MAX_PER_DAY) {
    throw new ZenithError(429, "该邮箱今日发送次数已达上限");
  }

  await verifyHuman(db, input.turnstileToken, input.ip);

  const code = String(randomInt(100_000, 1_000_000));
  const id = newId("code");
  db.prepare(
    "INSERT INTO email_codes (id, email, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, email, input.purpose, sha256Hex(`${email}:${code}`), now + CODE_TTL_MS, now);

  // 过期验证码顺手清理，避免长期堆积。
  db.prepare("DELETE FROM email_codes WHERE expires_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);

  const mail = buildVerificationMail(code, input.purpose);
  try {
    await sendSmtpMail(readSmtpConfig(db), {
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (error) {
    db.prepare("DELETE FROM email_codes WHERE id = ?").run(id);
    throw new ZenithError(
      502,
      `验证码邮件发送失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function consumeCode(db: DatabaseSync, email: string, purpose: EmailCodePurpose, code: string): void {
  const row = db
    .prepare(
      "SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL " +
        "ORDER BY created_at DESC LIMIT 1",
    )
    .get(email, purpose) as unknown as
    | { id: string; code_hash: string; expires_at: number; attempts: number }
    | undefined;

  if (!row) throw new ZenithError(400, "请先获取邮箱验证码");
  if (row.expires_at <= Date.now()) throw new ZenithError(400, "验证码已过期，请重新获取");
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    throw new ZenithError(429, "验证码尝试次数过多，请重新获取");
  }

  const matched = row.code_hash === sha256Hex(`${email}:${code.trim()}`);
  if (!matched) {
    db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    throw new ZenithError(400, "验证码不正确");
  }

  db.prepare("UPDATE email_codes SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id);
}

export interface RegisterInput {
  email: string;
  password: string;
  code: string;
  deviceId?: string;
  turnstileToken?: string;
  ip: string;
  userAgent: string;
}

export interface AuthResult {
  token: string;
  user: PublicUser;
  quota: QuotaSnapshot;
  bonus: number;
}

export async function registerUser(db: DatabaseSync, input: RegisterInput): Promise<AuthResult> {
  if (!getSettingBool(db, "registration_enabled", true)) {
    throw new ZenithError(403, "注册功能已关闭");
  }
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ZenithError(400, "邮箱格式不正确");
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new ZenithError(400, passwordError);
  if (!input.code?.trim()) throw new ZenithError(400, "请填写邮箱验证码");

  await verifyHuman(db, input.turnstileToken, input.ip);
  consumeCode(db, email, "register", input.code);

  if (findUserByEmail(db, email)) {
    throw new ZenithError(409, "该邮箱已注册，请直接登录");
  }

  const now = Date.now();
  const userId = newId("usr");
  const deviceHash = computeDeviceHash(input.deviceId, input.ip, input.userAgent);
  const bonusQuotaSetting = Math.max(0, getSettingInt(db, "signup_bonus_quota", 500_000));

  const result = transaction(db, () => {
    // 同一设备的并发注册由 devices 主键兜底：只有真正插入成功的那一次获得赠送。
    const deviceInsert = db
      .prepare("INSERT OR IGNORE INTO devices (device_hash, first_user_id, first_seen_at) VALUES (?, ?, ?)")
      .run(deviceHash, userId, now);
    const firstOnDevice = Number(deviceInsert.changes) > 0;
    const bonus = firstOnDevice ? bonusQuotaSetting : 0;

    db.prepare(
      "INSERT INTO users (id, email, password_hash, display_name, role, status, created_at, " +
        "register_ip, register_ua, device_hash, bonus_granted, bonus_quota, bonus_used) " +
        "VALUES (?, ?, ?, ?, 'user', 'active', ?, ?, ?, ?, ?, ?, 0)",
    ).run(
      userId,
      email,
      hashPassword(input.password),
      email.split("@")[0] || email,
      now,
      input.ip,
      input.userAgent.slice(0, 500),
      deviceHash,
      bonus > 0 ? 1 : 0,
      bonus,
    );

    return { bonus };
  });

  const token = createSession(db, userId);
  rememberActiveUser(db, userId);
  const user = findUserById(db, userId);
  if (!user) throw new ZenithError(500, "账号创建失败");
  return {
    token,
    user: toPublicUser(user),
    quota: quotaSnapshot(refreshSubscriptionWindow(db, user)),
    bonus: result.bonus,
  };
}

export interface LoginInput {
  email: string;
  password: string;
  turnstileToken?: string;
  ip: string;
  userAgent: string;
}

export async function loginUser(db: DatabaseSync, input: LoginInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ZenithError(400, "邮箱格式不正确");
  await verifyHuman(db, input.turnstileToken, input.ip);

  const user = findUserByEmail(db, email);
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    throw new ZenithError(401, "邮箱或密码不正确");
  }
  if (user.status !== "active") {
    throw new ZenithError(403, "账号已被禁用");
  }

  const now = Date.now();
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, user.id);
  const token = createSession(db, user.id);
  rememberActiveUser(db, user.id);
  const fresh = findUserById(db, user.id) ?? user;
  return {
    token,
    user: toPublicUser(fresh),
    quota: quotaSnapshot(refreshSubscriptionWindow(db, fresh)),
    bonus: 0,
  };
}

export function logoutUser(db: DatabaseSync, token: string | null | undefined): void {
  deleteSession(db, token);
}

export interface ResetPasswordInput {
  email: string;
  code: string;
  password: string;
}

export function resetPassword(db: DatabaseSync, input: ResetPasswordInput): void {
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ZenithError(400, "邮箱格式不正确");
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new ZenithError(400, passwordError);
  const user = findUserByEmail(db, email);
  if (!user) throw new ZenithError(400, "验证码无效或已过期");
  consumeCode(db, email, "reset", input.code);
  transaction(db, () => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      hashPassword(input.password),
      user.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  });
}

export function changePassword(
  db: DatabaseSync,
  userId: string,
  oldPassword: string,
  newPassword: string,
): void {
  const user = findUserById(db, userId);
  if (!user) throw new ZenithError(401, "登录已失效");
  if (!verifyPassword(oldPassword, user.password_hash)) {
    throw new ZenithError(400, "原密码不正确");
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) throw new ZenithError(400, passwordError);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hashPassword(newPassword),
    userId,
  );
}

export function readMe(db: DatabaseSync, userId: string) {
  const user = findUserById(db, userId);
  if (!user) throw new ZenithError(401, "登录已失效");
  const refreshed = refreshSubscriptionWindow(db, user);
  return {
    user: toPublicUser(refreshed),
    quota: getQuota(db, userId),
  };
}

export function bootstrapAdminAccount(db: DatabaseSync): { email: string; created: boolean } {  const email = normalizeEmail(
    process.env["ZENITH_ADMIN_EMAIL"]?.trim() || "admin@zenithcloud.local",
  );
  const password = process.env["ZENITH_ADMIN_PASSWORD"]?.trim() || "zenithcloud";
  const existingAdmin = db
    .prepare("SELECT id, email FROM users WHERE role = 'admin' LIMIT 1")
    .get() as unknown as { id?: string; email?: string } | undefined;
  if (existingAdmin?.id) {
    return { email: existingAdmin.email ?? "", created: false };
  }

  const existing = findUserByEmail(db, email);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(existing.id);
    return { email, created: false };
  }

  const now = Date.now();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, role, status, created_at, " +
      "bonus_granted, bonus_quota, bonus_used) VALUES (?, ?, ?, ?, 'admin', 'active', ?, 0, 0, 0)",
  ).run(newId("usr"), email, hashPassword(password), "Administrator", now);
  return { email, created: true };
}
