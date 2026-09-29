import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


import { loadConfig, type RuntimeConfig } from "./config.js";
import { ConnectionService, type AuthorizationIntent } from "./connection-service.js";
import { AmazonDocumentReader } from "./document-reader.js";
import { ConnectedAccountStore } from "./connected-accounts.js";
import { createLocalAccountAccessPolicy, isLocalLoopback } from "./local-identity.js";
import { createAmazonMcpHttpApp, type ReadinessResult } from "./http.js";
import { LwaAccessTokenProvider } from "./lwa.js";
import { createStructuredLogger } from "./logger.js";
import { McpArgumentFileLogger } from "./mcp-argument-logger.js";
import { createAmazonOAuthRouter, type OAuthState } from "./oauth.js";
import { PUBLIC_MCP_PATH } from "./portal.js";
import { AmazonSpApiClient } from "./sp-api-client.js";
import { FileExpiringStore } from "./state-store.js";
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
}): () => Promise<ReadinessResult> {
  return async () => {
    const tokenStore = await options.tokenStoreCheck();
    const checks: ReadinessResult["checks"] = {
      lwa: options.lwaConfigured ? "ok" : "error",
      tokenStore,
      encryptionKey: canParseEncryptionKey(options.encryptionKey) ? "ok" : "error",
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

export async function createRuntime(configFile?: string) {
  const config = await loadConfig(configFile);
  await secureDataDirectory(config);

  const startupCleanup: Array<() => Promise<unknown> | void> = [];
  try {
  const keyring = createTokenKeyringFromConfig(config.credentialKeyring);
  const currentEncryptionKey = config.credentialKeyring.keys[
    config.credentialKeyring.currentKeyId
  ]!;
  const connectionStore: ConnectionStore = new EncryptedFileTokenStore({
    file: config.tokenStoreFile,
    encryptionKey: currentEncryptionKey,
    keyring,
    allowedSellingPartnerIds: config.allowedSellingPartnerIds,
  });
  startupCleanup.push(() => connectionStore.close());
  const stateStore = new FileExpiringStore<OAuthState>(config.stateStoreFile);
  const intentStore = new FileExpiringStore<AuthorizationIntent>(config.intentStoreFile);
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
  const accessTokens = new LwaAccessTokenProvider({
    clientId: config.lwaClientId,
    clientSecret: config.lwaClientSecret,
    refreshTokens: connectionStore,
    logger,
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
    allowedConnectedAccountOrigins: [config.publicOrigin],
    connectionCacheTtlMs: CONNECTION_CACHE_TTL_MS,
    onDisconnect: async (tenantId, sellingPartnerId) => {
      await accessTokens.invalidateAccessToken(sellingPartnerId, tenantId);
      regionCache.delete(tenantId, sellingPartnerId);
    },
  });
  // Single-user: accounts live in one local file, bound to the fixed local owner.
  const connectedAccountService = new ConnectedAccountStore({
    file: config.connectedAccountDatabaseFile,
    oauth: connections,
    authorizationOrigin: config.publicOrigin,
  });
  startupCleanup.push(() => Promise.resolve(connectedAccountService.close()));
  const readinessCheck = createRuntimeReadinessCheck({
    lwaConfigured: Boolean(config.lwaClientId && config.lwaClientSecret),
    encryptionKey: currentEncryptionKey,
    tokenStoreCheck: () => connectionStore.checkHealth(),
  });
  const accountAccessPolicy = createLocalAccountAccessPolicy(connectedAccountService);
  const app = createAmazonMcpHttpApp({
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
    connectedAccountService,
    portal: {
      publicOrigin: config.publicOrigin,
      version: SERVICE_VERSION,
      toolCount: 30,
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
      argumentLogger.close(),
    ]);
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
