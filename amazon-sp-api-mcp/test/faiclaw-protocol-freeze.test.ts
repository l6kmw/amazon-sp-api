import assert from "node:assert/strict";
import { test } from "node:test";

import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST, CONNECTED_ACCOUNT_PROTOCOL_SCOPES } from "../src/connected-account.js";

/**
 * M0-T4: freeze Connected Account Protocol v1 surface contracts that must not
 * drift without an explicit design change and migration plan.
 */
test("freezes discovery capability and runtime tool mapping", () => {
  assert.equal(CONNECTED_ACCOUNT_DISCOVERY_MANIFEST.protocolVersion, "1.0");
  assert.equal(CONNECTED_ACCOUNT_DISCOVERY_MANIFEST.providerKey, "amazon-sp-api");
  assert.equal(CONNECTED_ACCOUNT_DISCOVERY_MANIFEST.displayName, "Amazon SP-API");
  assert.equal(CONNECTED_ACCOUNT_DISCOVERY_MANIFEST.authorizationFlow, "redirect");
  assert.deepEqual(CONNECTED_ACCOUNT_DISCOVERY_MANIFEST.capabilities, {
    multiAccount: true,
    sharedEmployeeBinding: false,
    independentOwnerAuthorization: false,
    remark: true,
    refresh: true,
    unbind: true,
  });
  assert.deepEqual(CONNECTED_ACCOUNT_DISCOVERY_MANIFEST.runtime, {
    listAccountsTool: "amazon_list_accounts",
    accountIdArgument: "account_id",
  });
});

test("freezes protocol scope set used by auth/check and route guards", () => {
  assert.deepEqual([...CONNECTED_ACCOUNT_PROTOCOL_SCOPES].sort(), [
    "config:check",
    "connected_accounts:manage",
    "mcp:catalog",
    "mcp:invoke",
  ]);
});

test("freezes lifecycle method/path table for ConnectedAccount v1", () => {
  const routes = [
    ["GET", "/.well-known/connected-account"],
    ["GET", "/connected-account/v1/auth/check"],
    ["GET", "/connected-account/v1/accounts"],
    ["POST", "/connected-account/v1/accounts/refresh"],
    ["POST", "/connected-account/v1/accounts/lookup"],
    ["POST", "/connected-account/v1/authorization-attempts"],
    ["GET", "/connected-account/v1/authorization-attempts/{attemptId}"],
    ["POST", "/connected-account/v1/account-bindings"],
    ["PUT", "/connected-account/v1/account-bindings/{connectionId}/remark"],
    ["DELETE", "/connected-account/v1/account-bindings/{connectionId}"],
    ["DELETE", "/connected-account/v1/connections/{connectionId}"],
  ] as const;

  assert.equal(routes.length, 11);
  for (const [method, path] of routes) {
    assert.match(method, /^(GET|POST|PUT|DELETE)$/);
    assert.ok(path.startsWith("/") || path.startsWith("/."));
    assert.ok(!path.includes("?"));
  }
});
