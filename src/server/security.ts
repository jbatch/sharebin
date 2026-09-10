import "@fastify/cookie";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db, UserRow } from "./db.js";
import { nowIso } from "./db.js";

export const sessionCookieName = "sharebin_session";

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function publicId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName, { path: "/" });
}

export function createSession(db: Db, userId: string): string {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  db.prepare(
    "INSERT INTO web_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(publicId(), userId, sha256(token), expires.toISOString(), now.toISOString());
  return token;
}

export function getUserFromRequest(db: Db, request: FastifyRequest): UserRow | null {
  const token = request.cookies[sessionCookieName];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT users.* FROM web_sessions
       JOIN users ON users.id = web_sessions.user_id
       WHERE web_sessions.token_hash = ? AND web_sessions.expires_at > ? AND users.disabled_at IS NULL`
    )
    .get(sha256(token), nowIso()) as UserRow | undefined;
  return row ?? null;
}

export function deleteSession(db: Db, request: FastifyRequest): void {
  const token = request.cookies[sessionCookieName];
  if (!token) return;
  db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha256(token));
}

export function requireOrigin(request: FastifyRequest, appBaseUrl: string): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (origin === "null" && request.url.split("?")[0] === "/share") return true;
  const host = request.headers.host;
  const allowed = new URL(appBaseUrl).origin;
  if (origin === allowed || Boolean(host && origin === `http://${host}`) || Boolean(host && origin === `https://${host}`)) {
    return true;
  }
  if (process.env.NODE_ENV !== "production") {
    return isDevelopmentHost(origin);
  }
  return false;
}

function isDevelopmentHost(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "::1") return true;
    if (hostname.startsWith("127.")) return true;
    const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!ipv4) return false;
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    return first === 10 || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31);
  } catch {
    return false;
  }
}
