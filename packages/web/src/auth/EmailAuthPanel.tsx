import { useEffect, useState } from "react";
import { Button } from "@zcode/ui";
import {
  fetchAuthConfig,
  loginAccount,
  registerAccount,
  sendEmailCode,
  type LocalAuthConfig,
  type LocalAuthSession,
} from "./localAuthService.js";
import { TurnstileWidget } from "./TurnstileWidget.js";

interface EmailAuthPanelProps {
  onAuthenticated: (session: LocalAuthSession) => void;
}

type Mode = "login" | "register";

const COPY = {
  zh: {
    loginTab: "登录",
    registerTab: "注册",
    email: "邮箱",
    password: "密码",
    code: "邮箱验证码",
    sendCode: "获取验证码",
    sending: "发送中…",
    codeSent: "验证码已发送，请查收邮件（10 分钟内有效）",
    submitLogin: "登录",
    submitRegister: "注册并登录",
    submitting: "提交中…",
    passwordHint: "密码至少 8 位",
    turnstileHint: "请先完成人机验证",
    smtpMissing: "服务端尚未配置 SMTP，暂时无法注册",
    registerClosed: "服务端已关闭注册",
    bonusClaimed: "该设备已领取过新人赠送额度",
    bonusGranted: "注册成功，已发放新人赠送额度",
  },
  en: {
    loginTab: "Sign in",
    registerTab: "Register",
    email: "Email",
    password: "Password",
    code: "Email code",
    sendCode: "Send code",
    sending: "Sending…",
    codeSent: "Code sent. It is valid for 10 minutes.",
    submitLogin: "Sign in",
    submitRegister: "Register and sign in",
    submitting: "Submitting…",
    passwordHint: "At least 8 characters",
    turnstileHint: "Complete the human verification first",
    smtpMissing: "SMTP is not configured on the server; registration is unavailable.",
    registerClosed: "Registration is closed by the server.",
    bonusClaimed: "This device already claimed the signup bonus.",
    bonusGranted: "Registered. Signup bonus granted.",
  },
};

function isZh(): boolean {
  return (navigator.language || document.documentElement.lang || "").toLowerCase().startsWith("zh");
}

export function EmailAuthPanel({ onAuthenticated }: EmailAuthPanelProps) {
  const copy = isZh() ? COPY.zh : COPY.en;
  const [config, setConfig] = useState<LocalAuthConfig | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetchAuthConfig()
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const needsTurnstile = Boolean(config?.turnstileEnabled);

  const handleSendCode = async () => {
    setError("");
    setMessage("");
    if (!email.trim()) {
      setError("请先填写邮箱");
      return;
    }
    if (needsTurnstile && !turnstileToken) {
      setError(copy.turnstileHint);
      return;
    }
    setSending(true);
    try {
      await sendEmailCode(email.trim(), "register", turnstileToken);
      setMessage(copy.codeSent);
      setTurnstileReset((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async () => {
    setError("");
    setMessage("");
    if (!email.trim() || !password) {
      setError("请填写邮箱和密码");
      return;
    }
    if (mode === "register" && !code.trim()) {
      setError("请填写邮箱验证码");
      return;
    }
    if (needsTurnstile && !turnstileToken) {
      setError(copy.turnstileHint);
      return;
    }
    setBusy(true);
    try {
      const session =
        mode === "login"
          ? await loginAccount({ email: email.trim(), password, turnstileToken })
          : await registerAccount({ email: email.trim(), password, code: code.trim(), turnstileToken });
      if (mode === "register" && (session.bonus ?? 0) > 0) {
        setMessage(copy.bonusGranted);
      } else if (mode === "register") {
        setMessage(copy.bonusClaimed);
      }
      onAuthenticated(session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (needsTurnstile) setTurnstileReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-md border border-card-border bg-background p-1">
        {(["login", "register"] as const).map((item) => {
          const disabled = item === "register" && config && !config.registrationEnabled;
          return (
            <button
              key={item}
              type="button"
              disabled={Boolean(disabled)}
              className={
                "flex-1 rounded px-3 py-1.5 text-ui-xs font-medium transition-colors " +
                (mode === item
                  ? "bg-secondary text-foreground"
                  : "text-foreground-subtle hover:text-foreground disabled:opacity-40")
              }
              onClick={() => {
                setMode(item);
                setError("");
                setMessage("");
              }}
            >
              {item === "login" ? copy.loginTab : copy.registerTab}
            </button>
          );
        })}
      </div>

      {mode === "register" && config && !config.registrationEnabled ? (
        <p className="text-ui-xs text-foreground-subtle">{copy.registerClosed}</p>
      ) : null}
      {mode === "register" && config && !config.smtpConfigured ? (
        <p className="text-ui-xs text-foreground-subtle">{copy.smtpMissing}</p>
      ) : null}

      <div className="space-y-2">
        <input
          className="w-full rounded-md border border-card-border bg-background px-3 py-2 text-ui-sm text-foreground outline-none focus:border-primary"
          type="email"
          autoComplete="email"
          placeholder={copy.email}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          className="w-full rounded-md border border-card-border bg-background px-3 py-2 text-ui-sm text-foreground outline-none focus:border-primary"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          placeholder={copy.password + (mode === "register" ? `（${copy.passwordHint}）` : "")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {mode === "register" ? (
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-card-border bg-background px-3 py-2 text-ui-sm text-foreground outline-none focus:border-primary"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={copy.code}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={sending || busy}
              onClick={() => {
                void handleSendCode();
              }}
            >
              {sending ? copy.sending : copy.sendCode}
            </Button>
          </div>
        ) : null}
      </div>

      {needsTurnstile && config?.turnstileSiteKey ? (
        <TurnstileWidget
          siteKey={config.turnstileSiteKey}
          resetKey={turnstileReset}
          onToken={setTurnstileToken}
        />
      ) : null}

      {error ? <p className="text-ui-xs text-red-500">{error}</p> : null}
      {message ? <p className="text-ui-xs text-foreground-subtle">{message}</p> : null}

      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => {
          void handleSubmit();
        }}
      >
        {busy ? copy.submitting : mode === "login" ? copy.submitLogin : copy.submitRegister}
      </Button>
    </div>
  );
}
