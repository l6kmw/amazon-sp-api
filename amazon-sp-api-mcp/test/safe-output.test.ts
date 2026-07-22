import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectInventoryResponse,
  projectListingItemResponse,
  projectListingsResponse,
  projectMarketplaceResponse,
  projectOrderResponse,
} from "../src/safe-output.js";

test("projects marketplace fields and drops unknown data", () => {
  assert.deepEqual(projectMarketplaceResponse({
    region: "eu",
    payload: [{
      marketplace: { id: "A1", name: "Store", countryCode: "GB", secret: "drop" },
      participation: { isParticipating: true, internalNote: "drop" },
      unknown: "drop",
    }],
  }), {
    region: "eu",
    payload: [{
      marketplace: { id: "A1", countryCode: "GB", name: "Store" },
      participation: { isParticipating: true },
    }],
  });
});

test("projects order fields and fails closed for PII and unknown fields", () => {
  const projected = projectOrderResponse({
    order: {
      orderId: "ORDER-1",
      createdTime: "2026-07-20T00:00:00Z",
      buyer: { buyerName: "Hidden", buyerEmail: "hidden@example.com" },
      recipient: { deliveryAddress: { addressLine1: "Hidden Street", phone: "123" } },
      payment: { paymentExecutions: [{ authorizationCode: "secret" }] },
      tax: { taxRegistrations: [{ legalName: "Hidden", taxRegistrationNumber: "secret" }] },
      orderItems: [{
        orderItemId: "ITEM-1",
        quantityOrdered: 2,
        product: {
          asin: "ASIN-1",
          title: "Product",
          sellerSku: "SKU-1",
          customization: { customizedUrl: "https://secret.example" },
          unexpected: "drop",
        },
      }],
      packages: [{
        packageReferenceId: "PACKAGE-1",
        trackingNumber: "TRACK-SECRET",
        shipFromAddress: { addressLine1: "Hidden Warehouse" },
      }],
      futureSensitiveField: "drop",
    },
  });

  const text = JSON.stringify(projected);
  assert.match(text, /ORDER-1|ITEM-1|SKU-1|PACKAGE-1/);
  assert.doesNotMatch(
    text,
    /Hidden|hidden@example|secret|TRACK-SECRET|futureSensitiveField|customization|unexpected/,
  );
});

test("projects listing fields and drops issue messages, attributes, and unknown data", () => {
  const listing = {
    sku: "SKU-1",
    summaries: [{
      marketplaceId: "ATVPDKIKX0DER",
      asin: "B000TEST01",
      productType: "PRODUCT",
      conditionType: "new_new",
      status: ["BUYABLE", "DISCOVERABLE"],
      itemName: "Safe title",
      createdDate: "2026-07-01T00:00:00Z",
      lastUpdatedDate: "2026-07-20T00:00:00Z",
      mainImage: { link: "https://images.example/item.jpg", height: 1000 },
      secret: "drop",
    }],
    issues: [{
      code: "LISTING_MISSING_REQUIRED_ATTRIBUTE",
      severity: "ERROR",
      categories: ["INVALID_ATTRIBUTE"],
      attributeNames: ["item_name"],
      message: "sensitive localized seller detail",
      details: { privateNote: "drop" },
    }],
    fulfillmentAvailability: [{
      fulfillmentChannelCode: "AMAZON_NA",
      quantity: 4,
      privateQuantity: 99,
    }],
    attributes: { buyerEmail: [{ value: "hidden@example.com" }] },
    offers: [{ price: "secret" }],
  };

  const expected = {
    sku: "SKU-1",
    summaries: [{
      marketplaceId: "ATVPDKIKX0DER",
      asin: "B000TEST01",
      productType: "PRODUCT",
      conditionType: "new_new",
      status: ["BUYABLE", "DISCOVERABLE"],
      itemName: "Safe title",
      createdDate: "2026-07-01T00:00:00Z",
      lastUpdatedDate: "2026-07-20T00:00:00Z",
      mainImage: { link: "https://images.example/item.jpg" },
    }],
    issues: [{
      code: "LISTING_MISSING_REQUIRED_ATTRIBUTE",
      severity: "ERROR",
      categories: ["INVALID_ATTRIBUTE"],
      attributeNames: ["item_name"],
    }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: "AMAZON_NA", quantity: 4 }],
  };
  assert.deepEqual(projectListingItemResponse(listing), expected);
  assert.deepEqual(projectListingsResponse({
    numberOfResults: 1,
    items: [listing],
    pagination: { nextToken: "NEXT", previousToken: "PREVIOUS", secret: "drop" },
    secret: "drop",
  }), {
    numberOfResults: 1,
    items: [expected],
    pagination: { nextToken: "NEXT", previousToken: "PREVIOUS" },
  });
  assert.doesNotMatch(
    JSON.stringify(projectListingsResponse({ items: [listing] })),
    /sensitive localized|hidden@example|attributes|offers|privateNote|privateQuantity|secret/,
  );
});

test("projects inventory quantities and drops unknown fields", () => {
  assert.deepEqual(projectInventoryResponse({
    payload: {
      granularity: { granularityType: "Marketplace", granularityId: "A1", secret: "drop" },
      inventorySummaries: [{
        asin: "ASIN-1",
        sellerSku: "SKU-1",
        totalQuantity: 4,
        inventoryDetails: {
          fulfillableQuantity: 3,
          reservedQuantity: { totalReservedQuantity: 1, privateNote: "drop" },
        },
        privateNote: "drop",
      }],
    },
    pagination: { nextToken: "NEXT", internal: "drop" },
  }), {
    payload: {
      granularity: { granularityType: "Marketplace", granularityId: "A1" },
      inventorySummaries: [{
        asin: "ASIN-1",
        sellerSku: "SKU-1",
        inventoryDetails: {
          fulfillableQuantity: 3,
          reservedQuantity: { totalReservedQuantity: 1 },
        },
        totalQuantity: 4,
      }],
    },
    pagination: { nextToken: "NEXT" },
  });
});
