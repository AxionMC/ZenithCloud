# ZenithCloud 统一服务端与账号计费规格

状态：实现中（2026-10-23）
适用范围：`packages/server/src/zenith/**`、`packages/web/src/auth/**`、品牌字符串。

## 1. 目标

把原本依赖外部产品服务（z.ai OAuth / CDN 插件目录 / 外部模型 API）的能力收敛到本仓库自己的服务端，形成单进程 **ZenithCloud 服务端**：

1. 邮箱注册/登录，账号数据保存在服务端数据库。
2. 服务端可配置 SMTP 发信、Cloudflare Turnstile 人机验证。
3. 新用户注册赠送额度，默认 500,000（可由后台调整）；同一台电脑只发放一次。
4. 订阅套餐由后台创建，额度周期为「每周重置」；必须配置易支付后才能购买。
5. 服务端提供 OpenAI 兼容中转，使用邮箱账号登录态鉴权，不向用户发放 API Key；模型访问要求有效订阅（可由后台关闭该门槛）。
6. 插件商店服务端并入同一进程：目录 JSON + 插件包下载 + 后台增删改。
7. 管理后台：用户、设置、套餐、订单、插件管理。

非目标（本次不做）：
- 桌面端 OAuth 登录链路的替换（桌面端继续使用现有 OAuth；Web 端已移除第三方 OAuth 入口，只保留邮箱账号）。
- 修改内部包名 `@zcode/*`、协议字段、持久化目录名。品牌替换只针对用户可见文案。

## 2. 状态所有权

| 状态 | 唯一所有者 | 存储 |
| --- | --- | --- |
| 用户账号、密码哈希、登录会话 | 服务端 `ZenithStore` | SQLite |
| 设备去重（赠送资格） | 服务端 `devices` 表 | SQLite |
| 额度（赠送/订阅周额度） | 服务端 `quotaService` | SQLite |
| 订阅套餐、订单、支付状态 | 服务端 `billingService` | SQLite |
| SMTP / Turnstile / 易支付 / 上游中转配置 | 服务端 `settings` 表 | SQLite |
| 插件目录与插件包 | 服务端 `pluginStore` | SQLite + 数据目录文件 |
| 浏览器登录态 | Web 客户端 `localAuthStorage` | localStorage |
| 设备指纹 | Web 客户端 `deviceId` | localStorage（缺失时服务端按 IP+UA 兜底） |

额度扣减顺序：先扣赠送额度，再扣订阅周额度。订阅周额度按 `subscription_week_start` 惰性重置（跨周首个请求或查询时归零），不依赖定时任务。

## 3. 数据模型（SQLite）

- `settings(key TEXT PRIMARY KEY, value TEXT, updated_at)`
- `users(id, email UNIQUE, password_hash, display_name, role, status, created_at, last_login_at, register_ip, register_ua, device_hash, bonus_granted INTEGER, bonus_quota INTEGER, bonus_used INTEGER, subscription_plan_id, subscription_expires_at, subscription_week_start, subscription_weekly_quota, subscription_used)`
- `sessions(token_hash PRIMARY KEY, user_id, created_at, expires_at)`
- `api_keys(id, user_id, name, key_hash UNIQUE, key_prefix, created_at, last_used_at, revoked_at)`（历史表结构保留，当前不再发放 Key）
- `email_codes(id, email, purpose, code_hash, expires_at, consumed_at, created_at, attempts)`
- `devices(device_hash PRIMARY KEY, first_user_id, first_seen_at)`
- `plans(id, name, description, price_cents, duration_days, weekly_quota, sort, enabled, created_at)`（`price_cents` 为人民币分）
- `orders(out_trade_no PRIMARY KEY, user_id, plan_id, amount_cents, status, provider, trade_no, created_at, paid_at, raw_notify)`（`amount_cents` 为人民币分）
- `usage_logs(id, user_id, api_key_id, model, prompt_tokens, completion_tokens, total_tokens, charged_tokens, source, created_at)`
- `plugins(id, plugin_name, version, display_name, description, category, publisher_type, author, icon_url, homepage, download_url, storage_path, sha256, size, featured, enabled, sort, created_at, updated_at)`

