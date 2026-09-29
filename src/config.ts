// The parser deliberately validates untyped YAML one field at a time before it
// returns the typed runtime object.
// @ts-nocheck
import { readFile, stat } from "node:fs/promises";
import YAML from "yaml";
import type { ConnectedAccountJwtKey } from "./connected-account.js";

export interface RuntimeConfig {
  host: string;
  allowedHosts: string[];
  publicOrigin: string;
  redirectUri: string;
  successRedirectUri: string;
  applicationId: string;
  authorizationUri: string;
  applicationVersion: string;
  lwaClientId: string;
  lwaClientSecret: string;
  credentialKeyring: {
    currentKeyId: string;
    keys: Record<string, string>;
  };
  allowedSellingPartnerIds: string[];
  dataDirectory: string;
  tokenStoreFile: string;
  stateStoreFile: string;
  intentStoreFile: string;
  connectedAccountDatabaseFile: string;
  sellerCentralManageURL: string;
  databaseUrl?: string;
  postgresPool: { min: number; max: number; idleTimeoutMs: number };
  redisUrl?: string;
  redisNamespace: string;
  connectedAccountEnabled: boolean;
  connectedAccountJwtAudience?: string;
  connectedAccountJwtKeys: ConnectedAccountJwtKey[];
  connectedAccountAllowedOrigins: string[];
  adminSessionSecret?: string;
  operator?: {
    name: string;
    legalName?: string;
    legalNameEn?: string;
    url?: string;
    wwwUrl?: string;
    email?: string;
    siteUrl?: string;
    initial?: string;
    registrationId?: string;
  };
  adminOa?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    subject: string;
    scope: string;
    redirectUri: string;
  };
}

export class ConfigurationError extends Error {
  constructor(path, message) {
    super(`${path} ${message}`);
    this.name = "ConfigurationError";
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
    throw new ConfigurationError(path, "must be a mapping");
  }
  return value;
};

function exactKeys(value, allowed, path) {
  const record = object(value, path);
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new ConfigurationError(`${path}.${unknown}`, "is not supported");
  return record;
}

