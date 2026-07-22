import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Pool } from "pg";
import { RedisStateStore } from "./redis-store.mjs";

import {
  IntentStore,
  PostgresTokenStore,
  StateStore,
  TokenStore,
  createAmazonOAuthServer,
  validateAmazonCallbackUri,
} from "./server.mjs";
import { installLwaCredentials } from "./install-lwa-credentials.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function startTestServer(exchangeCode) {
  const directory = await mkdtemp(join(tmpdir(), "amazon-oauth-test-"));
  temporaryDirectories.push(directory);
  const config = {
    clientId: "client-id",
    clientSecret: "client-secret",
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "https://api.example.com",
    redirectUri: "https://api.example.com/oauth/amazon/callback",
    successRedirectUri: "",
    internalSecret: "internal-secret-with-at-least-32-chars",
    applicationId: "amzn1.sp.solution.example",
    authorizationUri: "https://sellercentral-europe.amazon.com/apps/authorize/consent",
    applicationVersion: "beta",
    tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    connected-accountAllowedOrigins: ["https://app.connected-account.example"],
  };
  const server = createAmazonOAuthServer({
    config,
    exchangeCode,
    stateStore: new StateStore(join(directory, "states.json")),
    intentStore: new IntentStore(join(directory, "intents.json")),
    tokenStore: new TokenStore(
      join(directory, "tokens.json"),
      config.tokenEncryptionKey,
    ),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    server,
  };
}

