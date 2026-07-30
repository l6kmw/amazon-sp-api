import assert from "node:assert/strict";
import { test } from "node:test";

import { MetricsRegistry, isLoopbackAddress } from "../src/metrics.js";

test("renders low-cardinality prometheus text and collapses unknown labels", () => {
  const registry = new MetricsRegistry();
  registry.inc("mcp_tool_results_total", "tool results", {
    tool: "amazon_get_order",
    result: "success",
    actor_type: "connected-account",
  });
  registry.inc("mcp_tool_results_total", "tool results", {
    tool: "amazon_list_accounts",
    result: "success",
    actor_type: "test_agent",
  });
  registry.inc("mcp_tool_results_total", "tool results", {
    tool: "evil;drop",
    result: "weird",
    actor_type: "nope",
    request_id: "should-not-appear",
  } as Record<string, string>);
  registry.observeSeconds("mcp_tool_duration_seconds", "duration", 0.12, {
    tool: "amazon_get_order",
    result: "success",
  });
  registry.setGauge("readiness", "dependency readiness", 1, { dependency: "postgres" });

  const text = registry.renderPrometheus();
  assert.match(text, /amazon_connected-account_mcp_tool_results_total/);
  assert.match(text, /tool="amazon_get_order"/);
  assert.match(text, /actor_type="test_agent"/);
  assert.match(text, /tool="unknown"/);
  assert.match(text, /result="unknown"/);
  assert.match(text, /amazon_connected-account_mcp_tool_duration_seconds_bucket/);
  assert.match(text, /dependency="postgres"/);
  assert.doesNotMatch(text, /request_id|evil|should-not-appear/);
});

test("classifies loopback metrics clients", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
});
