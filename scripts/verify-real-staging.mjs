import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

const temporary = mkdtempSync(join(tmpdir(), "amazon-sp-api-staging-"));
const postgres = `amazon-sp-api-staging-pg-${process.pid}`;
const redis = `amazon-sp-api-staging-redis-${process.pid}`;
const cleanup = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").slice(-800)}`);
  }
  return result.stdout.trim();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function verifyTlsBrowser({ origin, password, proxyRequests }) {
  const chrome = process.env.CHROME_BIN
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profile = mkdtempSync(join(tmpdir(), "amazon-real-staging-browser-"));
  const browser = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--ignore-certificate-errors", "--allow-insecure-localhost", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, origin,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket;
  try {
    let wsUrl;
    let stderr = "";
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      stderr += chunk;
      wsUrl ||= chunk.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    });
    for (let attempt = 0; attempt < 100 && !wsUrl; attempt += 1) await wait(50);
    assert.ok(wsUrl, `Chrome DevTools unavailable: ${stderr.slice(-800)}`);
    const listUrl = `http://${new URL(wsUrl).host}/json/list`;
    let page;
    for (let attempt = 0; attempt < 100 && !page; attempt += 1) {
      page = (await fetch(listUrl).then((response) => response.json())).find((item) => item.type === "page");
      if (!page) await wait(50);
    }
    assert.ok(page?.webSocketDebuggerUrl, "Chrome page target missing");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const blockedCookieReasons = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Network.responseReceivedExtraInfo") {
        for (const blocked of message.params.blockedCookies || []) blockedCookieReasons.push(...blocked.blockedReasons);
      }
      const waiter = message.id && pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, label) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (await evaluate(expression)) return;
        await wait(50);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    await command("Runtime.enable");
    await command("Network.enable");
    await waitFor("document.querySelector('#admin-username') !== null", "TLS login form");
    await evaluate(`(() => {
      const set=(selector,value)=>{const input=document.querySelector(selector);const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
      set('#admin-username','admin');set('#admin-password',${JSON.stringify(password)});document.querySelector('form').requestSubmit();
    })()`);
    await waitFor("document.querySelector('#admin-username') === null", "authenticated TLS shell");
    assert.equal(await evaluate("fetch('/api/v1/admin/session').then((response)=>response.json()).then((body)=>body.authenticated)"), true);
    const cookies = (await command("Network.getAllCookies")).cookies;
    const sessionCookie = cookies.find((cookie) => cookie.name === "__Host-amazon_admin_session");
    const cookieMetadata = cookies.map(({ name, secure, httpOnly, sameSite, domain, path }) => ({ name, secure, httpOnly, sameSite, domain, path }));
    assert.ok(sessionCookie?.secure && sessionCookie.httpOnly, `admin browser cookie must be Secure and HttpOnly: cookies=${JSON.stringify(cookieMetadata)} blocked=${JSON.stringify(blockedCookieReasons)}`);
    assert.equal(sessionCookie.sameSite, "Strict");
    assert.equal(await evaluate("document.cookie.includes('__Host-amazon_admin_session')"), false);
    assert.equal(await evaluate("fetch('/').then((response)=>response.headers.get('cache-control'))"), "no-store");
    assert.equal(await evaluate("fetch('/admin-config.js').then((response)=>response.headers.get('cache-control'))"), "no-store");
    assert.equal(await evaluate(`(() => {
      const asset=document.querySelector('script[src*="/assets/"]')?.getAttribute('src');
      return asset ? fetch(asset).then((response)=>response.headers.get('cache-control')) : null;
    })()`), "public, max-age=31536000, immutable");

    await evaluate("window.location.hash='#/mcp-config'");
    await waitFor("document.body.innerText.includes('MCP 连接配置')", "MCP config page");
    assert.equal(await evaluate("document.body.innerText.includes(window.location.origin + '/mcp/amazon')"), true);

    await evaluate("window.location.hash='#/amazon-setup'");
    await waitFor("document.body.innerText.includes('Amazon / LWA 配置与授权向导')", "Amazon setup page");
    await evaluate(`Array.from(document.querySelectorAll('button')).find((button)=>button.textContent.includes('Seller 授权')).click()`);
    await waitFor("document.querySelector('#authorization-employee') !== null", "authorization owner selector");
    await evaluate(`Array.from(document.querySelectorAll('button')).find((button)=>button.textContent.includes('创建 Authorization Attempt')).click()`);
    await waitFor("document.body.innerText.includes('pending')", "pending authorization attempt");
    await waitFor("Array.from(document.querySelectorAll('button')).some((button)=>button.textContent.includes('打开 Amazon 官方授权'))", "authorization start button");
    await evaluate(`Array.from(document.querySelectorAll('button')).find((button)=>button.textContent.includes('打开 Amazon 官方授权')).click()`);
    for (let attempt = 0; attempt < 100 && !proxyRequests.some((value) => value.startsWith("GET /oauth/amazon/start?intent=")); attempt += 1) await wait(50);
    assert.ok(proxyRequests.some((value) => value.startsWith("GET /oauth/amazon/start?intent=")), "browser did not reach same-origin OAuth start");
    assert.ok(proxyRequests.includes("POST /api/v1/admin/session"), "browser login did not traverse TLS proxy");
    assert.ok(proxyRequests.includes("POST /api/v1/admin/authorization-attempts"), "browser OAuth attempt did not traverse TLS proxy");
  } finally {
    socket?.close();
    browser.kill("SIGTERM");
    rmSync(profile, { recursive: true, force: true });
  }
}

