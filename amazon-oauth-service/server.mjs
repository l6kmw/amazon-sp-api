import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { RedisStateStore } from "./redis-store.mjs";
import {
  createSingleKeyKeyring,
  encryptSecret as encryptSecretEnvelope,
  parseEncryptionKey as parseKeyMaterial,
} from "./token-crypto.mjs";

const AMAZON_DOMAIN_SUFFIXES = [
  "amazon.com",
  "amazon.ca",
  "amazon.com.mx",
  "amazon.com.br",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.nl",
  "amazon.se",
  "amazon.pl",
  "amazon.com.tr",
  "amazon.co.jp",
  "amazon.com.au",
  "amazon.in",
  "amazon.sg",
  "amazon.ae",
  "amazon.sa",
  "amazon.eg",
  "amazon.co.za",
  "amazon.ie",
  "amazon.com.be",
];

const DEFAULT_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const AMAZON_INTENT_COOKIE = "amazon_oauth_intent";

function isAmazonHost(hostname) {
  return AMAZON_DOMAIN_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

export function validateAmazonCallbackUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("amazon_callback_uri is invalid");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !isAmazonHost(url.hostname) ||
    !url.pathname.startsWith("/apps/authorize/confirm/")
  ) {
    throw new InputError("amazon_callback_uri is not an allowed Amazon URI");
  }
  return url;
}

function requiredParam(searchParams, name, maxLength = 4096) {
  const value = searchParams.get(name);
  if (!value || value.length > maxLength) {
    throw new InputError(`${name} is required`);
  }
  return value;
}

function requiredBodyValue(body, name, maxLength = 4096) {
  const value = body?.[name];
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new InputError(`${name} is required`);
  }
  return value;
}

function validateSellingPartnerId(value) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new InputError("selling_partner_id is invalid");
  }
  return value;
}

function parseEncryptionKey(value) {
  if (!value) {
    throw new ConfigurationError("AMAZON_TOKEN_ENCRYPTION_KEY is not configured");
  }
  try {
    return parseKeyMaterial(value);
  } catch {
    throw new ConfigurationError("AMAZON_TOKEN_ENCRYPTION_KEY must be 32 bytes");
  }
}

