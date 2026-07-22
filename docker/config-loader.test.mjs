import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadDockerConfig } from "./config-loader.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function configFile(content) {
  const directory = await mkdtemp(join(tmpdir(), "amazon-docker-config-"));
  directories.push(directory);
  const file = join(directory, "config.yaml");
  await writeFile(file, content, { mode: 0o600 });
  return file;
}

const goodKey = randomBytes(32).toString("base64");
const goodInternal = `internal-${randomBytes(24).toString("hex")}`;

const validYaml = `
server:
  oauth:
    host: 0.0.0.0
    port: 8788
  mcp:
    host: 0.0.0.0
    port: 8789
    allowedHosts: [api.example.com, localhost]
amazon:
  publicOrigin: https://api.example.com
  oauthRedirectUri: https://api.example.com/oauth/amazon/callback
  applicationId: amzn1.sp.solution.example
  authorizationUri: https://sellercentral-europe.amazon.com/apps/authorize/consent
  applicationVersion: beta
  lwa:
    clientId: client-id
    clientSecret: client-secret
  tokenEncryptionKey: ${goodKey}
  allowedSellingPartnerIds: [A1SELLER]
oauth:
  internalSecret: ${goodInternal}
  dataDirectory: /data
mcp:
  allowLegacyAuth: false
  enableListingsTools: true
  identityValidationUrl: http://host.docker.internal:8080/api/v1/admin/session
  limits:
    requestsPerMinute: 120
    maxConcurrentRequests: 8
  cache:
    connectionTtlMs: 30000
    regionTtlMs: 86400000
`;

test("rejects a configuration file readable by group or other users", async () => {
  const file = await configFile(validYaml);
  await chmod(file, 0o644);
  await assert.rejects(loadDockerConfig(file), /config permissions/);
});

test("loads strict YAML into isolated OAuth and MCP environments", async () => {
  const result = await loadDockerConfig(await configFile(validYaml));
  assert.equal(result.dataDirectory, "/data");
  assert.equal(result.tokenStoreFile, "/data/tokens.json");
  assert.equal(result.oauthEnv.HOST, "0.0.0.0");
  assert.equal(result.oauthEnv.PORT, "8788");
  assert.equal(result.oauthEnv.AMAZON_DATA_DIR, "/data");
  assert.equal(result.mcpEnv.HOST, "0.0.0.0");
  assert.equal(result.mcpEnv.PORT, "8789");
  assert.equal(result.mcpEnv.AMAZON_OAUTH_INTERNAL_URL, "http://127.0.0.1:8788");
  assert.equal(result.mcpEnv.AMAZON_TOKEN_STORE_FILE, "/data/tokens.json");
  assert.equal(
    result.mcpEnv.AMAZON_AUTHORIZATION_URI,
    "https://sellercentral-europe.amazon.com/apps/authorize/consent",
  );
  assert.equal(result.mcpEnv.AMAZON_ENABLE_LISTINGS_TOOLS, "true");
  assert.equal(result.mcpEnv.MCP_ALLOWED_HOSTS, "api.example.com,localhost");
  assert.equal(result.mcpEnv.MCP_ALLOW_LEGACY_AUTH, "false");
  assert.equal(result.mcpEnv.CONNECTED_ACCOUNT_ENABLED, "false");
  assert.equal(result.mcpEnv.AMAZON_TOKEN_ENCRYPTION_CURRENT_KEY_ID, "k0");
  assert.equal(result.connected-accountEnabled, false);
  assert.equal(result.productionStorage, false);
});

test("loads production storage, credential keyring, and connected-account settings", async () => {
  const jwtSecret = randomBytes(32).toString("base64");
  const k0 = randomBytes(32).toString("base64");
  const k1 = randomBytes(32).toString("base64");
  const yaml = `
server:
  oauth:
    host: 0.0.0.0
    port: 8788
  mcp:
    host: 0.0.0.0
    port: 8789
    allowedHosts: [api.example.com]
amazon:
  publicOrigin: https://api.example.com
  oauthRedirectUri: https://api.example.com/oauth/amazon/callback
  applicationId: amzn1.sp.solution.example
  authorizationUri: https://sellercentral-europe.amazon.com/apps/authorize/consent
  applicationVersion: beta
  lwa:
    clientId: client-id
    clientSecret: client-secret
  credentialKeys:
    currentKeyId: k1
    keys:
      - keyId: k0
        secret: ${k0}
      - keyId: k1
        secret: ${k1}
  allowedSellingPartnerIds: [A1SELLER]
oauth:
  internalSecret: ${goodInternal}
  dataDirectory: /data
mcp:
  allowLegacyAuth: false
  enableListingsTools: false
  identityValidationUrl: https://identity.example.com/session
  identityHealthUrl: https://identity.example.com/healthz
storage:
  postgres:
    url: postgresql://amazon:redacted@host.docker.internal:5432/amazon
    schema: amazon_sp_api
    pool:
      min: 0
      max: 10
      idleTimeoutMs: 10000
  redis:
    url: redis://host.docker.internal:6379/0
    namespace: amazon-sp-api
connected-account:
  enabled: true
  audience: amazon-sp-api-account-service
  allowedOrigins:
    - https://app.connected-account.example
  jwtKeys:
    - kid: provider-v1
      issuer: https://connected-account.example
      secret: ${jwtSecret}
`;
  const result = await loadDockerConfig(await configFile(yaml));
  assert.equal(result.connected-accountEnabled, true);
  assert.equal(result.productionStorage, true);
  assert.equal(result.mcpEnv.CONNECTED_ACCOUNT_ENABLED, "true");
  assert.equal(result.mcpEnv.CONNECTED_ACCOUNT_JWT_AUDIENCE, "amazon-sp-api-account-service");
  assert.equal(result.mcpEnv.AMAZON_TOKEN_ENCRYPTION_CURRENT_KEY_ID, "k1");
  assert.equal(result.mcpEnv.AMAZON_DATABASE_URL, "postgresql://amazon:redacted@host.docker.internal:5432/amazon");
  assert.equal(result.oauthEnv.AMAZON_REDIS_NAMESPACE, "amazon-sp-api");
  assert.equal(result.mcpEnv.LEGACY_IDENTITY_HEALTH_URL, "https://identity.example.com/healthz");
  assert.match(result.mcpEnv.CONNECTED_ACCOUNT_JWT_KEYS, /provider-v1/);
  assert.doesNotMatch(JSON.stringify(result.mcpEnv.CONNECTED_ACCOUNT_JWT_KEYS), /\n/);
});

