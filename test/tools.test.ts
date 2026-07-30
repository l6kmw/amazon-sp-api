import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { mcpMetrics } from "../src/metrics.js";
import { SP_API_DOMAINS, SpApiCapabilityTracker } from "../src/sp-api-operations.js";
import { SpApiError, type SpApiReader, type SpApiRequestOptions } from "../src/sp-api-client.js";
import { createAmazonMcpServer } from "../src/tools.js";

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

function serverOptions(capabilityTracker = new SpApiCapabilityTracker()) {
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

async function connectedClient(spApi: SpApiReader, options = serverOptions()) {
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