async function internalRequest(context, path, options = {}) {
  return fetch(`${context.baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: "Bearer internal-secret-with-at-least-32-chars",
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

test("accepts Amazon confirmation URIs and rejects open redirects", () => {
  assert.equal(
    validateAmazonCallbackUri(
      "https://sellercentral.amazon.com/apps/authorize/confirm/example",
    ).hostname,
    "sellercentral.amazon.com",
  );
  assert.throws(() =>
    validateAmazonCallbackUri(
      "https://amazon.com.attacker.example/apps/authorize/confirm/example",
    ),
  );
});

test("binds callback credentials to the tenant from a one-time intent", async () => {
  let exchangedCode;
  const context = await startTestServer(async ({ code }) => {
    exchangedCode = code;
    return {
      refresh_token: "refresh-token-must-not-appear-in-storage",
      token_type: "bearer",
    };
  });

  try {
    const intentResponse = await internalRequest(context, "/internal/amazon/intents", {
      method: "POST",
      body: JSON.stringify({ tenant_id: "user-1" }),
    });
    assert.equal(intentResponse.status, 201);
    const intent = await intentResponse.json();
    assert.match(intent.intent_id, /^[A-Za-z0-9_-]+$/);
    const startURL = new URL(intent.authorization_url);
    assert.equal(startURL.pathname, "/oauth/amazon/start");
    assert.equal(startURL.searchParams.get("intent"), intent.intent_id);

    const loginResponse = await internalRequest(context, "/internal/amazon/login", {
      method: "POST",
      body: JSON.stringify({
        intent_id: intent.intent_id,
        tenant_id: "user-1",
        amazon_callback_uri: "https://sellercentral.amazon.com/apps/authorize/confirm/example",
        amazon_state: "amazon-state",
        selling_partner_id: "A1EXAMPLE",
        version: "beta",
      }),
    });
    assert.equal(loginResponse.status, 200);
    const amazonRedirect = new URL((await loginResponse.json()).redirect_url);
    assert.equal(amazonRedirect.searchParams.get("amazon_state"), "amazon-state");
    assert.equal(amazonRedirect.searchParams.get("version"), "beta");
    assert.equal(
      amazonRedirect.searchParams.get("redirect_uri"),
      "https://api.example.com/oauth/amazon/callback",
    );

    const state = amazonRedirect.searchParams.get("state");
    const callbackUrl = new URL("/oauth/amazon/callback", context.baseUrl);
    callbackUrl.searchParams.set("state", state);
    callbackUrl.searchParams.set("selling_partner_id", "A1EXAMPLE");
    callbackUrl.searchParams.set("spapi_oauth_code", "authorization-code");

    const mismatchedCallbackUrl = new URL(callbackUrl);
    mismatchedCallbackUrl.searchParams.set("selling_partner_id", "A1OTHERSELLER");
    const mismatchedResponse = await fetch(mismatchedCallbackUrl);
    assert.equal(mismatchedResponse.status, 400);

    const callbackResponse = await fetch(callbackUrl, { redirect: "manual" });
    assert.equal(callbackResponse.status, 200);
    assert.equal(exchangedCode, "authorization-code");

    const tokenFile = await readFile(join(context.directory, "tokens.json"), "utf8");
    assert.doesNotMatch(tokenFile, /refresh-token-must-not-appear-in-storage/);
    assert.match(tokenFile, /aes-256-gcm/);
    assert.match(tokenFile, /"tenantId": "user-1"/);

    const replayResponse = await fetch(callbackUrl, { redirect: "manual" });
    assert.equal(replayResponse.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      context.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("authorization start sets an intent cookie and public login continues without Legacy", async () => {
  const context = await startTestServer(async () => ({}));
  try {
    const intentResponse = await internalRequest(context, "/internal/amazon/intents", {
      method: "POST",
      body: JSON.stringify({ tenant_id: "user-1" }),
    });
    const intent = await intentResponse.json();
    const startResponse = await fetch(intent.authorization_url.replace("https://api.example.com", context.baseUrl), {
      redirect: "manual",
    });
    assert.equal(startResponse.status, 302);
    const intentCookie = startResponse.headers.get("set-cookie");
    assert.match(intentCookie, /amazon_oauth_intent=/);
    assert.match(intentCookie, /HttpOnly/);
    assert.match(intentCookie, /SameSite=Lax/);
    const sellerAuthorizationURL = new URL(startResponse.headers.get("location"));
    assert.equal(sellerAuthorizationURL.searchParams.get("state"), intent.intent_id);

    const loginURL = new URL("/oauth/amazon/login", context.baseUrl);
    loginURL.searchParams.set("amazon_callback_uri", "https://sellercentral.amazon.com/apps/authorize/confirm/example");
    loginURL.searchParams.set("amazon_state", "amazon-state");
    loginURL.searchParams.set("selling_partner_id", "A1EXAMPLE");

    const response = await fetch(loginURL, {
      redirect: "manual",
      headers: { cookie: intentCookie.split(";", 1)[0] },
    });
    assert.equal(response.status, 302);
    const confirmation = new URL(response.headers.get("location"));
    assert.equal(confirmation.hostname, "sellercentral.amazon.com");
    assert.equal(confirmation.searchParams.get("amazon_state"), "amazon-state");
    assert.notEqual(confirmation.searchParams.get("state"), intent.intent_id);

    const missingCookie = await fetch(loginURL, { redirect: "manual" });
    assert.equal(missingCookie.status, 400);
  } finally {
    await new Promise((resolve, reject) => context.server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("completes a ConnectedAccount authorization through the public login bridge", async () => {
  const attemptId = "att_0123456789abcdef";
  const context = await startTestServer(async () => ({
    refresh_token: "connected-account-refresh-token-must-not-appear-in-storage",
    token_type: "bearer",
  }));
  try {
    const intentResponse = await internalRequest(context, "/internal/amazon/intents", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: "jwt-employee:issuer-hash:employee-1",
        connected-account_attempt_id: attemptId,
        connected-account_origin: "https://app.connected-account.example",
      }),
    });
    assert.equal(intentResponse.status, 201);
    const intent = await intentResponse.json();
    const intentFile = await readFile(join(context.directory, "intents.json"), "utf8");
    assert.doesNotMatch(intentFile, new RegExp(intent.intent_id));

    const startResponse = await fetch(
      intent.authorization_url.replace("https://api.example.com", context.baseUrl),
      { redirect: "manual" },
    );
    const intentCookie = startResponse.headers.get("set-cookie");
    const loginURL = new URL("/oauth/amazon/login", context.baseUrl);
    loginURL.searchParams.set(
      "amazon_callback_uri",
      "https://sellercentral.amazon.com/apps/authorize/confirm/example",
    );
    loginURL.searchParams.set("amazon_state", "amazon-state");
    loginURL.searchParams.set("selling_partner_id", "A1CONNECTED_ACCOUNT");
    const loginResponse = await fetch(loginURL, {
      redirect: "manual",
      headers: { cookie: intentCookie.split(";", 1)[0] },
    });
    assert.equal(loginResponse.status, 302);
    const state = new URL(loginResponse.headers.get("location")).searchParams.get("state");
    const stateFile = await readFile(join(context.directory, "states.json"), "utf8");
    assert.doesNotMatch(stateFile, new RegExp(state));

    const callbackURL = new URL("/oauth/amazon/callback", context.baseUrl);
    callbackURL.searchParams.set("state", state);
    callbackURL.searchParams.set("selling_partner_id", "A1CONNECTED_ACCOUNT");
    callbackURL.searchParams.set("spapi_oauth_code", "authorization-code");
    const callbackResponse = await fetch(callbackURL, { redirect: "manual" });
    assert.equal(callbackResponse.status, 200);
    assert.equal(callbackResponse.headers.get("cache-control"), "no-store");
    assert.equal(callbackResponse.headers.get("referrer-policy"), "no-referrer");
    assert.match(
      callbackResponse.headers.get("content-security-policy"),
      /script-src 'nonce-[A-Za-z0-9+/=]+'/,
    );
    const completionPage = await callbackResponse.text();
    assert.match(completionPage, /postMessage\(/);
    assert.match(completionPage, /"https:\/\/app\.connected-account\.example"/);
    assert.match(completionPage, new RegExp(attemptId));
    // postMessage payload may only contain type/attemptId/status; targetOrigin exact.
    assert.match(
      completionPage,
      /postMessage\(\{"type":"connected-account:connected-account-authorization","attemptId":"[^"]+","status":"active"\},"https:\/\/app\.connected-account\.example"\)/,
    );
    assert.doesNotMatch(completionPage, /refresh_token|access_token|selling_partner|tenant/i);
    assert.doesNotMatch(completionPage, /connected-account-refresh-token/);

    const tokenFile = await readFile(join(context.directory, "tokens.json"), "utf8");
    assert.doesNotMatch(tokenFile, /connected-account-refresh-token-must-not-appear-in-storage/);
    assert.match(tokenFile, /aes-256-gcm/);
    assert.match(tokenFile, new RegExp(attemptId));

    const completionResponse = await internalRequest(
      context,
      `/internal/amazon/connected-account-completions/${attemptId}?tenant_id=${encodeURIComponent("jwt-employee:issuer-hash:employee-1")}`,
    );
    assert.equal(completionResponse.status, 200);
    const completion = await completionResponse.json();
    assert.equal(completion.sellingPartnerId, "A1CONNECTED_ACCOUNT");
    assert.match(completion.authorizedAt, /^\d{4}-\d{2}-\d{2}T/);

    const wrongTenant = await internalRequest(
      context,
      `/internal/amazon/connected-account-completions/${attemptId}?tenant_id=${encodeURIComponent("jwt-employee:issuer-hash:employee-2")}`,
    );
    assert.equal(wrongTenant.status, 404);
    const wrongAttempt = await internalRequest(
      context,
      "/internal/amazon/connected-account-completions/att_fedcba9876543210?tenant_id=jwt-employee%3Aissuer-hash%3Aemployee-1",
    );
    assert.equal(wrongAttempt.status, 404);

    const replay = await fetch(callbackURL, { redirect: "manual" });
    assert.equal(replay.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      context.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects ConnectedAccount intents for missing or untrusted origins", async () => {
  const context = await startTestServer(async () => ({}));
  try {
    for (const connected-accountOrigin of [undefined, "https://attacker.example", "*"]) {
      const response = await internalRequest(context, "/internal/amazon/intents", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: "jwt-employee:issuer-hash:employee-1",
          connected-account_attempt_id: "att_0123456789abcdef",
          ...(connected-accountOrigin === undefined ? {} : { connected-account_origin: connected-accountOrigin }),
        }),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await new Promise((resolve, reject) =>
      context.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("authorization renewal prepares the intent cookie and opens Manage Your Apps", async () => {
  const context = await startTestServer(async () => ({}));
  try {
    const intentResponse = await internalRequest(context, "/internal/amazon/intents", {
      method: "POST",
      body: JSON.stringify({ tenant_id: "user-1" }),
    });
    const intent = await intentResponse.json();
    const renewalURL = new URL("/oauth/amazon/renew", context.baseUrl);
    renewalURL.searchParams.set("intent", intent.intent_id);

    const renewalResponse = await fetch(renewalURL, { redirect: "manual" });
    assert.equal(renewalResponse.status, 302);
    assert.equal(
      renewalResponse.headers.get("location"),
      "https://sellercentral-europe.amazon.com/apps/manage",
    );
    const intentCookie = renewalResponse.headers.get("set-cookie");
    assert.match(intentCookie, /amazon_oauth_intent=/);
    assert.match(intentCookie, /HttpOnly/);
    assert.match(intentCookie, /Secure/);
    assert.match(intentCookie, /SameSite=Lax/);

    const invalidResponse = await fetch(
      new URL("/oauth/amazon/renew?intent=invalid", context.baseUrl),
      { redirect: "manual" },
    );
    assert.equal(invalidResponse.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      context.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("binds a direct callback when Amazon skips the login bridge", async () => {
  const context = await startTestServer(async () => ({
    refresh_token: "direct-refresh-token",
    token_type: "bearer",
  }));
  try {
    const intentResponse = await internalRequest(context, "/internal/amazon/intents", {
      method: "POST",
      body: JSON.stringify({ tenant_id: "user-1" }),
    });
    const intent = await intentResponse.json();
    const callbackURL = new URL("/oauth/amazon/callback", context.baseUrl);
    callbackURL.searchParams.set("state", intent.intent_id);
    callbackURL.searchParams.set("selling_partner_id", "A1DIRECT");
    callbackURL.searchParams.set("spapi_oauth_code", "direct-authorization-code");

    const response = await fetch(callbackURL, { redirect: "manual" });
    assert.equal(response.status, 200);
    const tokenFile = JSON.parse(
      await readFile(join(context.directory, "tokens.json"), "utf8"),
    );
    assert.equal(tokenFile.A1DIRECT.tenantId, "user-1");

    const replay = await fetch(callbackURL, { redirect: "manual" });
    assert.equal(replay.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      context.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("intent is one-time and cannot be continued by another tenant", async () => {
  const context = await startTestServer(async () => ({}));
  try {
    const intentResponse = await internalRequest(context, "/internal/amazon/intents", {
      method: "POST",
      body: JSON.stringify({ tenant_id: "user-1" }),
    });
    const intent = await intentResponse.json();
    const body = {
      intent_id: intent.intent_id,
      tenant_id: "user-2",
      amazon_callback_uri: "https://sellercentral.amazon.com/apps/authorize/confirm/example",
      amazon_state: "amazon-state",
      selling_partner_id: "A1EXAMPLE",
    };

    const wrongTenant = await internalRequest(context, "/internal/amazon/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(wrongTenant.status, 400);

    body.tenant_id = "user-1";
    const accepted = await internalRequest(context, "/internal/amazon/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 200);
    const replay = await internalRequest(context, "/internal/amazon/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 400);
  } finally {
    await new Promise((resolve, reject) => context.server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("lists tenant connections and disconnect deletes usable credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-token-test-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "tokens.json");
  const store = new TokenStore(file, Buffer.alloc(32, 9).toString("base64"));
  await store.save("A1EXAMPLE", "user-1", { refresh_token: "secret", token_type: "bearer" });

  assert.equal((await store.list("user-1")).length, 1);
  assert.equal((await store.list("user-2")).length, 0);
  assert.equal(await store.disconnect("user-2", "A1EXAMPLE"), false);
  assert.equal(await store.disconnect("user-1", "A1EXAMPLE"), true);
  assert.doesNotMatch(await readFile(file, "utf8"), /A1EXAMPLE/);
});

test("health check reports whether LWA credentials are configured", async () => {
  const context = await startTestServer(async () => ({}));
  try {
    const response = await fetch(`${context.baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { lwaConfigured: true, status: "ok" });
  } finally {
    await new Promise((resolve, reject) =>
      context.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("installs LWA credentials atomically without changing other settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-lwa-install-test-"));
  temporaryDirectories.push(directory);
  const incoming = join(directory, "incoming.env");
  const target = join(directory, "service.env");
  await writeFile(
    incoming,
    'AMAZON_LWA_CLIENT_ID="new-client"\nAMAZON_LWA_CLIENT_SECRET="new-secret"\n',
    { mode: 0o600 },
  );
  await writeFile(
    target,
    "PORT=8788\nAMAZON_LWA_CLIENT_ID=\nAMAZON_LWA_CLIENT_SECRET=\n",
    { mode: 0o644 },
  );
  await chmod(target, 0o644);

  installLwaCredentials(incoming, target);

  const installed = await readFile(target, "utf8");
  assert.match(installed, /PORT=8788/);
  assert.match(installed, /AMAZON_LWA_CLIENT_ID="new-client"/);
  assert.match(installed, /AMAZON_LWA_CLIENT_SECRET="new-secret"/);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await assert.rejects(readFile(incoming, "utf8"), { code: "ENOENT" });
});

