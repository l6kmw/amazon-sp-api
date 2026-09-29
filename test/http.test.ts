import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createAmazonMcpHttpApp } from "../src/http.js";
import { createStructuredLogger } from "../src/logger.js";
import {
  McpArgumentFileLogger,
  type McpArgumentLogInput,
  type McpArgumentLogger,
} from "../src/mcp-argument-logger.js";
import { createRuntimeReadinessCheck } from "../src/server.js";
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
      authenticated: false,
    });
    assert.equal(body.accounts.listUrl, "https://api.example.com/api/v1/accounts");
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
    assert.match(body, /\{\{OPERATOR_EMAIL\}\}/u);
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
    assert.match(body, /\{\{OPERATOR_LEGAL_NAME\}\}/u);
    assert.match(body, /\{\{OPERATOR_REGISTRATION_ID\}\}/u);
    assert.match(body, /Amazon Ads API integrations/u);
    assert.match(body, /\{\{OPERATOR_EMAIL\}\}/u);
    assert.doesNotMatch(body, /<script\s+[^>]*src=/iu);
    assert.doesNotMatch(body, /(?:client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["'][^"']+/iu);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("renders operator details into legal pages when configured", async () => {
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    authenticate: async () => {
      throw new Error("company route must not authenticate");
    },
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
    operator: {
      name: "Example Operator",
      legalName: "示例运营主体有限公司",
      legalNameEn: "Example Operator Ltd.",
      url: "https://operator.example.com",
      email: "privacy@operator.example.com",
      siteUrl: "https://api.operator.example.com",
      initial: "E",
    },
  });
  const { server, origin } = await listen(app);
  try {
    const response = await fetch(`${origin}/company`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Example Operator/u);
    assert.match(body, /示例运营主体有限公司/u);
    assert.match(body, /privacy@operator\.example\.com/u);
    assert.match(body, /https:\/\/operator\.example\.com/u);
    // operator-supplied placeholders are substituted; ones the operator did not
    // supply stay literal rather than borrowing another company's values
    assert.match(body, /\{\{OPERATOR_REGISTRATION_ID\}\}/u);
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
