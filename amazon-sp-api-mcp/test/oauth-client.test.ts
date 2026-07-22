import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { AmazonOAuthClient } from "../src/oauth-client.js";

test("calls private OAuth connection endpoints with tenant scope", async () => {
  const requests: Array<{ method?: string; path?: string; authorization?: string; body?: string }> = [];
  const disconnected: Array<{ tenantId: string; sellingPartnerId: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      response.writeHead(201);
      response.end(JSON.stringify({ authorization_url: "https://api.example.com/oauth/amazon/start?intent=opaque" }));
    } else if (request.method === "GET") {
      response.end(JSON.stringify({ connections: [{ sellingPartnerId: "A1EXAMPLE", authorizedAt: "2026-07-17T10:00:00Z" }] }));
    } else {
      response.end(JSON.stringify({ disconnected: true }));
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new AmazonOAuthClient({
    baseURL: `http://127.0.0.1:${port}`,
    internalSecret: "internal-secret",
    onDisconnect(tenantId, sellingPartnerId) {
      disconnected.push({ tenantId, sellingPartnerId });
    },
  });

  try {
    assert.match(await client.createAuthorizationURL("user-1"), /oauth\/amazon\/start/);
    assert.match(await client.createRenewalURL("user-1"), /oauth\/amazon\/renew/);
    assert.equal((await client.listConnections("user-1"))[0]?.sellingPartnerId, "A1EXAMPLE");
    await client.disconnect("user-1", "A1EXAMPLE");
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.authorization === "Bearer internal-secret"));
    assert.match(requests[0]?.body || "", /"tenant_id":"user-1"/);
    assert.match(requests[1]?.body || "", /"tenant_id":"user-1"/);
    assert.match(requests[2]?.path || "", /tenant_id=user-1/);
    assert.match(requests[3]?.path || "", /connections\/A1EXAMPLE\?tenant_id=user-1/);
    assert.deepEqual(disconnected, [{ tenantId: "user-1", sellingPartnerId: "A1EXAMPLE" }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("creates and polls ConnectedAccount authorization attempts with tenant scope", async () => {
  const requests: Array<{ method?: string; path?: string; body?: string }> = [];
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async (input, init) => {
      requests.push({
        method: init?.method,
        path: new URL(String(input)).pathname + new URL(String(input)).search,
        body: String(init?.body || ""),
      });
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          authorization_url: "https://api.example.com/oauth/amazon/start?intent=opaque",
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        sellingPartnerId: "A1EXAMPLE",
        authorizedAt: "2026-07-21T10:00:00Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  const authorizationURL = await client.createConnectedAccountAuthorizationURL(
    "jwt-employee:issuer-hash:employee-1",
    "att_0123456789abcdef",
    "https://app.connected-account.example",
  );
  assert.match(authorizationURL, /oauth\/amazon\/start/);
  assert.deepEqual(JSON.parse(requests[0]?.body || "{}"), {
    tenant_id: "jwt-employee:issuer-hash:employee-1",
    connected-account_attempt_id: "att_0123456789abcdef",
    connected-account_origin: "https://app.connected-account.example",
  });

  assert.deepEqual(
    await client.getConnectedAccountAuthorizationCompletion(
      "jwt-employee:issuer-hash:employee-1",
      "att_0123456789abcdef",
    ),
    { sellingPartnerId: "A1EXAMPLE", authorizedAt: "2026-07-21T10:00:00Z" },
  );
  assert.match(
    requests[1]?.path || "",
    /connected-account-completions\/att_0123456789abcdef\?tenant_id=jwt-employee%3Aissuer-hash%3Aemployee-1/,
  );
});

test("returns null while a ConnectedAccount authorization attempt is incomplete", async () => {
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async () => new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  assert.equal(
    await client.getConnectedAccountAuthorizationCompletion("tenant-1", "att_0123456789abcdef"),
    null,
  );
});

test("caches connection lists per tenant and invalidates after disconnect", async () => {
  let listCalls = 0;
  let deleteCalls = 0;
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    connectionCacheTtlMs: 60_000,
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return new Response(JSON.stringify({ disconnected: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      listCalls += 1;
      return new Response(JSON.stringify({
        connections: [{ sellingPartnerId: "A1EXAMPLE", authorizedAt: "2026-07-17T10:00:00Z" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.equal((await client.listConnections("user-1")).length, 1);
  assert.equal((await client.listConnections("user-1")).length, 1);
  assert.equal(listCalls, 1);
  await client.disconnect("user-1", "A1EXAMPLE");
  assert.equal(deleteCalls, 1);
  assert.equal((await client.listConnections("user-1")).length, 1);
  assert.equal(listCalls, 2);
});

test("forces a fresh OAuth connection list when requested", async () => {
  let listCalls = 0;
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    connectionCacheTtlMs: 60_000,
    fetchImpl: (async () => {
      listCalls += 1;
      return new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await client.listConnections("tenant-1");
  await client.listConnections("tenant-1");
  await client.listConnections("tenant-1", true);
  assert.equal(listCalls, 2);
});

test("deduplicates concurrent connection lists without sharing tenants", async () => {
  const calls = new Map<string, number>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    connectionCacheTtlMs: 60_000,
    fetchImpl: (async (input) => {
      const tenantId = new URL(String(input)).searchParams.get("tenant_id")!;
      calls.set(tenantId, (calls.get(tenantId) ?? 0) + 1);
      await gate;
      return new Response(JSON.stringify({
        connections: [{ sellingPartnerId: `SELLER-${tenantId}`, authorizedAt: "2026-07-17T10:00:00Z" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  const tenantOne = Array.from({ length: 10 }, () => client.listConnections("user-1"));
  const tenantTwo = client.listConnections("user-2");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.fromEntries(calls), { "user-1": 1, "user-2": 1 });
  release();
  assert.ok((await Promise.all(tenantOne)).every((items) =>
    items[0]?.sellingPartnerId === "SELLER-user-1"));
  assert.equal((await tenantTwo)[0]?.sellingPartnerId, "SELLER-user-2");
});

test("does not repopulate a connection cache from a list started before disconnect", async () => {
  let listCalls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    connectionCacheTtlMs: 60_000,
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      listCalls += 1;
      const call = listCalls;
      if (call === 1) await firstGate;
      return new Response(JSON.stringify({ connections: [{
        sellingPartnerId: call === 1 ? "STALE" : "CURRENT",
        authorizedAt: "2026-07-17T10:00:00Z",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  const stale = client.listConnections("user-1");
  await new Promise((resolve) => setImmediate(resolve));
  await client.disconnect("user-1", "STALE");
  assert.equal((await client.listConnections("user-1"))[0]?.sellingPartnerId, "CURRENT");
  releaseFirst();
  assert.equal((await stale)[0]?.sellingPartnerId, "STALE");
  assert.equal((await client.listConnections("user-1"))[0]?.sellingPartnerId, "CURRENT");
  assert.equal(listCalls, 2);
});

test("does not cache failed connection-list requests", async () => {
  let calls = 0;
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    connectionCacheTtlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("temporary failure");
      return new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await assert.rejects(client.listConnections("user-1"));
  assert.deepEqual(await client.listConnections("user-1"), []);
  assert.equal(calls, 2);
});

test("maps OAuth 404 according to operation context", async () => {
  const responses: number[] = [];
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async () => {
      responses.push(404);
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  await assert.rejects(
    client.createAuthorizationURL("user-1"),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_OAUTH",
  );
  await assert.rejects(
    client.disconnect("user-1", "A1SELLER"),
    (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
  );
  assert.equal(responses.length, 2);
});

test("rejects OAuth intent responses without an authorization URL", async () => {
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async () => new Response("{}", {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    client.createAuthorizationURL("user-1"),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_OAUTH",
  );
});

test("rejects malformed OAuth responses with a stable upstream error", async () => {
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    client.listConnections("user-1"),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_OAUTH",
  );
});

test("maps OAuth network failures to a retryable stable error", async () => {
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
  });

  await assert.rejects(
    client.listConnections("user-1"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UPSTREAM_OAUTH");
      assert.equal((error as { retryable?: boolean }).retryable, true);
      assert.doesNotMatch((error as Error).message, /fetch failed/);
      return true;
    },
  );
});

test("does not invalidate access tokens when OAuth disconnect fails", async () => {
  let invalidations = 0;
  const client = new AmazonOAuthClient({
    baseURL: "http://127.0.0.1:8788",
    internalSecret: "internal-secret",
    fetchImpl: (async () => new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
    onDisconnect() {
      invalidations += 1;
    },
  });

  await assert.rejects(
    client.disconnect("user-1", "A1EXAMPLE"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "NOT_CONNECTED");
      assert.deepEqual(JSON.parse((error as Error).message), {
        code: "NOT_CONNECTED",
        message: "Amazon connection was not found for the current user",
        retryable: false,
        details: { status: 404 },
      });
      return true;
    },
  );
  assert.equal(invalidations, 0);
});
