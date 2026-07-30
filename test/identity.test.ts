import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConnectedAccountJwtVerifier } from "../src/connected-account.js";
import { createAmazonAuthenticator } from "../src/identity.js";

const principal = {
  issuer: "https://connected-account.example",
  employeeId: "employee-1",
  kid: "provider-v1",
  expiresAt: "2026-07-28T10:00:00.000Z",
  scopes: new Set(["mcp:invoke"]),
  workspaceId: "jwt-employee:workspace",
};

test("accepts only locally verified ConnectedAccount JWT identities", async () => {
  let calls = 0;
  const authenticate = createAmazonAuthenticator({
    connected-accountVerifier: {
      verify(token: string) {
        calls += 1;
        return token === "valid-connected-account-jwt" ? principal : null;
      },
    } as ConnectedAccountJwtVerifier,
  });
  assert.deepEqual(await authenticate("valid-connected-account-jwt"), {
    authType: "connected-account",
    credentialKind: "employee_jwt",
    tenantId: principal.workspaceId,
    issuer: principal.issuer,
    employeeId: principal.employeeId,
    kid: principal.kid,
    expiresAt: principal.expiresAt,
    scopes: principal.scopes,
  });
  assert.equal(await authenticate("oat_user"), null);
  assert.equal(await authenticate("shared-bearer-token"), null);
  assert.equal(calls, 2);
});

test("routes oat tokens only to the independent Test Agent verifier", async () => {
  let jwtCalls = 0;
  let agentCalls = 0;
  const authenticate = createAmazonAuthenticator({
    connected-accountVerifier: {
      verify() {
        jwtCalls += 1;
        throw new Error("oat token must not reach JWT parsing");
      },
    } as unknown as ConnectedAccountJwtVerifier,
    async authenticateTestAgent(token) {
      agentCalls += 1;
      return token === `oat_${"a".repeat(43)}` ? {
        authType: "test_agent",
        credentialKind: "test_agent_token",
        tenantId: "tenant-1",
        agentRecordId: "agent_record_1",
        agentId: "diagnostic-agent",
        scopes: new Set(["mcp:invoke"]),
      } : null;
    },
  });
  assert.equal((await authenticate(`oat_${"a".repeat(43)}`))?.authType, "test_agent");
  assert.equal(await authenticate(`oat_${"b".repeat(43)}`), null);
  assert.equal(jwtCalls, 0);
  assert.equal(agentCalls, 2);
  assert.equal(await authenticate("not-an-oat"), null);
  assert.equal(jwtCalls, 1);
});

test("connected-account.enabled=false produces a closed authenticator", async () => {
  const authenticate = createAmazonAuthenticator({});
  assert.equal(await authenticate("anything"), null);
});
