import { z } from "zod";

/**
 * Compact MCP success output schemas for ConnectedAccount-authenticated tools.
 * These are public contracts: closed (strict), projected fields only.
 */

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const stringList = z.array(z.string());

const moneySchema = z.object({
  amount: scalar.optional(),
  currencyCode: z.string().optional(),
}).strict();

const dateTimeRangeSchema = z.object({
  earliestDateTime: z.string().optional(),
  latestDateTime: z.string().optional(),
}).strict();

const measurementSchema = z.object({
  unit: z.string().optional(),
  value: scalar.optional(),
}).strict();

const itemSchema = z.object({
  orderItemId: z.string().optional(),
  quantityOrdered: scalar.optional(),
  measurement: measurementSchema.optional(),
  associatedOrderItems: z.array(z.object({
    associationType: z.string().optional(),
    orderId: z.string().optional(),
    orderItemId: z.string().optional(),
  }).strict()).optional(),
  programs: stringList.optional(),
  product: z.object({
    asin: z.string().optional(),
    title: z.string().optional(),
    sellerSku: z.string().optional(),
    condition: z.object({
      conditionType: z.string().optional(),
      conditionSubtype: z.string().optional(),
    }).strict().optional(),
    price: z.object({
      unitPrice: moneySchema.optional(),
      priceDesignation: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
  proceeds: z.object({
    proceedsTotal: moneySchema.optional(),
    breakdowns: z.array(z.object({
      type: z.string().optional(),
      subtotal: moneySchema.optional(),
      detailedBreakdowns: z.array(z.object({
        subtype: z.string().optional(),
        value: moneySchema.optional(),
      }).strict()).optional(),
    }).strict()).optional(),
  }).strict().optional(),
  expense: z.object({
    pointsCost: z.object({
      pointsGranted: z.object({
        pointsNumber: scalar.optional(),
        pointsMonetaryValue: moneySchema.optional(),
      }).strict().optional(),
    }).strict().optional(),
  }).strict().optional(),
  promotion: z.object({
    breakdowns: z.array(z.object({
      promotionId: z.string().optional(),
    }).strict()).optional(),
  }).strict().optional(),
  fulfillment: z.object({
    quantityFulfilled: scalar.optional(),
    quantityUnfulfilled: scalar.optional(),
  }).strict().optional(),
}).strict();

const orderSchema = z.object({
  orderId: z.string().optional(),
  createdTime: z.string().optional(),
  lastUpdatedTime: z.string().optional(),
  programs: stringList.optional(),
  associatedOrders: z.array(z.object({
    associationType: z.string().optional(),
    orderId: z.string().optional(),
  }).strict()).optional(),
  salesChannel: z.object({
    channelName: z.string().optional(),
    marketplaceId: z.string().optional(),
    marketplaceName: z.string().optional(),
  }).strict().optional(),
  proceeds: z.object({
    grandTotal: moneySchema.optional(),
    breakdowns: z.array(z.object({
      status: z.string().optional(),
      subtotal: moneySchema.optional(),
      type: z.string().optional(),
    }).strict()).optional(),
  }).strict().optional(),
  fulfillment: z.object({
    fulfillmentStatus: z.string().optional(),
    fulfilledBy: z.string().optional(),
    fulfillmentServiceLevel: z.string().optional(),
    shipByWindow: dateTimeRangeSchema.optional(),
    deliverByWindow: dateTimeRangeSchema.optional(),
  }).strict().optional(),
  orderItems: z.array(itemSchema).optional(),
  packages: z.array(z.object({
    packageReferenceId: z.string().optional(),
    packageStatus: z.object({
      status: z.string().optional(),
      detailedStatus: z.string().optional(),
    }).strict().optional(),
    carrier: z.string().optional(),
    createdTime: z.string().optional(),
    shipTime: z.string().optional(),
    shippingService: z.string().optional(),
    packageItems: z.array(z.object({
      orderItemId: z.string().optional(),
      quantity: scalar.optional(),
    }).strict()).optional(),
  }).strict()).optional(),
  fulfillmentOrders: z.array(z.object({
    fulfillmentOrderId: z.string().optional(),
  }).strict()).optional(),
}).strict();

const paginationSchema = z.object({
  nextToken: z.string().optional(),
  previousToken: z.string().optional(),
  hasMore: z.boolean().optional(),
}).strict();

const marketplaceItemSchema = z.object({
  marketplace: z.object({
    id: z.string().optional(),
    countryCode: z.string().optional(),
    name: z.string().optional(),
    defaultCurrencyCode: z.string().optional(),
    defaultLanguageCode: z.string().optional(),
    domainName: z.string().optional(),
  }).strict().optional(),
  participation: z.object({
    isParticipating: z.boolean().optional(),
    hasSuspendedListings: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const inventoryDetailsSchema = z.object({
  fulfillableQuantity: scalar.optional(),
  inboundWorkingQuantity: scalar.optional(),
  inboundShippedQuantity: scalar.optional(),
  inboundReceivingQuantity: scalar.optional(),
  reservedQuantity: z.object({
    totalReservedQuantity: scalar.optional(),
    pendingCustomerOrderQuantity: scalar.optional(),
    pendingTransshipmentQuantity: scalar.optional(),
    fcProcessingQuantity: scalar.optional(),
  }).strict().optional(),
  researchingQuantity: z.object({
    totalResearchingQuantity: scalar.optional(),
    researchingQuantityBreakdown: z.array(z.object({
      name: z.string().optional(),
      quantity: scalar.optional(),
    }).strict()).optional(),
  }).strict().optional(),
  unfulfillableQuantity: z.object({
    totalUnfulfillableQuantity: scalar.optional(),
    customerDamagedQuantity: scalar.optional(),
    warehouseDamagedQuantity: scalar.optional(),
    distributorDamagedQuantity: scalar.optional(),
    carrierDamagedQuantity: scalar.optional(),
    defectiveQuantity: scalar.optional(),
    expiredQuantity: scalar.optional(),
  }).strict().optional(),
}).strict();

const inventoryItemSchema = z.object({
  asin: z.string().optional(),
  fnSku: z.string().optional(),
  sellerSku: z.string().optional(),
  condition: z.string().optional(),
  inventoryDetails: inventoryDetailsSchema.optional(),
  lastUpdatedTime: z.string().optional(),
  productName: z.string().optional(),
  totalQuantity: scalar.optional(),
  stores: stringList.optional(),
}).strict();

const listingItemSchema = z.object({
  sku: z.string().optional(),
  summaries: z.array(z.object({
    marketplaceId: z.string().optional(),
    asin: z.string().optional(),
    productType: z.string().optional(),
    conditionType: z.string().optional(),
    status: stringList.optional(),
    itemName: z.string().optional(),
    createdDate: z.string().optional(),
    lastUpdatedDate: z.string().optional(),
    mainImage: z.object({ link: z.string().optional() }).strict().optional(),
  }).strict()).optional(),
  issues: z.array(z.object({
    code: z.string().optional(),
    severity: z.string().optional(),
    categories: stringList.optional(),
    attributeNames: stringList.optional(),
  }).strict()).optional(),
  fulfillmentAvailability: z.array(z.object({
    fulfillmentChannelCode: z.string().optional(),
    quantity: scalar.optional(),
  }).strict()).optional(),
}).strict();

export const identityOutputSchema = z.object({
  // Single-user build: the caller is always the fixed local owner.
  identity_type: z.literal("local_owner"),
  identity_id: z.string().min(1),
  role: z.literal("owner"),
}).strict();

export const listAccountsOutputSchema = z.object({
  items: z.array(z.object({
    account_id: z.string().min(1),
    name: z.string().min(1),
    status: z.literal("active"),
    external_account_id: z.string().min(1),
    capabilities: z.array(z.string()),
  }).strict()),
}).strict();

export const listMarketplacesOutputSchema = z.object({
  region: z.enum(["na", "eu", "fe"]).optional(),
  items: z.array(marketplaceItemSchema),
}).strict();

export const businessSnapshotOutputSchema = z.object({
  summary: z.string().min(1),
  connectionStatus: z.literal("ok"),
  sellingPartnerId: z.string().min(1),
  region: z.enum(["na", "eu", "fe"]).optional(),
  regions: z.array(z.enum(["na", "eu", "fe"])),
  lookbackDays: z.number().int(),
  marketplaces: z.object({
    participatingCount: z.number().int(),
    analyzedCount: z.number().int(),
    marketplaceIds: z.array(z.string()),
    truncated: z.boolean(),
  }).strict(),
  orders: z.object({
    ordersSampled: z.number().int(),
    hasOrders: z.boolean(),
    firstPageCount: z.number().int(),
    paginationHint: z.string(),
  }).strict(),
  inventory: z.object({
    included: z.boolean(),
    checkedMarketplaceCount: z.number().int(),
    marketplacesWithInventory: z.number().int(),
    summaryCount: z.number().int(),
    isEmpty: z.boolean().nullable(),
  }).strict(),
  listings: z.object({
    included: z.boolean(),
    checkedMarketplaceCount: z.number().int(),
    sampleListingCount: z.number().int(),
    marketplacesWithListings: z.number().int(),
    buyableSampleCount: z.number().int(),
    issueSampleCount: z.number().int(),
    hasMore: z.boolean(),
    countsByMarketplace: z.array(z.object({
      marketplaceId: z.string(),
      sampleListingCount: z.number().int(),
      buyableSampleCount: z.number().int(),
      issueSampleCount: z.number().int(),
      hasMore: z.boolean(),
    }).strict()),
    paginationHint: z.string(),
  }).strict(),
  dataBoundary: z.string().min(1),
}).strict();

export const searchOrdersOutputSchema = z.object({
  items: z.array(orderSchema),
  pagination: paginationSchema.optional(),
  lastUpdatedBefore: z.string().optional(),
  createdBefore: z.string().optional(),
}).strict();

export const getOrderOutputSchema = orderSchema;

export const listOrderItemsOutputSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(itemSchema),
}).strict();

export const listInventoryOutputSchema = z.object({
  items: z.array(inventoryItemSchema),
  granularity: z.object({
    granularityType: z.string().optional(),
    granularityId: z.string().optional(),
  }).strict().optional(),
  pagination: paginationSchema.optional(),
}).strict();

export const searchListingsOutputSchema = z.object({
  items: z.array(listingItemSchema),
  numberOfResults: scalar.optional(),
  pagination: paginationSchema.optional(),
}).strict();

export const getListingItemOutputSchema = listingItemSchema;

export const connectionHealthOutputSchema = z.object({
  status: z.literal("ok"),
  sellingPartnerId: z.string().min(1),
  region: z.enum(["na", "eu", "fe"]),
  marketplaceCount: z.number().int().nonnegative(),
  checkedAt: z.string().min(1),
}).strict();

export const createAuthorizationUrlOutputSchema = z.object({
  authorizationUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
}).strict();

export const createRenewalUrlOutputSchema = z.object({
  renewalUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
}).strict();

export const listConnectionsOutputSchema = z.object({
  items: z.array(z.object({
    sellingPartnerId: z.string().min(1),
    authorizedAt: z.string().min(1),
  }).strict()),
}).strict();

export const disconnectConnectionOutputSchema = z.object({
  disconnected: z.literal(true),
  sellingPartnerId: z.string().min(1),
  amazonAuthorizationRevoked: z.literal(false),
  sellerCentralManageUrl: z.string().url(),
  nextAction: z.string().min(1),
}).strict();

export const toolAnnotations = {
  localRead: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  externalRead: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  externalCreate: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  externalDestructive: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Convert projected SP-API marketplace payload into closed MCP list shape. */
export function toMarketplacesOutput(projected: unknown): z.infer<typeof listMarketplacesOutputSchema> {
  const record = isRecord(projected) ? projected : {};
  const payload = Array.isArray(record.payload) ? record.payload : [];
  return listMarketplacesOutputSchema.parse({
    ...(typeof record.region === "string" ? { region: record.region } : {}),
    items: payload,
  });
}

export function toSearchOrdersOutput(projected: unknown): z.infer<typeof searchOrdersOutputSchema> {
  const record = isRecord(projected) ? projected : {};
  return searchOrdersOutputSchema.parse({
    items: Array.isArray(record.orders) ? record.orders : [],
    ...(isRecord(record.pagination) ? { pagination: record.pagination } : {}),
    ...(typeof record.lastUpdatedBefore === "string"
      ? { lastUpdatedBefore: record.lastUpdatedBefore }
      : {}),
    ...(typeof record.createdBefore === "string" ? { createdBefore: record.createdBefore } : {}),
  });
}

export function toGetOrderOutput(projected: unknown): z.infer<typeof getOrderOutputSchema> {
  const record = isRecord(projected) ? projected : {};
  const order = isRecord(record.order) ? record.order : {};
  return getOrderOutputSchema.parse(order);
}

export function toOrderItemsOutput(projected: unknown): z.infer<typeof listOrderItemsOutputSchema> {
  const record = isRecord(projected) ? projected : {};
  return listOrderItemsOutputSchema.parse({
    orderId: typeof record.orderId === "string" ? record.orderId : "",
    items: Array.isArray(record.orderItems) ? record.orderItems : [],
  });
}

export function toInventoryOutput(projected: unknown): z.infer<typeof listInventoryOutputSchema> {
  const record = isRecord(projected) ? projected : {};
  const payload = isRecord(record.payload) ? record.payload : {};
  return listInventoryOutputSchema.parse({
    items: Array.isArray(payload.inventorySummaries) ? payload.inventorySummaries : [],
    ...(isRecord(payload.granularity) ? { granularity: payload.granularity } : {}),
    ...(isRecord(record.pagination) ? { pagination: record.pagination } : {}),
  });
}

export function toListingsOutput(projected: unknown): z.infer<typeof searchListingsOutputSchema> {
  const record = isRecord(projected) ? projected : {};
  return searchListingsOutputSchema.parse({
    items: Array.isArray(record.items) ? record.items : [],
    ...(record.numberOfResults !== undefined ? { numberOfResults: record.numberOfResults } : {}),
    ...(isRecord(record.pagination) ? { pagination: record.pagination } : {}),
  });
}

export function toListingItemOutput(projected: unknown): z.infer<typeof getListingItemOutputSchema> {
  return getListingItemOutputSchema.parse(isRecord(projected) ? projected : {});
}