function string(value, path, { optional = false, min = 1, max = 4096 } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || value.trim().length < min) {
    throw new ConfigurationError(path, `must be a string of at least ${min} characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ConfigurationError(path, `must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalString(value, path) {
  if (value === undefined || value === null || value === "") return undefined;
  return string(value, path);
}

function boolean(value, path, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigurationError(path, "must be true or false");
  return value;
}

function integer(value, path, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(path, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function stringList(value, path, { nonEmpty = false, pattern, maxItems = 100 } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new ConfigurationError(path, nonEmpty ? "must be a non-empty list" : "must be a list");
  }
  if (value.length > maxItems) {
    throw new ConfigurationError(path, `must contain at most ${maxItems} items`);
  }
  const result = [...new Set(value.map((item, index) => {
    const parsed = string(item, `${path}[${index}]`);
    if (pattern && !pattern.test(parsed)) throw new ConfigurationError(`${path}[${index}]`, "is invalid");
    return parsed;
  }))];
  if (nonEmpty && result.length === 0) throw new ConfigurationError(path, "must be a non-empty list");
  return result;
}

function httpsURL(value, path) {
  const parsed = new URL(string(value, path));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ConfigurationError(path, "must be an HTTPS URL without embedded credentials");
  }
  return parsed.toString().replace(/\/$/, "");
}

function optionalHttpsURL(value, path) {
  const raw = string(value, path, { optional: true });
  return raw ? httpsURL(raw, path) : "";
}

function oidcIssuer(value, path) {
  const raw = string(value, path, { max: 2048 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(path, "must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.href.includes("/.well-known/")
  ) {
    throw new ConfigurationError(path, "must be an HTTPS issuer URL without credentials, query, fragment, or a discovery-document path");
  }
  return parsed.toString();
}

function optionalSection(value, allowed, path) {
  if (value === undefined || value === null) return {};
  return exactKeys(value, allowed, path);
}

function rejectWeakMaterial(key, path) {
  if (key.length < 32) {
    throw new ConfigurationError(path, "must decode to at least 32 bytes");
  }
  if (key.every((byte) => byte === 0)) {
    throw new ConfigurationError(path, "must not be all-zero bytes");
  }
  if (key.every((byte) => byte === key[0])) {
    throw new ConfigurationError(path, "must not be all-identical bytes");
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
      throw new ConfigurationError(path, "must not use a short repeating byte pattern");
    }
  }
}

/** Encryption / JWT secrets: base64 or 64-hex, high-quality material checks. */
function decodeSecretMaterial(raw, path, { exactBytes } = {}) {
  const value = string(raw, path, { min: 1, max: 1024 });
  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    throw new ConfigurationError(path, "must not use a known placeholder value");
  }
  let key;
  if (/^[a-fA-F0-9]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 !== 1) {
    key = Buffer.from(value, "base64");
    const canonical = key.toString("base64").replace(/=+$/, "");
    if (canonical !== value.replace(/=+$/, "")) {
      throw new ConfigurationError(path, "must be base64 or 64-hex encoded");
    }
  } else {
    throw new ConfigurationError(path, "must be base64 or 64-hex encoded");
  }
  if (exactBytes !== undefined && key.length !== exactBytes) {
    throw new ConfigurationError(path, `must decode to exactly ${exactBytes} bytes`);
  }
  rejectWeakMaterial(key, path);
  return value;
}

async function readSecretFile(filePath, path) {
  const resolved = string(filePath, path);
  if (!resolved.startsWith("/")) {
    throw new ConfigurationError(path, "must be an absolute path");
  }
  try {
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new ConfigurationError(path, "must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new ConfigurationError(path, "must deny all group and other access (0600 or stricter)");
    }
    return (await readFile(resolved, "utf8")).trim();
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(path, "could not be read");
  }
}

async function secretFromInlineOrFile(
  record,
  path,
  { inlineKey = "secret", fileKey = "secretFile", exactBytes } = {},
) {
  const hasInline = record[inlineKey] !== undefined && record[inlineKey] !== null && record[inlineKey] !== "";
  const hasFile = record[fileKey] !== undefined && record[fileKey] !== null && record[fileKey] !== "";
  if (hasInline === hasFile) {
    throw new ConfigurationError(path, `must set exactly one of ${inlineKey} or ${fileKey}`);
  }
  const raw = hasInline
    ? string(record[inlineKey], `${path}.${inlineKey}`)
    : await readSecretFile(record[fileKey], `${path}.${fileKey}`);
  return decodeSecretMaterial(raw, path, { exactBytes });
}

async function exclusiveUrl(record, path) {
  const hasUrl = record.url !== undefined && record.url !== null && record.url !== "";
  const hasFile = record.urlFile !== undefined && record.urlFile !== null && record.urlFile !== "";
  if (hasUrl === hasFile) {
    throw new ConfigurationError(path, "must set exactly one of url or urlFile");
  }
  const raw = hasUrl
    ? string(record.url, `${path}.url`, { max: 2048 })
    : await readSecretFile(record.urlFile, `${path}.urlFile`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(path, "must be a valid URL");
  }
  if (path.includes("postgres") && !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new ConfigurationError(path, "must use postgres:// or postgresql://");
  }
  if (path.includes("redis") && !["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new ConfigurationError(path, "must use redis:// or rediss://");
  }
  return raw;
}

function namespace(value, path) {
  const raw = string(value, path, { min: 1, max: 64 });
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new ConfigurationError(path, "must not contain whitespace or control characters");
  }
  return raw;
}

function exactOrigin(value, path, { requireHttps = false } = {}) {
  const raw = string(value, path);
  if (raw === "*") throw new ConfigurationError(path, "must not be a wildcard");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(path, "must be an exact HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigurationError(path, "must be an exact HTTP(S) origin");
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new ConfigurationError(path, "must use HTTPS in production");
  }
  return url.origin;
}

export async function loadConfig(
  file = process.env.AMAZON_CONFIG_FILE || "config.yaml",
): Promise<RuntimeConfig> {
  let parsed;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new ConfigurationError("config", "must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new ConfigurationError("config permissions", "must deny all group and other access (0600 or stricter)");
    }
    parsed = YAML.parse(await readFile(file, "utf8"), { uniqueKeys: true });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("config", "could not be read or parsed");
  }

  const draft = object(parsed, "config");
  if (draft.oauth !== undefined) {
    throw new ConfigurationError(
      "oauth",
      "has been removed; move oauth.dataDirectory to storage.dataDirectory",
    );
  }
  if (draft.server?.oauth !== undefined || draft.server?.mcp !== undefined) {
    throw new ConfigurationError(
      "server",
      "uses the removed two-service layout; migrate to server.host and server.allowedHosts",
    );
  }
  if (draft.server?.port !== undefined) {
    throw new ConfigurationError(
      "server.port",
      "has been removed; the service always listens on port 8789",
    );
  }
  if (draft.amazon?.oauthRedirectUri !== undefined) {
    throw new ConfigurationError(
      "amazon.oauthRedirectUri",
      "has been removed; it is derived as amazon.publicOrigin + /oauth/amazon/callback",
    );
  }
  if (draft.amazon?.tokenEncryptionKey !== undefined) {
    throw new ConfigurationError(
      "amazon.tokenEncryptionKey",
      "has been removed; migrate the same key to amazon.credentialKeys with keyId k0",
    );
  }
  if (draft.mcp !== undefined) {
    const migrationHints = {
      identityValidationUrl: "has been removed; MCP now verifies ConnectedAccount JWTs locally",
      identityHealthUrl: "has been removed; readiness no longer calls an external identity service",
      enableListingsTools: "has been removed; Listings tools are always enabled",
      limits: "has been removed; the Provider does not apply local request or concurrency limits",
      cache: "has been removed; connection and region cache TTLs are fixed in the service",
      allowLegacyAuth: "has been removed; MCP accepts only ConnectedAccount Employee JWTs",
      legacyAuthToken: "has been removed; shared bearer tokens are not supported",
      legacyTenantId: "has been removed; accounts are resolved from the ConnectedAccount account_id claim",
    };
    const key = Object.keys(draft.mcp)[0];
    if (key && migrationHints[key]) {
      throw new ConfigurationError(
        `mcp.${key}`,
        migrationHints[key],
      );
    }
    throw new ConfigurationError(
      "mcp",
      "has been removed; MCP accepts only locally verified ConnectedAccount JWTs and uses fixed limits",
    );
  }
  if (draft.storage?.postgres?.schema !== undefined) {
    throw new ConfigurationError(
      "storage.postgres.schema",
      "has been removed; the PostgreSQL schema is fixed as amazon_sp_api",
    );
  }

  const root = exactKeys(draft, ["server", "amazon", "storage", "connectedAccount", "admin", "operator"], "config");
  const server = exactKeys(root.server, ["host", "allowedHosts"], "server");
  const amazon = exactKeys(root.amazon, [
    "publicOrigin", "successRedirectUri", "applicationId", "authorizationUri",
    "applicationVersion", "lwa", "credentialKeys", "allowedSellingPartnerIds",
  ], "amazon");
  const lwa = exactKeys(amazon.lwa, ["clientId", "clientSecret"], "amazon.lwa");
  const storage = exactKeys(root.storage, ["dataDirectory", "postgres", "redis"], "storage");
  const connectedAccount = optionalSection(root.connectedAccount, [
    "enabled", "audience", "allowedOrigins", "jwtKeys",
  ], "connectedAccount");
  const admin = optionalSection(root.admin, ["sessionSecretFile", "oa"], "admin");
  const adminOa = optionalSection(admin.oa, [
    "issuer", "clientId", "clientSecretFile", "subject", "scopes",
  ], "admin.oa");
  const operatorSection = optionalSection(root.operator, [
    "name", "legalName", "legalNameEn", "url", "wwwUrl", "email", "siteUrl", "initial", "registrationId",
  ], "operator");
  const operator = operatorSection.name === undefined ? undefined : {
    name: string(operatorSection.name, "operator.name"),
    legalName: optionalString(operatorSection.legalName, "operator.legalName"),
    legalNameEn: optionalString(operatorSection.legalNameEn, "operator.legalNameEn"),
    url: optionalString(operatorSection.url, "operator.url"),
    wwwUrl: optionalString(operatorSection.wwwUrl, "operator.wwwUrl"),
    email: optionalString(operatorSection.email, "operator.email"),
    siteUrl: optionalString(operatorSection.siteUrl, "operator.siteUrl"),
    initial: optionalString(operatorSection.initial, "operator.initial"),
    registrationId: optionalString(operatorSection.registrationId, "operator.registrationId"),
  };

  const host = string(server.host, "server.host");
  const allowedHosts = stringList(server.allowedHosts, "server.allowedHosts", { nonEmpty: true });
  const publicOrigin = httpsURL(amazon.publicOrigin, "amazon.publicOrigin");
  const redirectUri = new URL("/oauth/amazon/callback", publicOrigin).toString();
  const dataDirectory = string(storage.dataDirectory, "storage.dataDirectory");
  if (!dataDirectory.startsWith("/")) {
    throw new ConfigurationError("storage.dataDirectory", "must be an absolute path");
  }
  const sellerIds = stringList(amazon.allowedSellingPartnerIds, "amazon.allowedSellingPartnerIds", {
    nonEmpty: true,
    pattern: /^[A-Za-z0-9._:-]{1,128}$/,
  });

  const credentialKeys = exactKeys(
    amazon.credentialKeys,
    ["currentKeyId", "keys"],
    "amazon.credentialKeys",
  );
  const currentKeyId = string(
    credentialKeys.currentKeyId,
    "amazon.credentialKeys.currentKeyId",
    { max: 64 },
  );
  if (currentKeyId === "legacy-unversioned") {
    throw new ConfigurationError(
      "amazon.credentialKeys.currentKeyId",
      "must not be legacy-unversioned",
    );
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(currentKeyId)) {
    throw new ConfigurationError("amazon.credentialKeys.currentKeyId", "is invalid");
  }
  if (!Array.isArray(credentialKeys.keys) || credentialKeys.keys.length === 0) {
    throw new ConfigurationError("amazon.credentialKeys.keys", "must be a non-empty list");
  }
  const keyMaterials = {};
  const seen = new Set();
  for (const [index, item] of credentialKeys.keys.entries()) {
    const entry = exactKeys(
      item,
      ["keyId", "secret", "secretFile"],
      `amazon.credentialKeys.keys[${index}]`,
    );
    const keyId = string(
      entry.keyId,
      `amazon.credentialKeys.keys[${index}].keyId`,
      { max: 64 },
    );
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyId)) {
      throw new ConfigurationError(`amazon.credentialKeys.keys[${index}].keyId`, "is invalid");
    }
    if (seen.has(keyId)) {
      throw new ConfigurationError(`amazon.credentialKeys.keys[${index}].keyId`, "is duplicated");
    }
    seen.add(keyId);
    keyMaterials[keyId] = await secretFromInlineOrFile(
      entry,
      `amazon.credentialKeys.keys[${index}]`,
      { exactBytes: 32 },
    );
  }
  if (!seen.has(currentKeyId)) {
    throw new ConfigurationError("amazon.credentialKeys.currentKeyId", "must exist in keys");
  }
  const credentialKeyring = { currentKeyId, keys: keyMaterials };

  // Storage
  let postgresUrl = "";
  let postgresPool = { min: 0, max: 10, idleTimeoutMs: 10_000 };
  let redisUrl = "";
  let redisNamespace = "amazon-sp-api";
  if (storage.postgres) {
    const postgres = exactKeys(storage.postgres, [
      "url", "urlFile", "pool",
    ], "storage.postgres");
    postgresUrl = await exclusiveUrl(postgres, "storage.postgres");
    const pool = optionalSection(postgres.pool, ["min", "max", "idleTimeoutMs"], "storage.postgres.pool");
    const poolMin = integer(pool.min ?? 0, "storage.postgres.pool.min", { min: 0, max: 50 });
    const poolMax = integer(pool.max ?? 10, "storage.postgres.pool.max", { min: 1, max: 100 });
    if (poolMin > poolMax) {
      throw new ConfigurationError("storage.postgres.pool", "min must be <= max");
    }
    const idleTimeoutMs = integer(pool.idleTimeoutMs ?? 10_000, "storage.postgres.pool.idleTimeoutMs", { min: 1000, max: 600_000 });
    postgresPool = { min: poolMin, max: poolMax, idleTimeoutMs };
  }
  if (storage.redis) {
    const redis = exactKeys(storage.redis, ["url", "urlFile", "namespace"], "storage.redis");
    redisUrl = await exclusiveUrl(redis, "storage.redis");
    redisNamespace = namespace(redis.namespace ?? "amazon-sp-api", "storage.redis.namespace");
  }

  let adminSessionSecret = "";
  let parsedAdminOa;
  if (root.admin !== undefined) {
    if (!postgresUrl) {
      throw new ConfigurationError("admin", "requires storage.postgres");
    }
    const raw = await readSecretFile(admin.sessionSecretFile, "admin.sessionSecretFile");
    adminSessionSecret = decodeSecretMaterial(raw, "admin.sessionSecretFile", { exactBytes: 32 });
    if (admin.oa !== undefined) {
      const clientSecret = await readSecretFile(adminOa.clientSecretFile, "admin.oa.clientSecretFile");
      if (
        clientSecret.length < 16
        || clientSecret.length > 1024
        || PLACEHOLDER_SECRETS.has(clientSecret.toLowerCase())
      ) {
        throw new ConfigurationError("admin.oa.clientSecretFile", "must contain a non-placeholder secret of 16 to 1024 characters");
      }
      const scopes = adminOa.scopes === undefined
        ? ["openid", "profile"]
        : stringList(adminOa.scopes, "admin.oa.scopes", {
          nonEmpty: true,
          maxItems: 20,
          pattern: /^[A-Za-z0-9._:-]{1,128}$/,
        });
      if (!scopes.includes("openid")) {
        throw new ConfigurationError("admin.oa.scopes", "must include openid");
      }
      parsedAdminOa = {
        issuer: oidcIssuer(adminOa.issuer, "admin.oa.issuer"),
        clientId: string(adminOa.clientId, "admin.oa.clientId", { min: 3, max: 512 }),
        clientSecret,
        subject: string(adminOa.subject, "admin.oa.subject", { max: 512 }),
        scope: scopes.join(" "),
        redirectUri: new URL("/api/v1/admin/oa/callback", publicOrigin).toString(),
      };
    }
  }

  // ConnectedAccount
  const connectedAccountEnabled = boolean(connectedAccount.enabled, "connectedAccount.enabled", false);
  let connectedAccountAudience = "";
  let connectedAccountOrigins = [];
  let connectedAccountJwtKeys = [];
  if (connectedAccountEnabled) {
    if (!postgresUrl || !redisUrl) {
      throw new ConfigurationError("connectedAccount.enabled", "requires storage.postgres and storage.redis");
    }
    connectedAccountAudience = string(connectedAccount.audience, "connectedAccount.audience", { min: 3, max: 256 });
    connectedAccountOrigins = stringList(connectedAccount.allowedOrigins, "connectedAccount.allowedOrigins", { nonEmpty: true, maxItems: 20 })
      .map((item, index) => exactOrigin(item, `connectedAccount.allowedOrigins[${index}]`, { requireHttps: true }));
    if (!Array.isArray(connectedAccount.jwtKeys) || connectedAccount.jwtKeys.length === 0) {
      throw new ConfigurationError("connectedAccount.jwtKeys", "must be a non-empty list");
    }
    const kids = new Set();
    for (const [index, item] of connectedAccount.jwtKeys.entries()) {
      const entry = exactKeys(item, ["kid", "issuer", "secret", "secretFile"], `connectedAccount.jwtKeys[${index}]`);
      const kid = string(entry.kid, `connectedAccount.jwtKeys[${index}].kid`, { max: 128 });
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid)) {
        throw new ConfigurationError(`connectedAccount.jwtKeys[${index}].kid`, "is invalid");
      }
      if (kids.has(kid)) {
        throw new ConfigurationError(`connectedAccount.jwtKeys[${index}].kid`, "is duplicated");
      }
      kids.add(kid);
      const issuer = string(entry.issuer, `connectedAccount.jwtKeys[${index}].issuer`, { max: 512 });
      const secret = await secretFromInlineOrFile(entry, `connectedAccount.jwtKeys[${index}]`);
      connectedAccountJwtKeys.push({ kid, issuer, secret });
    }
  }

  const baseDataDirectory = dataDirectory.replace(/\/$/, "");
  const authorizationUri = httpsURL(amazon.authorizationUri, "amazon.authorizationUri");
  return {
    host,
    allowedHosts,
    publicOrigin,
    redirectUri,
    successRedirectUri: optionalHttpsURL(amazon.successRedirectUri, "amazon.successRedirectUri"),
    applicationId: string(amazon.applicationId, "amazon.applicationId"),
    authorizationUri,
    applicationVersion: string(amazon.applicationVersion, "amazon.applicationVersion"),
    lwaClientId: string(lwa.clientId, "amazon.lwa.clientId"),
    lwaClientSecret: string(lwa.clientSecret, "amazon.lwa.clientSecret"),
    credentialKeyring,
    allowedSellingPartnerIds: sellerIds,
    dataDirectory,
    tokenStoreFile: `${baseDataDirectory}/tokens.json`,
    stateStoreFile: `${baseDataDirectory}/states.json`,
    intentStoreFile: `${baseDataDirectory}/intents.json`,
    connectedAccountDatabaseFile: `${baseDataDirectory}/connected-account.sqlite`,
    sellerCentralManageURL: new URL("/apps/manage", authorizationUri).toString(),
    databaseUrl: postgresUrl || undefined,
    postgresPool,
    redisUrl: redisUrl || undefined,
    redisNamespace,
    connectedAccountEnabled,
    connectedAccountJwtAudience: connectedAccountAudience || undefined,
    connectedAccountJwtKeys,
    connectedAccountAllowedOrigins: connectedAccountOrigins,
    adminSessionSecret: adminSessionSecret || undefined,
    operator,
    adminOa: parsedAdminOa,
  };
}
