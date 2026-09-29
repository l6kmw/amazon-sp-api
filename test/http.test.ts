import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AdminAuditService } from "../src/admin-audit.js";
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST } from "../src/connected-account.js";
import { createAmazonMcpHttpApp } from "../src/http.js";
import { createStructuredLogger } from "../src/logger.js";
import {
  McpArgumentFileLogger,
  type McpArgumentLogInput,
  type McpArgumentLogger,
} from "../src/mcp-argument-logger.js";
import {
  createRuntimeReadinessCheck,
  productionPostgresPoolConfig,
} from "../src/server.js";
import { createAmazonMcpServer } from "../src/tools.js";

const principal = {
  authType: "employee_jwt" as const,
  tenantId: "jwt-employee:workspace",
  issuer: "https://example.com",
  employeeId: "employee-1",
  kid: "provider-v1",
  expiresAt: "2026-07-28T10:00:00.000Z",
  scopes: new Set(["mcp:invoke"]),
};

test("production PostgreSQL pool has fixed query and connection timeouts", () => {
  assert.deepEqual(productionPostgresPoolConfig({
    databaseUrl: "postgres://service:secret@db.example/amazon",
    postgresPool: { min: 2, max: 12, idleTimeoutMs: 15_000 },
  }), {
    connectionString: "postgres://service:secret@db.example/amazon",
    min: 2,
    max: 12,
    idleTimeoutMillis: 15_000,
    statement_timeout: 40_000,
    query_timeout: 45_000,
    connectionTimeoutMillis: 5_000,
  });
});

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

async function postMcp(
  origin: string,
  body: unknown,
  options: { token: string; requestId: string },
) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-request-id": options.requestId,
    },
    body: JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

