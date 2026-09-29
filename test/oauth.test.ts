import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { RuntimeConfig } from "../src/config.js";
import { ConnectionService, type AuthorizationIntent } from "../src/connection-service.js";
import {
  createAmazonOAuthRouter,
  OAuthUpstreamError,
  type OAuthState,
  validateAmazonCallbackUri,
} from "../src/oauth.js";
import { createAmazonMcpHttpApp } from "../src/http.js";
import { FileExpiringStore } from "../src/state-store.js";
import { EncryptedFileTokenStore } from "../src/token-store.js";
import { createAmazonMcpServer } from "../src/tools.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function context(exchangeCode: Parameters<typeof createAmazonOAuthRouter>[0]["exchangeCode"]) {
  const directory = await mkdtemp(join(tmpdir(), "amazon-oauth-router-"));
  directories.push(directory);
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const config = {
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    publicOrigin: "https://api.example.com",
    redirectUri: "https://api.example.com/oauth/amazon/callback",
    successRedirectUri: "",
    applicationId: "amzn1.sp.solution.example",
    authorizationUri: "https://sellercentral-europe.amazon.com/apps/authorize/consent",
    applicationVersion: "beta",
    lwaClientId: "client-id",
    lwaClientSecret: "client-secret",
    credentialKeyring: { currentKeyId: "k0", keys: { k0: encryptionKey } },
    allowedSellingPartnerIds: ["A1SELLER", "A1OTHER"],
    dataDirectory: directory,
    tokenStoreFile: join(directory, "tokens.json"),
    stateStoreFile: join(directory, "states.json"),
    intentStoreFile: join(directory, "intents.json"),
    connectedAccountDatabaseFile: join(directory, "connected-account.sqlite"),
    sellerCentralManageURL: "https://sellercentral-europe.amazon.com/apps/manage",
  } satisfies RuntimeConfig;
  const connectionStore = new EncryptedFileTokenStore({
    file: config.tokenStoreFile,
    encryptionKey,
    allowedSellingPartnerIds: config.allowedSellingPartnerIds,
  });
  const stateStore = new FileExpiringStore<OAuthState>(config.stateStoreFile);
  const intentStore = new FileExpiringStore<AuthorizationIntent>(config.intentStoreFile);
  await Promise.all([
    connectionStore.initialize(), stateStore.initialize(), intentStore.initialize(),
  ]);
  const connections = new ConnectionService({
    store: connectionStore,
    intentStore,
    publicOrigin: config.publicOrigin,
    allowedConnectedAccountOrigins: [config.publicOrigin],
  });
  const app = createAmazonMcpHttpApp({
    host: config.host,
    allowedHosts: config.allowedHosts,
    version: "0.1.0",
    authenticate: async () => null,
    createServer: () => createAmazonMcpServer({ async get() { return {}; } }),
  });
  app.use(createAmazonOAuthRouter({
    config,
    stateStore,
    intentStore,
    connectionStore,
    exchangeCode,
    onConnectionSaved: (tenantId) => connections.invalidateConnections(tenantId),
  }));
  app.all(/^\/internal\/amazon(?:\/|$)/, (_request, response) => {
    response.status(404).json({ error: "not_found" });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    config,
    connections,
    connectionStore,
  };
}

test("accepts Amazon confirmation URIs and rejects open redirects", () => {
  assert.equal(
    validateAmazonCallbackUri("https://sellercentral.amazon.com/apps/authorize/confirm/example").hostname,
    "sellercentral.amazon.com",
  );
  assert.throws(() => validateAmazonCallbackUri(
    "https://amazon.com.attacker.example/apps/authorize/confirm/example",
  ));
});

