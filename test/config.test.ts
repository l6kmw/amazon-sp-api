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
    ["limits: { requestsPerMinute: 10 }", /does not apply local request or concurrency limits/],
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

test("loads file-backed storage without any database service", async () => {
  const config = await loadConfig(await configFile(validYaml));
  assert.equal(config.dataDirectory, "/data");
  assert.equal(config.tokenStoreFile, "/data/tokens.json");
  assert.equal(config.stateStoreFile, "/data/states.json");
  assert.equal(config.intentStoreFile, "/data/intents.json");
  assert.ok(config.connectedAccountDatabaseFile.startsWith("/data/"));
});