export function encryptSecret(value, keyValue, credentialId = "unknown") {
  const keyring = createSingleKeyKeyring(keyValue, "k0");
  return encryptSecretEnvelope(value, keyring, {
    credentialId,
    provider: "amazon-sp-api",
  });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function stateKey(state) {
  return createHash("sha256").update(state).digest("base64url");
}

export class StateStore {
  constructor(file, ttlMs = 10 * 60 * 1000) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.queue = Promise.resolve();
  }

  run(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  create(record) {
    return this.run(async () => {
      const now = Date.now();
      const states = await readJson(this.file, {});
      for (const [key, value] of Object.entries(states)) {
        if (value.expiresAt <= now) delete states[key];
      }
      const state = randomBytes(32).toString("base64url");
      states[stateKey(state)] = { ...record, expiresAt: now + this.ttlMs };
      await writeJson(this.file, states);
      return state;
    });
  }

  get(state) {
    return this.run(async () => {
      const states = await readJson(this.file, {});
      const key = stateKey(state);
      const record = states[key] || states[state];
      if (!record) return null;
      if (record.expiresAt <= Date.now()) {
        delete states[key];
        delete states[state];
        await writeJson(this.file, states);
        return null;
      }
      return record;
    });
  }

  delete(state) {
    return this.run(async () => {
      const states = await readJson(this.file, {});
      delete states[stateKey(state)];
      delete states[state];
      await writeJson(this.file, states);
    });
  }

  consume(state, accepts = () => true) {
    return this.run(async () => {
      const states = await readJson(this.file, {});
      const key = stateKey(state);
      const record = states[key] || states[state];
      if (!record || record.expiresAt <= Date.now()) {
        if (record) {
          delete states[key];
          delete states[state];
          await writeJson(this.file, states);
        }
        return null;
      }
      if (!accepts(record)) return null;
      delete states[key];
      delete states[state];
      await writeJson(this.file, states);
      return record;
    });
  }
}

export class IntentStore extends StateStore {}

export class TokenStore {
  constructor(file, encryptionKey) {
    this.file = file;
    this.encryptionKey = encryptionKey;
    this.queue = Promise.resolve();
  }

  save(sellingPartnerId, tenantId, tokenResponse, metadata = {}) {
    const operation = async () => {
      const tokens = await readJson(this.file, {});
      const currentTenantId = tokens[sellingPartnerId]?.tenantId;
      if (currentTenantId && currentTenantId !== tenantId) {
        throw new ConflictError("selling partner is already connected");
      }
      tokens[sellingPartnerId] = {
        authorizedAt: new Date().toISOString(),
        refreshToken: encryptSecret(
          tokenResponse.refresh_token,
          this.encryptionKey,
          sellingPartnerId,
        ),
        tenantId,
        tokenType: tokenResponse.token_type || "bearer",
        ...(metadata.connected-accountAttemptId
          ? { connected-accountAttemptId: metadata.connected-accountAttemptId }
          : {}),
      };
      await writeJson(this.file, tokens);
    };
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  list(tenantId) {
    return this.run(async () => {
      const tokens = await readJson(this.file, {});
      return Object.entries(tokens)
        .filter(([, token]) => token.tenantId === tenantId)
        .map(([sellingPartnerId, token]) => ({
          authorizedAt: token.authorizedAt,
          sellingPartnerId,
        }))
        .sort((left, right) => left.sellingPartnerId.localeCompare(right.sellingPartnerId));
    });
  }

  disconnect(tenantId, sellingPartnerId) {
    return this.run(async () => {
      const tokens = await readJson(this.file, {});
      if (tokens[sellingPartnerId]?.tenantId !== tenantId) return false;
      delete tokens[sellingPartnerId];
      await writeJson(this.file, tokens);
      return true;
    });
  }

  findConnectedAccountCompletion(tenantId, attemptId) {
    return this.run(async () => {
      const tokens = await readJson(this.file, {});
      for (const [sellingPartnerId, token] of Object.entries(tokens)) {
        if (token.tenantId === tenantId && token.connected-accountAttemptId === attemptId) {
          return { authorizedAt: token.authorizedAt, sellingPartnerId };
        }
      }
      return null;
    });
  }

  run(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

export class PostgresTokenStore {
  constructor(databaseUrl, encryptionKey, pool) {
    if (!databaseUrl && !pool) throw new ConfigurationError("AMAZON_DATABASE_URL is required");
    parseEncryptionKey(encryptionKey);
    this.pool = pool || new Pool({ connectionString: databaseUrl, max: 10 });
    this.encryptionKey = encryptionKey;
  }

  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        SELECT pg_advisory_xact_lock(
          hashtext('amazon_sp_api'),
          hashtext('schema_migration')
        )
      `);
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS amazon_sp_api;
        CREATE TABLE IF NOT EXISTS amazon_sp_api.oauth_connection (
          selling_partner_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          authorized_at TIMESTAMPTZ NOT NULL,
          refresh_token JSONB,
          token_type TEXT NOT NULL,
          connected-account_attempt_id TEXT,
          credential_revision BIGINT NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE amazon_sp_api.oauth_connection
          ADD COLUMN IF NOT EXISTS credential_revision BIGINT NOT NULL DEFAULT 1;
        CREATE UNIQUE INDEX IF NOT EXISTS oauth_connection_connected-account_attempt_idx
          ON amazon_sp_api.oauth_connection (tenant_id, connected-account_attempt_id)
          WHERE connected-account_attempt_id IS NOT NULL AND status = 'active';
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async save(sellingPartnerId, tenantId, tokenResponse, metadata = {}) {
    const now = new Date();
    const result = await this.pool.query(`
      INSERT INTO amazon_sp_api.oauth_connection
        (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
         connected-account_attempt_id, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $3, $3)
      ON CONFLICT (selling_partner_id) DO UPDATE SET
        authorized_at = EXCLUDED.authorized_at,
        refresh_token = EXCLUDED.refresh_token,
        token_type = EXCLUDED.token_type,
        connected-account_attempt_id = EXCLUDED.connected-account_attempt_id,
        credential_revision = amazon_sp_api.oauth_connection.credential_revision + 1,
        status = 'active',
        updated_at = EXCLUDED.updated_at
      WHERE amazon_sp_api.oauth_connection.tenant_id = EXCLUDED.tenant_id
      RETURNING selling_partner_id
    `, [
      sellingPartnerId,
      tenantId,
      now,
      encryptSecret(tokenResponse.refresh_token, this.encryptionKey, sellingPartnerId),
      tokenResponse.token_type || "bearer",
      metadata.connected-accountAttemptId || null,
    ]);
    if (result.rowCount === 0) {
      throw new ConflictError("selling partner is already connected");
    }
  }

  async importEncryptedConnections(tokens) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [sellingPartnerId, token] of Object.entries(tokens)) {
        if (!token?.tenantId || !token?.refreshToken || !token?.authorizedAt) {
          throw new ConfigurationError("token file contains an invalid connection");
        }
        const result = await client.query(`
          INSERT INTO amazon_sp_api.oauth_connection
            (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
             connected-account_attempt_id, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'active', $3, $3)
          ON CONFLICT (selling_partner_id) DO UPDATE SET
            authorized_at = EXCLUDED.authorized_at,
            refresh_token = EXCLUDED.refresh_token,
            token_type = EXCLUDED.token_type,
            connected-account_attempt_id = EXCLUDED.connected-account_attempt_id,
            status = 'active',
            updated_at = EXCLUDED.updated_at
          WHERE amazon_sp_api.oauth_connection.tenant_id = EXCLUDED.tenant_id
          RETURNING selling_partner_id
        `, [
          sellingPartnerId,
          token.tenantId,
          token.authorizedAt,
          token.refreshToken,
          token.tokenType || "bearer",
          token.connected-accountAttemptId || null,
        ]);
        if (result.rowCount === 0) {
          throw new ConflictError("selling partner is already connected to another tenant");
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(tenantId) {
    const result = await this.pool.query(`
      SELECT selling_partner_id, authorized_at
      FROM amazon_sp_api.oauth_connection
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY selling_partner_id
    `, [tenantId]);
    return result.rows.map((row) => ({
      authorizedAt: new Date(row.authorized_at).toISOString(),
      sellingPartnerId: row.selling_partner_id,
    }));
  }

  async disconnect(tenantId, sellingPartnerId) {
    const result = await this.pool.query(`
      UPDATE amazon_sp_api.oauth_connection
      SET status = 'disconnected', refresh_token = NULL, connected-account_attempt_id = NULL,
          updated_at = NOW()
      WHERE tenant_id = $1 AND selling_partner_id = $2 AND status = 'active'
    `, [tenantId, sellingPartnerId]);
    return result.rowCount > 0;
  }

  async findConnectedAccountCompletion(tenantId, attemptId) {
    const result = await this.pool.query(`
      SELECT selling_partner_id, authorized_at
      FROM amazon_sp_api.oauth_connection
      WHERE tenant_id = $1 AND connected-account_attempt_id = $2 AND status = 'active'
    `, [tenantId, attemptId]);
    const row = result.rows[0];
    return row ? {
      authorizedAt: new Date(row.authorized_at).toISOString(),
      sellingPartnerId: row.selling_partner_id,
    } : null;
  }

  async checkHealth() {
    try {
      await this.pool.query("SELECT 1 FROM amazon_sp_api.oauth_connection LIMIT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }
}

export async function exchangeAuthorizationCode({ code, config, fetchImpl = fetch }) {
  if (!config.clientId || !config.clientSecret) {
    throw new ConfigurationError("Amazon LWA credentials are not configured");
  }

  const response = await fetchImpl("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new UpstreamError(`LWA token exchange failed with status ${response.status}`);
  }
  const body = await response.json();
  if (!body.refresh_token) {
    throw new UpstreamError("LWA response did not include a refresh token");
  }
  return body;
}

class InputError extends Error {}
class ConfigurationError extends Error {}
class ConflictError extends Error {}
class UpstreamError extends Error {}

function sendJson(response, status, body) {
  response.writeHead(status, {
    ...DEFAULT_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendSuccess(response) {
  response.writeHead(200, {
    ...DEFAULT_HEADERS,
    "content-type": "text/html; charset=utf-8",
  });
  response.end(
    "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Amazon 授权完成</title><body><h1>Amazon 授权已完成</h1><p>可以关闭此页面并返回旧实现。</p></body></html>",
  );
}

function sendConnectedAccountSuccess(response, attemptId, targetOrigin) {
  const nonce = randomBytes(18).toString("base64");
  const message = JSON.stringify({
    type: "connected-account:connected-account-authorization",
    attemptId,
    status: "active",
  }).replaceAll("<", "\\u003c");
  const origin = JSON.stringify(targetOrigin).replaceAll("<", "\\u003c");
  response.writeHead(200, {
    ...DEFAULT_HEADERS,
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    "content-type": "text/html; charset=utf-8",
  });
  response.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Amazon 授权完成</title><body><h1>Amazon 授权已完成</h1><p>可以关闭此页面并返回 ConnectedAccount。</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${message},${origin})}</script></body></html>`,
  );
}

function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, { ...DEFAULT_HEADERS, ...headers, location });
  response.end();
}

function isValidInternalSecret(request, expected) {
  if (!expected) return false;
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) throw new InputError("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("request body is invalid");
  }
}

