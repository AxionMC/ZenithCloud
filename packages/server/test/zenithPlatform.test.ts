import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openZenithDatabase, setSetting } from "../src/zenith/database.js";
import { ensureDefaultSettings } from "../src/zenith/settings.js";
import { loginUser, registerUser } from "../src/zenith/authService.js";
import { createSession, sha256Hex } from "../src/zenith/session.js";
import { consumeQuota, getQuota, grantSubscription } from "../src/zenith/quota.js";
import { createOrder, createPlan, handleEpayNotify } from "../src/zenith/billing.js";
import { buildEpaySign } from "../src/zenith/epay.js";
import {
  chargedTokensFor,
  resolveModelPricing,
} from "../src/zenith/pricing.js";
import { estimateAutoDifficulty, handleRelayRequest } from "../src/zenith/relay.js";
import { refreshUpstreamModels } from "../src/zenith/upstreamModels.js";
import { buildMarketplaceJson, upsertPlugin } from "../src/zenith/plugins.js";

const dataDir = mkdtempSync(join(tmpdir(), "zenith-platform-test-"));
const { db } = openZenithDatabase(dataDir);
ensureDefaultSettings(db);

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function insertRegisterCode(email: string, code: string): void {
  db.prepare(
    "INSERT INTO email_codes (id, email, purpose, code_hash, expires_at, created_at) VALUES (?, ?, 'register', ?, ?, ?)",
  ).run(
    `code-${Math.random()}`,
    email,
    sha256Hex(`${email}:${code}`),
    Date.now() + 600_000,
    Date.now(),
  );
}

describe("ZenithCloud 账号与额度", () => {
  it("首次设备注册发放默认 500K，同设备第二个账号不发放", async () => {
    insertRegisterCode("first@example.com", "123456");
    const first = await registerUser(db, {
      email: "first@example.com",
      password: "password123",
      code: "123456",
      deviceId: "device-A",
      ip: "1.1.1.1",
      userAgent: "vitest",
    });
    expect(first.bonus).toBe(500_000);
    expect(first.quota.bonusRemaining).toBe(500_000);

    insertRegisterCode("second@example.com", "654321");
    const second = await registerUser(db, {
      email: "second@example.com",
      password: "password123",
      code: "654321",
      deviceId: "device-A",
      ip: "1.1.1.1",
      userAgent: "vitest",
    });
    expect(second.bonus).toBe(0);
  });

  it("赠送额度可调整且立即生效", async () => {
    setSetting(db, "signup_bonus_quota", "1000");
    insertRegisterCode("third@example.com", "111111");
    const third = await registerUser(db, {
      email: "third@example.com",
      password: "password123",
      code: "111111",
      deviceId: "device-B",
      ip: "2.2.2.2",
      userAgent: "vitest",
    });
    expect(third.bonus).toBe(1000);
    setSetting(db, "signup_bonus_quota", "500000");
  });

  it("错误密码登录被拒绝", async () => {
    await expect(
      loginUser(db, { email: "first@example.com", password: "wrong-pass", ip: "", userAgent: "" }),
    ).rejects.toThrow();
  });

  it("扣减顺序为先赠送后订阅，超额拒绝", async () => {
    const user = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get("first@example.com") as unknown as { id: string };

    const consumed = consumeQuota(db, user.id, 1200);
    expect(consumed.ok).toBe(true);
    expect(consumed.snapshot.bonusRemaining).toBe(500_000 - 1200);

    expect(consumeQuota(db, user.id, 10_000_000).ok).toBe(false);

    const plan = createPlan(db, {
      name: "周卡",
      priceCents: 990,
      durationDays: 30,
      weeklyQuota: 100,
      enabled: true,
    });
    grantSubscription(db, user.id, plan);
    db.prepare("UPDATE users SET subscription_used = 60 WHERE id = ?").run(user.id);
    expect(getQuota(db, user.id)?.subscriptionRemaining).toBe(40);

    db.prepare("UPDATE users SET subscription_week_start = ? WHERE id = ?").run(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      user.id,
    );
    expect(getQuota(db, user.id)?.subscriptionRemaining).toBe(100);
  });
});