约束：
- `devices.device_hash` 主键保证「同一设备只赠送一次」。注册时若 `device_hash` 已存在则不赠送；无 deviceId 时用 `sha256("ip:"+ip+"|ua:"+ua)` 兜底。
- 邮箱验证码 10 分钟有效、一次性、最多尝试 5 次；同一邮箱 60 秒内只能发一次。
- 密码使用 `scrypt`（16 字节 salt，64 字节 hash）。
- 会话 30 天有效；API Key 仅存 SHA-256，创建时返回一次明文。

## 4. HTTP 接口

公开接口（无需登录）：

- `GET  /api/auth/config` → `{ registrationEnabled, turnstileEnabled, turnstileSiteKey, smtpConfigured, epayConfigured }`
- `POST /api/auth/send-code` `{ email, purpose: "register"|"reset" }`
- `POST /api/auth/register` `{ email, password, code, deviceId?, turnstileToken? }` → `{ token, user, bonus }`
- `POST /api/auth/login` `{ email, password, turnstileToken? }` → `{ token, user }`
- `POST /api/auth/logout`（Bearer）
- `POST /api/auth/reset-password` `{ email, code, password }`（验证码重置）
- `POST /api/auth/change-password` `{ oldPassword, newPassword }`（Bearer）
- `GET  /api/auth/me`（Bearer）→ `{ user, quota, subscription, plans }`
- `GET  /api/auth/models`（Bearer）→ `{ models, autoOnly }`（由服务端从上游同步，免费用户仅 `auto`）
- `GET  /api/auth/usage`（Bearer）
- `GET  /api/billing/plans`
- `POST /api/billing/orders`（Bearer）`{ planId }` → `{ payUrl }`（未配置易支付返回 409）
- `POST /api/billing/epay/notify`（易支付异步回调；验签后置订单 paid 并发放订阅）
- `GET  /api/billing/epay/return`（同步跳回，302 到 `public_base_url`）
- `GET  /api/plugins/marketplace.json`（官方市场目录，兼容 marketplace.json 结构）
- `GET  /api/plugins/download/:pluginName/:version`（插件 zip）
- `GET  /api/public/settings` → 前端需要的公开配置子集

OpenAI 兼容中转（Bearer = 邮箱账号的登录会话令牌，不发放 API Key）：

- `GET  /v1/models`
- `POST /v1/chat/completions`（支持 stream 透传）
- `POST /v1/embeddings`
- `POST /v1/responses`（透传）

管理接口（`Authorization: Bearer <admin session>`，仅 `role=admin`）：

- `POST /api/admin/login` `{ email, password }`
- `GET  /api/admin/overview`
- `GET/POST/PATCH/DELETE /api/admin/users...`（禁用、改额度、授予/取消订阅）
- `GET/PUT /api/admin/settings`（分组：smtp / turnstile / epay / relay / signup）
- `GET/POST/PATCH/DELETE /api/admin/plans`
- `GET /api/admin/orders`
- `GET /api/admin/relay/models` / `POST /api/admin/relay/models/refresh`（上游模型列表缓存与刷新）
- `GET/POST/PATCH/DELETE /api/admin/plugins`
- `POST /api/admin/plugins/import-catalog`（从官方 CDN 拉取目录并入）
- 管理页面：`GET /admin`（内置单页，无构建步骤）

## 5. 关键规则

### 5.1 注册赠送

1. 校验 Turnstile（开启时）→ 校验邮箱验证码 → 校验邮箱未注册。
2. 计算 `device_hash`。首次出现的设备：赠送 `signup_bonus_quota`（默认 500000）。已存在：赠送 0，并在响应中返回 `bonus: 0`。
3. 赠送与用户创建在同一事务内，避免并发重复发放。

### 5.2 订阅与额度

