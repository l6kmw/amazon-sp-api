import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import express from "express";
import type { Pool } from "pg";

import { registerAdminAgentRoutes, type AdminAgentService } from "../src/admin-agents.js";
import { registerAdminAuditRoutes, type AdminAuditService, type AuditEvent, type AuditResult } from "../src/admin-audit.js";
import { registerAdminBindingRoutes } from "../src/admin-bindings.js";
import { createAmazonMcpHttpApp } from "../src/http.js";
import { hashAdminPassword } from "../src/admin-auth.js";
import { AdminSessionManager, registerAdminSessionRoutes } from "../src/admin-session.js";
import type { PostgresConnectedAccountAccountStore } from "../src/postgres-connected-account-accounts.js";

async function fixture(now = { value: Date.now() }) {
  const password = "correct horse battery staple";
  const passwordHash = await hashAdminPassword(password);
  const state = { active: true };
  const pool = {
    async query(text: string) {
      if (text.includes("password_hash")) {
        return {
          rows: [{ username: "admin", password_hash: passwordHash, role: "admin", status: state.active ? "active" : "disabled" }],
        };
      }
      if (text.includes("status = 'active'")) {
        return { rows: state.active ? [{ username: "admin" }] : [] };
      }
      throw new Error("unexpected query");
    },
  } as unknown as Pool;
  const sessions = new AdminSessionManager({
    pool,
    secret: Buffer.alloc(32, 19).toString("base64"),
    now: () => now.value,
  });
  const auditEvents: Array<AuditEvent & { result: AuditResult; errorCode: string | null }> = [];
  const audits = {
    async record(event: AuditEvent, result: AuditResult, errorCode: string | null = null) {
      auditEvents.push({ ...event, result, errorCode });
    },
    async run<T>(event: AuditEvent, operation: (client: never) => Promise<T>, classify: (error: unknown) => {
      result: Exclude<AuditResult, "success">; errorCode: string;
    }) {
      try {
        const value = await operation({} as never);
        auditEvents.push({ ...event, result: "success", errorCode: null });
        return value;
      } catch (error) {
        const failure = classify(error);
        auditEvents.push({ ...event, ...failure });
        throw error;
      }
    },
    async list() { return { items: [], nextCursor: null }; },
  } as unknown as AdminAuditService;
  const app = express();
  app.use(express.json({ strict: true, limit: "4kb" }));
  registerAdminSessionRoutes(app, sessions, audits);
  const sampleAgent = {
    id: "agent_test", agent_id: "diagnostic-agent", name: "Diagnostic Agent", purpose: "test",
    status: "active" as const, api_token_configured: true, api_token_hint: "oat_abcdef…1234",
    api_token_created_at: new Date(now.value).toISOString(), last_used_at: null,
    created_at: new Date(now.value).toISOString(), updated_at: new Date(now.value).toISOString(),
  };
  const agentBearer = `oat_${"z".repeat(43)}`;
  const agents = {
    async authenticateToken(value: string) {
      return value === agentBearer ? {
        authType: "test_agent", credentialKind: "test_agent_token", tenantId: "tenant-1",
        agentRecordId: sampleAgent.id, agentId: sampleAgent.agent_id,
        scopes: new Set(["connected_accounts:manage"]),
      } : null;
    },
    async list() { return [sampleAgent]; },
    async create() { return { agent: sampleAgent, apiToken: `oat_${"a".repeat(43)}` }; },
    async update() { return sampleAgent; },
    async rotateToken() { return { agent: sampleAgent, apiToken: `oat_${"b".repeat(43)}` }; },
    async revokeToken() { return { ...sampleAgent, api_token_configured: false, api_token_hint: "" }; },
  } as unknown as AdminAgentService;
  const bindingCalls: Array<{
    operation: "share" | "unshare" | "disconnect" | "authorization.create" | "authorization.read";
    issuer: string;
    employeeId?: string;
    connectionId: string;
  }> = [];
  const accounts = {
    async adminCreateAuthorizationAttempt(issuer: string, employeeId: string) {
      bindingCalls.push({ operation: "authorization.create", issuer, employeeId, connectionId: "att_admin_test_1234567890123" });
      return {
        attemptId: "att_admin_test_1234567890123",
        status: "pending",
        authorizationUrl: "https://api.example.com/oauth/amazon/start?intent=safe",
        createdAt: new Date(now.value).toISOString(),
        expiresAt: new Date(now.value + 600_000).toISOString(),
      };
    },
    async pollAdminAuthorizationCompletion() { return null; },
    async adminGetAuthorizationAttempt(attemptId: string) {
      bindingCalls.push({ operation: "authorization.read", issuer: "example-issuer-prod", connectionId: attemptId });
      return {
        attemptId,
        status: "pending",
        createdAt: new Date(now.value).toISOString(),
        expiresAt: new Date(now.value + 600_000).toISOString(),
      };
    },
    async adminShareAccount(issuer: string, employeeId: string, connectionId: string) {
      bindingCalls.push({ operation: "share", issuer, employeeId, connectionId });
      return { account: { connectionId, metadata: { account_id: "acct_test" } }, created: true };
    },
    async adminUnshareAccount(issuer: string, employeeId: string, connectionId: string) {
      bindingCalls.push({ operation: "unshare", issuer, employeeId, connectionId });
    },
    async adminDisconnectConnection(issuer: string, connectionId: string) {
      bindingCalls.push({ operation: "disconnect", issuer, connectionId });
    },
  } as unknown as PostgresConnectedAccountAccountStore;
  registerAdminAuditRoutes(app, sessions, audits, agents);
  registerAdminAgentRoutes(app, sessions, agents, audits);
  registerAdminBindingRoutes(app, sessions, agents, audits, accounts);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    password,
    state,
    now,
    auditEvents,
    agentBearer,
    bindingCalls,
  };
}

