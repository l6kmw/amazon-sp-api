import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import express from "express";

import type { AdminAgentService } from "../src/admin-agents.js";
import {
  type AdminAdsAccount,
  type AdminAdsEmployee,
  type AdminAdsService,
  LoopbackAdminAdsClient,
  registerAdminAdsRoutes,
} from "../src/admin-ads.js";
import type { AdminAuditService } from "../src/admin-audit.js";
import type { AdminSessionManager } from "../src/admin-session.js";

const account: AdminAdsAccount = {
  provider_key: "amazon-ads",
  account_id: "acct_0123456789abcdef",
  connection_id: "con_0123456789abcdef",
  external_account_id: "1234567890",
  display_name: "US Ads",
  status: "active",
  owner_issuer: "https://identity.example.com",
  owner_employee_id: "employee-owner",
  active_bindings_count: 1,
  updated_at: "2026-08-05T12:00:00.000Z",
  region: "na",
  country_code: "US",
  currency_code: "USD",
  account_type: "seller",
  bindings: [{
    connection_id: "con_0123456789abcdef",
    issuer: "https://identity.example.com",
    employee_id: "employee-owner",
    status: "active",
    remark: null,
    bound_at: "2026-08-05T12:00:00.000Z",
    updated_at: "2026-08-05T12:00:00.000Z",
    is_owner: true,
  }],
};

const employee: AdminAdsEmployee = {
  issuer: account.owner_issuer,
  employee_id: account.owner_employee_id,
  first_seen_at: "2026-08-05T12:00:00.000Z",
  last_seen_at: "2026-08-05T12:00:00.000Z",
  active_bindings_count: 1,
  total_bindings_count: 1,
};

test("loopback Ads client accepts only bounded credential-free DTOs", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/accounts")) {
      response.end(JSON.stringify({ items: [account], total: 1 }));
    } else if (request.url?.includes("/accounts/")) {
      response.end(JSON.stringify(account));
    } else if (request.url?.endsWith("/employees")) {
      response.end(JSON.stringify({ items: [employee], total: 1 }));
    } else if (request.method === "POST") {
      response.statusCode = 201;
      response.end(JSON.stringify({ shared: true }));
    } else {
      response.statusCode = 204;
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const client = new LoopbackAdminAdsClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  try {
    assert.deepEqual(await client.listAccounts(), { items: [account], total: 1 });
    assert.deepEqual(await client.getAccount(account.account_id), account);
    assert.deepEqual(await client.listEmployees(), { items: [employee], total: 1 });
    await client.shareBinding(account.connection_id, employee.issuer, employee.employee_id);
    await client.unshareBinding(account.connection_id, employee.issuer, employee.employee_id);
    await client.disconnect(account.connection_id);
    assert.equal(paths.length, 6);
    assert.ok(paths.every((path) => path.includes("/_internal/admin/amazon-ads/")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const invalidServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ ...account, refresh_token: "forbidden" }], total: 1 }));
  });
  await new Promise<void>((resolve) => invalidServer.listen(0, "127.0.0.1", resolve));
  try {
    const invalid = new LoopbackAdminAdsClient(
      `http://127.0.0.1:${(invalidServer.address() as AddressInfo).port}`,
    );
    await assert.rejects(invalid.listAccounts(), /Ads response is invalid/);
  } finally {
    await new Promise<void>((resolve) => invalidServer.close(() => resolve()));
  }
});

test("admin Ads routes require the existing admin Session and CSRF", async () => {
  const calls: string[] = [];
  const ads: AdminAdsService = {
    async listAccounts() { calls.push("list"); return { items: [account], total: 1 }; },
    async getAccount() { calls.push("detail"); return account; },
    async listEmployees() { calls.push("employees"); return { items: [employee], total: 1 }; },
    async shareBinding() { calls.push("share"); },
    async unshareBinding() { calls.push("unshare"); },
    async disconnect() { calls.push("disconnect"); },
  };
  const claims = {
    userId: "tenant-1" as const,
    username: "admin",
    role: "admin" as const,
    csrfToken: "test-csrf-token-01234567890123456789",
    expiresAt: Date.now() + 60_000,
  };
  const sessions = {
    async session(request: express.Request) {
      return request.header("x-test-admin") === "yes" ? claims : null;
    },
    validCsrf(request: express.Request) {
      return request.header("x-csrf-token") === claims.csrfToken;
    },
  } as unknown as AdminSessionManager;
  const agents = { async authenticateToken() { return null; } } as unknown as AdminAgentService;
  const audits = { async record() {} } as unknown as AdminAuditService;
  const app = express();
  app.use(express.json());
  registerAdminAdsRoutes(app, sessions, agents, audits, ads);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${origin}/api/v1/admin/providers/amazon-ads/accounts`)).status, 401);
    const listed = await fetch(`${origin}/api/v1/admin/providers/amazon-ads/accounts`, {
      headers: { "x-test-admin": "yes" },
    });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as { total: number }).total, 1);

    const shareBody = JSON.stringify({
      connection_id: account.connection_id,
      issuer: employee.issuer,
      employee_id: employee.employee_id,
    });
    assert.equal((await fetch(`${origin}/api/v1/admin/providers/amazon-ads/account-bindings`, {
      method: "POST",
      headers: { "x-test-admin": "yes", "content-type": "application/json" },
      body: shareBody,
    })).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/admin/providers/amazon-ads/account-bindings`, {
      method: "POST",
      headers: {
        "x-test-admin": "yes",
        "x-csrf-token": claims.csrfToken,
        "content-type": "application/json",
      },
      body: shareBody,
    })).status, 201);
    assert.deepEqual(calls, ["list", "share"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
