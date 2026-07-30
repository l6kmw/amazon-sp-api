import assert from "node:assert/strict";
import { test } from "node:test";

import { hashAdminPassword, verifyAdminPassword } from "../src/admin-auth.js";

test("hashes administrator passwords with a salted versioned scrypt envelope", async () => {
  const password = "correct horse battery staple";
  const first = await hashAdminPassword(password);
  const second = await hashAdminPassword(password);

  assert.match(first, /^scrypt\$v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(await verifyAdminPassword(password, first), true);
  assert.equal(await verifyAdminPassword("wrong password", first), false);
  assert.equal(await verifyAdminPassword(password, "invalid"), false);
  assert.doesNotMatch(first, new RegExp(password));
});

test("rejects weak administrator bootstrap passwords", async () => {
  await assert.rejects(hashAdminPassword("too-short"), /between 12 and 1024/);
});
