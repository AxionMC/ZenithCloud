import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, transaction } from "./database.js";
import { buildEpayPayUrl, verifyEpaySign } from "./epay.js";
import { grantSubscription } from "./quota.js";
import { isEpayConfigured, readEpayConfig } from "./settings.js";
import { ZenithError } from "./types.js";
import type { PlanRow } from "./types.js";

export interface PlanView {
  id: string;
  name: string;
  description: string;
  /** 价格，单位：分（人民币）。 */
  priceCents: number;
  /** 货币固定为人民币。 */
  currency: "CNY";
  durationDays: number;
  weeklyQuota: number;
  sort: number;
  enabled: boolean;
}

export function toPlanView(row: PlanRow): PlanView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: "CNY",
    durationDays: row.duration_days,
    weeklyQuota: row.weekly_quota,
    sort: row.sort,
    enabled: Boolean(row.enabled),
  };
}

export function listPlans(db: DatabaseSync, onlyEnabled = false): PlanView[] {
  const sql = onlyEnabled
    ? "SELECT * FROM plans WHERE enabled = 1 ORDER BY sort ASC, created_at ASC"
    : "SELECT * FROM plans ORDER BY sort ASC, created_at ASC";
  const rows = db.prepare(sql).all() as unknown as PlanRow[];
  return rows.map(toPlanView);
}

export interface PlanInput {
  name?: unknown;
  description?: unknown;
  priceCents?: unknown;
  durationDays?: unknown;
  weeklyQuota?: unknown;
  sort?: unknown;
  enabled?: unknown;
}

function numberField(value: unknown, field: string, min: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new ZenithError(400, `${field} 必须是大于等于 ${min} 的数字`);
  }
  return Math.floor(parsed);
}

export function createPlan(db: DatabaseSync, input: PlanInput): PlanView {
  const name = String(input.name ?? "").trim();
  if (!name) throw new ZenithError(400, "套餐名称不能为空");
  const id = newId("plan");
  db.prepare(
    "INSERT INTO plans (id, name, description, price_cents, duration_days, weekly_quota, sort, enabled, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    name.slice(0, 80),
    String(input.description ?? "").slice(0, 500),
    numberField(input.priceCents, "priceCents", 0),
    numberField(input.durationDays, "durationDays", 1),
    numberField(input.weeklyQuota, "weeklyQuota", 1),
    numberField(input.sort ?? 0, "sort", 0),
    input.enabled === false ? 0 : 1,
    Date.now(),
  );
  const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as unknown as PlanRow;
  return toPlanView(row);
}

export function updatePlan(db: DatabaseSync, planId: string, input: PlanInput): PlanView {
  const existing = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as unknown as
    | PlanRow
    | undefined;
  if (!existing) throw new ZenithError(404, "套餐不存在");

  const name = input.name === undefined ? existing.name : String(input.name).trim();
  if (!name) throw new ZenithError(400, "套餐名称不能为空");
  db.prepare(
    "UPDATE plans SET name = ?, description = ?, price_cents = ?, duration_days = ?, weekly_quota = ?, sort = ?, enabled = ? WHERE id = ?",
  ).run(
    name.slice(0, 80),
    input.description === undefined ? existing.description : String(input.description).slice(0, 500),
    input.priceCents === undefined
      ? existing.price_cents
      : numberField(input.priceCents, "priceCents", 0),
    input.durationDays === undefined
      ? existing.duration_days
      : numberField(input.durationDays, "durationDays", 1),
    input.weeklyQuota === undefined
      ? existing.weekly_quota
      : numberField(input.weeklyQuota, "weeklyQuota", 1),
    input.sort === undefined ? existing.sort : numberField(input.sort, "sort", 0),
    input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
    planId,
  );
  const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as unknown as PlanRow;
  return toPlanView(row);
}

export function deletePlan(db: DatabaseSync, planId: string): void {
  const result = db.prepare("DELETE FROM plans WHERE id = ?").run(planId);
  if (Number(result.changes) === 0) throw new ZenithError(404, "套餐不存在");
}

function randomTradeNo(): string {
  return `ZC${Date.now()}${String(randomInt(1000, 10000))}`;
}

export interface CreateOrderResult {
  outTradeNo: string;
  payUrl: string;
  amountCents: number;
  currency: "CNY";
}

