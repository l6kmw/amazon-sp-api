import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { backfillPostgresAccountLifecycle } from "./postgres-backfill.js";
import { createTokenKeyringFromConfig, decryptSecret } from "./token-store.js";

const config = await loadConfig();
if (!config.databaseUrl) throw new Error("storage.postgres is required");

const pool = new Pool({
  connectionString: config.databaseUrl,
  min: config.postgresPool.min,
  max: config.postgresPool.max,
  idleTimeoutMillis: config.postgresPool.idleTimeoutMs,
});
const keyring = createTokenKeyringFromConfig(config.credentialKeyring);

try {
  const result = await backfillPostgresAccountLifecycle(
    pool,
    (sellingPartnerId, token) => { decryptSecret(token, keyring, sellingPartnerId); },
  );
  console.log(`Account lifecycle backfill complete: ${JSON.stringify(result)}`);
} finally {
  await pool.end();
}
