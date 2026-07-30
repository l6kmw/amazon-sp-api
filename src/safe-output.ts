interface Projection {
  readonly [key: string]: ProjectionField;
}
type ProjectionField = "scalar" | "scalars" | Projection | readonly [Projection];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isArrayProjection(field: ProjectionField): field is readonly [Projection] {
  return Array.isArray(field);
}

function projectRecord(value: unknown, projection: Projection): Record<string, unknown> {
  if (!isRecord(value)) return {};

  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(projection)) {
    const child = value[key];
    if (child === undefined) continue;

    if (field === "scalar") {
      if (isScalar(child)) output[key] = child;
      continue;
    }
    if (field === "scalars") {
      if (Array.isArray(child)) output[key] = child.filter(isScalar);
      continue;
    }
    if (isArrayProjection(field)) {
      if (Array.isArray(child)) output[key] = child.map((item) => projectRecord(item, field[0]));
      continue;
    }
    if (isRecord(child)) output[key] = projectRecord(child, field);
  }
  return output;
}

const MONEY = {
  amount: "scalar",
  currencyCode: "scalar",
} as const satisfies Projection;

const DATE_TIME_RANGE = {
  earliestDateTime: "scalar",
  latestDateTime: "scalar",
} as const satisfies Projection;

const MEASUREMENT = {
  unit: "scalar",
  value: "scalar",
} as const satisfies Projection;

const ITEM_PROCEEDS_BREAKDOWN = {
  type: "scalar",
  subtotal: MONEY,
  detailedBreakdowns: [{ subtype: "scalar", value: MONEY }],
} as const satisfies Projection;

const ITEM_PROCEEDS = {
  proceedsTotal: MONEY,
  breakdowns: [ITEM_PROCEEDS_BREAKDOWN],
} as const satisfies Projection;

const ITEM = {
  orderItemId: "scalar",
  quantityOrdered: "scalar",
  measurement: MEASUREMENT,
  associatedOrderItems: [{ associationType: "scalar", orderId: "scalar", orderItemId: "scalar" }],
  programs: "scalars",
  product: {
    asin: "scalar",
    title: "scalar",
    sellerSku: "scalar",
    condition: {
      conditionType: "scalar",
      conditionSubtype: "scalar",
    },
    price: {
      unitPrice: MONEY,
      priceDesignation: "scalar",
    },
  },
  proceeds: ITEM_PROCEEDS,
  expense: {
    pointsCost: {
      pointsGranted: {
        pointsNumber: "scalar",
        pointsMonetaryValue: MONEY,
      },
    },
  },
  promotion: {
    breakdowns: [{ promotionId: "scalar" }],
  },
  fulfillment: {
    quantityFulfilled: "scalar",
    quantityUnfulfilled: "scalar",
  },
} as const satisfies Projection;

const ORDER = {
  orderId: "scalar",
  createdTime: "scalar",
  lastUpdatedTime: "scalar",
  programs: "scalars",
  associatedOrders: [{ associationType: "scalar", orderId: "scalar" }],
  salesChannel: {
    channelName: "scalar",
    marketplaceId: "scalar",
    marketplaceName: "scalar",
  },
  proceeds: {
    grandTotal: MONEY,
    breakdowns: [{ status: "scalar", subtotal: MONEY, type: "scalar" }],
  },
  fulfillment: {
    fulfillmentStatus: "scalar",
    fulfilledBy: "scalar",
    fulfillmentServiceLevel: "scalar",
    shipByWindow: DATE_TIME_RANGE,
    deliverByWindow: DATE_TIME_RANGE,
  },
  orderItems: [ITEM],
  packages: [{
    packageReferenceId: "scalar",
    packageStatus: { status: "scalar", detailedStatus: "scalar" },
    carrier: "scalar",
    createdTime: "scalar",
    shipTime: "scalar",
    shippingService: "scalar",
    packageItems: [{ orderItemId: "scalar", quantity: "scalar" }],
  }],
  fulfillmentOrders: [{ fulfillmentOrderId: "scalar" }],
} as const satisfies Projection;

