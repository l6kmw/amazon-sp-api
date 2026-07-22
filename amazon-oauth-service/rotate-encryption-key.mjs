#!/usr/bin/env node
/**
 * Expand/contract Refresh Token envelope re-encryption.
 *
 * Dry-run (default): counts legacy vs versioned envelopes; never prints secrets.
 * Apply: re-encrypts with current key as version=2 using AAD binding.
 *
 * Required env:
 *   AMAZON_DATABASE_URL
 *   AMAZON_TOKEN_ENCRYPTION_KEY (or AMAZON_TOKEN_ENCRYPTION_CURRENT_KEY + KEYRING)
 * Optional:
 *   AMAZON_TOKEN_ENCRYPTION_APPLY=true  to write
 *   AMAZON_TOKEN_ENCRYPTION_BATCH=100
 */
import { Pool } from "pg";

import {
  createSingleKeyKeyring,
  decryptSecret,
  encryptSecret,
  envelopeVersionLabel,
  isLegacyUnversionedEnvelope,
  isVersionedEnvelope,
} from "./token-crypto.mjs";

const databaseUrl = process.env.AMAZON_DATABASE_URL || "";
const encryptionKey = process.env.AMAZON_TOKEN_ENCRYPTION_KEY || "";
const apply = process.env.AMAZON_TOKEN_ENCRYPTION_APPLY === "true";
const batch = Math.min(
  500,
  Math.max(1, Number(process.env.AMAZON_TOKEN_ENCRYPTION_BATCH || 100) || 100),
);

if (!databaseUrl) {
  console.error("AMAZON_DATABASE_URL is required");
  process.exit(1);
}
if (!encryptionKey) {
  console.error("AMAZON_TOKEN_ENCRYPTION_KEY is required");
  process.exit(1);
}

const keyring = createSingleKeyKeyring(encryptionKey, "k0");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

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

  // Dry-run inventory first (also used for apply batching).
  const rows = await pool.query(`
    SELECT selling_partner_id, tenant_id, refresh_token, credential_revision, status
    FROM amazon_sp_api.oauth_connection
    WHERE refresh_token IS NOT NULL
    ORDER BY selling_partner_id
  `);

  for (const row of rows.rows) {
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
      if ((updated.rowCount ?? 0) === 0) {
        stats.skipped += 1;
      } else {
        stats.reencrypted += 1;
      }
    } catch {
      stats.failed += 1;
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    currentKeyId: keyring.currentKeyId,
    batch,
    stats: {
      ...stats,
      // Never include sample ciphertext or versions that embed secrets.
      labels: {
        legacy: "legacy-unversioned",
        versioned: "v2",
      },
    },
  }));
  if (stats.failed > 0) process.exitCode = 2;
} finally {
  await pool.end();
}
