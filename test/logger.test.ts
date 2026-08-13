import assert from "node:assert/strict";
import { test } from "node:test";

import { runWithToolRequestContext } from "../src/errors.js";
import { createStructuredLogger } from "../src/logger.js";

test("writes allowlisted structured logs without raw identifiers", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "internal-secret",
    service: "mcp",
    write(line) {
      lines.push(line);
    },
  });

  logger.write("info", "mcp.tool.completed", {
    request_id: "req_fixed_logger_01",
    tool: "amazon_get_order",
    actor_type: "connected-account",
    result: "success",
    duration_ms: 12.5,
    tenantHash: logger.hash("tenant-secret"),
    sellerHash: logger.hash("seller-secret"),
    authorization: "Bearer secret",
    nested: { evil: true },
    event: "overridden",
  });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.event, "mcp.tool.completed");
  assert.equal(record.service, "mcp");
  assert.equal(record.tool, "amazon_get_order");
  assert.equal(record.request_id, "req_fixed_logger_01");
  assert.equal(record.tenantHash, undefined);
  assert.equal(record.authorization, undefined);
  assert.equal(record.nested, undefined);
  assert.doesNotMatch(lines[0]!, /tenant-secret|seller-secret|Bearer secret|internal-secret/);

  logger.write("info", "mcp.request.completed", {
    request_id: "req_test_agent_01",
    method: "tools/list",
    actor_type: "test_agent",
    actor_id_hash: logger.hash("diagnostic-agent"),
    result: "success",
    duration_ms: 3,
  });
  const agentRecord = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.equal(agentRecord.actor_type, "test_agent");
  assert.equal(agentRecord.actor_id_hash, logger.hash("diagnostic-agent"));
  assert.doesNotMatch(lines[1]!, /diagnostic-agent/);
});

test("drops unknown events and invalid field types", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "internal-secret",
    write(line) { lines.push(line); },
  });
  logger.write("info", "not_in_dictionary", { request_id: "req_xxxxxxxx" });
  assert.equal(lines.length, 0);
  assert.ok(logger.droppedCount() >= 1);

  logger.write("info", "logger.self_test", {
    request_id: "short",
    duration_ms: -1,
    status: "ok",
  });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.request_id, undefined);
  assert.equal(record.duration_ms, undefined);
  assert.equal(record.status, "ok");
});

test("allows numeric upstream status only on SP-API failure events", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "internal-secret",
    write(line) { lines.push(line); },
  });

  for (const upstreamStatus of [403, "403", 99, 600]) {
    logger.write("warn", "sp_api.request.failed", {
      operation: "search_listings",
      result: "error",
      error_code: "upstream_error",
      attempt: 1,
      upstream_status: upstreamStatus,
    });
  }
  logger.write("info", "sp_api.request.completed", {
    operation: "search_listings",
    result: "success",
    attempt: 1,
    upstream_status: 200,
  });

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records[0]?.upstream_status, 403);
  for (const record of records.slice(1)) assert.equal(record.upstream_status, undefined);
});

test("logs pagination budget exhaustion without continuation or account identifiers", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "pagination-budget-test",
    write(line) { lines.push(line); },
  });

  logger.write("warn", "mcp.pagination.budget_exhausted", {
    tool: "amazon_search_orders",
    pages_completed: 2,
    budget_ms: 50_000,
    duration_ms: 49_500,
    result: "success",
    pagination_token: "secret-next-token",
    account_id: "acct_0123456789abcdef",
    seller_id: "A1SELLER",
  });

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.event, "mcp.pagination.budget_exhausted");
  assert.equal(record.tool, "amazon_search_orders");
  assert.equal(record.pages_completed, 2);
  assert.equal(record.budget_ms, 50_000);
  assert.equal(record.duration_ms, 49_500);
  assert.equal(record.result, "success");
  assert.doesNotMatch(lines[0]!, /secret-next-token|acct_|A1SELLER/);
});

test("inherits the tool request ID and isolates concurrent log contexts", async () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    hashKey: "request-context-test",
    write(line) { lines.push(line); },
  });

  await Promise.all([
    runWithToolRequestContext({ requestId: "req_context_a" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      logger.write("warn", "sp_api.request.failed", {
        operation: "search_orders",
        error_code: "upstream_error",
        result: "error",
        attempt: 1,
      });
    }),
    runWithToolRequestContext({ requestId: "req_context_b" }, async () => {
      logger.write("error", "lwa.refresh.failed", {
        request_id: "req_wrong_id",
        error_code: "lwa_failed",
        result: "error",
        attempt: 1,
      });
    }),
  ]);

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const spApi = records.find((record) => record.event === "sp_api.request.failed");
  const lwa = records.find((record) => record.event === "lwa.refresh.failed");
  assert.equal(spApi?.request_id, "req_context_a");
  assert.equal(lwa?.request_id, "req_context_b");
  assert.doesNotMatch(lines.join("\n"), /req_wrong_id/);
});