test("issues a signed secure admin session and requires CSRF for logout", async () => {
  const app = await fixture();
  try {
    const anonymous = await fetch(`${app.baseURL}/api/v1/admin/session`);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.deepEqual(await anonymous.json(), {
      auth_enabled: true,
      login_enabled: true,
      authenticated: false,
    });

    const login = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: app.password }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("cache-control"), "no-store");
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^__Host-amazon_admin_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    const sessionCookie = setCookie.split(";", 1)[0]!;
    const body = await login.json() as { csrf_token: string; authenticated: boolean };
    assert.equal(body.authenticated, true);
    assert.match(body.csrf_token, /^[A-Za-z0-9_-]{32,}$/);
    assert.doesNotMatch(JSON.stringify(body), /password|scrypt/i);

    const current = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal((await current.json() as { authenticated: boolean }).authenticated, true);

    const missingCsrf = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "DELETE",
      headers: { cookie: sessionCookie },
    });
    assert.equal(missingCsrf.status, 403);

    const logout = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "DELETE",
      headers: { cookie: sessionCookie, "x-csrf-token": body.csrf_token },
    });
    assert.equal(logout.status, 200);
    const cleared = logout.headers.get("set-cookie") ?? "";
    assert.match(cleared, /^__Host-amazon_admin_session=;/);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
    assert.match(cleared, /HttpOnly.*Secure.*SameSite=Strict/i);
    assert.deepEqual(app.auditEvents.map(({ action, result, errorCode }) => ({ action, result, errorCode })), [
      { action: "admin.login", result: "success", errorCode: null },
      { action: "admin.logout", result: "denied", errorCode: "csrf_invalid" },
      { action: "admin.logout", result: "success", errorCode: null },
    ]);
    assert.doesNotMatch(JSON.stringify(app.auditEvents), new RegExp(app.password));
    assert.doesNotMatch(JSON.stringify(app.auditEvents), /__Host-|csrf_token|oat_/i);
  } finally {
    await app.close();
  }
});

test("rejects tampered, expired, and disabled administrator sessions", async () => {
  const now = { value: Date.now() };
  const app = await fixture(now);
  try {
    const login = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: app.password }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0]!;

    const tampered = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      headers: { cookie: `${cookie}x` },
    });
    assert.equal((await tampered.json() as { authenticated: boolean }).authenticated, false);

    app.state.active = false;
    const disabled = await fetch(`${app.baseURL}/api/v1/admin/session`, { headers: { cookie } });
    assert.equal((await disabled.json() as { authenticated: boolean }).authenticated, false);

    app.state.active = true;
    now.value += 12 * 60 * 60_000 + 1;
    const expired = await fetch(`${app.baseURL}/api/v1/admin/session`, { headers: { cookie } });
    assert.equal((await expired.json() as { authenticated: boolean }).authenticated, false);
  } finally {
    await app.close();
  }
});

