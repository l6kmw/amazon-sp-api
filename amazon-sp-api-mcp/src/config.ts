import type { ConnectedAccountJwtKey } from "./connected-account.js";

export interface RuntimeConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  mcpAuthToken?: string;
  allowLegacyAuth: boolean;
  legacyTenantId?: string;
  lwaClientId: string;
  lwaClientSecret: string;
  tokenEncryptionKey: string;
  tokenStoreFile: string;
  allowedSellingPartnerIds: string[];
  identityValidationURL: string;
  identityHealthURL: string;
  oauthInternalURL: string;
  internalSecret: string;
  tenantRequestsPerMinute: number;
  tenantMaxConcurrentRequests: number;
  enableListingsTools: boolean;
  connected-accountEnabled: boolean;
  connected-accountJwtAudience?: string;
  connected-accountJwtKeys: ConnectedAccountJwtKey[];
  connected-accountDatabaseFile: string;
  connected-accountAllowedOrigins: string[];
  databaseUrl?: string;
  redisUrl?: string;
  redisNamespace: string;
}

export class ConfigurationError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`${name} is required`);
  return value;
}

function list(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function booleanFlag(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be true or false`);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

function origins(value: string): string[] {
  return list(value).map((item) => {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new ConfigurationError("CONNECTED_ACCOUNT_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new ConfigurationError("CONNECTED_ACCOUNT_ALLOWED_ORIGINS contains an invalid origin");
    }
    return url.origin;
  });
}

function connected-accountJwtConfig(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): { audience?: string; keys: ConnectedAccountJwtKey[] } {
  if (!enabled) return { keys: [] };
  const audience = required(env, "CONNECTED_ACCOUNT_JWT_AUDIENCE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(env, "CONNECTED_ACCOUNT_JWT_KEYS"));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("CONNECTED_ACCOUNT_JWT_KEYS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError("CONNECTED_ACCOUNT_JWT_KEYS must be a JSON object");
  }
  const keys = Object.entries(parsed).map(([kid, value]) => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid)) {
      throw new ConfigurationError("CONNECTED_ACCOUNT_JWT_KEYS contains an invalid kid");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigurationError(`CONNECTED_ACCOUNT_JWT_KEYS.${kid} must be an object`);
    }
    const candidate = value as Record<string, unknown>;
    const issuer = typeof candidate.issuer === "string" ? candidate.issuer.trim() : "";
    const secret = typeof candidate.secret === "string" ? candidate.secret : "";
    if (!issuer || issuer.length > 512) {
      throw new ConfigurationError(`CONNECTED_ACCOUNT_JWT_KEYS.${kid}.issuer is required`);
    }
    if (Buffer.byteLength(secret) < 32) {
      throw new ConfigurationError(`CONNECTED_ACCOUNT_JWT_KEYS.${kid}.secret must contain at least 32 bytes`);
    }
    return { kid, issuer, secret };
  });
  if (keys.length === 0) {
    throw new ConfigurationError("CONNECTED_ACCOUNT_JWT_KEYS must contain at least one key");
  }
  return { audience, keys };
}

export function buildRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = Number(env.PORT ?? 8789);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PORT must be a valid TCP port");
  }

  const allowLegacyAuth = booleanFlag(env, "MCP_ALLOW_LEGACY_AUTH");
  const mcpAuthToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  if (allowLegacyAuth && !mcpAuthToken) {
    throw new ConfigurationError("MCP_AUTH_TOKEN is required when MCP_ALLOW_LEGACY_AUTH=true");
  }
  if (allowLegacyAuth && Buffer.byteLength(mcpAuthToken!) < 32) {
    throw new ConfigurationError("MCP_AUTH_TOKEN must contain at least 32 bytes");
  }
  const legacyTenantId = env.MCP_LEGACY_TENANT_ID?.trim() || undefined;
  if (legacyTenantId && !/^[A-Za-z0-9_-]{1,128}$/.test(legacyTenantId)) {
    throw new ConfigurationError("MCP_LEGACY_TENANT_ID contains an invalid tenant ID");
  }
  const connected-accountEnabled = booleanFlag(env, "CONNECTED_ACCOUNT_ENABLED");
  const connected-account = connected-accountJwtConfig(env, connected-accountEnabled);
  const connected-accountAllowedOrigins = origins(env.CONNECTED_ACCOUNT_ALLOWED_ORIGINS || "");
  if (connected-accountEnabled && connected-accountAllowedOrigins.length === 0) {
    throw new ConfigurationError("CONNECTED_ACCOUNT_ALLOWED_ORIGINS is required when CONNECTED_ACCOUNT_ENABLED=true");
  }
  const databaseUrl = env.AMAZON_DATABASE_URL?.trim() || undefined;
  if (connected-accountEnabled && !databaseUrl) {
    throw new ConfigurationError("AMAZON_DATABASE_URL is required when CONNECTED_ACCOUNT_ENABLED=true");
  }
  const redisUrl = env.AMAZON_REDIS_URL?.trim() || undefined;
  if (connected-accountEnabled && !redisUrl) {
    throw new ConfigurationError("AMAZON_REDIS_URL is required when CONNECTED_ACCOUNT_ENABLED=true");
  }

  const allowedSellingPartnerIds = list(required(env, "AMAZON_ALLOWED_SELLING_PARTNER_IDS"));
  if (allowedSellingPartnerIds.length === 0) {
    throw new ConfigurationError("AMAZON_ALLOWED_SELLING_PARTNER_IDS cannot be empty");
  }
  if (allowedSellingPartnerIds.some((id) => !/^[A-Za-z0-9._:-]{1,128}$/.test(id))) {
    throw new ConfigurationError("AMAZON_ALLOWED_SELLING_PARTNER_IDS contains an invalid ID");
  }

  const identityValidationURL =
    env.LEGACY_IDENTITY_VALIDATION_URL?.trim() ||
    "http://127.0.0.1:8080/api/v1/admin/session";
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    allowedHosts: list(env.MCP_ALLOWED_HOSTS || "api.example.com,127.0.0.1,localhost"),
    mcpAuthToken,
    allowLegacyAuth,
    legacyTenantId,
    lwaClientId: required(env, "AMAZON_LWA_CLIENT_ID"),
    lwaClientSecret: required(env, "AMAZON_LWA_CLIENT_SECRET"),
    tokenEncryptionKey: required(env, "AMAZON_TOKEN_ENCRYPTION_KEY"),
    tokenStoreFile:
      env.AMAZON_TOKEN_STORE_FILE?.trim() || "/var/lib/amazon-oauth-service/tokens.json",
    allowedSellingPartnerIds,
    identityValidationURL,
    identityHealthURL:
      env.LEGACY_IDENTITY_HEALTH_URL?.trim() ||
      new URL("/healthz", identityValidationURL).toString(),
    oauthInternalURL:
      env.AMAZON_OAUTH_INTERNAL_URL?.trim() || "http://127.0.0.1:8788",
    internalSecret: required(env, "AMAZON_INTERNAL_SECRET"),
    tenantRequestsPerMinute: positiveInteger(env, "MCP_TENANT_REQUESTS_PER_MINUTE", 120),
    tenantMaxConcurrentRequests: positiveInteger(env, "MCP_TENANT_MAX_CONCURRENT_REQUESTS", 8),
    enableListingsTools: booleanFlag(env, "AMAZON_ENABLE_LISTINGS_TOOLS"),
    connected-accountEnabled,
    connected-accountJwtAudience: connected-account.audience,
    connected-accountJwtKeys: connected-account.keys,
    connected-accountDatabaseFile:
      env.CONNECTED_ACCOUNT_DATABASE_FILE?.trim() || "/var/lib/amazon-sp-api-mcp/connected-account.sqlite",
    connected-accountAllowedOrigins,
    databaseUrl,
    redisUrl,
    redisNamespace: env.AMAZON_REDIS_NAMESPACE?.trim() || "amazon-sp-api",
  };
}