test("stores encrypted OAuth connections atomically in PostgreSQL", {
  skip: !process.env.TEST_OAUTH_DATABASE_URL,
}, async () => {
  const databaseUrl = process.env.TEST_OAUTH_DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresTokenStore(
    databaseUrl,
    Buffer.alloc(32, 9).toString("base64"),
  );
  const secondStore = new PostgresTokenStore(
    databaseUrl,
    Buffer.alloc(32, 9).toString("base64"),
  );
  await pool.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
  try {
    await Promise.all([store.initialize(), secondStore.initialize()]);
    await store.save("A1POSTGRES", "tenant-1", {
      refresh_token: "postgres-refresh-token",
      token_type: "bearer",
    }, { connected-accountAttemptId: "att_0123456789abcdef" });
    assert.deepEqual(await store.list("tenant-1"), [{
      authorizedAt: (await store.list("tenant-1"))[0].authorizedAt,
      sellingPartnerId: "A1POSTGRES",
    }]);
    assert.deepEqual(
      (await store.findConnectedAccountCompletion("tenant-1", "att_0123456789abcdef"))
        ?.sellingPartnerId,
      "A1POSTGRES",
    );
    await assert.rejects(
      store.save("A1POSTGRES", "tenant-2", { refresh_token: "other-token" }),
      /already connected/,
    );
    const stored = await pool.query(`
      SELECT refresh_token::text AS encrypted, tenant_id, status
      FROM amazon_sp_api.oauth_connection
      WHERE selling_partner_id = 'A1POSTGRES'
    `);
    assert.equal(stored.rows[0].tenant_id, "tenant-1");
    assert.equal(stored.rows[0].status, "active");
    assert.doesNotMatch(stored.rows[0].encrypted, /postgres-refresh-token/);
    assert.equal(await store.disconnect("tenant-2", "A1POSTGRES"), false);
    assert.equal(await store.disconnect("tenant-1", "A1POSTGRES"), true);
    const disconnected = await pool.query(`
      SELECT refresh_token, status FROM amazon_sp_api.oauth_connection
      WHERE selling_partner_id = 'A1POSTGRES'
    `);
    assert.equal(disconnected.rows[0].refresh_token, null);
    assert.equal(disconnected.rows[0].status, "disconnected");
    await secondStore.save("A1POSTGRES", "tenant-2", {
      refresh_token: "replacement-refresh-token",
      token_type: "bearer",
    });
    assert.deepEqual(await secondStore.list("tenant-1"), []);
    assert.equal((await secondStore.list("tenant-2"))[0]?.sellingPartnerId, "A1POSTGRES");
    const reconnected = await pool.query(`
      SELECT refresh_token::text AS encrypted, tenant_id, status
      FROM amazon_sp_api.oauth_connection
      WHERE selling_partner_id = 'A1POSTGRES'
    `);
    assert.equal(reconnected.rows[0].tenant_id, "tenant-2");
    assert.equal(reconnected.rows[0].status, "active");
    assert.doesNotMatch(reconnected.rows[0].encrypted, /replacement-refresh-token/);
  } finally {
    await store.close();
    await secondStore.close();
    await pool.query("DROP SCHEMA IF EXISTS amazon_sp_api CASCADE");
    await pool.end();
  }
});

test("consumes OAuth state only once across Redis-backed instances", {
  skip: !process.env.TEST_REDIS_URL,
}, async () => {
  const namespace = `amazon-sp-api-oauth-test-${process.pid}-${Date.now()}`;
  const first = new RedisStateStore({
    redisUrl: process.env.TEST_REDIS_URL,
    namespace,
  });
  const second = new RedisStateStore({
    redisUrl: process.env.TEST_REDIS_URL,
    namespace,
  });
  try {
    const state = await first.create({ sellingPartnerId: "A1REDIS", tenantId: "tenant-1" });
    assert.doesNotMatch(first.key(state), new RegExp(state));
    assert.equal(await second.consume(state, () => false), null);
    const results = await Promise.all([
      first.consume(state),
      second.consume(state),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), {
      sellingPartnerId: "A1REDIS",
      tenantId: "tenant-1",
    });
    assert.equal(await first.get(state), null);
    assert.equal(await first.checkHealth(), true);
  } finally {
    await first.close();
    await second.close();
  }
});