describe("ZenithCloud 订阅与易支付", () => {
  it("未配置易支付时禁止下单；配置后回调验签并幂等发放订阅", () => {
    const user = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get("first@example.com") as unknown as { id: string };
    const plan = db
      .prepare("SELECT id FROM plans ORDER BY created_at DESC LIMIT 1")
      .get() as unknown as { id: string };

    expect(() => createOrder(db, user.id, plan.id, "http://localhost:3030")).toThrow(/易支付/);

    setSetting(db, "epay_enabled", "true");
    setSetting(db, "epay_gateway", "https://pay.example.com");
    setSetting(db, "epay_pid", "1001");
    setSetting(db, "epay_key", "test-key");
    setSetting(db, "public_base_url", "http://localhost:3030");

    const order = createOrder(db, user.id, plan.id, "http://localhost:3030");
    expect(order.payUrl).toContain("/submit.php?");
    expect(order.payUrl).toContain("sign=");

    const params: Record<string, string> = {
      pid: "1001",
      trade_no: "T123",
      out_trade_no: order.outTradeNo,
      type: "alipay",
      money: (order.amountCents / 100).toFixed(2),
      trade_status: "TRADE_SUCCESS",
    };
    params["sign"] = buildEpaySign(params, "test-key");
    params["sign_type"] = "MD5";

    expect(() => handleEpayNotify(db, { ...params, sign: "bad" })).toThrow(/签名/);
    expect(handleEpayNotify(db, params)).toEqual({ ok: true, message: "success" });
    expect(handleEpayNotify(db, params)).toEqual({ ok: true, message: "success" });

    const row = db
      .prepare("SELECT status FROM orders WHERE out_trade_no = ?")
      .get(order.outTradeNo) as unknown as { status: string };
    expect(row.status).toBe("paid");
  });
});

