import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "pg";

import { PostgresRefreshTokenStore } from "../src/postgres-token-store.js";
import { createTokenKeyringFromConfig, encryptSecret } from "../src/token-store.js";

test("reads a database-authorized seller without a legacy static allowlist", async () => {
  const encryptionKey = Buffer.alloc(32, 17).toString("base64");
  const keyring = createTokenKeyringFromConfig({ encryptionKey });
  const sellingPartnerId = "A1DATABASE";
  const tenantId = "credential-owner";
  const pool = {
    async query() {
      return {
        rows: [{
          tenant_id: tenantId,
          refresh_token: encryptSecret("refresh-token", keyring, sellingPartnerId),
          credential_revision: 3,
          credential_id: "cred_database",
          credential_owner_id: tenantId,
        }],
      };
    },
  } as unknown as Pool;
  const store = new PostgresRefreshTokenStore({
    pool,
    encryptionKey,
    keyring,
  });

  assert.deepEqual(await store.getRefreshCredential(sellingPartnerId, tenantId), {
    refreshToken: "refresh-token",
    revision: 3,
    credentialId: "cred_database",
    credentialOwnerId: tenantId,
  });
});
