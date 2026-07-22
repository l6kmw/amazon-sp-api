import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient } from "redis";

import { LwaAccessTokenProvider } from "../src/lwa.js";
import { RedisAccessTokenCoordinator } from "../src/redis-coordinator.js";

const redisUrl = process.env.TEST_REDIS_URL;

test("coordinates LWA exchange and invalidation across instances with Redis", {
  skip: !redisUrl,
}, async () => {
  const namespace = `amazon-sp-api-test-${process.pid}-${Date.now()}`;
  const firstCoordinator = new RedisAccessTokenCoordinator({ redisUrl, namespace });
  const secondCoordinator = new RedisAccessTokenCoordinator({ redisUrl, namespace });
  const inspector = createClient({ url: redisUrl });
  inspector.on("error", () => {});
  await inspector.connect();
  let exchanges = 0;
  const fetchImpl = (async () => {
    exchanges += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(JSON.stringify({
      access_token: `shared-access-${exchanges}`,
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const refreshTokens = { async getRefreshToken() { return "refresh-token"; } };
  const first = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens,
    fetchImpl,
    coordinator: firstCoordinator,
  });
  const second = new LwaAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshTokens,
    fetchImpl,
    coordinator: secondCoordinator,
  });
  try {
    assert.deepEqual(await Promise.all([
      first.getAccessToken("A1REDIS", "tenant-1"),
      second.getAccessToken("A1REDIS", "tenant-1"),
    ]), ["shared-access-1", "shared-access-1"]);
    assert.equal(exchanges, 1);

    assert.equal(
      await second.getAccessToken("A1REDIS", "tenant-1", true),
      "shared-access-2",
    );
    assert.equal(exchanges, 2);
    await first.invalidateAccessToken("A1REDIS", "tenant-1");
    assert.equal(
      await second.getAccessToken("A1REDIS", "tenant-1"),
      "shared-access-3",
    );
    assert.equal(exchanges, 3);

    const keys = await inspector.keys(`${namespace}:*`);
    assert.ok(keys.length > 0);
    assert.doesNotMatch(keys.join("\n"), /A1REDIS|tenant-1/);
    assert.equal(await firstCoordinator.checkHealth(), "ok");
  } finally {
    const keys = await inspector.keys(`${namespace}:*`);
    if (keys.length > 0) await inspector.del(keys);
    await inspector.close();
    await firstCoordinator.close();
    await secondCoordinator.close();
  }
});
