import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createStructuredLogger } from "../src/logger.js";
import { mcpMetrics } from "../src/metrics.js";
import { SP_API_DOMAINS, SpApiCapabilityTracker } from "../src/sp-api-operations.js";
import {
  AmazonSpApiClient,
  SpApiError,
  type SpApiReader,
  type SpApiRequestOptions,
} from "../src/sp-api-client.js";
import { createAmazonMcpServer, type AmazonMcpServerOptions } from "../src/tools.js";

const principal = {
  authType: "connected-account" as const,
  tenantId: "jwt-employee:workspace",
  issuer: "https://connected-account.example",
  employeeId: "employee-1",
  kid: "provider-v1",
  expiresAt: "2026-07-28T10:00:00.000Z",
  scopes: new Set(["mcp:invoke"]),
};
const account = {
  connectionId: "con_0123456789abcdef",
  externalAccountId: "A1SELLER",
  providerKey: "amazon-sp-api" as const,
  displayName: "Amazon EU",
  status: "active" as const,
  metadata: { account_id: "acct_0123456789abcdef" },
};

function serverOptions(capabilityTracker = new SpApiCapabilityTracker()): AmazonMcpServerOptions {
  return {
    principal,
    capabilityTracker,
    accountAccessPolicy: {
      async listAccounts() { return [account]; },
      async resolveAccount(_principal: typeof principal, accountId: string) {
        if (accountId !== account.metadata.account_id) throw new Error("missing");
        return { account, credentialOwnerId: "credential-owner-workspace" };
      },
    },
  };
}

