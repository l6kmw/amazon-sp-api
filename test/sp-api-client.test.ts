import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AmazonSpApiClient,
  regionForMarketplace,
  regionForMarketplaces,
} from "../src/sp-api-client.js";
import { createStructuredLogger } from "../src/logger.js";

test("routes marketplace requests, serializes arrays, and retries throttling", async () => {
  const urls: string[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const tokenCalls: Array<{ sellingPartnerId: string; tenantId?: string; forceRefresh?: boolean }> = [];
  let calls = 0;
  const client = new AmazonSpApiClient({
    accessTokens: {
      async getAccessToken(sellingPartnerId, tenantId, forceRefresh) {
        tokenCalls.push({ sellingPartnerId, tenantId, forceRefresh });
        return "access-token";
      },
    },
    fetchImpl: (async (input, init) => {
      calls += 1;
      urls.push(String(input));
      assert.equal(new Headers(init?.headers).get("x-amz-access-token"), "access-token");
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
  });

  const response = await client.get({
    sellingPartnerId: "A1SELLER",
    tenantId: "user-1",
    region: regionForMarketplace("ATVPDKIKX0DER"),
    path: "/orders/2026-01-01/orders",
    query: { marketplaceIds: ["ATVPDKIKX0DER"], maxResultsPerPage: 25 },
  });

  assert.deepEqual(response, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(tokenCalls, [{
    sellingPartnerId: "A1SELLER",
    tenantId: "user-1",
    forceRefresh: undefined,
  }]);
  assert.deepEqual(waits, [2000]);
  assert.match(urls[0]!, /^https:\/\/sellingpartnerapi-na\.amazon\.com/);
  assert.match(urls[0]!, /marketplaceIds=ATVPDKIKX0DER/);
  assert.equal(logs.length, 2);
  assert.ok(logs.some((line) => line.includes('"event":"sp_api.request.completed"')));
  assert.ok(logs.some((line) => line.includes('"event":"sp_api.request.failed"')));
  assert.doesNotMatch(logs.join("\n"), /access-token|A1SELLER|user-1/);
});

test("retries transport failures only for safe operations", async () => {
  let safeCalls = 0;
  const waits: number[] = [];
  const client = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => {
      safeCalls += 1;
      if (safeCalls < 3) throw new Error("network");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(await client.request({
    sellingPartnerId: "A1SELLER",
    tenantId: "workspace-1",
    region: "na",
    operation: "getCatalogItem",
    method: "GET",
    path: "/catalog/2022-04-01/items/B000TEST01",
    retryMode: "safe",
  }), { ok: true });
  assert.equal(safeCalls, 3);
  assert.deepEqual(waits, [1000, 2000]);

  let createCalls = 0;
  const noReplay = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => {
      createCalls += 1;
      throw new Error("uncertain failure");
    }) as typeof fetch,
    sleep: async () => { throw new Error("must not wait"); },
  });
  await assert.rejects(noReplay.request({
    sellingPartnerId: "A1SELLER",
    tenantId: "workspace-1",
    region: "na",
    operation: "createReport",
    method: "POST",
    path: "/reports/2021-06-30/reports",
    body: { reportType: "GET_FLAT_FILE_OPEN_LISTINGS_DATA" },
    retryMode: "never",
  }));
  assert.equal(createCalls, 1);
});

test("adapts request spacing to Amazon operation usage-plan headers", async () => {
  const waits: number[] = [];
  const client = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "x-amzn-ratelimit-limit": "2" },
    })) as typeof fetch,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  const request = () => client.request({
    sellingPartnerId: "A1SELLER",
    tenantId: "workspace-1",
    region: "na" as const,
    operation: "getCatalogItem",
    method: "GET" as const,
    path: "/catalog/2022-04-01/items/B000TEST01",
    retryMode: "safe" as const,
  });
  await request();
  await request();
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! > 0 && waits[0]! <= 500);
});

