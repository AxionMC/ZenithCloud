import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import type { SmtpConfig } from "./settings.js";

/**
 * 极简 SMTP 客户端：只依赖 node 内置模块，支持 465 隐式 TLS、587 STARTTLS、
 * AUTH LOGIN / PLAIN，以及纯文本/HTML 验证码邮件。避免为发信引入原生依赖。
 */

interface SmtpIo {
  lines: string[];
  pending: Array<(line: string) => void>;
  buffer: string;
  socket: Socket | TLSSocket;
  detach: () => void;
}

function createIo(socket: Socket | TLSSocket): SmtpIo {
  const io: SmtpIo = {
    lines: [],
    pending: [],
    buffer: "",
    socket,
    detach: () => socket.removeListener("data", onData),
  };
  function onData(chunk: Buffer): void {
    io.buffer += chunk.toString("utf8");
    let index = io.buffer.indexOf("\r\n");
    while (index >= 0) {
      const line = io.buffer.slice(0, index);
      io.buffer = io.buffer.slice(index + 2);
      const waiter = io.pending.shift();
      if (waiter) waiter(line);
      else io.lines.push(line);
      index = io.buffer.indexOf("\r\n");
    }
  }
  socket.on("data", onData);
  return io;
}

function readLine(io: SmtpIo, timeoutMs: number): Promise<string> {
  const queued = io.lines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = io.pending.indexOf(onLine);
      if (index >= 0) io.pending.splice(index, 1);
      reject(new Error("SMTP 响应超时"));
    }, timeoutMs);
    function onLine(line: string): void {
      clearTimeout(timer);
      resolve(line);
    }
    io.pending.push(onLine);
  });
}

async function readResponse(io: SmtpIo, timeoutMs = 20_000): Promise<{ code: number; lines: string[] }> {
  const first = await readLine(io, timeoutMs);
  const code = Number.parseInt(first.slice(0, 3), 10);
  const lines = [first];
  let current = first;
  while (current.length > 3 && current[3] === "-") {
    current = await readLine(io, timeoutMs);
    lines.push(current);
  }
  return { code, lines };
}

function expect(response: { code: number; lines: string[] }, ...codes: number[]): void {
  if (!codes.includes(response.code)) {
    throw new Error(`SMTP 请求失败：${response.lines.join(" ")}`);
  }
}

async function command(
  io: SmtpIo,
  line: string,
  ...codes: number[]
): Promise<{ code: number; lines: string[] }> {
  io.socket.write(`${line}\r\n`);
  const response = await readResponse(io);
  expect(response, ...codes);
  return response;
}

function waitForConnect(socket: Socket | TLSSocket, event: "connect" | "secureConnect"): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMTP 连接超时")), 20_000);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${base64(value)}?=`;
}

function wrapBase64(value: string): string {
  return value.replace(/(.{76})/g, "$1\r\n");
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function buildMessage(config: SmtpConfig, message: SmtpMessage): string {
  const fromName = config.fromName?.trim() || "ZenithCloud";
  const from = `"${encodeHeader(fromName)}" <${config.fromAddress}>`;
  const domain = config.fromAddress.split("@")[1] || "localhost";
  const headers = [
    `From: ${from}`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
  ];

  if (message.html) {
    const boundary = `zc_${randomUUID().replaceAll("-", "")}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(base64(message.text)),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(base64(message.html)),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }

  return [
    ...headers,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64(message.text)),
    "",
  ].join("\r\n");
}

export async function sendSmtpMail(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  if (!config.enabled || !config.host || !config.fromAddress) {
    throw new Error("SMTP 未配置");
  }
  if (!message.to.includes("@")) {
    throw new Error("收件邮箱无效");
  }

  let socket: Socket | TLSSocket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });

  socket.setTimeout(20_000, () => socket.destroy(new Error("SMTP 连接超时")));
  await waitForConnect(socket, config.secure ? "secureConnect" : "connect");
  // 连接建立后 waitForConnect 的 error 监听已移除；保留一个空监听，
  // 避免超时销毁 socket 时 'error' 事件无人处理导致进程崩溃。
  socket.on("error", () => undefined);

  let io = createIo(socket);
  try {
    expect(await readResponse(io), 220);
    let ehlo = await command(io, `EHLO ${hostname() || "localhost"}`, 250);
    const supportsStartTls = ehlo.lines.some((line) => line.toUpperCase().includes("STARTTLS"));

    if (!config.secure && supportsStartTls) {
      await command(io, "STARTTLS", 220);
      io.detach();
      socket = tlsConnect({ socket: socket as Socket, servername: config.host });
      await waitForConnect(socket, "secureConnect");
      socket.on("error", () => undefined);
      io = createIo(socket);
      ehlo = await command(io, `EHLO ${hostname() || "localhost"}`, 250);
    }

    if (config.username) {
      const authLine = ehlo.lines.join(" ").toUpperCase();
      if (authLine.includes("AUTH") && authLine.includes("PLAIN")) {
        await command(io, `AUTH PLAIN ${base64(`\u0000${config.username}\u0000${config.password}`)}`, 235);
      } else {
        await command(io, "AUTH LOGIN", 334);
        await command(io, base64(config.username), 334);
        await command(io, base64(config.password), 235);
      }
    }

    await command(io, `MAIL FROM:<${config.fromAddress}>`, 250);
    await command(io, `RCPT TO:<${message.to}>`, 250, 251);
    await command(io, "DATA", 354);
    const payload = buildMessage(config, message);
    socket.write(`${payload}\r\n.\r\n`);
    expect(await readResponse(io), 250);
    io.socket.write("QUIT\r\n");
    await readResponse(io).catch(() => undefined);
  } finally {
    io.detach();
    socket.end();
  }
}

export function buildVerificationMail(
  code: string,
  purpose: "register" | "reset",
): { subject: string; text: string; html: string } {
  const action = purpose === "register" ? "注册" : "重置密码";
  const subject = `ZenithCloud ${action}验证码：${code}`;
  const text = [
    `你正在${action} ZenithCloud 账号，验证码为：${code}`,
    "",
    "验证码 10 分钟内有效，请勿转发给他人。",
    "如果这不是你的操作，请忽略本邮件。",
  ].join("\n");
  const html = [
    "<div style=\"font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px\">",
    "<h2 style=\"margin:0 0 16px\">ZenithCloud</h2>",
    `<p>你正在${action} ZenithCloud 账号，验证码为：</p>`,
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>`,
    "<p style=\"color:#666\">验证码 10 分钟内有效，请勿转发给他人。</p>",
    "<p style=\"color:#666\">如果这不是你的操作，请忽略本邮件。</p>",
    "</div>",
  ].join("");
  return { subject, text, html };
}
