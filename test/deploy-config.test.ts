import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("public Nginx exposes the admin console and frozen Amazon APIs without detailed readiness", async () => {
  const nginx = await readFile("deploy/api.example.com.nginx", "utf8");

  for (const location of [
    "location = /",
    "location = /admin-config.js",
    "location = /company",
    "location = /privacy",
    "location ^~ /assets/",
    "location ^~ /api/v1/admin/",
    "location ^~ /amazon/api/",
    "location ^~ /oauth/amazon/",
    "location ^~ /oauth/amazon-ads/",
    "location = /mcp/amazon",
    "location = /mcp/amazon/healthz",
    "location = /mcp/amazon-ads",
    "location = /mcp/amazon-ads/healthz",
    "location = /amazon-ads/.well-known/connected-account",
    "location ^~ /amazon-ads/connected-account/v1/",
  ]) assert.ok(nginx.includes(location), location);
  assert.match(nginx, /location = \/mcp\/amazon\s*\{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8789\/mcp;/s);
  assert.match(nginx, /location = \/mcp\/amazon-ads\s*\{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8790\/mcp;/s);
  assert.doesNotMatch(nginx, /location\s+=\s+\/amazon(?:\s|\{)/);
  assert.doesNotMatch(nginx, /location\s+=\s+\/readyz\b/);
  assert.doesNotMatch(nginx, /location\s+\^~\s+\/api\/\s/);
});

test("Docker packaging excludes local secrets and produces traceable amd64 images", async () => {
  const [dockerignore, dockerfile, compose] = await Promise.all([
    readFile(".dockerignore", "utf8"),
    readFile("docker/Dockerfile", "utf8"),
    readFile("docker-compose.yml", "utf8"),
  ]);
  const ignored = new Set(dockerignore.split(/\r?\n/u));

  for (const path of [".api", "config.yaml", "config.local.yaml", "data/", ".learnings/"]) {
    assert.ok(ignored.has(path), `${path} must be excluded from the Docker build context`);
  }
  for (const label of [
    "org.opencontainers.image.source",
    "org.opencontainers.image.revision",
    "org.opencontainers.image.version",
    "com.example.release",
  ]) assert.ok(dockerfile.includes(label), label);
  assert.match(compose, /platform: \$\{AMAZON_PLATFORM:-linux\/amd64\}/u);
  assert.match(compose, /image: \$\{AMAZON_IMAGE_REPOSITORY:-amazon-sp-api\}:\$\{AMAZON_IMAGE_TAG:-local\}/u);
  assert.match(compose, /image: \$\{AMAZON_ADS_IMAGE_REPOSITORY:-amazon-ads-mcp\}:\$\{AMAZON_ADS_IMAGE_TAG:-local\}/u);
  assert.match(compose, /127\.0\.0\.1:\$\{AMAZON_ADS_PORT:-8790\}:8790/u);
  assert.match(compose, /network_mode: "service:amazon-sp-api"/u);
  assert.match(compose, /logging:\s+driver: json-file\s+options:\s+max-size: "10m"\s+max-file: "5"/u);
});
