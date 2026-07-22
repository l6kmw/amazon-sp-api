import assert from "node:assert/strict";
import { test } from "node:test";

import { LegacyIdentityVerifier, createAmazonAuthenticator } from "../src/identity.js";

test("resolves a Legacy Agent token to its trusted app_user id", async () => {
  let authorization = "";
  const verifier = new LegacyIdentityVerifier({
    url: "http://127.0.0.1:8080/api/v1/admin/session",
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") || "";
      return new Response(JSON.stringify({ authenticated: true, user_id: "user-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await verifier.verify("oat_secret"), { authType: "legacy", tenantId: "user-1" });
  assert.equal(authorization, "Bearer oat_secret");
});

test("allows Docker-host HTTP and remote HTTPS identity endpoints but rejects remote plaintext", () => {
  assert.doesNotThrow(() => new LegacyIdentityVerifier({
    url: "http://host.docker.internal:8080/api/v1/admin/session",
  }));
  assert.doesNotThrow(() => new LegacyIdentityVerifier({
    url: "https://identity.example.com/api/v1/admin/session",
  }));
  assert.throws(
    () => new LegacyIdentityVerifier({ url: "http://identity.example.com/api/v1/admin/session" }),
    /HTTPS unless it targets a local endpoint/,
  );
});

test("authenticator rejects legacy credentials by default", async () => {
  let identityCalls = 0;
  const authenticate = createAmazonAuthenticator({
    legacyToken: "legacy-token-with-at-least-32-bytes",
    identityVerifier: {
      async verify() {
        identityCalls += 1;
        return { authType: "legacy" as const, tenantId: "user-2" };
      },
    },
  });

  assert.equal(await authenticate("legacy-token-with-at-least-32-bytes"), null);
  assert.deepEqual(await authenticate("oat_user"), { authType: "legacy", tenantId: "user-2" });
  assert.equal(await authenticate("wrong"), null);
  assert.equal(identityCalls, 1);
});

test("authenticator enables legacy credentials only with an explicit migration flag", async () => {
  const unbound = createAmazonAuthenticator({
    allowLegacyAuth: true,
    legacyToken: "legacy-token-with-at-least-32-bytes",
    identityVerifier: { async verify() { return null; } },
  });
  assert.deepEqual(await unbound("legacy-token-with-at-least-32-bytes"), { authType: "legacy" });

  const bound = createAmazonAuthenticator({
    allowLegacyAuth: true,
    legacyToken: "legacy-token-with-at-least-32-bytes",
    legacyTenantId: "migration-tenant",
    identityVerifier: { async verify() { return null; } },
  });
  assert.deepEqual(await bound("legacy-token-with-at-least-32-bytes"), {
    authType: "legacy",
    tenantId: "migration-tenant",
  });
});
