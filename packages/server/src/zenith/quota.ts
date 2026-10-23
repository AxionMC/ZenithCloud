import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import type { QuotaSnapshot, ZenithUserRow } from "./types.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function selectUser(db: DatabaseSync, userId: string): ZenithUserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as unknown as
    | ZenithUserRow
    | undefined;
  return row ?? null;
}

/**
 * 订阅周额度惰性重置：跨周后的第一次读写把 used 归零。
 * 不依赖定时任务，服务重启或多实例也不会漏掉周期切换。
 */
export function refreshSubscriptionWindow(
  db: DatabaseSync,
  user: ZenithUserRow,
  now = Date.now(),
): ZenithUserRow {
  if (user.subscription_weekly_quota <= 0) return user;
  if (user.subscription_week_start <= 0) return user;
  if (now - user.subscription_week_start < WEEK_MS) return user;
  db.prepare(
    "UPDATE users SET subscription_week_start = ?, subscription_used = 0 WHERE id = ?",
  ).run(now, user.id);
  return {
    ...user,
    subscription_week_start: now,
    subscription_used: 0,
  };
}

export function isSubscriptionActive(user: ZenithUserRow, now = Date.now()): boolean {
  return (
    Boolean(user.subscription_plan_id) &&
    user.subscription_weekly_quota > 0 &&
    user.subscription_expires_at > now
  );
}

export function quotaSnapshot(user: ZenithUserRow, now = Date.now()): QuotaSnapshot {
  const bonusRemaining = Math.max(0, user.bonus_quota - user.bonus_used);
  const active = isSubscriptionActive(user, now);
  const subscriptionRemaining = active
    ? Math.max(0, user.subscription_weekly_quota - user.subscription_used)
    : 0;
  return {
    bonusQuota: user.bonus_quota,
    bonusUsed: user.bonus_used,
    bonusRemaining,
    subscriptionActive: active,
    subscriptionPlanId: user.subscription_plan_id,
    subscriptionWeeklyQuota: active ? user.subscription_weekly_quota : 0,
    subscriptionUsed: active ? user.subscription_used : 0,
    subscriptionRemaining,
    subscriptionExpiresAt: user.subscription_expires_at,
    weekStart: user.subscription_week_start,
    totalRemaining: bonusRemaining + subscriptionRemaining,
  };
}

export function getQuota(db: DatabaseSync, userId: string): QuotaSnapshot | null {
  const user = selectUser(db, userId);
  if (!user) return null;
  return quotaSnapshot(refreshSubscriptionWindow(db, user));
}

export interface ConsumeResult {
  ok: boolean;
  snapshot: QuotaSnapshot;
}

/**
 * 扣减顺序固定：先赠送额度，再订阅周额度。
 * 在一个事务里重新读取用户，避免并发请求把同一份额度扣两次。
 */
export function consumeQuota(db: DatabaseSync, userId: string, tokens: number): ConsumeResult {
  const requested = Math.max(0, Math.floor(tokens));
  return transaction(db, () => {
    const current = selectUser(db, userId);
    if (!current) {
      return {
        ok: false,
        snapshot: quotaSnapshot({
          id: userId,
          email: "",
          password_hash: "",
          display_name: "",
          role: "user",
          status: "disabled",
          created_at: 0,
          last_login_at: null,
          register_ip: "",
          register_ua: "",
          device_hash: "",
          bonus_granted: 0,
          bonus_quota: 0,
          bonus_used: 0,
          subscription_plan_id: null,
          subscription_expires_at: 0,
          subscription_week_start: 0,
          subscription_weekly_quota: 0,
          subscription_used: 0,
        }),
      };
    }

    const user = refreshSubscriptionWindow(db, current);
    const before = quotaSnapshot(user);
    if (requested === 0) {
      return { ok: true, snapshot: before };
    }
    if (before.totalRemaining < requested) {
      return { ok: false, snapshot: before };
    }

    let remaining = requested;
    let bonusUsed = user.bonus_used;
    let subscriptionUsed = user.subscription_used;

    const bonusAvailable = Math.max(0, user.bonus_quota - user.bonus_used);
    if (remaining > 0 && bonusAvailable > 0) {
      const take = Math.min(bonusAvailable, remaining);
      bonusUsed += take;
      remaining -= take;
    }

    if (remaining > 0 && before.subscriptionActive) {
      subscriptionUsed += remaining;
      remaining = 0;
    }

    db.prepare("UPDATE users SET bonus_used = ?, subscription_used = ? WHERE id = ?").run(
      bonusUsed,
      subscriptionUsed,
      user.id,
    );

    return {
      ok: true,
      snapshot: quotaSnapshot({
        ...user,
        bonus_used: bonusUsed,
        subscription_used: subscriptionUsed,
      }),
    };
  });
}

export function grantSubscription(
  db: DatabaseSync,
  userId: string,
  plan: { id: string; weeklyQuota: number; durationDays: number },
  now = Date.now(),
): void {
  const weeklyQuota = Math.max(0, Math.floor(Number(plan.weeklyQuota) || 0));
  const durationDays = Math.max(1, Math.floor(Number(plan.durationDays) || 1));
  transaction(db, () => {
    const user = selectUser(db, userId);
    if (!user) throw new Error("User not found");
    const base = isSubscriptionActive(user, now) && user.subscription_expires_at > now
      ? user.subscription_expires_at
      : now;
    const expiresAt = base + durationDays * 24 * 60 * 60 * 1000;
    db.prepare(
      "UPDATE users SET subscription_plan_id = ?, subscription_expires_at = ?, " +
        "subscription_weekly_quota = ?, subscription_week_start = ?, subscription_used = 0 " +
        "WHERE id = ?",
    ).run(plan.id, expiresAt, weeklyQuota, now, userId);
  });
}

export function addBonusQuota(db: DatabaseSync, userId: string, delta: number): void {
  transaction(db, () => {
    const user = selectUser(db, userId);
    if (!user) throw new Error("User not found");
    const nextQuota = Math.max(0, user.bonus_quota + Math.floor(delta));
    // 调低总额时同步收敛已用量，避免出现负余额或凭空恢复额度。
    const nextUsed = Math.min(user.bonus_used, nextQuota);
    db.prepare("UPDATE users SET bonus_quota = ?, bonus_used = ? WHERE id = ?").run(
      nextQuota,
      nextUsed,
      userId,
    );
  });
}
