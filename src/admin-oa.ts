import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { Express, Request, Response } from "express";
import * as oidc from "openid-client";

import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import { AdminSessionManager, setAdminSessionCookie } from "./admin-session.js";

const FLOW_COOKIE = "__Host-amazon_admin_oa_flow";
const FLOW_TTL_MS = 10 * 60_000;
const MAX_CONSUMED_STATES = 1_000;

interface OaFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

export interface AdminOaIdentity {
  issuer: string;
  subject: string;
}

export interface AdminOaClient {
  authorizationUrl(input: {
    redirectUri: string;
    scope: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  exchangeCallback(input: {
    currentUrl: URL;
    codeVerifier: string;
    expectedState: string;
    expectedNonce: string;
  }): Promise<AdminOaIdentity>;
}

export interface AdminOaOptions {
  publicOrigin: string;
  sessionSecret: string;
  scope: string;
  client: AdminOaClient;
  now?: () => number;
}

export class OpenIdAdminOaClient implements AdminOaClient {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  #configuration?: Promise<oidc.Configuration>;

  constructor(options: { issuer: string; clientId: string; clientSecret: string }) {
    this.#issuer = options.issuer;
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
  }

  async authorizationUrl(input: {
    redirectUri: string;
    scope: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const configuration = await this.#config();
    return oidc.buildAuthorizationUrl(configuration, {
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: input.scope,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
  }

  async exchangeCallback(input: {
    currentUrl: URL;
    codeVerifier: string;
    expectedState: string;
    expectedNonce: string;
  }): Promise<AdminOaIdentity> {
    const tokens = await oidc.authorizationCodeGrant(
      await this.#config(),
      input.currentUrl,
      {
        pkceCodeVerifier: input.codeVerifier,
        expectedState: input.expectedState,
        expectedNonce: input.expectedNonce,
      },
    );
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new Error("OA ID token subject is missing");
    }
    return { issuer: this.#issuer, subject: claims.sub };
  }

  #config(): Promise<oidc.Configuration> {
    if (!this.#configuration) {
      this.#configuration = oidc.discovery(
        new URL(this.#issuer),
        this.#clientId,
        this.#clientSecret,
      ).catch((error) => {
        this.#configuration = undefined;
        throw error;
      });
    }
    return this.#configuration;
  }
}

class AdminOaFlowCookie {
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #consumed = new Map<string, number>();

  constructor(secret: string, now: () => number) {
    this.#key = /^[a-fA-F0-9]{64}$/.test(secret)
      ? Buffer.from(secret, "hex")
      : Buffer.from(secret, "base64");
    if (this.#key.length !== 32) throw new Error("OA flow key must be 32 bytes");
    this.#now = now;
  }

  issue(flow: OaFlow): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(FLOW_COOKIE));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(flow), "utf8"),
      cipher.final(),
    ]);
    return ["v1", iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }

  consume(token: string, expectedState: string): OaFlow | null {
    const digest = createHash("sha256").update(token).digest("base64url");
    this.#prune();
    if (this.#consumed.has(digest) || this.#consumed.size >= MAX_CONSUMED_STATES) return null;
    const flow = this.#open(token);
    if (!flow || !constantTimeEqual(flow.state, expectedState)) return null;
    this.#consumed.set(digest, flow.expiresAt);
    return flow;
  }

  #open(token: string): OaFlow | null {
    const [version, encodedIv, encodedCiphertext, encodedTag, extra] = token.split(".");
    if (version !== "v1" || !encodedIv || !encodedCiphertext || !encodedTag || extra) return null;
    try {
      const iv = Buffer.from(encodedIv, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext, "base64url");
      const tag = Buffer.from(encodedTag, "base64url");
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4096) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from(FLOW_COOKIE));
      decipher.setAuthTag(tag);
      const value = JSON.parse(Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8")) as Partial<OaFlow>;
      if (
        typeof value.state !== "string"
        || typeof value.nonce !== "string"
        || typeof value.codeVerifier !== "string"
        || typeof value.expiresAt !== "number"
        || value.state.length < 32
        || value.state.length > 256
        || value.nonce.length < 32
        || value.nonce.length > 256
        || value.codeVerifier.length < 43
        || value.codeVerifier.length > 128
        || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= this.#now()
      ) return null;
      return value as OaFlow;
    } catch {
      return null;
    }
  }

