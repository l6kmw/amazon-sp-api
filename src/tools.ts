import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { abortAfter, waitForAbortable } from "./abort.js";
import { AmazonMcpError, normalizeToolErrorMessage } from "./errors.js";

import { mcpMetrics } from "./metrics.js";
import type { AmazonDocumentReader } from "./document-reader.js";
import type { AmazonPrincipal } from "./identity.js";
import type { LocalAccountAccessPolicy } from "./local-identity.js";
import {
  ConnectedAccountError,
  type ConnectedAccountProtocol,
  type MaybePromise,
} from "./connected-accounts.js";
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
  SpApiRequestBudgetExceededError,
  regionForMarketplace,
  regionForMarketplaces,
  supportsFbaInventory,
  supportsListingsItems,
  type AmazonRegion,
  type SpApiReader,
} from "./sp-api-client.js";
import { NULL_LOGGER, type StructuredLogger } from "./logger.js";
import {
  READ_OPERATIONS,
  SP_API_DOMAINS,
  SpApiCapabilityTracker,
  domainInputSchema,
  executeReadOperation,
  isDocumentReadOperation,
  operationForAction,
  validateOperationInput,
  type SpApiDomain,
} from "./sp-api-operations.js";
import {
  businessSnapshotOutputSchema,
  connectionHealthOutputSchema,
  getListingItemOutputSchema,
  getOrderOutputSchema,
  identityOutputSchema,
  listAccountsOutputSchema,
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

export interface AmazonMcpServerOptions {
  principal?: AmazonPrincipal;
  regionCache?: AmazonSellerRegionCache;
  capabilityTracker?: SpApiCapabilityTracker;
  documentReader?: Pick<AmazonDocumentReader, "readPage">;
  accountAccessPolicy?: LocalAccountAccessPolicy;
  logger?: StructuredLogger;
  now?: () => number;
  searchOrdersBudgetMs?: number;
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

const accountId = z.string().regex(/^acct_[A-Za-z0-9_-]{16,128}$/);
const marketplaceId = z.string().regex(/^[A-Z0-9]{10,20}$/);
const fbaInventoryMarketplaceId = marketplaceId.refine(supportsFbaInventory, {
  message: "marketplaceId is not supported by FBA Inventory",
});
const orderId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const timestamp = z.string().datetime({ offset: true });
const amazonRegion = z.enum(["na", "eu", "fe"]);
const REGION_PROBE_ORDER: AmazonRegion[] = ["na", "eu", "fe"];
export const SEARCH_ORDERS_BUDGET_MS = 50_000;
const SERVER_INSTRUCTIONS = [
  "先调用 amazon_get_identity 和 amazon_list_accounts；账号授权、续期和断开通过本地 /api/v1/accounts 接口管理。",
  "所有 Amazon 业务工具必须使用 amazon_list_accounts 返回的 account_id，不能直接传 Selling Partner ID。",
  "amazon_search_orders 的 createdAfter 与 lastUpdatedAfter 必须二选一，时间使用带 offset 的 ISO-8601。",
  "一次请求的多个 marketplace 必须属于同一区域（na/eu/fe）。",
  "本服务不提供买家、地址、支付或追踪号等 PII，请勿反复索要。",
].join("\n");
const DOMAIN_TITLES: Readonly<Record<SpApiDomain, string>> = {
  seller: "Seller account",
  catalog: "Catalog",
  listings: "Listings",
  orders: "Orders",
  inventory: "Inventory",
  pricing: "Pricing and fees",
  analytics: "Analytics",
  finances: "Finances",
  warehousing: "Amazon Warehousing and Distribution",
  fulfillment: "Fulfillment",
  shipping: "Shipping",
  services: "Services",
  content: "A+ Content",
  reports: "Reports",
  data_kiosk: "Data Kiosk",
  feeds: "Feeds",
  integrations: "Integrations and notifications",
};
const jsonResultSchema = z.union([
  z.record(z.unknown()),
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const genericReadOutputSchema = z.object({
  action: z.string(),
  operation: z.string(),
  model_version: z.string(),
  region: amazonRegion,
  data: jsonResultSchema,
}).strict();
const readCapabilitiesOutputSchema = z.object({
  model_commit: z.string(),
  items: z.array(z.object({
    domain: z.string(),
    action: z.string(),
    operation: z.string(),
    version: z.string(),
    roles: z.array(z.string()),
    regions: z.array(amazonRegion),
    status: z.enum(["unknown", "available", "permission_required"]),
  }).strict()).max(200),
}).strict();

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
  deadlineAt?: number;
  signal?: AbortSignal;
  now?: () => number;
  read: (nextToken?: string, deadlineAt?: number) => Promise<unknown>;
}): Promise<{ pages: Record<string, unknown>[]; nextToken?: string; budgetExhausted: boolean }> {
  const pages: Record<string, unknown>[] = [];
  const requestedTokens = new Set<string>();
  let nextToken = options.initialToken;
  let budgetExhausted = false;
  for (let page = 0; page < (options.autoPage ? 5 : 1); page += 1) {
    options.signal?.throwIfAborted();
    if (options.deadlineAt !== undefined && (options.now ?? Date.now)() >= options.deadlineAt) {
      if (pages.length === 0) throw new SpApiRequestBudgetExceededError();
      budgetExhausted = true;
      break;
    }
    if (nextToken) requestedTokens.add(nextToken);
    let result: unknown;
    try {
      result = await options.read(nextToken, options.deadlineAt);
    } catch (error) {
      if (
        error instanceof SpApiRequestBudgetExceededError &&
        !options.signal?.aborted &&
        pages.length > 0
      ) {
        budgetExhausted = true;
        break;
      }
      if (
        error instanceof SpApiRequestBudgetExceededError &&
        options.signal?.aborted
      ) {
        options.signal.throwIfAborted();
      }
      throw error;
    }
    const response = record(result) ?? {};
    pages.push(response);
    const token = record(response.pagination)?.nextToken;
    nextToken = typeof token === "string" && token ? token : undefined;
    if (!nextToken) break;
    if (requestedTokens.has(nextToken)) {
      throw new AmazonMcpError(
        "UPSTREAM_SP_API",
        "Amazon SP-API returned a repeated pagination token",
        false,
      );
    }
  }
  return { pages, nextToken, budgetExhausted };
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

function publicIdentityId(principal: AmazonPrincipal): string {
  return principal.employeeId;
}

function snapshotSummary(options: {
  regions: readonly AmazonRegion[];
  participatingCount: number;
  lookbackDays: number;
  ordersSampled: number;
  includeInventory: boolean;
  inventoryCheckedMarketplaceCount: number;
  analyzedMarketplaceCount: number;
  inventorySummaryCount: number;
  includeListings: boolean;
  listingsCheckedMarketplaceCount: number;
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
    : options.inventoryCheckedMarketplaceCount === 0
      ? `0/${options.analyzedMarketplaceCount} 个已分析站点支持 FBA 库存查询，本次未发起库存请求`
      : options.inventorySummaryCount === 0
        ? `已检查 ${options.inventoryCheckedMarketplaceCount}/${options.analyzedMarketplaceCount} 个站点的 FBA 库存，库存汇总为空`
        : `已检查 ${options.inventoryCheckedMarketplaceCount}/${options.analyzedMarketplaceCount} 个站点的 FBA 库存，本次返回 ${options.inventorySummaryCount} 条库存汇总`;
  const inventoryGuidance = options.includeInventory
    ? "如需库存明细，请调用 amazon_list_inventory_summaries。"
    : "如需库存状态，请重新调用 amazon_business_snapshot 并设置 includeInventory=true。";
  const listings = !options.includeListings
    ? "未检查 Listings"
    : options.listingsCheckedMarketplaceCount === 0
      ? `0/${options.analyzedMarketplaceCount} 个已分析站点支持 Listings Items，本次未发起 Listings 请求`
      : options.listingSampleCount === 0
        ? `已检查 ${options.listingsCheckedMarketplaceCount}/${options.analyzedMarketplaceCount} 个站点的 Listings，Listing 抽样为空`
        : `已检查 ${options.listingsCheckedMarketplaceCount}/${options.analyzedMarketplaceCount} 个站点的 Listings，抽样发现 ${options.listingSampleCount} 个刊登，其中 ${options.buyableListingSampleCount} 个可购买，${options.listingIssueSampleCount} 个含问题代码`;
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
  const now = options.now ?? Date.now;
  const logger = options.logger ?? NULL_LOGGER;
  const searchOrdersBudgetMs = options.searchOrdersBudgetMs ?? SEARCH_ORDERS_BUDGET_MS;
  if (!Number.isFinite(searchOrdersBudgetMs) || searchOrdersBudgetMs <= 0) {
    throw new Error("search orders budget must be positive");
  }
  const withAccount = <T extends z.ZodRawShape>(fields: T) => z.object({
    account_id: accountId,
    ...fields,
  }).strict();
  const accountDescription = (description: string) =>
    `${description} Required: account_id from amazon_list_accounts.`;
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

  const readSpApi: SpApiReader["get"] = (request) => client.get(request);

  server.registerTool(
    "amazon_get_identity",
    {
      title: "Get Amazon MCP identity",
      description: "Return a safe summary of the authenticated MCP identity. No tenant, workspace, JWT claims, token, or credential metadata is returned.",
      inputSchema: z.object({ account_id: accountId.optional() }).strict(),
      outputSchema: identityOutputSchema,
      annotations: toolAnnotations.localRead,
    },
    async () => {
      if (!options.principal) {
        throw new AmazonMcpError("TENANT_REQUIRED", "authenticated identity is required");
      }
      return successResult(identityOutputSchema, {
        identity_type: "local_owner",
        identity_id: publicIdentityId(options.principal),
        role: "owner",
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
      if (options.principal && options.accountAccessPolicy) {
        const accounts = await options.accountAccessPolicy.listAccounts(options.principal);
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
      return successResult(listAccountsOutputSchema, { items: [] });
    },
  );

  const resolveAccountInput = async (input: unknown, signal?: AbortSignal) => {
    const values = record(input);
    if (!options.principal || !options.accountAccessPolicy || typeof values?.account_id !== "string") {
      throw new AmazonMcpError("NOT_CONNECTED", "Amazon account is not available");
    }
    try {
      return await waitForAbortable(
        options.accountAccessPolicy.resolveAccount(
          options.principal,
          values.account_id,
          signal,
        ),
        signal,
      );
    } catch (error) {
      if (signal?.aborted || error instanceof SpApiRequestBudgetExceededError) throw error;
      mcpMetrics.inc("account_access_rejections_total", "Account policy access rejections", {
        actor_type: options.principal.authType === "employee_jwt" ? "employee_jwt" : "test_agent",
        error_code: error instanceof ConnectedAccountError && error.status === 404
          ? "resource_not_found"
          : "forbidden",
      });
      if (error instanceof ConnectedAccountError && error.status === 404) {
        throw new AmazonMcpError("NOT_CONNECTED", "Amazon account is not available");
      }
      throw error;
    }
  };

  server.registerTool(
    "amazon_get_read_capabilities",
    {
      title: "List frozen Amazon read capabilities",
      description: "List allowlisted Seller read actions from the frozen official model. Status is observed locally and does not trigger Amazon permission probes.",
      inputSchema: z.object({
        account_id: accountId,
        domain: z.enum(SP_API_DOMAINS).optional(),
      }).strict(),
      outputSchema: readCapabilitiesOutputSchema,
      annotations: toolAnnotations.localRead,
    },
    async (input) => {
      const access = await resolveAccountInput(input);
      const currentTenantId = access.credentialOwnerId;
      const selected = READ_OPERATIONS.filter((operation) => !input.domain || operation.domain === input.domain);
      return successResult(readCapabilitiesOutputSchema, {
        model_commit: "6ad2ee14835a9aa31889ae5607ea4e1fcc90f3ad",
        items: selected.map((operation) => ({
          domain: operation.domain,
          action: operation.action,
          operation: operation.operationId,
          version: operation.version,
          roles: [...operation.roles],
          regions: [...operation.regions],
          status: options.capabilityTracker?.get(
            currentTenantId,
            input.account_id,
            operation.operationId,
          ) ?? "unknown",
        })),
      });
    },
  );

  for (const domain of SP_API_DOMAINS) {
    const domainDescription = domain === "orders"
      ? `Run one frozen, allowlisted ${DOMAIN_TITLES[domain]} Seller read action. Put searchOrders filters in query and omit body; autoPage is supported only by amazon_search_orders. Arbitrary methods, paths, URLs, headers and restricted operations are not accepted.`
      : `Run one frozen, allowlisted ${DOMAIN_TITLES[domain]} Seller read action. Arbitrary methods, paths, URLs, headers and restricted operations are not accepted.`;
    server.registerTool(
      `amazon_${domain}_read`,
      {
        title: `${DOMAIN_TITLES[domain]} read operations`,
        description: domainDescription,
        inputSchema: domainInputSchema(domain),
        outputSchema: genericReadOutputSchema,
        annotations: toolAnnotations.externalRead,
      },
      async (input: unknown) => {
        const values = input as {
          action: string;
          account_id: string;
          region: AmazonRegion;
          path?: Record<string, unknown>;
          query?: Record<string, unknown>;
          body?: unknown;
        };
        const operation = operationForAction(domain, values.action);
        validateOperationInput(operation, values);
        const access = await resolveAccountInput(values);
        const seller = access.account.externalAccountId;
        const currentTenantId = access.credentialOwnerId;
        let data: unknown;
        if (isDocumentReadOperation(operation)) {
          try {
            data = await options.documentReader?.readPage({
              operation,
              tenantId: currentTenantId,
              employeeId: publicIdentityId(options.principal!),
              accountId: values.account_id,
              sellingPartnerId: seller,
              region: values.region,
              jobId: (values as typeof values & { job_id: string }).job_id,
              cursor: (values as typeof values & { cursor?: string }).cursor,
            }) ?? (() => { throw new AmazonMcpError("INTERNAL", "document reader is unavailable"); })();
            options.capabilityTracker?.set(
              currentTenantId, values.account_id, operation.operationId, "available",
            );
          } catch (error) {
            if (error instanceof AmazonMcpError && error.code === "AMAZON_ROLE_REQUIRED") {
              options.capabilityTracker?.set(
                currentTenantId, values.account_id, operation.operationId, "permission_required",
              );
            }
            throw error;
          }
        } else {
          data = await executeReadOperation({
            client,
            operation,
            tenantId: currentTenantId,
            accountId: values.account_id,
            sellingPartnerId: seller,
            region: values.region,
            input: values,
            capabilities: options.capabilityTracker,
          });
        }
        return successResult(genericReadOutputSchema, {
          action: operation.action,
          operation: operation.operationId,
          model_version: operation.version,
          region: values.region,
          data,
        });
      },
    );
  }

  server.registerTool(
    "amazon_list_marketplaces",
    {
      title: "List Amazon marketplaces",
      description: accountDescription("List marketplace participations. Omit region to auto-discover it; the response then includes region for subsequent calls."),
      inputSchema: withAccount({
        region: amazonRegion.optional(),
      }),
      outputSchema: listMarketplacesOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      const currentTenantId = access.credentialOwnerId;
      const { region } = input;
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
        if (cachedRegion) {
          options.regionCache?.delete(currentTenantId, seller);
        }
        throw error;
      }
      if (!region) {
        options.regionCache?.set(currentTenantId, seller, result.region);
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
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      const currentTenantId = access.credentialOwnerId;
      const participationByRegion = new Map<AmazonRegion, MarketplaceParticipations>();
      const participationRegions = marketplaceIds
        ? [...new Set(marketplaceIds.map(regionForMarketplace))]
        : REGION_PROBE_ORDER;
      for (const region of participationRegions) {
        try {
          const response = await readSpApi({
            sellingPartnerId: seller,
            tenantId: currentTenantId,
            region,
            path: "/sellers/v1/marketplaceParticipations",
          }) as MarketplaceParticipations;
          participationByRegion.set(region, response);
        } catch (error) {
          if (!marketplaceIds && error instanceof SpApiError && error.status === 403) continue;
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
      const inventoryMarketplaceIds = includeInventory
        ? selectedIds.filter(supportsFbaInventory)
        : [];
      if (includeInventory) {
        for (const id of inventoryMarketplaceIds) {
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
      const listingMarketplaceIds = includeListings
        ? selectedIds.filter(supportsListingsItems)
        : [];
      if (includeListings) {
        for (const id of listingMarketplaceIds) {
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
          inventoryCheckedMarketplaceCount: inventoryMarketplaceIds.length,
          analyzedMarketplaceCount: selectedIds.length,
          inventorySummaryCount,
          includeListings,
          listingsCheckedMarketplaceCount: listingMarketplaceIds.length,
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
          checkedMarketplaceCount: inventoryMarketplaceIds.length,
          marketplacesWithInventory,
          summaryCount: inventorySummaryCount,
          isEmpty: inventoryMarketplaceIds.length > 0 ? inventorySummaryCount === 0 : null,
        },
        listings: {
          included: includeListings,
          checkedMarketplaceCount: listingMarketplaceIds.length,
          sampleListingCount: listingSampleCount,
          marketplacesWithListings: listingCountsByMarketplace.filter(
            (item) => item.sampleListingCount > 0,
          ).length,
          buyableSampleCount: buyableListingSampleCount,
          issueSampleCount: listingIssueSampleCount,
          hasMore: listingCountsByMarketplace.some((item) => item.hasMore),
          countsByMarketplace: listingCountsByMarketplace,
          paginationHint: !includeListings
            ? "Listings were not requested; set includeListings=true after enabling the Listings feature flag."
            : listingMarketplaceIds.length === 0
              ? "No selected marketplace supports Listings Items; no Listings request was made."
              : "Only the first 20 Listings per marketplace were sampled; use amazon_search_listings for details and pagination.",
        },
        dataBoundary: `Read-only operational summary. No buyer or recipient datasets are requested, and no buyer, recipient, address, payment, tracking, or other PII is returned; order totals are sampled, not exact. Listings are ${!includeListings ? "not included" : listingMarketplaceIds.length === 0 ? "not queried because the selected marketplaces are unsupported" : "sampled from allowlisted summary and issue-code fields only; totals are not exact"}.`,
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
    async (input, extra) => {
      const toolStartedAt = now();
      const deadlineAt = toolStartedAt + searchOrdersBudgetMs;
      const budget = abortAfter(
        searchOrdersBudgetMs,
        new SpApiRequestBudgetExceededError(),
      );
      const signal = AbortSignal.any([extra.signal, budget.signal]);
      try {
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
        const access = await resolveAccountInput(input, signal);
        const seller = access.account.externalAccountId;
        const currentTenantId = access.credentialOwnerId;
        const region = regionForMarketplaces(marketplaceIds);
        const { pages, nextToken, budgetExhausted } = await readPages({
          autoPage,
          initialToken: paginationToken,
          deadlineAt,
          signal: extra.signal,
          now,
          read: (token, requestDeadlineAt) => readSpApi({
            sellingPartnerId: seller,
            tenantId: currentTenantId,
            region,
            path: "/orders/2026-01-01/orders",
            query: { marketplaceIds, ...filters, paginationToken: token },
            deadlineAt: requestDeadlineAt,
            signal,
          }),
        });
        if (budgetExhausted) {
          logger.write("warn", "mcp.pagination.budget_exhausted", {
            tool: "amazon_search_orders",
            pages_completed: pages.length,
            budget_ms: searchOrdersBudgetMs,
            duration_ms: Math.max(0, now() - toolStartedAt),
            result: "success",
          });
        }
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
      } finally {
        budget.dispose();
      }
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
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      return successResult(
        getOrderOutputSchema,
        toGetOrderOutput(projectOrderResponse(
          await readSpApi({
            sellingPartnerId: seller,
            tenantId: access.credentialOwnerId,
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
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      const response = (await readSpApi({
        sellingPartnerId: seller,
        tenantId: access.credentialOwnerId,
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
    marketplaceId: fbaInventoryMarketplaceId,
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
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      const currentTenantId = access.credentialOwnerId;
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

  const listingIncludedData = ["summaries", "issues", "fulfillmentAvailability"] as const;
  const listingBaseSchema = withAccount({
    marketplaceId: marketplaceId.refine(supportsListingsItems, {
      message: "marketplaceId is not supported by Listings Items",
    }),
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
        const access = await resolveAccountInput(input);
        const seller = access.account.externalAccountId;
        const response = record(await readSpApi({
          sellingPartnerId: seller,
          tenantId: access.credentialOwnerId,
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
        const access = await resolveAccountInput(input);
        const seller = access.account.externalAccountId;
        return successResult(
          getListingItemOutputSchema,
          toListingItemOutput(projectListingItemResponse(
            await readSpApi({
              sellingPartnerId: seller,
              tenantId: access.credentialOwnerId,
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
  server.registerTool(
    "amazon_get_inventory_by_sku",
    {
      title: "Get FBA inventory by seller SKU",
      description: accountDescription("Get the FBA inventory summary for one seller SKU and marketplace."),
      inputSchema: withAccount({
        marketplaceId: fbaInventoryMarketplaceId,
        sellerSku: z.string().min(1).max(50),
        details: z.boolean().default(true),
      }),
      outputSchema: listInventoryOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const { marketplaceId: marketplace, sellerSku, details } = input;
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      return successResult(
        listInventoryOutputSchema,
        toInventoryOutput(projectInventoryResponse(
          await readSpApi({
            sellingPartnerId: seller,
            tenantId: access.credentialOwnerId,
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

  server.registerTool(
    "amazon_connection_health",
    {
      title: "Check Amazon seller connection health",
      description: accountDescription("Use as the first troubleshooting step: reuse a valid LWA access token when possible and verify Sellers API access. Token force-refresh only happens on clear Amazon token-invalid responses."),
      inputSchema: withAccount({
        region: amazonRegion.optional(),
      }),
      outputSchema: connectionHealthOutputSchema,
      annotations: toolAnnotations.externalRead,
    },
    async (input) => {
      const { region } = input;
      const access = await resolveAccountInput(input);
      const seller = access.account.externalAccountId;
      const currentTenantId = access.credentialOwnerId;
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

  return server;
}
