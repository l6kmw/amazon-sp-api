import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  READ_OPERATIONS,
  domainInputSchema,
  executeReadOperation,
  operationForAction,
  validateOperationInput,
  validateOperationPolicy,
} from "../src/sp-api-operations.js";

test("classifies every operation in the frozen 353-operation baseline", async () => {
  const coverage = JSON.parse(await readFile(
    new URL("../vendor/amazon-sp-api-models/operations.json", import.meta.url),
    "utf8",
  )) as {
    commit: string;
    operationCount: number;
    includedCount: number;
    operations: Array<{ included: boolean; reason: string; family: string; model: string }>;
  };
  assert.equal(coverage.commit, "6ad2ee14835a9aa31889ae5607ea4e1fcc90f3ad");
  assert.equal(coverage.operationCount, 353);
  assert.equal(coverage.operations.length, 353);
  assert.equal(coverage.includedCount, READ_OPERATIONS.length);
  assert.equal(READ_OPERATIONS.length, 93);
  assert.ok(coverage.operations.every((operation) => typeof operation.reason === "string" && operation.reason.length > 0));
  assert.ok(coverage.operations.filter((operation) => operation.family.startsWith("vendor-")).every((operation) => !operation.included));
  assert.ok(coverage.operations.filter((operation) => ["catalogItemsV0", "ordersV0", "financesV0"].includes(operation.model)).every((operation) => !operation.included));
  assert.ok(coverage.operations.filter((operation) => [
    "getDestination", "getDestinations", "getSubscriptionById",
  ].includes((operation as { operationId?: string }).operationId ?? "")).every((operation) => !operation.included));
  assert.ok(READ_OPERATIONS.every((operation) => !operation.roles.some((role) => /Restricted|Vendor|Payment Initiation|Account Information/.test(role))));

  const sellerAccount = operationForAction("seller", "getAccount");
  assert.deepEqual(sellerAccount.regions, ["eu"]);
  assert.deepEqual(sellerAccount.roles, ["Finance and Accounting"]);
  assert.deepEqual(operationForAction("inventory", "getInventorySummaries").roles, [
    "Amazon Fulfillment", "Product Listing",
  ]);
  assert.deepEqual(operationForAction("inventory", "getSupplySources").roles, ["Selling Partner Insights"]);
  assert.deepEqual(operationForAction("data_kiosk", "getQuery").roles, ["Brand Analytics"]);
});

test("generated domain schemas reject arbitrary paths, methods and write actions", () => {
  const schema = domainInputSchema("catalog");
  assert.throws(() => schema.parse({
    action: "deleteCatalogItem",
    account_id: "acct_0123456789abcdef",
    region: "na",
    path: { url: "https://attacker.example" },
  }));
  const forged = {
    action: "getCatalogItem",
    account_id: "acct_0123456789abcdef",
    region: "na",
    path: { asin: "B000TEST01", url: "https://attacker.example" },
    query: { marketplaceIds: ["ATVPDKIKX0DER"] },
  };
  assert.doesNotThrow(() => schema.parse(forged));
  assert.throws(() => validateOperationInput(operationForAction("catalog", "getCatalogItem"), forged));
  assert.throws(() => validateOperationInput(operationForAction("seller", "getAccount"), {
    action: "getAccount",
    account_id: "acct_0123456789abcdef",
    region: "na",
    path: {},
    query: {},
  }), /not available in the selected Amazon region/);
  const awd = operationForAction("warehousing", "listInboundShipments");
  const awdInput = {
    action: "listInboundShipments",
    account_id: "acct_0123456789abcdef",
    region: "eu" as const,
    path: {},
    query: { maxResults: 25 },
  };
  assert.doesNotThrow(() => validateOperationInput(awd, awdInput));
  assert.throws(() => validateOperationInput(awd, {
    ...awdInput,
    query: { maxResults: "25" },
  }));
});

