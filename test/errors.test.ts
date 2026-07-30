import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AmazonMcpError,
  mapInternalErrorCode,
  normalizeToolErrorMessage,
  runWithToolRequestContext,
} from "../src/errors.js";

test("serializes stable Amazon MCP errors without empty details", () => {
  const error = new AmazonMcpError("NOT_CONNECTED", "connect a seller first");
  assert.deepEqual(error.toJSON(), {
    code: "NOT_CONNECTED",
    message: "connect a seller first",
    retryable: false,
  });
  assert.deepEqual(JSON.parse(error.message), error.toJSON());
});

test("maps internal codes to ConnectedAccount public codes", () => {
  assert.equal(mapInternalErrorCode("INVALID_FILTER"), "invalid_tool_arguments");
  assert.equal(mapInternalErrorCode("NOT_CONNECTED"), "resource_not_found");
  assert.equal(mapInternalErrorCode("SELLER_FORBIDDEN"), "forbidden");
  assert.equal(mapInternalErrorCode("AMAZON_ROLE_REQUIRED"), "AMAZON_ROLE_REQUIRED");
  assert.equal(mapInternalErrorCode("RATE_LIMITED"), "rate_limited");
  assert.equal(mapInternalErrorCode("UPSTREAM_SP_API"), "upstream_error");
  assert.equal(mapInternalErrorCode("INTERNAL"), "internal_error");
  assert.equal(mapInternalErrorCode("AUTH_EXPIRED"), "unauthorized");
});

test("normalizes tool failures into a closed public error envelope", () => {
  const normalized = runWithToolRequestContext({
    requestId: "req_fixed_test_id_01",
    tool: "amazon_search_orders",
  }, () => normalizeToolErrorMessage(JSON.stringify({
    code: "UPSTREAM_SP_API",
    message: "Bearer oat_secret failed for buyer@example.com",
    retryable: true,
    details: {
      status: 503,
      requestId: "req_fixed_test_id_01",
      authorization: "Bearer secret",
      refreshToken: "Atzr-secret",
      buyer: "buyer@example.com",
      nested: { authorization: "Bearer nested-secret" },
    },
    secret: "must-not-pass",
  })));

  assert.deepEqual(JSON.parse(normalized), {
    error: {
      code: "upstream_error",
      tool: "amazon_search_orders",
      message: "The upstream provider request failed",
      detail: "upstream_status=503",
      http_status: 502,
      request_id: "req_fixed_test_id_01",
      next_action: "Retry only if retryable; otherwise inspect request_id with an operator",
    },
  });
  assert.doesNotMatch(
    normalized,
    /oat_secret|buyer@example\.com|Bearer secret|Atzr-secret|must-not-pass|nested|UPSTREAM_SP_API/,
  );
});

test("internal_error keeps request_id and next_action without diagnostic detail", () => {
  const normalized = runWithToolRequestContext({
    requestId: "req_internal_safe_01",
    tool: "amazon_get_order",
  }, () => normalizeToolErrorMessage("stack trace /tmp/secret.sql SELECT * FROM tokens"));

  const payload = JSON.parse(normalized);
  assert.equal(payload.error.code, "internal_error");
  assert.equal(payload.error.request_id, "req_internal_safe_01");
  assert.equal(payload.error.tool, "amazon_get_order");
  assert.equal(payload.error.http_status, 500);
  assert.ok(payload.error.next_action);
  assert.equal(payload.error.detail, undefined);
  assert.doesNotMatch(normalized, /stack|\/tmp|SELECT|tokens/);
});

test("schema validation failures become invalid_tool_arguments without structured secrets", () => {
  const normalized = normalizeToolErrorMessage(
    "Input validation error: Invalid arguments for tool amazon_search_orders: marketplaceIds",
  );
  const payload = JSON.parse(normalized);
  assert.equal(payload.error.code, "invalid_tool_arguments");
  assert.equal(payload.error.tool, "amazon_search_orders");
  assert.equal(payload.error.http_status, 400);
  assert.ok(payload.error.request_id);
});

test("public envelope rejects unknown top-level fields by reconstruction", () => {
  const normalized = normalizeToolErrorMessage(JSON.stringify({
    error: {
      code: "forbidden",
      tool: "amazon_get_order",
      message: "denied",
      request_id: "req_forbidden_01",
      http_status: 403,
      next_action: "stop",
      stack: "secret",
      authorization: "Bearer x",
    },
  }));
  const payload = JSON.parse(normalized);
  assert.equal(payload.error.code, "forbidden");
  assert.equal(payload.error.request_id, "req_forbidden_01");
  assert.equal(Object.prototype.hasOwnProperty.call(payload.error, "stack"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.error, "authorization"), false);
});