  #prune(): void {
    const now = this.#now();
    for (const [digest, expiresAt] of this.#consumed) {
      if (expiresAt <= now) this.#consumed.delete(digest);
    }
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function cookie(request: Request, name: string): string {
  const header = request.header("cookie") ?? "";
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function setFlowCookie(response: Response, token: string): void {
  response.cookie(FLOW_COOKIE, token, {
    path: "/",
    maxAge: FLOW_TTL_MS,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
}

function clearFlowCookie(response: Response): void {
  response.clearCookie(FLOW_COOKIE, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
}

function currentCallbackUrl(request: Request, publicOrigin: string): URL {
  const value = new URL("/api/v1/admin/oa/callback", publicOrigin);
  const queryIndex = request.originalUrl.indexOf("?");
  if (queryIndex >= 0) value.search = request.originalUrl.slice(queryIndex + 1);
  return value;
}

export function registerAdminOaRoutes(
  app: Express,
  sessions: AdminSessionManager,
  audits: AdminAuditService,
  options: AdminOaOptions,
): void {
  const now = options.now ?? Date.now;
  const flows = new AdminOaFlowCookie(options.sessionSecret, now);
  const event = (request: Request, response: Response, action: string): AuditEvent => ({
    actorType: "browser_session",
    actorId: "oa",
    action,
    resourceType: "admin_session",
    resourceId: "tenant-1",
    requestId: auditRequest(request, response),
  });

  app.get("/api/v1/admin/oa/login", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    const audit = event(request, response, "admin.oa.login.start");
    try {
      const flow: OaFlow = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        codeVerifier: oidc.randomPKCECodeVerifier(),
        expiresAt: now() + FLOW_TTL_MS,
      };
      const authorizationUrl = await options.client.authorizationUrl({
        redirectUri: new URL("/api/v1/admin/oa/callback", options.publicOrigin).toString(),
        scope: options.scope,
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: await oidc.calculatePKCECodeChallenge(flow.codeVerifier),
      });
      await audits.record(audit, "success");
      setFlowCookie(response, flows.issue(flow));
      response.redirect(302, authorizationUrl);
    } catch {
      await audits.record(audit, "failed", "oa_unavailable").catch(() => undefined);
      response.status(502).json({ error: { code: "oa_unavailable", message: "OA login is unavailable" } });
    }
  });

  app.get("/api/v1/admin/oa/callback", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    clearFlowCookie(response);
    const audit = event(request, response, "admin.oa.login.callback");
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const flow = flows.consume(cookie(request, FLOW_COOKIE), state);
    if (!flow) {
      await audits.record(audit, "denied", "oa_state_invalid").catch(() => undefined);
      response.status(400).json({ error: { code: "oa_login_failed", message: "OA login failed" } });
      return;
    }
    try {
      const identity = await options.client.exchangeCallback({
        currentUrl: currentCallbackUrl(request, options.publicOrigin),
        codeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      const claims = await sessions.authenticateOa(identity);
      if (!claims) {
        await audits.record(audit, "denied", "oa_identity_denied");
        response.status(403).json({ error: { code: "forbidden", message: "Forbidden" } });
        return;
      }
      audit.actorId = claims.username;
      await audits.record(audit, "success");
      setAdminSessionCookie(response, sessions.issue(claims), claims.expiresAt);
      response.redirect(303, "/");
    } catch {
      await audits.record(audit, "denied", "oa_callback_invalid").catch(() => undefined);
      response.status(400).json({ error: { code: "oa_login_failed", message: "OA login failed" } });
    }
  });
}
