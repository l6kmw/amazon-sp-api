import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("public Nginx exposes the admin console and frozen Amazon APIs without detailed readiness", async () => {
  const nginx = await readFile("deploy/api.example.com.nginx", "utf8");

  for (const location of [
    "location = /",
    "location = /admin-config.js",
    "location ^~ /assets/",
    "location ^~ /api/v1/admin/",
    "location ^~ /amazon/api/",
    "location ^~ /oauth/amazon/",
    "location = /mcp/amazon",
    "location = /mcp/amazon/healthz",
  ]) assert.ok(nginx.includes(location), location);
  assert.match(nginx, /location = \/mcp\/amazon\s*\{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8789\/mcp;/s);
  assert.doesNotMatch(nginx, /location\s+=\s+\/amazon\b/);
  assert.doesNotMatch(nginx, /location\s+=\s+\/readyz\b/);
  assert.doesNotMatch(nginx, /location\s+\^~\s+\/api\/\s/);
});
