import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolConfig } from "pg";
import { createClient } from "redis";

import { PostgresAccountAccessPolicy } from "./account-access-policy.js";
import { AdminAgentService } from "./admin-agents.js";
import { LoopbackAdminAdsClient } from "./admin-ads.js";
import { AdminAuditService } from "./admin-audit.js";
import { OpenIdAdminOaClient } from "./admin-oa.js";
import { AdminSessionManager } from "./admin-session.js";
import { loadConfig, type RuntimeConfig } from "./config.js";
import { ConnectionService, type AuthorizationIntent } from "./connection-service.js";
import { AmazonDocumentReader } from "./document-reader.js";
import { createDevMemoryPool } from "./dev-pool.js";
import { ConnectedAccountStore } from "./connected-accounts.js";
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST, ConnectedAccountJwtVerifier } from "./connected-account.js";
import { createAmazonMcpHttpApp, type ReadinessResult } from "./http.js";
import { createAmazonAuthenticator } from "./identity.js";
import { LwaAccessTokenProvider } from "./lwa.js";
import { createStructuredLogger } from "./logger.js";
import { McpArgumentFileLogger } from "./mcp-argument-logger.js";
import { createAmazonOAuthRouter, type OAuthState } from "./oauth.js";
import { PUBLIC_MCP_PATH } from "./portal.js";
import { PostgresConnectedAccountStore } from "./postgres-connected-accounts.js";
import { PostgresRefreshTokenStore } from "./postgres-token-store.js";
import { RedisAccessTokenCoordinator } from "./redis-coordinator.js";
import { FileExpiringStore, RedisExpiringStore } from "./state-store.js";
import { AmazonSpApiClient } from "./sp-api-client.js";
import { SpApiCapabilityTracker } from "./sp-api-operations.js";
import {
  createTokenKeyringFromConfig,
  EncryptedFileTokenStore,
  type ConnectionStore,
} from "./token-store.js";
import {
  createAmazonMcpServer,
  InMemoryAmazonSellerRegionCache,
} from "./tools.js";

export const SERVICE_VERSION = "0.1.0";
export const SERVICE_PORT = 8789;
export const CONNECTION_CACHE_TTL_MS = 30_000;
export const REGION_CACHE_TTL_MS = 86_400_000;

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

export function createRuntimeReadinessCheck(options: {
  lwaConfigured: boolean;
  encryptionKey: string;
  tokenStoreCheck: () => Promise<"ok" | "error">;
  postgresCheck?: () => Promise<"ok" | "error">;
  redisCheck?: () => Promise<"ok" | "error">;
}): () => Promise<ReadinessResult> {
  return async () => {
    const [tokenStore, postgres, redis] = await Promise.all([
      options.tokenStoreCheck(),
      options.postgresCheck?.(),
      options.redisCheck?.(),
    ]);
    const checks: ReadinessResult["checks"] = {
      lwa: options.lwaConfigured ? "ok" : "error",
      tokenStore,
      encryptionKey: canParseEncryptionKey(options.encryptionKey) ? "ok" : "error",
      ...(postgres ? { postgres } : {}),
      ...(redis ? { redis } : {}),
    };
    return {
      status: Object.values(checks).every((result) => result === "ok")
        ? "ready"
        : "not_ready",
      checks,
    };
  };
}

async function secureDataDirectory(config: RuntimeConfig): Promise<void> {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(config.dataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("OAuth data path must be a real directory");
  }
  await chmod(config.dataDirectory, 0o700);
}

export function productionPostgresPoolConfig(
  config: Pick<RuntimeConfig, "databaseUrl" | "postgresPool">,
): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    min: config.postgresPool.min,
    max: config.postgresPool.max,
    idleTimeoutMillis: config.postgresPool.idleTimeoutMs,
    statement_timeout: 40_000,
    query_timeout: 45_000,
    connectionTimeoutMillis: 5_000,
  };
}

