import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listMarketplacesOutputSchema,
  searchOrdersOutputSchema,
  toGetOrderOutput,
  toInventoryOutput,
  toMarketplacesOutput,
  toOrderItemsOutput,
  toSearchOrdersOutput,
} from "../src/tool-schemas.js";

test("normalizes projected marketplaces into closed items list", () => {
  // Converters consume safe-output projections only; unknown fields are stripped earlier.
  const output = toMarketplacesOutput({
    region: "eu",
    payload: [{
      marketplace: { id: "A1", name: "UK" },
      participation: { isParticipating: true },
    }],
  });
  assert.deepEqual(output, {
    region: "eu",
    items: [{
      marketplace: { id: "A1", name: "UK" },
      participation: { isParticipating: true },
    }],
  });
  assert.equal(listMarketplacesOutputSchema.safeParse(output).success, true);
  assert.equal(
    listMarketplacesOutputSchema.safeParse({ ...output, tenantId: "x" }).success,
    false,
  );
});

test("normalizes orders and inventory list shapes to items + pagination", () => {
  const orders = toSearchOrdersOutput({
    orders: [{ orderId: "O1" }],
    pagination: { nextToken: "N1", hasMore: true },
    createdBefore: "2026-07-01T00:00:00Z",
  });
  assert.deepEqual(orders, {
    items: [{ orderId: "O1" }],
    pagination: { nextToken: "N1", hasMore: true },
    createdBefore: "2026-07-01T00:00:00Z",
  });
  assert.equal(searchOrdersOutputSchema.safeParse(orders).success, true);
  assert.equal(
    searchOrdersOutputSchema.safeParse({ ...orders, grantId: "x" }).success,
    false,
  );

  const inventory = toInventoryOutput({
    payload: {
      granularity: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER" },
      inventorySummaries: [{ sellerSku: "SKU-1", totalQuantity: 3 }],
    },
    pagination: { hasMore: false },
  });
  assert.deepEqual(inventory, {
    items: [{ sellerSku: "SKU-1", totalQuantity: 3 }],
    granularity: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER" },
    pagination: { hasMore: false },
  });
});

test("unwraps single-order and order-item list contracts", () => {
  assert.deepEqual(
    toGetOrderOutput({
      order: { orderId: "ORDER-1" },
    }),
    { orderId: "ORDER-1" },
  );
  assert.deepEqual(
    toOrderItemsOutput({
      orderId: "ORDER-1",
      orderItems: [{ orderItemId: "ITEM-1" }],
    }),
    {
      orderId: "ORDER-1",
      items: [{ orderItemId: "ITEM-1" }],
    },
  );
});
