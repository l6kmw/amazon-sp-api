import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createAmazonMcpHttpApp } from "../src/http.js";
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST } from "../src/connected-account.js";
import { createStructuredLogger } from "../src/logger.js";
import { PrincipalRequestLimiter } from "../src/rate-limit.js";
import { createRuntimeReadinessCheck } from "../src/server.js";
import { createAmazonMcpServer } from "../src/tools.js";

test("requires bearer authentication and serves seven data tools over Streamable HTTP", async () => {
  const authToken = "test-auth-token".repeat(3);
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async (token) => token === authToken
      ? { authType: "legacy", tenantId: "migration-tenant" }
      : null,
    createServer: () =>
      createAmazonMcpServer({
        async get() {
          return {};
        },
      }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

  try {
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);

    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    });
    const client = new Client({ name: "http-test-client", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    await client.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects an authenticated principal without a tenant before creating an MCP server", async () => {
  let serverCreations = 0;
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async () => ({ authType: "legacy" }),
    createServer: () => {
      serverCreations += 1;
      return createAmazonMcpServer({ async get() { return {}; } });
    },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`,
      {
        method: "POST",
        headers: { authorization: "Bearer legacy", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      error: { code: -32003, message: "Tenant identity required" },
      id: 1,
    });
    assert.equal(serverCreations, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("binds a Legacy credential principal to standalone management tools", async () => {
  let listedTenant = "";
  const logs: string[] = [];
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async (token) => token === "oat_user" ? { authType: "legacy", tenantId: "user-1" } : null,
    createServer: (principal) => createAmazonMcpServer(
      { async get() { return {}; } },
      {
        tenantId: principal.tenantId,
        connections: {
          async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start?intent=opaque"; },
          async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew?intent=opaque"; },
          async listConnections(tenantId) { listedTenant = tenantId; return []; },
          async disconnect() {},
        },
      },
    ),
    toolCount: 14,
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const endpoint = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);

  try {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: "Bearer oat_user" } },
    });
    const client = new Client({ name: "tenant-http-test", version: "1.0.0" });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 14);
    await client.callTool({ name: "amazon_list_connections", arguments: {} });
    assert.equal(listedTenant, "user-1");
    await client.close();

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejected.status, 401);
    assert.ok(logs.some((line) => line.includes('"event":"mcp.request.completed"')));
    assert.ok(logs.some((line) => line.includes('"event":"mcp.auth.rejected"')));
    assert.doesNotMatch(logs.join("\n"), /oat_user|user-1|Bearer wrong/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("serves ConnectedAccount discovery, auth check, MCP health, and enforces MCP scopes", async () => {
  const principal = {
    authType: "connected-account" as const,
    tenantId: "jwt-employee:issuer:employee-1",
    issuer: "example-issuer-prod",
    employeeId: "employee-1",
    kid: "provider-v1",
    expiresAt: "2026-07-21T10:00:00.000Z",
    scopes: new Set(["config:check"]),
  };
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 14,
    connected-accountManifest: CONNECTED_ACCOUNT_DISCOVERY_MANIFEST,
    authenticate: async (token) => token === "employee-jwt" ? principal : null,
    createServer: (authenticatedPrincipal) => createAmazonMcpServer(
      { async get() { return {}; } },
      {
        tenantId: authenticatedPrincipal.tenantId,
        principal: authenticatedPrincipal,
      },
    ),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  try {
    const discovery = await fetch(`${origin}/.well-known/connected-account`);
    assert.equal(discovery.status, 200);
    assert.deepEqual(await discovery.json(), CONNECTED_ACCOUNT_DISCOVERY_MANIFEST);
    assert.equal(discovery.headers.get("cache-control"), "no-store");

    const mcpHealth = await fetch(`${origin}/mcp/healthz`);
    assert.equal(mcpHealth.status, 200);
    assert.deepEqual(await mcpHealth.json(), { status: "ok", tools: 14, version: "0.1.0" });

    const unauthorized = await fetch(`${origin}/connected-account/v1/auth/check`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

    const checked = await fetch(`${origin}/connected-account/v1/auth/check`, {
      headers: { authorization: "Bearer employee-jwt" },
    });
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), {
      authenticated: true,
      employeeId: "employee-1",
      issuer: "example-issuer-prod",
      kid: "provider-v1",
      expiresAt: "2026-07-21T10:00:00.000Z",
    });

    const scopeRejected = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer employee-jwt", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    assert.equal(scopeRejected.status, 403);
    assert.deepEqual(await scopeRejected.json(), {
      jsonrpc: "2.0",
      error: { code: -32003, message: "Required scope is missing" },
      id: 7,
    });

    principal.scopes.add("mcp:catalog");
    const catalogTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: "Bearer employee-jwt" } },
    });
    const catalogClient = new Client({ name: "connected-account-catalog-test", version: "1.0.0" });
    await catalogClient.connect(catalogTransport);
    assert.ok((await catalogClient.listTools()).tools.some(
      (tool) => tool.name === "amazon_list_accounts",
    ));
    await catalogClient.close();
    const catalogInvokeRejected = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer employee-jwt", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "amazon_get_identity", arguments: {} },
      }),
    });
    assert.equal(catalogInvokeRejected.status, 403);
    assert.deepEqual(await catalogInvokeRejected.json(), {
      jsonrpc: "2.0",
      error: { code: -32003, message: "Required scope is missing" },
      id: 8,
    });
    const catalogDelete = await fetch(`${origin}/mcp`, {
      method: "DELETE",
      headers: { authorization: "Bearer employee-jwt" },
    });
    assert.equal(catalogDelete.status, 403);

    principal.scopes.add("mcp:invoke");
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: "Bearer employee-jwt" } },
    });
    const client = new Client({ name: "connected-account-http-test", version: "1.0.0" });
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "amazon_list_accounts"));
    const identity = await client.callTool({ name: "amazon_get_identity", arguments: {} });
    assert.deepEqual(identity.structuredContent, {
      identity_type: "employee_jwt",
      identity_id: "employee-1",
      role: "employee",
    });
    const accounts = await client.callTool({ name: "amazon_list_accounts", arguments: {} });
    assert.deepEqual(accounts.structuredContent, { items: [] });
    await client.close();
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("returns retry guidance when a tenant exceeds its request rate", async () => {
  const logs: string[] = [];
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async () => ({ authType: "legacy", tenantId: "tenant-limited" }),
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
    requestLimiter: new PrincipalRequestLimiter({ requestsPerMinute: 1, maxConcurrent: 2 }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const endpoint = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const request = () => fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer tenant-token", "content-type": "application/json" },
    body: "{}",
  });

  try {
    const first = await request();
    assert.notEqual(first.status, 429);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.deepEqual(await limited.json(), {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Too many requests" },
      id: null,
    });
    assert.ok(logs.some((line) => line.includes('"event":"mcp.rate_limited"')));
    assert.doesNotMatch(logs.join("\n"), /tenant-limited|tenant-token/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("fails readiness when the token encryption key cannot be parsed", async () => {
  const readinessCheck = createRuntimeReadinessCheck({
    tokenStoreFile: "/tokens.json",
    oauthInternalURL: "http://127.0.0.1:8788",
    encryptionKey: "not-a-32-byte-key",
    accessFile: async () => {},
    fetchImpl: (async () => new Response(
      JSON.stringify({ status: "ok", lwaConfigured: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch,
  });

  assert.deepEqual(await readinessCheck(), {
    status: "not_ready",
    checks: { tokenStore: "ok", oauthInternal: "ok", encryptionKey: "error" },
  });
});

test("includes PostgreSQL, Redis, and identity service in production readiness", async () => {
  let identityResponse: "ok" | "unavailable" | "malformed" = "ok";
  const readinessCheck = createRuntimeReadinessCheck({
    tokenStoreFile: "/unused/tokens.json",
    oauthInternalURL: "http://127.0.0.1:8788/internal",
    identityHealthURL: "http://127.0.0.1:8080/healthz",
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    tokenStoreCheck: async () => "ok",
    postgresCheck: async () => "ok",
    redisCheck: async () => "ok",
    fetchImpl: (async (input, init) => {
      assert.ok(init?.signal);
      const url = String(input);
      if (url === "http://127.0.0.1:8788/healthz") {
        return new Response(JSON.stringify({ status: "ok", lwaConfigured: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(url, "http://127.0.0.1:8080/healthz");
      if (identityResponse === "unavailable") {
        return new Response(JSON.stringify({ status: "error" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        identityResponse === "malformed" ? "not-json" : JSON.stringify({ status: "ok" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  assert.deepEqual(await readinessCheck(), {
    status: "ready",
    checks: {
      tokenStore: "ok",
      oauthInternal: "ok",
      encryptionKey: "ok",
      postgres: "ok",
      redis: "ok",
      identityService: "ok",
    },
  });

  identityResponse = "unavailable";
  assert.equal((await readinessCheck()).checks.identityService, "error");
  assert.equal((await readinessCheck()).status, "not_ready");

  identityResponse = "malformed";
  assert.equal((await readinessCheck()).checks.identityService, "error");
  assert.equal((await readinessCheck()).status, "not_ready");
});

test("separates liveness from runtime readiness without leaking check errors", async () => {
  let tokenStoreReadable = true;
  let oauthHealthy = true;
  let oauthLwaConfigured = true;
  let malformedOauthHealth = false;
  let oauthRequestFails = false;
  let unexpectedFailure = false;
  const runtimeReadinessCheck = createRuntimeReadinessCheck({
    tokenStoreFile: "/sensitive/tokens.json",
    oauthInternalURL: "http://127.0.0.1:8788/internal",
    accessFile: async (file, mode) => {
      assert.equal(file, "/sensitive/tokens.json");
      assert.equal(mode, 4);
      if (!tokenStoreReadable) throw new Error(`cannot read ${file}`);
    },
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    fetchImpl: (async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1:8788/healthz");
      assert.ok(init?.signal);
      if (oauthRequestFails) throw new TypeError("fetch failed for internal credential");
      return new Response(
        malformedOauthHealth
          ? "not-json"
          : JSON.stringify({ status: "ok", lwaConfigured: oauthLwaConfigured }),
        {
          status: oauthHealthy ? 200 : 503,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
  });
  const app = createAmazonMcpHttpApp({
    authToken: "test-auth-token".repeat(3),
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
    toolCount: 11,
    version: "0.1.0",
    readinessCheck: async () => {
      if (unexpectedFailure) throw new Error("credential at /sensitive/tokens.json");
      return runtimeReadinessCheck();
    },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok", tools: 11, version: "0.1.0" });

    const ready = await fetch(`${origin}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: "ready",
      checks: { tokenStore: "ok", oauthInternal: "ok", encryptionKey: "ok" },
    });

    tokenStoreReadable = false;
    const unreadable = await fetch(`${origin}/readyz`);
    assert.equal(unreadable.status, 503);
    assert.deepEqual(await unreadable.json(), {
      status: "not_ready",
      checks: { tokenStore: "error", oauthInternal: "ok", encryptionKey: "ok" },
    });
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);

    tokenStoreReadable = true;
    oauthHealthy = false;
    const oauthUnavailable = await fetch(`${origin}/readyz`);
    assert.equal(oauthUnavailable.status, 503);
    assert.deepEqual(await oauthUnavailable.json(), {
      status: "not_ready",
      checks: { tokenStore: "ok", oauthInternal: "error", encryptionKey: "ok" },
    });

    oauthHealthy = true;
    oauthLwaConfigured = false;
    const oauthUnconfigured = await fetch(`${origin}/readyz`);
    assert.equal(oauthUnconfigured.status, 503);
    assert.deepEqual(await oauthUnconfigured.json(), {
      status: "not_ready",
      checks: { tokenStore: "ok", oauthInternal: "error", encryptionKey: "ok" },
    });

    oauthLwaConfigured = true;
    malformedOauthHealth = true;
    const malformedOauth = await fetch(`${origin}/readyz`);
    assert.equal(malformedOauth.status, 503);
    assert.deepEqual(await malformedOauth.json(), {
      status: "not_ready",
      checks: { tokenStore: "ok", oauthInternal: "error", encryptionKey: "ok" },
    });

    malformedOauthHealth = false;
    oauthRequestFails = true;
    const oauthNetworkFailure = await fetch(`${origin}/readyz`);
    assert.equal(oauthNetworkFailure.status, 503);
    assert.doesNotMatch(await oauthNetworkFailure.text(), /credential|fetch failed/);

    unexpectedFailure = true;
    const unexpected = await fetch(`${origin}/readyz`);
    assert.equal(unexpected.status, 503);
    const body = await unexpected.text();
    assert.doesNotMatch(body, /credential|sensitive|tokens\.json/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