async function connectedClient(spApi: SpApiReader, options: AmazonMcpServerOptions = serverOptions()) {
  const server = createAmazonMcpServer(spApi, options);
  const client = new Client({ name: "amazon-read-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function parseToolError(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text).error as { code: string; detail?: string };
}

test("tools/list exposes only ConnectedAccount account lifecycle and frozen read tools", async () => {
  const { client, server } = await connectedClient({ async get() { return {}; } });
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 30);
    const names = tools.map((tool) => tool.name);
    for (const removed of [
      "amazon_create_authorization_url",
      "amazon_create_renewal_url",
      "amazon_list_connections",
      "amazon_disconnect_connection",
    ]) assert.ok(!names.includes(removed), removed);
    for (const required of [
      "amazon_get_read_capabilities",
      "amazon_catalog_read",
      "amazon_reports_read",
      "amazon_data_kiosk_read",
      "amazon_shipping_read",
      "amazon_services_read",
      "amazon_search_listings",
      "amazon_get_listing_item",
    ]) assert.ok(names.includes(required), required);
    for (const domain of SP_API_DOMAINS) {
      assert.ok(names.includes(`amazon_${domain}_read`), domain);
    }
    assert.doesNotMatch(JSON.stringify(tools.map((tool) => tool.inputSchema)), /sellingPartnerId|legacy|oat_/i);
    for (const domain of ["amazon_catalog_read", "amazon_orders_read", "amazon_reports_read"]) {
      const schema = tools.find((tool) => tool.name === domain)?.inputSchema as {
        properties?: { action?: { enum?: string[] } };
      };
      assert.ok((schema.properties?.action?.enum?.length ?? 0) > 0, domain);
    }
    const ordersTool = tools.find((tool) => tool.name === "amazon_orders_read");
    const ordersSchema = ordersTool?.inputSchema as {
      properties?: {
        account_id?: unknown;
        body?: unknown;
        query?: { properties?: Record<string, unknown> };
      };
    };
    assert.ok(ordersSchema.properties?.account_id);
    assert.ok(ordersSchema.properties?.query?.properties?.createdAfter);
    assert.ok(ordersSchema.properties?.query?.properties?.marketplaceIds);
    assert.ok(ordersSchema.properties?.query?.properties?.maxResultsPerPage);
    assert.equal(ordersSchema.properties?.body, undefined);
    assert.doesNotMatch(JSON.stringify(ordersSchema), /BUYER|RECIPIENT|PACKAGES|PAYMENT|TAX/);
    assert.match(ordersTool?.description ?? "", /searchOrders.*query.*omit body.*autoPage.*amazon_search_orders/i);
    const identitySchema = tools.find((tool) => tool.name === "amazon_get_identity")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(identitySchema.properties?.account_id);
    assert.ok(!identitySchema.required?.includes("account_id"));
    for (const tool of tools) {
      assert.ok(tool.outputSchema, tool.name);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean", tool.name);
    }
    const catalogOutput = tools.find((tool) => tool.name === "amazon_catalog_read")?.outputSchema as {
      required?: string[];
    };
    assert.ok(catalogOutput.required?.includes("data"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("executes a fixed catalog action and drops PII and model-unknown fields", async () => {
  let request: SpApiRequestOptions | undefined;
  const capabilityTracker = new SpApiCapabilityTracker();
  const spApi: SpApiReader = {
    async get() { return {}; },
    async request(options) {
      request = options;
      return {
        asin: "B000TEST01",
        summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: "Safe product" }],
        buyer: { buyerEmail: "secret@example.com" },
        unknownFromAmazon: "must be dropped",
      };
    },
  };
  const { client, server } = await connectedClient(spApi, serverOptions(capabilityTracker));
  try {
    const result = await client.callTool({
      name: "amazon_catalog_read",
      arguments: {
        action: "getCatalogItem",
        account_id: account.metadata.account_id,
        region: "na",
        path: { asin: "B000TEST01" },
        query: { marketplaceIds: ["ATVPDKIKX0DER"], includedData: ["summaries"] },
      },
    });
    assert.equal(request?.method, "GET");
    assert.equal(request?.path, "/catalog/2022-04-01/items/B000TEST01");
    assert.equal(request?.sellingPartnerId, "A1SELLER");
    assert.equal(request?.tenantId, "credential-owner-workspace");
    const serialized = JSON.stringify(result.structuredContent);
    assert.match(serialized, /B000TEST01/);
    assert.doesNotMatch(serialized, /secret@example|unknownFromAmazon|buyer/i);

    const capabilities = await client.callTool({
      name: "amazon_get_read_capabilities",
      arguments: { account_id: account.metadata.account_id, domain: "catalog" },
    });
    const item = (capabilities.structuredContent as { items: Array<{ operation: string; status: string }> })
      .items.find((entry) => entry.operation === "getCatalogItem");
    assert.equal(item?.status, "available");
  } finally {
    await client.close();
    await server.close();
  }
});

test("constructs generic Orders GET requests from query and rejects body or autoPage", async () => {
  let upstreamCalls = 0;
  let request: SpApiRequestOptions | undefined;
  const { client, server } = await connectedClient({
    async get() { return {}; },
    async request(options) {
      upstreamCalls += 1;
      request = options;
      return { orders: [] };
    },
  });
  const base = {
    action: "searchOrders",
    account_id: account.metadata.account_id,
    region: "na",
  };
  try {
    for (const arguments_ of [
      {
        ...base,
        body: {
          createdAfter: "2026-08-01T00:00:00.000Z",
          marketplaceIds: ["ATVPDKIKX0DER"],
        },
      },
      {
        ...base,
        query: {
          createdAfter: "2026-08-01T00:00:00.000Z",
          marketplaceIds: ["ATVPDKIKX0DER"],
          autoPage: false,
        },
      },
      {
        ...base,
        path: { orderId: "ORDER-1" },
        query: {
          createdAfter: "2026-08-01T00:00:00.000Z",
          marketplaceIds: ["ATVPDKIKX0DER"],
        },
      },
    ]) {
      const result = await client.callTool({ name: "amazon_orders_read", arguments: arguments_ });
      assert.equal(parseToolError(result).code, "invalid_tool_arguments");
    }
    assert.equal(upstreamCalls, 0);

    const valid = await client.callTool({
      name: "amazon_orders_read",
      arguments: {
        ...base,
        query: {
          createdAfter: "2026-08-01T00:00:00.000Z",
          createdBefore: "2026-08-02T00:00:00.000Z",
          marketplaceIds: ["ATVPDKIKX0DER"],
          maxResultsPerPage: 20,
        },
      },
    });
    assert.notEqual(valid.isError, true);
    assert.equal(upstreamCalls, 1);
    assert.equal(request?.method, "GET");
    assert.deepEqual(request?.query, {
      createdAfter: "2026-08-01T00:00:00.000Z",
      createdBefore: "2026-08-02T00:00:00.000Z",
      marketplaceIds: ["ATVPDKIKX0DER"],
      maxResultsPerPage: 20,
    });
    assert.equal(request?.body, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns completed order pages with a continuation token when the auto-page budget expires", async () => {
  let now = 1_000;
  let fetchCalls = 0;
  const logs: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "orders-budget-test",
    write(line) { logs.push(line); },
  });
  const { client, server } = await connectedClient({
    async get() {
      fetchCalls += 1;
      now += 25_000;
      return {
        orders: [{ orderId: `ORDER-${fetchCalls}` }],
        pagination: { nextToken: `secret-next-token-${fetchCalls}` },
      };
    },
  }, {
    ...serverOptions(),
    logger,
    now: () => now,
    searchOrdersBudgetMs: 50_000,
  });
  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
        autoPage: true,
      },
    });

    assert.notEqual(result.isError, true);
    assert.equal(fetchCalls, 2);
    assert.equal(now - 1_000, 50_000);
    assert.deepEqual(result.structuredContent, {
      items: [{ orderId: "ORDER-1" }, { orderId: "ORDER-2" }],
      pagination: { nextToken: "secret-next-token-2", hasMore: true },
    });
    const budgetLog = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.event === "mcp.pagination.budget_exhausted");
    assert.equal(budgetLog?.tool, "amazon_search_orders");
    assert.equal(budgetLog?.pages_completed, 2);
    assert.equal(budgetLog?.budget_ms, 50_000);
    assert.equal(budgetLog?.duration_ms, now - 1_000);
    assert.doesNotMatch(logs.join("\n"), /secret-next-token|A1SELLER|credential-owner/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns completed order pages when the next response body exceeds the auto-page budget", async () => {
  let fetchCalls = 0;
  let releaseBody!: (body: unknown) => void;
  const pendingBody = new Promise<unknown>((resolve) => { releaseBody = resolve; });
  const spApi = new AmazonSpApiClient({
    accessTokens: { async getAccessToken() { return "access-token"; } },
    fetchImpl: (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(JSON.stringify({
          orders: [{ orderId: "ORDER-1" }],
          pagination: { nextToken: "secret-next-token-1" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const response = new Response("", { status: 200 });
      Object.defineProperty(response, "json", { value: () => pendingBody });
      return response;
    }) as typeof fetch,
  });
  const { client, server } = await connectedClient(spApi, {
    ...serverOptions(),
    searchOrdersBudgetMs: 100,
  });

  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
        autoPage: true,
      },
    });

    assert.notEqual(result.isError, true);
    assert.equal(fetchCalls, 2);
    assert.deepEqual(result.structuredContent, {
      items: [{ orderId: "ORDER-1" }],
      pagination: { nextToken: "secret-next-token-1", hasMore: true },
    });
  } finally {
    releaseBody({ orders: [{ orderId: "ORDER-2" }] });
    await client.close();
    await server.close();
  }
});

