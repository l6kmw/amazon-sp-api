import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { ConnectedAccountJwtVerifier, connectedAccountWorkspaceId } from "../src/connected-account.js";
import { createAmazonAuthenticator } from "../src/identity.js";

const NOW = 1_784_559_000;
const KEY = { kid: "provider-v1", issuer: "example-issuer-prod", secret: "s".repeat(32) };

function jwt(options: {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  secret?: string;
} = {}): string {
  const header = Buffer.from(JSON.stringify(options.header ?? {
    alg: "HS256",
    typ: "JWT",
    kid: KEY.kid,
  })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(options.payload ?? {
    iss: KEY.issuer,
    sub: "employee-1",
    aud: "amazon-sp-api-account-service",
    scope: "mcp:invoke connected_accounts:manage",
    jti: "token-1",
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
  })).toString("base64url");
  const signature = createHmac("sha256", options.secret ?? KEY.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifier(keys = [KEY]) {
  return new ConnectedAccountJwtVerifier({
    audience: "amazon-sp-api-account-service",
    keys,
    now: () => NOW,
  });
}

test("verifies strict ConnectedAccount Employee JWT claims and derives an issuer-scoped workspace", () => {
  const identity = verifier().verify(jwt());
  assert.ok(identity);
  assert.equal(identity.issuer, "example-issuer-prod");
  assert.equal(identity.employeeId, "employee-1");
  assert.equal(identity.kid, "provider-v1");
  assert.equal(identity.expiresAt, new Date((NOW + 300) * 1_000).toISOString());
  assert.deepEqual([...identity.scopes], ["mcp:invoke", "connected_accounts:manage"]);
  assert.equal(identity.workspaceId, connectedAccountWorkspaceId("example-issuer-prod", "employee-1"));
  assert.notEqual(
    identity.workspaceId,
    connectedAccountWorkspaceId("example-issuer-staging", "employee-1"),
  );
});

test("rejects invalid ConnectedAccount JWT headers, signatures, claims, and times", () => {
  const validPayload = {
    iss: KEY.issuer,
    sub: "employee-1",
    aud: "amazon-sp-api-account-service",
    scope: "mcp:invoke",
    jti: "token-1",
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
  };
  const invalidTokens = [
    "not-a-jwt",
    jwt({ header: { alg: "none", typ: "JWT", kid: KEY.kid } }),
    jwt({ header: { alg: "HS256", kid: KEY.kid } }),
    jwt({ header: { alg: "HS256", typ: "JWT", kid: "unknown" } }),
    jwt({ secret: "x".repeat(32) }),
    jwt({ payload: { ...validPayload, iss: "wrong" } }),
    jwt({ payload: { ...validPayload, aud: "wrong" } }),
    jwt({ payload: { ...validPayload, jti: undefined } }),
    jwt({ payload: { ...validPayload, scope: "" } }),
    jwt({ payload: { ...validPayload, exp: NOW + 301 } }),
    jwt({ payload: { ...validPayload, exp: NOW - 31 } }),
    jwt({ payload: { ...validPayload, iat: NOW + 31, nbf: NOW + 31, exp: NOW + 100 } }),
  ];
  for (const token of invalidTokens) assert.equal(verifier().verify(token), null);

  const arrayAudience = jwt({
    payload: { ...validPayload, aud: ["another-service", "amazon-sp-api-account-service"] },
  });
  assert.ok(verifier().verify(arrayAudience));
});

test("authenticator accepts only locally verified ConnectedAccount JWTs", async () => {
  const authenticate = createAmazonAuthenticator({
    connectedAccountVerifier: verifier(),
  });

  assert.equal((await authenticate(jwt()))?.authType, "employee_jwt");
  assert.equal(await authenticate("oat_user"), null);
  assert.equal(await authenticate("old-shared-token"), null);
  assert.equal(await authenticate("wrong"), null);
});