test("completes login and callback in one process with a one-time state", async () => {
  let exchangedCode = "";
  const testContext = await context(async ({ code }) => {
    exchangedCode = code;
    return { refresh_token: "refresh-token-must-not-be-plaintext", token_type: "bearer" };
  });
  const publicStart = new URL(await testContext.connections.createAuthorizationURL("tenant-1"));
  const localStart = new URL(publicStart.pathname + publicStart.search, testContext.baseURL);
  const start = await fetch(localStart, { redirect: "manual" });
  assert.equal(start.status, 302);
  const cookie = start.headers.get("set-cookie")!;
  assert.match(cookie, /amazon_oauth_intent=.*HttpOnly.*Secure.*SameSite=Lax/);
  const sellerConsent = new URL(start.headers.get("location")!);
  assert.equal(sellerConsent.searchParams.get("application_id"), testContext.config.applicationId);

  const login = new URL("/oauth/amazon/login", testContext.baseURL);
  login.searchParams.set(
    "amazon_callback_uri",
    "https://sellercentral.amazon.com/apps/authorize/confirm/example",
  );
  login.searchParams.set("amazon_state", "amazon-state");
  login.searchParams.set("selling_partner_id", "A1SELLER");
  login.searchParams.set("version", "beta");
  const bridge = await fetch(login, {
    redirect: "manual",
    headers: { cookie: cookie.split(";", 1)[0]! },
  });
  assert.equal(bridge.status, 302);
  const confirmation = new URL(bridge.headers.get("location")!);
  assert.equal(confirmation.searchParams.get("redirect_uri"), testContext.config.redirectUri);
  assert.equal(confirmation.searchParams.get("amazon_state"), "amazon-state");
  const state = confirmation.searchParams.get("state")!;

  const callback = new URL("/oauth/amazon/callback", testContext.baseURL);
  callback.searchParams.set("state", state);
  callback.searchParams.set("selling_partner_id", "A1SELLER");
  callback.searchParams.set("spapi_oauth_code", "authorization-code");
  const mismatch = new URL(callback);
  mismatch.searchParams.set("selling_partner_id", "A1OTHER");
  assert.equal((await fetch(mismatch, { redirect: "manual" })).status, 400);
  assert.equal((await fetch(callback, { redirect: "manual" })).status, 200);
  assert.equal(exchangedCode, "authorization-code");
  assert.equal(
    await testContext.connectionStore.getRefreshToken("A1SELLER", "tenant-1"),
    "refresh-token-must-not-be-plaintext",
  );
  assert.doesNotMatch(await readFile(testContext.config.tokenStoreFile, "utf8"), /must-not-be-plaintext/);

  const connected = await testContext.connectionStore.list("tenant-1");
  assert.equal(connected.length, 1);
  assert.equal(connected[0]?.sellingPartnerId, "A1SELLER");
  await testContext.connections.disconnect("tenant-1", "A1SELLER");
  await assert.rejects(
    testContext.connectionStore.getRefreshToken("A1SELLER", "tenant-1"),
    (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
  );
  assert.equal((await fetch(callback, { redirect: "manual" })).status, 400);
});

test("supports direct callbacks and maps LWA failure without exposing internals", async () => {
  const success = await context(async () => ({ refresh_token: "direct-refresh-token" }));
  const intent = new URL(await success.connections.createAuthorizationURL("tenant-1"))
    .searchParams.get("intent")!;
  const callback = new URL("/oauth/amazon/callback", success.baseURL);
  callback.searchParams.set("state", intent);
  callback.searchParams.set("selling_partner_id", "A1SELLER");
  callback.searchParams.set("spapi_oauth_code", "direct-code");
  assert.equal((await fetch(callback)).status, 200);

  const failure = await context(async () => {
    throw new OAuthUpstreamError("secret Amazon response");
  });
  const failedIntent = new URL(await failure.connections.createAuthorizationURL("tenant-1"))
    .searchParams.get("intent")!;
  const failedCallback = new URL("/oauth/amazon/callback", failure.baseURL);
  failedCallback.searchParams.set("state", failedIntent);
  failedCallback.searchParams.set("selling_partner_id", "A1SELLER");
  failedCallback.searchParams.set("spapi_oauth_code", "bad-code");
  const response = await fetch(failedCallback);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "amazon_token_exchange_failed" });
});

test("removed internal OAuth endpoints always return 404", async () => {
  const testContext = await context(async () => ({ refresh_token: "unused" }));
  for (const path of [
    "/internal/amazon/intents",
    "/internal/amazon/connections",
    "/internal/amazon/connected-account-completions/att_0123456789abcdef",
  ]) {
    assert.equal((await fetch(`${testContext.baseURL}${path}`)).status, 404);
  }
});
