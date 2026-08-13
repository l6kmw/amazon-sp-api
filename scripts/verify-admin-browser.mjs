import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const chrome = process.env.CHROME_BIN
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await stat(chrome).catch(() => {
  throw new Error(`Chrome not found; set CHROME_BIN (checked ${chrome})`);
});

const dist = join(process.cwd(), "web/admin/dist");
await stat(join(dist, "index.html"));
const agent = {
  id: "agent_browser_test",
  agent_id: "browser-test",
  name: "Browser Test Agent",
  purpose: "browser verification",
  status: "active",
  api_token_configured: true,
  api_token_hint: "oat_abcd…wxyz",
  api_token_created_at: "2026-07-30T00:00:00.000Z",
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T00:00:00.000Z",
  last_used_at: null,
};
let authenticated = false;
let oaMode = false;
let oaLoginRequests = 0;
let unbindRequestURL = "";
let disconnectRequestURL = "";
let authorizationRequestBody = "";
let authorizationPolls = 0;
let openedAuthorizationURL = "";
let shareRequest = { url: "", body: "" };
let refreshRequests = 0;
let accountDetailRequests = 0;
let adsShareRequest = { body: "" };
let adsUnshareRequestURL = "";
let adsDisconnectRequestURL = "";

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/admin-config.js") {
    response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    response.end("window.__AMAZON_SP_API_ADMIN_CONFIG__={publicBaseURL:'',providerName:'Amazon SP-API',mcpPath:'/mcp/amazon'};");
    return;
  }
  if (url.pathname === "/api/v1/admin/session") {
    if (request.method === "POST") authenticated = true;
    json(response, authenticated
      ? {
        authenticated: true,
        username: "admin",
        csrf_token: "browser-csrf",
        ...(oaMode ? { login_enabled: false, oa_login_enabled: true, auth_method: "oa" } : {}),
      }
      : oaMode
        ? {
          authenticated: false,
          auth_enabled: true,
          login_enabled: false,
          oa_login_enabled: true,
          oa_login_url: "/api/v1/admin/oa/login",
        }
        : { authenticated: false, auth_enabled: true, login_enabled: true });
    return;
  }
  if (url.pathname === "/api/v1/admin/oa/login") {
    oaLoginRequests += 1;
    authenticated = true;
    response.writeHead(303, { location: "/", "cache-control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === "/api/v1/admin/dashboard") {
    json(response, {
      total_accounts: 0, active_accounts: 0, active_bindings: 0, active_test_agents: 1,
      credential_status_counts: {}, recent_errors_count: 2,
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/amazon-config-status") {
    json(response, {
      lwa_client_id_configured: true, lwa_client_secret_configured: true,
      application_id_configured: true, public_origin: `http://127.0.0.1:${server.address().port}`,
      oauth_callback_url: `http://127.0.0.1:${server.address().port}/oauth/amazon/callback`,
      postgres_status: "ok", redis_status: "ok", credential_keyring_status: "ok",
      connected-account_keyring_status: "ok",
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/authorization-attempts" && request.method === "POST") {
    authorizationRequestBody = await requestBody(request);
    json(response, {
      attempt_id: "att_browser_authorization1",
      status: "pending",
      authorization_url: `http://127.0.0.1:${server.address().port}/oauth/amazon/start?intent=browser-secret-intent`,
      created_at: "2026-07-30T00:00:00.000Z",
      expires_at: "2026-07-30T00:10:00.000Z",
    }, 201);
    return;
  }
  if (url.pathname === "/api/v1/admin/authorization-attempts/att_browser_authorization1") {
    authorizationPolls += 1;
    json(response, {
      attempt_id: "att_browser_authorization1",
      status: authorizationPolls === 1 ? "pending" : "completed",
      ...(authorizationPolls === 1 ? {} : { account_id: "acct_browser" }),
      created_at: "2026-07-30T00:00:00.000Z",
      expires_at: "2026-07-30T00:10:00.000Z",
    });
    return;
  }
  if (url.pathname === "/oauth/amazon/start") {
    openedAuthorizationURL = request.url || "";
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>Amazon authorization</title>");
    return;
  }
  if (url.pathname === "/api/v1/admin/accounts") {
    json(response, {
      items: [{
        account_id: "acct_browser", selling_partner_id_masked: "A1B*******SER",
        display_name: "Browser Seller", region: "NA", marketplaces: ["ATVPDKIKX0DER"],
        status: "active", credential_status: "active", credential_revision: 3,
        active_bindings_count: 1, last_synced_at: "2026-07-30T00:00:00.000Z",
      }], total: 1, page: 1, total_pages: 1,
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/providers/amazon-ads/accounts") {
    json(response, {
      items: [{
        provider_key: "amazon-ads", account_id: "acct_ads_browser",
        connection_id: "con_ads_browser", external_account_id: "9988776655",
        display_name: "Browser Ads", status: "active", owner_issuer: "connected-account-browser",
        owner_employee_id: "employee-browser", active_bindings_count: 2,
        updated_at: "2026-07-30T00:00:00.000Z", region: "na", country_code: "US",
        currency_code: "USD", account_type: "seller", marketplace_id: "ATVPDKIKX0DER",
        bindings: [],
      }],
      total: 1,
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/providers/amazon-ads/accounts/acct_ads_browser") {
    json(response, {
      provider_key: "amazon-ads", account_id: "acct_ads_browser",
      connection_id: "con_ads_browser", external_account_id: "9988776655",
      display_name: "Browser Ads", status: "active", owner_issuer: "connected-account-browser",
      owner_employee_id: "employee-browser", active_bindings_count: 2,
      updated_at: "2026-07-30T00:00:00.000Z", region: "na", country_code: "US",
      currency_code: "USD", account_type: "seller", marketplace_id: "ATVPDKIKX0DER",
      bindings: [
        { connection_id: "con_ads_browser", issuer: "connected-account-browser", employee_id: "employee-browser", status: "active", remark: null, bound_at: "2026-07-30T00:00:00.000Z", updated_at: "2026-07-30T00:00:00.000Z", is_owner: true },
        { connection_id: "con_ads_browser", issuer: "connected-account-browser", employee_id: "employee-shared", status: "active", remark: "Ads shared", bound_at: "2026-07-30T00:00:00.000Z", updated_at: "2026-07-30T00:00:00.000Z", is_owner: false },
      ],
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/providers/amazon-ads/employees") {
    json(response, { items: [
      { issuer: "connected-account-browser", employee_id: "employee-browser", first_seen_at: "2026-07-30T00:00:00.000Z", last_seen_at: "2026-07-30T00:00:00.000Z", active_bindings_count: 1, total_bindings_count: 1 },
      { issuer: "connected-account-browser", employee_id: "employee-shared", first_seen_at: "2026-07-30T00:00:00.000Z", last_seen_at: "2026-07-30T00:00:00.000Z", active_bindings_count: 1, total_bindings_count: 1 },
      { issuer: "connected-account-browser", employee_id: "employee-ads-new", first_seen_at: "2026-07-30T00:00:00.000Z", last_seen_at: "2026-07-30T00:00:00.000Z", active_bindings_count: 0, total_bindings_count: 0 },
    ], total: 3 });
    return;
  }
  if (
    url.pathname === "/api/v1/admin/providers/amazon-ads/account-bindings"
    && request.method === "POST"
  ) {
    adsShareRequest = { body: await requestBody(request) };
    json(response, { shared: true }, 201);
    return;
  }
  if (
    url.pathname === "/api/v1/admin/providers/amazon-ads/account-bindings/con_ads_browser"
    && request.method === "DELETE"
  ) {
    adsUnshareRequestURL = request.url || "";
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (
    url.pathname === "/api/v1/admin/providers/amazon-ads/connections/con_ads_browser"
    && request.method === "DELETE"
  ) {
    adsDisconnectRequestURL = request.url || "";
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === "/api/v1/admin/accounts/acct_browser/refresh" && request.method === "POST") {
    refreshRequests += 1;
    json(response, { refreshed: true });
    return;
  }
  if (url.pathname === "/api/v1/admin/accounts/acct_browser") {
    accountDetailRequests += 1;
    json(response, {
      account_id: "acct_browser", selling_partner_id_masked: "A1B*******SER",
      display_name: "Browser Seller", region: "NA", marketplaces: ["ATVPDKIKX0DER"],
      status: "active", credential_status: "active", credential_revision: 3,
      active_bindings_count: 1, last_synced_at: "2026-07-30T00:00:00.000Z",
      bindings: [{ connection_id: "con_browser", employee_id: "employee-browser", issuer: "connected-account-browser", remark: "owner", bound_at: "2026-07-30T00:00:00.000Z", status: "active" }],
      credential_info: { key_id: "k0", revision: 3, last_refreshed_at: "2026-07-30T00:00:00.000Z" },
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/capabilities") {
    json(response, [{
      tool_name: "amazon_catalog_read", title: "Catalog", description: "Read catalog items",
      domain: "catalog", action: "getCatalogItem", amazon_role: "Product Listing",
      supported_regions: ["NA"], availability: "available", is_readonly: true,
    }]);
    return;
  }
  if (url.pathname === "/api/v1/admin/mcp-config") {
    json(response, { endpoint: `${origin}/mcp/amazon`, transport: "streamable-http", header_name: "Authorization", health_status: "ok", registered_tools_count: 30, tools: [] });
    return;
  }
  if (url.pathname === "/api/v1/admin/connected-account-employees") {
    json(response, { items: [
      { employee_id: "employee-browser", issuer: "connected-account-browser", first_seen_at: "2026-07-30T00:00:00.000Z", last_seen_at: "2026-07-30T00:00:00.000Z", active_bindings_count: 1, total_bindings_count: 1 },
      { employee_id: "employee-shared", issuer: "connected-account-browser", first_seen_at: "2026-07-30T00:00:00.000Z", last_seen_at: "2026-07-30T00:00:00.000Z", active_bindings_count: 0, total_bindings_count: 0 },
    ], total: 2, offset: 0, limit: 50 });
    return;
  }
  if (url.pathname === "/api/v1/admin/connected-account-employees/employee-browser/accounts") {
    json(response, [{ connection_id: "con_browser", employee_id: "employee-browser", issuer: "connected-account-browser", remark: "owner", bound_at: "2026-07-30T00:00:00.000Z", status: "active" }]);
    return;
  }
  if (
    url.pathname === "/api/v1/admin/connected-account-employees/employee-shared/account-bindings"
    && request.method === "POST"
  ) {
    shareRequest = { url: request.url || "", body: await requestBody(request) };
    json(response, { connection_id: "con_browser", employee_id: "employee-shared", issuer: "connected-account-browser", bound_at: "2026-07-30T00:00:00.000Z", status: "active" }, 201);
    return;
  }
  if (
    url.pathname === "/api/v1/admin/connected-account-employees/employee-browser/account-bindings/con_browser"
    && request.method === "DELETE"
  ) {
    unbindRequestURL = request.url || "";
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === "/api/v1/admin/agents") {
    json(response, { items: [agent] });
    return;
  }
  if (url.pathname === "/api/v1/admin/audit-logs") {
    json(response, {
      items: [{
        id: "128",
        tenant_id: "tenant-1",
        actor_type: "employee_jwt",
        actor_id: "actor-hash",
        agent_record_id: null,
        action: "mcp.tool.failed",
        resource_type: "mcp_tool",
        resource_id: "amazon_search_orders",
        result: "failed",
        error_code: "invalid_tool_arguments",
        request_id: "req_browser_audit",
        created_at: "2026-07-30T00:00:00.000Z",
      }],
      next_cursor: null,
    });
    return;
  }
  if (url.pathname === "/api/v1/admin/connections/con_browser" && request.method === "DELETE") {
    disconnectRequestURL = request.url || "";
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === `/api/v1/admin/agents/${agent.id}/api-token` && request.method === "DELETE") {
    json(response, { ...agent, api_token_configured: false, api_token_hint: "" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    json(response, { error: { code: "not_found", message: "Not found" } }, 404);
    return;
  }

  const relative = normalize(url.pathname).replace(/^[/\\]+/, "");
  const candidate = join(dist, relative || "index.html");
  const file = await readFile(candidate).catch(() => readFile(join(dist, "index.html")));
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(candidate)] || "application/octet-stream";
  response.writeHead(200, { "content-type": type });
  response.end(file);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "amazon-admin-browser-"));
const browser = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  origin,
], { stdio: ["ignore", "ignore", "pipe"] });

async function stopBrowser() {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  browser.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!stopped && browser.exitCode === null && browser.signalCode === null) {
    browser.kill("SIGKILL");
    await exited;
  }
}

async function removeProfile() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = error && typeof error === "object"
        && ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code);
      if (!retryable || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

let wsUrl;
const stderr = [];
browser.stderr.setEncoding("utf8");
browser.stderr.on("data", (chunk) => {
  stderr.push(chunk);
  wsUrl ||= chunk.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
});
for (let i = 0; i < 100 && !wsUrl; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
if (!wsUrl) throw new Error(`Chrome DevTools unavailable: ${stderr.join("").slice(-1000)}`);

const listUrl = `http://${new URL(wsUrl).host}/json/list`;
let page;
for (let i = 0; i < 100 && !page; i += 1) {
  page = (await fetch(listUrl).then((value) => value.json())).find((item) => item.type === "page");
  if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(page?.webSocketDebuggerUrl, "page target missing");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
const browserErrors = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails.text);
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") browserErrors.push(message.params.entry.text);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression, userGesture = false) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}
async function waitFor(expression, label) {
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function viewport(width, height = 900) {
  await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 480 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, `${width}px body overflow`);
}
async function screenshot(name) {
  const directory = process.env.ADMIN_BROWSER_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(directory, `${name}.png`), Buffer.from(result.data, "base64"));
}

try {
  await command("Runtime.enable");
  await command("Log.enable");
  await waitFor("document.querySelector('#admin-username') !== null", "login form");
  await evaluate(`(() => {
    const set=(selector,value)=>{const input=document.querySelector(selector); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true}));};
    set('#admin-username','admin'); set('#admin-password','browser-password'); document.querySelector('form').requestSubmit();
  })()`);
  await waitFor("document.body.innerText.includes('Amazon 连接')", "authenticated shell");
  await waitFor("document.body.innerText.includes('过去 24 小时有 2 项告警')", "dashboard alert status");
  assert.equal(
    await evaluate("document.body.innerText.includes('过去 24 小时存在 2 次 MCP 工具或凭据异常')"),
    true,
  );
  assert.equal(
    await evaluate("document.querySelector('a[href=\"#/audit-logs\"]')?.textContent.trim()"),
    "查看审计日志",
  );
  const routes = [
    ["#/", "Seller 账号总数"],
    ["#/accounts", "Amazon 连接"],
    ["#/accounts/acct_browser", "Browser Seller"],
    ["#/capabilities", "SP-API 能力"],
    ["#/amazon-setup", "Amazon / LWA 配置"],
    ["#/mcp-config", "MCP 连接配置"],
    ["#/connected-account-employees", "数字员工绑定"],
    ["#/test-agents", "Browser Test Agent"],
    ["#/audit-logs", "审计日志"],
  ];
  for (const [hash, label] of routes) {
    await evaluate(`window.location.hash=${JSON.stringify(hash)}`);
    await waitFor(`document.body.innerText.includes(${JSON.stringify(label)})`, hash);
    if (hash === "#/audit-logs") {
      assert.equal(await evaluate("document.body.innerText.includes('2026/07/30 08:00:00')"), true);
      assert.equal(await evaluate("document.body.innerText.includes('2026-07-30T00:00:00.000Z')"), false);
      assert.equal(await evaluate("document.body.innerText.includes('时间戳（北京时间）')"), true);
    }
    if (hash === "#/mcp-config") {
      assert.equal(await evaluate("document.body.innerText.includes(window.location.origin + '/mcp/amazon')"), true);
      assert.equal(await evaluate("document.body.innerText.includes(window.location.origin + 'http')"), false);
      await evaluate("window.__originalOpen=window.open; window.__openedHealthURL=''; window.open=(url)=>{window.__openedHealthURL=String(url); return null}");
      await evaluate(
        `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.includes('健康检查')).click()`,
        true,
      );
      assert.equal(
        await evaluate("window.__openedHealthURL"),
        `${origin}/healthz/amazon-mcp`,
      );
      await evaluate("window.open=window.__originalOpen; delete window.__originalOpen; delete window.__openedHealthURL");
    }
    await viewport(320, 780);
    await viewport(1440, 900);
  }
  await evaluate("window.location.hash='#/accounts'");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='详情')",
    "account detail button",
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='详情').click()`,
  );
  await waitFor("window.location.hash==='#/accounts/acct_browser'", "account detail route");
  await waitFor("document.body.innerText.includes('Browser Seller')", "account detail page");
  await evaluate("window.location.hash='#/accounts'");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='Ads')",
    "Ads provider tab",
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='Ads').click()`,
  );
  await waitFor("document.body.innerText.includes('Browser Ads')", "Ads account list");
  await viewport(320, 780);
  await viewport(1440, 900);
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='Ads 详情').click()`,
  );
  await waitFor("document.body.innerText.includes('9988776655')", "Ads account detail");
  await viewport(1440, 900);
  await screenshot("amazon-ads-detail-desktop");
  await viewport(320, 780);
  await screenshot("amazon-ads-detail-mobile");
  await viewport(1440, 900);
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='分享 Ads Binding' && !item.disabled)",
    "Ads share binding",
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='分享 Ads Binding').click()`,
  );
  for (let i = 0; i < 100 && !adsShareRequest.body; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(adsShareRequest.body), {
    connection_id: "con_ads_browser",
    issuer: "connected-account-browser",
    employee_id: "employee-ads-new",
  });
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='移除 Binding' && !item.disabled)",
    "Ads remove binding",
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='移除 Binding').click()`,
  );
  for (let i = 0; i < 100 && !adsUnshareRequestURL; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    adsUnshareRequestURL,
    "/api/v1/admin/providers/amazon-ads/account-bindings/con_ads_browser?issuer=connected-account-browser&employee_id=employee-shared",
  );
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='断开 Ads Grant' && !item.disabled)",
    "Ads disconnect",
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='断开 Ads Grant').click()`,
  );
  await waitFor("document.querySelector('dialog')?.open === true", "Ads disconnect confirmation");
  await evaluate(`(() => { const input=document.querySelector('dialog input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'acct_ads_browser'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await evaluate(
    `Array.from(document.querySelectorAll('dialog button')).find((item)=>item.textContent.trim()==='确认断开').click()`,
  );
  for (let i = 0; i < 100 && !adsDisconnectRequestURL; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adsDisconnectRequestURL, "/api/v1/admin/providers/amazon-ads/connections/con_ads_browser");
  await evaluate("window.location.hash='#/amazon-setup'");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.includes('Seller 授权'))",
    "Seller authorization step",
  );
  await evaluate(`Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.includes('Seller 授权')).click()`);
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.includes('创建 Authorization Attempt'))",
    "create authorization attempt",
  );
  await evaluate(`Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.includes('创建 Authorization Attempt')).click()`);
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.includes('打开 Amazon 官方授权'))",
    "open Amazon authorization",
  );
  assert.deepEqual(JSON.parse(authorizationRequestBody), {
    issuer: "connected-account-browser",
    employee_id: "employee-browser",
  });
  assert.equal(await evaluate("document.documentElement.innerHTML.includes('browser-secret-intent')"), false);
  for (let i = 0; i < 150 && authorizationPolls < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(authorizationPolls, 1);
  assert.equal(await evaluate(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.includes('打开 Amazon 官方授权'))",
  ), true, "authorization URL must survive a pending poll response");
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.includes('打开 Amazon 官方授权')).click()`,
    true,
  );
  for (let i = 0; i < 100 && !openedAuthorizationURL; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(openedAuthorizationURL, "/oauth/amazon/start?intent=browser-secret-intent");
  await waitFor("document.body.innerText.includes('completed')", "completed authorization attempt");
  assert.ok(authorizationPolls >= 1);

  await evaluate("window.location.hash='#/accounts/acct_browser'");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='Refresh 状态' && !item.disabled)",
    "refresh account status",
  );
  await evaluate(`Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='Refresh 状态').click()`);
  for (let i = 0; i < 100 && !refreshRequests; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshRequests, 1);
  const accountDetailRequestsBeforeShare = accountDetailRequests;
  await waitFor(`(() => {
    const item = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.trim() === '分享 Binding');
    if (!item || item.disabled) return false;
    window.__shareButtonBeforeRefresh = item;
    item.click();
    return true;
  })()`, "share binding button");
  for (let i = 0; i < 100 && !shareRequest.url; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(shareRequest.url, "/api/v1/admin/connected-account-employees/employee-shared/account-bindings");
  assert.deepEqual(JSON.parse(shareRequest.body), {
    issuer: "connected-account-browser",
    connection_id: "con_browser",
  });
  for (let i = 0; i < 100 && accountDetailRequests <= accountDetailRequestsBeforeShare; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(accountDetailRequests > accountDetailRequestsBeforeShare, "sharing must refresh account details");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='分享 Binding' && item !== window.__shareButtonBeforeRefresh && !item.disabled)",
    "completed share binding detail refresh",
  );
  await evaluate("delete window.__shareButtonBeforeRefresh");
  await waitFor(`(() => {
    const item = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.trim() === 'Disconnect Grant');
    if (!item || item.disabled) return false;
    item.click();
    return true;
  })()`, "disconnect button");
  await waitFor("document.querySelector('dialog')?.open === true", "disconnect confirmation dialog");
  await evaluate(`(() => { const input=document.querySelector('dialog input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'acct_browser'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(
    "Array.from(document.querySelectorAll('dialog button')).some((item)=>item.textContent.trim()==='确认断开' && !item.disabled)",
    "enabled disconnect confirmation",
  );
  await evaluate(`Array.from(document.querySelectorAll('dialog button')).find((item)=>item.textContent.trim()==='确认断开').click()`);
  for (let i = 0; i < 100 && !disconnectRequestURL; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disconnectRequestURL, "/api/v1/admin/connections/con_browser?issuer=connected-account-browser");

  await evaluate("window.location.hash='#/connected-account-employees'");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.includes('employee-browser'))",
    "employee row",
  );
  await evaluate(`Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.includes('employee-browser')).click()`);
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='解绑')",
    "unbind button",
  );
  await evaluate(`Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='解绑').click()`);
  await waitFor("document.querySelector('dialog')?.open === true", "unbind confirmation dialog");
  await evaluate(`Array.from(document.querySelectorAll('dialog button')).find((item)=>item.textContent.trim()==='确认解绑').click()`);
  for (let i = 0; i < 100 && !unbindRequestURL; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    unbindRequestURL,
    "/api/v1/admin/connected-account-employees/employee-browser/account-bindings/con_browser?issuer=connected-account-browser",
  );

  await evaluate("window.location.hash='#/test-agents'");
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='撤销 Token')",
    "revoke button",
  );
  await evaluate(`Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='撤销 Token').click()`);
  await waitFor("document.querySelector('dialog')?.open === true", "native confirmation dialog");
  assert.ok(await evaluate("document.querySelector('dialog').getAttribute('aria-labelledby')"));
  await command("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await waitFor("document.querySelector('dialog')?.open === false", "Escape closes dialog");
  assert.deepEqual(await evaluate("({local:localStorage.length,session:sessionStorage.length})"), { local: 0, session: 0 });
  assert.equal(await evaluate("/oat_[A-Za-z0-9_-]{32,}/.test(document.documentElement.innerHTML)"), false);

  authenticated = false;
  oaMode = true;
  await command("Page.navigate", { url: origin });
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some((item)=>item.textContent.trim()==='使用统一 OA 登录')",
    "OA login button",
  );
  assert.equal(await evaluate("document.querySelector('#admin-password') === null"), true);
  await viewport(320, 780);
  await screenshot("amazon-admin-oa-login-mobile");
  await viewport(1440, 900);
  await screenshot("amazon-admin-oa-login-desktop");
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find((item)=>item.textContent.trim()==='使用统一 OA 登录').click()",
    true,
  );
  await waitFor("document.body.innerText.includes('Amazon 连接')", "OA authenticated shell");
  assert.equal(oaLoginRequests, 1);
  assert.deepEqual(await evaluate("({local:localStorage.length,session:sessionStorage.length})"), { local: 0, session: 0 });
  assert.equal(browserErrors.length, 0, browserErrors.join("\n"));
  console.log("admin browser: password+OA login/router/320px/1440px/dialog/storage/secret checks passed");
} finally {
  socket.close();
  await stopBrowser();
  await new Promise((resolve) => server.close(resolve));
  await removeProfile();
}
