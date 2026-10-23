/**
 * 内置管理后台（单页、零构建）。由 /admin 直接返回字符串，
 * 避免额外引入前端构建链；所有数据都走 /api/admin/*。
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ZenithCloud 管理后台</title>
<style>
:root { color-scheme: dark; --bg:#0b0d12; --panel:#141821; --line:#232936; --text:#e7ebf3; --muted:#8b93a7; --accent:#5b8cff; --danger:#e5534b; --ok:#2ea043; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; align-items:center; justify-content:space-between; padding:14px 22px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(11,13,18,.92); backdrop-filter:blur(8px); z-index:5; }
h1 { font-size:17px; margin:0; letter-spacing:.3px; }
h2 { font-size:15px; margin:0 0 12px; }
nav { display:flex; gap:6px; flex-wrap:wrap; }
nav button { background:transparent; color:var(--muted); border:1px solid transparent; padding:7px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
nav button.active { background:var(--panel); color:var(--text); border-color:var(--line); }
main { padding:22px; max-width:1180px; margin:0 auto; }
section.tab { display:none; }
section.tab.active { display:block; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.card .label { color:var(--muted); font-size:12px; }
.card .value { font-size:24px; font-weight:650; margin-top:6px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:12px; }
td input, td select { width:100%; }
input, select, textarea { background:#0d1119; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; font-family:inherit; }
input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent); }
button.primary { background:var(--accent); color:#fff; border:none; border-radius:8px; padding:9px 14px; font-size:13px; cursor:pointer; }
button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 12px; font-size:13px; cursor:pointer; }
button.danger { background:transparent; color:var(--danger); border:1px solid var(--danger); border-radius:8px; padding:6px 10px; font-size:12px; cursor:pointer; }
button.small { padding:5px 9px; font-size:12px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
.field { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.field label { font-size:12px; color:var(--muted); }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.muted { color:var(--muted); font-size:12px; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); color:var(--muted); }
.badge.ok { color:var(--ok); border-color:rgba(46,160,67,.4); }
.badge.off { color:var(--danger); border-color:rgba(229,83,75,.4); }
#login { max-width:380px; margin:12vh auto; }
#login .panel { padding:22px; }
#toast { position:fixed; right:18px; bottom:18px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; }
#toast.show { opacity:1; }
.scroll { overflow:auto; max-height:62vh; }
@media (max-width:760px){ .grid2,.grid3{ grid-template-columns:1fr; } main{padding:14px;} }
</style>
</head>
<body>
<header>
  <h1>ZenithCloud 管理后台</h1>
  <div class="row" id="headerActions" style="display:none">
    <span class="muted" id="whoami"></span>
    <button class="ghost small" onclick="logout()">退出</button>
  </div>
</header>
<div id="login">
  <div class="panel">
    <h2>管理员登录</h2>
    <div class="field"><label>账号 / 邮箱</label><input id="loginEmail" autocomplete="username" placeholder="管理员账号或邮箱" /></div>
    <div class="field"><label>密码</label><input id="loginPassword" type="password" autocomplete="current-password" /></div>
    <button class="primary" style="width:100%" onclick="login()">登录</button>
    <p class="muted" style="margin:12px 0 0">默认账号由 ZENITH_ADMIN_EMAIL / ZENITH_ADMIN_PASSWORD 环境变量初始化。</p>
  </div>
</div>
<main id="app" style="display:none">
  <nav id="tabs">
    <button data-tab="overview" class="active" onclick="showTab('overview')">概览</button>
    <button data-tab="users" onclick="showTab('users')">用户</button>
    <button data-tab="plans" onclick="showTab('plans')">订阅套餐</button>
    <button data-tab="orders" onclick="showTab('orders')">订单</button>
    <button data-tab="plugins" onclick="showTab('plugins')">插件</button>
    <button data-tab="settings" onclick="showTab('settings')">设置</button>
  </nav>

  <section class="tab active" id="tab-overview" style="margin-top:18px">
    <div class="cards" id="overviewCards"></div>
  </section>

  <section class="tab" id="tab-users">
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input id="userQuery" placeholder="搜索邮箱或 ID" style="max-width:280px" />
        <button class="ghost" onclick="loadUsers()">搜索</button>
        <span class="muted" id="userCount"></span>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>邮箱</th><th>状态</th><th>赠送剩余</th><th>订阅</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody id="userRows"></tbody>
      </table></div>
    </div>
  </section>

  <section class="tab" id="tab-plans">
    <div class="panel">
      <h2>新建套餐</h2>
      <div class="grid3">
        <div class="field"><label>名称</label><input id="planName" placeholder="月度会员" /></div>
        <div class="field"><label>价格（CNY / 元）</label><input id="planPrice" type="number" min="0" step="0.01" value="29" /></div>
        <div class="field"><label>有效天数</label><input id="planDays" type="number" min="1" value="30" /></div>
        <div class="field"><label>每周额度（tokens）</label><input id="planQuota" type="number" min="1" value="5000000" /></div>
        <div class="field"><label>排序</label><input id="planSort" type="number" value="0" /></div>
        <div class="field"><label>启用</label><select id="planEnabled"><option value="true">启用</option><option value="false">停用</option></select></div>
      </div>
      <button class="primary" onclick="createPlan()">创建套餐</button>
    </div>
    <div class="panel"><div class="scroll"><table>
      <thead><tr><th>名称</th><th>价格 (CNY)</th><th>天数</th><th>每周额度</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="planRows"></tbody>
    </table></div></div>
  </section>

  <section class="tab" id="tab-orders">
    <div class="panel"><div class="scroll"><table>
      <thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>创建</th><th>支付</th></tr></thead>
      <tbody id="orderRows"></tbody>
    </table></div></div>
  </section>

  <section class="tab" id="tab-plugins">
    <div class="panel">
      <h2>新增 / 更新插件</h2>
      <div class="grid3">
        <div class="field"><label>插件名（id）</label><input id="pluginName" placeholder="my-plugin" /></div>
        <div class="field"><label>版本</label><input id="pluginVersion" value="latest" /></div>
        <div class="field"><label>显示名</label><input id="pluginDisplay" /></div>
        <div class="field"><label>分类</label><input id="pluginCategory" placeholder="productivity" /></div>
        <div class="field"><label>下载地址（外链，可空）</label><input id="pluginUrl" placeholder="https://..." /></div>
        <div class="field"><label>作者</label><input id="pluginAuthor" /></div>
      </div>
      <div class="field"><label>描述</label><textarea id="pluginDesc" rows="2"></textarea></div>
      <div class="row">
        <button class="primary" onclick="savePlugin()">保存条目</button>
        <button class="ghost" onclick="importCatalog()">从官方 CDN 导入目录</button>
        <input id="pluginFile" type="file" accept=".zip" style="max-width:260px" />
        <button class="ghost" onclick="uploadPlugin()">上传 zip</button>
      </div>
    </div>
    <div class="panel"><div class="scroll"><table>
      <thead><tr><th>插件</th><th>版本</th><th>分类</th><th>来源</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="pluginRows"></tbody>
    </table></div></div>
  </section>

  <section class="tab" id="tab-settings">
    <div class="panel">
      <h2>注册与赠送</h2>
      <div class="grid3">
        <div class="field"><label>开放注册</label><select id="set_registration_enabled"><option value="true">开启</option><option value="false">关闭</option></select></div>
        <div class="field"><label>新用户赠送额度</label><input id="set_signup_bonus_quota" type="number" min="0" /></div>
        <div class="field"><label>对外访问地址 public_base_url</label><input id="set_public_base_url" placeholder="https://your-domain.com" /></div>
      </div>
    </div>
    <div class="panel">
      <h2>SMTP 发信</h2>
      <div class="grid3">
        <div class="field"><label>启用</label><select id="set_smtp_enabled"><option value="true">开启</option><option value="false">关闭</option></select></div>
        <div class="field"><label>Host</label><input id="set_smtp_host" /></div>
        <div class="field"><label>Port</label><input id="set_smtp_port" type="number" /></div>
        <div class="field"><label>SSL（465 勾选）</label><select id="set_smtp_secure"><option value="true">是</option><option value="false">否</option></select></div>
        <div class="field"><label>用户名</label><input id="set_smtp_username" /></div>
        <div class="field"><label>密码 / 授权码</label><input id="set_smtp_password" type="password" /></div>
        <div class="field"><label>发件地址</label><input id="set_smtp_from_address" /></div>
        <div class="field"><label>发件人名称</label><input id="set_smtp_from_name" /></div>
      </div>
    </div>
    <div class="panel">
      <h2>Cloudflare Turnstile</h2>
      <div class="grid3">
        <div class="field"><label>启用</label><select id="set_turnstile_enabled"><option value="true">开启</option><option value="false">关闭</option></select></div>
        <div class="field"><label>Site Key</label><input id="set_turnstile_site_key" /></div>
        <div class="field"><label>Secret Key</label><input id="set_turnstile_secret_key" type="password" /></div>
      </div>
    </div>
    <div class="panel">
      <h2>易支付</h2>
      <div class="grid3">
        <div class="field"><label>启用</label><select id="set_epay_enabled"><option value="true">开启</option><option value="false">关闭</option></select></div>
        <div class="field"><label>网关地址</label><input id="set_epay_gateway" placeholder="https://pay.example.com" /></div>
        <div class="field"><label>PID</label><input id="set_epay_pid" /></div>
        <div class="field"><label>密钥</label><input id="set_epay_key" type="password" /></div>
        <div class="field"><label>支付方式</label><select id="set_epay_type"><option value="alipay">支付宝</option><option value="wxpay">微信</option><option value="qqpay">QQ</option></select></div>
      </div>
    </div>
    <div class="panel">
      <h2>上游模型中转（OpenAI 兼容）</h2>
      <div class="grid2">
        <div class="field"><label>Base URL（含 /v1）</label><input id="set_relay_base_url" placeholder="https://api.example.com/v1" /></div>
        <div class="field"><label>上游 API Key</label><input id="set_relay_api_key" type="password" /></div>
        <div class="field"><label>允许的模型（逗号分隔，空=全部）</label><input id="set_relay_models" placeholder="gpt-4o-mini,deepseek-chat" /></div>
        <div class="field"><label>模型映射 JSON（原名→上游名）</label><input id="set_relay_model_map" placeholder='{"gpt-4o":"gpt-4o-2024-08-06"}' /></div>
        <div class="field"><label>模型访问需要订阅</label><select id="set_require_subscription_for_relay"><option value="true">是</option><option value="false">否（推荐：免费用户可用 Auto）</option></select></div>
        <div class="field"><label>免费用户仅允许 Auto（强制）</label><select id="set_free_users_auto_only"><option value="true">是（推荐）</option><option value="false">否</option></select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Auto 模型阶梯 JSON（simple / medium / complex）</label><input id="set_auto_model_ladder" placeholder='{"simple":"gpt-4o-mini","medium":"gpt-4o-mini","complex":"gpt-4o"}' /></div>
        <div class="field"><label>模型计费倍率 JSON（模型→系数，default 兜底；优先级高于内置价格表）</label><input id="set_relay_model_rates" placeholder='{"gpt-4o":5,"gpt-4o-mini":1,"default":1}' /></div>
        <div class="field"><label>获取后自动写入允许列表</label><select id="set_auto_sync_models"><option value="true">是</option><option value="false">否</option></select></div>
        <div class="field"><label>计费加价倍率（内置价格表结果再乘此值）</label><input id="set_billing_markup" type="number" min="0.1" step="0.1" /></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ghost" onclick="refreshUpstreamModels()">从上游获取模型</button>
        <span class="muted" id="relayModelsInfo">尚未从上游获取模型</span>
      </div>
      <p class="muted" style="margin:10px 0 0">内置计费已包含 OpenAI（gpt-4o / gpt-4.1 / o 系列）、Claude（Opus / Sonnet / Haiku）与 DeepSeek（chat / reasoner）常用模型；未知模型按 1:1 计费，可用上方倍率覆盖。</p>
    </div>
    <div class="panel">
      <h2>模型价格（CNY / 1M tokens）</h2>
      <p class="muted">单位：人民币元 / 1M tokens。这里填写的同名模型会覆盖内置价格；输入与输出分开计价，留空表示使用内置价格，未知模型按 1:1 计费。</p>
      <table>
        <thead><tr><th>模型</th><th>输入价格</th><th>输出价格</th><th></th></tr></thead>
        <tbody id="pricingRows"></tbody>
      </table>
      <div class="row" style="margin-top:10px">
        <button class="ghost" onclick="addPricingRow()">添加模型</button>
        <button class="primary" onclick="savePricing()">保存价格</button>
      </div>
    </div>
    <div class="panel">
      <h2>管理员密码</h2>
      <div class="grid3">
        <div class="field"><label>原密码</label><input id="pwOld" type="password" /></div>
        <div class="field"><label>新密码（至少 8 位）</label><input id="pwNew" type="password" /></div>
      </div>
      <button class="primary" onclick="changePassword()">修改密码</button>
    </div>
    <div class="row"><button class="primary" onclick="saveSettings()">保存全部设置</button><span class="muted">保存后立即生效，无需重启。</span></div>
  </section>
</main>
<div id="toast"></div>
<script>
var TOKEN_KEY = 'zenith.admin.token';
var state = { plans: [], settings: {} };

function q(id) { return document.getElementById(id); }
function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}
function fmt(value) { return Number(value || 0).toLocaleString(); }
function fmtMoney(cents) { return '¥' + (Number(cents || 0) / 100).toFixed(2); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '-'; }
function toast(message) {
  var el = q('toast'); el.textContent = message; el.classList.add('show');
  setTimeout(function () { el.classList.remove('show'); }, 2200);
}
function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

function api(path, options) {
  options = options || {};
  var headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  if (token()) headers.authorization = 'Bearer ' + token();
  return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
    return response.text().then(function (text) {
      var payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (err) { payload = { error: text }; }
      if (response.status === 401) { showLogin(); throw new Error('登录已失效'); }
      if (!response.ok) throw new Error((payload && payload.error) || ('HTTP ' + response.status));
      return payload;
    });
  });
}

function showLogin() {
  sessionStorage.removeItem(TOKEN_KEY);
  q('login').style.display = 'block';
  q('app').style.display = 'none';
  q('headerActions').style.display = 'none';
}
function showApp() {
  q('login').style.display = 'none';
  q('app').style.display = 'block';
  q('headerActions').style.display = 'flex';
}

function login() {
  api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: q('loginEmail').value, password: q('loginPassword').value }) })
    .then(function (result) {
      sessionStorage.setItem(TOKEN_KEY, result.token);
      q('whoami').textContent = result.user.email;
      showApp();
      loadOverview(); loadUsers(); loadPlans(); loadPlugins(); loadSettings();
    })
    .catch(function (error) { toast(error.message); });
}
function logout() { api('/api/admin/logout', { method: 'POST' }).catch(function () {}); showLogin(); }

function showTab(name) {
  var tabs = document.querySelectorAll('#tabs button');
  for (var i = 0; i < tabs.length; i += 1) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
  var sections = document.querySelectorAll('section.tab');
  for (var j = 0; j < sections.length; j += 1) sections[j].classList.toggle('active', sections[j].id === 'tab-' + name);
  if (name === 'overview') loadOverview();
  if (name === 'users') loadUsers();
  if (name === 'plans') loadPlans();
  if (name === 'orders') loadOrders();
  if (name === 'plugins') loadPlugins();
  if (name === 'settings') loadSettings();
}

function loadOverview() {
  api('/api/admin/overview').then(function (data) {
    var items = [
      ['用户总数', fmt(data.users)], ['活跃用户', fmt(data.activeUsers)], ['设备数', fmt(data.devices)],
      ['有效订阅', fmt(data.activeSubscriptions)], ['已支付订单', fmt(data.paidOrders)],
      ['累计收入', fmtMoney(data.revenueCents)], ['待支付订单', fmt(data.pendingOrders)],
      ['近 7 天用量', fmt(data.tokensUsed7d) + ' tokens'], ['启用插件', fmt(data.plugins)]
    ];
    q('overviewCards').innerHTML = items.map(function (item) {
      return '<div class="card"><div class="label">' + esc(item[0]) + '</div><div class="value">' + esc(item[1]) + '</div></div>';
    }).join('');
  }).catch(function (error) { toast(error.message); });
}

function loadUsers() {
  var query = q('userQuery').value.trim();
  api('/api/admin/users?query=' + encodeURIComponent(query)).then(function (data) {
    q('userCount').textContent = data.users.length + ' 位用户';
    q('userRows').innerHTML = data.users.map(function (item) {
      var user = item.user; var quota = item.quota || {};
      var sub = quota.subscriptionActive ? ('每周 ' + fmt(quota.subscriptionRemaining) + ' / ' + fmt(quota.subscriptionWeeklyQuota)) : '无';
      var actions = '<button class="ghost small" onclick="toggleUser(\\'' + user.id + '\\',\\'' + user.status + '\\')">' + (user.status === 'active' ? '禁用' : '启用') + '</button> ' +
        '<button class="ghost small" onclick="addBonus(\\'' + user.id + '\\')">加额度</button>' +
        '<button class="ghost small" onclick="grantPlan(\\'' + user.id + '\\')">授予套餐</button>';
      return '<tr><td>' + esc(user.email) + '<div class="muted">' + esc(user.id) + '</div></td>' +
        '<td><span class="badge ' + (user.status === 'active' ? 'ok' : 'off') + '">' + esc(user.status) + '</span>' +
        (user.role === 'admin' ? ' <span class="badge">admin</span>' : '') + '</td>' +
        '<td>' + fmt(quota.bonusRemaining) + '</td><td>' + esc(sub) + '</td>' +
        '<td>' + fmtTime(user.createdAt) + '</td><td>' + actions + '</td></tr>';
    }).join('');
  }).catch(function (error) { toast(error.message); });
}

function toggleUser(id, status) {
  api('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: status === 'active' ? 'disabled' : 'active' }) })
    .then(function () { toast('已更新'); loadUsers(); }).catch(function (error) { toast(error.message); });
}
function addBonus(id) {
  var value = prompt('增加多少 tokens？', '500000');
  if (value === null) return;
  api('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ bonusDelta: Number(value) }) })
    .then(function () { toast('已增加额度'); loadUsers(); }).catch(function (error) { toast(error.message); });
}
function grantPlan(id) {
  if (!state.plans.length) { toast('请先创建套餐'); return; }
  var names = state.plans.map(function (plan, index) { return (index + 1) + '. ' + plan.name; }).join('\\n');
  var choice = prompt('输入套餐序号：\\n' + names, '1');
  if (choice === null) return;
  var plan = state.plans[Number(choice) - 1];
  if (!plan) { toast('序号无效'); return; }
  api('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ grantPlanId: plan.id }) })
    .then(function () { toast('已授予套餐'); loadUsers(); }).catch(function (error) { toast(error.message); });
}

function loadPlans() {
  api('/api/admin/plans').then(function (data) {
    state.plans = data.plans;
    q('planRows').innerHTML = data.plans.map(function (plan) {
      return '<tr><td>' + esc(plan.name) + '</td><td>' + fmtMoney(plan.priceCents) + '</td><td>' + plan.durationDays + '</td>' +
        '<td>' + fmt(plan.weeklyQuota) + '</td><td>' + (plan.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge off">停用</span>') + '</td>' +
        '<td><button class="ghost small" onclick="togglePlan(\\'' + plan.id + '\\',' + (plan.enabled ? 'false' : 'true') + ')">' + (plan.enabled ? '停用' : '启用') + '</button> ' +
        '<button class="danger small" onclick="deletePlan(\\'' + plan.id + '\\')">删除</button></td></tr>';
    }).join('');
  }).catch(function (error) { toast(error.message); });
}
function createPlan() {
  var body = {
    name: q('planName').value, priceCents: Math.round(Number(q('planPrice').value) * 100),
    durationDays: Number(q('planDays').value), weeklyQuota: Number(q('planQuota').value),
    sort: Number(q('planSort').value), enabled: q('planEnabled').value === 'true'
  };
  api('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) })
    .then(function () { toast('套餐已创建'); loadPlans(); }).catch(function (error) { toast(error.message); });
}
function togglePlan(id, enabled) {
  api('/api/admin/plans/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: enabled }) })
    .then(function () { loadPlans(); }).catch(function (error) { toast(error.message); });
}
function deletePlan(id) {
  if (!confirm('确认删除该套餐？')) return;
  api('/api/admin/plans/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function () { toast('已删除'); loadPlans(); }).catch(function (error) { toast(error.message); });
}

function loadOrders() {
  api('/api/admin/orders').then(function (data) {
    q('orderRows').innerHTML = data.orders.map(function (order) {
      return '<tr><td>' + esc(order.outTradeNo) + '</td><td>' + esc(order.userId) + '</td><td>' + esc(order.planId) + '</td>' +
        '<td>' + fmtMoney(order.amountCents) + '</td><td><span class="badge ' + (order.status === 'paid' ? 'ok' : '') + '">' + esc(order.status) + '</span></td>' +
        '<td>' + fmtTime(order.createdAt) + '</td><td>' + fmtTime(order.paidAt) + '</td></tr>';
    }).join('');
  }).catch(function (error) { toast(error.message); });
}

function loadPlugins() {
  api('/api/admin/plugins').then(function (data) {
    q('pluginRows').innerHTML = data.plugins.map(function (plugin) {
      var source = plugin.hasPackage ? '上传包' : (plugin.downloadUrl ? '外链' : '无');
      return '<tr><td>' + esc(plugin.pluginName) + '<div class="muted">' + esc(plugin.displayName) + '</div></td>' +
        '<td>' + esc(plugin.version) + '</td><td>' + esc(plugin.category) + '</td><td>' + source + '</td>' +
        '<td>' + (plugin.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge off">停用</span>') + '</td>' +
        '<td><button class="ghost small" onclick="togglePlugin(\\'' + plugin.id + '\\',' + (plugin.enabled ? 'false' : 'true') + ')">' + (plugin.enabled ? '停用' : '启用') + '</button> ' +
        '<button class="danger small" onclick="deletePlugin(\\'' + plugin.id + '\\')">删除</button></td></tr>';
    }).join('');
  }).catch(function (error) { toast(error.message); });
}
function savePlugin() {
  var body = {
    pluginName: q('pluginName').value, version: q('pluginVersion').value, displayName: q('pluginDisplay').value,
    category: q('pluginCategory').value, downloadUrl: q('pluginUrl').value, author: q('pluginAuthor').value,
    description: q('pluginDesc').value, enabled: true
  };
  api('/api/admin/plugins', { method: 'POST', body: JSON.stringify(body) })
    .then(function () { toast('插件已保存'); loadPlugins(); }).catch(function (error) { toast(error.message); });
}
function togglePlugin(id, enabled) {
  api('/api/admin/plugins/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: enabled }) })
    .then(function () { loadPlugins(); }).catch(function (error) { toast(error.message); });
}
function deletePlugin(id) {
  if (!confirm('确认删除该插件条目？')) return;
  api('/api/admin/plugins/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function () { toast('已删除'); loadPlugins(); }).catch(function (error) { toast(error.message); });
}
function importCatalog() {
  api('/api/admin/plugins/import-catalog', { method: 'POST', body: '{}' })
    .then(function (result) { toast('已导入 ' + result.imported + ' 个条目'); loadPlugins(); }).catch(function (error) { toast(error.message); });
}
function uploadPlugin() {
  var file = q('pluginFile').files[0];
  if (!file) { toast('请选择 zip 文件'); return; }
  var reader = new FileReader();
  reader.onload = function () {
    var base64 = String(reader.result).split(',')[1] || '';
    api('/api/admin/plugins/upload', { method: 'POST', body: JSON.stringify({
      pluginName: q('pluginName').value, version: q('pluginVersion').value, dataBase64: base64
    }) }).then(function () { toast('上传完成'); loadPlugins(); }).catch(function (error) { toast(error.message); });
  };
  reader.readAsDataURL(file);
}

var SETTING_KEYS = ['registration_enabled','signup_bonus_quota','public_base_url','smtp_enabled','smtp_host','smtp_port','smtp_secure','smtp_username','smtp_password','smtp_from_address','smtp_from_name','turnstile_enabled','turnstile_site_key','turnstile_secret_key','epay_enabled','epay_gateway','epay_pid','epay_key','epay_type','relay_base_url','relay_api_key','relay_models','relay_model_map','require_subscription_for_relay','free_users_auto_only','auto_model_ladder','relay_model_rates','auto_sync_models','billing_markup'];
function loadSettings() {
  api('/api/admin/settings').then(function (data) {
    state.settings = data.settings;
    SETTING_KEYS.forEach(function (key) {
      var el = q('set_' + key);
      if (el && data.settings[key] !== undefined) el.value = data.settings[key];
    });
    api('/api/admin/relay/models').then(function (result) {
      var el = q('relayModelsInfo');
      if (!el) return;
      el.textContent = result.models.length
        ? '已缓存 ' + result.models.length + ' 个模型，更新于 ' + fmtTime(result.fetchedAt)
        : '尚未从上游获取模型';
    }).catch(function () {});
    renderPricingRows(parsePricing(data.settings.model_pricing));
  }).catch(function (error) { toast(error.message); });
}
function refreshUpstreamModels() {
  api('/api/admin/relay/models/refresh', { method: 'POST', body: '{}' })
    .then(function (result) { toast('已从上游获取 ' + result.models.length + ' 个模型'); loadSettings(); })
    .catch(function (error) { toast(error.message); });
}
function saveSettings() {
  var values = {};
  SETTING_KEYS.forEach(function (key) {
    var el = q('set_' + key);
    if (el) values[key] = el.value;
  });
  api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(values) })
    .then(function () { toast('设置已保存'); }).catch(function (error) { toast(error.message); });
}
function parsePricing(value) {
  try {
    var parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}
function pricingRowHtml(model, input, output) {
  return '<tr><td><input class="pricing-model" value="' + esc(model) + '"></td>' +
    '<td><input class="pricing-input" type="number" min="0" step="0.0001" value="' + esc(input) + '"></td>' +
    '<td><input class="pricing-output" type="number" min="0" step="0.0001" value="' + esc(output) + '"></td>' +
    '<td><button class="danger small" onclick="removePricingRow(this)">删除</button></td></tr>';
}
function renderPricingRows(pricing) {
  var models = Object.keys(pricing);
  var rows = models.map(function (model) {
    var item = pricing[model] || {};
    var input = item.input !== undefined ? item.input : (item.inputPerMillion !== undefined ? item.inputPerMillion : '');
    var output = item.output !== undefined ? item.output : (item.outputPerMillion !== undefined ? item.outputPerMillion : '');
    return pricingRowHtml(model, input, output);
  });
  q('pricingRows').innerHTML = rows.join('');
}
function addPricingRow() {
  q('pricingRows').insertAdjacentHTML('beforeend', pricingRowHtml('', '', ''));
}
function removePricingRow(button) {
  var row = button.closest('tr');
  if (row) row.remove();
}
function readPricingRows() {
  var rows = q('pricingRows').querySelectorAll('tr');
  var result = {};
  for (var i = 0; i < rows.length; i += 1) {
    var model = rows[i].querySelector('.pricing-model').value.trim();
    var inputRaw = rows[i].querySelector('.pricing-input').value.trim();
    var outputRaw = rows[i].querySelector('.pricing-output').value.trim();
    // 价格留空的条目不写入，避免误把模型设为免费。
    if (!model || inputRaw === '' || outputRaw === '') continue;
    var input = Number(inputRaw);
    var output = Number(outputRaw);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    result[model] = { input: input, output: output };
  }
  return result;
}
function savePricing() {
  var pricing = readPricingRows();
  api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ model_pricing: JSON.stringify(pricing) }) })
    .then(function () { toast('模型价格已保存'); })
    .catch(function (error) { toast(error.message); });
}
function changePassword() {
  api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: q('pwOld').value, newPassword: q('pwNew').value }) })
    .then(function () { toast('密码已修改'); q('pwOld').value = ''; q('pwNew').value = ''; })
    .catch(function (error) { toast(error.message); });
}

(function boot() {
  if (token()) {
    showApp();
    loadOverview(); loadUsers(); loadPlans(); loadPlugins(); loadSettings();
  } else {
    showLogin();
  }
})();
</script>
</body>
</html>`;