test("Orders discovery and secondary validation keep GET filters in query", () => {
  const schema = domainInputSchema("orders");
  const search = {
    action: "searchOrders",
    account_id: "acct_0123456789abcdef",
    region: "na" as const,
    query: {
      createdAfter: "2026-08-01T00:00:00.000Z",
      marketplaceIds: ["ATVPDKIKX0DER"],
      maxResultsPerPage: 20,
    },
  };
  assert.doesNotThrow(() => schema.parse(search));
  assert.doesNotThrow(() => validateOperationInput(operationForAction("orders", "searchOrders"), search));
  assert.doesNotThrow(() => validateOperationInput(operationForAction("orders", "getOrder"), {
    action: "getOrder",
    account_id: "acct_0123456789abcdef",
    region: "na",
    path: { orderId: "ORDER-1" },
  }));

  for (const invalid of [
    { ...search, body: search.query },
    { ...search, query: { ...search.query, autoPage: false } },
    { ...search, path: { createdAfter: search.query.createdAfter } },
  ]) assert.throws(() => schema.parse(invalid));

  assert.throws(
    () => validateOperationInput(operationForAction("orders", "searchOrders"), {
      ...search,
      path: { orderId: "ORDER-1" },
    }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_FILTER",
  );
});

test("rejects Orders PII segments and unknown Data Kiosk schemas", () => {
  const orders = operationForAction("orders", "searchOrders");
  assert.throws(() => validateOperationPolicy(orders, {
    query: { includedData: ["BUYER"] },
  }), /PII data segments/);

  const dataKiosk = operationForAction("data_kiosk", "createQuery");
  const validQuery = `{ analytics_salesAndTraffic_2024_04_24 {
    salesAndTrafficByDate(
      aggregateBy: DAY
      startDate: "2026-07-01"
      endDate: "2026-07-02"
      marketplaceIds: ["ATVPDKIKX0DER"]
    ) { startDate endDate marketplaceId }
  } }`;
  assert.doesNotThrow(() => validateOperationPolicy(dataKiosk, { body: { query: validQuery } }));
  for (const query of [
    "mutation { anything }",
    "{ __schema { types { name } } }",
    "{ analytics_vendorAnalytics_2024_09_30 { sourcingView { asin } } }",
    "{ analytics_salesAndTraffic_2024_04_24 { unknownField } }",
  ]) assert.throws(() => validateOperationPolicy(dataKiosk, { body: { query } }));
});

test("enforces FBA Inventory marketplace support before an upstream request", async () => {
  let upstreamCalls = 0;
  const execute = (marketplaceId: string) => executeReadOperation({
    client: {
      async get() { return {}; },
      async request() {
        upstreamCalls += 1;
        return {};
      },
    },
    operation: operationForAction("inventory", "getInventorySummaries"),
    tenantId: "workspace-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na",
    input: {
      query: {
        details: false,
        granularityType: "Marketplace",
        granularityId: marketplaceId,
        marketplaceIds: [marketplaceId],
      },
    },
  });
  await assert.rejects(execute("A2ZV50J4W1RKNI"), /not supported by FBA Inventory/);
  assert.equal(upstreamCalls, 0);
  await execute("ATVPDKIKX0DER");
  assert.equal(upstreamCalls, 1);
});

test("enforces Listings marketplace support before every generic upstream request", async () => {
  let upstreamCalls = 0;
  const client = {
    async get() { return {}; },
    async request() {
      upstreamCalls += 1;
      return {};
    },
  };
  for (const action of ["getListingsItem", "searchListingsItems", "getListingsRestrictions"]) {
    await assert.rejects(executeReadOperation({
      client,
      operation: operationForAction("listings", action),
      tenantId: "tenant-1",
      accountId: "acct_0123456789abcdef",
      sellingPartnerId: "A1SELLER",
      region: "na",
      input: { query: { marketplaceIds: ["A2ZV50J4W1RKNI"] } },
    }), (error: unknown) => (error as { code?: string }).code === "INVALID_FILTER");
  }
  assert.equal(upstreamCalls, 0);

  await executeReadOperation({
    client,
    operation: operationForAction("listings", "searchListingsItems"),
    tenantId: "tenant-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na",
    input: { query: { marketplaceIds: ["ATVPDKIKX0DER"] } },
  });
  assert.equal(upstreamCalls, 1);
});

test("only explicitly allowlisted query POST/PUT/DELETE operations are callable", () => {
  const nonGet = READ_OPERATIONS.filter((operation) => operation.method !== "GET");
  assert.deepEqual(new Set(nonGet.map((operation) => operation.operationId)), new Set([
    "checkInboundEligibility",
    "validateContentDocumentAsinRelations",
    "getMyFeesEstimateForSKU",
    "getMyFeesEstimateForASIN",
    "getMyFeesEstimates",
    "getItemOffersBatch",
    "getListingOffersBatch",
    "getFeaturedOfferExpectedPriceBatch",
    "getCompetitiveSummary",
    "getSellingPartnerMetrics",
    "listOfferMetrics",
    "listOffers",
    "createQuery",
    "cancelQuery",
    "createReport",
    "cancelReport",
  ]));
  assert.equal(operationForAction("reports", "createReport").retry, "never_on_uncertain_failure");
  assert.equal(operationForAction("data_kiosk", "createQuery").retry, "never_on_uncertain_failure");
});

test("response policy removes seller identity, addresses, payment identifiers and document IDs", async () => {
  const invoke = (
    operation: ReturnType<typeof operationForAction>,
    response: unknown,
    input: { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown } = {
      path: {}, query: {},
    },
  ) => executeReadOperation({
    client: { async get() { return {}; }, async request() { return response; } },
    operation,
    tenantId: "workspace-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: operation.regions[0]!,
    input,
  });

  const seller = await invoke(operationForAction("seller", "getAccount"), {
    payload: {
      businessType: "PRIVATE_LIMITED",
      sellingPlan: "PROFESSIONAL",
      marketplaceParticipationList: [],
      business: { name: "Secret Ltd", registeredBusinessAddress: { city: "Secret" } },
      primaryContact: { name: "Secret Person", address: { city: "Secret" } },
    },
  });
  assert.deepEqual(seller, {
    payload: {
      marketplaceParticipationList: [],
      businessType: "PRIVATE_LIMITED",
      sellingPlan: "PROFESSIONAL",
    },
  });

  const finance = await invoke(operationForAction("finances", "listTransactions"), {
    payload: {
      transactions: [{
        transactionType: "Shipment",
        transactionStatus: "RELEASED",
        description: "Safe",
        postedDate: "2026-07-28T00:00:00Z",
        totalAmount: { currencyCode: "EUR", currencyAmount: 1 },
        contexts: [{ paymentMethod: "secret", paymentReference: "secret", storeName: "Safe store" }],
      }],
    },
  });
  assert.doesNotMatch(JSON.stringify(finance), /paymentMethod|paymentReference|secret/i);

  const report = await invoke(operationForAction("reports", "getReport"), {
    reportId: "report-1",
    reportType: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
    processingStatus: "DONE",
    createdTime: "2026-07-28T00:00:00Z",
    reportDocumentId: "document-secret",
  }, { path: { reportId: "report-1" } });
  assert.doesNotMatch(JSON.stringify(report), /document-secret|reportDocumentId/);
  await assert.rejects(
    invoke(operationForAction("reports", "getReport"), {
      reportId: "report-2",
      reportType: "GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL",
      processingStatus: "DONE",
      createdTime: "2026-07-28T00:00:00Z",
    }, { path: { reportId: "report-2" } }),
    /non-restricted Seller allowlist/,
  );
});

test("cancel operations preflight the temporary read job before changing its state", async () => {
  const calls: string[] = [];
  const client = {
    async get() { return {}; },
    async request(options: { operation: string }) {
      calls.push(options.operation);
      if (options.operation === "getReport") {
        return {
          reportId: "report-1",
          reportType: "GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL",
          processingStatus: "DONE",
          createdTime: "2026-07-28T00:00:00Z",
        };
      }
      return {};
    },
  };
  await assert.rejects(executeReadOperation({
    client,
    operation: operationForAction("reports", "cancelReport"),
    tenantId: "workspace-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na",
    input: { path: { reportId: "report-1" } },
  }), /non-restricted Seller allowlist/);
  assert.deepEqual(calls, ["getReport"]);
});
