import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  ConnectedAccountError,
  ConnectedAccountStore,
  type ConnectedAccountPrincipal,
} from "../src/connected-accounts.js";
import { createAmazonMcpHttpApp } from "../src/http.js";
import { LOCAL_ACCOUNT_PRINCIPAL, LOCAL_OWNER } from "../src/local-identity.js";
import { createAmazonMcpServer } from "../src/tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

function principal(
  issuer: string,
  employeeId: string,
  scopes = new Set(["connected_accounts:manage", "mcp:invoke"]),
): ConnectedAccountPrincipal {
  return {
    authType: "employee_jwt",
    tenantId: `jwt-employee:${issuer}:${employeeId}`,
    issuer,
    employeeId,
    kid: "provider-v1",
    expiresAt: "2026-07-21T10:05:00.000Z",
    scopes,
  };
}

async function createStore(now = new Date("2026-07-21T10:00:00.000Z")) {
  const directory = await mkdtemp(join(tmpdir(), "amazon-connected-account-test-"));
  temporaryDirectories.push(directory);
  const completions = new Map<string, { sellingPartnerId: string; authorizedAt: string }>();
  const created: Array<{ tenantId: string; attemptId: string; origin: string }> = [];
  const activeConnections = new Map<string, Array<{
    sellingPartnerId: string;
    authorizedAt: string;
  }>>();
  const disconnected: Array<{ tenantId: string; sellingPartnerId: string }> = [];
  let disconnectFailure: Error | undefined;
  const store = new ConnectedAccountStore({
    file: join(directory, "connected-account.sqlite"),
    authorizationOrigin: "https://app.example.com",
    now: () => now,
    oauth: {
      async createConnectedAccountAuthorizationURL(tenantId, attemptId, origin) {
        created.push({ tenantId, attemptId, origin });
        return `https://api.example.com/oauth/amazon/start?intent=${attemptId}`;
      },
      async getConnectedAccountAuthorizationCompletion(_tenantId, attemptId) {
        return completions.get(attemptId) ?? null;
      },
      async listConnections(tenantId, forceRefresh) {
        assert.equal(forceRefresh, true);
        return activeConnections.get(tenantId) ?? [];
      },
      async disconnectIfPresent(tenantId, sellingPartnerId) {
        disconnected.push({ tenantId, sellingPartnerId });
        const connections = activeConnections.get(tenantId) ?? [];
        const found = connections.some(
          (connection) => connection.sellingPartnerId === sellingPartnerId,
        );
        activeConnections.set(
          tenantId,
          connections.filter((connection) => connection.sellingPartnerId !== sellingPartnerId),
        );
        if (disconnectFailure) {
          const error = disconnectFailure;
          disconnectFailure = undefined;
          throw error;
        }
        return found;
      },
    },
  });
  return {
    store,
    completions,
    created,
    activeConnections,
    disconnected,
    failNextDisconnect(error: Error) { disconnectFailure = error; },
    setNow(value: Date) { now = value; },
  };
}

async function completeAttempt(
  context: Awaited<ReturnType<typeof createStore>>,
  actor: ConnectedAccountPrincipal,
  seller = "A1SELLER",
) {
  const attempt = await context.store.createAuthorizationAttempt(actor);
  context.completions.set(attempt.attemptId, {
    sellingPartnerId: seller,
    authorizedAt: "2026-07-21T10:01:00.000Z",
  });
  return await context.store.getAuthorizationAttempt(actor, attempt.attemptId);
}

