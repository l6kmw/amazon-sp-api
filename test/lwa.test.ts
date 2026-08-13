import assert from "node:assert/strict";
import { test } from "node:test";

import { LwaAccessTokenProvider } from "../src/lwa.js";
import { createStructuredLogger } from "../src/logger.js";
import { mcpMetrics } from "../src/metrics.js";

test("exchanges a refresh token once and caches the LWA access token", async () => {
  let calls = 0;
  let requestBody = "";
  const logs: string[] = [];
  const refreshTokenCalls: Array<{ sellingPartnerId: string; tenantId?: string }> = [];
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken(sellingPartnerId, tenantId) {
        refreshTokenCalls.push({ sellingPartnerId, tenantId });
        return "refresh-token";
      },
    },
    fetchImpl: (async (_input, init) => {
      calls += 1;
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
  });

  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-token");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-token");
  assert.equal(calls, 1);
  assert.deepEqual(refreshTokenCalls, [
    { sellingPartnerId: "A1SELLER", tenantId: "user-1" },
    { sellingPartnerId: "A1SELLER", tenantId: "user-1" },
  ]);
  assert.match(requestBody, /refresh_token=refresh-token/);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /"event":"lwa\.refresh\.completed"/);
  assert.doesNotMatch(logs[0]!, /refresh-token|access-token|client-secret|A1SELLER|user-1/);
});