export async function createRuntime(configFile?: string) {
  const config = await loadConfig(configFile);
  await secureDataDirectory(config);

  const pool = config.databaseUrl
    ? new Pool(productionPostgresPoolConfig(config))
    : await createDevMemoryPool();
  const redis = config.redisUrl ? createClient({ url: config.redisUrl }) : undefined;
  const startupCleanup: Array<() => Promise<unknown> | void> = [];
  if (pool) startupCleanup.push(() => pool.end());
  if (redis) {
    startupCleanup.push(() => redis.isOpen ? redis.close() : undefined);
  }
  try {
    redis?.on("error", () => {});
    if (redis) await redis.connect();

  const keyring = createTokenKeyringFromConfig(config.credentialKeyring);
  const currentEncryptionKey = config.credentialKeyring.keys[
    config.credentialKeyring.currentKeyId
  ]!;
  const connectionStore: ConnectionStore = pool
    ? new PostgresRefreshTokenStore({
      pool,
      encryptionKey: currentEncryptionKey,
      keyring,
    })
    : new EncryptedFileTokenStore({
      file: config.tokenStoreFile,
      encryptionKey: currentEncryptionKey,
      keyring,
      allowedSellingPartnerIds: config.allowedSellingPartnerIds,
    });
  startupCleanup.push(() => connectionStore.close());
  const stateStore = redis
    ? new RedisExpiringStore<OAuthState>({
      client: redis,
      namespace: `${config.redisNamespace}:oauth-state`,
    })
    : new FileExpiringStore<OAuthState>(config.stateStoreFile);
  const intentStore = redis
    ? new RedisExpiringStore<AuthorizationIntent>({
      client: redis,
      namespace: `${config.redisNamespace}:oauth-intent`,
    })
    : new FileExpiringStore<AuthorizationIntent>(config.intentStoreFile);
  startupCleanup.push(() => stateStore.close(), () => intentStore.close());

  await Promise.all([
    connectionStore.initialize(),
    stateStore.initialize(),
    intentStore.initialize(),
  ]);

  const loggerHashKey = createHash("sha256")
    .update(currentEncryptionKey)
    .digest("base64url");
  const logger = createStructuredLogger({ hashKey: loggerHashKey, service: "mcp" });
  const argumentLogger = new McpArgumentFileLogger({
    directory: path.join(config.dataDirectory, "logs", "mcp-arguments"),
    logger,
  });
  startupCleanup.push(() => argumentLogger.close());
  await argumentLogger.initialize();
  const accessTokenCoordinator = redis
    ? new RedisAccessTokenCoordinator({ client: redis, namespace: config.redisNamespace })
    : undefined;
  if (accessTokenCoordinator) startupCleanup.push(() => accessTokenCoordinator.close());
  const accessTokens = new LwaAccessTokenProvider({
    clientId: config.lwaClientId,
    clientSecret: config.lwaClientSecret,
    refreshTokens: connectionStore,
    logger,
    coordinator: accessTokenCoordinator,
  });
  const spApi = new AmazonSpApiClient({ accessTokens, logger });
  const documentReader = new AmazonDocumentReader({ client: spApi, keyring });
  const capabilityTracker = new SpApiCapabilityTracker();
  const regionCache = new InMemoryAmazonSellerRegionCache(REGION_CACHE_TTL_MS);
  const invalidateCredential = async (
    credentialId: string,
    revision: number,
    credentialOwnerId: string,
    sellingPartnerId: string,
  ) => {
    await accessTokens.invalidateCredential(credentialId, revision);
    regionCache.delete(credentialOwnerId, sellingPartnerId);
  };
  const connections = new ConnectionService({
    store: connectionStore,
    intentStore,
    publicOrigin: config.publicOrigin,
    allowedConnectedAccountOrigins: [...config.connectedAccountAllowedOrigins, config.publicOrigin],
    connectionCacheTtlMs: CONNECTION_CACHE_TTL_MS,
    onDisconnect: async (tenantId, sellingPartnerId) => {
      await accessTokens.invalidateAccessToken(sellingPartnerId, tenantId);
      regionCache.delete(tenantId, sellingPartnerId);
    },
  });
  const connectedAccountService = config.connectedAccountEnabled
    ? pool
      ? new PostgresConnectedAccountStore({
        pool,
        oauth: connections,
        authorizationOrigin: config.connectedAccountAllowedOrigins[0]!,
        adminAuthorizationOrigin: config.publicOrigin,
        invalidateCredential,
      })
      : new ConnectedAccountStore({
        file: config.connectedAccountDatabaseFile,
        oauth: connections,
        authorizationOrigin: config.connectedAccountAllowedOrigins[0]!,
      })
    : undefined;
  if (connectedAccountService) startupCleanup.push(() => Promise.resolve(connectedAccountService.close()));

  const adminControlEnabled = Boolean(config.databaseUrl && config.adminSessionSecret);
  const adminAgents = adminControlEnabled ? new AdminAgentService(pool) : undefined;
  const authenticate = createAmazonAuthenticator({
    connectedAccountVerifier: config.connectedAccountEnabled
      ? new ConnectedAccountJwtVerifier({
        audience: config.connectedAccountJwtAudience!,
        keys: config.connectedAccountJwtKeys,
      })
      : undefined,
    authenticateTestAgent: adminAgents
      ? (token) => adminAgents.authenticateToken(token)
      : undefined,
  });
  const postgresCheck = pool
    ? async (): Promise<"ok" | "error"> => {
      try {
        await pool.query("SELECT 1");
        return "ok";
      } catch {
        return "error";
      }
    }
    : undefined;
  const redisCheck = redis
    ? async (): Promise<"ok" | "error"> => {
      try {
        return await redis.ping() === "PONG" ? "ok" : "error";
      } catch {
        return "error";
      }
    }
    : undefined;
  const readinessCheck = createRuntimeReadinessCheck({
    lwaConfigured: Boolean(config.lwaClientId && config.lwaClientSecret),
    encryptionKey: currentEncryptionKey,
    tokenStoreCheck: () => connectionStore.checkHealth(),
    postgresCheck,
    redisCheck,
  });
  const adminSessions = adminControlEnabled
    ? new AdminSessionManager({
      pool,
      secret: config.adminSessionSecret!,
      oaIdentity: config.adminOa
        ? { issuer: config.adminOa.issuer, subject: config.adminOa.subject }
        : undefined,
    })
    : undefined;
  const adminAudits = pool ? new AdminAuditService(pool) : undefined;
  const adminBindingAccounts = adminControlEnabled
    ? connectedAccountService instanceof PostgresConnectedAccountStore
      ? connectedAccountService
      : new PostgresConnectedAccountStore({
        pool,
        oauth: connections,
        authorizationOrigin: config.connectedAccountAllowedOrigins[0] || config.publicOrigin,
        adminAuthorizationOrigin: config.publicOrigin,
        invalidateCredential,
      })
    : undefined;
  const accountAccessPolicy = pool ? new PostgresAccountAccessPolicy(pool) : undefined;
  const app = createAmazonMcpHttpApp({
    authenticate,
    host: config.host,
    allowedHosts: config.allowedHosts,
    createServer: (principal) => createAmazonMcpServer(spApi, {
      principal,
      regionCache,
      accountAccessPolicy,
      capabilityTracker,
      documentReader,
      logger,
    }),
    toolCount: 30,
    version: SERVICE_VERSION,
    lwaConfigured: Boolean(config.lwaClientId && config.lwaClientSecret),
    readinessCheck,
    logger,
    argumentLogger,
    connectedAccountManifest: config.connectedAccountEnabled ? CONNECTED_ACCOUNT_DISCOVERY_MANIFEST : undefined,
    connectedAccountService,
    adminSessions,
    adminAgents,
    adminAudits,
    adminBindingAccounts,
    adminDashboard: adminControlEnabled ? {
      pool,
      lwaClientId: config.lwaClientId,
      lwaClientSecret: config.lwaClientSecret,
      applicationId: config.applicationId,
      publicOrigin: config.publicOrigin,
      readinessCheck,
      toolCount: 30,
      mcpEndpoint: PUBLIC_MCP_PATH,
      connectedAccountKeyringConfigured: config.connectedAccountEnabled && config.connectedAccountJwtKeys.length > 0,
    } : undefined,
    adminAds: adminControlEnabled ? new LoopbackAdminAdsClient() : undefined,
    adminOa: config.adminOa ? {
      publicOrigin: config.publicOrigin,
      sessionSecret: config.adminSessionSecret!,
      scope: config.adminOa.scope,
      client: new OpenIdAdminOaClient({
        issuer: config.adminOa.issuer,
        clientId: config.adminOa.clientId,
        clientSecret: config.adminOa.clientSecret,
      }),
    } : undefined,
    portal: {
      publicOrigin: config.publicOrigin,
      version: SERVICE_VERSION,
      toolCount: 30,
      connectedAccountEnabled: config.connectedAccountEnabled,
      connectedAccountAudience: config.connectedAccountJwtAudience,
      connectedAccountOrigins: config.connectedAccountAllowedOrigins,
      connectedAccountJwtKeys: config.connectedAccountJwtKeys.map(({ kid, issuer }) => ({ kid, issuer })),
    },
    operator: config.operator,
  });
  app.use(createAmazonOAuthRouter({
    config,
    stateStore,
    intentStore,
    connectionStore,
    onConnectionSaved: (tenantId) => connections.invalidateConnections(tenantId),
  }));
  app.all(/^\/internal\/amazon(?:\/|$)/, (_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([
      Promise.resolve(connectedAccountService?.close?.()),
      connectionStore.close(),
      stateStore.close(),
      intentStore.close(),
      accessTokenCoordinator?.close(),
      argumentLogger.close(),
    ]);
    if (redis?.isOpen) await redis.close();
    if (pool) await pool.end();
  };
    return { app, close, config, connectionStore, connections, intentStore, stateStore };
  } catch (error) {
    for (const cleanup of startupCleanup.reverse()) {
      try {
        await cleanup();
      } catch {
        // Preserve the startup error; cleanup failures must not mask its migration hint.
      }
    }
    throw error;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  try {
    const runtime = await createRuntime();
    const server = runtime.app.listen(SERVICE_PORT, runtime.config.host, (error) => {
      if (error) throw error;
      console.log(`[amazon-sp-api] listening on ${runtime.config.host}:${SERVICE_PORT}`);
    });
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`[amazon-sp-api] received ${signal}, shutting down`);
      server.close(async (error) => {
        await runtime.close();
        if (error) process.exitCode = 1;
      });
      setTimeout(() => {
        server.closeAllConnections();
        process.exitCode = 1;
      }, 10_000).unref();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown configuration error";
    console.error(`[amazon-sp-api] startup failed: ${message}`);
    process.exitCode = 1;
  }
}
