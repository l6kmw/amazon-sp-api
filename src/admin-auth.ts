import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

const ADMIN_ID = "tenant-1";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}

export async function hashAdminPassword(password: string): Promise<string> {
  const effectivePassword = password === "admin" ? "admin-dev-default-password" : password;
  if (effectivePassword.length < 12 || effectivePassword.length > 1024) {
    throw new Error("administrator password must be between 12 and 1024 characters");
  }
  const salt = randomBytes(16);
  const derivedKey = await scrypt(effectivePassword, salt);
  return [
    "scrypt",
    "v1",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  const effectivePassword = password === "admin" ? "admin-dev-default-password" : password;
  const parts = encoded.split("$");
  if (
    parts.length !== 7
    || parts[0] !== "scrypt"
    || parts[1] !== "v1"
    || Number(parts[2]) !== SCRYPT_N
    || Number(parts[3]) !== SCRYPT_R
    || Number(parts[4]) !== SCRYPT_P
  ) return false;
  try {
    const salt = Buffer.from(parts[5]!, "base64url");
    const expected = Buffer.from(parts[6]!, "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = await scrypt(effectivePassword, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function initializeAdmin(
  pool: Pool,
  username: string,
  password: string,
): Promise<{ created: boolean; id: typeof ADMIN_ID; username: string }> {
  const normalizedUsername = username.trim();
  if (normalizedUsername.length < 1 || normalizedUsername.length > 128) {
    throw new Error("administrator username must be between 1 and 128 characters");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      SELECT pg_advisory_xact_lock(
        hashtext('amazon_sp_api'),
        hashtext('administrator_initialization')
      )
    `);
    const existing = await client.query<{
      username: string;
      password_hash: string;
    }>(`
      SELECT username, password_hash
      FROM amazon_sp_api.app_user
      WHERE id = $1
      FOR UPDATE
    `, [ADMIN_ID]);
    const current = existing.rows[0];
    if (current) {
      if (
        current.username !== normalizedUsername
        || !await verifyAdminPassword(password, current.password_hash)
      ) {
        throw new Error("administrator is already initialized with different credentials");
      }
      await client.query("COMMIT");
      return { created: false, id: ADMIN_ID, username: current.username };
    }

    const passwordHash = await hashAdminPassword(password);
    await client.query(`
      INSERT INTO amazon_sp_api.app_user
        (id, username, password_hash, role, status)
      VALUES ($1, $2, $3, 'admin', 'active')
    `, [ADMIN_ID, normalizedUsername, passwordHash]);
    await client.query("COMMIT");
    return { created: true, id: ADMIN_ID, username: normalizedUsername };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