- 套餐：`weekly_quota`（每周 token 额度）、`price_cents`（人民币分）、`duration_days`。接口返回统一带 `currency: "CNY"`。
- 支付成功：写 `subscription_plan_id / expires_at / weekly_quota`，`week_start = now`，`subscription_used = 0`；若已有未过期订阅，则顺延 `expires_at` 且额度按新套餐重置当周。
- 惰性重置：访问额度时若 `now - week_start >= 7d`，将 `week_start` 滚到当前周期并把 `subscription_used` 归零。
- 无有效订阅或订阅过期时，订阅额度不可用。

### 5.3 易支付

- 协议：彩虹易支付（MD5）。金额单位为人民币元（`money` 由人民币分换算），`sign = md5(按 key 升序拼接 k=v&... + key)`。
- 下单：`POST {gateway}/submit.php` 表单（`pid,type,out_trade_no,notify_url,return_url,name,money,sign,sign_type=MD5`）。
- 回调：校验 `sign`、`trade_status=TRADE_SUCCESS`、金额与订单一致；幂等（已 paid 直接返回 `success`）。
- 未配置 `epay_gateway/pid/key` 时 `POST /api/billing/orders` 返回 409。

### 5.4 模型中转与计费

- 上游：`relay_base_url`（必填，OpenAI 兼容根，如 `https://api.example.com/v1`）、`relay_api_key`、`relay_models`（逗号分隔，空=全部）、`relay_model_map`（JSON，旧名→上游名）。
- 鉴权：`Authorization: Bearer <登录会话令牌>`；同源浏览器还可直接使用登录时下发的 HttpOnly `zenith_session` Cookie。会话由邮箱登录创建，客户端不持有、也不需要单独申请 API Key。
- **Auto 模式**：请求 `model=auto`（或 `zenith-auto`）时，服务端按请求特征评分后从 `auto_model_ladder` 选择上游模型：
  - 评分维度：上下文字符数、消息轮数、是否带 tools、代码块数量；
  - `simple / medium / complex` 三档分别映射到管理员配置的模型；未配置时回落到 `relay_models[0]`。
- **免费用户强制 Auto**：`free_users_auto_only` 默认开启。无有效订阅的用户即使请求具体模型，服务端也会覆盖为 Auto；`/v1/models` 对免费用户只返回 `auto`。客户端无法关闭。
- **订阅用户**：可请求 `auto` 或 `relay_models` 允许的任意模型；`require_subscription_for_relay` 默认关闭（免费用户可用 Auto），开启后未订阅用户连 Auto 也不能用。
- **模型列表同步**：服务端调用上游 OpenAI 兼容的 `GET /v1/models` 获取模型，缓存到 settings（TTL 30 分钟），`auto_sync_models` 开启时自动写入 `relay_models`；`/v1/models` 与 `/api/auth/models` 返回同一份列表。管理端提供 `GET /api/admin/relay/models` 与 `POST /api/admin/relay/models/refresh`。
- **计费**：内置 OpenAI（gpt-4o / gpt-4.1 / o 系列）、Claude（Opus / Sonnet / Haiku）、DeepSeek（chat / reasoner / r1）人民币价格表，按输入、输出分别计价；基准为 1 额度 token = 1.08 元 / 1M tokens，可再乘 `billing_markup`。后台 `model_pricing` 可按模型覆盖内置价格（CNY / 1M tokens，输入/输出分开），`relay_model_rates` 中的显式系数优先级更高（按总 tokens × 系数，用于旧配置或特殊模型）。未知模型按 1:1 计费。单次用量超过剩余额度时扣完剩余额度，避免变成免费调用。
- 请求体中的 `model` 按 `relay_model_map` 改写后再转发；Auto 选出的模型同样受 `relay_models` 白名单约束。
- 记录 `usage_logs`（原始 tokens、计费 tokens、实际模型），扣减顺序为先赠送额度、后订阅周额度。
- **本地客户端网关**：设置 `ZENITH_LOCAL_GATEWAY=1` 后，来自回环地址、携带固定标识 `zenith-local-gateway` 的请求会归属到最近一次邮箱登录的账号，供同机部署的内置客户端接入并正常计费。客户端与服务器不在同一台机器时，可再加 `ZENITH_LOCAL_GATEWAY_ALLOW_REMOTE=1` 放行非回环请求（共享固定标识，仅建议可信环境）。内置 Provider 模板 Base URL 为 `https://api.hongkongyun.top/v1`，模板 schema 不允许写入 `apiKey`，客户端首次使用需在 Key 栏填这个固定标识。

