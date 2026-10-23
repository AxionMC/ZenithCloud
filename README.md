# ZenithCloud

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZenithCloud" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZenithCloud 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

## ZenithCloud 服务端（账号 / 额度 / 订阅 / 中转 / 插件商店）

`packages/server` 已内置统一后端（`packages/server/src/zenith/`），随 Web 服务一起启动：

- 邮箱注册/登录，验证码通过后台配置的 SMTP 发送；支持 Cloudflare Turnstile 人机验证。Web 登录页只保留邮箱账号，不再展示第三方 OAuth 入口。
- 新用户赠送额度，默认 500,000 tokens，可在后台调整；同一设备只发放一次（设备 ID，缺失时用 IP + User-Agent 兜底去重）。
- 订阅套餐、易支付购买、每周额度自动重置（惰性重置，不依赖定时任务）。订阅价格与支付金额统一按人民币（CNY / 元）计价，接口返回 `currency: "CNY"`。
- 模型访问与账号登录绑定：用户只用邮箱账号登录客户端，不发 API Key。免费用户被服务端强制使用 **Auto 模式**（按任务难度自动选择模型，客户端无法关闭）；订阅用户可自选模型。`require_subscription_for_relay` 默认关闭，开启后未订阅用户连 Auto 也不能用。
- 计费：内置 OpenAI（gpt-4o / gpt-4.1 / o 系列）、Claude（Opus / Sonnet / Haiku）、DeepSeek（chat / reasoner）价格表，按输入/输出分别计价；后台「模型价格」可逐模型覆盖内置价格，也可设置加价倍率与总 tokens 系数。单次超出剩余额度时扣完剩余额度，不会变成免费调用。
- 模型列表由服务端调用上游 `/v1/models` 获取并缓存，默认自动写入允许列表；管理后台可一键刷新，客户端通过 `/v1/models` 或账户中心“可用模型”同步。
- 同机客户端可用 `ZENITH_LOCAL_GATEWAY=1` + 固定标识 `zenith-local-gateway` 免账号 Key 接入，用量归属最近一次邮箱登录的账号。内置客户端模板名为 `ZenithCloud`（Base URL 为 `https://api.hongkongyun.top/v1`），在客户端模型设置里选中后，API Key 填固定标识 `zenith-local-gateway`；后台 `relay_models` 要与模板中的模型 ID 对齐（留空表示放开全部）。
- 客户端与服务器不在同一台机器、需要直接访问公网域名时，额外设置 `ZENITH_LOCAL_GATEWAY_ALLOW_REMOTE=1`。该模式使用共享固定标识并按最近登录账号计费，仅建议单人/可信环境使用；多人共享服务器应改用各账号的登录会话令牌。
- OpenAI 兼容中转：客户端 Base URL 填 `<服务地址>/v1`，鉴权使用账号登录态（Bearer 会话令牌或同源 HttpOnly Cookie）。
- 插件商店：`GET <服务地址>/api/plugins/marketplace.json`，插件包由服务端托管。
- 管理后台：`<服务地址>/admin`，可管理用户、套餐、订单、插件，以及 SMTP、Turnstile、易支付、上游中转和赠送额度。

环境变量：

| 变量                            | 说明                     | 默认值                    |
| ------------------------------- | ------------------------ | ------------------------- |
| `ZENITH_DATA_DIR`               | SQLite 与插件包数据目录  | `~/.zenithcloud`          |
| `ZENITH_ADMIN_EMAIL`            | 初始管理员邮箱           | `admin@zenithcloud.local` |
| `ZENITH_ADMIN_PASSWORD`         | 初始管理员密码           | `zenithcloud`             |
| `ZENITH_PLUGIN_MARKETPLACE_URL` | 客户端拉取官方市场的地址 | 官方 CDN                  |
| `ZENITH_LOCAL_GATEWAY`          | 允许本地网关标识接入（默认仅回环地址） | 未开启 |
| `ZENITH_LOCAL_GATEWAY_ALLOW_REMOTE` | 允许非回环地址使用本地网关标识（共享标识，谨慎开启） | 未开启 |

首次启动会创建管理员账号；登录 `/admin` 后请立即在「设置 → 管理员密码」修改。管理员需要依次配置 SMTP（否则注册不可用）、Turnstile（可选）、`public_base_url`（易支付回调要求公网可访问的 HTTPS 地址）、易支付网关/PID/密钥、上游中转 Base URL 与 Key。未配置易支付时订阅下单返回 409。

规格、数据模型与验收场景见 [specs/zenithcloud-saas-platform.md](specs/zenithcloud-saas-platform.md)。

## Docker 部署（服务端，直接监听 2055）

镜像内不包含 Nginx，服务直接监听 `2055`，宿主机已有 Nginx 可直接反代到 `127.0.0.1:2055`。

```bash
docker compose -f packages/server/docker-compose.yml up -d --build
```

- 访问 `http://<宿主机IP>:2055/admin`。
- 管理员账号：`CLzimo`，密码：`qwertyuiop1234`（首次启动写入，登录后请立即修改）。
- 数据（SQLite、插件包）保存在 `zenithcloud-data` 卷；删除卷会重新初始化管理员。
- 只监听本机给 Nginx 用时，把 `packages/server/docker-compose.yml` 的端口改成 `"127.0.0.1:2055:2055"`。
- 常用环境变量：`ZENITH_ADMIN_EMAIL`、`ZENITH_ADMIN_PASSWORD`、`ZENITH_DATA_DIR`、`ZENITH_LOCAL_GATEWAY`、`ZENITH_PLUGIN_MARKETPLACE_URL`。

## 更新

- **2026-10-19**：更新至 ZenithCloud v3.16.2 版本。
- **2026-10-16**：更新至 ZenithCloud v3.16.1 版本。
- 2026-10-10：更新至 ZenithCloud v3.15.1 版本。
- 2026-9-23：更新至 ZenithCloud v3.14.3 版本。

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZenithCloud 命令行版”打包章节解压运行。

### ZenithCloud 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

### CLI 源码开发

CLI 的模型配置、非交互调用、工具与扩展、批量评测和轨迹记录见 [CLI 使用指南](apps/zcode-cli/docs/usage/README.md)。

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

### UI Plugin 开发

参见 [UI Plugin：能力、API 与调试](UI_PLUGIN.md)，从 Excalidraw 的画布协作示例开始，了解插件安装更新、页面 API 和宿主联调入口。

**向 `zcode-plugins` 提交插件 PR 时，必须在 PR 模板中声明是否为 UI Plugin，并填写插件名称。** 判断标准见[提交 PR 时声明插件类型](UI_PLUGIN.md#提交-pr-时声明插件类型)。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

第三方声明生成、发行校验流程及声明在发行物中的位置见 [third-party/README.md](third-party/README.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZenithCloud 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZenithCloud.app
```

### ZenithCloud 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
