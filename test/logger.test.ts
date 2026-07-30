import assert from "node:assert/strict";
import { test } from "node:test";

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
