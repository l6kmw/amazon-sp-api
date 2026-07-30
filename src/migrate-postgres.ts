import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { migratePostgres, POSTGRES_SCHEMA_VERSION } from "./postgres-migrations.js";

const config = await loadConfig();
if (!config.databaseUrl) throw new Error("storage.postgres is required");

const pool = new Pool({
  connectionString: config.databaseUrl,
  min: config.postgresPool.min,
  max: config.postgresPool.max,
  idleTimeoutMillis: config.postgresPool.idleTimeoutMs,
});

try {
  await migratePostgres(pool);
  console.log(`PostgreSQL schema is at version ${POSTGRES_SCHEMA_VERSION}`);
} finally {
  await pool.end();
}