test("rejects unknown keys and unsafe or incomplete secrets without echoing values", async () => {
  for (const yaml of [
    validYaml.replace("  applicationVersion: beta\n", "  applicationVersion: beta\n  unexpected: secret-value\n"),
    validYaml.replace(goodInternal, "short"),
    validYaml.replace(goodKey, "not-a-key"),
    validYaml.replace("  allowedSellingPartnerIds: [A1SELLER]\n", "  allowedSellingPartnerIds: []\n"),
    validYaml.replace(goodKey, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  ]) {
    const file = await configFile(yaml);
    await assert.rejects(
      loadDockerConfig(file),
      (error) => {
        assert.doesNotMatch(String(error), /secret-value|client-secret|not-a-key|AAAA/);
        return true;
      },
    );
  }
});

test("requires fixed internal container ports", async () => {
  const wrongOAuthPort = validYaml.replace("    port: 8788", "    port: 8888");
  await assert.rejects(loadDockerConfig(await configFile(wrongOAuthPort)), /server.oauth.port/);
  const wrongMcpPort = validYaml.replace("    port: 8789", "    port: 8889");
  await assert.rejects(loadDockerConfig(await configFile(wrongMcpPort)), /server.mcp.port/);
});

test("requires explicit legacy credentials and validates public HTTPS URLs", async () => {
  const legacy = validYaml.replace("  allowLegacyAuth: false", "  allowLegacyAuth: true");
  await assert.rejects(loadDockerConfig(await configFile(legacy)), /legacyAuthToken/);
  const insecure = validYaml.replace("https://api.example.com\n", "http://api.example.com\n");
  await assert.rejects(loadDockerConfig(await configFile(insecure)), /publicOrigin/);
});

test("validates optional redirects and permits plaintext identity only on local Docker hosts", async () => {
  const badSuccess = validYaml.replace(
    "  applicationVersion: beta\n",
    "  applicationVersion: beta\n  successRedirectUri: http://api.example.com/done\n",
  );
  await assert.rejects(loadDockerConfig(await configFile(badSuccess)), /successRedirectUri/);

  const remotePlaintext = validYaml.replace(
    "http://host.docker.internal:8080/api/v1/admin/session",
    "http://identity.example.com/api/v1/admin/session",
  );
  await assert.rejects(loadDockerConfig(await configFile(remotePlaintext)), /identityValidationUrl/);

  const remoteTls = remotePlaintext.replace("http://identity.example.com", "https://identity.example.com");
  const result = await loadDockerConfig(await configFile(remoteTls));
  assert.equal(result.mcpEnv.LEGACY_IDENTITY_VALIDATION_URL, "https://identity.example.com/api/v1/admin/session");
});

test("connected-account enablement requires postgres, redis, keyring, origins, and https", async () => {
  const incomplete = `${validYaml}
connected-account:
  enabled: true
  audience: amazon-sp-api-account-service
`;
  await assert.rejects(loadDockerConfig(await configFile(incomplete)), /connected-account.enabled|storage/);

  const jwt = randomBytes(32).toString("base64");
  const withStorageOnly = `${validYaml}
storage:
  postgres:
    url: postgresql://amazon:x@127.0.0.1:5432/amazon
  redis:
    url: redis://127.0.0.1:6379/0
    namespace: amazon-sp-api
connected-account:
  enabled: true
  audience: amazon-sp-api-account-service
  allowedOrigins: ["https://app.example.com"]
  jwtKeys:
    - kid: k1
      issuer: https://issuer.example
      secret: ${jwt}
`;
  // tokenEncryptionKey-only is rejected when connected-account enabled
  await assert.rejects(loadDockerConfig(await configFile(withStorageOnly)), /credentialKeys|connected-account.enabled/);
});

test("rejects redis namespace whitespace and postgres/redis url+urlFile conflicts", async () => {
  const badNs = `${validYaml}
storage:
  redis:
    url: redis://127.0.0.1:6379/0
    namespace: "bad name"
`;
  await assert.rejects(loadDockerConfig(await configFile(badNs)), /namespace/);

  const both = `${validYaml}
storage:
  postgres:
    url: postgresql://a@b/c
    urlFile: /run/secrets/db
`;
  await assert.rejects(loadDockerConfig(await configFile(both)), /exactly one of url or urlFile/);
});
