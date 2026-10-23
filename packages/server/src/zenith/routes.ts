import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureDefaultSettings,
  readEpayConfig,
  readPublicSettings,
  readRelayConfig,
} from "./settings.js";
import {
  bootstrapAdminAccount,
  changePassword,
  loginUser,
  logoutUser,
  readMe,
  registerUser,
  resetPassword,
  sendVerificationCode,
  type EmailCodePurpose,
} from "./authService.js";
import {
  deleteSession,
  findSessionUser,
  purgeExpiredSessions,
} from "./session.js";
import { getQuota } from "./quota.js";
import { getSettingBool, openZenithDatabase } from "./database.js";
import {
  createOrder,
  createPlan,
  deletePlan,
  handleEpayNotify as processEpayNotify,
  listOrders,
  listPlans,
  updatePlan,
} from "./billing.js";
import {
  buildMarketplaceJson,
  deletePlugin,
  importOfficialCatalog,
  listPlugins,
  readPluginPackage,
  savePluginPackage,
  updatePluginById,
  upsertPlugin,
} from "./plugins.js";
import { handleRelayRequest } from "./relay.js";
import {
  readCachedUpstreamModels,
  refreshUpstreamModels,
  refreshUpstreamModelsIfStale,
  resolveServableModels,
} from "./upstreamModels.js";
import {
  adminLogin,
  getOverview,
  listUsage,
  listUsers,
  readAdminSettings,
  updateUserAsAdmin,
  writeAdminSettings,
} from "./adminService.js";
import { ZenithError } from "./types.js";
import type { ZenithUserRow } from "./types.js";
import { ADMIN_PAGE_HTML } from "./adminPage.js";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export interface ZenithRuntime {
  db: DatabaseSync;
  dataDir: string;
  filePath: string;
  adminEmail: string;
  adminCreated: boolean;
}

export function createZenithRuntime(options: { dataDir?: string } = {}): ZenithRuntime {
  const { db, dataDir, filePath } = options.dataDir
    ? openZenithDatabase(options.dataDir)
    : openZenithDatabase();
  ensureDefaultSettings(db);
  purgeExpiredSessions(db);
  const admin = bootstrapAdminAccount(db);
  return { db, dataDir, filePath, adminEmail: admin.email, adminCreated: admin.created };
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function textReply(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

const SESSION_COOKIE = "zenith_session";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * 登录后同时下发 HttpOnly Cookie：同源的浏览器客户端调用 /v1 时无需再持有
 * 或展示任何 API Key，登录态本身就是模型访问凭据。
 */
function withSessionCookie(response: Response, token: string, requestUrl: string): Response {
  const secure = requestUrl.startsWith("https://") ? "; Secure" : "";
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}${secure}`,
  );
  return response;
}

function clearSessionCookie(response: Response, requestUrl: string): Response {
  const secure = requestUrl.startsWith("https://") ? "; Secure" : "";
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`,
  );
  return response;
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

function requireUser(c: Context, db: DatabaseSync): ZenithUserRow {
  const user = findSessionUser(db, bearerToken(c));
  if (!user) throw new ZenithError(401, "登录已失效，请重新登录");
  return user;
}

function requireAdmin(c: Context, db: DatabaseSync): ZenithUserRow {
  const user = requireUser(c, db);
  if (user.role !== "admin") throw new ZenithError(403, "需要管理员权限");
  return user;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ZenithError(400, "请求体不是合法 JSON");
  }
}

function handle(fn: (c: Context) => Promise<Response> | Response) {
  return async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof ZenithError) {
        return jsonReply({ error: error.message }, error.status);
      }
      console.error("[zenithcloud] request failed", error);
      return jsonReply({ error: "服务器内部错误" }, 500);
    }
  };
}

function applyCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function isLoopbackRequest(c: Context): boolean {
  // Hono Node adapter 把原始 Node req 放在 c.env.incoming；只信任真实 socket 地址，
  // 不信任可伪造的 X-Forwarded-For。
  const env = c.env as unknown as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  const address = env?.incoming?.socket?.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function registerZenithRoutes(app: Hono, runtime: ZenithRuntime): void {
  const { db, dataDir } = runtime;

  // 预检请求在鉴权中间件之前返回，浏览器才能拿到 CORS 响应。
  app.options("/api/*", () => new Response(null, { status: 204, headers: CORS_HEADERS }));
  app.options("/v1/*", () => new Response(null, { status: 204, headers: CORS_HEADERS }));

  app.get(
    "/admin",
    () => new Response(ADMIN_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  app.get(
    "/admin/",
    () => new Response(ADMIN_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );

  // ---------- 公开配置 ----------
  app.get("/api/public/settings", handle((c) => jsonReply(readPublicSettings(db))));

  // ---------- 账号 ----------
  app.get("/api/auth/config", handle((c) => jsonReply(readPublicSettings(db))));

  app.post(
    "/api/auth/send-code",
    handle(async (c) => {
      const body = await readJsonBody(c);
      const purpose: EmailCodePurpose = body["purpose"] === "reset" ? "reset" : "register";
      await sendVerificationCode(db, {
        email: String(body["email"] ?? ""),
        purpose,
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
        userAgent: c.req.header("user-agent") ?? "",
        ...(typeof body["turnstileToken"] === "string"
          ? { turnstileToken: body["turnstileToken"] }
          : {}),
      });
      return jsonReply({ ok: true });
    }),
  );

  app.post(
    "/api/auth/register",
    handle(async (c) => {
      const body = await readJsonBody(c);
      const result = await registerUser(db, {
        email: String(body["email"] ?? ""),
        password: String(body["password"] ?? ""),
        code: String(body["code"] ?? ""),
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
        userAgent: c.req.header("user-agent") ?? "",
        ...(typeof body["deviceId"] === "string" ? { deviceId: body["deviceId"] } : {}),
        ...(typeof body["turnstileToken"] === "string"
          ? { turnstileToken: body["turnstileToken"] }
          : {}),
      });
      return withSessionCookie(jsonReply(result), result.token, c.req.url);
    }),
  );

  app.post(
    "/api/auth/login",
    handle(async (c) => {
      const body = await readJsonBody(c);
      const result = await loginUser(db, {
        email: String(body["email"] ?? ""),
        password: String(body["password"] ?? ""),
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
        userAgent: c.req.header("user-agent") ?? "",
        ...(typeof body["turnstileToken"] === "string"
          ? { turnstileToken: body["turnstileToken"] }
          : {}),
      });
      return withSessionCookie(jsonReply(result), result.token, c.req.url);
    }),
  );

  app.post(
    "/api/auth/logout",
    handle((c) => {
      logoutUser(db, bearerToken(c));
      return clearSessionCookie(jsonReply({ ok: true }), c.req.url);
    }),
  );

  app.post(
    "/api/auth/reset-password",
    handle(async (c) => {
      const body = await readJsonBody(c);
      resetPassword(db, {
        email: String(body["email"] ?? ""),
        code: String(body["code"] ?? ""),
        password: String(body["password"] ?? ""),
      });
      return jsonReply({ ok: true });
    }),
  );

  app.post(
    "/api/auth/change-password",
    handle(async (c) => {
      const user = requireUser(c, db);
      const body = await readJsonBody(c);
      changePassword(
        db,
        user.id,
        String(body["oldPassword"] ?? ""),
        String(body["newPassword"] ?? ""),
      );
      return jsonReply({ ok: true });
    }),
  );

  app.get(
    "/api/auth/me",
    handle((c) => {
      const user = requireUser(c, db);
      return jsonReply(readMe(db, user.id));
    }),
  );

  app.get(
    "/api/auth/usage",
    handle((c) => {
      const user = requireUser(c, db);
      const rows = db
        .prepare(
          "SELECT id, model, prompt_tokens, completion_tokens, total_tokens, charged_tokens, source, created_at " +
            "FROM usage_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
        )
        .all(user.id);
      return jsonReply({ usage: rows });
    }),
  );

  app.get(
    "/api/auth/models",
    handle(async (c) => {
      const user = requireUser(c, db);
      const quota = getQuota(db, user.id);
      await refreshUpstreamModelsIfStale(db);
      const autoOnly =
        getSettingBool(db, "free_users_auto_only", true) && !quota?.subscriptionActive;
      const models = autoOnly
        ? ["auto"]
        : ["auto", ...resolveServableModels(db, readRelayConfig(db))];
      return jsonReply({ models, autoOnly });
    }),
  );

  // ---------- 计费 ----------
  app.get(
    "/api/billing/plans",
    handle(() => jsonReply({ plans: listPlans(db, true) })),
  );

  app.post(
    "/api/billing/orders",
    handle(async (c) => {
      const user = requireUser(c, db);
      const body = await readJsonBody(c);
      const epay = readEpayConfig(db);
      const fallbackBase = epay.publicBaseUrl || new URL(c.req.url).origin;
      const result = createOrder(db, user.id, String(body["planId"] ?? ""), fallbackBase);
      return jsonReply(result);
    }),
  );

  app.get(
    "/api/billing/orders",
    handle((c) => {
      const user = requireUser(c, db);
      return jsonReply({ orders: listOrders(db, user.id, 50) });
    }),
  );

  app.get(
    "/api/billing/epay/return",
    handle((c) => {
      const base = readEpayConfig(db).publicBaseUrl || "/";
      return c.redirect(`${base.replace(/\/+$/, "")}/?payment=return`);
    }),
  );

  const epayNotifyRoute = async (c: Context): Promise<Response> => {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(c.req.query())) params[key] = value;
    if (c.req.method === "POST") {
      try {
        const form = await c.req.parseBody();
        for (const [key, value] of Object.entries(form)) {
          if (typeof value === "string") params[key] = value;
        }
      } catch {
        // 非表单请求体走 query 参数。
      }
    }
    const result = processEpayNotify(db, params);
    return textReply(result.message);
  };

  app.post("/api/billing/epay/notify", handle(epayNotifyRoute));
  app.get("/api/billing/epay/notify", handle(epayNotifyRoute));

  // ---------- 插件商店 ----------
  app.get(
    "/api/plugins/marketplace.json",
    handle(() => jsonReply(buildMarketplaceJson(db))),
  );

  app.get(
    "/api/plugins/download/:pluginName/:version",
    handle((c) => {
      const pluginName = c.req.param("pluginName") ?? "";
      const version = c.req.param("version") ?? "";
      const buffer = readPluginPackage(dataDir, pluginName, version);
      if (buffer) {
        return new Response(buffer, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${pluginName}-${version}.zip"`,
            ...CORS_HEADERS,
          },
        });
      }
      const row = db
        .prepare("SELECT download_url FROM plugins WHERE plugin_name = ? AND version = ?")
        .get(pluginName, version) as unknown as { download_url?: string } | undefined;
      if (row?.download_url) return c.redirect(row.download_url);
      throw new ZenithError(404, "插件包不存在");
    }),
  );

  // ---------- 管理端 ----------
  app.post(
    "/api/admin/login",
    handle(async (c) => {
      const body = await readJsonBody(c);
      return jsonReply(adminLogin(db, String(body["email"] ?? ""), String(body["password"] ?? "")));
    }),
  );

  app.post(
    "/api/admin/logout",
    handle((c) => {
      deleteSession(db, bearerToken(c));
      return jsonReply({ ok: true });
    }),
  );

  app.get(
    "/api/admin/overview",
    handle((c) => {
      requireAdmin(c, db);
      return jsonReply(getOverview(db));
    }),
  );

  app.get(
    "/api/admin/users",
    handle((c) => {
      requireAdmin(c, db);
      const query = c.req.query("query") ?? "";
      const limit = Number.parseInt(c.req.query("limit") ?? "50", 10) || 50;
      const offset = Number.parseInt(c.req.query("offset") ?? "0", 10) || 0;
      return jsonReply({ users: listUsers(db, { query, limit, offset }) });
    }),
  );

  app.patch(
    "/api/admin/users/:id",
    handle(async (c) => {
      const admin = requireAdmin(c, db);
      const body = await readJsonBody(c);
      const result = updateUserAsAdmin(db, admin.id, c.req.param("id") ?? "", body);
      return jsonReply(result);
    }),
  );

  app.get(
    "/api/admin/settings",
    handle((c) => {
      requireAdmin(c, db);
      return jsonReply({ settings: readAdminSettings(db) });
    }),
  );

  app.put(
    "/api/admin/settings",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      const applied = writeAdminSettings(db, body);
      return jsonReply({ ok: true, applied });
    }),
  );

  app.get(
    "/api/admin/plans",
    handle((c) => {
      requireAdmin(c, db);
      return jsonReply({ plans: listPlans(db, false) });
    }),
  );

  app.post(
    "/api/admin/plans",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      return jsonReply(createPlan(db, body));
    }),
  );

  app.patch(
    "/api/admin/plans/:id",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      return jsonReply(updatePlan(db, c.req.param("id") ?? "", body));
    }),
  );

  app.delete(
    "/api/admin/plans/:id",
    handle((c) => {
      requireAdmin(c, db);
      deletePlan(db, c.req.param("id") ?? "");
      return jsonReply({ ok: true });
    }),
  );

  app.get(
    "/api/admin/orders",
    handle((c) => {
      requireAdmin(c, db);
      const limit = Number.parseInt(c.req.query("limit") ?? "100", 10) || 100;
      return jsonReply({ orders: listOrders(db, undefined, limit) });
    }),
  );

  app.get(
    "/api/admin/usage",
    handle((c) => {
      requireAdmin(c, db);
      const limit = Number.parseInt(c.req.query("limit") ?? "200", 10) || 200;
      return jsonReply({ usage: listUsage(db, limit) });
    }),
  );

  app.get(
    "/api/admin/relay/models",
    handle((c) => {
      requireAdmin(c, db);
      return jsonReply(readCachedUpstreamModels(db));
    }),
  );

  app.post(
    "/api/admin/relay/models/refresh",
    handle(async (c) => {
      requireAdmin(c, db);
      return jsonReply(await refreshUpstreamModels(db));
    }),
  );

  app.get(
    "/api/admin/plugins",
    handle((c) => {
      requireAdmin(c, db);
      return jsonReply({ plugins: listPlugins(db, false) });
    }),
  );

  app.post(
    "/api/admin/plugins",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      return jsonReply(upsertPlugin(db, body));
    }),
  );

  app.patch(
    "/api/admin/plugins/:id",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      return jsonReply(updatePluginById(db, c.req.param("id") ?? "", body));
    }),
  );

  app.delete(
    "/api/admin/plugins/:id",
    handle((c) => {
      requireAdmin(c, db);
      deletePlugin(db, c.req.param("id") ?? "");
      return jsonReply({ ok: true });
    }),
  );

  app.post(
    "/api/admin/plugins/import-catalog",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      const url =
        typeof body["url"] === "string" && body["url"].trim()
          ? body["url"].trim()
          : "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
      return jsonReply(await importOfficialCatalog(db, url));
    }),
  );

  app.post(
    "/api/admin/plugins/upload",
    handle(async (c) => {
      requireAdmin(c, db);
      const body = await readJsonBody(c);
      const row = savePluginPackage(db, dataDir, {
        pluginName: String(body["pluginName"] ?? ""),
        ...(typeof body["version"] === "string" ? { version: body["version"] } : {}),
        dataBase64: String(body["dataBase64"] ?? ""),
        ...(typeof body["sha256"] === "string" ? { sha256: body["sha256"] } : {}),
      });
      return jsonReply({ ok: true, plugin: { id: row.id, sha256: row.sha256, size: row.size } });
    }),
  );

  // ---------- OpenAI 兼容中转 ----------
  app.all(
    "/v1/*",
    handle(async (c) =>
      applyCors(
        await handleRelayRequest(db, c.req.raw, { localGatewayAllowed: isLoopbackRequest(c) }),
      ),
    ),
  );

  // 未知 API 路径返回 JSON 404，避免落到 SPA 静态回退。
  const notFound = (c: Context) => jsonReply({ error: "Not found" }, 404);
  app.all("/api/auth/*", handle(notFound));
  app.all("/api/billing/*", handle(notFound));
  app.all("/api/plugins/*", handle(notFound));
  app.all("/api/admin/*", handle(notFound));
  app.all("/v1", handle(notFound));
}
