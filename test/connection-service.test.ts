import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectionService, type AuthorizationIntent } from "../src/connection-service.js";
import type { ExpiringStore } from "../src/state-store.js";
import type { AmazonConnection, ConnectionStore } from "../src/token-store.js";

class MemoryIntentStore implements ExpiringStore<AuthorizationIntent> {
  readonly records = new Map<string, AuthorizationIntent>();
  next = 0;
  async initialize() {}
  async create(record: Omit<AuthorizationIntent, "expiresAt">) {
    const id = `intent-${++this.next}`;
    this.records.set(id, record);
    return id;
  }
  async get(id: string) { return this.records.get(id) ?? null; }
  async delete(id: string) { this.records.delete(id); }
  async consume(id: string) {
    const record = this.records.get(id) ?? null;
    this.records.delete(id);
    return record;
  }
  async checkHealth(): Promise<"ok"> { return "ok"; }
  async close() {}
}

function memoryConnectionStore() {
  const connections = new Map<string, AmazonConnection[]>();
  let listCalls = 0;
  const store = {
    async initialize() {},
    async save() {},
    async list(tenantId: string) {
      listCalls += 1;
      return connections.get(tenantId) ?? [];
    },
    async disconnect(tenantId: string, sellingPartnerId: string) {
      const items = connections.get(tenantId) ?? [];
      if (!items.some((item) => item.sellingPartnerId === sellingPartnerId)) return false;
      connections.set(tenantId, items.filter((item) => item.sellingPartnerId !== sellingPartnerId));
      return true;
    },
    async findConnectedAccountCompletion(tenantId: string, attemptId: string) {
      return attemptId === "att_0123456789abcdef"
        ? connections.get(tenantId)?.[0] ?? null
        : null;
    },
    async getRefreshToken() { return "refresh"; },
    async checkHealth(): Promise<"ok"> { return "ok"; },
    async close() {},
  } satisfies ConnectionStore;
  return { connections, listCalls: () => listCalls, store };
}

test("creates authorization and renewal intents in process", async () => {
  const intents = new MemoryIntentStore();
  const { store } = memoryConnectionStore();
  const service = new ConnectionService({
    store,
    intentStore: intents,
    publicOrigin: "https://api.example.com",
  });
  assert.equal(
    await service.createAuthorizationURL("tenant-1"),
    "https://api.example.com/oauth/amazon/start?intent=intent-1",
  );
  assert.equal(
    await service.createRenewalURL("tenant-1"),
    "https://api.example.com/oauth/amazon/renew?intent=intent-2",
  );
  assert.equal(intents.records.get("intent-1")?.tenantId, "tenant-1");
});

test("creates and polls an allowed ConnectedAccount authorization intent", async () => {
  const intents = new MemoryIntentStore();
  const { store, connections } = memoryConnectionStore();
  connections.set("jwt-employee:issuer:employee-1", [{
    sellingPartnerId: "A1SELLER",
    authorizedAt: "2026-07-28T00:00:00.000Z",
  }]);
  const service = new ConnectionService({
    store,
    intentStore: intents,
    publicOrigin: "https://api.example.com",
    allowedConnectedAccountOrigins: ["https://app.connected-account.example"],
  });
  await service.createConnectedAccountAuthorizationURL(
    "jwt-employee:issuer:employee-1",
    "att_0123456789abcdef",
    "https://app.connected-account.example",
  );
  assert.equal(intents.records.get("intent-1")?.connected-accountOrigin, "https://app.connected-account.example");
  await service.cancelAuthorizationURL("https://attacker.example/oauth/amazon/start?intent=intent-1");
  assert.ok(intents.records.has("intent-1"));
  assert.equal(
    (await service.getConnectedAccountAuthorizationCompletion(
      "jwt-employee:issuer:employee-1",
      "att_0123456789abcdef",
    ))?.sellingPartnerId,
    "A1SELLER",
  );
  await assert.rejects(
    service.createConnectedAccountAuthorizationURL(
      "tenant-1",
      "att_0123456789abcdef",
      "https://attacker.example",
    ),
  );
  await service.cancelAuthorizationURL("https://api.example.com/oauth/amazon/start?intent=intent-1");
  assert.equal(intents.records.has("intent-1"), false);
});

test("caches connection lists and invalidates them after disconnect", async () => {
  const intents = new MemoryIntentStore();
  const { store, connections, listCalls } = memoryConnectionStore();
  connections.set("tenant-1", [{
    sellingPartnerId: "A1SELLER",
    authorizedAt: "2026-07-28T00:00:00.000Z",
  }]);
  const invalidated: string[] = [];
  const service = new ConnectionService({
    store,
    intentStore: intents,
    publicOrigin: "https://api.example.com",
    connectionCacheTtlMs: 60_000,
    onDisconnect: (_tenantId, sellerId) => { invalidated.push(sellerId); },
  });
  assert.equal((await service.listConnections("tenant-1")).length, 1);
  assert.equal((await service.listConnections("tenant-1")).length, 1);
  assert.equal(listCalls(), 1);
  await service.disconnect("tenant-1", "A1SELLER");
  assert.deepEqual(invalidated, ["A1SELLER"]);
  assert.deepEqual(await service.listConnections("tenant-1"), []);
  assert.equal(listCalls(), 2);
  await assert.rejects(service.disconnect("tenant-1", "A1SELLER"),
    (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED");
});

test("retries idempotent provider cleanup after token deletion succeeds", async () => {
  const intents = new MemoryIntentStore();
  const { store, connections } = memoryConnectionStore();
  connections.set("tenant-1", [{
    sellingPartnerId: "A1SELLER",
    authorizedAt: "2026-07-28T00:00:00.000Z",
  }]);
  let cleanupCalls = 0;
  const service = new ConnectionService({
    store,
    intentStore: intents,
    publicOrigin: "https://api.example.com",
    onDisconnect: () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw new Error("cache unavailable");
    },
  });

  await assert.rejects(service.disconnectIfPresent("tenant-1", "A1SELLER"));
  assert.equal(await service.disconnectIfPresent("tenant-1", "A1SELLER"), false);
  assert.equal(cleanupCalls, 2);
  assert.deepEqual(await service.listConnections("tenant-1"), []);
});

test("allows concurrent idempotent provider disconnects", async () => {
  const intents = new MemoryIntentStore();
  const { store, connections } = memoryConnectionStore();
  connections.set("tenant-1", [{
    sellingPartnerId: "A1SELLER",
    authorizedAt: "2026-07-28T00:00:00.000Z",
  }]);
  let cleanupCalls = 0;
  const service = new ConnectionService({
    store,
    intentStore: intents,
    publicOrigin: "https://api.example.com",
    onDisconnect: () => { cleanupCalls += 1; },
  });

  const results = await Promise.all([
    service.disconnectIfPresent("tenant-1", "A1SELLER"),
    service.disconnectIfPresent("tenant-1", "A1SELLER"),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(cleanupCalls, 2);
});
