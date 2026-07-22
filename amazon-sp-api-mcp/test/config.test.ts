import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRuntimeConfig } from "../src/config.js";

const validEnv = {
  MCP_AUTH_TOKEN: "m".repeat(32),
  AMAZON_ALLOWED_SELLING_PARTNER_IDS: "A1SELLER",
  AMAZON_LWA_CLIENT_ID: "client-id",
  AMAZON_LWA_CLIENT_SECRET: "client-secret",
  AMAZON_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  AMAZON_INTERNAL_SECRET: "internal-secret",
};

test("builds a fail-closed runtime configuration", () => {
  const config = buildRuntimeConfig(validEnv);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8789);
  assert.deepEqual(config.allowedSellingPartnerIds, ["A1SELLER"]);
  assert.equal(config.identityValidationURL, "http://127.0.0.1:8080/api/v1/admin/session");
  assert.equal(config.identityHealthURL, "http://127.0.0.1:8080/healthz");
  assert.equal(config.oauthInternalURL, "http://127.0.0.1:8788");
  assert.equal(config.tenantRequestsPerMinute, 120);
  assert.equal(config.tenantMaxConcurrentRequests, 8);
  assert.equal(config.allowLegacyAuth, false);
  assert.equal(config.legacyTenantId, undefined);
  assert.equal(config.enableListingsTools, false);
  assert.equal(config.connected-accountEnabled, false);
  assert.equal(config.connected-accountJwtAudience, undefined);
  assert.deepEqual(config.connected-accountJwtKeys, []);
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.redisUrl, undefined);
  assert.equal(config.redisNamespace, "amazon-sp-api");
  assert.equal(config.connected-accountDatabaseFile, "/var/lib/amazon-sp-api-mcp/connected-account.sqlite");
  assert.deepEqual(config.connected-accountAllowedOrigins, []);
  assert.equal(
    buildRuntimeConfig({ ...validEnv, AMAZON_ENABLE_LISTINGS_TOOLS: "true" }).enableListingsTools,
    true,
  );
  assert.equal(buildRuntimeConfig({ ...validEnv, MCP_AUTH_TOKEN: undefined }).mcpAuthToken, undefined);
  assert.equal(
    buildRuntimeConfig({
      ...validEnv,
      LEGACY_IDENTITY_VALIDATION_URL: "http://127.0.0.1:9080/custom/session",
    }).identityHealthURL,
    "http://127.0.0.1:9080/healthz",
  );
  assert.equal(
    buildRuntimeConfig({
      ...validEnv,
      LEGACY_IDENTITY_HEALTH_URL: "http://127.0.0.1:9080/custom-health",
    }).identityHealthURL,
    "http://127.0.0.1:9080/custom-health",
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, MCP_ALLOW_LEGACY_AUTH: "true", MCP_AUTH_TOKEN: "short" }),
    /32 bytes/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, AMAZON_ALLOWED_SELLING_PARTNER_IDS: "" }),
    /required/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, AMAZON_ALLOWED_SELLING_PARTNER_IDS: "invalid id" }),
    /invalid ID/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, AMAZON_INTERNAL_SECRET: "" }),
    /AMAZON_INTERNAL_SECRET/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, MCP_TENANT_REQUESTS_PER_MINUTE: "0" }),
    /positive integer/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, MCP_TENANT_MAX_CONCURRENT_REQUESTS: "1.5" }),
    /positive integer/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, MCP_ALLOW_LEGACY_AUTH: "yes" }),
    /MCP_ALLOW_LEGACY_AUTH/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, AMAZON_ENABLE_LISTINGS_TOOLS: "yes" }),
    /AMAZON_ENABLE_LISTINGS_TOOLS/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, MCP_ALLOW_LEGACY_AUTH: "true", MCP_AUTH_TOKEN: undefined }),
    /MCP_AUTH_TOKEN/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, MCP_LEGACY_TENANT_ID: "invalid tenant" }),
    /MCP_LEGACY_TENANT_ID/,
  );

  const connected-account = buildRuntimeConfig({
    ...validEnv,
    CONNECTED_ACCOUNT_ENABLED: "true",
    AMAZON_DATABASE_URL: "postgresql://amazon@127.0.0.1/amazon",
    AMAZON_REDIS_URL: "redis://127.0.0.1:6379",
    CONNECTED_ACCOUNT_JWT_AUDIENCE: "amazon-sp-api-account-service",
    CONNECTED_ACCOUNT_ALLOWED_ORIGINS: "https://app.connected-account.example",
    CONNECTED_ACCOUNT_JWT_KEYS: JSON.stringify({
      "provider-v1": { issuer: "example-issuer-prod", secret: "s".repeat(32) },
    }),
  });
  assert.equal(connected-account.connected-accountEnabled, true);
  assert.equal(connected-account.connected-accountJwtAudience, "amazon-sp-api-account-service");
  assert.deepEqual(connected-account.connected-accountJwtKeys, [{
    kid: "provider-v1",
    issuer: "example-issuer-prod",
    secret: "s".repeat(32),
  }]);
  assert.deepEqual(connected-account.connected-accountAllowedOrigins, ["https://app.connected-account.example"]);
  assert.equal(connected-account.databaseUrl, "postgresql://amazon@127.0.0.1/amazon");
  assert.equal(connected-account.redisUrl, "redis://127.0.0.1:6379");
  assert.throws(
    () => buildRuntimeConfig({
      ...validEnv,
      CONNECTED_ACCOUNT_ENABLED: "true",
      CONNECTED_ACCOUNT_JWT_AUDIENCE: "audience",
      CONNECTED_ACCOUNT_ALLOWED_ORIGINS: "https://app.connected-account.example",
      CONNECTED_ACCOUNT_JWT_KEYS: JSON.stringify({
        key: { issuer: "example-issuer-prod", secret: "s".repeat(32) },
      }),
    }),
    /AMAZON_DATABASE_URL/,
  );
  assert.throws(
    () => buildRuntimeConfig({
      ...validEnv,
      CONNECTED_ACCOUNT_ENABLED: "true",
      AMAZON_DATABASE_URL: "postgresql://amazon@127.0.0.1/amazon",
      CONNECTED_ACCOUNT_JWT_AUDIENCE: "audience",
      CONNECTED_ACCOUNT_ALLOWED_ORIGINS: "https://app.connected-account.example",
      CONNECTED_ACCOUNT_JWT_KEYS: JSON.stringify({
        key: { issuer: "example-issuer-prod", secret: "s".repeat(32) },
      }),
    }),
    /AMAZON_REDIS_URL/,
  );
  assert.throws(
    () => buildRuntimeConfig({ ...validEnv, CONNECTED_ACCOUNT_ENABLED: "true" }),
    /CONNECTED_ACCOUNT_JWT_AUDIENCE/,
  );
  assert.throws(
    () => buildRuntimeConfig({
      ...validEnv,
      CONNECTED_ACCOUNT_ENABLED: "true",
      CONNECTED_ACCOUNT_JWT_AUDIENCE: "audience",
      CONNECTED_ACCOUNT_ALLOWED_ORIGINS: "https://app.connected-account.example",
      CONNECTED_ACCOUNT_JWT_KEYS: "not-json",
    }),
    /JSON object/,
  );
  assert.throws(
    () => buildRuntimeConfig({
      ...validEnv,
      CONNECTED_ACCOUNT_ENABLED: "true",
      CONNECTED_ACCOUNT_JWT_AUDIENCE: "audience",
      CONNECTED_ACCOUNT_ALLOWED_ORIGINS: "https://app.connected-account.example",
      CONNECTED_ACCOUNT_JWT_KEYS: JSON.stringify({ key: { issuer: "example-issuer-prod", secret: "short" } }),
    }),
    /32 bytes/,
  );
  assert.throws(
    () => buildRuntimeConfig({
      ...validEnv,
      CONNECTED_ACCOUNT_ENABLED: "true",
      CONNECTED_ACCOUNT_JWT_AUDIENCE: "audience",
      CONNECTED_ACCOUNT_JWT_KEYS: JSON.stringify({
        key: { issuer: "example-issuer-prod", secret: "s".repeat(32) },
      }),
      CONNECTED_ACCOUNT_ALLOWED_ORIGINS: "https://app.connected-account.example/path",
    }),
    /CONNECTED_ACCOUNT_ALLOWED_ORIGINS/,
  );
});