test("MCP accepts independent Test Agent and Employee credentials", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    toolCount: 30,
    connectedAccountManifest: CONNECTED_ACCOUNT_DISCOVERY_MANIFEST,
    connectedAccountService: {
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

test("does not enforce the removed Provider request quota", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async (token) => token === "employee-jwt" ? principal : null,
    createServer: (authenticated) => createAmazonMcpServer(
      { async get() { return {}; } },
      { principal: authenticated },
    ),
  });
  const { server, origin } = await listen(app);
  try {
    for (let index = 0; index < 121; index += 1) {
      const result = await postMcp(origin, {
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/list",
      }, {
        token: "employee-jwt",
        requestId: `req_no_provider_limit_${String(index).padStart(3, "0")}`,
      });
      assert.equal(result.response.status, 200, `request ${index + 1}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("records only authenticated tools/call arguments with isolated request IDs", async () => {
  const lines: string[] = [];
  const argumentRecords: McpArgumentLogInput[] = [];
  const argumentLogRoot = await mkdtemp(join(tmpdir(), "amazon-http-argument-log-"));
  const argumentLogDirectory = join(argumentLogRoot, "logs", "mcp-arguments");
  const logger = createStructuredLogger({
    hashKey: "http-argument-log-test",
    write(line) { lines.push(line); },
  });
  const fileLogger = new McpArgumentFileLogger({
    directory: argumentLogDirectory,
    logger,
    now: () => new Date("2026-08-10T06:15:30.000Z"),
  });
  await fileLogger.initialize();
  const argumentLogger: McpArgumentLogger = {
    async log(input) {
      argumentRecords.push(structuredClone(input));
      await fileLogger.log(input);
    },
    async close() { await fileLogger.close(); },
  };
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    logger,
    argumentLogger,
    authenticate: async (token) => token === "employee-jwt" ? principal : null,
    createServer: (authenticated) => createAmazonMcpServer(
      { async get() { return {}; } },
      { principal: authenticated },
    ),
  });
  const { server, origin } = await listen(app);
  const successArguments = { account_id: "acct_0123456789abcdef" };
  const invalidArguments = {
    account_id: "acct_fedcba9876543210",
    nested: { marker: "schema-raw-value" },
    items: [1, null, "raw"],
  };
  try {
    const [success, schemaFailure] = await Promise.all([
      postMcp(origin, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "amazon_get_identity", arguments: successArguments },
      }, { token: "employee-jwt", requestId: "req_argument_success_01" }),
      postMcp(origin, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amazon_get_identity", arguments: invalidArguments },
      }, { token: "employee-jwt", requestId: "req_argument_schema_01" }),
    ]);
    assert.equal(success.response.status, 200);
    assert.match(success.text, /employee_jwt/u);
    assert.equal(success.response.headers.get("x-request-id"), "req_argument_success_01");
    assert.equal(schemaFailure.response.status, 200);
    assert.match(schemaFailure.text, /invalid_tool_arguments/u);
    assert.equal(schemaFailure.response.headers.get("x-request-id"), "req_argument_schema_01");

    assert.deepEqual(
      argumentRecords.toSorted((left, right) => left.requestId.localeCompare(right.requestId)),
      [
        {
          requestId: "req_argument_schema_01",
          tool: "amazon_get_identity",
          actorType: "employee_jwt",
          actorIdHash: logger.hash("employee-1"),
          argumentsPresent: true,
          arguments: invalidArguments,
        },
        {
          requestId: "req_argument_success_01",
          tool: "amazon_get_identity",
          actorType: "employee_jwt",
          actorIdHash: logger.hash("employee-1"),
          argumentsPresent: true,
          arguments: successArguments,
        },
      ],
    );

    const catalog = await postMcp(origin, {
      jsonrpc: "2.0", id: 3, method: "tools/list",
    }, { token: "employee-jwt", requestId: "req_argument_catalog_01" });
    assert.equal(catalog.response.status, 200);
    const rejected = await postMcp(origin, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "amazon_get_identity",
        arguments: { marker: "rejected-auth-raw-value" },
      },
    }, { token: "rejected-bearer-value", requestId: "req_argument_rejected_01" });
    assert.equal(rejected.response.status, 401);
    assert.equal(argumentRecords.length, 2);

    const [explicitNull, missing] = await Promise.all([
      postMcp(origin, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "amazon_get_identity", arguments: null },
      }, { token: "employee-jwt", requestId: "req_argument_null_01" }),
      postMcp(origin, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "amazon_get_identity" },
      }, { token: "employee-jwt", requestId: "req_argument_missing_01" }),
    ]);
    assert.equal(explicitNull.response.status, 200);
    assert.equal(missing.response.status, 200);
    assert.deepEqual(
      argumentRecords.find((record) => record.requestId === "req_argument_null_01"),
      {
        requestId: "req_argument_null_01",
        tool: "amazon_get_identity",
        actorType: "employee_jwt",
        actorIdHash: logger.hash("employee-1"),
        argumentsPresent: true,
        arguments: null,
      },
    );
    assert.deepEqual(
      argumentRecords.find((record) => record.requestId === "req_argument_missing_01"),
      {
        requestId: "req_argument_missing_01",
        tool: "amazon_get_identity",
        actorType: "employee_jwt",
        actorIdHash: logger.hash("employee-1"),
        argumentsPresent: false,
        arguments: undefined,
      },
    );

    const firstBatchArguments = { account_id: "acct_batch000000000001" };
    const secondBatchArguments = { account_id: "acct_batch000000000002" };
    const batch = await postMcp(origin, [
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "amazon_get_identity", arguments: firstBatchArguments },
      },
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "amazon_get_identity", arguments: secondBatchArguments },
      },
    ], { token: "employee-jwt", requestId: "req_argument_batch_01" });
    assert.equal(batch.response.status, 200);
    const batchRecords = argumentRecords.filter((record) =>
      record.requestId === "req_argument_batch_01");
    assert.equal(batchRecords.length, 2);
    assert.deepEqual(
      batchRecords.map((record) => record.arguments).toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))),
      [firstBatchArguments, secondBatchArguments],
    );
    assert.ok(batchRecords.every((record) =>
      record.tool === "amazon_get_identity"
      && record.actorType === "employee_jwt"
      && record.actorIdHash === logger.hash("employee-1")
      && record.argumentsPresent));

    const argumentFile = await readFile(
      join(argumentLogDirectory, "mcp-arguments-2026-08-10T06.jsonl"),
      "utf8",
    );
    assert.match(argumentFile, /schema-raw-value|acct_batch000000000001/u);
    assert.doesNotMatch(
      argumentFile,
      /employee-jwt|rejected-bearer-value|rejected-auth-raw-value/u,
    );

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.some((record) =>
      record.event === "mcp.tool.completed"
      && record.request_id === "req_argument_success_01"
    ));
    assert.ok(records.some((record) =>
      record.event === "mcp.tool.failed"
      && record.request_id === "req_argument_schema_01"
    ));
    assert.doesNotMatch(
      lines.join("\n"),
      /acct_0123456789abcdef|acct_fedcba9876543210|acct_batch00000000000[12]|schema-raw-value|rejected-auth-raw-value|employee-jwt|rejected-bearer-value/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await argumentLogger.close();
    await rm(argumentLogRoot, { recursive: true, force: true });
  }
});

test("does not record tools/call arguments rejected by access gates", async () => {
  const lines: string[] = [];
  const argumentRecords: McpArgumentLogInput[] = [];
  const logger = createStructuredLogger({
    hashKey: "http-argument-log-gate-test",
    write(line) { lines.push(line); },
  });
  const argumentLogger: McpArgumentLogger = {
    async log(input) { argumentRecords.push(structuredClone(input)); },
    async close() {},
  };
  const principals: Record<string, typeof principal> = {
    "scope-token": { ...principal, employeeId: "scope-employee", scopes: new Set() },
    "tenant-token": { ...principal, employeeId: "tenant-employee", tenantId: "" },
  };
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    logger,
    argumentLogger,
    authenticate: async (token) => principals[token] ?? null,
    createServer: () => { throw new Error("access gate must stop the request"); },
  });
  const { server, origin } = await listen(app);
  try {
    const cases = [
      { token: "scope-token", requestId: "req_argument_scope_01", status: 403 },
      { token: "tenant-token", requestId: "req_argument_tenant_01", status: 403 },
    ];
    for (const item of cases) {
      const result = await postMcp(origin, {
        jsonrpc: "2.0",
        id: item.requestId,
        method: "tools/call",
        params: {
          name: "amazon_get_identity",
          arguments: { marker: `${item.token}-raw-arguments` },
        },
      }, { token: item.token, requestId: item.requestId });
      assert.equal(result.response.status, item.status, item.requestId);
    }
    assert.deepEqual(argumentRecords, []);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      records.map((record) => record.event),
      ["mcp.scope.rejected", "mcp.tenant.rejected"],
    );
    assert.doesNotMatch(
      lines.join("\n"),
      /scope-token|tenant-token|raw-arguments/u,
    );
  } finally {
    await argumentLogger.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("keeps tools/call available when argument logging rejects", async () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "http-argument-log-failure-test",
    write(line) { lines.push(line); },
  });
  const argumentLogger: McpArgumentLogger = {
    async log() { throw new Error("disk unavailable"); },
    async close() {},
  };
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    logger,
    argumentLogger,
    authenticate: async (token) => token === "employee-jwt" ? principal : null,
    createServer: (authenticated) => createAmazonMcpServer(
      { async get() { return {}; } },
      { principal: authenticated },
    ),
  });
  const { server, origin } = await listen(app);
  try {
    const result = await postMcp(origin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "amazon_get_identity",
        arguments: { account_id: "acct_abcdef0123456789" },
      },
    }, { token: "employee-jwt", requestId: "req_argument_disk_failure_01" });
    assert.equal(result.response.status, 200);
    assert.match(result.text, /employee_jwt/u);

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const failure = records.find((record) => record.event === "mcp.argument_log.failed");
    assert.equal(failure?.request_id, "req_argument_disk_failure_01");
    assert.equal(failure?.tool, "amazon_get_identity");
    assert.equal(failure?.actor_type, "employee_jwt");
    assert.equal(failure?.actor_id_hash, logger.hash("employee-1"));
    assert.equal(failure?.result, "error");
    assert.equal(failure?.error_code, "internal_error");
    assert.doesNotMatch(lines.join("\n"), /acct_abcdef0123456789|employee-jwt|disk unavailable/u);
  } finally {
    await argumentLogger.close();
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

test("connectedAccount.enabled=false behavior closes only MCP authentication", async () => {
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
    connectedAccountManifest: CONNECTED_ACCOUNT_DISCOVERY_MANIFEST,
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
      connectedAccountEnabled: true,
      connectedAccountAudience: "amazon-sp-api-account-service",
      connectedAccountOrigins: ["https://www.connectedaccount.me"],
      connectedAccountJwtKeys: [{ kid: "provider-v1", issuer: "https://example.com" }],
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
    assert.equal(body.provider.employeeConsoleUrl, "https://www.connectedaccount.me/employees");
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

test("serves the public privacy policy without authentication", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async () => {
      throw new Error("privacy route must not authenticate");
    },
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
  });
  const { server, origin } = await listen(app);
  try {
    const response = await fetch(`${origin}/privacy`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /Privacy Policy/u);
    assert.match(body, /support@connected-account\.com/u);
    assert.match(body, /encrypted refresh tokens/u);
    assert.match(body, /does not sell Amazon data/u);
    assert.doesNotMatch(body, /(?:client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["'][^"']+/iu);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("serves the public company profile without authentication or JavaScript", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async () => {
      throw new Error("company route must not authenticate");
    },
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
  });
  const { server, origin } = await listen(app);
  try {
    const response = await fetch(`${origin}/company`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /深圳市旧实现智能科技有限公司/u);
    assert.match(body, /91440300MAKFW2Q969/u);
    assert.match(body, /Amazon Ads API integrations/u);
    assert.match(body, /support@connected-account\.com/u);
    assert.doesNotMatch(body, /<script\s+[^>]*src=/iu);
    assert.doesNotMatch(body, /(?:client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["'][^"']+/iu);
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
        connectedAccountEnabled: true,
        connectedAccountAudience: "amazon-sp-api-account-service",
        connectedAccountOrigins: ["https://www.connectedaccount.me"],
        connectedAccountJwtKeys: [{ kid: "provider-v1", issuer: "https://example.com" }],
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
