import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { migratePostgres, POSTGRES_SCHEMA_VERSION } from "../src/postgres-migrations.js";

function fakePool(options: {
  applied?: Array<{ version: number; name: string }>;
  failMigration?: boolean;
} = {}) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, ...(values ? { values } : {}) });
      if (text.includes("SELECT version, name FROM")) {
        return { rows: options.applied ?? [] };
      }
      if (options.failMigration && text.includes("CREATE TABLE IF NOT EXISTS amazon_sp_api.oauth_connection")) {
        throw new Error("migration failed");
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  return {
    pool: { async connect() { return client; } } as unknown as Pool,
    queries,
  };
}

test("runs pending PostgreSQL migrations once in a transaction", async () => {
  const first = fakePool();
  await migratePostgres(first.pool);
  assert.equal(POSTGRES_SCHEMA_VERSION, 3);
  assert.equal(first.queries[0]?.text, "BEGIN");
  assert.ok(first.queries.some(({ text }) => text.includes("pg_advisory_xact_lock")));
  assert.deepEqual(
    first.queries
      .filter(({ text }) => text.includes("INSERT INTO amazon_sp_api.schema_migration"))
      .map(({ values }) => values),
    [
      [1, "baseline_oauth_and_connected_accounts"],
      [2, "expand_control_plane_and_account_lifecycle"],
      [3, "allow_independent_seller_credentials"],
    ],
  );
  const expand = first.queries.find(({ text }) => text.includes("CREATE TABLE amazon_sp_api.app_user"))?.text ?? "";
  assert.match(expand, /CREATE TABLE amazon_sp_api\.app_agent/);
  assert.match(expand, /CREATE TABLE amazon_sp_api\.audit_log/);
  assert.match(expand, /CREATE TABLE amazon_sp_api\.amazon_account/);
  assert.match(expand, /UNIQUE \(provider_key, issuer_scope, selling_partner_id\)/);
  assert.match(expand, /CREATE TABLE amazon_sp_api\.amazon_credential/);
  assert.match(expand, /encrypted_refresh_token JSONB/);
  assert.match(expand, /CHECK \(status <> 'active' OR encrypted_refresh_token IS NOT NULL\)/);
  assert.doesNotMatch(expand, /\n\s+refresh_token\s/);
  const independentCredentials = first.queries.find(({ text }) => text.includes("DROP CONSTRAINT oauth_connection_pkey"))?.text ?? "";
  assert.match(independentCredentials, /PRIMARY KEY \(selling_partner_id, tenant_id\)/);
  assert.equal(first.queries.at(-1)?.text, "COMMIT");

  const second = fakePool({
    applied: [
      { version: 1, name: "baseline_oauth_and_connected_accounts" },
      { version: 2, name: "expand_control_plane_and_account_lifecycle" },
      { version: 3, name: "allow_independent_seller_credentials" },
    ],
  });
  await migratePostgres(second.pool);
  assert.equal(
    second.queries.some(({ text }) => text.includes("CREATE TABLE IF NOT EXISTS amazon_sp_api.oauth_connection")),
    false,
  );
  assert.equal(
    second.queries.some(({ text }) => text.includes("CREATE TABLE amazon_sp_api.app_user")),
    false,
  );
});

test("rolls back failed or divergent PostgreSQL migrations", async () => {
  const failed = fakePool({ failMigration: true });
  await assert.rejects(migratePostgres(failed.pool), /migration failed/);
  assert.equal(failed.queries.at(-1)?.text, "ROLLBACK");

  const divergent = fakePool({ applied: [{ version: 1, name: "unexpected" }] });
  await assert.rejects(migratePostgres(divergent.pool), /history diverges/);
  assert.equal(divergent.queries.at(-1)?.text, "ROLLBACK");
});
