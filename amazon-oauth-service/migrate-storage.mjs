import { readFile } from "node:fs/promises";

import { PostgresTokenStore } from "./server.mjs";

const databaseUrl = process.env.AMAZON_DATABASE_URL || "";
const encryptionKey = process.env.AMAZON_TOKEN_ENCRYPTION_KEY || "";
const tokenFile = process.env.AMAZON_TOKEN_STORE_FILE ||
  `${process.env.AMAZON_DATA_DIR || "/var/lib/amazon-oauth-service"}/tokens.json`;

if (!databaseUrl) throw new Error("AMAZON_DATABASE_URL is required");

const store = new PostgresTokenStore(databaseUrl, encryptionKey);
try {
  await store.initialize();
  const tokens = JSON.parse(await readFile(tokenFile, "utf8"));
  await store.importEncryptedConnections(tokens);
  console.log(`Imported ${Object.keys(tokens).length} encrypted Amazon connection(s)`);
} finally {
  await store.close();
}