describe("ZenithCloud 模型中转", () => {
  it("只接受账号登录态；免费用户只能看到 Auto 模型", async () => {
    setSetting(db, "relay_base_url", "https://upstream.invalid/v1");
    setSetting(db, "relay_api_key", "upstream-key");
    setSetting(db, "require_subscription_for_relay", "false");
    setSetting(db, "free_users_auto_only", "true");

    const user = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get("third@example.com") as unknown as { id: string };
    const token = createSession(db, user.id);

    const unauthorized = await handleRelayRequest(
      db,
      new Request("http://localhost/v1/models", { headers: { authorization: "Bearer nope" } }),
    );
    expect(unauthorized.status).toBe(401);

    const models = await handleRelayRequest(
      db,
      new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(models.status).toBe(200);
    const payload = (await models.json()) as { data?: Array<{ id: string }> };
    expect(payload.data?.map((item) => item.id)).toEqual(["auto"]);
  });

  it("免费用户请求具体模型会被服务端强制为 Auto", async () => {
    setSetting(db, "relay_models", "gpt-4o-mini");
    setSetting(
      db,
      "auto_model_ladder",
      JSON.stringify({ simple: "gpt-4o-mini", medium: "gpt-4o-mini", complex: "gpt-4o-mini" }),
    );
    const user = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get("third@example.com") as unknown as { id: string };
    const token = createSession(db, user.id);

    const response = await handleRelayRequest(
      db,
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    // 未被强制时会因为 gpt-4o 不在允许列表而 400；强制 Auto 后解析为 gpt-4o-mini，走到上游失败。
    expect(response.status).toBe(502);
    setSetting(db, "relay_models", "");
  });

  it("订阅门槛开启时未订阅返回 403", async () => {
    setSetting(db, "require_subscription_for_relay", "true");
    const user = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get("third@example.com") as unknown as { id: string };
    const token = createSession(db, user.id);
    const response = await handleRelayRequest(
      db,
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: { type?: string } };
    expect(payload.error?.type).toBe("subscription_required");
    setSetting(db, "require_subscription_for_relay", "false");
  });

  it("Auto 按难度选模型，计费按模型系数放大", () => {
    expect(estimateAutoDifficulty(null)).toBe("simple");
    expect(
      estimateAutoDifficulty({ messages: [{ role: "user", content: "x".repeat(7_000) }] }),
    ).toBe("medium");
    expect(
      estimateAutoDifficulty({ messages: [{ role: "user", content: "x".repeat(61_000) }] }),
    ).toBe("complex");

    setSetting(
      db,
      "relay_model_rates",
      JSON.stringify({ "gpt-4o": 5, "gpt-4o-mini": 1, default: 2 }),
    );
    expect(chargedTokensFor(db, "gpt-4o", { promptTokens: 50, completionTokens: 50, totalTokens: 100 })).toBe(500);
    expect(chargedTokensFor(db, "gpt-4o-mini", { promptTokens: 50, completionTokens: 50, totalTokens: 100 })).toBe(100);
    expect(chargedTokensFor(db, "unknown-model", { promptTokens: 50, completionTokens: 50, totalTokens: 100 })).toBe(200);
    setSetting(db, "relay_model_rates", "{}");
  });

  it("内置 OpenAI / Claude / DeepSeek 人民币计费表", () => {
    // gpt-4o-mini: 400 输入 × 1.08 + 600 输出 × 4.32 = 0.003024 元 → 2800 额度
    expect(chargedTokensFor(db, "gpt-4o-mini", { promptTokens: 400, completionTokens: 600, totalTokens: 1000 })).toBe(2800);
    // claude-sonnet-4-5: 1000 × 21.6 + 1000 × 108 = 0.1296 元 → 120000 额度
    expect(chargedTokensFor(db, "claude-sonnet-4-5", { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 })).toBe(120_000);
    // deepseek-chat: 1000 × 2.016 + 1000 × 3.024 = 0.00504 元 → 4667 额度
    expect(chargedTokensFor(db, "deepseek-chat", { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 })).toBe(4667);
    expect(resolveModelPricing("gpt-4o-2024-08-06")?.inputPerMillion).toBe(18);
    expect(resolveModelPricing("claude-3-5-sonnet-20241022")?.outputPerMillion).toBe(108);
    expect(resolveModelPricing("unknown-model")).toBeNull();

    // 后台自定义价格覆盖内置价格：(400×1 + 600×2) 元 / 1M = 0.0016 元 → 1482 额度
    setSetting(
      db,
      "model_pricing",
      JSON.stringify({ "gpt-4o-mini": { input: 1, output: 2 } }),
    );
    expect(chargedTokensFor(db, "gpt-4o-mini", { promptTokens: 400, completionTokens: 600, totalTokens: 1000 })).toBe(1482);
    expect(chargedTokensFor(db, "gpt-4o-mini-2024-07-18", { promptTokens: 400, completionTokens: 600, totalTokens: 1000 })).toBe(1482);
    setSetting(db, "model_pricing", "{}");
  });

  it("服务端从上游 /v1/models 获取并同步模型列表", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "gpt-4o-mini" }, { id: "claude-sonnet-4-5" }, { id: "deepseek-chat" }],
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as AddressInfo).port;

    try {
      setSetting(db, "relay_base_url", `http://127.0.0.1:${port}/v1`);
      setSetting(db, "relay_api_key", "upstream-key");
      setSetting(db, "relay_models", "");
      setSetting(db, "auto_sync_models", "true");

      const result = await refreshUpstreamModels(db);
      expect(result.models).toEqual(["claude-sonnet-4-5", "deepseek-chat", "gpt-4o-mini"]);
      expect(result.syncedAllowlist).toBe(true);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'relay_models'").get()).toEqual({
        value: "claude-sonnet-4-5,deepseek-chat,gpt-4o-mini",
      });

      // 订阅用户从 /v1/models 看到 auto + 上游模型
      const user = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get("first@example.com") as unknown as { id: string };
      const token = createSession(db, user.id);
      const response = await handleRelayRequest(
        db,
        new Request("http://localhost/v1/models", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const payload = (await response.json()) as { data?: Array<{ id: string }> };
      expect(payload.data?.map((item) => item.id)).toEqual([
        "auto",
        "claude-sonnet-4-5",
        "deepseek-chat",
        "gpt-4o-mini",
      ]);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      setSetting(db, "relay_models", "");
      setSetting(db, "auto_sync_models", "true");
    }
  });

  it("客户端调用后按模型系数实际扣减额度", async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-test",
            model: "gpt-4o-mini",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 400, completion_tokens: 600, total_tokens: 1000 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as AddressInfo).port;

    try {
      setSetting(db, "relay_base_url", `http://127.0.0.1:${port}/v1`);
      setSetting(db, "relay_api_key", "upstream-key");
      setSetting(db, "relay_models", "gpt-4o-mini");
      setSetting(
        db,
        "auto_model_ladder",
        JSON.stringify({ simple: "gpt-4o-mini", medium: "gpt-4o-mini", complex: "gpt-4o-mini" }),
      );
      setSetting(db, "relay_model_rates", JSON.stringify({ "gpt-4o-mini": 2 }));

      const user = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get("first@example.com") as unknown as { id: string };
      const token = createSession(db, user.id);
      const before = getQuota(db, user.id)?.totalRemaining ?? 0;

      const response = await handleRelayRequest(
        db,
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-zenith-charged-tokens")).toBe("2000");
      const after = getQuota(db, user.id)?.totalRemaining ?? 0;
      expect(before - after).toBe(2000);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      setSetting(db, "relay_model_rates", "{}");
    }
  });
});

describe("ZenithCloud 插件商店", () => {
  it("目录结构与官方 marketplace.json 兼容", () => {
    upsertPlugin(db, {
      pluginName: "demo-plugin",
      version: "1.0.0",
      displayName: "Demo",
      enabled: true,
      featured: true,
    });
    const catalog = buildMarketplaceJson(db);
    expect(catalog.name).toBe("zcode-plugins-official");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.featured).toEqual(["demo-plugin"]);
  });
});
