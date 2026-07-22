import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildRuntimeConfig } from "./config.js";
import { AmazonMcpError } from "./errors.js";
import { ConnectedAccountAccountStore } from "./connected-account-accounts.js";
import { PostgresConnectedAccountAccountStore } from "./postgres-connected-account-accounts.js";
import { PostgresRefreshTokenStore } from "./postgres-token-store.js";
import { RedisAccessTokenCoordinator } from "./redis-coordinator.js";
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST, ConnectedAccountJwtVerifier } from "./connected-account.js";
import { createAmazonMcpHttpApp, type ReadinessResult } from "./http.js";
import { createAmazonAuthenticator, LegacyIdentityVerifier } from "./identity.js";
import { LwaAccessTokenProvider } from "./lwa.js";
import { createStructuredLogger } from "./logger.js";
import { AmazonOAuthClient } from "./oauth-client.js";
import { PrincipalRequestLimiter } from "./rate-limit.js";
import { AmazonSpApiClient } from "./sp-api-client.js";
import { EncryptedFileTokenStore } from "./token-store.js";
import {
  createAmazonMcpServer,
  InMemoryAmazonSellerRegionCache,
} from "./tools.js";

function canParseEncryptionKey(value: string): boolean {
  try {
    const key = /^[a-fA-F0-9]{64}$/.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
    return key.length === 32;
  } catch {
    return false;
  }
}

