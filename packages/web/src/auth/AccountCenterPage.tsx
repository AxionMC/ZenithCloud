import { useCallback, useEffect, useState } from "react";
import { Button } from "@zcode/ui";
import {
  clearSession,
  createSubscriptionOrder,
  fetchAuthConfig,
  fetchAvailableModels,
  fetchMe,
  formatQuota,
  listPlans,
  loadSession,
  logoutAccount,
  type LocalAuthConfig,
  type LocalAuthUser,
  type LocalPlan,
  type LocalQuotaSnapshot,
} from "./localAuthService.js";

interface AccountCenterPageProps {
  onLoggedOut: () => void;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString();
}

export function AccountCenterPage({ onLoggedOut }: AccountCenterPageProps) {
  const session = loadSession();
  const [user, setUser] = useState<LocalAuthUser | null>(session?.user ?? null);
  const [quota, setQuota] = useState<LocalQuotaSnapshot | null>(session?.quota ?? null);
  const [plans, setPlans] = useState<LocalPlan[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [config, setConfig] = useState<LocalAuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!session?.token) return;
    setError("");
    try {
      const [me, planList, authConfig, modelList] = await Promise.all([
        fetchMe(session.token),
        listPlans(),
        fetchAuthConfig(),
        fetchAvailableModels(session.token),
      ]);
      setUser(me.user);
      setQuota(me.quota);
      setPlans(planList);
      setConfig(authConfig);
      setModels(modelList.models);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("登录已失效")) {
        clearSession();
        onLoggedOut();
        return;
      }
      setError(message);
    }
  }, [onLoggedOut, session?.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleBuy = async (planId: string) => {
    if (!session?.token) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const order = await createSubscriptionOrder(session.token, planId);
      window.location.assign(order.payUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyEndpoint = async () => {
    const endpoint = `${window.location.origin}/v1`;
    try {
      await navigator.clipboard.writeText(endpoint);
      setNotice("接入地址已复制");
    } catch {
      setNotice(endpoint);
    }
  };

  const handleLogout = async () => {
    if (session?.token) await logoutAccount(session.token);
    clearSession();
    onLoggedOut();
  };

  const subscriptionRequired = Boolean(config?.requireSubscription) && !quota?.subscriptionActive;
  const autoOnly = Boolean(config?.freeUsersAutoOnly) && !quota?.subscriptionActive;

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground">
      <section className="mx-auto w-full max-w-2xl space-y-4">
        <div className="rounded-lg border border-card-border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-ui-xs font-medium text-foreground-subtle">ZenithCloud</div>
              <h1 className="truncate text-ui-lg font-medium text-foreground">
                {user?.displayName || user?.email || "账户中心"}
              </h1>
              <p className="truncate text-ui-xs text-foreground-subtle">{user?.email}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleLogout()}>
              退出登录
            </Button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-card-border bg-background p-3">
              <div className="text-ui-xs text-foreground-subtle">新人赠送余额</div>
              <div className="mt-1 text-ui-lg font-medium">
                {formatQuota(quota?.bonusRemaining)} / {formatQuota(quota?.bonusQuota)}
              </div>
              <div className="mt-1 text-ui-xs text-foreground-subtle">tokens</div>
            </div>
            <div className="rounded-md border border-card-border bg-background p-3">
              <div className="text-ui-xs text-foreground-subtle">订阅每周额度</div>
              <div className="mt-1 text-ui-lg font-medium">
                {quota?.subscriptionActive
                  ? `${formatQuota(quota.subscriptionRemaining)} / ${formatQuota(quota.subscriptionWeeklyQuota)}`
                  : "未订阅"}
              </div>
              <div className="mt-1 text-ui-xs text-foreground-subtle">
                {quota?.subscriptionActive
                  ? `到期时间 ${formatDate(quota.subscriptionExpiresAt)}，每周自动重置`
                  : "购买订阅后才能使用客户端模型"}
              </div>
            </div>
          </div>

          {subscriptionRequired ? (
            <p className="mt-3 rounded-md border border-card-border bg-background p-3 text-ui-xs text-foreground-subtle">
              模型访问需要有效订阅。请选择下方套餐完成购买后再使用客户端。
            </p>
          ) : null}
          {autoOnly ? (
            <p className="mt-3 rounded-md border border-card-border bg-background p-3 text-ui-xs text-foreground-subtle">
              免费账号只能使用 Auto 模式（服务端按任务难度自动选择模型），无法关闭；购买订阅后可自行选择模型。
            </p>
          ) : null}
          {error ? <p className="mt-3 text-ui-xs text-red-500">{error}</p> : null}
          {notice ? <p className="mt-3 text-ui-xs text-foreground-subtle">{notice}</p> : null}
        </div>

        <div className="rounded-lg border border-card-border bg-card p-5 shadow-sm">
          <h2 className="text-ui-sm font-medium">订阅套餐</h2>
          <div className="mt-3 space-y-2">
            {plans.length === 0 ? (
              <p className="text-ui-xs text-foreground-subtle">管理员尚未创建套餐。</p>
            ) : (
              plans.map((plan) => (
                <div
                  key={plan.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-card-border bg-background p-3"
                >
                  <div className="min-w-0">
                    <div className="text-ui-sm font-medium">{plan.name}</div>
                    <div className="text-ui-xs text-foreground-subtle">
                      每 {plan.durationDays} 天，每周 {formatQuota(plan.weeklyQuota)} tokens
                      {plan.description ? ` · ${plan.description}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-ui-sm font-medium">
                      ¥{(plan.priceCents / 100).toFixed(2)}
                      <span className="ml-1 text-ui-xs text-foreground-subtle">CNY</span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleBuy(plan.id)}
                    >
                      购买
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border border-card-border bg-card p-5 shadow-sm">
          <h2 className="text-ui-sm font-medium">可用模型</h2>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            列表由服务端从上游同步。{autoOnly ? "免费账号只可使用 Auto。" : "订阅账号可自行选择。"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {models.length === 0 ? (
              <span className="text-ui-xs text-foreground-subtle">管理员尚未同步模型列表。</span>
            ) : (
              models.map((model) => (
                <span
                  key={model}
                  className="rounded-full border border-card-border bg-background px-2.5 py-1 font-mono text-ui-xs"
                >
                  {model}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border border-card-border bg-card p-5 shadow-sm">
          <h2 className="text-ui-sm font-medium">客户端接入</h2>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            在客户端使用本邮箱账号登录即可调用模型，不发放 API Key。
            {autoOnly ? `当前账号固定使用 ${config?.autoModelId ?? "auto"} 模式。` : ""}
            服务端接入地址：
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-card-border bg-background px-3 py-2 font-mono text-ui-xs">
              {window.location.origin}/v1
            </code>
            <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopyEndpoint()}>
              复制
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