test("protects test agent routes with the administrator session and CSRF", async () => {
  const app = await fixture();
  try {
    const anonymous = await fetch(`${app.baseURL}/api/v1/admin/agents`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: app.password }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const csrf = (await login.json() as { csrf_token: string }).csrf_token;

    const auditPage = await fetch(`${app.baseURL}/api/v1/admin/audit-logs`, { headers: { cookie } });
    assert.equal(auditPage.status, 200);
    assert.equal(auditPage.headers.get("cache-control"), "no-store");
    assert.deepEqual(await auditPage.json(), { items: [], next_cursor: null });
    assert.equal((await fetch(`${app.baseURL}/api/v1/admin/audit-logs?limit=101`, {
      headers: { cookie },
    })).status, 400);
    assert.equal((await fetch(`${app.baseURL}/api/v1/admin/audit-logs`, {
      headers: { authorization: `Bearer ${app.agentBearer}` },
    })).status, 200);
    assert.equal((await fetch(`${app.baseURL}/api/v1/admin/agents`, {
      headers: { authorization: `Bearer ${app.agentBearer}` },
    })).status, 200);
    assert.equal((await fetch(`${app.baseURL}/api/v1/admin/agents/agent_test`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${app.agentBearer}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated by Agent" }),
    })).status, 200);

    const denied = await fetch(`${app.baseURL}/api/v1/admin/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "diagnostic-agent", name: "Diagnostic Agent" }),
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`${app.baseURL}/api/v1/admin/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ agent_id: "diagnostic-agent", name: "Diagnostic Agent" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.match((await created.json() as { api_token: string }).api_token, /^oat_/);

    const rotated = await fetch(`${app.baseURL}/api/v1/admin/agents/agent_test/api-token`, {
      method: "POST", headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get("cache-control"), "no-store");
    assert.match((await rotated.json() as { api_token: string }).api_token, /^oat_/);
    const revoked = await fetch(`${app.baseURL}/api/v1/admin/agents/agent_test/api-token`, {
      method: "DELETE", headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.headers.get("cache-control"), "no-store");
    assert.equal((await revoked.json() as { api_token_configured: boolean }).api_token_configured, false);

    const listed = await fetch(`${app.baseURL}/api/v1/admin/agents`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    assert.doesNotMatch(JSON.stringify(await listed.json()), new RegExp(`oat_${"a".repeat(43)}`));
    assert.deepEqual(
      app.auditEvents.filter(({ action }) => action.startsWith("agent.")).map(({ action, result, errorCode }) => ({
        action, result, errorCode,
      })),
      [
        { action: "agent.list", result: "denied", errorCode: "unauthorized" },
        { action: "agent.update", result: "success", errorCode: null },
        { action: "agent.create", result: "denied", errorCode: "csrf_invalid" },
        { action: "agent.create", result: "success", errorCode: null },
        { action: "agent.token.rotate", result: "success", errorCode: null },
        { action: "agent.token.revoke", result: "success", errorCode: null },
      ],
    );
    const agentAudit = app.auditEvents.find(({ action }) => action === "agent.update")!;
    assert.equal(agentAudit.actorType, "agent_token");
    assert.equal(agentAudit.actorId, "diagnostic-agent");
    assert.equal(agentAudit.agentRecordId, "agent_test");
  } finally {
    await app.close();
  }
});

test("shares and removes employee bindings through authenticated audited admin routes", async () => {
  const app = await fixture();
  try {
    const connectionId = `con_${"c".repeat(24)}`;
    const login = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: app.password }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const csrf = (await login.json() as { csrf_token: string }).csrf_token;

    const denied = await fetch(`${app.baseURL}/api/v1/admin/connected-account-employees/employee-2/account-bindings`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ issuer: "example-issuer-prod", connection_id: connectionId }),
    });
    assert.equal(denied.status, 403);
    const shared = await fetch(`${app.baseURL}/api/v1/admin/connected-account-employees/employee-2/account-bindings`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.agentBearer}`, "content-type": "application/json" },
      body: JSON.stringify({ issuer: "example-issuer-prod", connection_id: connectionId }),
    });
    assert.equal(shared.status, 201);
    assert.equal(shared.headers.get("cache-control"), "no-store");
    const removed = await fetch(
      `${app.baseURL}/api/v1/admin/connected-account-employees/employee-2/account-bindings/${connectionId}?issuer=example-issuer-prod`,
      { method: "DELETE", headers: { cookie, "x-csrf-token": csrf } },
    );
    assert.equal(removed.status, 204);
    const disconnectDenied = await fetch(
      `${app.baseURL}/api/v1/admin/connections/${connectionId}?issuer=example-issuer-prod`,
      { method: "DELETE", headers: { cookie } },
    );
    assert.equal(disconnectDenied.status, 403);
    const disconnected = await fetch(
      `${app.baseURL}/api/v1/admin/connections/${connectionId}?issuer=example-issuer-prod`,
      { method: "DELETE", headers: { authorization: `Bearer ${app.agentBearer}` } },
    );
    assert.equal(disconnected.status, 204);
    assert.equal(disconnected.headers.get("cache-control"), "no-store");
    assert.deepEqual(app.bindingCalls, [
      { operation: "share", issuer: "example-issuer-prod", employeeId: "employee-2", connectionId },
      { operation: "unshare", issuer: "example-issuer-prod", employeeId: "employee-2", connectionId },
      { operation: "disconnect", issuer: "example-issuer-prod", connectionId },
    ]);
    assert.deepEqual(
      app.auditEvents.filter(({ action }) => action.startsWith("employee.binding"))
        .map(({ actorType, action, result, errorCode }) => ({ actorType, action, result, errorCode })),
      [
        { actorType: "browser_session", action: "employee.binding.share", result: "denied", errorCode: "csrf_invalid" },
        { actorType: "agent_token", action: "employee.binding.share", result: "success", errorCode: null },
        { actorType: "browser_session", action: "employee.binding.unshare", result: "success", errorCode: null },
      ],
    );
    assert.deepEqual(
      app.auditEvents.filter(({ action }) => action === "connection.disconnect")
        .map(({ actorType, result, errorCode }) => ({ actorType, result, errorCode })),
      [
        { actorType: "browser_session", result: "denied", errorCode: "csrf_invalid" },
        { actorType: "agent_token", result: "success", errorCode: null },
      ],
    );
  } finally {
    await app.close();
  }
});

test("registers audited admin OAuth attempts and keeps refresh writes unregistered", async () => {
  const context = await fixture();
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    createServer: () => { throw new Error("not used"); },
    adminSessions: {} as AdminSessionManager,
    adminAgents: {} as AdminAgentService,
    adminAudits: {} as AdminAuditService,
    adminBindingAccounts: {} as PostgresConnectedAccountAccountStore,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${context.baseURL}/api/v1/admin/authorization-attempts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.agentBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ issuer: "example-issuer-prod", employee_id: "employee-owner" }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.attempt_id, "att_admin_test_1234567890123");
    assert.equal(createdBody.status, "pending");
    assert.match(createdBody.authorization_url, /^https:\/\//);

    const attempt = await fetch(
      `${context.baseURL}/api/v1/admin/authorization-attempts/${createdBody.attempt_id}`,
      { headers: { authorization: `Bearer ${context.agentBearer}` } },
    );
    assert.equal(attempt.status, 200);
    assert.equal((await attempt.json()).attempt_id, createdBody.attempt_id);
    assert.deepEqual(context.bindingCalls.slice(-2), [
      {
        operation: "authorization.create",
        issuer: "example-issuer-prod",
        employeeId: "employee-owner",
        connectionId: "att_admin_test_1234567890123",
      },
      {
        operation: "authorization.read",
        issuer: "example-issuer-prod",
        connectionId: "att_admin_test_1234567890123",
      },
    ]);

    assert.equal((await fetch(`${origin}/api/v1/admin/accounts/acct_test/refresh`, {
      method: "POST",
    })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await context.close();
  }
});

test("locks repeated administrator login failures without revealing account existence", async () => {
  const app = await fixture();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${app.baseURL}/api/v1/admin/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong-password" }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: { code: "invalid_credentials", message: "Invalid credentials" },
      });
    }
    const locked = await fetch(`${app.baseURL}/api/v1/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: app.password }),
    });
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get("retry-after"), "300");
  } finally {
    await app.close();
  }
});
