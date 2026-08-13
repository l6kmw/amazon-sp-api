import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import express from "express";
import type { Pool } from "pg";

import {
  registerAdminOaRoutes,
  type AdminOaClient,
  type AdminOaIdentity,
} from "../src/admin-oa.js";
import type { AdminAuditService, AuditEvent, AuditResult } from "../src/admin-audit.js";
import { AdminSessionManager, registerAdminSessionRoutes } from "../src/admin-session.js";

const ISSUER = "https://oa.example.com/tenant";
const SUBJECT = "oa-admin-subject";

function setCookies(response: Response): string[] {
  const values = response.headers.getSetCookie?.();
  return values?.length ? values : [response.headers.get("set-cookie") ?? ""];
}

function cookieValue(response: Response, name: string): string {
  for (const value of setCookies(response)) {
    const match = value.match(new RegExp(`(?:^|, )${name}=([^;]+)`));
    if (match?.[1]) return `${name}=${match[1]}`;
  }
  return "";
}

async function fixture(identity: AdminOaIdentity = { issuer: ISSUER, subject: SUBJECT }) {
  const now = { value: Date.now() };
  const pool = {
    async query(text: string) {
      if (text.includes("status = 'active'")) return { rows: [{ username: "admin" }] };
      throw new Error("unexpected query");
    },
  } as unknown as Pool;
  const sessions = new AdminSessionManager({
    pool,
    secret: Buffer.alloc(32, 23).toString("base64"),
    now: () => now.value,
    oaIdentity: { issuer: ISSUER, subject: SUBJECT },
  });
  const auditEvents: Array<AuditEvent & { result: AuditResult; errorCode: string | null }> = [];
  const audits = {
    async record(event: AuditEvent, result: AuditResult, errorCode: string | null = null) {
      auditEvents.push({ ...event, result, errorCode });
    },
  } as unknown as AdminAuditService;
  let authorizationInput: Parameters<AdminOaClient["authorizationUrl"]>[0] | undefined;
  const exchanges: Parameters<AdminOaClient["exchangeCallback"]>[0][] = [];
  const client: AdminOaClient = {
    async authorizationUrl(input) {
      authorizationInput = input;
      const url = new URL("/authorize", ISSUER);
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge", input.codeChallenge);
      return url.toString();
    },
    async exchangeCallback(input) {
      exchanges.push(input);
      return identity;
    },
  };
  const app = express();
  app.use(express.json({ strict: true, limit: "4kb" }));
  registerAdminSessionRoutes(app, sessions, audits);
  registerAdminOaRoutes(app, sessions, audits, {
    publicOrigin: "https://api.example.com",
    sessionSecret: Buffer.alloc(32, 23).toString("base64"),
    scope: "openid profile",
    client,
    now: () => now.value,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    now,
    sessions,
    authorizationInput: () => authorizationInput,
    exchanges,
    auditEvents,
  };
}

test("bridges an allowlisted OA identity into the existing admin Session", async () => {
  const app = await fixture();
  try {
    const anonymous = await fetch(`${app.baseURL}/api/v1/admin/session`);
    assert.deepEqual(await anonymous.json(), {
      auth_enabled: true,
      login_enabled: false,
      oa_login_enabled: true,
      oa_login_url: "/api/v1/admin/oa/login",
      authenticated: false,
    });
    assert.equal((await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "password" }),
    })).status, 404);
    assert.equal(app.sessions.verify(app.sessions.issue({
      userId: "tenant-1",
      username: "admin",
      role: "admin",
      authMethod: "password",
      csrfToken: "x".repeat(32),
      expiresAt: app.now.value + 60_000,
    })), null);

    const login = await fetch(`${app.baseURL}/api/v1/admin/oa/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("cache-control"), "no-store");
    assert.equal(login.headers.get("referrer-policy"), "no-referrer");
    const flowCookie = cookieValue(login, "__Host-amazon_admin_oa_flow");
    assert.ok(flowCookie);
    assert.match(setCookies(login).join("\n"), /HttpOnly.*Secure.*SameSite=Lax/i);
    const input = app.authorizationInput();
    assert.ok(input);
    assert.equal(input.redirectUri, "https://api.example.com/api/v1/admin/oa/callback");
    assert.equal(input.scope, "openid profile");
    assert.doesNotMatch(flowCookie, new RegExp(`${input.state}|${input.nonce}`));
    assert.doesNotMatch(login.headers.get("location") ?? "", /code_verifier|client_secret/i);

    const callback = await fetch(
      `${app.baseURL}/api/v1/admin/oa/callback?code=authorization-code&state=${encodeURIComponent(input.state)}`,
      { headers: { cookie: flowCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/");
    const sessionCookie = cookieValue(callback, "__Host-amazon_admin_session");
    assert.ok(sessionCookie);
    assert.match(setCookies(callback).join("\n"), /__Host-amazon_admin_session=.*HttpOnly.*Secure.*SameSite=Strict/i);
    assert.doesNotMatch(setCookies(callback).join("\n"), /authorization-code|oa-admin-subject/);
    assert.equal(app.exchanges.length, 1);
    assert.equal(app.exchanges[0]?.currentUrl.toString(), `https://api.example.com/api/v1/admin/oa/callback?code=authorization-code&state=${input.state}`);
    assert.equal(app.exchanges[0]?.expectedState, input.state);
    assert.equal(app.exchanges[0]?.expectedNonce, input.nonce);
    assert.match(app.exchanges[0]?.codeVerifier ?? "", /^[A-Za-z0-9_-]{43,128}$/);

    const current = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      headers: { cookie: sessionCookie },
    });
    const currentBody = await current.json() as Record<string, unknown>;
    assert.equal(currentBody.authenticated, true);
    assert.equal(currentBody.auth_method, "oa");
    assert.equal(currentBody.username, "admin");
    assert.match(String(currentBody.csrf_token), /^[A-Za-z0-9_-]{32,}$/);
    assert.doesNotMatch(JSON.stringify(currentBody), /oa-admin-subject|authorization-code/);

    const replay = await fetch(
      `${app.baseURL}/api/v1/admin/oa/callback?code=replay&state=${encodeURIComponent(input.state)}`,
      { headers: { cookie: flowCookie }, redirect: "manual" },
    );
    assert.equal(replay.status, 400);
    assert.equal(app.exchanges.length, 1);
    assert.deepEqual(
      app.auditEvents.map(({ action, result, errorCode }) => ({ action, result, errorCode })),
      [
        { action: "admin.oa.login.start", result: "success", errorCode: null },
        { action: "admin.oa.login.callback", result: "success", errorCode: null },
        { action: "admin.oa.login.callback", result: "denied", errorCode: "oa_state_invalid" },
      ],
    );
  } finally {
    await app.close();
  }
});

