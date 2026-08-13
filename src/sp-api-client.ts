import { AmazonMcpError, type AmazonMcpErrorCode } from "./errors.js";
import { abortAfter, abortableSleep, waitForAbortable } from "./abort.js";
import { NULL_LOGGER, type StructuredLogger } from "./logger.js";
import { mcpMetrics } from "./metrics.js";

export type AmazonRegion = "na" | "eu" | "fe";

export type QueryValue = string | number | boolean | readonly string[] | undefined;

const DEFAULT_SLEEP = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface SpApiRequestOptions {
  sellingPartnerId: string;
  tenantId: string;
  region: AmazonRegion;
  operation: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  retryMode: "safe" | "never";
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface AccessTokenProvider {
  getAccessToken(
    sellingPartnerId: string,
    tenantId: string,
    forceRefresh?: boolean,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Optional recovery path used only after Amazon returns a clear token-invalid response.
   * Implementations must not log token material.
   */
  recoverAccessToken?(
    sellingPartnerId: string,
    tenantId: string,
    rejectedAccessToken: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface SpApiReader {
  get(options: {
    sellingPartnerId: string;
    tenantId: string;
    region: AmazonRegion;
    path: string;
    query?: Record<string, QueryValue>;
    deadlineAt?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  request?(options: SpApiRequestOptions): Promise<unknown>;
}

const ENDPOINTS: Record<AmazonRegion, string> = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

const MARKETPLACE_REGIONS: Record<string, AmazonRegion> = {
  ATVPDKIKX0DER: "na",
  A2EUQ1WTGCTBG2: "na",
  A1AM78C64UM0Y8: "na",
  A2Q3Y263D00KWC: "na",
  A2ZV50J4W1RKNI: "na",
  A3H6HPSLHAK3XG: "na",
  A1MQXOICRS2Z7M: "na",
  A1F83G8C2ARO7P: "eu",
  A1PA6795UKMFR9: "eu",
  A13V1IB3VIYZZH: "eu",
  APJ6JRA9NG5V4: "eu",
  A1RKKUPIHCS9HS: "eu",
  A28R8C7NBKEWEA: "eu",
  A1805IZSGTT6HS: "eu",
  A2NODRKZP88ZB9: "eu",
  A1C3SOZRARQ6R3: "eu",
  A33AVAJ2PDY3EV: "eu",
  A17E79C6D8DWNP: "eu",
  A2VIGQ35RCS4UG: "eu",
  ARBP9OOSHTCHU: "eu",
  AMEN7PMS3EDWL: "eu",
  A21TJRUUN4KGV: "eu",
  A1VC38T7YXB528: "fe",
  A39IBJ37TRP1C6: "fe",
  A19VAU5U5O7RUS: "fe",
};

const NONSTANDARD_MARKETPLACE_IDS = new Set([
  "A2ZV50J4W1RKNI",
  "A3H6HPSLHAK3XG",
  "A1MQXOICRS2Z7M",
]);

export function supportsFbaInventory(marketplaceId: string): boolean {
  return MARKETPLACE_REGIONS[marketplaceId] !== undefined
    && !NONSTANDARD_MARKETPLACE_IDS.has(marketplaceId);
}

export function supportsListingsItems(marketplaceId: string): boolean {
  return MARKETPLACE_REGIONS[marketplaceId] !== undefined
    && !NONSTANDARD_MARKETPLACE_IDS.has(marketplaceId);
}

/**
 * Frozen Amazon SP-API Access Token invalid conditions (2026-07).
 * Sources: SP-API error responses for invalid/expired LWA access tokens use HTTP 401,
 * or HTTP 403 with errors[].code === "Unauthorized".
 * Permission denials use other codes (e.g. Unauthorized is specifically the auth gate;
 * non-token 403s from missing roles often still use Unauthorized in some APIs — we only
 * treat Unauthorized as token-invalid when status is 401/403, matching Amazon token docs.
 * We deliberately do NOT treat all 403s as token failure.
 */
export function isAmazonAccessTokenInvalidError(options: {
  status: number;
  errorCode?: string;
}): boolean {
  if (options.status === 401) return true;
  if (options.status === 403 && options.errorCode === "Unauthorized") return true;
  return false;
}

export function regionForMarketplace(marketplaceId: string): AmazonRegion {
  const region = MARKETPLACE_REGIONS[marketplaceId];
  if (!region) {
    throw new AmazonMcpError(
      "INVALID_FILTER",
      "unsupported marketplace ID",
    );
  }
  return region;
}

export function regionForMarketplaces(marketplaceIds: readonly string[]): AmazonRegion {
  const region = regionForMarketplace(marketplaceIds[0] ?? "");
  if (marketplaceIds.some((marketplaceId) => regionForMarketplace(marketplaceId) !== region)) {
    throw new AmazonMcpError(
      "REGION_MISMATCH",
      "marketplace IDs must belong to one Amazon region",
    );
  }
  return region;
}

function codeForSpApiStatus(status: number): AmazonMcpErrorCode {
  if (status === 400 || status === 413 || status === 415) return "INVALID_FILTER";
  if (status === 429) return "RATE_LIMITED";
  return "UPSTREAM_SP_API";
}

export class SpApiError extends AmazonMcpError {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
    readonly errorCode?: string,
  ) {
    const retryable = status === 429 || status >= 500;
    super(
      codeForSpApiStatus(status),
      message,
      retryable,
      requestId ? { status, requestId } : { status },
    );
    this.name = "SpApiError";
  }
}

export class SpApiRequestBudgetExceededError extends AmazonMcpError {
  constructor() {
    super("TIMEOUT", "Amazon SP-API request budget exhausted");
    this.name = "SpApiRequestBudgetExceededError";
  }
}

function buildQuery(values: Record<string, QueryValue> | undefined): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined) continue;
    query.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }
  return query;
}

function operationForPath(path: string): string {
  if (path === "/sellers/v1/marketplaceParticipations") return "marketplace_participations";
  if (path === "/orders/2026-01-01/orders") return "search_orders";
  if (path.startsWith("/orders/2026-01-01/orders/")) return "get_order";
  if (path === "/fba/inventory/v1/summaries") return "inventory_summaries";
  if (/^\/listings\/2021-08-01\/items\/[^/]+$/.test(path)) return "search_listings";
  if (path.startsWith("/listings/2021-08-01/items/")) return "get_listing_item";
  return "unknown";
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 8_000);
}

async function parseSpApiError(
  response: Response,
  readJson: () => Promise<unknown> = () => response.json(),
  outerSignal?: AbortSignal,
): Promise<{
  message: string;
  errorCode?: string;
  requestId?: string;
}> {
  const requestId = response.headers.get("x-amzn-requestid") ?? undefined;
  try {
    const body = (await readJson()) as { errors?: Array<{ code?: string }> };
    const errorCode = typeof body.errors?.[0]?.code === "string"
      ? body.errors[0].code
      : undefined;
    return {
      message: errorCode
        ? `Amazon SP-API request failed: ${errorCode}`
        : "Amazon SP-API request failed",
      errorCode,
      requestId,
    };
  } catch (error) {
    outerSignal?.throwIfAborted();
    if (error instanceof SpApiRequestBudgetExceededError) throw error;
    if (error instanceof AmazonMcpError) throw error;
    return { message: "Amazon SP-API request failed", requestId };
  }
}

export class AmazonSpApiClient implements SpApiReader {
  readonly #accessTokens: AccessTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #logger: StructuredLogger;
  readonly #now: () => number;
  readonly #requestTimeoutLimitMs: number;

  constructor(options: {
    accessTokens: AccessTokenProvider;
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    logger?: StructuredLogger;
    now?: () => number;
    requestTimeoutMs?: number;
  }) {
    this.#accessTokens = options.accessTokens;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? DEFAULT_SLEEP;
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutLimitMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.#requestTimeoutLimitMs) || this.#requestTimeoutLimitMs <= 0) {
      throw new Error("SP-API request timeout must be positive");
    }
  }

  async get(options: {
    sellingPartnerId: string;
    tenantId: string;
    region: AmazonRegion;
    path: string;
    query?: Record<string, QueryValue>;
    deadlineAt?: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    return this.request({
      ...options,
      operation: operationForPath(options.path),
      method: "GET",
      retryMode: "safe",
    });
  }

  async request(options: SpApiRequestOptions): Promise<unknown> {
    const deadlineBudget = options.deadlineAt === undefined
      ? undefined
      : abortAfter(
        options.deadlineAt - this.#now(),
        new SpApiRequestBudgetExceededError(),
      );
    const signal = options.signal && deadlineBudget
      ? AbortSignal.any([options.signal, deadlineBudget.signal])
      : options.signal ?? deadlineBudget?.signal;
    try {
      this.#assertActive(options.deadlineAt, signal);
      let accessToken = await waitForAbortable(
        this.#accessTokens.getAccessToken(
          options.sellingPartnerId,
          options.tenantId,
          undefined,
          signal,
        ),
        signal,
      );
      this.#assertActive(options.deadlineAt, signal);
      let tokenRecoveryUsed = false;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startedAt = performance.now();
        const requestTimeoutMs = this.#requestTimeoutMs(options.deadlineAt);
        const requestUsesRemainingBudget = options.deadlineAt !== undefined &&
          this.#now() + requestTimeoutMs >= options.deadlineAt;
        const requestTimeout = abortAfter(
          requestTimeoutMs,
          requestUsesRemainingBudget
            ? new SpApiRequestBudgetExceededError()
            : new DOMException("Amazon SP-API request timed out", "TimeoutError"),
        );
        const requestSignal = signal
          ? AbortSignal.any([signal, requestTimeout.signal])
          : requestTimeout.signal;
        try {
          let response: Response;
          try {
            response = await this.#fetch(
              (() => {
                const url = new URL(options.path, ENDPOINTS[options.region]);
                url.search = buildQuery(
                  options.query as Record<string, QueryValue> | undefined,
                ).toString();
                return url;
              })(),
              {
                method: options.method,
                headers: {
                  accept: "application/json",
                  ...(options.body === undefined ? {} : { "content-type": "application/json" }),
                  "user-agent": "AmazonSpApiService/0.1",
                  "x-amz-access-token": accessToken,
                },
                ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                signal: requestSignal,
              },
            );
          } catch (error) {
            const operation = options.operation;
            const errorCode = requestSignal.aborted ? "timeout" : "upstream_error";
            this.#logger.write("error", "sp_api.request.failed", {
              operation,
              attempt: attempt + 1,
              duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
              error_code: errorCode,
              result: "error",
            });
            mcpMetrics.inc("sp_api_errors_total", "SP-API transport errors", {
              operation,
              error_code: errorCode,
            });
            if (signal?.aborted) signal.throwIfAborted();
            if (requestTimeout.signal.reason instanceof SpApiRequestBudgetExceededError) {
              throw requestTimeout.signal.reason;
            }
            if (options.retryMode === "safe" && attempt < 2) {
              await this.#sleepWithinBudget(
                Math.min(1000 * 2 ** attempt, 8_000),
                options.deadlineAt,
                signal,
              );
              continue;
            }
            throw new AmazonMcpError(
              "UPSTREAM_SP_API",
              "Amazon SP-API network request failed",
              true,
            );
          }
          const operation = options.operation;
          const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
          this.#logger.write(response.ok ? "info" : "warn", response.ok
            ? "sp_api.request.completed"
            : "sp_api.request.failed", {
            operation,
            attempt: attempt + 1,
            duration_ms: durationMs,
            ...(response.ok
              ? { result: "success" as const }
              : {
                result: "error" as const,
                upstream_status: response.status,
                error_code: response.status === 429
                  ? "rate_limited" as const
                  : "upstream_error" as const,
              }),
          });
          mcpMetrics.observeSeconds(
            "sp_api_duration_seconds",
            "SP-API request duration",
            durationMs / 1000,
            {
              operation,
              result: response.ok ? "success" : "error",
            },
          );
          if (response.status === 429) {
            mcpMetrics.inc("sp_api_errors_total", "SP-API transport errors", {
              operation,
              error_code: "rate_limited",
            });
          } else if (response.status >= 500) {
            mcpMetrics.inc("sp_api_errors_total", "SP-API transport errors", {
              operation,
              error_code: "upstream_error",
            });
          }

          if (!response.ok) {
            const parsed = await parseSpApiError(
              response,
              () => this.#readResponseJson(
                response,
                options.deadlineAt,
                requestSignal,
              ),
              signal,
            );
            if (
              isAmazonAccessTokenInvalidError({
                status: response.status,
                errorCode: parsed.errorCode,
              }) &&
              !tokenRecoveryUsed
            ) {
              tokenRecoveryUsed = true;
              const rejected = accessToken;
              const recovered = await waitForAbortable(
                this.#accessTokens.recoverAccessToken
                  ? this.#accessTokens.recoverAccessToken(
                    options.sellingPartnerId,
                    options.tenantId,
                    rejected,
                    signal,
                  )
                  : this.#accessTokens.getAccessToken(
                    options.sellingPartnerId,
                    options.tenantId,
                    true,
                    signal,
                  ),
                signal,
              );
              if (recovered === rejected) {
                throw new SpApiError(
                  response.status,
                  parsed.message,
                  parsed.requestId,
                  parsed.errorCode,
                );
              }
              accessToken = recovered;
              this.#assertActive(options.deadlineAt, signal);
              // Retry the same logical request once with the recovered token.
              attempt -= 1;
              continue;
            }

            if (
              options.retryMode === "safe" &&
              (response.status === 429 || response.status >= 500) &&
              attempt < 2
            ) {
              await this.#sleepWithinBudget(
                retryDelay(response, attempt),
                options.deadlineAt,
                signal,
              );
              continue;
            }

            throw new SpApiError(
              response.status,
              parsed.message,
              parsed.requestId,
              parsed.errorCode,
            );
          }

          if (response.status === 204) return {};
          try {
            return await this.#readResponseJson(
              response,
              options.deadlineAt,
              requestSignal,
            );
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof SpApiRequestBudgetExceededError) throw error;
            if (error instanceof AmazonMcpError) throw error;
            throw new AmazonMcpError(
              "UPSTREAM_SP_API",
              "Amazon SP-API response was not valid JSON",
              true,
              { status: response.status },
            );
          }
        } finally {
          requestTimeout.dispose();
        }
      }

      throw new SpApiError(502, "Amazon SP-API retry limit exceeded");
    } finally {
      deadlineBudget?.dispose();
    }
  }

  #assertWithinBudget(deadlineAt?: number): void {
    if (deadlineAt !== undefined && this.#now() >= deadlineAt) {
      throw new SpApiRequestBudgetExceededError();
    }
  }

  #assertActive(deadlineAt?: number, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.#assertWithinBudget(deadlineAt);
  }

  #requestTimeoutMs(deadlineAt?: number): number {
    if (deadlineAt === undefined) return this.#requestTimeoutLimitMs;
    const remainingMs = deadlineAt - this.#now();
    if (remainingMs <= 0) throw new SpApiRequestBudgetExceededError();
    return Math.max(1, Math.min(this.#requestTimeoutLimitMs, Math.ceil(remainingMs)));
  }

  async #sleepWithinBudget(
    milliseconds: number,
    deadlineAt?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const now = this.#now();
    if (deadlineAt !== undefined && now + milliseconds >= deadlineAt) {
      throw new SpApiRequestBudgetExceededError();
    }
    if (this.#sleep === DEFAULT_SLEEP) await abortableSleep(milliseconds, signal);
    else await waitForAbortable(this.#sleep(milliseconds), signal);
    this.#assertActive(deadlineAt, signal);
  }

  async #readResponseJson(
    response: Response,
    deadlineAt: number | undefined,
    requestSignal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await waitForAbortable(response.json(), requestSignal);
    } catch (error) {
      if (requestSignal.aborted) {
        try {
          void response.body?.cancel().catch(() => {});
        } catch {
          // The body may already have been cancelled by fetch.
        }
      }
      if (
        error instanceof SpApiRequestBudgetExceededError ||
        (deadlineAt !== undefined &&
          (this.#now() >= deadlineAt ||
            requestSignal.reason instanceof SpApiRequestBudgetExceededError))
      ) {
        throw new SpApiRequestBudgetExceededError();
      }
      if (
        requestSignal.aborted &&
        requestSignal.reason instanceof DOMException &&
        requestSignal.reason.name === "TimeoutError"
      ) {
        throw new AmazonMcpError(
          "UPSTREAM_SP_API",
          "Amazon SP-API response timed out",
          true,
          { status: response.status },
        );
      }
      throw error;
    }
  }
}
