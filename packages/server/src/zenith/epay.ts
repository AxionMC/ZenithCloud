import { createHash } from "node:crypto";

/**
 * 彩虹易支付（Epay）MD5 协议。
 * 文档约定：签名 = md5(按 key 升序拼接的 k=v&... 末尾直接拼 key)，空值与 sign/sign_type 不参与。
 */

export type EpayParams = Record<string, string | number | undefined>;

export function buildEpaySign(params: EpayParams, key: string): string {
  const entries = Object.entries(params)
    .filter(([name, value]) => name !== "sign" && name !== "sign_type")
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${String(value)}`);
  if (entries.length === 0) return "";
  return createHash("md5")
    .update(`${entries.join("&")}${key}`, "utf8")
    .digest("hex")
    .toLowerCase();
}

export function verifyEpaySign(params: EpayParams, key: string): boolean {
  const provided = String(params["sign"] ?? "").trim().toLowerCase();
  if (!provided) return false;
  const expected = buildEpaySign(params, key);
  return provided === expected;
}

export interface EpayPayUrlInput {
  gateway: string;
  pid: string;
  type: string;
  key: string;
  outTradeNo: string;
  amountCents: number;
  subject: string;
  notifyUrl: string;
  returnUrl: string;
}

export function buildEpayPayUrl(input: EpayPayUrlInput): string {
  const params: EpayParams = {
    pid: input.pid,
    type: input.type || "alipay",
    out_trade_no: input.outTradeNo,
    notify_url: input.notifyUrl,
    return_url: input.returnUrl,
    name: input.subject,
    money: (input.amountCents / 100).toFixed(2),
    sign_type: "MD5",
  };
  params["sign"] = buildEpaySign(params, input.key);
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(name, String(value));
  }
  const gateway = input.gateway.replace(/\/+$/, "");
  return `${gateway}/submit.php?${search.toString()}`;
}