test("keeps attempts, grants, bindings, and accounts scoped to issuer and employee", async () => {
  const context = await createStore();
  const employee = principal("example-issuer-prod", "employee-1");
  const sameIssuerOtherEmployee = principal("example-issuer-prod", "employee-2");
  const sameEmployeeOtherIssuer = principal("example-issuer-staging", "employee-1");
  try {
    const attempt = await context.store.createAuthorizationAttempt(employee);
    assert.match(attempt.attemptId, /^att_[A-Za-z0-9_-]{24}$/);
    assert.equal(attempt.status, "pending");
    assert.equal(context.created[0]?.tenantId, employee.tenantId);
    assert.equal(context.created[0]?.origin, "https://app.example.com");
    assert.equal(
      (await context.store.getAuthorizationAttempt(employee, attempt.attemptId)).status,
      "pending",
    );
    await assert.rejects(
      context.store.getAuthorizationAttempt(sameIssuerOtherEmployee, attempt.attemptId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );
    await assert.rejects(
      context.store.getAuthorizationAttempt(sameEmployeeOtherIssuer, attempt.attemptId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );

    context.completions.set(attempt.attemptId, {
      sellingPartnerId: "A1SELLER",
      authorizedAt: "2026-07-21T10:01:00.000Z",
    });
    const active = await context.store.getAuthorizationAttempt(employee, attempt.attemptId);
    assert.equal(active.status, "active");
    assert.match(active.connection?.connectionId ?? "", /^con_/);
    assert.notEqual(active.connection?.metadata.account_id, "A1SELLER");
    assert.equal(
      (await context.store.getAuthorizationAttempt(employee, attempt.attemptId)).connection
        ?.connectionId,
      active.connection?.connectionId,
    );

    const connectionId = active.connection!.connectionId;
    assert.equal(context.store.listAccounts(employee).length, 0);
    assert.equal(context.store.bindAccount(employee, connectionId).created, true);
    assert.equal(context.store.bindAccount(employee, connectionId).created, false);
    const remarked = context.store.updateRemark(employee, connectionId, "市场团队");
    assert.equal(remarked.remark, "市场团队");
    assert.equal(context.store.listAccounts(employee).length, 1);
    assert.equal(context.store.listAccounts(sameIssuerOtherEmployee).length, 0);
    assert.equal(context.store.listAccounts(sameEmployeeOtherIssuer).length, 0);
    assert.equal(
      context.store.lookupAccounts(employee, [connectionId, connectionId]).length,
      1,
    );
    assert.throws(
      () => context.store.bindAccount(sameIssuerOtherEmployee, connectionId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );

    const secondAccount = await completeAttempt(context, employee, "A2SELLER");
    context.store.bindAccount(employee, secondAccount.connection!.connectionId);
    assert.deepEqual(
      context.store.listAccounts(employee).map((account) => account.externalAccountId).sort(),
      ["A1SELLER", "A2SELLER"],
    );

    const other = await completeAttempt(context, sameIssuerOtherEmployee, "A1SELLER");
    assert.notEqual(other.connection?.connectionId, connectionId);
    assert.notEqual(
      other.connection?.metadata.account_id,
      active.connection?.metadata.account_id,
    );

    context.store.unbindAccount(employee, connectionId);
    context.store.unbindAccount(employee, connectionId);
    assert.deepEqual(
      context.store.listAccounts(employee).map((account) => account.externalAccountId),
      ["A2SELLER"],
    );
    context.store.bindAccount(employee, connectionId);
    await context.store.disconnect(employee, connectionId);
    await context.store.disconnect(employee, connectionId);
    assert.deepEqual(context.disconnected.slice(-2), [
      { tenantId: employee.tenantId, sellingPartnerId: "A1SELLER" },
      { tenantId: employee.tenantId, sellingPartnerId: "A1SELLER" },
    ]);
    assert.deepEqual(
      context.store.listAccounts(employee).map((account) => account.externalAccountId),
      ["A2SELLER"],
    );
    assert.throws(
      () => context.store.bindAccount(employee, connectionId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );
  } finally {
    context.store.close();
  }
});

test("allows concurrent owner disconnect retries to complete idempotently", async () => {
  const context = await createStore();
  const employee = principal("example-issuer-prod", "employee-1");
  try {
    const active = await completeAttempt(context, employee, "A1CONCURRENT");
    const connectionId = active.connection!.connectionId;
    context.store.bindAccount(employee, connectionId);

    await Promise.all([
      context.store.disconnect(employee, connectionId),
      context.store.disconnect(employee, connectionId),
    ]);

    assert.equal(context.store.listAccounts(employee).length, 0);
    assert.deepEqual(context.disconnected, [
      { tenantId: employee.tenantId, sellingPartnerId: "A1CONCURRENT" },
      { tenantId: employee.tenantId, sellingPartnerId: "A1CONCURRENT" },
    ]);
  } finally {
    context.store.close();
  }
});

test("finishes owner disconnect after an earlier cleanup failure", async () => {
  const context = await createStore();
  const employee = principal("example-issuer-prod", "employee-1");
  try {
    const active = await completeAttempt(context, employee, "A1RETRY");
    const connectionId = active.connection!.connectionId;
    context.store.bindAccount(employee, connectionId);
    context.failNextDisconnect(new Error("cache unavailable"));

    await assert.rejects(context.store.disconnect(employee, connectionId));
    assert.equal(context.store.listAccounts(employee).length, 1);
    await context.store.disconnect(employee, connectionId);
    assert.equal(context.store.listAccounts(employee).length, 0);
    assert.equal(context.disconnected.length, 2);
  } finally {
    context.store.close();
  }
});

test("shares active bindings within one issuer without transferring ownership", async () => {
  const context = await createStore();
  const owner = principal("example-issuer-prod", "employee-owner");
  const shared = principal("example-issuer-prod", "employee-shared");
  const unbound = principal("example-issuer-prod", "employee-unbound");
  const otherIssuer = principal("example-issuer-staging", "employee-shared");
  try {
    const active = await completeAttempt(context, owner, "A1SHARED");
    const connectionId = active.connection!.connectionId;
    const accountId = active.connection!.metadata.account_id;
    context.store.bindAccount(owner, connectionId);
    assert.equal(context.store.listAccounts(shared).length, 0);
    assert.throws(
      () => context.store.shareAccount(owner, connectionId, otherIssuer),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );

    assert.equal(context.store.shareAccount(owner, connectionId, shared).created, true);
    assert.equal(context.store.shareAccount(owner, connectionId, shared).created, false);
    assert.equal(context.store.updateRemark(shared, connectionId, "共享员工").remark, "共享员工");
    assert.equal(context.store.resolveAccount(shared, accountId).externalAccountId, "A1SHARED");
    assert.equal(context.store.resolveAccount(owner, accountId).remark, undefined);
    assert.equal((await context.store.refreshAccounts(shared))[0]?.remark, "共享员工");
    assert.equal(context.store.listAccounts(unbound).length, 0);
    assert.throws(
      () => context.store.resolveAccount(unbound, accountId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );

    context.store.unbindAccount(shared, connectionId);
    assert.equal(context.store.listAccounts(shared).length, 0);
    assert.equal(context.store.listAccounts(owner).length, 1);
    context.store.shareAccount(owner, connectionId, shared);
    context.store.unshareAccount(owner, connectionId, shared);
    assert.equal(context.store.listAccounts(shared).length, 0);
    assert.equal(context.store.listAccounts(owner).length, 1);

    context.store.shareAccount(owner, connectionId, shared);
    await assert.rejects(
      context.store.disconnect(shared, connectionId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );
    await context.store.disconnect(owner, connectionId);
    assert.deepEqual(context.disconnected, [{
      tenantId: owner.tenantId,
      sellingPartnerId: "A1SHARED",
    }]);
    assert.equal(context.store.listAccounts(owner).length, 0);
    assert.equal(context.store.listAccounts(shared).length, 0);
  } finally {
    context.store.close();
  }
});

test("resolves only active accounts owned and bound by the current employee", async () => {
  const context = await createStore();
  const employee = principal("example-issuer-prod", "employee-1");
  const otherEmployee = principal("example-issuer-prod", "employee-2");
  const otherIssuer = principal("example-issuer-staging", "employee-1");
  try {
    const active = await completeAttempt(context, employee, "A1OWNED");
    const connectionId = active.connection!.connectionId;
    const accountId = active.connection!.metadata.account_id;
    context.store.bindAccount(employee, connectionId);

    assert.equal(
      context.store.resolveAccount(employee, accountId).externalAccountId,
      "A1OWNED",
    );
    for (const actor of [otherEmployee, otherIssuer]) {
      assert.throws(
        () => context.store.resolveAccount(actor, accountId),
        (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
      );
    }

    context.store.unbindAccount(employee, connectionId);
    assert.throws(
      () => context.store.resolveAccount(employee, accountId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );
    context.store.bindAccount(employee, connectionId);
    assert.equal((await context.store.refreshAccounts(employee))[0]?.externalAccountId, "A1OWNED");
    assert.equal(context.store.resolveAccount(employee, accountId).externalAccountId, "A1OWNED");

    const disconnected = await completeAttempt(context, employee, "A2DISCONNECTED");
    const disconnectedId = disconnected.connection!.connectionId;
    const disconnectedAccountId = disconnected.connection!.metadata.account_id;
    context.store.bindAccount(employee, disconnectedId);
    await context.store.disconnect(employee, disconnectedId);
    assert.throws(
      () => context.store.resolveAccount(employee, disconnectedAccountId),
      (error: unknown) => error instanceof ConnectedAccountError && error.status === 404,
    );
  } finally {
    context.store.close();
  }
});

test("expires pending authorization attempts without polling OAuth again", async () => {
  const context = await createStore();
  const employee = principal("example-issuer-prod", "employee-1");
  try {
    const attempt = await context.store.createAuthorizationAttempt(employee);
    context.setNow(new Date("2026-07-21T10:10:00.001Z"));
    assert.deepEqual(await context.store.getAuthorizationAttempt(employee, attempt.attemptId), {
      attemptId: attempt.attemptId,
      status: "expired",
      expiresAt: "2026-07-21T10:10:00.000Z",
      errorCode: "authorization_expired",
    });
  } finally {
    context.store.close();
  }
});

test("exposes bound accounts over the local API and MCP without authentication", async () => {
  const context = await createStore();
  const owner = principal("local", "local");
  // Complete a real authorization attempt so the connection id is genuine.
  const attempt = await context.store.createAuthorizationAttempt(owner);
  context.completions.set(attempt.attemptId, {
    sellingPartnerId: "A1SELLER",
    authorizedAt: "2026-07-21T10:01:00.000Z",
  });
  const active = await context.store.getAuthorizationAttempt(owner, attempt.attemptId);
  const connectionId = active.connection!.connectionId;
  const bound = context.store.bindAccount(owner, connectionId);
  assert.equal(bound.created, true);
  const app = createAmazonMcpHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    version: "0.1.0",
    connectedAccountService: context.store,
    createServer: (actor) => createAmazonMcpServer(
      { async get() { return {}; } },
      {
        principal: actor,
        accountAccessPolicy: {
          async listAccounts() {
            return context.store.listAccounts(LOCAL_ACCOUNT_PRINCIPAL);
          },
          async resolveAccount(_principal: unknown, accountId: string) {
            return {
              account: context.store.resolveAccount(LOCAL_ACCOUNT_PRINCIPAL, accountId),
              credentialOwnerId: LOCAL_OWNER.workspaceId,
            };
          },
        },
      },
    ),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, init);
  try {
    // The Connected Account Protocol is gone in a single-user build.
    assert.equal((await request("/.well-known/connected-account")).status, 404);
    assert.equal((await request("/connected-account/v1/accounts")).status, 404);

    // The local account API needs no credentials.
    const listed = await request("/api/v1/accounts");
    assert.equal(listed.status, 200);
    const body = await listed.json() as { items: Array<{ connectionId: string }> };
    assert.deepEqual(body.items.map((item) => item.connectionId), [bound.account.connectionId]);

    // Starting an authorization attempt also needs no credentials.
    const attempt = await request("/api/v1/accounts/authorization-attempts", { method: "POST" });
    assert.equal(attempt.status, 201);

    // Disconnecting is unauthenticated too, and is idempotent.
    assert.equal((await request(`/api/v1/accounts/${connectionId}`, { method: "DELETE" })).status, 204);
    assert.deepEqual(await (await request("/api/v1/accounts")).json(), { items: [] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve()));
    context.store.close();
  }
});