test("deduplicates concurrent LWA exchanges for the same tenant and seller", async () => {
  let refreshTokenCalls = 0;
  let fetchCalls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken() {
        refreshTokenCalls += 1;
        return "refresh-token";
      },
    },
    fetchImpl: (async () => {
      fetchCalls += 1;
      await fetchGate;
      return new Response(JSON.stringify({ access_token: "shared-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const requests = Array.from({ length: 10 }, () =>
    provider.getAccessToken("A1SELLER", "user-1"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshTokenCalls, 10);
  assert.equal(fetchCalls, 1);
  releaseFetch();
  assert.deepEqual(await Promise.all(requests), Array(10).fill("shared-access"));
});

test("aborting one LWA waiter does not cancel or detach the shared exchange", async () => {
  let fetchCalls = 0;
  let exchangeSignal: AbortSignal | null | undefined;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async (_input, init) => {
      fetchCalls += 1;
      exchangeSignal = init?.signal;
      await fetchGate;
      return new Response(JSON.stringify({ access_token: "shared-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const reason = new DOMException("request budget exceeded", "TimeoutError");

  const cancelledWaiter = provider.getAccessToken(
    "A1SELLER",
    "user-1",
    false,
    controller.signal,
  );
  const survivingWaiter = provider.getAccessToken("A1SELLER", "user-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);

  const rejected = assert.rejects(cancelledWaiter, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  const lateWaiter = provider.getAccessToken("A1SELLER", "user-1");
  let survivingWaiterSettled = false;
  void survivingWaiter.then(
    () => { survivingWaiterSettled = true; },
    () => { survivingWaiterSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(survivingWaiterSettled, false);
  assert.equal(fetchCalls, 1);
  assert.equal(exchangeSignal?.aborted, false);

  releaseFetch();
  assert.equal(await survivingWaiter, "shared-access");
  assert.equal(await lateWaiter, "shared-access");
  assert.equal(fetchCalls, 1);
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "shared-access");
  assert.equal(fetchCalls, 1);
});

test("aborting one token-recovery waiter preserves the shared replacement exchange", async () => {
  let fetchCalls = 0;
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => {
      fetchCalls += 1;
      if (fetchCalls === 2) await recoveryGate;
      return new Response(JSON.stringify({
        access_token: fetchCalls === 1 ? "rejected-access" : "replacement-access",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assert.equal(
    await provider.getAccessToken("A1SELLER", "user-1"),
    "rejected-access",
  );
  const controller = new AbortController();
  const reason = new DOMException("request budget exceeded", "TimeoutError");
  const cancelledWaiter = provider.recoverAccessToken(
    "A1SELLER",
    "user-1",
    "rejected-access",
    controller.signal,
  );
  const survivingWaiter = provider.recoverAccessToken(
    "A1SELLER",
    "user-1",
    "rejected-access",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 2);

  const rejected = assert.rejects(cancelledWaiter, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  const lateWaiter = provider.recoverAccessToken(
    "A1SELLER",
    "user-1",
    "rejected-access",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 2);

  releaseRecovery();
  assert.equal(await survivingWaiter, "replacement-access");
  assert.equal(await lateWaiter, "replacement-access");
  assert.equal(fetchCalls, 2);
  assert.equal(
    await provider.getAccessToken("A1SELLER", "user-1"),
    "replacement-access",
  );
  assert.equal(fetchCalls, 2);
});

test("retries after a shared LWA exchange fails", async () => {
  let calls = 0;
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("temporary failure");
      return new Response(JSON.stringify({ access_token: "recovered", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const failed = await Promise.allSettled(Array.from({ length: 10 }, () =>
    provider.getAccessToken("A1SELLER", "user-1")));
  assert.ok(failed.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "recovered");
  assert.equal(calls, 2);
});

test("force refresh starts a new exchange instead of joining an older in-flight request", async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => {
      calls += 1;
      const call = calls;
      if (call === 1) await firstGate;
      return new Response(JSON.stringify({ access_token: `access-${call}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const ordinary = provider.getAccessToken("A1SELLER", "user-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1", true), "access-2");
  releaseFirst();
  assert.equal(await ordinary, "access-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-2");
  assert.equal(calls, 2);
});

test("persists rotated refresh tokens before publishing a new access token", async () => {
  const cas: Array<{ expectedRevision: number; newRefreshToken: string }> = [];
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken() { return "refresh-old"; },
      async getRefreshCredential() {
        return { refreshToken: "refresh-old", revision: 3 };
      },
      async compareAndSetRefreshToken(options) {
        cas.push({
          expectedRevision: options.expectedRevision,
          newRefreshToken: options.newRefreshToken,
        });
        return "updated";
      },
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      access_token: "access-new",
      expires_in: 3600,
      refresh_token: "refresh-new",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-new");
  assert.deepEqual(cas, [{ expectedRevision: 3, newRefreshToken: "refresh-new" }]);
  // Second call uses cache; no extra CAS.
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-new");
  assert.equal(cas.length, 1);
  assert.match(mcpMetrics.renderPrometheus(), /amazon_connected-account_lwa_refresh_rotation_total\{result="success"\} 1/);
});

test("does not publish access token when refresh token CAS conflicts", async () => {
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken() { return "refresh-old"; },
      async getRefreshCredential() {
        return { refreshToken: "refresh-old", revision: 1 };
      },
      async compareAndSetRefreshToken() {
        return "conflict";
      },
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      access_token: "access-should-not-cache",
      expires_in: 3600,
      refresh_token: "refresh-new",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    provider.getAccessToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_LWA",
  );
  assert.match(mcpMetrics.renderPrometheus(), /amazon_connected-account_lwa_refresh_rotation_total\{error_code="conflict",result="error"\} 1/);
});

test("shares one access token by credential identity across bound employee workspaces", async () => {
  let calls = 0;
  let revision = 4;
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken() { return "owner-refresh"; },
      async getRefreshCredential() {
        return {
          refreshToken: "owner-refresh",
          credentialId: "cred_shared",
          credentialOwnerId: "owner-workspace",
          revision,
        };
      },
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        access_token: `shared-access-${calls}`,
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  assert.equal(await provider.getAccessToken("A1SELLER", "employee-a-workspace"), "shared-access-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "employee-b-workspace"), "shared-access-1");
  assert.equal(calls, 1);
  revision = 5;
  assert.equal(await provider.getAccessToken("A1SELLER", "employee-b-workspace"), "shared-access-2");
  assert.equal(calls, 2);
});

test("does not share cached LWA access tokens across tenants", async () => {
  let calls = 0;
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken(_sellingPartnerId, tenantId) {
        return `refresh-${tenantId}`;
      },
    },
    fetchImpl: (async (_input, init) => {
      calls += 1;
      const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token");
      return new Response(JSON.stringify({ access_token: `access-${refreshToken}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-refresh-user-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-2"), "access-refresh-user-2");
  assert.equal(calls, 2);
});

test("force refresh bypasses a cached LWA access token", async () => {
  let calls = 0;
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken() {
        return "refresh-token";
      },
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: `access-${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1", true), "access-2");
  assert.equal(calls, 2);
});

test("returns a stable non-retryable error when LWA rejects a refresh token", async () => {
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    provider.getAccessToken("A1SELLER", "user-1"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_EXPIRED");
      assert.deepEqual(JSON.parse((error as Error).message), {
        code: "AUTH_EXPIRED",
        message: "LWA access token request failed with status 400",
        retryable: false,
        details: { status: 400 },
      });
      return true;
    },
  );
});

test("does not misclassify invalid LWA client credentials as an expired seller grant", async () => {
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_client" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    provider.getAccessToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_LWA",
  );
});

test("maps malformed LWA success responses to a stable upstream error", async () => {
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
  });

  await assert.rejects(
    provider.getAccessToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_LWA",
  );
});

test("maps LWA network failures to a retryable stable error", async () => {
  const logs: string[] = [];
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
  });

  await assert.rejects(
    provider.getAccessToken("A1SELLER", "user-1"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UPSTREAM_LWA");
      assert.equal((error as { retryable?: boolean }).retryable, true);
      assert.doesNotMatch((error as Error).message, /fetch failed/);
      return true;
    },
  );
  assert.equal(JSON.parse(logs[0]!).event, "lwa.refresh.failed");
  assert.equal(JSON.parse(logs[0]!).error_code, "lwa_failed");
});

test("does not repopulate an invalidated access token from an older in-flight exchange", async () => {
  let fetchCalls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: { async getRefreshToken() { return "refresh-token"; } },
    fetchImpl: (async () => {
      fetchCalls += 1;
      const call = fetchCalls;
      if (call === 1) await firstGate;
      return new Response(JSON.stringify({ access_token: `access-${call}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const staleRequest = provider.getAccessToken("A1SELLER", "user-1");
  await new Promise((resolve) => setImmediate(resolve));
  provider.invalidateAccessToken("A1SELLER", "user-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-2");
  releaseFirst();
  assert.equal(await staleRequest, "access-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-2");
  assert.equal(fetchCalls, 2);
});

test("invalidates only the matching tenant and seller access token", async () => {
  let calls = 0;
  const provider = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens: {
      async getRefreshToken(sellingPartnerId, tenantId) {
        return `refresh-${tenantId}-${sellingPartnerId}`;
      },
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: `access-${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-1");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-2"), "access-2");
  assert.equal(await provider.getAccessToken("A2SELLER", "user-1"), "access-3");

  provider.invalidateAccessToken("A1SELLER", "user-1");

  assert.equal(await provider.getAccessToken("A1SELLER", "user-1"), "access-4");
  assert.equal(await provider.getAccessToken("A1SELLER", "user-2"), "access-2");
  assert.equal(await provider.getAccessToken("A2SELLER", "user-1"), "access-3");
  assert.equal(calls, 4);
});
