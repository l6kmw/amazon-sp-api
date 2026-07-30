import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import express from "express";
import { Pool } from "pg";

import { PostgresAccountAccessPolicy } from "../src/account-access-policy.js";
import { registerAdminAccountRoutes } from "../src/admin-accounts.js";
import { AdminAgentService, registerAdminAgentRoutes } from "../src/admin-agents.js";
import { AdminAuditService, registerAdminAuditRoutes } from "../src/admin-audit.js";
import { initializeAdmin, verifyAdminPassword } from "../src/admin-auth.js";
import { registerAdminDashboardRoutes } from "../src/admin-dashboard.js";
import { AdminSessionManager } from "../src/admin-session.js";
import { ConnectedAccountAccountError, type ConnectedAccountPrincipal } from "../src/connected-account-accounts.js";
import { createAmazonAuthenticator } from "../src/identity.js";
import { backfillPostgresAccountLifecycle } from "../src/postgres-backfill.js";
import { PostgresConnectedAccountAccountStore } from "../src/postgres-connected-account-accounts.js";
import { migratePostgres } from "../src/postgres-migrations.js";
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
  const disconnected: Array<{ tenantId: string; sellingPartnerId: string }> = [];
  const authorizationOrigins: string[] = [];
  const oauth = {
    async createConnectedAccountAuthorizationURL(_tenantId: string, attemptId: string, origin: string) {
      authorizationOrigins.push(origin);
      return `https://api.example.com/oauth/amazon/start?intent=${attemptId}`;
    },
    async cancelAuthorizationURL() {},
    async getConnectedAccountAuthorizationCompletion(_tenantId: string, attemptId: string) {
      return completions.get(attemptId) ?? null;
    },
    async listConnections() {
      return [{ sellingPartnerId: "A1POSTGRES", authorizedAt: "2026-07-22T01:01:00.000Z" }];
    },
    async disconnectIfPresent(tenantId: string, sellingPartnerId: string) {
      disconnected.push({ tenantId, sellingPartnerId });
      return true;
    },
  };
  const first = new PostgresConnectedAccountAccountStore({
    databaseUrl,
    oauth,
    authorizationOrigin: "https://app.connected-account.example",
    adminAuthorizationOrigin: "https://admin.amazon.example",
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
    const adminClient = await admin.connect();
    try {
      await adminClient.query("BEGIN");
      const adminAttempt = await first.adminCreateAuthorizationAttempt(
        employee.issuer,
        employee.employeeId,
        "admin",
        adminClient,
      );
      await adminClient.query("COMMIT");
      assert.equal(adminAttempt.status, "pending");
      assert.equal(authorizationOrigins.at(-1), "https://admin.amazon.example");
      assert.deepEqual((await admin.query(`
        SELECT started_by_type, started_by_id, issuer_scope, employee_id
        FROM amazon_sp_api.authorization_attempt WHERE attempt_id = $1
      `, [adminAttempt.attemptId])).rows[0], {
        started_by_type: "admin",
        started_by_id: "admin",
        issuer_scope: employee.issuer,
        employee_id: employee.employeeId,
      });
      await adminClient.query("BEGIN");
      assert.equal(
        (await first.adminGetAuthorizationAttempt(adminAttempt.attemptId, null, adminClient)).attemptId,
        adminAttempt.attemptId,
      );
      await adminClient.query("COMMIT");
      await adminClient.query("BEGIN");
      await assert.rejects(
        first.adminCreateAuthorizationAttempt(employee.issuer, "unknown-employee", "admin", adminClient),
        (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
      );
      await adminClient.query("ROLLBACK");
    } finally {
      adminClient.release();
    }
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
    const encryptedToken = encrypted("refresh-token");
    await admin.query(`
      INSERT INTO amazon_sp_api.oauth_connection
        (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
         status, created_at, updated_at)
      VALUES ($1, $2, NOW(), $3, 'bearer', 'active', NOW(), NOW())
    `, ["A1POSTGRES", employee.tenantId, encryptedToken]);
    const backfill = await backfillPostgresAccountLifecycle(admin, (sellingPartnerId, token) => {
      assert.equal(sellingPartnerId, "A1POSTGRES");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(token.iv, "base64"));
      decipher.setAuthTag(Buffer.from(token.tag, "base64"));
      assert.equal(
        Buffer.concat([
          decipher.update(Buffer.from(token.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8"),
        "refresh-token",
      );
    });
    assert.deepEqual(backfill, { accounts: 1, credentials: 1, activeBindings: 1 });
    assert.deepEqual(await backfillPostgresAccountLifecycle(admin, () => {
      throw new Error("completed backfill must not re-read credentials");
    }), backfill);
    const migrated = (await admin.query(`
      SELECT a.account_id, a.selling_partner_id, c.encrypted_refresh_token,
             g.credential_id, b.account_id AS binding_account_id, b.workspace_tenant_id
      FROM amazon_sp_api.amazon_account a
      JOIN amazon_sp_api.amazon_credential c ON c.account_id = a.account_id
      JOIN amazon_sp_api.connection_grant g ON g.account_id = a.account_id
      JOIN amazon_sp_api.employee_account_binding b
        ON b.issuer = g.issuer AND b.connection_id = g.connection_id
    `)).rows[0];
    assert.equal(migrated.account_id, accountId);
    assert.equal(migrated.selling_partner_id, "A1POSTGRES");
    assert.deepEqual(migrated.encrypted_refresh_token, encryptedToken);
    assert.equal(migrated.credential_id, `cred_${accountId}`);
    assert.equal(migrated.binding_account_id, accountId);
    assert.equal(migrated.workspace_tenant_id, employee.tenantId);

    const sharedEmployee = principal("employee-2");
    const unboundEmployee = principal("employee-3");
    assert.equal((await first.shareAccount(employee, connectionId, sharedEmployee)).created, true);
    assert.equal((await first.shareAccount(employee, connectionId, sharedEmployee)).created, false);
    assert.equal(
      (await first.updateRemark(sharedEmployee, connectionId, "共享员工")).remark,
      "共享员工",
    );
    assert.equal((await second.resolveAccount(sharedEmployee, accountId)).externalAccountId, "A1POSTGRES");
    assert.equal((await second.resolveAccount(employee, accountId)).remark, undefined);
    assert.equal((await second.refreshAccounts(sharedEmployee))[0]?.remark, "共享员工");
    await assert.rejects(
      second.resolveAccount(unboundEmployee, accountId),
      (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
    );
    await second.unbindAccount(sharedEmployee, connectionId);
    assert.equal((await first.resolveAccount(employee, accountId)).externalAccountId, "A1POSTGRES");
    assert.equal((await first.listAccounts(sharedEmployee)).length, 0);
    const bindingClient = await admin.connect();
    try {
      await bindingClient.query("BEGIN");
      assert.equal((await first.adminShareAccount(
        employee.issuer, sharedEmployee.employeeId, connectionId, bindingClient,
      )).created, true);
      await bindingClient.query("COMMIT");
      assert.equal((await first.resolveAccount(sharedEmployee, accountId)).externalAccountId, "A1POSTGRES");
      await bindingClient.query("BEGIN");
      await first.adminUnshareAccount(
        employee.issuer, sharedEmployee.employeeId, connectionId, bindingClient,
      );
      await bindingClient.query("COMMIT");
      assert.equal((await first.listAccounts(sharedEmployee)).length, 0);
      await bindingClient.query("BEGIN");
      await assert.rejects(
        first.adminUnshareAccount(employee.issuer, employee.employeeId, connectionId, bindingClient),
        (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
      );
      await bindingClient.query("ROLLBACK");
    } finally {
      bindingClient.release();
    }
    await first.shareAccount(employee, connectionId, sharedEmployee);
    await assert.rejects(
      first.shareAccount(employee, connectionId, {
        ...sharedEmployee, issuer: "another-issuer",
      }),
      (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
    );
    await assert.rejects(
      second.disconnect(sharedEmployee, connectionId),
      (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
    );
    await Promise.all([
      first.disconnect(employee, connectionId),
      second.disconnect(employee, connectionId),
    ]);
    assert.deepEqual(disconnected, [
      { tenantId: employee.tenantId, sellingPartnerId: "A1POSTGRES" },
      { tenantId: employee.tenantId, sellingPartnerId: "A1POSTGRES" },
    ]);
    for (const actor of [employee, sharedEmployee]) {
      await assert.rejects(
        first.resolveAccount(actor, accountId),
        (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
      );
    }
    const tokens = new PostgresRefreshTokenStore({
      databaseUrl,
      encryptionKey: encryptionKey.toString("base64"),
      allowedSellingPartnerIds: ["A1POSTGRES"],
    });
    try {
      await tokens.initialize();
      assert.equal(
        await tokens.getRefreshToken("A1POSTGRES", employee.tenantId),
        "refresh-token",
      );
      await assert.rejects(
        tokens.getRefreshToken("A1POSTGRES", "another-tenant"),
        (error: unknown) => (error as { code?: string }).code === "SELLER_FORBIDDEN",
      );
      await tokens.save("A1POSTGRES", employee.tenantId, { refresh_token: "reauthorized-token" });
      assert.match(
        (await tokens.getRefreshCredential("A1POSTGRES", employee.tenantId)).credentialId ?? "",
        /^(cred_|legacy:)/,
      );
      assert.equal(
        (await tokens.getRefreshCredential("A1POSTGRES", employee.tenantId)).refreshToken,
        "reauthorized-token",
      );
      assert.equal(
        (await tokens.getRefreshCredential("A1POSTGRES", employee.tenantId)).revision,
        2,
      );
      assert.equal(await tokens.compareAndSetRefreshToken({
        sellingPartnerId: "A1POSTGRES",
        tenantId: employee.tenantId,
        expectedRevision: 2,
        newRefreshToken: "rotated-token",
      }), "updated");
      const rotated = await tokens.getRefreshCredential("A1POSTGRES", employee.tenantId);
      assert.equal(rotated.refreshToken, "rotated-token");
      assert.equal(rotated.revision, 3);
      assert.equal(rotated.credentialOwnerId, employee.tenantId);
      assert.equal(await tokens.compareAndSetRefreshToken({
        sellingPartnerId: "A1POSTGRES",
        tenantId: employee.tenantId,
        expectedRevision: 2,
        newRefreshToken: "stale-token",
      }), "conflict");
      assert.deepEqual((await admin.query(`
        SELECT o.credential_revision AS old_revision,
               c.refresh_token_revision AS new_revision,
               o.refresh_token = c.encrypted_refresh_token AS same_envelope
        FROM amazon_sp_api.oauth_connection o
        JOIN amazon_sp_api.external_account_credential legacy
          ON legacy.external_account_id = o.selling_partner_id
         AND legacy.owner_workspace_id = o.tenant_id
        JOIN amazon_sp_api.amazon_credential c ON c.account_id = legacy.account_id
        WHERE o.selling_partner_id = 'A1POSTGRES'
      `)).rows[0], { old_revision: "3", new_revision: "3", same_envelope: true });
      assert.equal(await tokens.disconnect(employee.tenantId, "A1POSTGRES"), true);
      assert.deepEqual((await admin.query(`
        SELECT o.status AS old_status, o.refresh_token IS NULL AS old_cleared,
               c.status AS new_status, c.encrypted_refresh_token IS NULL AS new_cleared
        FROM amazon_sp_api.oauth_connection o
        JOIN amazon_sp_api.external_account_credential legacy
          ON legacy.external_account_id = o.selling_partner_id
         AND legacy.owner_workspace_id = o.tenant_id
        JOIN amazon_sp_api.amazon_credential c ON c.account_id = legacy.account_id
        WHERE o.selling_partner_id = 'A1POSTGRES'
      `)).rows[0], {
        old_status: "disconnected",
        old_cleared: true,
        new_status: "revoked",
        new_cleared: true,
      });
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

test("completes admin-started OAuth as an Employee-owned bound grant", {
  skip: !databaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await pool.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
  await migratePostgres(pool);
  const owner = principal("admin-selected-owner");
  const completions = new Map<string, { sellingPartnerId: string; authorizedAt: string }>();
  const store = new PostgresConnectedAccountAccountStore({
    pool,
    authorizationOrigin: "https://app.connected-account.example",
    adminAuthorizationOrigin: "https://admin.amazon.example",
    oauth: {
      async createConnectedAccountAuthorizationURL(_tenantId: string, attemptId: string) {
        return `https://api.example.com/oauth/amazon/start?intent=${attemptId}`;
      },
      async cancelAuthorizationURL() {},
      async getConnectedAccountAuthorizationCompletion(_tenantId: string, attemptId: string) {
        return completions.get(attemptId) ?? null;
      },
      async listConnections() { return []; },
      async disconnectIfPresent() { return true; },
    },
    now: () => new Date("2026-07-30T01:00:00.000Z"),
  });
  try {
    await pool.query(`
      INSERT INTO amazon_sp_api.employee_registry
        (issuer, employee_id, workspace_id, first_seen_at, last_seen_at)
      VALUES ($1, $2, $3, NOW(), NOW())
    `, [owner.issuer, owner.employeeId, owner.tenantId]);
    await pool.query(`
      INSERT INTO amazon_sp_api.oauth_connection
        (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
         status, created_at, updated_at)
      VALUES ('A1ADMINOAUTH', $1, NOW(), $2, 'bearer', 'active', NOW(), NOW())
    `, [owner.tenantId, encrypted("admin-refresh-token")]);
    const createClient = await pool.connect();
    let attemptId: string;
    try {
      await createClient.query("BEGIN");
      attemptId = (await store.adminCreateAuthorizationAttempt(
        owner.issuer,
        owner.employeeId,
        "admin",
        createClient,
      )).attemptId;
      await createClient.query("COMMIT");
    } finally {
      createClient.release();
    }
    completions.set(attemptId, {
      sellingPartnerId: "A1ADMINOAUTH",
      authorizedAt: "2026-07-30T01:01:00.000Z",
    });
    const completion = await store.pollAdminAuthorizationCompletion(attemptId);
    const completeClient = await pool.connect();
    try {
      await completeClient.query("BEGIN");
      const completed = await store.adminGetAuthorizationAttempt(attemptId, completion, completeClient);
      await completeClient.query("COMMIT");
      assert.equal(completed.status, "active");
      assert.ok(completed.connection);
    } finally {
      completeClient.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT g.authorized_by_type, g.authorized_by_id, g.owner_employee_id,
             b.employee_id, b.workspace_id, b.status AS binding_status
      FROM amazon_sp_api.connection_grant g
      JOIN amazon_sp_api.employee_account_binding b
        ON b.issuer = g.issuer AND b.connection_id = g.connection_id
    `)).rows[0], {
      authorized_by_type: "admin",
      authorized_by_id: "admin",
      owner_employee_id: owner.employeeId,
      employee_id: owner.employeeId,
      workspace_id: owner.tenantId,
      binding_status: "active",
    });
    assert.equal((await store.listAccounts(owner)).length, 1);
  } finally {
    await pool.end();
  }
});

test("reuses one issuer-scoped account while isolating owner credentials", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const completions = new Map<string, { sellingPartnerId: string; authorizedAt: string }>();
  const oauth = {
    async createConnectedAccountAuthorizationURL(_tenantId: string, attemptId: string) {
      return `https://api.example.com/oauth/amazon/start?intent=${attemptId}`;
    },
    async cancelAuthorizationURL() {},
    async getConnectedAccountAuthorizationCompletion(_tenantId: string, attemptId: string) {
      return completions.get(attemptId) ?? null;
    },
    async listConnections() { return []; },
    async disconnectIfPresent(tenantId: string, sellingPartnerId: string) {
      return tokens.disconnect(tenantId, sellingPartnerId);
    },
  };
  const invalidated: Array<{
    credentialId: string;
    revision: number;
    credentialOwnerId: string;
    sellingPartnerId: string;
  }> = [];
  const accounts = new PostgresConnectedAccountAccountStore({
    databaseUrl,
    oauth,
    authorizationOrigin: "https://app.connected-account.example",
    invalidateCredential(credentialId, revision, credentialOwnerId, sellingPartnerId) {
      invalidated.push({ credentialId, revision, credentialOwnerId, sellingPartnerId });
    },
  });
  const tokens = new PostgresRefreshTokenStore({
    databaseUrl,
    encryptionKey: encryptionKey.toString("base64"),
    allowedSellingPartnerIds: ["A1INDEPENDENT"],
  });
  try {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await accounts.initialize();
    await tokens.initialize();
    const owners = [principal("owner-a"), principal("owner-b")];
    const completed: Awaited<ReturnType<typeof accounts.getAuthorizationAttempt>>[] = [];
    for (const [index, owner] of owners.entries()) {
      const attempt = await accounts.createAuthorizationAttempt(owner);
      await tokens.save("A1INDEPENDENT", owner.tenantId, {
        refresh_token: `refresh-${index + 1}`,
      }, { connected-accountAttemptId: attempt.attemptId });
      completions.set(attempt.attemptId, {
        sellingPartnerId: "A1INDEPENDENT",
        authorizedAt: "2026-07-22T01:01:00.000Z",
      });
      completed.push(await accounts.getAuthorizationAttempt(owner, attempt.attemptId));
    }
    assert.equal(completed[0]!.connection!.metadata.account_id, completed[1]!.connection!.metadata.account_id);
    assert.notEqual(completed[0]!.connection!.connectionId, completed[1]!.connection!.connectionId);
    assert.deepEqual((await admin.query(`
      SELECT
        (SELECT count(*)::int FROM amazon_sp_api.amazon_account) AS accounts,
        (SELECT count(*)::int FROM amazon_sp_api.amazon_credential) AS credentials,
        (SELECT count(*)::int FROM amazon_sp_api.connection_grant) AS grants,
        (SELECT count(*)::int FROM amazon_sp_api.oauth_connection) AS oauth_rows
    `)).rows[0], { accounts: 1, credentials: 2, grants: 2, oauth_rows: 2 });
    assert.equal(await tokens.getRefreshToken("A1INDEPENDENT", owners[0]!.tenantId), "refresh-1");
    assert.equal(await tokens.getRefreshToken("A1INDEPENDENT", owners[1]!.tenantId), "refresh-2");

    const sharedEmployee = principal("shared-employee");
    const ownerAConnection = completed[0]!.connection!.connectionId;
    await accounts.shareAccount(owners[0]!, ownerAConnection, sharedEmployee);
    const policy = new PostgresAccountAccessPolicy(admin);
    const ownerACredential = await tokens.getRefreshCredential(
      "A1INDEPENDENT",
      sharedEmployee.tenantId,
    );
    assert.equal(ownerACredential.refreshToken, "refresh-1");
    assert.equal(ownerACredential.credentialOwnerId, owners[0]!.tenantId);
    assert.match(ownerACredential.credentialId ?? "", /^cred_/);
    assert.equal(
      (await policy.resolveAccount(sharedEmployee, completed[0]!.connection!.metadata.account_id))
        .credentialOwnerId,
      owners[0]!.tenantId,
    );
    await assert.rejects(
      policy.resolveAccount(principal("unbound-employee"), completed[0]!.connection!.metadata.account_id),
      (error: unknown) => error instanceof ConnectedAccountAccountError && error.status === 404,
    );
    const testAgent = {
      authType: "test_agent" as const,
      credentialKind: "test_agent_token" as const,
      tenantId: "tenant-1" as const,
      agentRecordId: "agent_record_policy",
      agentId: "policy-agent",
      scopes: new Set(["mcp:invoke"]),
    };
    assert.equal((await policy.listAccounts(testAgent)).length, 1);
    const selectedForAgent = await policy.resolveAccount(
      testAgent,
      completed[0]!.connection!.metadata.account_id,
    );
    assert.ok(owners.some((owner) => owner.tenantId === selectedForAgent.credentialOwnerId));

    await admin.query(`
      INSERT INTO amazon_sp_api.app_user (id, username)
      VALUES ('tenant-1', 'admin-disconnect-test')
      ON CONFLICT (id) DO NOTHING
    `);
    const disconnectAudits = new AdminAuditService(admin);
    await disconnectAudits.run({
      actorType: "agent_token",
      actorId: "admin-test-agent",
      action: "connection.disconnect",
      resourceType: "connection_grant",
      resourceId: `${owners[0]!.issuer}:${ownerAConnection}`,
      requestId: "request-admin-disconnect",
    }, (client) => accounts.adminDisconnectConnection(
      owners[0]!.issuer,
      ownerAConnection,
      client,
    ));
    assert.deepEqual(invalidated, [{
      credentialId: ownerACredential.credentialId!,
      revision: ownerACredential.revision,
      credentialOwnerId: owners[0]!.tenantId,
      sellingPartnerId: "A1INDEPENDENT",
    }]);
    await tokens.save("A1INDEPENDENT", owners[0]!.tenantId, {
      refresh_token: "drifted-owner-a-token",
    });
    await disconnectAudits.run({
      actorType: "agent_token",
      actorId: "admin-test-agent",
      action: "connection.disconnect",
      resourceType: "connection_grant",
      resourceId: `${owners[0]!.issuer}:${ownerAConnection}`,
      requestId: "request-admin-disconnect-retry",
    }, (client) => accounts.adminDisconnectConnection(
      owners[0]!.issuer,
      ownerAConnection,
      client,
    ));
    await assert.rejects(
      tokens.getRefreshToken("A1INDEPENDENT", owners[0]!.tenantId),
      (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
    );
    assert.equal(invalidated.length, 2);
    assert.deepEqual((await admin.query(`
      SELECT action, result, request_id
      FROM amazon_sp_api.audit_log
      WHERE request_id = 'request-admin-disconnect'
    `)).rows[0], {
      action: "connection.disconnect",
      result: "success",
      request_id: "request-admin-disconnect",
    });
    await assert.rejects(
      tokens.getRefreshToken("A1INDEPENDENT", sharedEmployee.tenantId),
      (error: unknown) => (error as { code?: string }).code === "SELLER_FORBIDDEN",
    );
    assert.equal(
      (await policy.resolveAccount(testAgent, completed[0]!.connection!.metadata.account_id))
        .credentialOwnerId,
      owners[1]!.tenantId,
    );
    assert.equal(await tokens.getRefreshToken("A1INDEPENDENT", owners[1]!.tenantId), "refresh-2");
    const ownerBConnection = completed[1]!.connection!.connectionId;
    await Promise.all([
      accounts.disconnect(owners[1]!, ownerBConnection),
      accounts.disconnect(owners[1]!, ownerBConnection),
    ]);
    await tokens.save("A1INDEPENDENT", owners[1]!.tenantId, {
      refresh_token: "drifted-owner-b-token",
    });
    await accounts.disconnect(owners[1]!, ownerBConnection);
    await assert.rejects(
      tokens.getRefreshToken("A1INDEPENDENT", owners[1]!.tenantId),
      (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
    );
  } finally {
    await accounts.close();
    await tokens.close();
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});

test("blocks account lifecycle backfill when legacy ownership cannot be inferred", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await migratePostgres(admin);
    await admin.query(`
      INSERT INTO amazon_sp_api.oauth_connection
        (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
         status, created_at, updated_at)
      VALUES ('A1ORPHAN', 'unknown-tenant', NOW(), $1, 'bearer', 'active', NOW(), NOW())
    `, [encrypted("orphan-token")]);

    await assert.rejects(
      backfillPostgresAccountLifecycle(admin, () => {
        throw new Error("readiness blockers must be checked before credentials");
      }),
      /oauth_without_account.*1/,
    );
    assert.deepEqual((await admin.query(`
      SELECT
        (SELECT COUNT(*)::int FROM amazon_sp_api.amazon_account) AS accounts,
        (SELECT COUNT(*)::int FROM amazon_sp_api.amazon_credential) AS credentials,
        (SELECT COUNT(*)::int FROM amazon_sp_api.data_backfill) AS completed
    `)).rows[0], { accounts: 0, credentials: 0, completed: 0 });
  } finally {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});

test("initializes the fixed administrator once without storing plaintext", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const password = "correct horse battery staple";
  try {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await migratePostgres(admin);
    const initialized = await Promise.all([
      initializeAdmin(admin, "admin", password),
      initializeAdmin(admin, "admin", password),
    ]);
    assert.deepEqual(initialized.map(({ created }) => created).sort(), [false, true]);

    const stored = (await admin.query(`
      SELECT id, username, password_hash, role, status
      FROM amazon_sp_api.app_user
    `)).rows[0];
    assert.equal(stored.id, "tenant-1");
    assert.equal(stored.username, "admin");
    assert.equal(stored.role, "admin");
    assert.equal(stored.status, "active");
    assert.doesNotMatch(stored.password_hash, new RegExp(password));
    assert.equal(await verifyAdminPassword(password, stored.password_hash), true);

    await assert.rejects(
      initializeAdmin(admin, "another-admin", password),
      /already initialized with different credentials/,
    );
    assert.equal((await admin.query(`
      SELECT COUNT(*)::int AS count FROM amazon_sp_api.app_user
    `)).rows[0].count, 1);
  } finally {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});

test("records paginated audit outcomes without request secrets", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await migratePostgres(admin);
    await initializeAdmin(admin, "admin", "correct horse battery staple");
    const audits = new AdminAuditService(admin);
    const agents = new AdminAgentService(admin);
    const requestId = "req-audit-1";
    const baseEvent = {
      actorType: "browser_session" as const,
      actorId: "admin",
      action: "agent.create",
      resourceType: "test_agent",
      resourceId: "audit-agent",
      requestId,
    };
    const created = await audits.run(baseEvent, (client) => agents.create({
      agentId: "audit-agent", name: "Audit Agent", purpose: "audit transaction",
    }, client));
    assert.match(created.apiToken, /^oat_/);

    await assert.rejects(audits.run({ ...baseEvent, resourceId: "rolled-back-agent" }, async (client) => {
      await agents.create({
        agentId: "rolled-back-agent", name: "Rollback Agent", purpose: "rollback check",
      }, client);
      throw new Error("contains oat_secret Cookie refresh_token OAuth state query=password");
    }), /contains oat_secret/);
    assert.equal((await agents.list()).some(({ agent_id }) => agent_id === "rolled-back-agent"), false);
    await audits.record({ ...baseEvent, action: "agent.token.rotate", resourceId: created.agent.id }, "denied", "csrf_invalid");

    const page = await audits.list({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    const rest = await audits.list({ limit: 2, beforeId: page.nextCursor! });
    assert.equal(rest.items.length, 1);
    assert.deepEqual((await audits.list({ limit: 10, requestId })).items.map(({ result }) => result), [
      "denied", "failed", "success",
    ]);
    const stored = JSON.stringify((await admin.query(`
      SELECT actor_id, action, resource_type, resource_id, result, error_code, request_id
      FROM amazon_sp_api.audit_log ORDER BY id
    `)).rows);
    assert.doesNotMatch(stored, /oat_secret|Cookie|refresh_token|OAuth state|query=password/);
  } finally {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});

test("serves admin account views from the migrated PostgreSQL schema", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  let server: Server | undefined;
  try {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await migratePostgres(admin);
    await initializeAdmin(admin, "admin", "correct horse battery staple");
    const agents = new AdminAgentService(admin);
    const audits = new AdminAuditService(admin);
    const token = (await agents.create({
      agentId: "admin-api-test", name: "Admin API Test", purpose: "schema contract",
    })).apiToken;
    await admin.query(`
      INSERT INTO amazon_sp_api.external_account_credential
        (account_id, provider_key, external_account_id, owner_workspace_id, display_name,
         status, authorized_at, created_at, updated_at)
      VALUES ('acct_admin_test', 'amazon-sp-api', 'A1ADMINSELLER', 'workspace-owner',
              'Admin Seller', 'active', NOW(), NOW(), NOW());
      INSERT INTO amazon_sp_api.amazon_account
        (account_id, provider_key, issuer_scope, selling_partner_id, display_name, status,
         marketplace_ids, region, authorized_at, created_at, updated_at)
      VALUES ('acct_admin_test', 'amazon-sp-api', 'example-issuer-prod', 'A1ADMINSELLER',
              'Admin Seller', 'active', ARRAY['ATVPDKIKX0DER'], 'NA', NOW(), NOW(), NOW());
      INSERT INTO amazon_sp_api.amazon_credential
        (credential_id, account_id, credential_owner_id, encrypted_refresh_token,
         refresh_token_revision, status, authorized_at, last_refresh_at, created_at, updated_at)
      VALUES ('cred_admin_test', 'acct_admin_test', 'employee-owner', '{"key_id":"k0"}',
              3, 'active', NOW(), NOW(), NOW(), NOW());
      INSERT INTO amazon_sp_api.connection_grant
        (issuer, connection_id, account_id, owner_employee_id, status, created_at, updated_at,
         credential_id, authorized_by_type, authorized_by_id)
      VALUES ('example-issuer-prod', 'con_admin_test_123456', 'acct_admin_test', 'employee-owner',
              'active', NOW(), NOW(), 'cred_admin_test', 'employee', 'employee-owner');
      INSERT INTO amazon_sp_api.amazon_credential
        (credential_id, account_id, credential_owner_id, encrypted_refresh_token,
         refresh_token_revision, status, authorized_at, last_refresh_at, created_at, updated_at)
      VALUES ('cred_admin_second', 'acct_admin_test', 'employee-second', '{"key_id":"k1"}',
              7, 'active', NOW(), NOW() + INTERVAL '1 minute', NOW(), NOW() + INTERVAL '1 minute');
      INSERT INTO amazon_sp_api.connection_grant
        (issuer, connection_id, account_id, owner_employee_id, status, created_at, updated_at,
         credential_id, authorized_by_type, authorized_by_id)
      VALUES ('example-issuer-prod', 'con_admin_second_12345', 'acct_admin_test', 'employee-second',
              'active', NOW(), NOW() + INTERVAL '1 minute', 'cred_admin_second', 'employee', 'employee-second');
      INSERT INTO amazon_sp_api.employee_registry
        (issuer, employee_id, workspace_id, first_seen_at, last_seen_at)
      VALUES ('example-issuer-prod', 'employee-owner', 'workspace-owner', NOW(), NOW());
      INSERT INTO amazon_sp_api.employee_account_binding
        (issuer, employee_id, workspace_id, connection_id, status, remark, bound_at, updated_at,
         workspace_tenant_id, account_id)
      VALUES ('example-issuer-prod', 'employee-owner', 'workspace-owner', 'con_admin_test_123456',
              'active', 'owner', NOW(), NOW(), 'tenant-1', 'acct_admin_test')
    `);

    const app = express();
    const sessions = new AdminSessionManager({
      pool: admin,
      secret: randomBytes(32).toString("base64"),
    });
    registerAdminAccountRoutes(app, sessions, agents, audits, admin);
    registerAdminAgentRoutes(app, sessions, agents, audits);
    registerAdminAuditRoutes(app, sessions, audits, agents);
    registerAdminDashboardRoutes(app, sessions, agents, audits, {
      pool: admin,
      lwaClientId: "client-id",
      lwaClientSecret: "client-secret",
      applicationId: "application-id",
      publicOrigin: "https://api.example.com",
      readinessCheck: async () => ({
        status: "ready",
        checks: {
          lwa: "ok", tokenStore: "ok", encryptionKey: "ok", postgres: "ok", redis: "ok",
        },
      }),
      toolCount: 30,
      mcpEndpoint: "/mcp",
      connected-accountKeyringConfigured: true,
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (path: string) => fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const list = await get("/api/v1/admin/accounts?query=A1ADMINSELLER");
    assert.equal(list.status, 200);
    const item = (await list.json()).items[0];
    assert.deepEqual({ ...item, last_synced_at: null }, {
      account_id: "acct_admin_test",
      display_name: "Admin Seller",
      selling_partner_id_masked: "A1A*******LER",
      region: "NA",
      marketplaces: ["ATVPDKIKX0DER"],
      status: "active",
      credential_status: "active",
      credential_revision: 7,
      active_bindings_count: 1,
      last_synced_at: null,
    });
    assert.match(item.last_synced_at, /^\d{4}-\d{2}-\d{2}T/);
    const refresh = await fetch(`${origin}/api/v1/admin/accounts/acct_admin_test/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(refresh.status, 200);
    assert.deepEqual(await refresh.json(), { refreshed: true });
    const missingRefresh = await fetch(`${origin}/api/v1/admin/accounts/acct_missing/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missingRefresh.status, 404);
    const detail = await get("/api/v1/admin/accounts/acct_admin_test");
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.credential_info.key_id, "k1");
    assert.deepEqual(detailBody.marketplaces, ["ATVPDKIKX0DER"]);
    assert.equal(detailBody.bindings.length, 1);
    const employee = await get("/api/v1/admin/connected-account-employees/employee-owner/accounts?issuer=example-issuer-prod");
    assert.equal(employee.status, 200);
    assert.equal((await employee.json())[0].account_id, "acct_admin_test");

    const agentList = await get("/api/v1/admin/agents");
    assert.equal(agentList.status, 200);
    assert.equal((await agentList.json()).items[0].name, "Admin API Test");
    const auditList = await get("/api/v1/admin/audit-logs?limit=10");
    assert.equal(auditList.status, 200);
    assert.ok((await auditList.json()).items.length >= 3);
    const dashboard = await get("/api/v1/admin/dashboard");
    assert.equal(dashboard.status, 200);
    assert.deepEqual(await dashboard.json(), {
      total_accounts: 1,
      active_accounts: 1,
      active_bindings: 1,
      active_test_agents: 1,
      credential_status_counts: { active: 2, pending: 0, error: 0, disconnected: 0 },
      recent_errors_count: 0,
    });
    const config = await get("/api/v1/admin/amazon-config-status");
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), {
      lwa_client_id_configured: true,
      lwa_client_secret_configured: true,
      application_id_configured: true,
      public_origin: "https://api.example.com",
      oauth_callback_url: "https://api.example.com/oauth/amazon/callback",
      postgres_status: "ok",
      redis_status: "ok",
      credential_keyring_status: "ok",
      connected-account_keyring_status: "ok",
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});

test("manages independent test agent tokens without storing plaintext", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await migratePostgres(admin);
    await initializeAdmin(admin, "admin", "correct horse battery staple");
    const agents = new AdminAgentService(admin);
    const authenticate = createAmazonAuthenticator({
      authenticateTestAgent: (token) => agents.authenticateToken(token),
    });

    const created = await agents.create({
      agentId: "diagnostic-agent",
      name: "Diagnostic Agent",
      purpose: "MCP connectivity checks",
    });
    assert.match(created.apiToken, /^oat_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.agent.api_token_configured, true);
    const stored = (await admin.query(`
      SELECT api_token_hash, api_token_hint FROM amazon_sp_api.app_agent WHERE id = $1
    `, [created.agent.id])).rows[0];
    assert.equal(stored.api_token_hash, createHash("sha256").update(created.apiToken).digest("hex"));
    assert.notEqual(stored.api_token_hash, created.apiToken);
    assert.equal(stored.api_token_hint, created.agent.api_token_hint);
    assert.doesNotMatch(JSON.stringify(await agents.list()), /oat_[A-Za-z0-9_-]{43}/);
    assert.deepEqual(await authenticate(created.apiToken), {
      authType: "test_agent",
      credentialKind: "test_agent_token",
      tenantId: "tenant-1",
      agentRecordId: created.agent.id,
      agentId: "diagnostic-agent",
      scopes: new Set([
        "config:check", "mcp:catalog", "mcp:invoke", "connected_accounts:manage",
      ]),
    });
    assert.ok((await agents.list())[0]?.last_used_at);
    const secondAgent = await agents.create({
      agentId: "second-agent", name: "Second Agent", purpose: "isolation check",
    });
    assert.equal((await agents.authenticateToken(secondAgent.apiToken))?.agentRecordId, secondAgent.agent.id);
    assert.equal((await agents.authenticateToken(created.apiToken))?.agentRecordId, created.agent.id);

    const disabled = await agents.update(created.agent.id, { status: "disabled" });
    assert.equal(disabled?.status, "disabled");
    assert.equal(await authenticate(created.apiToken), null);
    const rotated = await agents.rotateToken(created.agent.id);
    assert.ok(rotated);
    assert.notEqual(rotated.apiToken, created.apiToken);
    assert.equal(await authenticate(created.apiToken), null);
    assert.equal(await authenticate(rotated.apiToken), null);
    await agents.update(created.agent.id, { status: "active" });
    const rotatedPrincipal = await authenticate(rotated.apiToken);
    assert.equal(
      rotatedPrincipal?.authType === "test_agent" ? rotatedPrincipal.agentRecordId : null,
      created.agent.id,
    );
    assert.equal((await admin.query(`
      SELECT api_token_hash FROM amazon_sp_api.app_agent WHERE id = $1
    `, [created.agent.id])).rows[0].api_token_hash,
    createHash("sha256").update(rotated.apiToken).digest("hex"));

    const revoked = await agents.revokeToken(created.agent.id);
    assert.equal(revoked?.api_token_configured, false);
    assert.equal(await authenticate(rotated.apiToken), null);
    assert.deepEqual((await admin.query(`
      SELECT api_token_hash, api_token_hint, api_token_created_at
      FROM amazon_sp_api.app_agent WHERE id = $1
    `, [created.agent.id])).rows[0], {
      api_token_hash: null,
      api_token_hint: "",
      api_token_created_at: null,
    });
  } finally {
    await admin.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await admin.end();
  }
});