function validateTenantId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:@-]{1,512}$/.test(value)) {
    throw new InputError("tenant_id is invalid");
  }
  return value;
}

function validateConnectedAccountAttemptId(value) {
  if (typeof value !== "string" || !/^att_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new InputError("connected-account_attempt_id is invalid");
  }
  return value;
}

function validateOrigin(value) {
  let origin;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) throw new Error("invalid origin");
    origin = url.origin;
  } catch {
    throw new InputError("connected-account_origin is invalid");
  }
  return origin;
}

function validateConnectedAccountOrigin(value, allowedOrigins) {
  const origin = validateOrigin(value);
  if (!allowedOrigins.includes(origin)) {
    throw new InputError("connected-account_origin is not allowed");
  }
  return origin;
}

function sellerAuthorizationURL(config, intentId) {
  if (!config.applicationId || !config.authorizationUri) {
    throw new ConfigurationError("Amazon authorization entry is not configured");
  }
  const url = new URL(config.authorizationUri);
  url.searchParams.set("application_id", config.applicationId);
  url.searchParams.set("state", intentId);
  if (config.applicationVersion) url.searchParams.set("version", config.applicationVersion);
  return url.toString();
}

function authorizationStartURL(config, intentId) {
  const start = new URL("/oauth/amazon/start", config.publicOrigin);
  start.searchParams.set("intent", intentId);
  return start.toString();
}

