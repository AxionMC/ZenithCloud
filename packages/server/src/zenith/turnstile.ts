export interface TurnstileVerifyResult {
  ok: boolean;
  errorCodes: string[];
}

/**
 * Cloudflare Turnstile 服务端校验。token 一次性、有效期约 5 分钟。
 * 网络异常按失败处理，避免人机验证被网络问题绕过。
 */
export async function verifyTurnstile(
  secretKey: string,
  token: string,
  remoteIp?: string,
): Promise<TurnstileVerifyResult> {
  const trimmedSecret = secretKey.trim();
  const trimmedToken = token.trim();
  if (!trimmedSecret) {
    return { ok: false, errorCodes: ["missing-secret"] };
  }
  if (!trimmedToken) {
    return { ok: false, errorCodes: ["missing-token"] };
  }

  const form = new URLSearchParams();
  form.set("secret", trimmedSecret);
  form.set("response", trimmedToken);
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    return {
      ok: payload.success === true,
      errorCodes: Array.isArray(payload["error-codes"]) ? payload["error-codes"] : [],
    };
  } catch {
    return { ok: false, errorCodes: ["verification-request-failed"] };
  }
}
