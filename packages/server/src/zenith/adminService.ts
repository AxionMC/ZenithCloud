import type { DatabaseSync } from "node:sqlite";
import { applySettings } from "./settings.js";
import { getAllSettings } from "./database.js";
import { createSession } from "./session.js";
import { addBonusQuota, getQuota, grantSubscription } from "./quota.js";
import { findUserById, normalizeEmail } from "./authService.js";
import { verifyPassword } from "./password.js";
import { ZenithError } from "./types.js";
import { toPublicUser } from "./types.js";
import type { ZenithUserRow } from "./types.js";

export interface AdminLoginResult {
  token: string;
  user: ReturnType<typeof toPublicUser>;
}

export function adminLogin(db: DatabaseSync, emailInput: string, password: string): AdminLoginResult {
  const email = normalizeEmail(emailInput);
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as unknown as
    | ZenithUserRow
    | undefined;
  if (!row || row.role !== "admin" || !verifyPassword(password, row.password_hash)) {
    throw new ZenithError(401, "管理员账号或密码错误");
  }
  if (row.status !== "active") throw new ZenithError(403, "管理员账号已被禁用");
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { token: createSession(db, row.id), user: toPublicUser(row) };
}

export function getOverview(db: DatabaseSync) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const number = (sql: string, ...params: Array<string | number>): number => {
    const row = db.prepare(sql).get(...params) as unknown as { value?: number } | undefined;
    return Number(row?.value ?? 0);
  };

  return {
    users: number("SELECT COUNT(*) AS value FROM users"),
    activeUsers: number("SELECT COUNT(*) AS value FROM users WHERE status = 'active'"),
    devices: number("SELECT COUNT(*) AS value FROM devices"),
    activeSubscriptions: number(
      "SELECT COUNT(*) AS value FROM users WHERE subscription_plan_id IS NOT NULL AND subscription_expires_at > ?",
      now,
    ),
    paidOrders: number("SELECT COUNT(*) AS value FROM orders WHERE status = 'paid'"),
    revenueCents: number("SELECT COALESCE(SUM(amount_cents), 0) AS value FROM orders WHERE status = 'paid'"),
    plugins: number("SELECT COUNT(*) AS value FROM plugins WHERE enabled = 1"),
    tokensUsed7d: number(
      "SELECT COALESCE(SUM(total_tokens), 0) AS value FROM usage_logs WHERE created_at > ?",
      weekAgo,
    ),
    pendingOrders: number("SELECT COUNT(*) AS value FROM orders WHERE status = 'pending'"),
  };
}

export interface AdminUserView {
  user: ReturnType<typeof toPublicUser>;
  quota: ReturnType<typeof getQuota>;
  deviceHash: string;
  registerIp: string;
  registerUa: string;
  bonusGranted: boolean;
}

function toAdminUserView(db: DatabaseSync, row: ZenithUserRow): AdminUserView {
  return {
    user: toPublicUser(row),
    quota: getQuota(db, row.id),
    deviceHash: row.device_hash,
    registerIp: row.register_ip,
    registerUa: row.register_ua,
    bonusGranted: Boolean(row.bonus_granted),
  };
}

export function listUsers(
  db: DatabaseSync,
  options: { query?: string; limit?: number; offset?: number } = {},
) {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const query = options.query?.trim();
  const rows = (query
    ? db
        .prepare(
          "SELECT * FROM users WHERE email LIKE ? OR id LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .all(`%${query}%`, `%${query}%`, limit, offset)
    : db.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset)) as unknown as ZenithUserRow[];
  return rows.map((row) => toAdminUserView(db, row));
}

export interface AdminUserPatch {
  status?: unknown;
  role?: unknown;
  displayName?: unknown;
  bonusQuota?: unknown;
  bonusDelta?: unknown;
  grantPlanId?: unknown;
  cancelSubscription?: unknown;
}

export function updateUserAsAdmin(
  db: DatabaseSync,
  actingUserId: string,
  userId: string,
  patch: AdminUserPatch,
): AdminUserView {
  const row = findUserById(db, userId);
  if (!row) throw new ZenithError(404, "用户不存在");

  if (userId === actingUserId) {
    if (patch.status === "disabled" || patch.role === "user") {
      throw new ZenithError(400, "不能禁用或降级当前登录的管理员");
    }
  }

  if (patch.displayName !== undefined) {
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
      String(patch.displayName).slice(0, 80),
      userId,
    );
  }
  if (patch.status === "active" || patch.status === "disabled") {
    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(patch.status, userId);
  }
  if (patch.role === "user" || patch.role === "admin") {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, userId);
  }
  if (patch.bonusQuota !== undefined) {
    const target = Math.max(0, Math.floor(Number(patch.bonusQuota) || 0));
    db.prepare(
      "UPDATE users SET bonus_quota = ?, bonus_used = MIN(bonus_used, ?) WHERE id = ?",
    ).run(target, target, userId);
  }
  if (patch.bonusDelta !== undefined) {
    addBonusQuota(db, userId, Number(patch.bonusDelta) || 0);
  }
  if (patch.cancelSubscription) {
    db.prepare(
      "UPDATE users SET subscription_plan_id = NULL, subscription_expires_at = 0, " +
        "subscription_weekly_quota = 0, subscription_week_start = 0, subscription_used = 0 WHERE id = ?",
    ).run(userId);
  }
  if (typeof patch.grantPlanId === "string" && patch.grantPlanId.trim()) {
    const plan = db
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get(patch.grantPlanId.trim()) as unknown as
      | { id: string; weekly_quota: number; duration_days: number }
      | undefined;
    if (!plan) throw new ZenithError(404, "套餐不存在");
    grantSubscription(db, userId, {
      id: plan.id,
      weeklyQuota: plan.weekly_quota,
      durationDays: plan.duration_days,
    });
  }

  const fresh = findUserById(db, userId);
  if (!fresh) throw new ZenithError(500, "用户读取失败");
  return toAdminUserView(db, fresh);
}

export function readAdminSettings(db: DatabaseSync) {
  return getAllSettings(db);
}

export function writeAdminSettings(db: DatabaseSync, values: Record<string, unknown>): string[] {
  return applySettings(db, values);
}

export function listUsage(db: DatabaseSync, limit = 200) {
  return db
    .prepare(
      "SELECT id, user_id, model, prompt_tokens, completion_tokens, total_tokens, charged_tokens, source, created_at " +
        "FROM usage_logs ORDER BY created_at DESC LIMIT ?",
    )
    .all(Math.min(1000, Math.max(1, limit)));
}
