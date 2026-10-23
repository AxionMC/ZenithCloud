export type ZenithUserRole = "user" | "admin";
export type ZenithUserStatus = "active" | "disabled";

export interface ZenithUserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: ZenithUserRole;
  status: ZenithUserStatus;
  created_at: number;
  last_login_at: number | null;
  register_ip: string;
  register_ua: string;
  device_hash: string;
  bonus_granted: number;
  bonus_quota: number;
  bonus_used: number;
  subscription_plan_id: string | null;
  subscription_expires_at: number;
  subscription_week_start: number;
  subscription_weekly_quota: number;
  subscription_used: number;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: ZenithUserRole;
  status: ZenithUserStatus;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface QuotaSnapshot {
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

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  duration_days: number;
  weekly_quota: number;
  sort: number;
  enabled: number;
  created_at: number;
}

export interface OrderRow {
  out_trade_no: string;
  user_id: string;
  plan_id: string;
  amount_cents: number;
  status: string;
  provider: string;
  trade_no: string | null;
  created_at: number;
  paid_at: number | null;
  raw_notify: string | null;
}

/** 业务错误：status 直接映射 HTTP 状态码，由路由层统一转换。 */
export class ZenithError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ZenithError";
    this.status = status;
  }
}

export function toPublicUser(row: ZenithUserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.email.split("@")[0] || row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}
