import { AmazonMcpError } from "./errors.js";
import { waitForAbortable } from "./abort.js";
import type { RefreshTokenCredential, RefreshTokenProvider } from "./token-store.js";
import { NULL_LOGGER, type StructuredLogger } from "./logger.js";
import { mcpMetrics } from "./metrics.js";

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
}

interface LwaResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

export class LwaError extends AmazonMcpError {
  constructor(status: number, message: string, oauthError?: string) {
    super(
      oauthError === "invalid_grant" ? "AUTH_EXPIRED" : "UPSTREAM_LWA",
      message,
      status === 429 || status >= 500,
      { status },
    );
    this.name = "LwaError";
  }
}

function cacheKey(
  credential: RefreshTokenCredential,
  sellingPartnerId: string,
  tenantId: string,
): string {
  return JSON.stringify([
    credential.credentialId ?? `legacy:${tenantId}:${sellingPartnerId}`,
    credential.revision,
  ]);
}

function boundedJitterMs(expiresInSeconds: number): number {
  // Bounded random jitter so multi-instance refresh waves do not align.
  const cap = Math.min(30_000, Math.max(0, Math.floor(expiresInSeconds * 50)));
  return cap === 0 ? 0 : Math.floor(Math.random() * (cap + 1));
}

export class LwaAccessTokenProvider {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshTokens: RefreshTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #logger: StructuredLogger;
  readonly #cache = new Map<string, CachedAccessToken>();
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #generations = new Map<string, number>();

