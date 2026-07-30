import { Pool } from "pg";

import { loadConfig } from "../src/config.js";
import {
  createKeyring,
  decryptSecret,
  encryptSecret,
  isLegacyUnversionedEnvelope,
  isVersionedEnvelope,
} from "../src/token-crypto.js";

const config = await loadConfig();
if (!config.databaseUrl) throw new Error("storage.postgres is required");
const apply = process.argv.includes("--apply");
const batchArgument = process.argv.find((value) => value.startsWith("--batch="));
const batch = Math.min(500, Math.max(1, Number(batchArgument?.split("=", 2)[1] ?? 100) || 100));
const keyring = createKeyring(config.credentialKeyring);
const poolMax = Math.min(4, config.postgresPool.max);
const pool = new Pool({
  connectionString: config.databaseUrl,
  min: Math.min(config.postgresPool.min, poolMax),
  max: poolMax,
  idleTimeoutMillis: config.postgresPool.idleTimeoutMs,
});
const stats = {
  total: 0,
  legacy: 0,
  versioned: 0,
  unknown: 0,
  reencrypted: 0,
  failed: 0,
  skipped: 0,
};

try {
  await pool.query(`
    ALTER TABLE amazon_sp_api.oauth_connection
      ADD COLUMN IF NOT EXISTS credential_revision BIGINT NOT NULL DEFAULT 1
  `);
  const rows = await pool.query(`
    SELECT selling_partner_id, tenant_id, refresh_token, credential_revision, status
    FROM amazon_sp_api.oauth_connection
    WHERE refresh_token IS NOT NULL
    ORDER BY selling_partner_id
  `);
  for (let offset = 0; offset < rows.rows.length; offset += batch) {
    for (const row of rows.rows.slice(offset, offset + batch)) {
      stats.total += 1;
      const envelope = row.refresh_token;
      if (isLegacyUnversionedEnvelope(envelope)) stats.legacy += 1;
      else if (isVersionedEnvelope(envelope)) stats.versioned += 1;
      else {
        stats.unknown += 1;
        continue;
      }
      if (!apply) continue;
      if (isVersionedEnvelope(envelope) && envelope.key_id === keyring.currentKeyId) {
        stats.skipped += 1;
        continue;
      }
      try {
        const plaintext = decryptSecret(envelope, keyring, {
          credentialId: row.selling_partner_id,
        });
        const next = encryptSecret(plaintext, keyring, {
          credentialId: row.selling_partner_id,
        });
        const updated = await pool.query(`
          UPDATE amazon_sp_api.oauth_connection
          SET refresh_token = $1,
              credential_revision = credential_revision + 1,
              updated_at = NOW()
          WHERE selling_partner_id = $2
            AND tenant_id = $3
            AND status = $4
            AND credential_revision = $5
          RETURNING selling_partner_id
        `, [
          next,
          row.selling_partner_id,
          row.tenant_id,
          row.status,
          row.credential_revision,
        ]);
        if ((updated.rowCount ?? 0) === 0) stats.skipped += 1;
        else stats.reencrypted += 1;
      } catch {
        stats.failed += 1;
      }
    }
  }
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    currentKeyId: keyring.currentKeyId,
    batch,
    stats: {
      ...stats,
      labels: { legacy: "legacy-unversioned", versioned: "v2" },
    },
  }));
  if (stats.failed > 0) process.exitCode = 2;
} finally {
  await pool.end();
}