const PAGINATION = {
  nextToken: "scalar",
  previousToken: "scalar",
  hasMore: "scalar",
} as const satisfies Projection;

const LISTING_ITEM = {
  sku: "scalar",
  summaries: [{
    marketplaceId: "scalar",
    asin: "scalar",
    productType: "scalar",
    conditionType: "scalar",
    status: "scalars",
    itemName: "scalar",
    createdDate: "scalar",
    lastUpdatedDate: "scalar",
    mainImage: { link: "scalar" },
  }],
  issues: [{
    code: "scalar",
    severity: "scalar",
    categories: "scalars",
    attributeNames: "scalars",
  }],
  fulfillmentAvailability: [{
    fulfillmentChannelCode: "scalar",
    quantity: "scalar",
  }],
} as const satisfies Projection;

const INVENTORY_DETAILS = {
  fulfillableQuantity: "scalar",
  inboundWorkingQuantity: "scalar",
  inboundShippedQuantity: "scalar",
  inboundReceivingQuantity: "scalar",
  reservedQuantity: {
    totalReservedQuantity: "scalar",
    pendingCustomerOrderQuantity: "scalar",
    pendingTransshipmentQuantity: "scalar",
    fcProcessingQuantity: "scalar",
  },
  researchingQuantity: {
    totalResearchingQuantity: "scalar",
    researchingQuantityBreakdown: [{ name: "scalar", quantity: "scalar" }],
  },
  unfulfillableQuantity: {
    totalUnfulfillableQuantity: "scalar",
    customerDamagedQuantity: "scalar",
    warehouseDamagedQuantity: "scalar",
    distributorDamagedQuantity: "scalar",
    carrierDamagedQuantity: "scalar",
    defectiveQuantity: "scalar",
    expiredQuantity: "scalar",
  },
} as const satisfies Projection;

export function projectMarketplaceResponse(value: unknown): unknown {
  return projectRecord(value, {
    region: "scalar",
    payload: [{
      marketplace: {
        id: "scalar",
        countryCode: "scalar",
        name: "scalar",
        defaultCurrencyCode: "scalar",
        defaultLanguageCode: "scalar",
        domainName: "scalar",
      },
      participation: {
        isParticipating: "scalar",
        hasSuspendedListings: "scalar",
      },
    }],
  });
}

export function projectSearchOrdersResponse(value: unknown): unknown {
  return projectRecord(value, {
    orders: [ORDER],
    pagination: PAGINATION,
    lastUpdatedBefore: "scalar",
    createdBefore: "scalar",
  });
}

export function projectOrderResponse(value: unknown): unknown {
  return projectRecord(value, { order: ORDER });
}

export function projectOrderItemsResponse(value: unknown): unknown {
  return projectRecord(value, { orderId: "scalar", orderItems: [ITEM] });
}

export function projectListingItemResponse(value: unknown): unknown {
  return projectRecord(value, LISTING_ITEM);
}

export function projectListingsResponse(value: unknown): unknown {
  return projectRecord(value, {
    numberOfResults: "scalar",
    items: [LISTING_ITEM],
    pagination: PAGINATION,
  });
}

export function projectInventoryResponse(value: unknown): unknown {
  return projectRecord(value, {
    payload: {
      granularity: { granularityType: "scalar", granularityId: "scalar" },
      inventorySummaries: [{
        asin: "scalar",
        fnSku: "scalar",
        sellerSku: "scalar",
        condition: "scalar",
        inventoryDetails: INVENTORY_DETAILS,
        lastUpdatedTime: "scalar",
        productName: "scalar",
        totalQuantity: "scalar",
        stores: "scalars",
      }],
    },
    pagination: PAGINATION,
  });
}