  constructor(options: {
    clientId: string;
    clientSecret: string;
    refreshTokens: RefreshTokenProvider;
    fetchImpl?: typeof fetch;
    logger?: StructuredLogger;
  }) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#refreshTokens = options.refreshTokens;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#logger = options.logger ?? NULL_LOGGER;
  }

  async getAccessToken(
    sellingPartnerId: string,
    tenantId: string,
    forceRefresh = false,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!tenantId) {
      throw new AmazonMcpError("TENANT_REQUIRED", "tenant identity is required");
    }
    const credential = await waitForAbortable(
      this.#credential(sellingPartnerId, tenantId),
      signal,
    );
    const key = cacheKey(credential, sellingPartnerId, tenantId);
    if (forceRefresh) {
      signal?.throwIfAborted();
      await waitForAbortable(this.#invalidateKey(key), signal);
    }
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

    const activeExchange = this.#inFlight.get(key);
    if (activeExchange) return waitForAbortable(activeExchange, signal);

    const generation = this.#generations.get(key) ?? 0;
    const exchange = this.#getOrExchangeAccessToken(
      key,
      generation,
      sellingPartnerId,
      tenantId,
      forceRefresh,
      undefined,
      credential,
    );
    this.#trackExchange(key, exchange);
    return waitForAbortable(exchange, signal);
  }

  /**
   * Recover from a rejected Access Token.
   * 1) Reuse a shared/local token that differs from the rejected value.
   * 2) Otherwise force-refresh under the distributed lock (single LWA exchange).
   */
  async recoverAccessToken(
    sellingPartnerId: string,
    tenantId: string,
    rejectedAccessToken: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!tenantId) {
      throw new AmazonMcpError("TENANT_REQUIRED", "tenant identity is required");
    }
    const credential = await waitForAbortable(
      this.#credential(sellingPartnerId, tenantId),
      signal,
    );
    const key = cacheKey(credential, sellingPartnerId, tenantId);
    const local = this.#cache.get(key);
    if (
      local &&
      local.expiresAt > Date.now() &&
      local.accessToken !== rejectedAccessToken
    ) {
      return local.accessToken;
    }

    const activeExchange = this.#inFlight.get(key);
    if (activeExchange) {
      const token = await waitForAbortable(activeExchange, signal);
      if (token !== rejectedAccessToken) return token;
    }

    // Drop the rejected token from local/shared caches before a recovery exchange.
    signal?.throwIfAborted();
    await waitForAbortable(this.#invalidateKey(key), signal);
    const replacementExchange = this.#inFlight.get(key);
    if (replacementExchange) {
      const token = await waitForAbortable(replacementExchange, signal);
      if (token !== rejectedAccessToken) return token;
    }
    const generation = this.#generations.get(key) ?? 0;
    const exchange = this.#getOrExchangeAccessToken(
      key,
      generation,
      sellingPartnerId,
      tenantId,
      true,
      rejectedAccessToken,
      credential,
    );
    this.#trackExchange(key, exchange);
    return waitForAbortable(exchange, signal);
  }

  #trackExchange(key: string, exchange: Promise<string>): void {
    this.#inFlight.set(key, exchange);
    const cleanup = () => {
      if (this.#inFlight.get(key) === exchange) this.#inFlight.delete(key);
    };
    void exchange.then(cleanup, cleanup);
  }

  async #getOrExchangeAccessToken(
    key: string,
    generation: number,
    sellingPartnerId: string,
    tenantId: string,
    forceRefresh: boolean,
    rejectedAccessToken: string | undefined,
    credential: RefreshTokenCredential,
  ): Promise<string> {
    // Single process: the caller already invalidated for forceRefresh/recover,
    // so exchange directly without a distributed lock.
    return (await this.#exchangeAccessToken(
      key,
      generation,
      sellingPartnerId,
      tenantId,
      credential,
    )).accessToken;
  }

  async #exchangeAccessToken(
    key: string,
    generation: number,
    sellingPartnerId: string,
    tenantId: string,
    credential: RefreshTokenCredential,
  ): Promise<CachedAccessToken> {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.#fetch("https://api.amazon.com/auth/o2/token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      this.#logger.write("error", "lwa.refresh.failed", {
        error_code: "lwa_failed",
        result: "error",
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
        attempt: 1,
      });
      throw new AmazonMcpError(
        "UPSTREAM_LWA",
        "LWA token exchange network request failed",
        true,
      );
    }

    this.#logger.write(response.ok ? "info" : "warn", response.ok
      ? "lwa.refresh.completed"
      : "lwa.refresh.failed", {
      ...(response.ok
        ? { result: "success" as const, attempt: 1 }
        : { error_code: "lwa_failed" as const, result: "error" as const, attempt: 1 }),
      duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    });
    if (response.ok) {
      mcpMetrics.inc("lwa_refresh_total", "LWA access token refreshes", { result: "success" });
    } else {
      mcpMetrics.inc("lwa_refresh_total", "LWA access token refreshes", { result: "error" });
    }

    if (!response.ok) {
      let oauthError: string | undefined;
      try {
        const errorBody = (await response.json()) as LwaResponse;
        oauthError = typeof errorBody.error === "string" ? errorBody.error : undefined;
      } catch {
        // Status alone is insufficient to classify a seller grant as expired.
      }
      throw new LwaError(
        response.status,
        `LWA access token request failed with status ${response.status}`,
        oauthError,
      );
    }

    let body: LwaResponse;
    try {
      body = (await response.json()) as LwaResponse;
    } catch {
      throw new LwaError(502, "LWA response was not valid JSON");
    }
    if (!body.access_token || !body.expires_in) {
      throw new LwaError(502, "LWA response did not include a usable access token");
    }

    // If Amazon rotated the Refresh Token, persist it before publishing Access Token.
    if (
      typeof body.refresh_token === "string" &&
      body.refresh_token &&
      body.refresh_token !== credential.refreshToken
    ) {
      if (!this.#refreshTokens.compareAndSetRefreshToken) {
        this.#logger.write("warn", "lwa.refresh.rotation_skipped", {
          reason_code: "store_not_writable",
          result: "error",
        });
        mcpMetrics.inc("lwa_refresh_rotation_total", "LWA refresh token rotation results", {
          result: "rejected",
          error_code: "configuration_required",
        });
      } else {
        const result = await this.#refreshTokens.compareAndSetRefreshToken({
          sellingPartnerId,
          tenantId: credential.credentialOwnerId ?? tenantId,
          expectedRevision: credential.revision,
          newRefreshToken: body.refresh_token,
        });
        mcpMetrics.inc("lwa_refresh_rotation_total", "LWA refresh token rotation results", result === "updated"
          ? { result: "success" }
          : { result: "error", error_code: result === "conflict" ? "conflict" : "resource_not_found" });
        if (result !== "updated") {
          // Do not publish Access Token obtained with a stale refresh path.
          throw new AmazonMcpError(
            "UPSTREAM_LWA",
            "Refresh token rotation could not be persisted safely",
            true,
          );
        }
      }
    }

    const refreshEarlyMs = Math.min(5 * 60_000, body.expires_in * 100);
    const jitterMs = boundedJitterMs(body.expires_in);
    const cached = {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000 - refreshEarlyMs - jitterMs,
    };
    if ((this.#generations.get(key) ?? 0) === generation) this.#cache.set(key, cached);
    return cached;
  }

  async invalidateAccessToken(sellingPartnerId: string, tenantId: string): Promise<void> {
    if (!tenantId) return;
    try {
      const credential = await this.#credential(sellingPartnerId, tenantId);
      await this.#invalidateKey(cacheKey(credential, sellingPartnerId, tenantId));
    } catch (error) {
      if (error instanceof AmazonMcpError && error.code === "NOT_CONNECTED") return;
      throw error;
    }
  }

  async invalidateCredential(credentialId: string, revision: number): Promise<void> {
    await this.#invalidateKey(JSON.stringify([credentialId, revision]));
  }

  async #credential(
    sellingPartnerId: string,
    tenantId: string,
  ): Promise<RefreshTokenCredential> {
    return this.#refreshTokens.getRefreshCredential
      ? this.#refreshTokens.getRefreshCredential(sellingPartnerId, tenantId)
      : {
        refreshToken: await this.#refreshTokens.getRefreshToken(sellingPartnerId, tenantId),
        revision: 1,
      };
  }

  async #invalidateKey(key: string): Promise<void> {
    this.#cache.delete(key);
    this.#inFlight.delete(key);
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
  }
}