### 5.5 插件商店

- 目录输出结构与官方 `marketplace.json` 兼容：`{ id, name, description, lastUpdated, featured, plugins: [...] }`。
- 每个插件条目至少包含 `id/name/version/description/listing`；下载优先返回数据目录中的 zip，否则 302 到 `download_url`。
- 管理端可直接录入条目，也可 `import-catalog` 从官方 CDN 导入后人工启用/排序。

## 6. 部署与配置

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `ZENITH_DATA_DIR` | SQLite 与插件包目录 | `~/.zenithcloud` |
| `ZENITH_ADMIN_EMAIL` | 初始管理员邮箱 | `admin@zenithcloud.local` |
| `ZENITH_ADMIN_PASSWORD` | 初始管理员密码 | `zenithcloud` |
| `ZENITH_PLUGIN_MARKETPLACE_URL` | 客户端官方市场目录 | 官方 CDN |
| `ZENITH_LOCAL_GATEWAY` | 允许同机内置客户端免 Key 接入（仅回环地址） | 未开启 |
| `ZENITH_LOCAL_GATEWAY_ALLOW_REMOTE` | 允许非回环地址使用本地网关标识（共享标识，谨慎开启） | 未开启 |

- 数据文件：`<ZENITH_DATA_DIR>/zenithcloud.sqlite`，插件包：`<ZENITH_DATA_DIR>/plugins/<plugin>/<version>.zip`。
- 首次启动创建管理员；管理员密码可在 `/admin → 设置 → 管理员密码` 修改。
- 易支付回调依赖 `public_base_url`，生产环境必须是公网可访问的 HTTPS 地址。
- 服务端配置读取数据库，修改后立即生效，不缓存。
- Docker：`packages/server/Dockerfile` + `packages/server/docker-compose.yml`，直接监听 `2055`（不带 Nginx），数据卷 `/data`，管理员由 `ZENITH_ADMIN_EMAIL` / `ZENITH_ADMIN_PASSWORD` 初始化。

## 7. 验收场景

1. 未配置 SMTP 时注册返回 503；配置后可收到 6 位验证码，10 分钟内可完成注册。
2. 同一 `deviceId` 注册第二个账号：`bonus=0`；换设备注册：`bonus=500000`（或后台调整值）。
3. Turnstile 开启且 token 无效：注册/登录 400；关闭时不校验。
4. 未配置易支付：创建订单 409；配置后返回 `submit.php` 支付链接。
5. 支付回调验签失败：400 且订单保持 pending；验签成功：订单 paid、订阅生效、当周额度可用。
6. 订阅跨周后首次请求：`subscription_used` 归零。
7. 客户端使用邮箱登录态调用 `/v1/chat/completions`：转发到 `relay_base_url`，返回体与上游一致；流式逐块透传；按 usage × 模型系数扣减额度。
8. 免费用户请求具体模型：服务端强制使用 Auto；订阅用户可自选模型。未订阅且开启订阅门槛：403，且不请求上游；额度耗尽：402。
9. 管理端可修改赠送额度、SMTP、Turnstile、易支付、上游中转、Auto 阶梯、模型计费倍率与订阅门槛；修改立即生效（读库，不缓存）。
10. `/admin` 可打开管理页；非管理员访问管理 API 返回 401/403。
11. Web 登录页只有邮箱登录/注册，不再展示第三方 OAuth 入口。
12. 本机客户端使用 `zenith-local-gateway` + `ZENITH_LOCAL_GATEWAY=1` 调用时，归属最近登录账号并正常扣减额度。
