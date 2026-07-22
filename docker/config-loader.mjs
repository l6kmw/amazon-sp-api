import { readFile, stat } from "node:fs/promises";
import YAML from "yaml";

export class DockerConfigurationError extends Error {
  constructor(path, message) {
    super(`${path} ${message}`);
    this.name = "DockerConfigurationError";
  }
}

const PLACEHOLDER_SECRETS = new Set([
  "replace-with-32-byte-encryption-key",
  "replace-with-at-least-32-random-bytes",
  "replace-with-lwa-client-secret",
  "changeme",
  "password",
  "secret",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
]);

const object = (value, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DockerConfigurationError(path, "must be a mapping");
  }
  return value;
};

function exactKeys(value, allowed, path) {
  const record = object(value, path);
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new DockerConfigurationError(`${path}.${unknown}`, "is not supported");
  return record;
}

function string(value, path, { optional = false, min = 1, max = 4096 } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || value.trim().length < min) {
    throw new DockerConfigurationError(path, `must be a string of at least ${min} characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new DockerConfigurationError(path, `must be at most ${max} characters`);
  }
  return trimmed;
}

function boolean(value, path, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new DockerConfigurationError(path, "must be true or false");
  return value;
}

function integer(value, path, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DockerConfigurationError(path, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function stringList(value, path, { nonEmpty = false, pattern, maxItems = 100 } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new DockerConfigurationError(path, nonEmpty ? "must be a non-empty list" : "must be a list");
  }
  if (value.length > maxItems) {
    throw new DockerConfigurationError(path, `must contain at most ${maxItems} items`);
  }
  const result = [...new Set(value.map((item, index) => {
    const parsed = string(item, `${path}[${index}]`);
    if (pattern && !pattern.test(parsed)) throw new DockerConfigurationError(`${path}[${index}]`, "is invalid");
    return parsed;
  }))];
  if (nonEmpty && result.length === 0) throw new DockerConfigurationError(path, "must be a non-empty list");
  return result;
}

function httpsURL(value, path) {
  const parsed = new URL(string(value, path));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new DockerConfigurationError(path, "must be an HTTPS URL without embedded credentials");
  }
  return parsed.toString().replace(/\/$/, "");
}

function identityURL(value, path) {
  const parsed = new URL(string(value, path));
  const localHosts = new Set(["127.0.0.1", "::1", "localhost", "host.docker.internal"]);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new DockerConfigurationError(path, "must be an HTTP(S) URL without embedded credentials");
  }
  if (parsed.protocol !== "https:" && !localHosts.has(parsed.hostname)) {
    throw new DockerConfigurationError(path, "must use HTTPS unless it targets a local Docker host");
  }
  return parsed.toString();
}

function optionalHttpsURL(value, path) {
  const raw = string(value, path, { optional: true });
  return raw ? httpsURL(raw, path) : "";
}

function optionalSection(value, allowed, path) {
  if (value === undefined || value === null) return {};
  return exactKeys(value, allowed, path);
}

function rejectWeakMaterial(key, path) {
  if (key.length < 32) {
    throw new DockerConfigurationError(path, "must decode to at least 32 bytes");
  }
  if (key.every((byte) => byte === 0)) {
    throw new DockerConfigurationError(path, "must not be all-zero bytes");
  }
  if (key.every((byte) => byte === key[0])) {
    throw new DockerConfigurationError(path, "must not be all-identical bytes");
  }
  for (const period of [1, 2, 3, 4]) {
    if (key.length % period !== 0) continue;
    const unit = key.subarray(0, period);
    let repeating = true;
    for (let offset = period; offset < key.length; offset += period) {
      if (!unit.equals(key.subarray(offset, offset + period))) {
        repeating = false;
        break;
      }
    }
    if (repeating) {
      throw new DockerConfigurationError(path, "must not use a short repeating byte pattern");
    }
  }
}

/** Encryption / JWT secrets: base64 or 64-hex, high-quality material checks. */
function decodeSecretMaterial(raw, path) {
  const value = string(raw, path, { min: 1, max: 1024 });
  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    throw new DockerConfigurationError(path, "must not use a known placeholder value");
  }
  let key;
  try {
    key = /^[a-fA-F0-9]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  } catch {
    throw new DockerConfigurationError(path, "must be base64 or 64-hex encoded");
  }
  rejectWeakMaterial(key, path);
  return value;
}

/** Opaque shared secrets (e.g. internalSecret): UTF-8 length + weak-pattern checks. */
function opaqueSecret(raw, path) {
  const value = string(raw, path, { min: 32, max: 1024 });
  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    throw new DockerConfigurationError(path, "must not use a known placeholder value");
  }
  rejectWeakMaterial(Buffer.from(value, "utf8"), path);
  return value;
}

async function readSecretFile(filePath, path) {
  const resolved = string(filePath, path);
  if (!resolved.startsWith("/")) {
    throw new DockerConfigurationError(path, "must be an absolute path");
  }
  try {
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new DockerConfigurationError(path, "must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new DockerConfigurationError(path, "must deny all group and other access (0600 or stricter)");
    }
    return (await readFile(resolved, "utf8")).trim();
  } catch (error) {
    if (error instanceof DockerConfigurationError) throw error;
    throw new DockerConfigurationError(path, "could not be read");
  }
}

async function secretFromInlineOrFile(record, path, { inlineKey = "secret", fileKey = "secretFile" } = {}) {
  const hasInline = record[inlineKey] !== undefined && record[inlineKey] !== null && record[inlineKey] !== "";
  const hasFile = record[fileKey] !== undefined && record[fileKey] !== null && record[fileKey] !== "";
  if (hasInline === hasFile) {
    throw new DockerConfigurationError(path, `must set exactly one of ${inlineKey} or ${fileKey}`);
  }
  const raw = hasInline
    ? string(record[inlineKey], `${path}.${inlineKey}`)
    : await readSecretFile(record[fileKey], `${path}.${fileKey}`);
  return decodeSecretMaterial(raw, path);
}

async function exclusiveUrl(record, path) {
  const hasUrl = record.url !== undefined && record.url !== null && record.url !== "";
  const hasFile = record.urlFile !== undefined && record.urlFile !== null && record.urlFile !== "";
  if (hasUrl === hasFile) {
    throw new DockerConfigurationError(path, "must set exactly one of url or urlFile");
  }
  const raw = hasUrl
    ? string(record.url, `${path}.url`, { max: 2048 })
    : await readSecretFile(record.urlFile, `${path}.urlFile`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DockerConfigurationError(path, "must be a valid URL");
  }
  if (!["postgres:", "postgresql:", "redis:", "rediss:"].includes(parsed.protocol) && path.includes("postgres")) {
    // postgres URL protocols
  }
  if (path.includes("postgres") && !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new DockerConfigurationError(path, "must use postgres:// or postgresql://");
  }
  if (path.includes("redis") && !["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new DockerConfigurationError(path, "must use redis:// or rediss://");
  }
  return raw;
}

function namespace(value, path) {
  const raw = string(value, path, { min: 1, max: 64 });
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new DockerConfigurationError(path, "must not contain whitespace or control characters");
  }
  return raw;
}

function exactOrigin(value, path, { requireHttps = false } = {}) {
  const raw = string(value, path);
  if (raw === "*") throw new DockerConfigurationError(path, "must not be a wildcard");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DockerConfigurationError(path, "must be an exact HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new DockerConfigurationError(path, "must be an exact HTTP(S) origin");
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new DockerConfigurationError(path, "must use HTTPS in production");
  }
  return url.origin;
}

export async function loadDockerConfig(file = process.env.AMAZON_CONFIG_FILE || "/app/config.yaml") {
  let parsed;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new DockerConfigurationError("config", "must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new DockerConfigurationError("config permissions", "must deny all group and other access (0600 or stricter)");
    }
    parsed = YAML.parse(await readFile(file, "utf8"), { uniqueKeys: true });
  } catch (error) {
    if (error instanceof DockerConfigurationError) throw error;
    throw new DockerConfigurationError("config", "could not be read or parsed");
  }

  const root = exactKeys(parsed, ["server", "amazon", "oauth", "mcp", "storage", "connected-account"], "config");
  const server = exactKeys(root.server, ["oauth", "mcp"], "server");
  const oauthServer = exactKeys(server.oauth, ["host", "port"], "server.oauth");
  const mcpServer = exactKeys(server.mcp, ["host", "port", "allowedHosts"], "server.mcp");
  const amazon = exactKeys(root.amazon, [
    "publicOrigin", "oauthRedirectUri", "successRedirectUri", "applicationId",
    "authorizationUri", "applicationVersion", "lwa", "tokenEncryptionKey",
    "credentialKeys", "allowedSellingPartnerIds",
  ], "amazon");
  const lwa = exactKeys(amazon.lwa, ["clientId", "clientSecret"], "amazon.lwa");
  const oauth = exactKeys(root.oauth, ["internalSecret", "dataDirectory"], "oauth");
  const mcp = exactKeys(root.mcp, [
    "allowLegacyAuth", "legacyAuthToken", "legacyTenantId", "enableListingsTools",
    "identityValidationUrl", "identityHealthUrl", "limits", "cache",
  ], "mcp");
  const limits = optionalSection(mcp.limits, ["requestsPerMinute", "maxConcurrentRequests"], "mcp.limits");
  const cache = optionalSection(mcp.cache, ["connectionTtlMs", "regionTtlMs"], "mcp.cache");
  const storage = optionalSection(root.storage, ["postgres", "redis"], "storage");
  const connected-account = optionalSection(root.connected-account, [
    "enabled", "audience", "allowedOrigins", "jwtKeys",
  ], "connected-account");

  const oauthHost = string(oauthServer.host, "server.oauth.host");
  const oauthPort = integer(oauthServer.port, "server.oauth.port", { max: 65535 });
  const mcpHost = string(mcpServer.host, "server.mcp.host");
  const mcpPort = integer(mcpServer.port, "server.mcp.port", { max: 65535 });
  if (oauthPort !== 8788) throw new DockerConfigurationError("server.oauth.port", "must be 8788 inside the container");
  if (mcpPort !== 8789) throw new DockerConfigurationError("server.mcp.port", "must be 8789 inside the container");
  const allowedHosts = stringList(mcpServer.allowedHosts, "server.mcp.allowedHosts", { nonEmpty: true });
  const publicOrigin = httpsURL(amazon.publicOrigin, "amazon.publicOrigin");
  const redirectUri = httpsURL(amazon.oauthRedirectUri, "amazon.oauthRedirectUri");
  if (!redirectUri.startsWith(`${publicOrigin}/`)) {
    throw new DockerConfigurationError("amazon.oauthRedirectUri", "must use amazon.publicOrigin");
  }
  const internalSecret = opaqueSecret(oauth.internalSecret, "oauth.internalSecret");
  const dataDirectory = string(oauth.dataDirectory, "oauth.dataDirectory");
  if (!dataDirectory.startsWith("/")) throw new DockerConfigurationError("oauth.dataDirectory", "must be an absolute path");
  const allowLegacyAuth = boolean(mcp.allowLegacyAuth, "mcp.allowLegacyAuth");
  const legacyAuthToken = string(mcp.legacyAuthToken, "mcp.legacyAuthToken", { optional: true });
  if (allowLegacyAuth && Buffer.byteLength(legacyAuthToken) < 32) {
    throw new DockerConfigurationError("mcp.legacyAuthToken", "is required and must contain at least 32 bytes when legacy auth is enabled");
  }
  const sellerIds = stringList(amazon.allowedSellingPartnerIds, "amazon.allowedSellingPartnerIds", {
    nonEmpty: true,
    pattern: /^[A-Za-z0-9._:-]{1,128}$/,
  });

  // Encryption keyring: credentialKeys (preferred) XOR legacy tokenEncryptionKey (compat).
  const hasLegacyKey = amazon.tokenEncryptionKey !== undefined
    && amazon.tokenEncryptionKey !== null
    && amazon.tokenEncryptionKey !== "";
  const hasKeyring = amazon.credentialKeys !== undefined && amazon.credentialKeys !== null;
  if (hasLegacyKey === hasKeyring) {
    throw new DockerConfigurationError(
      "amazon",
      "must set exactly one of tokenEncryptionKey (compat) or credentialKeys (production)",
    );
  }

  let tokenEncryptionKey;
  let credentialKeyEnv = {};
  if (hasKeyring) {
    const credentialKeys = exactKeys(
      amazon.credentialKeys,
      ["currentKeyId", "keys"],
      "amazon.credentialKeys",
    );
    const currentKeyId = string(credentialKeys.currentKeyId, "amazon.credentialKeys.currentKeyId", { max: 64 });
    if (currentKeyId === "legacy-unversioned") {
      throw new DockerConfigurationError("amazon.credentialKeys.currentKeyId", "must not be legacy-unversioned");
    }
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(currentKeyId)) {
      throw new DockerConfigurationError("amazon.credentialKeys.currentKeyId", "is invalid");
    }
    if (!Array.isArray(credentialKeys.keys) || credentialKeys.keys.length === 0) {
      throw new DockerConfigurationError("amazon.credentialKeys.keys", "must be a non-empty list");
    }
    const keyMaterials = {};
    const seen = new Set();
    for (const [index, item] of credentialKeys.keys.entries()) {
      const entry = exactKeys(item, ["keyId", "secret", "secretFile"], `amazon.credentialKeys.keys[${index}]`);
      const keyId = string(entry.keyId, `amazon.credentialKeys.keys[${index}].keyId`, { max: 64 });
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyId)) {
        throw new DockerConfigurationError(`amazon.credentialKeys.keys[${index}].keyId`, "is invalid");
      }
      if (seen.has(keyId)) {
        throw new DockerConfigurationError(`amazon.credentialKeys.keys[${index}].keyId`, "is duplicated");
      }
      seen.add(keyId);
      keyMaterials[keyId] = await secretFromInlineOrFile(entry, `amazon.credentialKeys.keys[${index}]`);
    }
    if (!seen.has(currentKeyId)) {
      throw new DockerConfigurationError("amazon.credentialKeys.currentKeyId", "must exist in keys");
    }
    tokenEncryptionKey = keyMaterials[currentKeyId];
    credentialKeyEnv = {
      AMAZON_TOKEN_ENCRYPTION_CURRENT_KEY_ID: currentKeyId,
      AMAZON_TOKEN_ENCRYPTION_KEYRING: JSON.stringify(keyMaterials),
    };
  } else {
    // Compat window: single key maps to current write key k0 (documented as non-production-preferred).
    tokenEncryptionKey = decodeSecretMaterial(amazon.tokenEncryptionKey, "amazon.tokenEncryptionKey");
    credentialKeyEnv = {
      AMAZON_TOKEN_ENCRYPTION_CURRENT_KEY_ID: "k0",
      AMAZON_TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ k0: tokenEncryptionKey }),
    };
  }

  // Storage
  let postgresUrl = "";
  let redisUrl = "";
  let redisNamespace = "amazon-sp-api";
  if (storage.postgres) {
    const postgres = exactKeys(storage.postgres, [
      "url", "urlFile", "schema", "pool",
    ], "storage.postgres");
    postgresUrl = await exclusiveUrl(postgres, "storage.postgres");
    const schema = string(postgres.schema ?? "amazon_sp_api", "storage.postgres.schema", { max: 63 });
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      throw new DockerConfigurationError("storage.postgres.schema", "is invalid");
    }
    const pool = optionalSection(postgres.pool, ["min", "max", "idleTimeoutMs"], "storage.postgres.pool");
    const poolMin = integer(pool.min ?? 0, "storage.postgres.pool.min", { min: 0, max: 50 });
    const poolMax = integer(pool.max ?? 10, "storage.postgres.pool.max", { min: 1, max: 100 });
    if (poolMin > poolMax) {
      throw new DockerConfigurationError("storage.postgres.pool", "min must be <= max");
    }
    integer(pool.idleTimeoutMs ?? 10_000, "storage.postgres.pool.idleTimeoutMs", { min: 1000, max: 600_000 });
  }
  if (storage.redis) {
    const redis = exactKeys(storage.redis, ["url", "urlFile", "namespace"], "storage.redis");
    redisUrl = await exclusiveUrl(redis, "storage.redis");
    redisNamespace = namespace(redis.namespace ?? "amazon-sp-api", "storage.redis.namespace");
  }

  // ConnectedAccount
  const connected-accountEnabled = boolean(connected-account.enabled, "connected-account.enabled", false);
  let connected-accountAudience = "";
  let connected-accountOrigins = [];
  let connected-accountJwtKeysJson = "";
  if (connected-accountEnabled) {
    if (!postgresUrl || !redisUrl) {
      throw new DockerConfigurationError("connected-account.enabled", "requires storage.postgres and storage.redis");
    }
    if (hasLegacyKey) {
      throw new DockerConfigurationError(
        "connected-account.enabled",
        "requires amazon.credentialKeys (tokenEncryptionKey-only mode is file-compat only)",
      );
    }
    connected-accountAudience = string(connected-account.audience, "connected-account.audience", { min: 3, max: 256 });
    connected-accountOrigins = stringList(connected-account.allowedOrigins, "connected-account.allowedOrigins", { nonEmpty: true, maxItems: 20 })
      .map((item, index) => exactOrigin(item, `connected-account.allowedOrigins[${index}]`, { requireHttps: true }));
    if (!Array.isArray(connected-account.jwtKeys) || connected-account.jwtKeys.length === 0) {
      throw new DockerConfigurationError("connected-account.jwtKeys", "must be a non-empty list");
    }
    const jwtMap = {};
    const kids = new Set();
    for (const [index, item] of connected-account.jwtKeys.entries()) {
      const entry = exactKeys(item, ["kid", "issuer", "secret", "secretFile"], `connected-account.jwtKeys[${index}]`);
      const kid = string(entry.kid, `connected-account.jwtKeys[${index}].kid`, { max: 128 });
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid)) {
        throw new DockerConfigurationError(`connected-account.jwtKeys[${index}].kid`, "is invalid");
      }
      if (kids.has(kid)) {
        throw new DockerConfigurationError(`connected-account.jwtKeys[${index}].kid`, "is duplicated");
      }
      kids.add(kid);
      const issuer = string(entry.issuer, `connected-account.jwtKeys[${index}].issuer`, { max: 512 });
      const secret = await secretFromInlineOrFile(entry, `connected-account.jwtKeys[${index}]`);
      jwtMap[kid] = { issuer, secret };
    }
    connected-accountJwtKeysJson = JSON.stringify(jwtMap);
  } else if (Object.keys(connected-account).length > 0 && connected-account.enabled !== false && connected-account.enabled !== undefined) {
    // already handled
  }

  const identityValidationUrl = identityURL(mcp.identityValidationUrl, "mcp.identityValidationUrl");
  const identityHealthUrlRaw = string(mcp.identityHealthUrl, "mcp.identityHealthUrl", { optional: true });
  const identityHealthUrl = identityHealthUrlRaw
    ? identityURL(mcp.identityHealthUrl, "mcp.identityHealthUrl")
    : "";

  const shared = {
    AMAZON_LWA_CLIENT_ID: string(lwa.clientId, "amazon.lwa.clientId"),
    AMAZON_LWA_CLIENT_SECRET: string(lwa.clientSecret, "amazon.lwa.clientSecret"),
    AMAZON_TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    AMAZON_INTERNAL_SECRET: internalSecret,
    ...credentialKeyEnv,
    ...(postgresUrl ? { AMAZON_DATABASE_URL: postgresUrl } : {}),
    ...(redisUrl ? {
      AMAZON_REDIS_URL: redisUrl,
      AMAZON_REDIS_NAMESPACE: redisNamespace,
    } : {}),
  };

  const tokenStoreFile = `${dataDirectory.replace(/\/$/, "")}/tokens.json`;
  return {
    oauthPort,
    mcpPort,
    dataDirectory,
    tokenStoreFile,
    connected-accountEnabled,
    productionStorage: Boolean(postgresUrl && redisUrl),
    oauthEnv: {
      ...shared,
      HOST: oauthHost,
      PORT: String(oauthPort),
      AMAZON_DATA_DIR: dataDirectory,
      AMAZON_PUBLIC_ORIGIN: publicOrigin,
      AMAZON_OAUTH_REDIRECT_URI: redirectUri,
      AMAZON_SUCCESS_REDIRECT_URI: optionalHttpsURL(amazon.successRedirectUri, "amazon.successRedirectUri"),
      AMAZON_APPLICATION_ID: string(amazon.applicationId, "amazon.applicationId"),
      AMAZON_AUTHORIZATION_URI: httpsURL(amazon.authorizationUri, "amazon.authorizationUri"),
      AMAZON_APPLICATION_VERSION: string(amazon.applicationVersion, "amazon.applicationVersion"),
    },
    mcpEnv: {
      ...shared,
      HOST: mcpHost,
      PORT: String(mcpPort),
      MCP_ALLOWED_HOSTS: allowedHosts.join(","),
      MCP_ALLOW_LEGACY_AUTH: String(allowLegacyAuth),
      MCP_AUTH_TOKEN: legacyAuthToken,
      MCP_LEGACY_TENANT_ID: string(mcp.legacyTenantId, "mcp.legacyTenantId", { optional: true }),
      MCP_TENANT_REQUESTS_PER_MINUTE: String(integer(limits.requestsPerMinute ?? 120, "mcp.limits.requestsPerMinute")),
      MCP_TENANT_MAX_CONCURRENT_REQUESTS: String(integer(limits.maxConcurrentRequests ?? 8, "mcp.limits.maxConcurrentRequests")),
      MCP_CONNECTION_CACHE_TTL_MS: String(integer(cache.connectionTtlMs ?? 30000, "mcp.cache.connectionTtlMs", { min: 0 })),
      MCP_REGION_CACHE_TTL_MS: String(integer(cache.regionTtlMs ?? 86400000, "mcp.cache.regionTtlMs", { min: 0 })),
      AMAZON_ALLOWED_SELLING_PARTNER_IDS: sellerIds.join(","),
      AMAZON_ENABLE_LISTINGS_TOOLS: String(boolean(mcp.enableListingsTools, "mcp.enableListingsTools")),
      AMAZON_TOKEN_STORE_FILE: tokenStoreFile,
      AMAZON_OAUTH_INTERNAL_URL: `http://127.0.0.1:${oauthPort}`,
      LEGACY_IDENTITY_VALIDATION_URL: identityValidationUrl,
      ...(identityHealthUrl ? { LEGACY_IDENTITY_HEALTH_URL: identityHealthUrl } : {}),
      CONNECTED_ACCOUNT_ENABLED: String(connected-accountEnabled),
      ...(connected-accountEnabled ? {
        CONNECTED_ACCOUNT_JWT_AUDIENCE: connected-accountAudience,
        CONNECTED_ACCOUNT_JWT_KEYS: connected-accountJwtKeysJson,
        CONNECTED_ACCOUNT_ALLOWED_ORIGINS: connected-accountOrigins.join(","),
      } : {}),
    },
  };
}