function sellerApplicationsURL(config) {
  if (!config.authorizationUri) {
    throw new ConfigurationError("Amazon authorization entry is not configured");
  }
  return new URL("/apps/manage", config.authorizationUri).toString();
}

function requestCookie(request, name) {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function intentCookie(value, maxAge = 600) {
  return `${AMAZON_INTENT_COOKIE}=${encodeURIComponent(value)}; Path=/oauth/amazon; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function buildConfig(env = process.env) {
  const dataDir = env.AMAZON_DATA_DIR || "/var/lib/amazon-oauth-service";
  const redirectUri =
    env.AMAZON_OAUTH_REDIRECT_URI ||
    "https://api.example.com/oauth/amazon/callback";
  const publicOrigin = env.AMAZON_PUBLIC_ORIGIN || "https://api.example.com";
  return {
    clientId: env.AMAZON_LWA_CLIENT_ID || "",
    clientSecret: env.AMAZON_LWA_CLIENT_SECRET || "",
    dataDir,
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8788),
    publicOrigin,
    redirectUri,
    successRedirectUri: env.AMAZON_SUCCESS_REDIRECT_URI || "",
    internalSecret: env.AMAZON_INTERNAL_SECRET || "",
    applicationId: env.AMAZON_APPLICATION_ID || "",
    authorizationUri:
      env.AMAZON_AUTHORIZATION_URI ||
      "https://sellercentral-europe.amazon.com/apps/authorize/consent",
    applicationVersion: env.AMAZON_APPLICATION_VERSION || "beta",
    tokenEncryptionKey: env.AMAZON_TOKEN_ENCRYPTION_KEY || "",
    databaseUrl: env.AMAZON_DATABASE_URL || "",
    redisUrl: env.AMAZON_REDIS_URL || "",
    redisNamespace: env.AMAZON_REDIS_NAMESPACE || "amazon-sp-api",
    connected-accountAllowedOrigins: (env.CONNECTED_ACCOUNT_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map(validateOrigin),
  };
}

export function createAmazonOAuthServer(options = {}) {
  const config = options.config || buildConfig();
  if (Boolean(config.databaseUrl) !== Boolean(config.redisUrl)) {
    throw new ConfigurationError(
      "AMAZON_DATABASE_URL and AMAZON_REDIS_URL must be configured together",
    );
  }
  const stateStore =
    options.stateStore || (config.redisUrl
      ? new RedisStateStore({
        redisUrl: config.redisUrl,
        namespace: `${config.redisNamespace}:oauth-state`,
      })
      : new StateStore(resolve(config.dataDir, "states.json")));
  const intentStore =
    options.intentStore || (config.redisUrl
      ? new RedisStateStore({
        redisUrl: config.redisUrl,
        namespace: `${config.redisNamespace}:oauth-intent`,
      })
      : new IntentStore(resolve(config.dataDir, "intents.json")));
  const tokenStore =
    options.tokenStore ||
    (config.databaseUrl
      ? new PostgresTokenStore(config.databaseUrl, config.tokenEncryptionKey)
      : new TokenStore(resolve(config.dataDir, "tokens.json"), config.tokenEncryptionKey));
  const exchangeCode = options.exchangeCode || exchangeAuthorizationCode;
  const storageReady = Promise.all([
    tokenStore.initialize?.(),
    stateStore.initialize?.(),
    intentStore.initialize?.(),
  ]).then(() => undefined);

  const server = createServer(async (request, response) => {
    try {
      await storageReady;
      const url = new URL(request.url, config.publicOrigin);

      if (request.method === "GET" && url.pathname === "/healthz") {
        const database = config.databaseUrl ? await tokenStore.checkHealth() : undefined;
        const redis = config.redisUrl
          ? await Promise.all([stateStore.checkHealth(), intentStore.checkHealth()])
            .then((checks) => checks.every(Boolean))
          : undefined;
        const ready = database !== false && redis !== false;
        return sendJson(response, ready ? 200 : 503, {
          ...(database === undefined ? {} : { database }),
          ...(redis === undefined ? {} : { redis }),
          lwaConfigured: Boolean(config.clientId && config.clientSecret),
          status: ready ? "ok" : "not_ready",
        });
      }

      if (request.method === "GET" && url.pathname === "/oauth/amazon/login") {
        const callbackUri = validateAmazonCallbackUri(
          requiredParam(url.searchParams, "amazon_callback_uri"),
        );
        const amazonState = requiredParam(url.searchParams, "amazon_state", 2048);
        const sellingPartnerId = validateSellingPartnerId(
          requiredParam(url.searchParams, "selling_partner_id", 128),
        );
        const version = url.searchParams.get("version");
        if (version && version !== "beta") {
          throw new InputError("version is invalid");
        }

        const intent = await intentStore.consume(
          requestCookie(request, AMAZON_INTENT_COOKIE),
        );
        if (!intent) {
          throw new InputError("authorization intent is invalid or expired");
        }
        const state = await stateStore.create({
          connected-accountAttemptId: intent.connected-accountAttemptId,
          connected-accountOrigin: intent.connected-accountOrigin,
          sellingPartnerId,
          tenantId: intent.tenantId,
        });
        callbackUri.searchParams.set("amazon_state", amazonState);
        callbackUri.searchParams.set("state", state);
        callbackUri.searchParams.set("redirect_uri", config.redirectUri);
        if (version) callbackUri.searchParams.set("version", version);
        return sendRedirect(response, callbackUri.toString(), {
          "set-cookie": intentCookie("", 0),
        });
      }

      if (request.method === "GET" && url.pathname === "/oauth/amazon/start") {
        const intentId = requiredParam(url.searchParams, "intent", 256);
        if (!(await intentStore.get(intentId))) {
          throw new InputError("authorization intent is invalid or expired");
        }
        return sendRedirect(response, sellerAuthorizationURL(config, intentId), {
          "set-cookie": intentCookie(intentId),
        });
      }

      if (request.method === "GET" && url.pathname === "/oauth/amazon/renew") {
        const intentId = requiredParam(url.searchParams, "intent", 256);
        if (!(await intentStore.get(intentId))) {
          throw new InputError("authorization intent is invalid or expired");
        }
        return sendRedirect(response, sellerApplicationsURL(config), {
          "set-cookie": intentCookie(intentId),
        });
      }

      if (request.method === "GET" && url.pathname === "/oauth/amazon/callback") {
        const state = requiredParam(url.searchParams, "state", 256);
        const sellingPartnerId = validateSellingPartnerId(
          requiredParam(url.searchParams, "selling_partner_id", 128),
        );
        const code = requiredParam(url.searchParams, "spapi_oauth_code", 4096);
        let stateRecord = await stateStore.consume(
          state,
          (record) => record.sellingPartnerId === sellingPartnerId,
        );
        if (!stateRecord) {
          stateRecord = await intentStore.consume(state);
        }
        if (!stateRecord) {
          throw new InputError("state is invalid or expired");
        }

        const tokenResponse = await exchangeCode({ code, config });
        await tokenStore.save(sellingPartnerId, stateRecord.tenantId, tokenResponse, {
          connected-accountAttemptId: stateRecord.connected-accountAttemptId,
        });
        if (stateRecord.connected-accountAttemptId) {
          return sendConnectedAccountSuccess(
            response,
            stateRecord.connected-accountAttemptId,
            stateRecord.connected-accountOrigin,
          );
        }
        if (config.successRedirectUri) {
          return sendRedirect(response, config.successRedirectUri);
        }
        return sendSuccess(response);
      }

      if (url.pathname.startsWith("/internal/amazon/")) {
        if (!isValidInternalSecret(request, config.internalSecret)) {
          return sendJson(response, 401, { error: "unauthorized" });
        }

        if (request.method === "POST" && url.pathname === "/internal/amazon/intents") {
          const body = await readJsonBody(request);
          const tenantId = validateTenantId(body.tenant_id);
          const connected-accountAttemptId = body.connected-account_attempt_id === undefined
            ? undefined
            : validateConnectedAccountAttemptId(body.connected-account_attempt_id);
          const connected-accountOrigin = connected-accountAttemptId
            ? validateConnectedAccountOrigin(body.connected-account_origin, config.connected-accountAllowedOrigins || [])
            : undefined;
          if (!connected-accountAttemptId && body.connected-account_origin !== undefined) {
            throw new InputError("connected-account_attempt_id is required with connected-account_origin");
          }
          const intentId = await intentStore.create({
            tenantId,
            ...(connected-accountAttemptId ? { connected-accountAttemptId, connected-accountOrigin } : {}),
          });
          return sendJson(response, 201, {
            authorization_url: authorizationStartURL(config, intentId),
            intent_id: intentId,
          });
        }

        if (request.method === "POST" && url.pathname === "/internal/amazon/login") {
          const body = await readJsonBody(request);
          const tenantId = validateTenantId(body.tenant_id);
          const callbackUri = validateAmazonCallbackUri(body.amazon_callback_uri);
          const amazonState = requiredBodyValue(body, "amazon_state", 2048);
          const sellingPartnerId = validateSellingPartnerId(
            requiredBodyValue(body, "selling_partner_id", 128),
          );
          if (body.version && body.version !== "beta") {
            throw new InputError("version is invalid");
          }
          const consumedIntent = await intentStore.consume(
            body.intent_id,
            (intent) => intent.tenantId === tenantId,
          );
          if (!consumedIntent) {
            throw new InputError("intent is invalid or expired");
          }
          const state = await stateStore.create({
            connected-accountAttemptId: consumedIntent.connected-accountAttemptId,
            connected-accountOrigin: consumedIntent.connected-accountOrigin,
            sellingPartnerId,
            tenantId,
          });
          callbackUri.searchParams.set("amazon_state", amazonState);
          callbackUri.searchParams.set("state", state);
          callbackUri.searchParams.set("redirect_uri", config.redirectUri);
          if (body.version) callbackUri.searchParams.set("version", body.version);
          return sendJson(response, 200, { redirect_url: callbackUri.toString() });
        }

        if (request.method === "GET" && url.pathname === "/internal/amazon/connections") {
          const tenantId = validateTenantId(url.searchParams.get("tenant_id"));
          return sendJson(response, 200, { connections: await tokenStore.list(tenantId) });
        }

        const completionMatch = url.pathname.match(
          /^\/internal\/amazon\/connected-account-completions\/([^/]+)$/,
        );
        if (request.method === "GET" && completionMatch) {
          const tenantId = validateTenantId(url.searchParams.get("tenant_id"));
          const attemptId = validateConnectedAccountAttemptId(decodeURIComponent(completionMatch[1]));
          const completion = await tokenStore.findConnectedAccountCompletion(tenantId, attemptId);
          if (!completion) return sendJson(response, 404, { error: "not_found" });
          return sendJson(response, 200, completion);
        }

        const disconnectMatch = url.pathname.match(/^\/internal\/amazon\/connections\/([^/]+)$/);
        if (request.method === "DELETE" && disconnectMatch) {
          const tenantId = validateTenantId(url.searchParams.get("tenant_id"));
          const sellingPartnerId = validateSellingPartnerId(decodeURIComponent(disconnectMatch[1]));
          const disconnected = await tokenStore.disconnect(tenantId, sellingPartnerId);
          if (!disconnected) return sendJson(response, 404, { error: "not_found" });
          return sendJson(response, 200, { disconnected: true });
        }

        return sendJson(response, 404, { error: "not_found" });
      }

      if (!["GET", "POST", "DELETE"].includes(request.method)) {
        return sendJson(response, 405, { error: "method_not_allowed" });
      }
      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof InputError) {
        return sendJson(response, 400, { error: error.message });
      }
      if (error instanceof ConfigurationError) {
        return sendJson(response, 503, { error: "service_not_configured" });
      }
      if (error instanceof ConflictError) {
        return sendJson(response, 409, { error: "connection_conflict" });
      }
      if (error instanceof UpstreamError) {
        console.error(`[amazon-oauth] ${error.message}`);
        return sendJson(response, 502, { error: "amazon_token_exchange_failed" });
      }
      console.error("[amazon-oauth] unexpected request failure");
      return sendJson(response, 500, { error: "internal_error" });
    }
  });
  server.storageReady = storageReady;
  server.tokenStore = tokenStore;
  server.stateStore = stateStore;
  server.intentStore = intentStore;
  return server;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const config = buildConfig();
  const server = createAmazonOAuthServer({ config });
  await server.storageReady;
  server.listen(config.port, config.host, () => {
    console.log(`[amazon-oauth] listening on ${config.host}:${config.port}`);
  });
}
