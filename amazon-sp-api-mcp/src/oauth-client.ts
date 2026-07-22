import { isIP } from "node:net";

import { AmazonMcpError } from "./errors.js";
import type { AmazonConnectionManager } from "./tools.js";

export interface AmazonConnection {
  sellingPartnerId: string;
  authorizedAt: string;
}

export interface ConnectedAccountAuthorizationCompletion extends AmazonConnection {}

interface CachedConnections {
  connections: AmazonConnection[];
  expiresAt: number;
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return hostname === "::1";
}

export class AmazonOAuthClient implements AmazonConnectionManager {
  readonly #baseURL: URL;
  readonly #internalSecret: string;
  readonly #fetch: typeof fetch;
  readonly #onDisconnect?: (tenantId: string, sellingPartnerId: string) => Promise<void> | void;
  readonly #connectionCacheTtlMs: number;
  readonly #connectionCache = new Map<string, CachedConnections>();
  readonly #connectionInFlight = new Map<string, Promise<AmazonConnection[]>>();
  readonly #connectionGenerations = new Map<string, number>();

  constructor(options: {
    baseURL: string;
    internalSecret: string;
    fetchImpl?: typeof fetch;
    onDisconnect?: (tenantId: string, sellingPartnerId: string) => Promise<void> | void;
    connectionCacheTtlMs?: number;
  }) {
    this.#baseURL = new URL(options.baseURL);
    if (this.#baseURL.protocol !== "http:" || !isLoopback(this.#baseURL.hostname)) {
      throw new Error("Amazon OAuth URL must use a loopback HTTP endpoint");
    }
    if (!options.internalSecret.trim()) throw new Error("Amazon internal secret is required");
    this.#internalSecret = options.internalSecret;
    this.#fetch = options.fetchImpl || fetch;
    this.#onDisconnect = options.onDisconnect;
    this.#connectionCacheTtlMs = options.connectionCacheTtlMs ?? 30_000;
    if (!Number.isFinite(this.#connectionCacheTtlMs) || this.#connectionCacheTtlMs < 0) {
      throw new Error("Amazon connection cache TTL must be non-negative");
    }
  }

  async createAuthorizationURL(tenantId: string): Promise<string> {
    const body = await this.#request("/internal/amazon/intents", "create_intent", {
      method: "POST",
      body: JSON.stringify({ tenant_id: tenantId }),
    }) as { authorization_url?: string };
    if (!body.authorization_url) {
      throw new AmazonMcpError(
        "UPSTREAM_OAUTH",
        "Amazon OAuth service returned no authorization URL",
        false,
      );
    }
    return body.authorization_url;
  }

  async createConnectedAccountAuthorizationURL(
    tenantId: string,
    attemptId: string,
    origin: string,
  ): Promise<string> {
    const body = await this.#request("/internal/amazon/intents", "create_intent", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        connected-account_attempt_id: attemptId,
        connected-account_origin: origin,
      }),
    }) as { authorization_url?: string };
    if (!body.authorization_url) {
      throw new AmazonMcpError(
        "UPSTREAM_OAUTH",
        "Amazon OAuth service returned no authorization URL",
        false,
      );
    }
    return body.authorization_url;
  }

  async getConnectedAccountAuthorizationCompletion(
    tenantId: string,
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationCompletion | null> {
    const query = new URLSearchParams({ tenant_id: tenantId });
    return await this.#request(
      `/internal/amazon/connected-account-completions/${encodeURIComponent(attemptId)}?${query}`,
      "get_connected_account_completion",
    ) as ConnectedAccountAuthorizationCompletion | null;
  }

  async createRenewalURL(tenantId: string): Promise<string> {
    const url = new URL(await this.createAuthorizationURL(tenantId));
    url.pathname = "/oauth/amazon/renew";
    return url.toString();
  }

  async listConnections(tenantId: string, forceRefresh = false): Promise<AmazonConnection[]> {
    if (forceRefresh) {
      this.#connectionCache.delete(tenantId);
      this.#connectionGenerations.set(
        tenantId,
        (this.#connectionGenerations.get(tenantId) ?? 0) + 1,
      );
    }
    const cached = this.#connectionCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return [...cached.connections];

    const activeRequest = forceRefresh ? undefined : this.#connectionInFlight.get(tenantId);
    if (activeRequest) return [...await activeRequest];

    const generation = this.#connectionGenerations.get(tenantId) ?? 0;
    const request = this.#fetchConnections(tenantId);
    this.#connectionInFlight.set(tenantId, request);
    try {
      const connections = await request;
      if (
        this.#connectionCacheTtlMs > 0 &&
        (this.#connectionGenerations.get(tenantId) ?? 0) === generation
      ) {
        this.#connectionCache.set(tenantId, {
          connections: [...connections],
          expiresAt: Date.now() + this.#connectionCacheTtlMs,
        });
      }
      return [...connections];
    } finally {
      if (this.#connectionInFlight.get(tenantId) === request) {
        this.#connectionInFlight.delete(tenantId);
      }
    }
  }

  async #fetchConnections(tenantId: string): Promise<AmazonConnection[]> {
    const query = new URLSearchParams({ tenant_id: tenantId });
    const body = await this.#request(
      `/internal/amazon/connections?${query}`,
      "list_connections",
    ) as {
      connections?: AmazonConnection[];
    };
    return body.connections || [];
  }

  async disconnect(tenantId: string, sellingPartnerId: string): Promise<void> {
    const query = new URLSearchParams({ tenant_id: tenantId });
    await this.#request(
      `/internal/amazon/connections/${encodeURIComponent(sellingPartnerId)}?${query}`,
      "disconnect",
      { method: "DELETE" },
    );
    this.#connectionCache.delete(tenantId);
    this.#connectionInFlight.delete(tenantId);
    this.#connectionGenerations.set(
      tenantId,
      (this.#connectionGenerations.get(tenantId) ?? 0) + 1,
    );
    await this.#onDisconnect?.(tenantId, sellingPartnerId);
  }

  async #request(
    path: string,
    operation: "create_intent" | "list_connections" | "disconnect" | "get_connected_account_completion",
    init: RequestInit = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseURL), {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#internalSecret}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AmazonMcpError(
        "UPSTREAM_OAUTH",
        "Amazon OAuth service network request failed",
        true,
      );
    }
    if (response.status === 404 && operation === "disconnect") {
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "Amazon connection was not found for the current user",
        false,
        { status: response.status },
      );
    }
    if (response.status === 404 && operation === "get_connected_account_completion") {
      return null;
    }
    if (response.status === 409 && operation === "create_intent") {
      throw new AmazonMcpError(
        "SELLER_FORBIDDEN",
        "Amazon seller is connected to another user",
        false,
        { status: response.status },
      );
    }
    if (!response.ok) {
      throw new AmazonMcpError(
        "UPSTREAM_OAUTH",
        `Amazon OAuth service returned status ${response.status}`,
        response.status === 429 || response.status >= 500,
        { status: response.status },
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AmazonMcpError(
        "UPSTREAM_OAUTH",
        "Amazon OAuth service response was not valid JSON",
        true,
        { status: response.status },
      );
    }
  }
}
