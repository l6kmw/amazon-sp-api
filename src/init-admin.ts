import { lstat, readFile } from "node:fs/promises";

import { Pool } from "pg";

import { initializeAdmin } from "./admin-auth.js";
import { loadConfig } from "./config.js";
import { migratePostgres } from "./postgres-migrations.js";

const username = process.env.AMAZON_ADMIN_USERNAME?.trim();
const passwordFile = process.env.AMAZON_ADMIN_PASSWORD_FILE;
if (!username) throw new Error("AMAZON_ADMIN_USERNAME is required");
if (!passwordFile) throw new Error("AMAZON_ADMIN_PASSWORD_FILE is required");

const metadata = await lstat(passwordFile);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error("administrator password path must be a regular file");
}
if ((metadata.mode & 0o077) !== 0) {
  throw new Error("administrator password file must not be accessible by group or others");
}
const password = (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "");
if (password.includes("\n") || password.includes("\r")) {
  throw new Error("administrator password file must contain exactly one line");
}

const config = await loadConfig();
if (!config.databaseUrl) throw new Error("storage.postgres is required");
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
try {
  await migratePostgres(pool);
  const result = await initializeAdmin(pool, username, password);
  console.log(result.created ? "Administrator initialized" : "Administrator already initialized");
} finally {
  await pool.end();
}