test("recovers once from clear Amazon Unauthorized access-token failures", async () => {
  const tokenCalls: Array<{ force?: boolean; recover?: boolean; rejected?: string }> = [];
  let calls = 0;
  const client = new AmazonSpApiClient({
    accessTokens: {
      async getAccessToken(_seller, _tenant, forceRefresh) {
        tokenCalls.push({ force: forceRefresh });
        return forceRefresh ? "access-token-2" : "access-token-1";
      },
      async recoverAccessToken(_seller, _tenant, rejected) {
        tokenCalls.push({ recover: true, rejected });
        return "access-token-2";
      },
    },
    fetchImpl: (async (_input, init) => {
      calls += 1;
      const token = new Headers(init?.headers).get("x-amz-access-token");
      if (token === "access-token-1") {
        return new Response(JSON.stringify({
          errors: [{ code: "Unauthorized", message: "The access token you provided is expired" }],
        }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.get({
    sellingPartnerId: "A1SELLER",
    tenantId: "user-1",
    region: "na",
    path: "/sellers/v1/marketplaceParticipations",
  }), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(tokenCalls, [
    { force: undefined },
    { recover: true, rejected: "access-token-1" },
  ]);
});

test("does not force-refresh on non-token 403/404/429/5xx failures", async () => {
  for (const fixture of [
    {
      status: 403,
      body: { errors: [{ code: "InvalidInput", message: "missing role" }] },
    },
    {
      status: 404,
      body: { errors: [{ code: "NotFound", message: "missing" }] },
    },
    {
      status: 429,
      body: { errors: [{ code: "QuotaExceeded", message: "slow down" }] },
    },
    {
      status: 503,
      body: { errors: [{ code: "ServerError", message: "busy" }] },
    },
  ] as const) {
    const tokenCalls: boolean[] = [];
    let recoverCalls = 0;
    let calls = 0;
    const client = new AmazonSpApiClient({
      accessTokens: {
        async getAccessToken(_s, _t, force) {
          tokenCalls.push(Boolean(force));
          return "access-token";
        },
        async recoverAccessToken() {
          recoverCalls += 1;
          return "access-token-new";
        },
      },
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify(fixture.body), {
          status: fixture.status,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }) as typeof fetch,
      sleep: async () => {},
    });

    await assert.rejects(client.get({
      sellingPartnerId: "A1SELLER",
      tenantId: "user-1",
      region: "na",
      path: "/orders/2026-01-01/orders",
    }));
    assert.equal(recoverCalls, 0, `status ${fixture.status}`);
    assert.ok(tokenCalls.every((force) => force === false), `status ${fixture.status}`);
    assert.ok(calls >= 1);
  }
});

test("stops after a second token-invalid response without refresh loops", async () => {
  let recoverCalls = 0;
  let calls = 0;
  const client = new AmazonSpApiClient({
    accessTokens: {
      async getAccessToken() { return "token-a"; },
      async recoverAccessToken() {
        recoverCalls += 1;
        return "token-b";
      },
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        errors: [{ code: "Unauthorized", message: "expired" }],
      }), { status: 403, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  await assert.rejects(client.get({
    sellingPartnerId: "A1SELLER",
    tenantId: "user-1",
    region: "na",
    path: "/sellers/v1/marketplaceParticipations",
  }));
  assert.equal(recoverCalls, 1);
  assert.equal(calls, 2);
});

test("identifies Listings Items operations without logging seller IDs or SKUs", async () => {
  const logs: string[] = [];
  const client = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch,
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
  });

  await client.get({
    sellingPartnerId: "A1SELLER",
    tenantId: "user-1",
    region: "na",
    path: "/listings/2021-08-01/items/A1SELLER/SKU-SECRET",
    query: { marketplaceIds: ["ATVPDKIKX0DER"] },
  });
  assert.equal(JSON.parse(logs[0]!).operation, "get_listing_item");
  assert.doesNotMatch(logs[0]!, /A1SELLER|SKU-SECRET|user-1/);
});

test("rejects marketplace lists that cross Amazon regions", () => {
  assert.throws(
    () => regionForMarketplaces(["ATVPDKIKX0DER", "A1F83G8C2ARO7P"]),
    (error: unknown) => (error as { code?: string }).code === "REGION_MISMATCH",
  );
});

test("maps SP-API request validation failures without exposing Amazon error text", async () => {
  for (const status of [400, 413, 415]) {
    const client = new AmazonSpApiClient({
      accessTokens: { async getAccessToken() { return "access-token"; } },
      fetchImpl: (async () => new Response(JSON.stringify({
        errors: [{ code: "InvalidInput", message: "BadSKU buyer@example.com" }],
      }), {
        status,
        headers: { "content-type": "application/json", "x-amzn-requestid": "safe-request-id" },
      })) as typeof fetch,
    });

    await assert.rejects(
      client.get({
        sellingPartnerId: "A1SELLER",
        tenantId: "user-1",
        region: "na",
        path: "/listings/2021-08-01/items/A1SELLER",
        query: { marketplaceIds: ["ATVPDKIKX0DER"] },
      }),
      (error: unknown) => {
        const value = error as { code?: string; retryable?: boolean; details?: unknown; message?: string };
        assert.equal(value.code, "INVALID_FILTER");
        assert.equal(value.retryable, false);
        assert.deepEqual(value.details, { status, requestId: "safe-request-id" });
        assert.doesNotMatch(value.message ?? "", /BadSKU|buyer@example/);
        return true;
      },
    );
  }
});

test("keeps Listings permission and not-found failures distinguishable by safe status", async () => {
  for (const status of [403, 404]) {
    const client = new AmazonSpApiClient({
      accessTokens: { async getAccessToken() { return "access-token"; } },
      fetchImpl: (async () => new Response(JSON.stringify({
        errors: [{ code: "Unauthorized", message: "private upstream context" }],
      }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });

    await assert.rejects(
      client.get({
        sellingPartnerId: "A1SELLER",
        tenantId: "user-1",
        region: "na",
        path: "/listings/2021-08-01/items/A1SELLER/SKU",
        query: { marketplaceIds: ["ATVPDKIKX0DER"] },
      }),
      (error: unknown) => {
        const value = error as { code?: string; retryable?: boolean; details?: { status?: number }; message?: string };
        assert.equal(value.code, "UPSTREAM_SP_API");
        assert.equal(value.retryable, false);
        assert.equal(value.details?.status, status);
        assert.doesNotMatch(value.message ?? "", /private upstream context/);
        return true;
      },
    );
  }
});

test("maps SP-API network failures to a retryable stable error", async () => {
  const logs: string[] = [];
  const client = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    logger: createStructuredLogger({
      hashKey: "internal-secret",
      write(line) { logs.push(line); },
    }),
  });

  await assert.rejects(
    client.get({
      sellingPartnerId: "A1SELLER",
      tenantId: "user-1",
      region: "na",
      path: "/sellers/v1/marketplaceParticipations",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UPSTREAM_SP_API");
      assert.equal((error as { retryable?: boolean }).retryable, true);
      assert.doesNotMatch((error as Error).message, /fetch failed/);
      return true;
    },
  );
  assert.equal(JSON.parse(logs[0]!).event, "sp_api.request.failed");
  assert.equal(JSON.parse(logs[0]!).error_code, "timeout");
});

test("maps malformed SP-API success responses to a stable upstream error", async () => {
  const client = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
  });

  await assert.rejects(
    client.get({
      sellingPartnerId: "A1SELLER",
      tenantId: "user-1",
      region: "na",
      path: "/sellers/v1/marketplaceParticipations",
    }),
    (error: unknown) => (error as { code?: string }).code === "UPSTREAM_SP_API",
  );
});

test("routes Ireland and Belgium marketplaces to the EU endpoint", () => {
  assert.equal(regionForMarketplace("A28R8C7NBKEWEA"), "eu");
  assert.equal(regionForMarketplace("AMEN7PMS3EDWL"), "eu");
});