async function checkOAuthHealth(
  fetchImpl: typeof fetch,
  oauthHealthURL: URL,
): Promise<"ok" | "error"> {
  try {
    const response = await fetchImpl(oauthHealthURL, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return "error";
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("status" in body) ||
      !("lwaConfigured" in body)
    ) {
      return "error";
    }
    return body.status === "ok" && body.lwaConfigured === true ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function checkIdentityHealth(
  fetchImpl: typeof fetch,
  identityHealthURL: URL,
): Promise<"ok" | "error"> {
  try {
    const response = await fetchImpl(identityHealthURL, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return "error";
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null &&
      "status" in body && body.status === "ok" ? "ok" : "error";
  } catch {
    return "error";
  }
}

export function createRuntimeReadinessCheck(options: {
  tokenStoreFile: string;
  oauthInternalURL: string;
  encryptionKey: string;
  accessFile?: typeof access;
  fetchImpl?: typeof fetch;
  tokenStoreCheck?: () => Promise<"ok" | "error">;
  postgresCheck?: () => Promise<"ok" | "error">;
  redisCheck?: () => Promise<"ok" | "error">;
  identityHealthURL?: string;
}): () => Promise<ReadinessResult> {
  const accessFile = options.accessFile ?? access;
  const fetchImpl = options.fetchImpl ?? fetch;
  const oauthHealthURL = new URL("/healthz", options.oauthInternalURL);
  const identityHealthURL = options.identityHealthURL
    ? new URL(options.identityHealthURL)
    : undefined;

  return async () => {
    const [tokenStore, oauthInternal, postgres, redis, identityService] = await Promise.all([
      options.tokenStoreCheck
        ? options.tokenStoreCheck()
        : accessFile(options.tokenStoreFile, constants.R_OK)
          .then(() => "ok" as const)
          .catch(() => "error" as const),
      checkOAuthHealth(fetchImpl, oauthHealthURL),
      options.postgresCheck?.(),
      options.redisCheck?.(),
      identityHealthURL ? checkIdentityHealth(fetchImpl, identityHealthURL) : undefined,
    ]);
    const checks: ReadinessResult["checks"] = {
      tokenStore,
      oauthInternal,
      encryptionKey: canParseEncryptionKey(options.encryptionKey) ? "ok" : "error",
      ...(postgres ? { postgres } : {}),
      ...(redis ? { redis } : {}),
      ...(identityService ? { identityService } : {}),
    };
    return {
      status: Object.values(checks).every((result) => result === "ok")
        ? "ready"
        : "not_ready",
      checks,
    };
  };
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const config = buildRuntimeConfig(env);
  const logger = createStructuredLogger({ hashKey: config.internalSecret, service: "mcp" });
  const requestLimiter = new PrincipalRequestLimiter({
    requestsPerMinute: config.tenantRequestsPerMinute,
    maxConcurrent: config.tenantMaxConcurrentRequests,
  });
  const refreshTokens = config.databaseUrl
    ? new PostgresRefreshTokenStore({
      databaseUrl: config.databaseUrl,
      encryptionKey: config.tokenEncryptionKey,
      allowedSellingPartnerIds: config.allowedSellingPartnerIds,
    })
    : new EncryptedFileTokenStore({
      file: config.tokenStoreFile,
      encryptionKey: config.tokenEncryptionKey,
      allowedSellingPartnerIds: config.allowedSellingPartnerIds,
    });
  const accessTokenCoordinator = config.redisUrl
    ? new RedisAccessTokenCoordinator({
      redisUrl: config.redisUrl,
      namespace: config.redisNamespace,
    })
    : undefined;
  const accessTokens = new LwaAccessTokenProvider({
    clientId: config.lwaClientId,
    clientSecret: config.lwaClientSecret,
    refreshTokens,
    logger,
    coordinator: accessTokenCoordinator,
  });
  const spApi = new AmazonSpApiClient({ accessTokens, logger });
  const regionCache = new InMemoryAmazonSellerRegionCache();
  const connections = new AmazonOAuthClient({
    baseURL: config.oauthInternalURL,
    internalSecret: config.internalSecret,
    onDisconnect: async (tenantId, sellingPartnerId) => {
      await accessTokens.invalidateAccessToken(sellingPartnerId, tenantId);
      regionCache.delete(tenantId, sellingPartnerId);
    },
  });
  const connected-accountAccounts = config.connected-accountEnabled
    ? config.databaseUrl
      ? new PostgresConnectedAccountAccountStore({
        databaseUrl: config.databaseUrl,
        oauth: connections,
        authorizationOrigin: config.connected-accountAllowedOrigins[0]!,
      })
      : new ConnectedAccountAccountStore({
        file: config.connected-accountDatabaseFile,
        oauth: connections,
        authorizationOrigin: config.connected-accountAllowedOrigins[0]!,
      })
    : undefined;
  const authenticate = createAmazonAuthenticator({
    legacyToken: config.mcpAuthToken,
    allowLegacyAuth: config.allowLegacyAuth,
    legacyTenantId: config.legacyTenantId,
    identityVerifier: new LegacyIdentityVerifier({ url: config.identityValidationURL }),
    connected-accountVerifier: config.connected-accountEnabled
      ? new ConnectedAccountJwtVerifier({
        audience: config.connected-accountJwtAudience!,
        keys: config.connected-accountJwtKeys,
      })
      : undefined,
  });
  const readinessCheck = createRuntimeReadinessCheck({
    tokenStoreFile: config.tokenStoreFile,
    oauthInternalURL: config.oauthInternalURL,
    encryptionKey: config.tokenEncryptionKey,
    tokenStoreCheck: refreshTokens instanceof PostgresRefreshTokenStore
      ? () => refreshTokens.checkHealth()
      : undefined,
    postgresCheck: connected-accountAccounts instanceof PostgresConnectedAccountAccountStore
      ? () => connected-accountAccounts.checkHealth()
      : undefined,
    redisCheck: accessTokenCoordinator
      ? () => accessTokenCoordinator.checkHealth()
      : undefined,
    identityHealthURL: config.allowLegacyAuth ? undefined : config.identityHealthURL,
  });
  const app = createAmazonMcpHttpApp({
    authenticate,
    host: config.host,
    allowedHosts: config.allowedHosts,
    createServer: (principal) => createAmazonMcpServer(spApi, {
      tenantId: principal.tenantId,
      principal,
      connections,
      regionCache,
      enableListingsTools: config.enableListingsTools,
      connected-accountAccounts,
      chargeSpApiCall: (tenantId) => {
        const limit = requestLimiter.acquire(tenantId);
        if (!limit.accepted) {
          throw new AmazonMcpError(
            "RATE_LIMITED",
            "Amazon snapshot internal call budget exceeded",
            true,
            { retryAfterSeconds: limit.retryAfterSeconds },
          );
        }
        limit.release();
      },
    }),
    toolCount: config.enableListingsTools ? 16 : 14,
    version: "0.1.0",
    readinessCheck,
    logger,
    requestLimiter,
    connected-accountManifest: config.connected-accountEnabled ? CONNECTED_ACCOUNT_DISCOVERY_MANIFEST : undefined,
    connected-accountAccounts,
  });
  const initialize = async () => {
    if (refreshTokens instanceof PostgresRefreshTokenStore) {
      await refreshTokens.initialize();
    }
    if (connected-accountAccounts instanceof PostgresConnectedAccountAccountStore) {
      await connected-accountAccounts.initialize();
    }
  };
  return { app, config, initialize };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  try {
    const { app, config, initialize } = createRuntime();
    await initialize();
    app.listen(config.port, config.host, (error) => {
      if (error) throw error;
      console.log(`[amazon-sp-api-mcp] listening on ${config.host}:${config.port}`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown configuration error";
    console.error(`[amazon-sp-api-mcp] startup failed: ${message}`);
    process.exitCode = 1;
  }
}
