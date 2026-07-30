import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { loadConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function configFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amazon-config-"));
  directories.push(directory);
  const file = join(directory, "config.yaml");
  await writeFile(file, content, { mode: 0o600 });
  return file;
}

const key = randomBytes(32).toString("base64");
const validYaml = `
server:
  host: 0.0.0.0
  allowedHosts: [api.example.com, localhost]
amazon:
  publicOrigin: https://api.example.com
  applicationId: amzn1.sp.solution.example
  authorizationUri: https://sellercentral-europe.amazon.com/apps/authorize/consent
  applicationVersion: beta
  lwa:
    clientId: client-id
    clientSecret: client-secret
  credentialKeys:
    currentKeyId: k0
    keys:
      - keyId: k0
        secret: ${key}
  allowedSellingPartnerIds: [A1SELLER]
storage:
  dataDirectory: /data
connected-account:
  enabled: false
`;

test("loads v2 without an mcp section or external identity URL", async () => {
  const config = await loadConfig(await configFile(validYaml));
  assert.equal(config.redirectUri, "https://api.example.com/oauth/amazon/callback");
  assert.equal(config.tokenStoreFile, "/data/tokens.json");
  assert.equal(config.credentialKeyring.keys.k0, key);
  for (const removed of [
    "enableListingsTools", "identityValidationURL", "identityHealthURL",
    "tenantRequestsPerMinute", "tenantMaxConcurrentRequests",
    "connectionCacheTtlMs", "regionCacheTtlMs",
  ]) assert.equal(removed in config, false, removed);
});

test("rejects every removed mcp field with a targeted migration hint", async () => {
  const cases: Array<[string, RegExp]> = [
    ["identityValidationUrl: http://host.docker.internal:8080/api/v1/admin/session", /verifies ConnectedAccount JWTs locally/],
    ["identityHealthUrl: http://host.docker.internal:8080/healthz", /readiness no longer calls/],
    ["enableListingsTools: false", /Listings tools are always enabled/],
    ["limits: { requestsPerMinute: 10 }", /fixed at 120 requests\/minute and 8 concurrent/],
    ["cache: { connectionTtlMs: 1 }", /cache TTLs are fixed/],
    ["allowLegacyAuth: true", /only ConnectedAccount Employee JWTs/],
    ["legacyAuthToken: old", /shared bearer tokens are not supported/],
    ["legacyTenantId: old", /ConnectedAccount account_id/],
  ];
  for (const [field, message] of cases) {
    await assert.rejects(loadConfig(await configFile(`${validYaml}\nmcp:\n  ${field}\n`)), message);
  }
});

test("rejects old single-service fields, unknown fields and unsafe permissions", async () => {
  await assert.rejects(
    loadConfig(await configFile(validYaml.replace("  host: 0.0.0.0", "  host: 0.0.0.0\n  port: 8789"))),
    /server\.port has been removed/,
  );
  await assert.rejects(
    loadConfig(await configFile(validYaml.replace("  applicationVersion: beta", "  applicationVersion: beta\n  unknown: value"))),
    /amazon\.unknown/,
  );
  await assert.rejects(
    loadConfig(await configFile(validYaml.replace("  publicOrigin: https://api.example.com", "  publicOrigin: https://api.example.com\n  oauthRedirectUri: https://api.example.com/oauth/amazon/callback"))),
    /oauthRedirectUri has been removed/,
  );
  const file = await configFile(validYaml);
  await chmod(file, 0o644);
  await assert.rejects(loadConfig(file), /config permissions/);
});

test("loads PostgreSQL, Redis and local ConnectedAccount JWT verification", async () => {
  const jwt = randomBytes(32).toString("base64");
  const yaml = validYaml
    .replace("storage:\n  dataDirectory: /data", `storage:
  dataDirectory: /data
  postgres:
    url: postgresql://amazon:redacted@127.0.0.1:5432/amazon
    pool: { min: 0, max: 12, idleTimeoutMs: 12000 }
  redis:
    url: redis://127.0.0.1:6379/0
    namespace: amazon-sp-api`)
    .replace("connected-account:\n  enabled: false", `connected-account:
  enabled: true
  audience: amazon-sp-api-account-service
  allowedOrigins: [https://app.connected-account.example]
  jwtKeys:
    - kid: provider-v1
      issuer: https://connected-account.example
      secret: ${jwt}`);
  const config = await loadConfig(await configFile(yaml));
  assert.equal(config.connected-accountEnabled, true);
  assert.equal(config.connected-accountJwtKeys[0]?.kid, "provider-v1");
  assert.equal(config.postgresPool.max, 12);
  assert.equal(config.redisNamespace, "amazon-sp-api");
});

test("loads the admin session key only from a private file with PostgreSQL", async () => {
  const sessionKey = randomBytes(32).toString("base64");
  const initial = await configFile(validYaml);
  const secretFile = join(dirname(initial), "admin-session.key");
  await writeFile(secretFile, sessionKey, { mode: 0o600 });
  const yaml = validYaml
    .replace("storage:\n  dataDirectory: /data", `storage:
  dataDirectory: /data
  postgres:
    url: postgresql://amazon:redacted@127.0.0.1:5432/amazon`)
    + `admin:\n  sessionSecretFile: ${secretFile}\n`;
  const file = await configFile(yaml);
  assert.equal((await loadConfig(file)).adminSessionSecret, sessionKey);

  await chmod(secretFile, 0o644);
  await assert.rejects(loadConfig(file), /admin\.sessionSecretFile.*0600 or stricter/);
  await assert.rejects(
    loadConfig(await configFile(`${validYaml}admin:\n  sessionSecretFile: ${secretFile}\n`)),
    /admin requires storage\.postgres/,
  );
});

test("requires PostgreSQL and Redis when ConnectedAccount is enabled", async () => {
  const incomplete = validYaml.replace("enabled: false", `enabled: true
  audience: amazon-sp-api-account-service
  allowedOrigins: [https://app.connected-account.example]
  jwtKeys:
    - kid: provider-v1
      issuer: https://connected-account.example
      secret: ${randomBytes(32).toString("base64")}`);
  await assert.rejects(loadConfig(await configFile(incomplete)), /requires storage\.postgres and storage\.redis/);
});
