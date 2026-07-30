import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { loadConfig } from "../src/config.js";
import { PostgresRefreshTokenStore } from "../src/postgres-token-store.js";
import { createTokenKeyringFromConfig, type TokenFile } from "../src/token-store.js";

const config = await loadConfig();
if (!config.databaseUrl) throw new Error("storage.postgres is required");

const pool = new Pool({
  connectionString: config.databaseUrl,
  min: config.postgresPool.min,
  max: config.postgresPool.max,
  idleTimeoutMillis: config.postgresPool.idleTimeoutMs,
});
const currentEncryptionKey = config.credentialKeyring.keys[
  config.credentialKeyring.currentKeyId
]!;
const store = new PostgresRefreshTokenStore({
  pool,
  encryptionKey: currentEncryptionKey,
  keyring: createTokenKeyringFromConfig(config.credentialKeyring),
  allowedSellingPartnerIds: config.allowedSellingPartnerIds,
});

try {
  await store.initialize();
  const tokens = JSON.parse(await readFile(config.tokenStoreFile, "utf8")) as TokenFile;
  await store.importEncryptedConnections(tokens);
  console.log(`Imported ${Object.keys(tokens).length} encrypted Amazon connection(s)`);
} finally {
  await pool.end();
}