try {
  run("docker", [
    "run", "--rm", "-d", "--name", postgres,
    "-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_DB=amazon_test",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  cleanup.push(() => spawnSync("docker", ["rm", "-f", postgres]));
  run("docker", [
    "run", "--rm", "-d", "--name", redis,
    "-p", "127.0.0.1::6379", "redis:7-alpine",
  ]);
  cleanup.push(() => spawnSync("docker", ["rm", "-f", redis]));

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (spawnSync("docker", ["exec", postgres, "pg_isready", "-U", "postgres", "-d", "amazon_test"]).status === 0) break;
    await wait(100);
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = spawnSync("docker", ["exec", redis, "redis-cli", "ping"], { encoding: "utf8" });
    if (result.stdout.includes("PONG")) break;
    await wait(100);
  }
  const postgresPort = run("docker", ["port", postgres, "5432/tcp"]).split(":").at(-1);
  const redisPort = run("docker", ["port", redis, "6379/tcp"]).split(":").at(-1);
  const databaseUrl = `postgresql://postgres:test@127.0.0.1:${postgresPort}/amazon_test`;
  let databaseReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await probe.query("SELECT 1");
      databaseReady = true;
      break;
    } catch {
      await wait(100);
    } finally {
      await probe.end().catch(() => undefined);
    }
  }
  assert.ok(databaseReady, "PostgreSQL host port did not become ready");

  const tlsKey = join(temporary, "tls.key");
  const tlsCert = join(temporary, "tls.crt");
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", tlsKey, "-out", tlsCert,
  ]);
  const proxyRequests = [];
  const proxy = createHttpsServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, (request, response) => {
    proxyRequests.push(`${request.method} ${request.url || "/"}`);
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: 8789,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, "x-forwarded-proto": "https" },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await listen(proxy);
  cleanup.push(() => proxy.close());
  const publicOrigin = `https://127.0.0.1:${proxy.address().port}`;

  const sessionSecret = join(temporary, "session.secret");
  const passwordFile = join(temporary, "admin.password");
  const configFile = join(temporary, "config.yaml");
  const dataDirectory = join(temporary, "data");
  const password = `M6-${randomBytes(18).toString("base64url")}`;
  const credentialSecret = randomBytes(32).toString("base64");
  writeFileSync(sessionSecret, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  writeFileSync(configFile, `server:
  host: "127.0.0.1"
  allowedHosts: ["127.0.0.1", "localhost"]
amazon:
  publicOrigin: "${publicOrigin}"
  successRedirectUri: ""
  applicationId: "m6-test-application"
  authorizationUri: "https://sellercentral-europe.amazon.com/apps/authorize/consent"
  applicationVersion: "beta"
  lwa:
    clientId: "m6-test-client"
    clientSecret: "m6-test-client-secret-value"
  credentialKeys:
    currentKeyId: "k0"
    keys:
      - keyId: "k0"
        secret: "${credentialSecret}"
  allowedSellingPartnerIds: ["A1M6TESTSELLER"]
storage:
  dataDirectory: "${dataDirectory}"
  postgres:
    url: "${databaseUrl}"
  redis:
    url: "redis://127.0.0.1:${redisPort}"
    namespace: "amazon-m6"
connected-account:
  enabled: false
admin:
  sessionSecretFile: "${sessionSecret}"
`, { mode: 0o600 });

  const environment = {
    ...process.env,
    AMAZON_CONFIG_FILE: configFile,
    AMAZON_ADMIN_USERNAME: "admin",
    AMAZON_ADMIN_PASSWORD_FILE: passwordFile,
  };
  const node = process.env.NODE_BIN || "node";
  const migrationOutput = run(node, ["dist/migrate-postgres.js"], { env: environment });
  assert.match(migrationOutput, /schema is at version 3/);
  run(node, ["dist/init-admin.js"], { env: environment });
  const service = spawn(node, ["dist/server.js"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(() => service.kill("SIGTERM"));
  let stderr = "";
  service.stderr.setEncoding("utf8");
  service.stderr.on("data", (chunk) => { stderr += chunk; });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.exitCode !== null) break;
    try {
      if ((await fetch("http://127.0.0.1:8789/healthz")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await wait(100);
  }
  assert.ok(ready, `compiled server failed to start: ${stderr.slice(-800)}`);
  const { PostgresRefreshTokenStore } = await import("../dist/postgres-token-store.js");
  const rollbackToken = `m6-${randomBytes(24).toString("base64url")}`;
  const tokenStore = new PostgresRefreshTokenStore({
    databaseUrl,
    encryptionKey: credentialSecret,
    allowedSellingPartnerIds: ["A1M6TESTSELLER"],
  });
  await tokenStore.initialize();
  await tokenStore.save("A1M6TESTSELLER", "workspace-m6", { refresh_token: rollbackToken });
  await tokenStore.close();
  const dumpPath = "/tmp/amazon-m6-rollback.dump";
  run("docker", ["exec", postgres, "pg_dump", "-U", "postgres", "-d", "amazon_test", "-Fc", "-f", dumpPath]);
  run("docker", ["exec", postgres, "createdb", "-U", "postgres", "amazon_restore"]);
  run("docker", ["exec", postgres, "pg_restore", "-U", "postgres", "-d", "amazon_restore", dumpPath]);
  const restoredStore = new PostgresRefreshTokenStore({
    databaseUrl: `postgresql://postgres:test@127.0.0.1:${postgresPort}/amazon_restore`,
    encryptionKey: credentialSecret,
    allowedSellingPartnerIds: ["A1M6TESTSELLER"],
  });
  assert.equal(await restoredStore.getRefreshToken("A1M6TESTSELLER", "workspace-m6"), rollbackToken);
  await restoredStore.close();

  const seed = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await seed.query(`
      INSERT INTO amazon_sp_api.employee_registry
        (issuer, employee_id, workspace_id, first_seen_at, last_seen_at)
      VALUES ('https://connected-account.m6.test', 'employee-m6', 'workspace-m6', NOW(), NOW())
    `);
  } finally {
    await seed.end();
  }

  const login = await fetch("http://127.0.0.1:8789/api/v1/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = (login.headers.getSetCookie?.()[0] || login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie);
  assert.ok(session.csrf_token);

  const created = await fetch("http://127.0.0.1:8789/api/v1/admin/agents", {
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": session.csrf_token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agent_id: "m6-browser-agent",
      name: "M6 Browser Agent",
      purpose: "isolated staging",
    }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.api_token, /^oat_[A-Za-z0-9_-]{43}$/);
  const mcp = await fetch("http://127.0.0.1:8789/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${body.api_token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "real-staging-verifier", version: "1.0.0" },
      },
    }),
  });
  assert.equal(mcp.status, 200);
  assert.match(await mcp.text(), /amazon-sp-api/i);

  const databaseContract = JSON.parse(run("docker", [
    "exec", postgres, "psql", "-U", "postgres", "-d", "amazon_test", "-tAc",
    `SELECT json_build_object(
      'hash', length(api_token_hash),
      'audit', (SELECT count(*) FROM amazon_sp_api.audit_log WHERE action = 'agent.create'),
      'plaintext', (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'amazon_sp_api' AND table_name = 'app_agent'
          AND column_name IN ('api_token', 'token')
      ),
      'schema_version', (SELECT max(version) FROM amazon_sp_api.schema_migration),
      'migration_count', (SELECT count(*) FROM amazon_sp_api.schema_migration)
    ) FROM amazon_sp_api.app_agent WHERE agent_id = 'm6-browser-agent'`,
  ]));
  assert.equal(databaseContract.hash, 64);
  assert.equal(Number(databaseContract.audit), 1);
  assert.equal(Number(databaseContract.plaintext), 0);
  assert.equal(Number(databaseContract.schema_version), 3);
  assert.equal(Number(databaseContract.migration_count), 3);

  await verifyTlsBrowser({ origin: publicOrigin, password, proxyRequests });

  console.log("real staging HTTP: compiled server + PG16 + Redis7 + admin login + Session/CSRF + one-time Agent token + MCP initialize passed");
  console.log("real staging TLS browser: reverse proxy + Secure/HttpOnly/Strict cookie + CSRF OAuth attempt + same-origin OAuth start passed");
  console.log("real staging rollback: pg_dump/restore + keyring Refresh Token decrypt passed");
  console.log(`db contract: schema_version=${databaseContract.schema_version} migrations=${databaseContract.migration_count} token_hash_length=${databaseContract.hash} audit_rows=${databaseContract.audit} plaintext_columns=${databaseContract.plaintext}`);
} finally {
  for (const operation of cleanup.reverse()) {
    try { operation(); } catch {}
  }
  rmSync(temporary, { recursive: true, force: true });
}
