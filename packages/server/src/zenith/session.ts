import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ZenithUserRow } from "./types.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSession(db: DatabaseSync, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(sha256Hex(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function findSessionUser(
  db: DatabaseSync,
  token: string | null | undefined,
): ZenithUserRow | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  const now = Date.now();
  const row = db
    .prepare(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id " +
        "WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .get(sha256Hex(trimmed), now) as unknown as ZenithUserRow | undefined;
  if (!row) return null;
  if (row.status !== "active") return null;
  return row;
}

export function deleteSession(db: DatabaseSync, token: string | null | undefined): void {
  const trimmed = token?.trim();
  if (!trimmed) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(trimmed));
}

export function purgeExpiredSessions(db: DatabaseSync): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