export function createOrder(
  db: DatabaseSync,
  userId: string,
  planId: string,
  fallbackBaseUrl: string,
): CreateOrderResult {
  if (!isEpayConfigured(db)) {
    throw new ZenithError(409, "服务端尚未配置易支付，暂时无法购买订阅");
  }
  const plan = db.prepare("SELECT * FROM plans WHERE id = ? AND enabled = 1").get(planId) as unknown as
    | PlanRow
    | undefined;
  if (!plan) throw new ZenithError(404, "套餐不存在或已下架");

  const epay = readEpayConfig(db);
  const baseUrl = (epay.publicBaseUrl || fallbackBaseUrl).replace(/\/+$/, "");
  if (!baseUrl) throw new ZenithError(500, "请先在后台配置 public_base_url");

  const outTradeNo = randomTradeNo();
  const now = Date.now();
  db.prepare(
    "INSERT INTO orders (out_trade_no, user_id, plan_id, amount_cents, status, provider, created_at) " +
      "VALUES (?, ?, ?, ?, 'pending', 'epay', ?)",
  ).run(outTradeNo, userId, plan.id, plan.price_cents, now);

  const payUrl = buildEpayPayUrl({
    gateway: epay.gateway,
    pid: epay.pid,
    key: epay.key,
    type: epay.type,
    outTradeNo,
    amountCents: plan.price_cents,
    subject: plan.name,
    notifyUrl: `${baseUrl}/api/billing/epay/notify`,
    returnUrl: `${baseUrl}/api/billing/epay/return`,
  });

  return { outTradeNo, payUrl, amountCents: plan.price_cents, currency: "CNY" };
}

export function listOrders(db: DatabaseSync, userId?: string, limit = 100) {
  const rows = (userId
    ? db
        .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(userId, limit)
    : db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?").all(limit)) as unknown as Array<{
    out_trade_no: string;
    user_id: string;
    plan_id: string;
    amount_cents: number;
    status: string;
    trade_no: string | null;
    created_at: number;
    paid_at: number | null;
  }>;
  return rows.map((row) => ({
    outTradeNo: row.out_trade_no,
    userId: row.user_id,
    planId: row.plan_id,
    amountCents: row.amount_cents,
    currency: "CNY" as const,
    status: row.status,
    tradeNo: row.trade_no,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  }));
}

export type EpayNotifyParams = Record<string, string | undefined>;

/**
 * 易支付异步回调。幂等：已支付订单重复回调直接返回 success。
 * 金额必须与订单一致，避免改价/串单。
 */
export function handleEpayNotify(db: DatabaseSync, params: EpayNotifyParams): { ok: boolean; message: string } {
  const epay = readEpayConfig(db);
  if (!epay.enabled || !epay.key) throw new ZenithError(503, "易支付未启用");
  if (!verifyEpaySign(params, epay.key)) throw new ZenithError(400, "签名校验失败");
  if (String(params["trade_status"] ?? "") !== "TRADE_SUCCESS") {
    return { ok: false, message: "非成功状态" };
  }

  const outTradeNo = String(params["out_trade_no"] ?? "").trim();
  if (!outTradeNo) throw new ZenithError(400, "缺少订单号");
  const order = db.prepare("SELECT * FROM orders WHERE out_trade_no = ?").get(outTradeNo) as unknown as
    | {
        out_trade_no: string;
        user_id: string;
        plan_id: string;
        amount_cents: number;
        status: string;
      }
    | undefined;
  if (!order) throw new ZenithError(404, "订单不存在");

  const money = Number.parseFloat(String(params["money"] ?? "0"));
  if (!Number.isFinite(money) || Math.round(money * 100) !== order.amount_cents) {
    throw new ZenithError(400, "订单金额不匹配");
  }
  if (order.status === "paid") {
    return { ok: true, message: "success" };
  }

  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(order.plan_id) as unknown as
    | PlanRow
    | undefined;

  transaction(db, () => {
    db.prepare(
      "UPDATE orders SET status = 'paid', trade_no = ?, paid_at = ?, raw_notify = ? " +
        "WHERE out_trade_no = ? AND status = 'pending'",
    ).run(
      String(params["trade_no"] ?? ""),
      Date.now(),
      JSON.stringify(params),
      order.out_trade_no,
    );
    if (plan) {
      grantSubscription(db, order.user_id, {
        id: plan.id,
        weeklyQuota: plan.weekly_quota,
        durationDays: plan.duration_days,
      });
    }
  });

  return { ok: true, message: "success" };
}
