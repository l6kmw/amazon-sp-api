import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";

import { Pool } from "pg";

import { ConnectedAccountAccountError, type ConnectedAccountPrincipal } from "../src/connected-account-accounts.js";
import { PostgresConnectedAccountAccountStore } from "../src/postgres-connected-account-accounts.js";
import { PostgresRefreshTokenStore } from "../src/postgres-token-store.js";

const databaseUrl = process.env.TEST_MCP_DATABASE_URL;
const encryptionKey = Buffer.alloc(32, 7);

function principal(employeeId: string): ConnectedAccountPrincipal {
  return {
    authType: "connected-account",
    tenantId: `jwt-employee:example-issuer-prod:${employeeId}`,
    issuer: "example-issuer-prod",
    employeeId,
    kid: "provider-v1",
    expiresAt: "2026-07-22T01:05:00.000Z",
    scopes: new Set(["connected_accounts:manage", "mcp:invoke"]),
  };
}

function encrypted(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

test("shares ConnectedAccount ownership and encrypted tokens through PostgreSQL", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
  const completions = new Map<string, { sellingPartnerId: string; authorizedAt: string }>();
  const oauth = {
    async createConnectedAccountAuthorizationURL(_tenantId: string, attemptId: string) {
      return `https://api.example.com/oauth/amazon/start?intent=${attemptId}`;
    },
    async getConnectedAccountAuthorizationCompletion(_tenantId: string, attemptId: string) {
      return completions.get(attemptId) ?? null;
    },
    async listConnections() {
      return [{ sellingPartnerId: "A1POSTGRES", authorizedAt: "2026-07-22T01:01:00.000Z" }];
    },
  };
  const first = new PostgresConnectedAccountAccountStore({
    databaseUrl,
    oauth,
    authorizationOrigin: "https://app.connected-account.example",
    now: () => new Date("2026-07-22T01:00:00.000Z"),
  });
  const second = new PostgresConnectedAccountAccountStore({
    databaseUrl,
    oauth,
    authorizationOrigin: "https://app.connected-account.example",
    now: () => new Date("2026-07-22T01:00:00.000Z"),
  });
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const employee = principal("employee-1");
    const attempt = await first.createAuthorizationAttempt(employee);
    completions.set(attempt.attemptId, {
      sellingPartnerId: "A1POSTGRES",
      authorizedAt: "2026-07-22T01:01:00.000Z",
    });
    const [left, right] = await Promise.all([
      first.getAuthorizationAttempt(employee, attempt.attemptId),
      second.getAuthorizationAttempt(employee, attempt.attemptId),
    ]);
    assert.equal(left.status, "active");
    assert.equal(right.status, "active");
    assert.equal(left.connection?.connectionId, right.connection?.connectionId);
    assert.deepEqual((await admin.query(`
      SELECT
        (SELECT count(*)::int FROM amazon_sp_api.external_account_credential) AS accounts,
        (SELECT count(*)::int FROM amazon_sp_api.connection_grant) AS grants
    `)).rows[0], { accounts: 1, grants: 1 });

    const connectionId = left.connection!.connectionId;
    const accountId = left.connection!.metadata.account_id;
    await first.bindAccount(employee, connectionId);
    assert.equal(
      (await second.resolveAccount(employee, accountId)).externalAccountId,
      "A1POSTGRES",
    );
    await assert.rejects(
      second.resolveAccount(principal("employee-2"), accountId),
      (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
    );
    await second.unbindAccount(employee, connectionId);
    await assert.rejects(
      first.resolveAccount(employee, accountId),
      (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
    );

    await admin.query(`
      CREATE TABLE amazon_sp_api.oauth_connection (
        selling_partner_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        refresh_token JSONB,
        status TEXT NOT NULL
      )
    `);
    await admin.query(`
      INSERT INTO amazon_sp_api.oauth_connection
        (selling_partner_id, tenant_id, refresh_token, status)
      VALUES ($1, $2, $3, 'active')
    `, ["A1POSTGRES", employee.tenantId, encrypted("refresh-token")]);
    const tokens = new PostgresRefreshTokenStore({
      databaseUrl,
      encryptionKey: encryptionKey.toString("base64"),
      allowedSellingPartnerIds: ["A1POSTGRES"],
    });
    try {
      assert.equal(
        await tokens.getRefreshToken("A1POSTGRES", employee.tenantId),
        "refresh-token",
      );
      await assert.rejects(
        tokens.getRefreshToken("A1POSTGRES", "another-tenant"),
        (error: unknown) => (error as { code?: string }).code === "SELLER_FORBIDDEN",
      );
      assert.equal(await tokens.checkHealth(), "ok");
    } finally {
      await tokens.close();
    }
  } finally {
    await first.close();
    await second.close();
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});
