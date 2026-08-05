import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AdminAuditService } from "../src/admin-audit.js";
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST } from "../src/connected-account.js";
import { createAmazonMcpHttpApp } from "../src/http.js";
import { createStructuredLogger } from "../src/logger.js";
import { createRuntimeReadinessCheck } from "../src/server.js";
import { createAmazonMcpServer } from "../src/tools.js";

const principal = {
  authType: "connected-account" as const,
  tenantId: "jwt-employee:workspace",
  issuer: "https://connected-account.example",
  employeeId: "employee-1",
  kid: "provider-v1",
  expiresAt: "2026-07-28T10:00:00.000Z",
  scopes: new Set(["mcp:invoke"]),
};

async function listen(app: ReturnType<typeof createAmazonMcpHttpApp>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    server,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

test("MCP accepts independent Test Agent and Employee credentials", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 30,
    connected-accountManifest: CONNECTED_ACCOUNT_DISCOVERY_MANIFEST,
    connected-accountAccounts: {
      async listAccounts() { return []; },
      async refreshAccounts() { return []; },
      async lookupAccounts() { return []; },
      async createAuthorizationAttempt() { throw new Error("not used"); },
      async getAuthorizationAttempt() { throw new Error("not used"); },
      async bindAccount() { throw new Error("not used"); },
      async shareAccount() { throw new Error("not used"); },
      async unshareAccount() {},
      async updateRemark() { throw new Error("not used"); },
      async unbindAccount() {},
      async disconnect() {},
      async resolveAccount() { throw new Error("not used"); },
    },
    authenticate: async (token) => token === "employee-jwt"
      ? principal
      : token === `oat_${"a".repeat(43)}`
        ? {
          authType: "test_agent",
          credentialKind: "test_agent_token",
          tenantId: "tenant-1",
          agentRecordId: "agent_record_1",
          agentId: "diagnostic-agent",
          scopes: new Set(["mcp:catalog", "mcp:invoke"]),
        }
        : token === `oat_${"c".repeat(43)}`
          ? {
            authType: "test_agent",
            credentialKind: "test_agent_token",
            tenantId: "tenant-1",
            agentRecordId: "agent_record_no_scope",
            agentId: "no-scope-agent",
            scopes: new Set<string>(),
          }
          : null,
    createServer: (authenticated) => createAmazonMcpServer(
      { async get() { return {}; } },
      {
        principal: authenticated,
        accountAccessPolicy: {
          async listAccounts(actor) {
            return actor.authType === "test_agent" ? [{
              connectionId: "con_0123456789abcdef",
              externalAccountId: "A1TESTAGENT",
              providerKey: "amazon-sp-api",
              displayName: "Agent-visible seller",
              status: "active",
              metadata: { account_id: "acct_0123456789abcdef" },
            }] : [];
          },
          async resolveAccount() { throw new Error("missing"); },
        },
      },
    ),
  });
  const { server, origin } = await listen(app);
  try {
    for (const token of ["", "oat_user", `oat_${"b".repeat(43)}`, "shared-token"]) {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(response.status, 401, token);
    }
    assert.equal((await fetch(`${origin}/connected-account/v1/accounts`, {
      headers: { authorization: `Bearer oat_${"a".repeat(43)}` },
    })).status, 401);
    assert.equal((await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer oat_${"c".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).status, 403);

    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: "Bearer employee-jwt" } },
    });
    const client = new Client({ name: "connected-account-only-http", version: "1.0.0" });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 30);
    assert.deepEqual((await client.callTool({
      name: "amazon_get_identity",
      arguments: { account_id: "acct_0123456789abcdef" },
    })).structuredContent, {
      identity_type: "employee_jwt",
      identity_id: "employee-1",
      role: "employee",
    });
    await client.close();

    const agentTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer oat_${"a".repeat(43)}` } },
    });
    const agentClient = new Client({ name: "test-agent-http", version: "1.0.0" });
    await agentClient.connect(agentTransport);
    assert.deepEqual(
      (await agentClient.callTool({ name: "amazon_get_identity", arguments: {} })).structuredContent,
      {
        identity_type: "test_agent_token",
        identity_id: "diagnostic-agent",
        role: "test_agent",
      },
    );
    assert.deepEqual(
      (await agentClient.callTool({ name: "amazon_list_accounts", arguments: {} })).structuredContent,
      {
        items: [{
          account_id: "acct_0123456789abcdef",
          name: "Agent-visible seller",
          status: "active",
          external_account_id: "A1TESTAGENT",
          capabilities: ["read"],
        }],
      },
    );
    await agentClient.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("records MCP isError responses as tool failures even when HTTP stays 200", async () => {
  const lines: string[] = [];
  const alerts: Array<{
    event: Record<string, unknown>;
    result: string;
    errorCode: string | null;
  }> = [];
  const logger = createStructuredLogger({
    hashKey: "http-tool-failure-test",
    write(line) { lines.push(line); },
  });
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 30,
    logger,
    adminAudits: {
      async record(event, result, errorCode) {
        alerts.push({
          event: event as unknown as Record<string, unknown>,
          result,
          errorCode: errorCode ?? null,
        });
      },
    } as AdminAuditService,
    authenticate: async (token) => token === "employee-jwt" ? principal : null,
    createServer: (authenticated) => createAmazonMcpServer(
      { async get() { return {}; } },
      { principal: authenticated },
    ),
  });
  const { server, origin } = await listen(app);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: "Bearer employee-jwt" } },
    });
    const client = new Client({ name: "tool-failure-logging", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({
      name: "amazon_get_identity",
      arguments: { unexpected: true },
    });
    assert.equal(result.isError, true);
    await client.close();

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const toolRecord = records.find((record) =>
      record.event === "mcp.tool.failed" && record.tool === "amazon_get_identity"
    );
    assert.equal(toolRecord?.result, "error");
    assert.equal(toolRecord?.error_code, "invalid_tool_arguments");
    assert.equal(typeof toolRecord?.request_id, "string");
    const requestRecord = records.find((record) =>
      record.event === "mcp.request.completed"
      && record.request_id === toolRecord?.request_id
    );
    assert.equal(requestRecord?.result, "error");
    assert.equal(requestRecord?.error_code, "invalid_tool_arguments");
    assert.deepEqual(alerts, [{
      event: {
        actorType: "employee_jwt",
        actorId: toolRecord?.actor_id_hash,
        agentRecordId: undefined,
        action: "mcp.tool.failed",
        resourceType: "mcp_tool",
        resourceId: "amazon_get_identity",
        requestId: toolRecord?.request_id,
      },
      result: "failed",
      errorCode: "invalid_tool_arguments",
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("connected-account.enabled=false behavior closes only MCP authentication", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 30,
    authenticate: async () => null,
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
    readinessCheck: async () => ({
      status: "ready",
      checks: { lwa: "ok", tokenStore: "ok", encryptionKey: "ok" },
    }),
  });
  const { server, origin } = await listen(app);
  try {
    assert.equal((await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer anything", "content-type": "application/json" },
      body: "{}",
    })).status, 401);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("readiness has no identity dependency and discovery remains unchanged", async () => {
  const readiness = createRuntimeReadinessCheck({
    lwaConfigured: true,
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    tokenStoreCheck: async () => "ok",
    postgresCheck: async () => "ok",
    redisCheck: async () => "ok",
  });
  assert.deepEqual(await readiness(), {
    status: "ready",
    checks: {
      lwa: "ok",
      tokenStore: "ok",
      encryptionKey: "ok",
      postgres: "ok",
      redis: "ok",
    },
  });

  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 30,
    connected-accountManifest: CONNECTED_ACCOUNT_DISCOVERY_MANIFEST,
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
    readinessCheck: readiness,
  });
  const { server, origin } = await listen(app);
  try {
    assert.deepEqual(await (await fetch(`${origin}/.well-known/connected-account`)).json(), CONNECTED_ACCOUNT_DISCOVERY_MANIFEST);
    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), {
      status: "ok", tools: 30, version: "0.1.0", lwaConfigured: false,
    });
    assert.doesNotMatch(JSON.stringify(await (await fetch(`${origin}/readyz`)).json()), /identity/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("exposes secret-free Amazon integration metadata without a frontend", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 30,
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
    readinessCheck: async () => ({
      status: "ready",
      checks: {
        lwa: "ok",
        tokenStore: "ok",
        encryptionKey: "ok",
        postgres: "ok",
        redis: "ok",
      },
    }),
    portal: {
      publicOrigin: "https://api.example.com",
      version: "0.1.0",
      toolCount: 30,
      connected-accountEnabled: true,
      connected-accountAudience: "amazon-sp-api-account-service",
      connected-accountOrigins: ["https://www.connected-account.me"],
      connected-accountJwtKeys: [{ kid: "provider-v1", issuer: "https://connected-account.example" }],
    },
  });
  const { server, origin } = await listen(app);
  try {
    for (const path of ["/amazon", "/amazon/", "/amazon/assets/app.js"]) {
      assert.equal((await fetch(`${origin}${path}`, { redirect: "manual" })).status, 404, path);
    }

    const config = await fetch(`${origin}/amazon/api/config`);
    assert.equal(config.headers.get("cache-control"), "no-store");
    const body = await config.json();
    assert.deepEqual(body.mcp, {
      transport: "streamable-http",
      url: "https://api.example.com/mcp/amazon",
      headerName: "Authorization",
      headerTemplate: "Bearer <CONNECTED_ACCOUNT_JWT>",
    });
    assert.equal(body.provider.employeeConsoleUrl, "https://www.connected-account.me/employees");
    assert.equal(body.provider.jwtKeys[0].kid, "provider-v1");
    assert.doesNotMatch(JSON.stringify(body), /clientSecret|lwaClient|sellingPartner|credentialKey/i);

    const status = await fetch(`${origin}/amazon/api/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.match(status.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.deepEqual(await status.json(), { status: "ready" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("redacts integration readiness details and fails closed", async () => {
  const readinessChecks = [
    async () => ({
      status: "not_ready" as const,
      checks: {
        lwa: "ok" as const,
        tokenStore: "error" as const,
        encryptionKey: "ok" as const,
        postgres: "error" as const,
        redis: "ok" as const,
      },
    }),
    async () => {
      throw new Error("database detail must remain private");
    },
  ];

  for (const readinessCheck of readinessChecks) {
    const app = createAmazonMcpHttpApp({
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost"],
      version: "0.1.0",
      createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
      readinessCheck,
      portal: {
        publicOrigin: "https://api.example.com",
        version: "0.1.0",
        toolCount: 30,
        connected-accountEnabled: true,
        connected-accountAudience: "amazon-sp-api-account-service",
        connected-accountOrigins: ["https://www.connected-account.me"],
        connected-accountJwtKeys: [{ kid: "provider-v1", issuer: "https://connected-account.example" }],
      },
    });
    const { server, origin } = await listen(app);
    try {
      const response = await fetch(`${origin}/amazon/api/status`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.deepEqual(body, { status: "not_ready" });
      assert.doesNotMatch(
        JSON.stringify(body),
        /checks|lwa|tokenStore|encryptionKey|postgres|redis|database detail/i,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});
