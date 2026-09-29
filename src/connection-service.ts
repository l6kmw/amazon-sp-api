import { AmazonMcpError } from "./errors.js";
import type { ExpiringStore } from "./state-store.js";
import type { AmazonConnection, ConnectionStore } from "./token-store.js";

export type { AmazonConnection } from "./token-store.js";
export interface ConnectedAccountAuthorizationCompletion extends AmazonConnection {}

export interface AuthorizationIntent {
  expiresAt?: number;
  tenantId: string;
  connectedAccountAttemptId?: string;
  connectedAccountOrigin?: string;
}

interface CachedConnections {
  connections: AmazonConnection[];
  expiresAt: number;
}

function validateTenantId(value: string): string {
  if (!/^[A-Za-z0-9._:@-]{1,512}$/.test(value)) {
    throw new AmazonMcpError("TENANT_REQUIRED", "tenant identity is invalid");
  }
  return value;
}

function validateAttemptId(value: string): string {
  if (!/^att_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new AmazonMcpError("INTERNAL", "ConnectedAccount authorization attempt is invalid");
  }
  return value;
}

export class ConnectionService {
  readonly #store: ConnectionStore;
  readonly #intentStore: ExpiringStore<AuthorizationIntent>;
  readonly #publicOrigin: string;
  readonly #allowedConnectedAccountOrigins: ReadonlySet<string>;
  readonly #onDisconnect?: (tenantId: string, sellingPartnerId: string) => Promise<void> | void;
  readonly #connectionCacheTtlMs: number;
  readonly #connectionCache = new Map<string, CachedConnections>();
  readonly #connectionInFlight = new Map<string, Promise<AmazonConnection[]>>();
  readonly #connectionGenerations = new Map<string, number>();

  constructor(options: {
    store: ConnectionStore;
    intentStore: ExpiringStore<AuthorizationIntent>;
    publicOrigin: string;
    allowedConnectedAccountOrigins?: Iterable<string>;
    onDisconnect?: (tenantId: string, sellingPartnerId: string) => Promise<void> | void;
    connectionCacheTtlMs?: number;
  }) {
    this.#store = options.store;
    this.#intentStore = options.intentStore;
    this.#publicOrigin = new URL(options.publicOrigin).origin;
    this.#allowedConnectedAccountOrigins = new Set(options.allowedConnectedAccountOrigins ?? []);
    this.#onDisconnect = options.onDisconnect;
    this.#connectionCacheTtlMs = options.connectionCacheTtlMs ?? 30_000;
    if (!Number.isFinite(this.#connectionCacheTtlMs) || this.#connectionCacheTtlMs < 0) {
      throw new Error("Amazon connection cache TTL must be non-negative");
    }
  }

  async createAuthorizationURL(tenantId: string): Promise<string> {
    const intentId = await this.#intentStore.create({ tenantId: validateTenantId(tenantId) });
    return this.#startURL(intentId, false);
  }

  async createRenewalURL(tenantId: string): Promise<string> {
    const intentId = await this.#intentStore.create({ tenantId: validateTenantId(tenantId) });
    return this.#startURL(intentId, true);
  }

  async createConnectedAccountAuthorizationURL(
    tenantId: string,
    attemptId: string,
    origin: string,
  ): Promise<string> {
    const normalizedOrigin = new URL(origin).origin;
    if (!this.#allowedConnectedAccountOrigins.has(normalizedOrigin)) {
      throw new AmazonMcpError("INTERNAL", "ConnectedAccount authorization origin is not allowed");
    }
    const intentId = await this.#intentStore.create({
      tenantId: validateTenantId(tenantId),
      connectedAccountAttemptId: validateAttemptId(attemptId),
      connectedAccountOrigin: normalizedOrigin,
    });
    return this.#startURL(intentId, false);
  }

  async cancelAuthorizationURL(value: string): Promise<void> {
    const url = new URL(value);
    if (url.origin !== this.#publicOrigin || url.pathname !== "/oauth/amazon/start") return;
    const intentId = url.searchParams.get("intent");
    if (intentId) await this.#intentStore.delete(intentId);
  }

  async getConnectedAccountAuthorizationCompletion(
    tenantId: string,
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationCompletion | null> {
    return this.#store.findConnectedAccountCompletion(
      validateTenantId(tenantId),
      validateAttemptId(attemptId),
    );
  }

  async listConnections(tenantId: string, forceRefresh = false): Promise<AmazonConnection[]> {
    validateTenantId(tenantId);
    if (forceRefresh) this.#invalidateCache(tenantId);
    const cached = this.#connectionCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return [...cached.connections];
    const active = forceRefresh ? undefined : this.#connectionInFlight.get(tenantId);
    if (active) return [...await active];

    const generation = this.#connectionGenerations.get(tenantId) ?? 0;
    const request = this.#store.list(tenantId);
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

  async disconnect(tenantId: string, sellingPartnerId: string): Promise<void> {
    const disconnected = await this.disconnectIfPresent(tenantId, sellingPartnerId);
    if (!disconnected) {
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "Amazon connection was not found for the current user",
      );
    }
  }

  async disconnectIfPresent(tenantId: string, sellingPartnerId: string): Promise<boolean> {
    validateTenantId(tenantId);
    this.#invalidateCache(tenantId);
    const disconnected = await this.#store.disconnect(tenantId, sellingPartnerId);
    await this.invalidateConnection(tenantId, sellingPartnerId);
    return disconnected;
  }

  async invalidateConnection(tenantId: string, sellingPartnerId: string): Promise<void> {
    validateTenantId(tenantId);
    try {
      await this.#onDisconnect?.(tenantId, sellingPartnerId);
    } finally {
      this.#invalidateCache(tenantId);
    }
  }

  invalidateConnections(tenantId: string): void {
    this.#invalidateCache(validateTenantId(tenantId));
  }

  #startURL(intentId: string, renewal: boolean): string {
    const url = new URL(renewal ? "/oauth/amazon/renew" : "/oauth/amazon/start", this.#publicOrigin);
    url.searchParams.set("intent", intentId);
    return url.toString();
  }

  #invalidateCache(tenantId: string): void {
    this.#connectionCache.delete(tenantId);
    this.#connectionInFlight.delete(tenantId);
    this.#connectionGenerations.set(
      tenantId,
      (this.#connectionGenerations.get(tenantId) ?? 0) + 1,
    );
  }
}
