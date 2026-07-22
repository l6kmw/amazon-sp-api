import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AmazonMcpError, normalizeToolErrorMessage } from "./errors.js";
import type { AmazonPrincipal } from "./identity.js";
import {
  ConnectedAccountAccountError,
  type ConnectedAccountConnectedAccount,
  type MaybePromise,
} from "./connected-account-accounts.js";
import {
  projectInventoryResponse,
  projectListingItemResponse,
  projectListingsResponse,
  projectMarketplaceResponse,
  projectOrderItemsResponse,
  projectOrderResponse,
  projectSearchOrdersResponse,
} from "./safe-output.js";
import {
  SpApiError,
  regionForMarketplace,
  regionForMarketplaces,
  type AmazonRegion,
  type SpApiReader,
} from "./sp-api-client.js";
import {
  businessSnapshotOutputSchema,
  connectionHealthOutputSchema,
  createAuthorizationUrlOutputSchema,
  createRenewalUrlOutputSchema,
  disconnectConnectionOutputSchema,
  getListingItemOutputSchema,
  getOrderOutputSchema,
  identityOutputSchema,
  listAccountsOutputSchema,
  listConnectionsOutputSchema,
  listInventoryOutputSchema,
  listMarketplacesOutputSchema,
  listOrderItemsOutputSchema,
  searchListingsOutputSchema,
  searchOrdersOutputSchema,
  toGetOrderOutput,
  toInventoryOutput,
  toListingItemOutput,
  toListingsOutput,
  toMarketplacesOutput,
  toOrderItemsOutput,
  toSearchOrdersOutput,
  toolAnnotations,
} from "./tool-schemas.js";

export interface AmazonConnectionManager {
  createAuthorizationURL(tenantId: string): Promise<string>;
  createRenewalURL(tenantId: string): Promise<string>;
  listConnections(
    tenantId: string,
    forceRefresh?: boolean,
  ): Promise<Array<{ sellingPartnerId: string; authorizedAt: string }>>;
  disconnect(tenantId: string, sellingPartnerId: string): Promise<void>;
}

export interface AmazonMcpServerOptions {
  tenantId?: string;
  principal?: AmazonPrincipal;
  connections?: AmazonConnectionManager;
  regionCache?: AmazonSellerRegionCache;
  sellerCentralManageURL?: string;
  chargeSpApiCall?: (tenantId: string) => void;
  enableListingsTools?: boolean;
  connected-accountAccounts?: {
    listAccounts(principal: Extract<AmazonPrincipal, { authType: "connected-account" }>): MaybePromise<ConnectedAccountConnectedAccount[]>;
    resolveAccount(
      principal: Extract<AmazonPrincipal, { authType: "connected-account" }>,
      accountId: string,
    ): MaybePromise<ConnectedAccountConnectedAccount>;
  };
}

export interface AmazonSellerRegionCache {
  get(tenantId: string, sellingPartnerId: string): AmazonRegion | undefined;
  set(tenantId: string, sellingPartnerId: string, region: AmazonRegion): void;
  delete(tenantId: string, sellingPartnerId: string): void;
}

interface CachedRegion {
  region: AmazonRegion;
  expiresAt: number;
}

export class InMemoryAmazonSellerRegionCache implements AmazonSellerRegionCache {
  readonly #ttlMs: number;
  readonly #entries = new Map<string, CachedRegion>();

  constructor(ttlMs = 24 * 60 * 60_000) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error("Amazon seller region cache TTL must be non-negative");
    }
    this.#ttlMs = ttlMs;
  }

  get(tenantId: string, sellingPartnerId: string): AmazonRegion | undefined {
    const key = JSON.stringify([tenantId, sellingPartnerId]);
    const cached = this.#entries.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return cached.region;
  }

  set(tenantId: string, sellingPartnerId: string, region: AmazonRegion): void {
    if (this.#ttlMs === 0) return;
    this.#entries.set(JSON.stringify([tenantId, sellingPartnerId]), {
      region,
      expiresAt: Date.now() + this.#ttlMs,
    });
  }

  delete(tenantId: string, sellingPartnerId: string): void {
    this.#entries.delete(JSON.stringify([tenantId, sellingPartnerId]));
  }
}

const sellingPartnerId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const accountId = z.string().regex(/^acct_[A-Za-z0-9_-]{16,128}$/);
const marketplaceId = z.string().regex(/^[A-Z0-9]{10,20}$/);
const orderId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const timestamp = z.string().datetime({ offset: true });
const amazonRegion = z.enum(["na", "eu", "fe"]);
const REGION_PROBE_ORDER: AmazonRegion[] = ["na", "eu", "fe"];
const SERVER_INSTRUCTIONS = [
  "先调用 amazon_get_identity 和 amazon_list_accounts；旧实现调用方也可用 amazon_list_connections，无账号时使用 amazon_create_authorization_url；ConnectedAccount Employee 使用 Connected Account UI。",
  "ConnectedAccount Employee 必须使用 amazon_list_accounts 返回的 account_id；旧实现调用方有多个连接时必须传 sellingPartnerId。",
  "amazon_search_orders 的 createdAfter 与 lastUpdatedAfter 必须二选一，时间使用带 offset 的 ISO-8601。",
  "一次请求的多个 marketplace 必须属于同一区域（na/eu/fe）。",
  "本服务不提供买家、地址、支付或追踪号等 PII，请勿反复索要。",
  "断开连接必须传 confirmDisconnect=DISCONNECT。",
  "授权 URL 只能在浏览器打开，且为 10 分钟内一次性链接。",
].join("\n");

