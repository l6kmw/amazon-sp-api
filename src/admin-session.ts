import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";
import type { Pool } from "pg";

import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import { verifyAdminPassword } from "./admin-auth.js";

const COOKIE_NAME = "__Host-amazon_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 5 * 60_000;
const DUMMY_PASSWORD_HASH = `scrypt$v1$16384$8$1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`;

export interface AdminSessionClaims {
  userId: "tenant-1";
  username: string;
  role: "admin";
  csrfToken: string;
  expiresAt: number;
}

interface LoginFailure {
  count: number;
  lockedUntil: number;
}

function cookie(request: Request, name: string): string {
  const header = request.header("cookie") ?? "";
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function strictBody(request: Request): { username: string; password: string } | null {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return null;
  }
  if (Object.keys(request.body).some((key) => !["username", "password"].includes(key))) {
    return null;
  }
  const { username, password } = request.body as Record<string, unknown>;
  if (
    typeof username !== "string"
    || typeof password !== "string"
    || username.trim().length < 1
    || username.length > 128
    || password.length < 1
    || password.length > 1024
  ) return null;
  return { username: username.trim(), password };
}

export class AdminSessionManager {
  readonly #pool: Pool;
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly #failures = new Map<string, LoginFailure>();

  constructor(options: { pool: Pool; secret: string; now?: () => number }) {
    this.#pool = options.pool;
    this.#secret = /^[a-fA-F0-9]{64}$/.test(options.secret)
      ? Buffer.from(options.secret, "hex")
      : Buffer.from(options.secret, "base64");
    if (this.#secret.length !== 32) throw new Error("admin session secret must be 32 bytes");
    this.#now = options.now ?? Date.now;
  }

  async authenticate(username: string, password: string): Promise<AdminSessionClaims | null> {
    const result = await this.#pool.query<{
      username: string;
      password_hash: string;
      role: string;
      status: string;
    }>(`
      SELECT username, password_hash, role, status
      FROM amazon_sp_api.app_user
      WHERE id = 'tenant-1'
    `);
    const user = result.rows[0];
    const validPassword = await verifyAdminPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (
      !user
      || user.username !== username
      || user.role !== "admin"
      || user.status !== "active"
      || !validPassword
    ) return null;
    return {
      userId: "tenant-1",
      username: user.username,
      role: "admin",
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: this.#now() + SESSION_TTL_MS,
    };
  }

  issue(claims: AdminSessionClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", this.#secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  verify(token: string): AdminSessionClaims | null {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || payload.length > 4096) return null;
    const expected = createHmac("sha256", this.#secret).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AdminSessionClaims>;
      if (
        claims.userId !== "tenant-1"
        || claims.role !== "admin"
        || typeof claims.username !== "string"
        || typeof claims.csrfToken !== "string"
        || claims.csrfToken.length < 32
        || typeof claims.expiresAt !== "number"
        || claims.expiresAt <= this.#now()
      ) return null;
      return claims as AdminSessionClaims;
    } catch {
      return null;
    }
  }

  async session(request: Request): Promise<AdminSessionClaims | null> {
    const claims = this.verify(cookie(request, COOKIE_NAME));
    if (!claims) return null;
    const result = await this.#pool.query<{ username: string }>(`
      SELECT username FROM amazon_sp_api.app_user
      WHERE id = $1 AND username = $2 AND role = 'admin' AND status = 'active'
    `, [claims.userId, claims.username]);
    return result.rows[0] ? claims : null;
  }

  isLocked(key: string): boolean {
    const failure = this.#failures.get(key);
    if (!failure) return false;
    if (failure.lockedUntil > this.#now()) return true;
    if (failure.lockedUntil > 0) this.#failures.delete(key);
    return false;
  }

  recordFailure(key: string): void {
    const failure = this.#failures.get(key) ?? { count: 0, lockedUntil: 0 };
    failure.count += 1;
    if (failure.count >= MAX_LOGIN_FAILURES) {
      failure.lockedUntil = this.#now() + LOGIN_LOCKOUT_MS;
    }
    this.#failures.set(key, failure);
  }

  clearFailures(key: string): void {
    this.#failures.delete(key);
  }

  validCsrf(request: Request, claims: AdminSessionClaims): boolean {
    const actual = Buffer.from(request.header("x-csrf-token") ?? "");
    const expected = Buffer.from(claims.csrfToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function sessionResponse(claims: AdminSessionClaims | null) {
  return claims ? {
    auth_enabled: true,
    login_enabled: true,
    authenticated: true,
    username: claims.username,
    role: claims.role,
    csrf_token: claims.csrfToken,
  } : {
    auth_enabled: true,
    login_enabled: true,
    authenticated: false,
  };
}

function setSessionCookie(response: Response, token: string, expiresAt: number): void {
  response.cookie(COOKIE_NAME, token, {
    path: "/",
    expires: new Date(expiresAt),
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
}

export function registerAdminSessionRoutes(
  app: Express,
  sessions: AdminSessionManager,
  audits: AdminAuditService,
): void {
  const event = (request: Request, response: Response, action: string, actorId: string): AuditEvent => ({
    actorType: "browser_session",
    actorId,
    action,
    resourceType: "admin_session",
    resourceId: "tenant-1",
    requestId: auditRequest(request, response),
  });

  app.get("/api/v1/admin/session", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    try {
      response.json(sessionResponse(await sessions.session(request)));
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  app.post("/api/v1/admin/session", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = strictBody(request);
    const audit = event(request, response, "admin.login", body?.username ?? "anonymous");
    if (!body) {
      await audits.record(audit, "denied", "invalid_request").catch(() => undefined);
      response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
      return;
    }
    const clientKey = `${request.ip}:${body.username.toLowerCase()}`;
    if (sessions.isLocked(clientKey)) {
      await audits.record(audit, "denied", "login_locked").catch(() => undefined);
      response.setHeader("retry-after", "300");
      response.status(429).json({ error: { code: "login_locked", message: "Login temporarily locked" } });
      return;
    }
    try {
      const claims = await sessions.authenticate(body.username, body.password);
      if (!claims) {
        sessions.recordFailure(clientKey);
        await audits.record(audit, "denied", "invalid_credentials");
        response.status(401).json({ error: { code: "invalid_credentials", message: "Invalid credentials" } });
        return;
      }
      sessions.clearFailures(clientKey);
      await audits.record(audit, "success");
      setSessionCookie(response, sessions.issue(claims), claims.expiresAt);
      response.json(sessionResponse(claims));
    } catch {
      await audits.record(audit, "failed", "internal_error").catch(() => undefined);
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  app.delete("/api/v1/admin/session", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "admin.logout", "anonymous");
    try {
      const claims = await sessions.session(request);
      if (!claims) {
        await audits.record(audit, "denied", "unauthorized");
        response.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
        return;
      }
      audit.actorId = claims.username;
      if (!sessions.validCsrf(request, claims)) {
        await audits.record(audit, "denied", "csrf_invalid");
        response.status(403).json({ error: { code: "csrf_invalid", message: "Invalid CSRF token" } });
        return;
      }
      await audits.record(audit, "success");
      clearSessionCookie(response);
      response.json(sessionResponse(null));
    } catch {
      await audits.record(audit, "failed", "internal_error").catch(() => undefined);
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}
