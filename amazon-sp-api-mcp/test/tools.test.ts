import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createAmazonMcpServer,
  InMemoryAmazonSellerRegionCache,
} from "../src/tools.js";
import { ConnectedAccountAccountError } from "../src/connected-account-accounts.js";
import { SpApiError, type SpApiReader } from "../src/sp-api-client.js";

function parseToolError(result: unknown): {
  code: string;
  tool: string;
  message: string;
  http_status: number;
  request_id: string;
  next_action: string;
  detail?: string;
} {
  const text = (result as { content: Array<{ text: string }>; structuredContent?: unknown })
    .content[0]!.text;
  const body = JSON.parse(text);
  assert.ok(body.error);
  assert.equal((result as { structuredContent?: unknown }).structuredContent, undefined);
  assert.equal(typeof body.error.request_id, "string");
  assert.ok(body.error.request_id.length >= 8);
  assert.equal(typeof body.error.next_action, "string");
  return body.error;
}

test("tools/list exposes complete annotations and outputSchema for every registered tool", async () => {
  const server = createAmazonMcpServer({ async get() { return {}; } }, {
    tenantId: "user-1",
    principal: { authType: "legacy", tenantId: "user-1" },
    enableListingsTools: true,
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "schema-list-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 16);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} missing outputSchema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean", tool.name);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("ConnectedAccount tools/list omits legacy connection tools and sellingPartnerId inputs", async () => {
  const server = createAmazonMcpServer({ async get() { return {}; } }, {
    tenantId: "jwt-employee:issuer:employee-1",
    principal: {
      authType: "connected-account",
      tenantId: "jwt-employee:issuer:employee-1",
      issuer: "example-issuer-prod",
      employeeId: "employee-1",
      kid: "provider-v1",
      expiresAt: "2026-07-22T00:00:00.000Z",
      scopes: new Set(["mcp:invoke"]),
    },
    enableListingsTools: true,
    connected-accountAccounts: {
      async listAccounts() { return []; },
      async resolveAccount() {
        throw new ConnectedAccountAccountError(404, "not_found", "missing");
      },
    },
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() { return []; },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "connected-account-catalog-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const forbidden of [
      "amazon_create_authorization_url",
      "amazon_create_renewal_url",
      "amazon_list_connections",
      "amazon_disconnect_connection",
    ]) {
      assert.ok(!names.includes(forbidden), forbidden);
    }
    assert.ok(names.includes("amazon_connection_health"));
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.ok(!("sellingPartnerId" in properties), tool.name);
      if (tool.name !== "amazon_get_identity" && tool.name !== "amazon_list_accounts") {
        // account-scoped tools require account_id for ConnectedAccount
        if (Object.keys(properties).length > 0 || tool.name.startsWith("amazon_")) {
          // tools with no account selector stay empty-input
        }
      }
    }
    const search = tools.find((tool) => tool.name === "amazon_search_orders");
    assert.ok(search);
    assert.ok("account_id" in ((search.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}));
    assert.ok(!("sellingPartnerId" in ((search.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})));
  } finally {
    await client.close();
    await server.close();
  }
});

test("exposes seven tenant-scoped read-only tools and strips PII from order output", async () => {
  const calls: Array<{ path: string; query?: unknown; tenantId?: string }> = [];
  const spApi: SpApiReader = {
    async get(options) {
      calls.push({ path: options.path, query: options.query, tenantId: options.tenantId });
      return {
        order: {
          orderId: "123-1234567-1234567",
          buyer: { buyerName: "Hidden Buyer", buyerEmail: "hidden@example.com" },
          recipient: { deliveryAddress: { addressLine1: "Hidden Street", phone: "123" } },
          orderItems: [{ orderItemId: "item-1", product: { sellerSku: "SKU-1" } }],
        },
      };
    },
  };

  const server = createAmazonMcpServer(spApi, {
    tenantId: "user-1",
    principal: { authType: "legacy", tenantId: "user-1" },
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const instructions = client.getInstructions();
    assert.match(instructions ?? "", /amazon_list_connections/);
    assert.match(instructions ?? "", /amazon_create_authorization_url/);
    assert.match(instructions ?? "", /sellingPartnerId/);
    assert.match(instructions ?? "", /createdAfter.*lastUpdatedAfter/);
    assert.match(instructions ?? "", /ISO-8601/);
    assert.match(instructions ?? "", /na\/eu\/fe/);
    assert.match(instructions ?? "", /PII/);
    assert.match(instructions ?? "", /confirmDisconnect=DISCONNECT/);
    assert.match(instructions ?? "", /浏览器.*10 分钟.*一次性/);

    const tools = await client.listTools();
    assert.equal(tools.tools.length, 14);
    const dataTools = tools.tools.filter((tool) => !tool.name.includes("authorization") &&
      !tool.name.includes("renewal") && !tool.name.includes("connections") &&
      !tool.name.includes("disconnect") && tool.name !== "amazon_connection_health" &&
      tool.name !== "amazon_get_identity" && tool.name !== "amazon_list_accounts");
    assert.equal(dataTools.length, 7);
    assert.ok(dataTools.every((tool) => tool.annotations?.readOnlyHint === true));
    const descriptions = Object.fromEntries(
      tools.tools.map((tool) => [tool.name, tool.description ?? ""]),
    );
    assert.match(descriptions.amazon_list_marketplaces ?? "", /Omit region.*includes region/);
    assert.match(descriptions.amazon_search_orders ?? "", /exactly one of createdAfter or lastUpdatedAfter/);
    assert.match(descriptions.amazon_search_orders ?? "", /30-day or smaller window/);
    assert.match(descriptions.amazon_search_orders ?? "", /paginationToken.*previous response/);
    assert.match(descriptions.amazon_list_inventory_summaries ?? "", /FBA only.*FBM.*empty result is normal/);

    const identityTool = tools.tools.find((tool) => tool.name === "amazon_get_identity");
    const accountsTool = tools.tools.find((tool) => tool.name === "amazon_list_accounts");
    assert.ok(identityTool?.outputSchema);
    assert.ok(accountsTool?.outputSchema);
    const identity = await client.callTool({ name: "amazon_get_identity", arguments: {} });
    assert.equal(identity.isError, undefined);
    assert.match(JSON.stringify(identity.structuredContent), /legacy_agent/);
    assert.doesNotMatch(JSON.stringify(identity), /user-1/);
    const accounts = await client.callTool({ name: "amazon_list_accounts", arguments: {} });
    assert.equal(accounts.isError, undefined);
    assert.match(JSON.stringify(accounts.structuredContent), /acct_/);
    assert.doesNotMatch(JSON.stringify(accounts), /refresh|token|tenant/i);

    const searchOrders = tools.tools.find((tool) => tool.name === "amazon_search_orders");
    assert.deepEqual(
      Object.keys((searchOrders?.inputSchema.properties ?? {}) as Record<string, unknown>),
      [
        "sellingPartnerId",
        "marketplaceIds",
        "createdAfter",
        "createdBefore",
        "lastUpdatedAfter",
        "lastUpdatedBefore",
        "fulfillmentStatuses",
        "fulfilledBy",
        "maxResultsPerPage",
        "paginationToken",
        "autoPage",
      ],
    );

    const invalidSearch = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceIds: ["ATVPDKIKX0DER"],
      },
    });
    assert.equal(invalidSearch.isError, true);
    const invalidSearchError = parseToolError(invalidSearch);
    assert.equal(invalidSearchError.code, "invalid_tool_arguments");
    assert.equal(invalidSearchError.http_status, 400);
    assert.equal(calls.length, 0);

    const invalidSchema = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceIds: ["invalid-marketplace"],
        createdAfter: "not-a-timestamp",
      },
    });
    assert.equal(invalidSchema.isError, true);
    const invalidSchemaError = parseToolError(invalidSchema);
    assert.equal(invalidSchemaError.code, "invalid_tool_arguments");
    assert.equal(invalidSchemaError.tool, "amazon_search_orders");
    assert.equal(invalidSchemaError.http_status, 400);
    assert.equal(calls.length, 0);

    const result = await client.callTool({
      name: "amazon_get_order",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceId: "ATVPDKIKX0DER",
        orderId: "123-1234567-1234567",
      },
    });
    const content = (result as { content: Array<{ text: string }> }).content;
    const text = content[0]!.text;
    assert.doesNotMatch(text, /Hidden Buyer|hidden@example|Hidden Street|"recipient"/);
    assert.match(text, /SKU-1/);
    assert.equal(calls[0]?.path, "/orders/2026-01-01/orders/123-1234567-1234567");

    await client.callTool({
      name: "amazon_list_marketplaces",
      arguments: { sellingPartnerId: "A1SELLER", region: "na" },
    });
    await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdAfter: "2026-07-01T00:00:00Z",
      },
    });
    await client.callTool({
      name: "amazon_list_order_items",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceId: "ATVPDKIKX0DER",
        orderId: "123-1234567-1234567",
      },
    });
    await client.callTool({
      name: "amazon_list_inventory_summaries",
      arguments: { sellingPartnerId: "A1SELLER", marketplaceId: "ATVPDKIKX0DER" },
    });
    await client.callTool({
      name: "amazon_get_inventory_by_sku",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceId: "ATVPDKIKX0DER",
        sellerSku: "SKU-1",
      },
    });
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => call.tenantId === "user-1"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("requires and authorizes account_id for every ConnectedAccount business tool", async () => {
  const accountId = "acct_1234567890abcdef";
  const seller = "A1CONNECTED_ACCOUNTSELLER";
  const spApiCalls: Array<{ path: string; sellingPartnerId: string }> = [];
  const resolvedAccountIds: string[] = [];
  const principal = {
    authType: "connected-account" as const,
    tenantId: "jwt-employee:example-issuer-prod:employee-1",
    issuer: "example-issuer-prod",
    employeeId: "employee-1",
    kid: "provider-v1",
    expiresAt: "2026-07-21T10:05:00.000Z",
    scopes: new Set(["mcp:invoke"]),
  };
  const account = {
    connectionId: "con_1234567890abcdef",
    externalAccountId: seller,
    providerKey: "amazon-sp-api" as const,
    displayName: `Amazon seller ${seller}`,
    status: "active" as const,
    metadata: { account_id: accountId },
  };
  const server = createAmazonMcpServer({
    async get(options) {
      spApiCalls.push({ path: options.path, sellingPartnerId: options.sellingPartnerId });
      if (options.path === "/sellers/v1/marketplaceParticipations") {
        return { payload: [] };
      }
      return {};
    },
  }, {
    tenantId: principal.tenantId,
    principal,
    enableListingsTools: true,
    connected-accountAccounts: {
      listAccounts() { return [account]; },
      resolveAccount(_actor, value) {
        resolvedAccountIds.push(value);
        if (value !== accountId) {
          throw new ConnectedAccountAccountError(404, "not_found", "Account not found");
        }
        return account;
      },
    },
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() { throw new Error("ConnectedAccount business tools must not use legacy connections"); },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "connected-account-account-selector-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const businessArguments: Record<string, Record<string, unknown>> = {
    amazon_list_marketplaces: { region: "na" },
    amazon_business_snapshot: {},
    amazon_search_orders: {
      marketplaceIds: ["ATVPDKIKX0DER"],
      createdAfter: "2026-07-01T00:00:00Z",
    },
    amazon_get_order: {
      marketplaceId: "ATVPDKIKX0DER",
      orderId: "123-1234567-1234567",
    },
    amazon_list_order_items: {
      marketplaceId: "ATVPDKIKX0DER",
      orderId: "123-1234567-1234567",
    },
    amazon_list_inventory_summaries: { marketplaceId: "ATVPDKIKX0DER" },
    amazon_search_listings: { marketplaceId: "ATVPDKIKX0DER" },
    amazon_get_listing_item: { marketplaceId: "ATVPDKIKX0DER", sellerSku: "SKU-1" },
    amazon_get_inventory_by_sku: { marketplaceId: "ATVPDKIKX0DER", sellerSku: "SKU-1" },
    amazon_connection_health: { region: "na" },
  };

  try {
    const tools = await client.listTools();
    for (const name of Object.keys(businessArguments)) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be registered`);
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      assert.ok("account_id" in properties, `${name} must expose account_id`);
      assert.ok(!("sellingPartnerId" in properties), `${name} must hide sellingPartnerId`);
      assert.ok(tool.inputSchema.required?.includes("account_id"), `${name} must require account_id`);

      const denied = await client.callTool({
        name,
        arguments: { ...businessArguments[name], account_id: "acct_ffffffffffffffff" },
      });
      assert.equal(denied.isError, true, `${name} must reject an unowned account`);
      const deniedError = parseToolError(denied);
      assert.equal(deniedError.code, "resource_not_found", name);
      assert.equal(deniedError.http_status, 404, name);
      assert.equal(spApiCalls.length, 0, `${name} must not call SP-API when ownership fails`);
    }

    const legacySelector = await client.callTool({
      name: "amazon_get_order",
      arguments: {
        ...businessArguments.amazon_get_order,
        sellingPartnerId: seller,
      },
    });
    assert.equal(legacySelector.isError, true);
    assert.equal(spApiCalls.length, 0);

    const allowed = await client.callTool({
      name: "amazon_get_order",
      arguments: { ...businessArguments.amazon_get_order, account_id: accountId },
    });
    assert.equal(allowed.isError, undefined);
    assert.deepEqual(spApiCalls, [{
      path: "/orders/2026-01-01/orders/123-1234567-1234567",
      sellingPartnerId: seller,
    }]);
    assert.equal(resolvedAccountIds.at(-1), accountId);
  } finally {
    await client.close();
    await server.close();
  }
});

test("summarizes an empty EU 11-marketplace account without PII or exact-total claims", async () => {
  const marketplaceIds = [
    "A1F83G8C2ARO7P",
    "A1PA6795UKMFR9",
    "A13V1IB3VIYZZH",
    "APJ6JRA9NG5V4",
    "A1RKKUPIHCS9HS",
    "A28R8C7NBKEWEA",
    "A1805IZSGTT6HS",
    "A2NODRKZP88ZB9",
    "A1C3SOZRARQ6R3",
    "A33AVAJ2PDY3EV",
    "A17E79C6D8DWNP",
  ];
  const calls: Array<{ path: string; region: string; query?: unknown }> = [];
  const server = createAmazonMcpServer({
    async get(options) {
      calls.push({ path: options.path, region: options.region, query: options.query });
      if (options.path === "/sellers/v1/marketplaceParticipations") {
        if (options.region !== "eu") throw new SpApiError(403, "wrong region");
        return {
          payload: marketplaceIds.map((id) => ({
            marketplace: { id, name: "Hidden name is not needed" },
            participation: { isParticipating: true },
          })),
        };
      }
      if (options.path === "/orders/2026-01-01/orders") {
        return { orders: [], buyer: { buyerEmail: "hidden@example.com" } };
      }
      if (options.path === "/fba/inventory/v1/summaries") {
        return { payload: { inventorySummaries: [] }, privateNote: "hidden" };
      }
      throw new Error(`unexpected path ${options.path}`);
    },
  }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "snapshot-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: { lookbackDays: 30 },
    });
    assert.equal(result.isError, undefined);
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    assert.deepEqual(body, {
      summary: "EU 区域，11 个参与站点；近 30 天抽样中未发现订单记录，FBA 库存汇总为空，未检查 Listings。订单为抽样结果，不代表精确总数；Listings 未检查；如需订单明细，请调用 amazon_search_orders；如需库存明细，请调用 amazon_list_inventory_summaries。",
      connectionStatus: "ok",
      sellingPartnerId: "A1SELLER",
      region: "eu",
      regions: ["eu"],
      lookbackDays: 30,
      marketplaces: {
        participatingCount: 11,
        analyzedCount: 11,
        marketplaceIds,
        truncated: false,
      },
      orders: {
        ordersSampled: 0,
        hasOrders: false,
        firstPageCount: 0,
        paginationHint: "Only bounded first pages were sampled; exact totals require paginated amazon_search_orders or an asynchronous job.",
      },
      inventory: {
        included: true,
        checkedMarketplaceCount: 11,
        marketplacesWithInventory: 0,
        summaryCount: 0,
        isEmpty: true,
      },
      listings: {
        included: false,
        checkedMarketplaceCount: 0,
        sampleListingCount: 0,
        marketplacesWithListings: 0,
        buyableSampleCount: 0,
        issueSampleCount: 0,
        hasMore: false,
        countsByMarketplace: [],
        paginationHint: "Listings were not requested; set includeListings=true after enabling the Listings feature flag.",
      },
      dataBoundary: "Read-only operational summary. No buyer or recipient datasets are requested, and no buyer, recipient, address, payment, tracking, or other PII is returned; order totals are sampled, not exact. Listings are not included.",
    });
    assert.doesNotMatch(JSON.stringify(body), /hidden@example|Hidden name|privateNote/);
    assert.deepEqual(calls.map((call) => call.path), [
      "/sellers/v1/marketplaceParticipations",
      "/sellers/v1/marketplaceParticipations",
      "/sellers/v1/marketplaceParticipations",
      "/orders/2026-01-01/orders",
      ...Array(11).fill("/fba/inventory/v1/summaries"),
    ]);
    const orderQuery = calls.find((call) => call.path.includes("/orders/"))?.query as {
      marketplaceIds: string[];
      maxResultsPerPage: number;
      createdAfter: string;
    };
    assert.deepEqual(orderQuery.marketplaceIds, marketplaceIds);
    assert.equal(orderQuery.maxResultsPerPage, 1);
    assert.match(orderQuery.createdAfter, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("snapshot merges participating marketplaces across regions and charges each internal call", async () => {
  const marketplacesByRegion: Record<string, string> = {
    na: "ATVPDKIKX0DER",
    eu: "A1F83G8C2ARO7P",
    fe: "A1VC38T7YXB528",
  };
  const calls: Array<{ region: string; path: string }> = [];
  const chargedTenants: string[] = [];
  const server = createAmazonMcpServer({
    async get(options) {
      calls.push({ region: options.region, path: options.path });
      if (options.path === "/sellers/v1/marketplaceParticipations") {
        return {
          payload: [{
            marketplace: { id: marketplacesByRegion[options.region] },
            participation: { isParticipating: true },
          }],
        };
      }
      if (options.path === "/orders/2026-01-01/orders") {
        return { orders: [{ orderId: `ORDER-${options.region}` }] };
      }
      throw new Error(`unexpected path ${options.path}`);
    },
  }, {
    tenantId: "user-1",
    chargeSpApiCall(tenantId) { chargedTenants.push(tenantId); },
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "multi-region-snapshot-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: { includeInventory: false },
    });
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    assert.deepEqual(body.regions, ["na", "eu", "fe"]);
    assert.deepEqual(body.marketplaces.marketplaceIds, Object.values(marketplacesByRegion));
    assert.equal(body.marketplaces.participatingCount, 3);
    assert.equal(body.orders.ordersSampled, 3);
    assert.equal(
      body.summary,
      "NA、EU、FE 区域，3 个参与站点；近 30 天抽样中发现 3 条订单记录，未检查 FBA 库存，未检查 Listings。订单为抽样结果，不代表精确总数；Listings 未检查；如需订单明细，请调用 amazon_search_orders；如需库存状态，请重新调用 amazon_business_snapshot 并设置 includeInventory=true。",
    );
    assert.deepEqual(body.inventory, {
      included: false,
      checkedMarketplaceCount: 0,
      marketplacesWithInventory: 0,
      summaryCount: 0,
      isEmpty: null,
    });
    assert.equal(calls.length, 6);
    assert.deepEqual(chargedTenants, Array(6).fill("user-1"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("optionally adds bounded per-marketplace Listing diagnostics to the snapshot", async () => {
  const marketplaceIds = ["ATVPDKIKX0DER", "A1F83G8C2ARO7P"];
  const listingCalls: Array<{ region: string; query?: Record<string, unknown> }> = [];
  const chargedTenants: string[] = [];
  const server = createAmazonMcpServer({
    async get(options) {
      if (options.path === "/sellers/v1/marketplaceParticipations") {
        const id = options.region === "na"
          ? marketplaceIds[0]
          : options.region === "eu"
            ? marketplaceIds[1]
            : undefined;
        if (!id) throw new SpApiError(403, "wrong region");
        return { payload: [{ marketplace: { id }, participation: { isParticipating: true } }] };
      }
      if (options.path === "/orders/2026-01-01/orders") return { orders: [] };
      if (options.path === "/listings/2021-08-01/items/A1SELLER") {
        listingCalls.push({ region: options.region, query: options.query });
        return options.region === "na"
          ? {
              numberOfResults: 21,
              items: [
                { sku: "SKU-1", summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }] },
                { sku: "SKU-2", summaries: [{ status: ["INACTIVE"] }], issues: [{ code: "ISSUE-1", message: "private" }] },
                ...Array.from({ length: 18 }, (_, index) => ({
                  sku: `SKU-${index + 3}`,
                  summaries: [{ status: ["INACTIVE"] }],
                })),
                {
                  sku: "SKU-21-SECRET",
                  summaries: [{ status: ["BUYABLE"] }],
                  issues: [{ code: "OUTSIDE-SAMPLE", message: "outside-private" }],
                  attributes: { secret: "outside-secret" },
                  offers: [{ price: "100.00" }],
                },
              ],
              pagination: { nextToken: "MORE" },
              attributes: { secret: "drop" },
            }
          : { numberOfResults: 0, items: [] };
      }
      throw new Error(`unexpected path ${options.path}`);
    },
  }, {
    tenantId: "user-1",
    enableListingsTools: true,
    chargeSpApiCall(tenantId) { chargedTenants.push(tenantId); },
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "snapshot-listings-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: { includeInventory: false, includeListings: true },
    });
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    assert.deepEqual(body.listings, {
      included: true,
      checkedMarketplaceCount: 2,
      sampleListingCount: 20,
      marketplacesWithListings: 1,
      buyableSampleCount: 1,
      issueSampleCount: 1,
      hasMore: true,
      countsByMarketplace: [
        { marketplaceId: "ATVPDKIKX0DER", sampleListingCount: 20, buyableSampleCount: 1, issueSampleCount: 1, hasMore: true },
        { marketplaceId: "A1F83G8C2ARO7P", sampleListingCount: 0, buyableSampleCount: 0, issueSampleCount: 0, hasMore: false },
      ],
      paginationHint: "Only the first 20 Listings per marketplace were sampled; use amazon_search_listings for details and pagination.",
    });
    assert.match(body.summary, /Listing 抽样发现 20 个刊登，其中 1 个可购买，1 个含问题代码/);
    assert.match(body.summary, /amazon_search_listings/);
    assert.match(body.dataBoundary, /Listings are sampled/);
    assert.doesNotMatch(JSON.stringify(body), /private|attributes|offers|secret|SKU-/);
    assert.equal(listingCalls.length, 2);
    assert.deepEqual(chargedTenants, Array(7).fill("user-1"));
    assert.ok(listingCalls.every((call) => call.query?.pageSize === 20));
    assert.ok(listingCalls.every((call) => JSON.stringify(call.query?.includedData) === JSON.stringify(["summaries", "issues"])));
  } finally {
    await client.close();
    await server.close();
  }
});

test("rejects includeListings unless Listings tools are enabled", async () => {
  let spApiCalls = 0;
  const server = createAmazonMcpServer({ async get() { spApiCalls += 1; return {}; } }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "snapshot-listings-disabled-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "amazon_business_snapshot",
      arguments: { includeListings: true },
    });
    assert.equal(result.isError, true);
    const error = parseToolError(result);
    assert.equal(error.code, "invalid_tool_arguments");
    assert.equal(error.http_status, 400);
    assert.equal(spApiCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("keeps pagination manual by default and caps automatic pagination at five pages", async () => {
  const calls: Array<{ path: string; token?: string }> = [];
  const server = createAmazonMcpServer({
    async get(options) {
      const query = options.query ?? {};
      const token = (query.paginationToken ?? query.nextToken) as string | undefined;
      calls.push({ path: options.path, token });
      if (options.path === "/orders/2026-01-01/orders") {
        const page = token ? Number(token.slice(1)) + 1 : 1;
        return {
          orders: [{ orderId: `ORDER-${page}` }],
          pagination: { nextToken: `O${page}` },
        };
      }
      if (options.path === "/fba/inventory/v1/summaries") {
        return {
          payload: {
            granularity: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER" },
            inventorySummaries: [{ sellerSku: token ? "SKU-2" : "SKU-1" }],
          },
          pagination: token ? {} : { nextToken: "I1" },
        };
      }
      throw new Error(`unexpected path ${options.path}`);
    },
  }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "pagination-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const manual = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdAfter: "2026-07-01T00:00:00Z",
      },
    });
    assert.deepEqual(
      JSON.parse((manual as { content: Array<{ text: string }> }).content[0]!.text),
      {
        items: [{ orderId: "ORDER-1" }],
        pagination: { nextToken: "O1", hasMore: true },
      },
    );
    assert.deepEqual(
      (manual as { structuredContent?: unknown }).structuredContent,
      {
        items: [{ orderId: "ORDER-1" }],
        pagination: { nextToken: "O1", hasMore: true },
      },
    );

    const automatic = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdAfter: "2026-07-01T00:00:00Z",
        autoPage: true,
      },
    });
    const automaticBody = JSON.parse(
      (automatic as { content: Array<{ text: string }> }).content[0]!.text,
    );
    assert.deepEqual(
      automaticBody.items.map((order: { orderId: string }) => order.orderId),
      ["ORDER-1", "ORDER-2", "ORDER-3", "ORDER-4", "ORDER-5"],
    );
    assert.deepEqual(automaticBody.pagination, { nextToken: "O5", hasMore: true });

    const inventory = await client.callTool({
      name: "amazon_list_inventory_summaries",
      arguments: { marketplaceId: "ATVPDKIKX0DER", autoPage: true },
    });
    const inventoryBody = JSON.parse(
      (inventory as { content: Array<{ text: string }> }).content[0]!.text,
    );
    assert.deepEqual(
      inventoryBody.items.map((item: { sellerSku: string }) => item.sellerSku),
      ["SKU-1", "SKU-2"],
    );
    assert.deepEqual(inventoryBody.pagination, { hasMore: false });
    assert.deepEqual(calls.map((call) => call.token), [
      undefined,
      undefined,
      "O1",
      "O2",
      "O3",
      "O4",
      undefined,
      "I1",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("stops automatic pagination when Amazon repeats or cycles a continuation token", async () => {
  const calls: string[] = [];
  const tokenResponses: Record<string, string> = {
    FIRST: "A",
    A: "B",
    B: "A",
  };
  const server = createAmazonMcpServer({
    async get(options) {
      const token = String(options.query?.paginationToken ?? "FIRST");
      calls.push(token);
      return {
        orders: [{ orderId: `ORDER-${token}` }],
        pagination: { nextToken: tokenResponses[token] },
      };
    },
  }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "pagination-cycle-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_search_orders",
      arguments: {
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdAfter: "2026-07-01T00:00:00Z",
        autoPage: true,
      },
    });
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    assert.deepEqual(calls, ["FIRST", "A", "B"]);
    assert.deepEqual(
      body.items.map((order: { orderId: string }) => order.orderId),
      ["ORDER-FIRST", "ORDER-A", "ORDER-B"],
    );
    assert.deepEqual(body.pagination, { hasMore: false });
  } finally {
    await client.close();
    await server.close();
  }
});

test("registers feature-gated Listings tools and safely routes search and get", async () => {
  const calls: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const server = createAmazonMcpServer({
    async get(options) {
      calls.push({ path: options.path, query: options.query });
      const listing = {
        sku: "SKU / 1",
        summaries: [{
          marketplaceId: "ATVPDKIKX0DER",
          asin: "B000TEST01",
          status: ["BUYABLE"],
          itemName: "Safe listing",
        }],
        issues: [{
          code: "ISSUE-1",
          severity: "ERROR",
          categories: ["INVALID_ATTRIBUTE"],
          attributeNames: ["item_name"],
          message: "private localized message",
        }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: "AMAZON_NA", quantity: 2 }],
        attributes: { buyerEmail: "hidden@example.com" },
      };
      if (options.path === "/listings/2021-08-01/items/A1SELLER") {
        return { numberOfResults: 1, items: [listing], pagination: { nextToken: "NEXT" } };
      }
      return listing;
    },
  }, {
    tenantId: "user-1",
    enableListingsTools: true,
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "listings-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "amazon_search_listings"));
    assert.ok(tools.tools.some((tool) => tool.name === "amazon_get_listing_item"));
    assert.ok(tools.tools.filter((tool) => tool.name.includes("listing")).every(
      (tool) => tool.annotations?.readOnlyHint === true,
    ));
    for (const name of [
      "amazon_list_marketplaces",
      "amazon_business_snapshot",
      "amazon_search_orders",
      "amazon_get_order",
      "amazon_list_order_items",
      "amazon_list_inventory_summaries",
      "amazon_search_listings",
      "amazon_get_listing_item",
      "amazon_get_inventory_by_sku",
      "amazon_connection_health",
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be registered`);
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      assert.ok("sellingPartnerId" in properties, `${name} must keep sellingPartnerId`);
      assert.ok(!("account_id" in properties), `${name} must not expose account_id`);
      assert.ok(!tool.inputSchema.required?.includes("sellingPartnerId"));
    }

    const search = await client.callTool({
      name: "amazon_search_listings",
      arguments: {
        marketplaceId: "ATVPDKIKX0DER",
        sellerSkus: ["SKU / 1"],
        pageSize: 20,
        pageToken: "PAGE-1",
      },
    });
    const searchText = (search as { content: Array<{ text: string }> }).content[0]!.text;
    assert.match(searchText, /B000TEST01|ISSUE-1|AMAZON_NA/);
    assert.doesNotMatch(searchText, /private localized|hidden@example|attributes/);
    assert.deepEqual(JSON.parse(searchText).pagination, { nextToken: "NEXT", hasMore: true });

    const get = await client.callTool({
      name: "amazon_get_listing_item",
      arguments: { marketplaceId: "ATVPDKIKX0DER", sellerSku: "SKU / 1" },
    });
    assert.equal(get.isError, undefined);
    assert.deepEqual(calls, [
      {
        path: "/listings/2021-08-01/items/A1SELLER",
        query: {
          marketplaceIds: ["ATVPDKIKX0DER"],
          includedData: ["summaries", "issues", "fulfillmentAvailability"],
          sellerSkus: ["SKU / 1"],
          pageSize: 20,
          pageToken: "PAGE-1",
        },
      },
      {
        path: "/listings/2021-08-01/items/A1SELLER/SKU%20%2F%201",
        query: {
          marketplaceIds: ["ATVPDKIKX0DER"],
          includedData: ["summaries", "issues", "fulfillmentAvailability"],
        },
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("keeps Listings tools unregistered when their feature flag is disabled", async () => {
  const server = createAmazonMcpServer({ async get() { return {}; } }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() { return []; },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "listings-disabled-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("amazon_search_listings"));
    assert.ok(!names.includes("amazon_get_listing_item"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("exposes standalone tenant-bound connection management tools", async () => {
  const calls: Array<{ action: string; tenantId: string; sellingPartnerId?: string }> = [];
  const server = createAmazonMcpServer(
    { async get() { return {}; } },
    {
      tenantId: "user-1",
      sellerCentralManageURL: "https://sellercentral-europe.amazon.com/apps/manage",
      connections: {
        async createAuthorizationURL(tenantId) {
          calls.push({ action: "create", tenantId });
          return "https://api.example.com/oauth/amazon/start?intent=opaque";
        },
        async createRenewalURL(tenantId) {
          calls.push({ action: "renew", tenantId });
          return "https://api.example.com/oauth/amazon/renew?intent=opaque";
        },
        async listConnections(tenantId) {
          calls.push({ action: "list", tenantId });
          return [{ sellingPartnerId: "A1EXAMPLE", authorizedAt: "2026-07-17T10:00:00Z" }];
        },
        async disconnect(tenantId, seller) {
          calls.push({ action: "disconnect", tenantId, sellingPartnerId: seller });
        },
      },
    },
  );
  const client = new Client({ name: "management-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 14);
    for (const name of [
      "amazon_connection_health",
      "amazon_create_authorization_url",
      "amazon_create_renewal_url",
      "amazon_list_connections",
      "amazon_disconnect_connection",
    ]) {
      assert.ok(tools.tools.some((tool) => tool.name === name));
    }
    const descriptions = Object.fromEntries(
      tools.tools.map((tool) => [tool.name, tool.description ?? ""]),
    );
    assert.match(descriptions.amazon_connection_health ?? "", /first troubleshooting step.*reuse a valid LWA access token/);
    assert.match(descriptions.amazon_create_renewal_url ?? "", /existing connection.*first-time.*MD1000/);
    assert.match(descriptions.amazon_disconnect_connection ?? "", /Only delete.*local refresh token.*Amazon-side revocation/);

    const authorization = await client.callTool({
      name: "amazon_create_authorization_url",
      arguments: {},
    });
    assert.match(JSON.stringify(authorization), /api\.example\.cn\/oauth\/amazon\/start/);
    const renewal = await client.callTool({
      name: "amazon_create_renewal_url",
      arguments: {},
    });
    assert.match(JSON.stringify(renewal), /api\.example\.cn\/oauth\/amazon\/renew/);
    const connections = await client.callTool({ name: "amazon_list_connections", arguments: {} });
    assert.match(JSON.stringify(connections), /A1EXAMPLE/);

    const unconfirmed = await client.callTool({
      name: "amazon_disconnect_connection",
      arguments: { sellingPartnerId: "A1EXAMPLE", confirmDisconnect: "" },
    });
    assert.equal(unconfirmed.isError, true);
    const disconnected = await client.callTool({
      name: "amazon_disconnect_connection",
      arguments: { sellingPartnerId: "A1EXAMPLE", confirmDisconnect: "DISCONNECT" },
    });
    assert.equal(disconnected.isError, undefined);
    assert.match(JSON.stringify(disconnected), /"amazonAuthorizationRevoked":false/);
    assert.match(
      JSON.stringify(disconnected),
      /https:\/\/sellercentral-europe\.amazon\.com\/apps\/manage/,
    );
    assert.match(
      JSON.stringify(disconnected),
      /Open https:\/\/sellercentral-europe\.amazon\.com\/apps\/manage and disable this app/,
    );
    assert.deepEqual(calls, [
      { action: "create", tenantId: "user-1" },
      { action: "renew", tenantId: "user-1" },
      { action: "list", tenantId: "user-1" },
      { action: "disconnect", tenantId: "user-1", sellingPartnerId: "A1EXAMPLE" },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("auto-selects one seller, discovers its region, and reuses tokens for health checks", async () => {
  const calls: Array<{
    sellingPartnerId: string;
    tenantId?: string;
    region: string;
  }> = [];
  const spApi: SpApiReader = {
    async get(options) {
      calls.push(options);
      if (options.region === "na") throw new SpApiError(403, "wrong region");
      return { payload: [{ marketplace: { id: "A1EXAMPLE" } }] };
    },
  };
  const connections = {
    async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
    async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
    async listConnections() {
      return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
    },
    async disconnect() {},
  };
  const server = createAmazonMcpServer(spApi, { tenantId: "user-1", connections });
  const client = new Client({ name: "automatic-selection-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const marketplaces = await client.callTool({ name: "amazon_list_marketplaces", arguments: {} });
    assert.equal(marketplaces.isError, undefined);
    const health = await client.callTool({ name: "amazon_connection_health", arguments: {} });
    assert.equal(health.isError, undefined);
    const healthContent = (health as { content: Array<{ text: string }> }).content;
    const healthBody = JSON.parse(healthContent[0]!.text);
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.region, "eu");
    assert.equal(healthBody.marketplaceCount, 1);
    // Without a region cache, health reuses the same probe order and never force-refreshes.
    assert.deepEqual(calls.map((call) => ({
      seller: call.sellingPartnerId,
      tenant: call.tenantId,
      region: call.region,
    })), [
      { seller: "A1SELLER", tenant: "user-1", region: "na" },
      { seller: "A1SELLER", tenant: "user-1", region: "eu" },
      { seller: "A1SELLER", tenant: "user-1", region: "na" },
      { seller: "A1SELLER", tenant: "user-1", region: "eu" },
    ]);
    assert.ok(!JSON.stringify(calls).includes("forceTokenRefresh"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("reuses a tenant-scoped seller region and invalidates it after a failed health check", async () => {
  const regions: string[] = [];
  let rejectCachedRegion = false;
  const spApi: SpApiReader = {
    async get(options) {
      regions.push(options.region);
      if (options.region === "na") throw new SpApiError(403, "wrong region");
      if (rejectCachedRegion && options.region === "eu") {
        throw new SpApiError(403, "seller region changed");
      }
      return { payload: [] };
    },
  };
  const connections = {
    async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
    async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
    async listConnections() {
      return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
    },
    async disconnect() {},
  };
  const regionCache = new InMemoryAmazonSellerRegionCache();
  const server = createAmazonMcpServer(spApi, {
    tenantId: "user-1",
    connections,
    regionCache,
  });
  const client = new Client({ name: "region-cache-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await client.callTool({ name: "amazon_list_marketplaces", arguments: {} });
    await client.callTool({ name: "amazon_list_marketplaces", arguments: {} });
    assert.deepEqual(regions, ["na", "eu", "eu"]);

    rejectCachedRegion = true;
    const failedMarketplace = await client.callTool({
      name: "amazon_list_marketplaces",
      arguments: {},
    });
    assert.equal(failedMarketplace.isError, true);
    assert.equal(regionCache.get("user-1", "A1SELLER"), undefined);

    rejectCachedRegion = false;
    await client.callTool({ name: "amazon_list_marketplaces", arguments: {} });
    rejectCachedRegion = true;
    const health = await client.callTool({ name: "amazon_connection_health", arguments: {} });
    assert.equal(health.isError, true);
    assert.equal(regionCache.get("user-1", "A1SELLER"), undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("normalizes unknown tool failures without exposing their messages", async () => {
  const server = createAmazonMcpServer({
    async get() {
      throw new Error("sensitive internal implementation detail");
    },
  }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "unknown-error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_get_order",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceId: "ATVPDKIKX0DER",
        orderId: "123-1234567-1234567",
      },
    });
    assert.equal(result.isError, true);
    const error = parseToolError(result);
    assert.equal(error.code, "internal_error");
    assert.equal(error.http_status, 500);
    assert.equal(error.detail, undefined);
    assert.doesNotMatch(JSON.stringify(result), /sensitive internal implementation detail/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns stable retry guidance for SP-API throttling", async () => {
  const server = createAmazonMcpServer({
    async get() {
      throw new SpApiError(429, "Amazon SP-API request failed: QuotaExceeded", "request-1");
    },
  }, {
    tenantId: "user-1",
    connections: {
      async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
      async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
      async listConnections() {
        return [{ sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" }];
      },
      async disconnect() {},
    },
  });
  const client = new Client({ name: "upstream-error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_get_order",
      arguments: {
        sellingPartnerId: "A1SELLER",
        marketplaceId: "ATVPDKIKX0DER",
        orderId: "123-1234567-1234567",
      },
    });
    assert.equal(result.isError, true);
    const error = parseToolError(result);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.http_status, 429);
    assert.equal(error.request_id, "request-1");
    assert.match(error.detail ?? "", /upstream_status=429|retry_after/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("refreshes a missing seller before enforcing tenant connection ownership", async () => {
  const connectionCalls: Array<{ tenantId: string; forceRefresh: boolean }> = [];
  const spApiCalls: string[] = [];
  const server = createAmazonMcpServer(
    {
      async get(options) {
        spApiCalls.push(options.sellingPartnerId);
        return { payload: [] };
      },
    },
    {
      tenantId: "tenant-a",
      connections: {
        async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
        async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
        async listConnections(tenantId, forceRefresh = false) {
          connectionCalls.push({ tenantId, forceRefresh });
          return [{ sellingPartnerId: "SELLER-A", authorizedAt: "2026-07-20T00:00:00Z" }];
        },
        async disconnect() {},
      },
    },
  );
  const client = new Client({ name: "seller-ownership-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const forbidden = await client.callTool({
      name: "amazon_list_marketplaces",
      arguments: { sellingPartnerId: "SELLER-B", region: "na" },
    });
    assert.equal(forbidden.isError, true);
    const forbiddenError = parseToolError(forbidden);
    assert.equal(forbiddenError.code, "resource_not_found");
    assert.equal(forbiddenError.http_status, 404);
    assert.deepEqual(connectionCalls, [
      { tenantId: "tenant-a", forceRefresh: false },
      { tenantId: "tenant-a", forceRefresh: true },
    ]);
    assert.deepEqual(spApiCalls, []);

    const allowed = await client.callTool({
      name: "amazon_list_marketplaces",
      arguments: { sellingPartnerId: "SELLER-A", region: "na" },
    });
    assert.equal(allowed.isError, undefined);
    assert.deepEqual(connectionCalls, [
      { tenantId: "tenant-a", forceRefresh: false },
      { tenantId: "tenant-a", forceRefresh: true },
      { tenantId: "tenant-a", forceRefresh: false },
    ]);
    assert.deepEqual(spApiCalls, ["SELLER-A"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("sees a newly authorized seller after a cached empty connection list", async () => {
  const connectionCalls: boolean[] = [];
  const spApiCalls: string[] = [];
  const server = createAmazonMcpServer(
    {
      async get(options) {
        spApiCalls.push(options.sellingPartnerId);
        return { payload: [] };
      },
    },
    {
      tenantId: "tenant-a",
      connections: {
        async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
        async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
        async listConnections(_tenantId, forceRefresh = false) {
          connectionCalls.push(forceRefresh);
          return forceRefresh
            ? [{ sellingPartnerId: "SELLER-NEW", authorizedAt: "2026-07-22T00:00:00Z" }]
            : [];
        },
        async disconnect() {},
      },
    },
  );
  const client = new Client({ name: "authorization-cache-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "amazon_list_marketplaces",
      arguments: { region: "na" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(connectionCalls, [false, true]);
    assert.deepEqual(spApiCalls, ["SELLER-NEW"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("does not guess a seller without exactly one tenant connection", async () => {
  let spApiCalls = 0;
  let availableConnections = [
    { sellingPartnerId: "A1SELLER", authorizedAt: "2026-07-20T00:00:00Z" },
    { sellingPartnerId: "A2SELLER", authorizedAt: "2026-07-20T00:00:00Z" },
  ];
  const server = createAmazonMcpServer(
    { async get() { spApiCalls += 1; return {}; } },
    {
      tenantId: "user-1",
      connections: {
        async createAuthorizationURL() { return "https://api.example.com/oauth/amazon/start"; },
        async createRenewalURL() { return "https://api.example.com/oauth/amazon/renew"; },
        async listConnections() {
          return availableConnections;
        },
        async disconnect() {},
      },
    },
  );
  const client = new Client({ name: "multiple-connections-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({ name: "amazon_list_marketplaces", arguments: {} });
    assert.equal(result.isError, true);
    const sellerRequired = parseToolError(result);
    assert.equal(sellerRequired.code, "invalid_tool_arguments");
    assert.equal(sellerRequired.http_status, 400);
    availableConnections = [];
    const noConnection = await client.callTool({
      name: "amazon_list_marketplaces",
      arguments: {},
    });
    assert.equal(noConnection.isError, true);
    const missing = parseToolError(noConnection);
    assert.equal(missing.code, "resource_not_found");
    assert.equal(missing.http_status, 404);
    assert.equal(spApiCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