test("returns an upstream error when the provider repeats a pagination token", async () => {
  let calls = 0;
  const { client, server } = await connectedClient({
    async get() {
      calls += 1;
      return {
        orders: [{ orderId: `ORDER-${calls}` }],
        pagination: { nextToken: "repeated-token" },
      };
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
        autoPage: true,
      },
    });

    assert.equal(result.isError, true);
    assert.equal(calls, 2);
    assert.equal(parseToolError(result).code, "upstream_error");
    assert.equal((result as { structuredContent?: unknown }).structuredContent, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("applies the total search budget to a single order page", async () => {
  const deadlines: Array<number | undefined> = [];
  const { client, server } = await connectedClient({
    async get(request) {
      deadlines.push(request.deadlineAt);
      return { orders: [] };
    },
  }, {
    ...serverOptions(),
    now: () => 5_000,
    searchOrdersBudgetMs: 50_000,
  });
  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
      },
    });

    assert.notEqual(result.isError, true);
    assert.deepEqual(deadlines, [55_000]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns timeout when the order auto-page budget expires before any page completes", async () => {
  let now = 2_000;
  let upstreamCalls = 0;
  const { client, server } = await connectedClient({
    async get() {
      upstreamCalls += 1;
      return { orders: [] };
    },
  }, {
    ...serverOptions(),
    accountAccessPolicy: {
      async listAccounts() { return [account]; },
      async resolveAccount() {
        now = 52_000;
        return { account, credentialOwnerId: "credential-owner-workspace" };
      },
    },
    now: () => now,
    searchOrdersBudgetMs: 50_000,
  });
  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
        autoPage: true,
      },
    });

    assert.equal(upstreamCalls, 0);
    const error = parseToolError(result);
    assert.equal(error.code, "timeout");
    assert.equal((result as { structuredContent?: unknown }).structuredContent, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("times out account resolution without dispatching a single-page order request", async () => {
  let upstreamCalls = 0;
  let policySignal: AbortSignal | undefined;
  const { client, server } = await connectedClient({
    async get() {
      upstreamCalls += 1;
      return { orders: [] };
    },
  }, {
    ...serverOptions(),
    searchOrdersBudgetMs: 20,
    accountAccessPolicy: {
      async listAccounts() { return [account]; },
      async resolveAccount(_principal, _accountId, signal) {
        policySignal = signal;
        return await new Promise(() => {});
      },
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
      },
    }, undefined, { timeout: 1_000 });

    assert.equal(parseToolError(result).code, "timeout");
    assert.equal(policySignal?.aborted, true);
    assert.equal(upstreamCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("propagates client cancellation through account resolution without dispatch", async () => {
  let upstreamCalls = 0;
  let observedAbort = false;
  const controller = new AbortController();
  const { client, server } = await connectedClient({
    async get() {
      upstreamCalls += 1;
      return { orders: [] };
    },
  }, {
    ...serverOptions(),
    searchOrdersBudgetMs: 1_000,
    accountAccessPolicy: {
      async listAccounts() { return [account]; },
      async resolveAccount(_principal, _accountId, signal) {
        signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
        return await new Promise(() => {});
      },
    },
  });
  try {
    const pending = client.callTool({
      name: "amazon_search_orders",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["A2EUQ1WTGCTBG2"],
        createdAfter: "2026-08-01T00:00:00.000Z",
      },
    }, undefined, { signal: controller.signal, timeout: 1_000 });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await assert.rejects(pending);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observedAbort, true);
    assert.equal(upstreamCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("counts account policy rejections without exposing account identity", async () => {
  const { client, server } = await connectedClient({ async get() { return {}; } });
  try {
    const result = await client.callTool({
      name: "amazon_get_read_capabilities",
      arguments: { account_id: "acct_ffffffffffffffff" },
    });
    assert.equal(parseToolError(result).code, "internal_error");
    const metrics = mcpMetrics.renderPrometheus();
    assert.match(metrics, /amazon_connected-account_account_access_rejections_total\{actor_type="connected-account",error_code="forbidden"\} 1/);
    assert.doesNotMatch(metrics, /acct_ffffffffffffffff|employee-1|workspace/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("rejects arbitrary actions and maps Amazon 403 to a required role", async () => {
  const { client, server } = await connectedClient({
    async get() { return {}; },
    async request() { throw new SpApiError(403, "raw Amazon error must not leak"); },
  });
  try {
    const arbitrary = await client.callTool({
      name: "amazon_catalog_read",
      arguments: {
        action: "deleteAnything",
        account_id: account.metadata.account_id,
        region: "na",
      },
    });
    assert.equal(parseToolError(arbitrary).code, "invalid_tool_arguments");

    const denied = await client.callTool({
      name: "amazon_catalog_read",
      arguments: {
        action: "getCatalogItem",
        account_id: account.metadata.account_id,
        region: "na",
        path: { asin: "B000TEST01" },
        query: { marketplaceIds: ["ATVPDKIKX0DER"] },
      },
    });
    const error = parseToolError(denied);
    assert.equal(error.code, "AMAZON_ROLE_REQUIRED");
    assert.match(error.detail ?? "", /operation=getCatalogItem.*Product Listing/);
    assert.doesNotMatch(JSON.stringify(denied), /raw Amazon error/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("business snapshot probes only regions requested by explicit marketplaces", async () => {
  const requests: Array<{
    region: string;
    path: string;
    query?: Record<string, unknown>;
  }> = [];
  const { client, server } = await connectedClient({
    async get(request) {
      requests.push(request);
      assert.equal(request.region, "na");
      if (request.path === "/sellers/v1/marketplaceParticipations") {
        return {
          payload: [{
            marketplace: { id: "ATVPDKIKX0DER" },
            participation: { isParticipating: true },
          }],
        };
      }
      assert.equal(request.path, "/orders/2026-01-01/orders");
      return { orders: [] };
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds: ["ATVPDKIKX0DER"],
        includeInventory: false,
        includeListings: false,
      },
    });

    assert.deepEqual(requests.map(({ region, path }) => ({ region, path })), [
      { region: "na", path: "/sellers/v1/marketplaceParticipations" },
      { region: "na", path: "/orders/2026-01-01/orders" },
    ]);
    assert.deepEqual(requests[1]?.query?.marketplaceIds, ["ATVPDKIKX0DER"]);
    assert.deepEqual(
      (result.structuredContent as { regions: string[] }).regions,
      ["na"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("business snapshot checks FBA Inventory only for documented NA stores", async () => {
  const marketplaceIds = [
    "ATVPDKIKX0DER",
    "A2EUQ1WTGCTBG2",
    "A1AM78C64UM0Y8",
    "A2Q3Y263D00KWC",
    "A2ZV50J4W1RKNI",
    "A3H6HPSLHAK3XG",
    "A1MQXOICRS2Z7M",
  ];
  const inventoryIds: string[] = [];
  const { client, server } = await connectedClient({
    async get(request) {
      if (request.path === "/sellers/v1/marketplaceParticipations") {
        return {
          payload: marketplaceIds.map((id) => ({
            marketplace: { id },
            participation: { isParticipating: true },
          })),
        };
      }
      if (request.path === "/orders/2026-01-01/orders") return { orders: [] };
      assert.equal(request.path, "/fba/inventory/v1/summaries");
      inventoryIds.push(String(request.query?.granularityId));
      return { payload: { inventorySummaries: [] } };
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds,
        includeInventory: true,
        includeListings: false,
      },
    });
    const output = result.structuredContent as {
      summary: string;
      marketplaces: { analyzedCount: number; marketplaceIds: string[] };
      inventory: { checkedMarketplaceCount: number; summaryCount: number; isEmpty: boolean | null };
    };
    assert.deepEqual(inventoryIds, marketplaceIds.slice(0, 4));
    assert.equal(output.marketplaces.analyzedCount, 7);
    assert.deepEqual(output.marketplaces.marketplaceIds, marketplaceIds);
    assert.equal(output.inventory.checkedMarketplaceCount, 4);
    assert.equal(output.inventory.summaryCount, 0);
    assert.equal(output.inventory.isEmpty, true);
    assert.match(output.summary, /4\/7/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("business snapshot makes no FBA request when selected marketplaces are unsupported", async () => {
  const marketplaceIds = ["A2ZV50J4W1RKNI", "A3H6HPSLHAK3XG", "A1MQXOICRS2Z7M"];
  let inventoryCalls = 0;
  const { client, server } = await connectedClient({
    async get(request) {
      if (request.path === "/sellers/v1/marketplaceParticipations") {
        return {
          payload: marketplaceIds.map((id) => ({
            marketplace: { id },
            participation: { isParticipating: true },
          })),
        };
      }
      if (request.path === "/orders/2026-01-01/orders") return { orders: [] };
      inventoryCalls += 1;
      return {};
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds,
        includeInventory: true,
        includeListings: false,
      },
    });
    const output = result.structuredContent as {
      summary: string;
      inventory: { checkedMarketplaceCount: number; isEmpty: boolean | null };
    };
    assert.equal(inventoryCalls, 0);
    assert.equal(output.inventory.checkedMarketplaceCount, 0);
    assert.equal(output.inventory.isEmpty, null);
    assert.match(output.summary, /0\/3/);
    assert.doesNotMatch(output.summary, /库存汇总为空/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("business snapshot checks Listings only for standard marketplaces", async () => {
  const marketplaceIds = [
    "ATVPDKIKX0DER",
    "A2EUQ1WTGCTBG2",
    "A1AM78C64UM0Y8",
    "A2Q3Y263D00KWC",
    "A2ZV50J4W1RKNI",
    "A3H6HPSLHAK3XG",
    "A1MQXOICRS2Z7M",
  ];
  const listingIds: string[] = [];
  const { client, server } = await connectedClient({
    async get(request) {
      if (request.path === "/sellers/v1/marketplaceParticipations") {
        return {
          payload: marketplaceIds.map((id) => ({
            marketplace: { id },
            participation: { isParticipating: true },
          })),
        };
      }
      if (request.path === "/orders/2026-01-01/orders") return { orders: [] };
      assert.match(request.path, /^\/listings\/2021-08-01\/items\//);
      listingIds.push(String((request.query?.marketplaceIds as string[] | undefined)?.[0]));
      return { items: [] };
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds,
        includeInventory: false,
        includeListings: true,
      },
    });
    const output = result.structuredContent as {
      summary: string;
      marketplaces: { analyzedCount: number };
      listings: { checkedMarketplaceCount: number; countsByMarketplace: unknown[] };
    };
    assert.deepEqual(listingIds, marketplaceIds.slice(0, 4));
    assert.equal(output.marketplaces.analyzedCount, 7);
    assert.equal(output.listings.checkedMarketplaceCount, 4);
    assert.equal(output.listings.countsByMarketplace.length, 4);
    assert.match(output.summary, /4\/7/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("business snapshot makes no Listings request when selected marketplaces are unsupported", async () => {
  const marketplaceIds = ["A2ZV50J4W1RKNI", "A3H6HPSLHAK3XG", "A1MQXOICRS2Z7M"];
  let listingCalls = 0;
  const { client, server } = await connectedClient({
    async get(request) {
      if (request.path === "/sellers/v1/marketplaceParticipations") {
        return {
          payload: marketplaceIds.map((id) => ({
            marketplace: { id },
            participation: { isParticipating: true },
          })),
        };
      }
      if (request.path === "/orders/2026-01-01/orders") return { orders: [] };
      listingCalls += 1;
      return {};
    },
  });
  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceIds,
        includeInventory: false,
        includeListings: true,
      },
    });
    const output = result.structuredContent as {
      summary: string;
      listings: {
        checkedMarketplaceCount: number;
        countsByMarketplace: unknown[];
        hasMore: boolean;
        paginationHint: string;
      };
    };
    assert.equal(listingCalls, 0);
    assert.equal(output.listings.checkedMarketplaceCount, 0);
    assert.deepEqual(output.listings.countsByMarketplace, []);
    assert.equal(output.listings.hasMore, false);
    assert.match(output.listings.paginationHint, /No selected marketplace supports Listings Items/);
    assert.match(output.summary, /0\/3.*未发起 Listings 请求/);
    assert.doesNotMatch(output.summary, /Listing 抽样为空/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("dedicated inventory tools reject unsupported marketplaces without an upstream request", async () => {
  let upstreamCalls = 0;
  const { client, server } = await connectedClient({
    async get() {
      upstreamCalls += 1;
      return {};
    },
  });
  try {
    for (const [name, arguments_] of [
      ["amazon_list_inventory_summaries", {}],
      ["amazon_get_inventory_by_sku", { sellerSku: "SKU-1" }],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: {
          account_id: account.metadata.account_id,
          marketplaceId: "A2ZV50J4W1RKNI",
          ...arguments_,
        },
      });
      assert.equal(parseToolError(result).code, "invalid_tool_arguments");
    }
    assert.equal(upstreamCalls, 0);

    const supported = await client.callTool({
      name: "amazon_get_inventory_by_sku",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceId: "ATVPDKIKX0DER",
        sellerSku: "SKU-1",
      },
    });
    assert.notEqual(supported.isError, true);
    assert.equal(upstreamCalls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("dedicated Listings tools reject nonstandard marketplaces without an upstream request", async () => {
  let upstreamCalls = 0;
  const { client, server } = await connectedClient({
    async get() {
      upstreamCalls += 1;
      return { items: [] };
    },
  });
  try {
    for (const [name, arguments_] of [
      ["amazon_search_listings", {}],
      ["amazon_get_listing_item", { sellerSku: "SKU-1" }],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: {
          account_id: account.metadata.account_id,
          marketplaceId: "A2ZV50J4W1RKNI",
          ...arguments_,
        },
      });
      assert.equal(parseToolError(result).code, "invalid_tool_arguments");
    }
    assert.equal(upstreamCalls, 0);

    const supported = await client.callTool({
      name: "amazon_search_listings",
      arguments: {
        account_id: account.metadata.account_id,
        marketplaceId: "ATVPDKIKX0DER",
      },
    });
    assert.notEqual(supported.isError, true);
    assert.equal(upstreamCalls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
