import assert from "node:assert/strict";
import { test } from "node:test";

import { PrincipalRequestLimiter } from "../src/rate-limit.js";

test("limits concurrent requests per principal and releases idempotently", () => {
  const limiter = new PrincipalRequestLimiter({ requestsPerMinute: 10, maxConcurrent: 1 });
  const first = limiter.acquire("tenant-1");
  assert.equal(first.accepted, true);
  assert.deepEqual(limiter.acquire("tenant-1"), {
    accepted: false,
    reason: "concurrency",
    retryAfterSeconds: 1,
  });
  if (first.accepted) {
    first.release();
    first.release();
  }
  assert.equal(limiter.acquire("tenant-1").accepted, true);
  assert.equal(limiter.acquire("tenant-2").accepted, true);
});

test("limits requests per minute and resets the fixed window", () => {
  let now = 1_000;
  const limiter = new PrincipalRequestLimiter({
    requestsPerMinute: 2,
    maxConcurrent: 2,
    now: () => now,
  });
  for (let index = 0; index < 2; index += 1) {
    const result = limiter.acquire("tenant-1");
    assert.equal(result.accepted, true);
    if (result.accepted) result.release();
  }
  assert.deepEqual(limiter.acquire("tenant-1"), {
    accepted: false,
    reason: "rate",
    retryAfterSeconds: 60,
  });
  now += 60_000;
  assert.equal(limiter.acquire("tenant-1").accepted, true);
});

test("removes expired inactive principals without dropping active requests", () => {
  let now = 1_000;
  const limiter = new PrincipalRequestLimiter({
    requestsPerMinute: 10,
    maxConcurrent: 2,
    now: () => now,
  });
  const inactive = limiter.acquire("tenant-inactive");
  const active = limiter.acquire("tenant-active");
  assert.equal(inactive.accepted, true);
  assert.equal(active.accepted, true);
  if (inactive.accepted) inactive.release();
  assert.equal(limiter.trackedPrincipalCount, 2);

  now += 60_000;
  const firstTrigger = limiter.acquire("tenant-new");
  assert.equal(firstTrigger.accepted, true);
  if (firstTrigger.accepted) firstTrigger.release();
  assert.equal(limiter.trackedPrincipalCount, 2);

  if (active.accepted) active.release();
  now += 60_000;
  const secondTrigger = limiter.acquire("tenant-current");
  assert.equal(secondTrigger.accepted, true);
  assert.equal(limiter.trackedPrincipalCount, 1);
});