interface MarketplaceParticipations {
  payload?: unknown[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function participatingMarketplaceIds(response: MarketplaceParticipations): string[] {
  return (response.payload ?? []).flatMap((entry) => {
    const item = record(entry);
    const marketplace = record(item?.marketplace);
    const participation = record(item?.participation);
    return typeof marketplace?.id === "string" && participation?.isParticipating === true
      ? [marketplace.id]
      : [];
  });
}

async function readPages(options: {
  autoPage: boolean;
  initialToken?: string;
  read: (nextToken?: string) => Promise<unknown>;
}): Promise<{ pages: Record<string, unknown>[]; nextToken?: string }> {
  const pages: Record<string, unknown>[] = [];
  const requestedTokens = new Set<string>();
  let nextToken = options.initialToken;
  for (let page = 0; page < (options.autoPage ? 5 : 1); page += 1) {
    if (nextToken) requestedTokens.add(nextToken);
    const response = record(await options.read(nextToken)) ?? {};
    pages.push(response);
    const token = record(response.pagination)?.nextToken;
    nextToken = typeof token === "string" && token ? token : undefined;
    if (!nextToken || requestedTokens.has(nextToken)) {
      nextToken = undefined;
      break;
    }
  }
  return { pages, nextToken };
}

async function discoverMarketplaceRegion(options: {
  client: SpApiReader;
  sellingPartnerId: string;
  tenantId: string;
  region?: AmazonRegion;
}): Promise<{ region: AmazonRegion; response: MarketplaceParticipations }> {
  const regions = options.region ? [options.region] : REGION_PROBE_ORDER;
  let regionError: SpApiError | undefined;

  for (const region of regions) {
    try {
      const response = await options.client.get({
        sellingPartnerId: options.sellingPartnerId,
        tenantId: options.tenantId,
        region,
        path: "/sellers/v1/marketplaceParticipations",
      }) as MarketplaceParticipations;
      return { region, response };
    } catch (error) {
      if (
        !options.region &&
        error instanceof SpApiError &&
        error.status === 403
      ) {
        regionError = error;
        continue;
      }
      throw error;
    }
  }

  throw regionError || new Error("Amazon seller region could not be identified");
}

function structuredJsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function successResult(schema: z.ZodTypeAny, value: unknown) {
  const parsed = schema.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AmazonMcpError("INTERNAL", "tool output schema validation produced a non-object");
  }
  return structuredJsonResult(parsed as Record<string, unknown>);
}

function canonicalAmazonAccountId(sellingPartnerIdValue: string): string {
  return `acct_${createHash("sha256")
    .update(`amazon-sp-api:${sellingPartnerIdValue}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

function publicIdentityId(principal: AmazonPrincipal): string {
  if (principal.authType === "connected-account") return principal.employeeId;
  return `identity_${createHash("sha256")
    .update(`${principal.authType}:${principal.tenantId ?? "unbound"}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

function snapshotSummary(options: {
  regions: readonly AmazonRegion[];
  participatingCount: number;
  lookbackDays: number;
  ordersSampled: number;
  includeInventory: boolean;
  inventorySummaryCount: number;
  includeListings: boolean;
  listingSampleCount: number;
  buyableListingSampleCount: number;
  listingIssueSampleCount: number;
}): string {
  const region = options.regions.map((value) => value.toUpperCase()).join("、");
  const orders = options.ordersSampled === 0
    ? "抽样中未发现订单记录"
    : `抽样中发现 ${options.ordersSampled} 条订单记录`;
  const inventory = !options.includeInventory
    ? "未检查 FBA 库存"
    : options.inventorySummaryCount === 0
      ? "FBA 库存汇总为空"
      : `本次返回 ${options.inventorySummaryCount} 条 FBA 库存汇总`;
  const inventoryGuidance = options.includeInventory
    ? "如需库存明细，请调用 amazon_list_inventory_summaries。"
    : "如需库存状态，请重新调用 amazon_business_snapshot 并设置 includeInventory=true。";
  const listings = !options.includeListings
    ? "未检查 Listings"
    : options.listingSampleCount === 0
      ? "Listing 抽样为空"
      : `Listing 抽样发现 ${options.listingSampleCount} 个刊登，其中 ${options.buyableListingSampleCount} 个可购买，${options.listingIssueSampleCount} 个含问题代码`;
  const listingGuidance = options.includeListings
    ? "如需 Listing 明细，请调用 amazon_search_listings。"
    : "";
  const sampleBoundary = options.includeListings
    ? "订单与 Listings 均为抽样结果，不代表精确总数"
    : "订单为抽样结果，不代表精确总数；Listings 未检查";
  return `${region} 区域，${options.participatingCount} 个参与站点；近 ${options.lookbackDays} 天${orders}，${inventory}，${listings}。${sampleBoundary}；如需订单明细，请调用 amazon_search_orders；${inventoryGuidance}${listingGuidance}`;
}

const searchOrdersFields = {
  marketplaceIds: z.array(marketplaceId).min(1).max(50),
  createdAfter: timestamp.optional(),
  createdBefore: timestamp.optional(),
  lastUpdatedAfter: timestamp.optional(),
  lastUpdatedBefore: timestamp.optional(),
  fulfillmentStatuses: z
    .array(
      z.enum([
        "PENDING_AVAILABILITY",
        "PENDING",
        "UNSHIPPED",
        "PARTIALLY_SHIPPED",
        "SHIPPED",
        "CANCELLED",
        "UNFULFILLABLE",
      ]),
    )
    .optional(),
  fulfilledBy: z.array(z.enum(["MERCHANT", "AMAZON"])).optional(),
  maxResultsPerPage: z.number().int().min(1).max(100).optional(),
  paginationToken: z.string().min(1).optional(),
  autoPage: z.boolean().default(false),
};

function validateSearchOrderFilters(filters: {
  createdAfter?: string;
  createdBefore?: string;
  lastUpdatedAfter?: string;
  lastUpdatedBefore?: string;
}): void {
  if (Boolean(filters.createdAfter) === Boolean(filters.lastUpdatedAfter)) {
    throw new AmazonMcpError(
      "INVALID_FILTER",
      "provide exactly one of createdAfter or lastUpdatedAfter",
    );
  }
  if (filters.createdAfter && filters.lastUpdatedBefore) {
    throw new AmazonMcpError(
      "INVALID_FILTER",
      "lastUpdatedBefore cannot be combined with createdAfter",
    );
  }
  if (filters.lastUpdatedAfter && filters.createdBefore) {
    throw new AmazonMcpError(
      "INVALID_FILTER",
      "createdBefore cannot be combined with lastUpdatedAfter",
    );
  }
}

export function createAmazonMcpServer(
  client: SpApiReader,
  options: AmazonMcpServerOptions = {},
): McpServer {
  const isConnectedAccount = options.principal?.authType === "connected-account";
  const sellerCentralManageURL = options.sellerCentralManageURL ??
    "https://sellercentral-europe.amazon.com/apps/manage";
  const withAccount = <T extends z.ZodRawShape>(fields: T) => z.object({
    ...(isConnectedAccount
      ? { account_id: accountId }
      : { sellingPartnerId: sellingPartnerId.optional() }),
    ...fields,
  }).strict();
  const accountDescription = (description: string) => isConnectedAccount
    ? `${description} Required: account_id from amazon_list_accounts.`
    : description;
  const server = new McpServer(
    { name: "amazon-sp-api", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const sdkServer = server as unknown as {
    createToolError: (errorMessage: string) => {
      content: Array<{ type: "text"; text: string }>;
      isError: true;
    };
  };
  sdkServer.createToolError = (errorMessage) => ({
    content: [{ type: "text", text: normalizeToolErrorMessage(errorMessage) }],
    isError: true,
    // Failures must never include success-shaped structuredContent.
  });

  const tenantId = () => {
    if (!options.tenantId) {
      throw new AmazonMcpError(
        "TENANT_REQUIRED",
        "Amazon connection management requires a Legacy user or Agent credential",
      );
    }
    return options.tenantId;
  };
  const readSpApi: SpApiReader["get"] = (request) => {
    options.chargeSpApiCall?.(request.tenantId);
    return client.get(request);
  };
  const meteredClient: SpApiReader = { get: readSpApi };

  server.registerTool(
    "amazon_get_identity",
    {
      title: "Get Amazon MCP identity",
      description: "Return a safe summary of the authenticated MCP identity. No tenant, workspace, JWT claims, token, or credential metadata is returned.",
      inputSchema: z.object({}).strict(),
      outputSchema: identityOutputSchema,
      annotations: toolAnnotations.localRead,
    },
    async () => {
      if (!options.principal) {
        throw new AmazonMcpError("TENANT_REQUIRED", "authenticated identity is required");
      }
      return successResult(identityOutputSchema, {
        identity_type: options.principal.authType === "connected-account"
          ? "employee_jwt"
          : options.principal.authType === "legacy"
            ? "legacy_agent"
            : "legacy",
        identity_id: publicIdentityId(options.principal),
        role: "employee",
      });
    },
  );

  server.registerTool(
    "amazon_list_accounts",
    {
      title: "List available Amazon accounts",
      description: "List Amazon seller accounts available to the authenticated identity. Use account_id as the canonical account selector for ConnectedAccount-compatible tools; external_account_id is only for human verification.",
      inputSchema: z.object({}).strict(),
      outputSchema: listAccountsOutputSchema,
      annotations: toolAnnotations.localRead,
    },
    async () => {
      if (options.principal?.authType === "connected-account" && options.connected-accountAccounts) {
        const accounts = await options.connected-accountAccounts.listAccounts(options.principal);
        return successResult(listAccountsOutputSchema, {
          items: accounts.map((account) => ({
            account_id: account.metadata.account_id,
            name: account.displayName,
            status: "active",
            external_account_id: account.externalAccountId,
            capabilities: ["read"],
          })),
        });
      }
      if (!options.connections) return successResult(listAccountsOutputSchema, { items: [] });
      const connections = await options.connections.listConnections(tenantId());
      return successResult(listAccountsOutputSchema, {
        items: connections.map((connection) => ({
          account_id: canonicalAmazonAccountId(connection.sellingPartnerId),
          name: `Amazon seller ${connection.sellingPartnerId}`,
          status: "active",
          external_account_id: connection.sellingPartnerId,
          capabilities: ["read"],
        })),
      });
    },
  );

  const resolveLegacySellingPartnerId = async (value?: string): Promise<string> => {
    const currentTenantId = tenantId();
    if (!options.connections) {
      throw new AmazonMcpError(
        "TENANT_REQUIRED",
        "tenant-scoped Amazon connections are required",
      );
    }

    let connections = await options.connections.listConnections(currentTenantId);
    const cachedSelectionMissing = value
      ? !connections.some((connection) => connection.sellingPartnerId === value)
      : connections.length === 0;
    if (cachedSelectionMissing) {
      connections = await options.connections.listConnections(currentTenantId, true);
    }
    if (value) {
      if (connections.some((connection) => connection.sellingPartnerId === value)) {
        return value;
      }
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "Amazon seller is not connected for the current user; use amazon_create_authorization_url or amazon_list_connections",
      );
    }
    if (connections.length === 0) {
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "no Amazon seller is connected for the current user; use amazon_create_authorization_url or amazon_list_connections",
      );
    }
    if (connections.length > 1) {
      throw new AmazonMcpError(
        "SELLER_REQUIRED",
        "sellingPartnerId is required when the current user has multiple connections",
      );
    }
    return connections[0]!.sellingPartnerId;
  };

  const resolveAccountInput = async (input: unknown): Promise<string> => {
    const values = record(input);
    if (options.principal?.authType === "connected-account") {
      if (!options.connected-accountAccounts || typeof values?.account_id !== "string") {
        throw new AmazonMcpError("NOT_CONNECTED", "ConnectedAccount account is not available");
      }
      try {
        return (await options.connected-accountAccounts.resolveAccount(
          options.principal,
          values.account_id,
        )).externalAccountId;
      } catch (error) {
        if (error instanceof ConnectedAccountAccountError && error.status === 404) {
          throw new AmazonMcpError("NOT_CONNECTED", "ConnectedAccount account is not available");
        }
        throw error;
      }
    }
    return resolveLegacySellingPartnerId(
      typeof values?.sellingPartnerId === "string" ? values.sellingPartnerId : undefined,
    );
  };

  server.registerTool(
    "amazon_list_marketplaces",
    {
      title: "List Amazon marketplaces",
      description: accountDescription(`List marketplace participations. Omit region to auto-discover it; the response then includes region for subsequent calls.${isConnectedAccount ? "" : " A single connected seller is selected automatically when omitted."}`),
      inputSchema: withAccount({
        region: amazonRegion.optional(),
      }),
      outputSchema: listMarketplacesOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const seller = await resolveAccountInput(input);
      const { region } = input;
      const cachedRegion = !region && options.tenantId
        ? options.regionCache?.get(options.tenantId, seller)
        : undefined;
      let result: { region: AmazonRegion; response: MarketplaceParticipations };
      try {
        result = await discoverMarketplaceRegion({
          client: meteredClient,
          sellingPartnerId: seller,
          tenantId: tenantId(),
          region: (region || cachedRegion) as AmazonRegion | undefined,
        });
      } catch (error) {
        if (cachedRegion && options.tenantId) {
          options.regionCache?.delete(options.tenantId, seller);
        }
        throw error;
      }
      if (!region && options.tenantId) {
        options.regionCache?.set(options.tenantId, seller, result.region);
      }
      return successResult(
        listMarketplacesOutputSchema,
        toMarketplacesOutput(projectMarketplaceResponse(region
          ? result.response
          : { ...result.response, region: result.region })),
      );
    },
  );

  server.registerTool(
    "amazon_business_snapshot",
    {
      title: "Summarize Amazon business health",
      description: accountDescription("Return a bounded, non-PII operational snapshot across participating marketplaces. Samples at most one order per region and optionally checks FBA inventory per marketplace; totals are not exact."),
      inputSchema: withAccount({
        marketplaceIds: z.array(marketplaceId).min(1).max(50).optional(),
        lookbackDays: z.number().int().min(1).max(90).default(30),
        includeInventory: z.boolean().default(true),
        includeListings: z.boolean().default(false),
        maxMarketplaces: z.number().int().min(1).max(11).default(11),
      }),
      outputSchema: businessSnapshotOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const {
        marketplaceIds,
        lookbackDays,
        includeInventory,
        includeListings,
        maxMarketplaces,
      } = input;
      if (includeListings && !options.enableListingsTools) {
        throw new AmazonMcpError(
          "INVALID_FILTER",
          "includeListings requires AMAZON_ENABLE_LISTINGS_TOOLS=true",
        );
      }
      const seller = await resolveAccountInput(input);
      const currentTenantId = tenantId();
      const participationByRegion = new Map<AmazonRegion, MarketplaceParticipations>();
      for (const region of REGION_PROBE_ORDER) {
        try {
          const response = await readSpApi({
            sellingPartnerId: seller,
            tenantId: currentTenantId,
            region,
            path: "/sellers/v1/marketplaceParticipations",
          }) as MarketplaceParticipations;
          participationByRegion.set(region, response);
        } catch (error) {
          if (error instanceof SpApiError && error.status === 403) continue;
          throw error;
        }
      }
      if (participationByRegion.size === 0) {
        throw new AmazonMcpError(
          "UPSTREAM_SP_API",
          "Amazon marketplace participations could not be read in any region",
        );
      }
      const regions = [...participationByRegion.keys()];
      options.regionCache?.set(currentTenantId, seller, regions[0]!);

      const participatingIds = [...new Set(
        [...participationByRegion.values()].flatMap(participatingMarketplaceIds),
      )];
      const requestedIds = [...new Set(marketplaceIds ?? participatingIds)];
      if (requestedIds.some((id) => !participatingIds.includes(id))) {
        throw new AmazonMcpError(
          "INVALID_FILTER",
          "marketplaceIds must be participating marketplaces for the connected seller",
        );
      }
      const selectedIds = requestedIds.slice(0, maxMarketplaces);
      const byRegion = new Map<AmazonRegion, string[]>();
      for (const id of selectedIds) {
        const region = regionForMarketplace(id);
        byRegion.set(region, [...(byRegion.get(region) ?? []), id]);
      }

      const createdAfter = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
      let firstPageCount = 0;
      let hasMoreOrders = false;
      for (const [region, ids] of byRegion) {
        const response = record(await readSpApi({
          sellingPartnerId: seller,
          tenantId: currentTenantId,
          region,
          path: "/orders/2026-01-01/orders",
          query: { marketplaceIds: ids, createdAfter, maxResultsPerPage: 1 },
        }));
        firstPageCount += Array.isArray(response?.orders) ? response.orders.length : 0;
        hasMoreOrders ||= typeof record(response?.pagination)?.nextToken === "string";
      }

      let inventorySummaryCount = 0;
      let marketplacesWithInventory = 0;
      if (includeInventory) {
        for (const id of selectedIds) {
          const response = record(await readSpApi({
            sellingPartnerId: seller,
            tenantId: currentTenantId,
            region: regionForMarketplace(id),
            path: "/fba/inventory/v1/summaries",
            query: {
              details: false,
              granularityType: "Marketplace",
              granularityId: id,
              marketplaceIds: [id],
            },
          }));
          const summaries = record(response?.payload)?.inventorySummaries;
          const count = Array.isArray(summaries) ? summaries.length : 0;
          inventorySummaryCount += count;
          if (count > 0) marketplacesWithInventory += 1;
        }
      }

      const listingCountsByMarketplace: Array<{
        marketplaceId: string;
        sampleListingCount: number;
        buyableSampleCount: number;
        issueSampleCount: number;
        hasMore: boolean;
      }> = [];
      if (includeListings) {
        for (const id of selectedIds) {
          const response = record(await readSpApi({
            sellingPartnerId: seller,
            tenantId: currentTenantId,
            region: regionForMarketplace(id),
            path: `/listings/2021-08-01/items/${encodeURIComponent(seller)}`,
            query: {
              marketplaceIds: [id],
              includedData: ["summaries", "issues"],
              pageSize: 20,
            },
          })) ?? {};
          const rawItems = Array.isArray(response.items) ? response.items : [];
          const items = rawItems.slice(0, 20);
          let buyableSampleCount = 0;
          let issueSampleCount = 0;
          for (const itemValue of items) {
            const item = record(itemValue);
            const summaries = Array.isArray(item?.summaries) ? item.summaries : [];
            if (summaries.some((summary) => {
              const status = record(summary)?.status;
              return Array.isArray(status) && status.includes("BUYABLE");
            })) buyableSampleCount += 1;
            if (Array.isArray(item?.issues) && item.issues.length > 0) issueSampleCount += 1;
          }
          listingCountsByMarketplace.push({
            marketplaceId: id,
            sampleListingCount: items.length,
            buyableSampleCount,
            issueSampleCount,
            hasMore: typeof record(response.pagination)?.nextToken === "string",
          });
        }
      }
      const listingSampleCount = listingCountsByMarketplace.reduce(
        (total, item) => total + item.sampleListingCount,
        0,
      );
      const buyableListingSampleCount = listingCountsByMarketplace.reduce(
        (total, item) => total + item.buyableSampleCount,
        0,
      );
      const listingIssueSampleCount = listingCountsByMarketplace.reduce(
        (total, item) => total + item.issueSampleCount,
        0,
      );

      return successResult(businessSnapshotOutputSchema, {
        summary: snapshotSummary({
          regions,
          participatingCount: participatingIds.length,
          lookbackDays,
          ordersSampled: firstPageCount,
          includeInventory,
          inventorySummaryCount,
          includeListings,
          listingSampleCount,
          buyableListingSampleCount,
          listingIssueSampleCount,
        }),
        connectionStatus: "ok",
        sellingPartnerId: seller,
        region: regions.length === 1 ? regions[0] : undefined,
        regions,
        lookbackDays,
        marketplaces: {
          participatingCount: participatingIds.length,
          analyzedCount: selectedIds.length,
          marketplaceIds: selectedIds,
          truncated: requestedIds.length > selectedIds.length,
        },
        orders: {
          ordersSampled: firstPageCount,
          hasOrders: firstPageCount > 0,
          firstPageCount,
          paginationHint: hasMoreOrders
            ? "More orders exist; use amazon_search_orders with paginationToken for details."
            : "Only bounded first pages were sampled; exact totals require paginated amazon_search_orders or an asynchronous job.",
        },
        inventory: {
          included: includeInventory,
          checkedMarketplaceCount: includeInventory ? selectedIds.length : 0,
          marketplacesWithInventory,
          summaryCount: inventorySummaryCount,
          isEmpty: includeInventory ? inventorySummaryCount === 0 : null,
        },
        listings: {
          included: includeListings,
          checkedMarketplaceCount: includeListings ? selectedIds.length : 0,
          sampleListingCount: listingSampleCount,
          marketplacesWithListings: listingCountsByMarketplace.filter(
            (item) => item.sampleListingCount > 0,
          ).length,
          buyableSampleCount: buyableListingSampleCount,
          issueSampleCount: listingIssueSampleCount,
          hasMore: listingCountsByMarketplace.some((item) => item.hasMore),
          countsByMarketplace: listingCountsByMarketplace,
          paginationHint: includeListings
            ? "Only the first 20 Listings per marketplace were sampled; use amazon_search_listings for details and pagination."
            : "Listings were not requested; set includeListings=true after enabling the Listings feature flag.",
        },
        dataBoundary: `Read-only operational summary. No buyer or recipient datasets are requested, and no buyer, recipient, address, payment, tracking, or other PII is returned; order totals are sampled, not exact. Listings are ${includeListings ? "sampled from allowlisted summary and issue-code fields only; totals are not exact" : "not included"}.`,
      });
    },
  );

  server.registerTool(
    "amazon_search_orders",
    {
      title: "Search Amazon orders",
      description: accountDescription("Search non-PII orders. Provide exactly one of createdAfter or lastUpdatedAfter, start with a 30-day or smaller window, and use paginationToken only from the previous response to continue. autoPage defaults to false and reads at most 5 pages when enabled."),
      inputSchema: withAccount(searchOrdersFields),
      outputSchema: searchOrdersOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const {
        marketplaceIds,
        paginationToken,
        autoPage,
        createdAfter,
        createdBefore,
        lastUpdatedAfter,
        lastUpdatedBefore,
        fulfillmentStatuses,
        fulfilledBy,
        maxResultsPerPage,
      } = input;
      const filters = {
        createdAfter,
        createdBefore,
        lastUpdatedAfter,
        lastUpdatedBefore,
        fulfillmentStatuses,
        fulfilledBy,
        maxResultsPerPage,
      };
      validateSearchOrderFilters(filters);
      const seller = await resolveAccountInput(input);
      const currentTenantId = tenantId();
      const region = regionForMarketplaces(marketplaceIds);
      const { pages, nextToken } = await readPages({
        autoPage,
        initialToken: paginationToken,
        read: (token) => readSpApi({
          sellingPartnerId: seller,
          tenantId: currentTenantId,
          region,
          path: "/orders/2026-01-01/orders",
          query: { marketplaceIds, ...filters, paginationToken: token },
        }),
      });
      const lastPage = pages[pages.length - 1] ?? {};
      return successResult(
        searchOrdersOutputSchema,
        toSearchOrdersOutput(projectSearchOrdersResponse({
          orders: pages.flatMap((page) => Array.isArray(page.orders) ? page.orders : []),
          pagination: { nextToken, hasMore: Boolean(nextToken) },
          lastUpdatedBefore: lastPage.lastUpdatedBefore,
          createdBefore: lastPage.createdBefore,
        })),
      );
    },
  );

  const getOrderSchema = withAccount({
    marketplaceId,
    orderId,
  });

  server.registerTool(
    "amazon_get_order",
    {
      title: "Get Amazon order",
      description: accountDescription("Get one order without requesting buyer or recipient datasets."),
      inputSchema: getOrderSchema,
      outputSchema: getOrderOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const { marketplaceId: marketplace, orderId: id } = input;
      const seller = await resolveAccountInput(input);
      return successResult(
        getOrderOutputSchema,
        toGetOrderOutput(projectOrderResponse(
          await readSpApi({
            sellingPartnerId: seller,
            tenantId: tenantId(),
            region: regionForMarketplace(marketplace),
            path: `/orders/2026-01-01/orders/${encodeURIComponent(id)}`,
          }),
        )),
      );
    },
  );

  server.registerTool(
    "amazon_list_order_items",
    {
      title: "List Amazon order items",
      description: accountDescription("Return the non-PII item data from one order."),
      inputSchema: getOrderSchema,
      outputSchema: listOrderItemsOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const { marketplaceId: marketplace, orderId: id } = input;
      const seller = await resolveAccountInput(input);
      const response = (await readSpApi({
        sellingPartnerId: seller,
        tenantId: tenantId(),
        region: regionForMarketplace(marketplace),
        path: `/orders/2026-01-01/orders/${encodeURIComponent(id)}`,
      })) as { order?: { orderItems?: unknown[] } };
      return successResult(
        listOrderItemsOutputSchema,
        toOrderItemsOutput(projectOrderItemsResponse({
          orderId: id,
          orderItems: response.order?.orderItems ?? [],
        })),
      );
    },
  );

  const inventorySchema = withAccount({
    marketplaceId,
    details: z.boolean().default(true),
    startDateTime: timestamp.optional(),
    sellerSkus: z.array(z.string().min(1).max(50)).max(50).optional(),
    nextToken: z.string().min(1).optional(),
    autoPage: z.boolean().default(false),
  });

  server.registerTool(
    "amazon_list_inventory_summaries",
    {
      title: "List FBA inventory summaries",
      description: accountDescription("List FBA inventory summaries for one marketplace. This is FBA only; FBM inventory is out of scope, so an empty result is normal for an FBM-only seller. autoPage defaults to false and reads at most 5 pages when enabled."),
      inputSchema: inventorySchema,
      outputSchema: listInventoryOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const {
        marketplaceId: marketplace,
        nextToken: initialToken,
        autoPage,
        details,
        startDateTime,
        sellerSkus,
      } = input;
      const seller = await resolveAccountInput(input);
      const currentTenantId = tenantId();
      const region = regionForMarketplace(marketplace);
      const { pages, nextToken } = await readPages({
        autoPage,
        initialToken,
        read: (token) => readSpApi({
          sellingPartnerId: seller,
          tenantId: currentTenantId,
          region,
          path: "/fba/inventory/v1/summaries",
          query: {
            details,
            startDateTime,
            sellerSkus,
            granularityType: "Marketplace",
            granularityId: marketplace,
            marketplaceIds: [marketplace],
            nextToken: token,
          },
        }),
      });
      const firstPayload = record(pages[0]?.payload);
      return successResult(
        listInventoryOutputSchema,
        toInventoryOutput(projectInventoryResponse({
          payload: {
            granularity: firstPayload?.granularity,
            inventorySummaries: pages.flatMap((page) => {
              const summaries = record(page.payload)?.inventorySummaries;
              return Array.isArray(summaries) ? summaries : [];
            }),
          },
          pagination: { nextToken, hasMore: Boolean(nextToken) },
        })),
      );
    },
  );

  if (options.enableListingsTools) {
    const listingIncludedData = ["summaries", "issues", "fulfillmentAvailability"] as const;
    const listingBaseSchema = withAccount({
      marketplaceId,
    });

    server.registerTool(
      "amazon_search_listings",
      {
        title: "Search Amazon listings",
        description: accountDescription("Search read-only Listing summaries for one marketplace. Returns allowlisted status, issue codes, and fulfillment availability; quantities are not a complete cross-channel inventory total."),
        inputSchema: listingBaseSchema.extend({
          sellerSkus: z.array(z.string().min(1).max(50)).min(1).max(20).optional(),
          pageSize: z.number().int().min(1).max(20).default(20),
          pageToken: z.string().min(1).optional(),
        }),
        outputSchema: searchListingsOutputSchema,
        annotations: toolAnnotations.externalRead,
      },
      async (input) => {
        const { marketplaceId: marketplace, sellerSkus, pageSize, pageToken } = input;
        const seller = await resolveAccountInput(input);
        const response = record(await readSpApi({
          sellingPartnerId: seller,
          tenantId: tenantId(),
          region: regionForMarketplace(marketplace),
          path: `/listings/2021-08-01/items/${encodeURIComponent(seller)}`,
          query: {
            marketplaceIds: [marketplace],
            includedData: listingIncludedData,
            sellerSkus,
            pageSize,
            pageToken,
          },
        })) ?? {};
        const pagination = record(response.pagination) ?? {};
        const nextToken = typeof pagination.nextToken === "string"
          ? pagination.nextToken
          : undefined;
        return successResult(
          searchListingsOutputSchema,
          toListingsOutput(projectListingsResponse({
            ...response,
            pagination: {
              ...pagination,
              hasMore: Boolean(nextToken),
            },
          })),
        );
      },
    );

    server.registerTool(
      "amazon_get_listing_item",
      {
        title: "Get Amazon listing item",
        description: accountDescription("Get one read-only Listing by seller SKU and marketplace. Returns only allowlisted non-PII summary, issue-code, and fulfillment-availability fields."),
        inputSchema: listingBaseSchema.extend({
          sellerSku: z.string().min(1).max(50),
        }),
        outputSchema: getListingItemOutputSchema,
        annotations: toolAnnotations.externalRead,
      },
      async (input) => {
        const { marketplaceId: marketplace, sellerSku } = input;
        const seller = await resolveAccountInput(input);
        return successResult(
          getListingItemOutputSchema,
          toListingItemOutput(projectListingItemResponse(
            await readSpApi({
              sellingPartnerId: seller,
              tenantId: tenantId(),
              region: regionForMarketplace(marketplace),
              path: `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(sellerSku)}`,
              query: {
                marketplaceIds: [marketplace],
                includedData: listingIncludedData,
              },
            }),
          )),
        );
      },
    );
  }

  server.registerTool(
    "amazon_get_inventory_by_sku",
    {
      title: "Get FBA inventory by seller SKU",
      description: accountDescription("Get the FBA inventory summary for one seller SKU and marketplace."),
      inputSchema: withAccount({
        marketplaceId,
        sellerSku: z.string().min(1).max(50),
        details: z.boolean().default(true),
      }),
      outputSchema: listInventoryOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const { marketplaceId: marketplace, sellerSku, details } = input;
      const seller = await resolveAccountInput(input);
      return successResult(
        listInventoryOutputSchema,
        toInventoryOutput(projectInventoryResponse(
          await readSpApi({
            sellingPartnerId: seller,
            tenantId: tenantId(),
            region: regionForMarketplace(marketplace),
            path: "/fba/inventory/v1/summaries",
            query: {
              details,
              granularityType: "Marketplace",
              granularityId: marketplace,
              marketplaceIds: [marketplace],
              sellerSku,
            },
          }),
        )),
      );
    },
  );

  if (options.connections) {
    server.registerTool(
      "amazon_connection_health",
      {
        title: "Check Amazon seller connection health",
        description: accountDescription(`Use as the first troubleshooting step: reuse a valid LWA access token when possible and verify Sellers API access. Token force-refresh only happens on clear Amazon token-invalid responses.${isConnectedAccount ? "" : " A single connected seller and its region are selected automatically when omitted."}`),
        inputSchema: withAccount({
          region: amazonRegion.optional(),
        }),
        outputSchema: connectionHealthOutputSchema,
        annotations: toolAnnotations.externalRead,
      },
      async (input) => {
        const { region } = input;
        const seller = await resolveAccountInput(input);
        const currentTenantId = tenantId();
        const cachedRegion = !region
          ? options.regionCache?.get(currentTenantId, seller)
          : undefined;
        let result: { region: AmazonRegion; response: MarketplaceParticipations };
        try {
          result = await discoverMarketplaceRegion({
            client,
            sellingPartnerId: seller,
            tenantId: currentTenantId,
            region: (region || cachedRegion) as AmazonRegion | undefined,
          });
        } catch (error) {
          if (cachedRegion) options.regionCache?.delete(currentTenantId, seller);
          throw error;
        }
        if (!region) options.regionCache?.set(currentTenantId, seller, result.region);
        return successResult(connectionHealthOutputSchema, {
          status: "ok",
          sellingPartnerId: seller,
          region: result.region,
          marketplaceCount: result.response.payload?.length ?? 0,
          checkedAt: new Date().toISOString(),
        });
      },
    );

    // ConnectedAccount principals manage lifecycle only via /connected-account/v1; legacy tools stay Legacy-only.
    if (!isConnectedAccount) {
      server.registerTool(
        "amazon_create_authorization_url",
        {
          title: "Create Amazon seller authorization URL",
          description: "Create a ten-minute, one-time Amazon Seller Central authorization URL for the current MCP user. Open the returned URL in a browser to complete consent. No Legacy page is involved.",
          inputSchema: z.object({}).strict(),
          outputSchema: createAuthorizationUrlOutputSchema,
          annotations: toolAnnotations.externalCreate,
        },
        async () => successResult(createAuthorizationUrlOutputSchema, {
          authorizationUrl: await options.connections!.createAuthorizationURL(tenantId()),
          expiresInSeconds: 600,
        }),
      );

      server.registerTool(
        "amazon_create_renewal_url",
        {
          title: "Create Amazon seller renewal URL",
          description: "Re-authorize an existing connection with a ten-minute, one-time Seller Central Manage Your Apps URL. For first-time authorization use amazon_create_authorization_url instead to avoid MD1000; the seller must click Re-Authorize in the browser.",
          inputSchema: z.object({}).strict(),
          outputSchema: createRenewalUrlOutputSchema,
          annotations: toolAnnotations.externalCreate,
        },
        async () => successResult(createRenewalUrlOutputSchema, {
          renewalUrl: await options.connections!.createRenewalURL(tenantId()),
          expiresInSeconds: 600,
        }),
      );

      server.registerTool(
        "amazon_list_connections",
        {
          title: "List Amazon seller connections",
          description: "List Amazon seller accounts connected to the current MCP user. Credentials and refresh tokens are never returned.",
          inputSchema: z.object({}).strict(),
          outputSchema: listConnectionsOutputSchema,
          annotations: toolAnnotations.localRead,
        },
        async () => successResult(listConnectionsOutputSchema, {
          items: await options.connections!.listConnections(tenantId()),
        }),
      );

      server.registerTool(
        "amazon_disconnect_connection",
        {
          title: "Disconnect Amazon seller",
          description: "Only delete the current user's encrypted local refresh token for one Amazon seller. Required: sellingPartnerId and confirmDisconnect=DISCONNECT. The result includes the regional Seller Central Manage Your Apps link required to finish Amazon-side revocation.",
          inputSchema: z.object({
            sellingPartnerId,
            confirmDisconnect: z.string(),
          }).strict(),
          outputSchema: disconnectConnectionOutputSchema,
          annotations: toolAnnotations.externalDestructive,
        },
        async ({ sellingPartnerId: seller, confirmDisconnect }) => {
          if (confirmDisconnect !== "DISCONNECT") {
            throw new AmazonMcpError(
              "INVALID_FILTER",
              "confirmDisconnect must be DISCONNECT before removing Amazon credentials",
            );
          }
          await options.connections!.disconnect(tenantId(), seller);
          return successResult(disconnectConnectionOutputSchema, {
            disconnected: true,
            sellingPartnerId: seller,
            amazonAuthorizationRevoked: false,
            sellerCentralManageUrl: sellerCentralManageURL,
            nextAction: `Open ${sellerCentralManageURL} and disable this app in Seller Central to revoke its Amazon authorization.`,
          });
        },
      );
    }
  }

  return server;
}