test("rejects a valid OA callback unless both issuer and subject match", async () => {
  for (const identity of [
    { issuer: ISSUER, subject: "another-subject" },
    { issuer: "https://other-oa.example.com/tenant", subject: SUBJECT },
  ]) {
    const app = await fixture(identity);
    try {
      const login = await fetch(`${app.baseURL}/api/v1/admin/oa/login`, { redirect: "manual" });
      const input = app.authorizationInput()!;
      const callback = await fetch(
        `${app.baseURL}/api/v1/admin/oa/callback?code=authorization-code&state=${encodeURIComponent(input.state)}`,
        { headers: { cookie: cookieValue(login, "__Host-amazon_admin_oa_flow") }, redirect: "manual" },
      );
      assert.equal(callback.status, 403);
      assert.equal(cookieValue(callback, "__Host-amazon_admin_session"), "");
      assert.deepEqual(await callback.json(), { error: { code: "forbidden", message: "Forbidden" } });
      assert.equal(app.auditEvents.at(-1)?.errorCode, "oa_identity_denied");
    } finally {
      await app.close();
    }
  }
});

test("rejects tampered state and an expired OA flow before token exchange", async () => {
  const app = await fixture();
  try {
    const login = await fetch(`${app.baseURL}/api/v1/admin/oa/login`, { redirect: "manual" });
    const input = app.authorizationInput()!;
    const flowCookie = cookieValue(login, "__Host-amazon_admin_oa_flow");
    const tampered = await fetch(
      `${app.baseURL}/api/v1/admin/oa/callback?code=authorization-code&state=${"x".repeat(43)}`,
      { headers: { cookie: flowCookie }, redirect: "manual" },
    );
    assert.equal(tampered.status, 400);
    assert.equal(app.exchanges.length, 0);

    app.now.value += 10 * 60_000 + 1;
    const expired = await fetch(
      `${app.baseURL}/api/v1/admin/oa/callback?code=authorization-code&state=${encodeURIComponent(input.state)}`,
      { headers: { cookie: flowCookie }, redirect: "manual" },
    );
    assert.equal(expired.status, 400);
    assert.equal(app.exchanges.length, 0);
  } finally {
    await app.close();
  }
});
