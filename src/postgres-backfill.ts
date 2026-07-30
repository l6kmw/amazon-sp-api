import type { Pool } from "pg";

import type { EncryptedSecret } from "./token-store.js";

export const ACCOUNT_LIFECYCLE_BACKFILL = "account_lifecycle_v1";

export interface AccountLifecycleBackfillResult {
  accounts: number;
  credentials: number;
  activeBindings: number;
}

interface CountRow {
  accounts: number;
  credentials: number;
  active_bindings: number;
}

function count(value: number | string): number {
  return Number(value);
}

export async function backfillPostgresAccountLifecycle(
  pool: Pool,
  verifyEncryptedToken: (sellingPartnerId: string, token: EncryptedSecret) => void,
): Promise<AccountLifecycleBackfillResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      SELECT pg_advisory_xact_lock(
        hashtext('amazon_sp_api'),
        hashtext('account_lifecycle_backfill')
      )
    `);

    const completed = await client.query<{ details: AccountLifecycleBackfillResult }>(`
      SELECT details FROM amazon_sp_api.data_backfill WHERE name = $1
    `, [ACCOUNT_LIFECYCLE_BACKFILL]);
    if (completed.rows[0]) {
      await client.query("COMMIT");
      return completed.rows[0].details;
    }

    const readiness = await client.query<{
      accounts_without_grant: number | string;
      accounts_with_multiple_issuers: number | string;
      accounts_without_oauth: number | string;
      oauth_without_account: number | string;
    }>(`
      WITH account_grants AS (
        SELECT a.account_id,
               COUNT(g.connection_id) AS grant_count,
               COUNT(DISTINCT g.issuer) AS issuer_count
        FROM amazon_sp_api.external_account_credential a
        LEFT JOIN amazon_sp_api.connection_grant g ON g.account_id = a.account_id
        GROUP BY a.account_id
      ), account_oauth AS (
        SELECT a.account_id, o.selling_partner_id
        FROM amazon_sp_api.external_account_credential a
        LEFT JOIN amazon_sp_api.oauth_connection o
          ON o.selling_partner_id = a.external_account_id
         AND o.tenant_id = a.owner_workspace_id
      ), oauth_accounts AS (
        SELECT o.selling_partner_id, a.account_id
        FROM amazon_sp_api.oauth_connection o
        LEFT JOIN amazon_sp_api.external_account_credential a
          ON a.external_account_id = o.selling_partner_id
         AND a.owner_workspace_id = o.tenant_id
      )
      SELECT
        (SELECT COUNT(*) FROM account_grants WHERE grant_count = 0) AS accounts_without_grant,
        (SELECT COUNT(*) FROM account_grants WHERE issuer_count > 1) AS accounts_with_multiple_issuers,
        (SELECT COUNT(*) FROM account_oauth WHERE selling_partner_id IS NULL) AS accounts_without_oauth,
        (SELECT COUNT(*) FROM oauth_accounts WHERE account_id IS NULL) AS oauth_without_account
    `);
    const blockers = readiness.rows[0]!;
    const blockerCount = Object.values(blockers).reduce((total: number, value: unknown) => total + count(value as string | number), 0);
    if (blockerCount > 0) {
      throw new Error(`account lifecycle backfill blocked: ${JSON.stringify(blockers)}`);
    }

    const encrypted = await client.query<{
      selling_partner_id: string;
      refresh_token: EncryptedSecret;
    }>(`
      SELECT selling_partner_id, refresh_token
      FROM amazon_sp_api.oauth_connection
      WHERE refresh_token IS NOT NULL
      ORDER BY selling_partner_id
    `);
    for (const row of encrypted.rows) {
      verifyEncryptedToken(row.selling_partner_id, row.refresh_token);
    }

    await client.query(`
      INSERT INTO amazon_sp_api.amazon_account
        (account_id, provider_key, issuer_scope, selling_partner_id, display_name, status,
         authorized_at, created_at, updated_at)
      SELECT a.account_id, a.provider_key, MIN(g.issuer), a.external_account_id,
             a.display_name, a.status, a.authorized_at, a.created_at, a.updated_at
      FROM amazon_sp_api.external_account_credential a
      JOIN amazon_sp_api.connection_grant g ON g.account_id = a.account_id
      GROUP BY a.account_id
      ON CONFLICT (account_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        status = EXCLUDED.status,
        authorized_at = EXCLUDED.authorized_at,
        updated_at = EXCLUDED.updated_at
    `);
    await client.query(`
      INSERT INTO amazon_sp_api.amazon_credential
        (credential_id, account_id, credential_owner_id, encrypted_refresh_token,
         refresh_token_revision, status, authorized_at, created_at, updated_at)
      SELECT 'cred_' || a.account_id, a.account_id, a.owner_workspace_id, o.refresh_token,
             o.credential_revision,
             CASE WHEN o.status = 'active' AND o.refresh_token IS NOT NULL THEN 'active' ELSE 'revoked' END,
             o.authorized_at, o.created_at, o.updated_at
      FROM amazon_sp_api.external_account_credential a
      JOIN amazon_sp_api.oauth_connection o
        ON o.selling_partner_id = a.external_account_id
       AND o.tenant_id = a.owner_workspace_id
      ON CONFLICT (account_id, credential_owner_id) DO UPDATE SET
        encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        refresh_token_revision = EXCLUDED.refresh_token_revision,
        status = EXCLUDED.status,
        authorized_at = EXCLUDED.authorized_at,
        updated_at = EXCLUDED.updated_at
    `);
    await client.query(`
      UPDATE amazon_sp_api.connection_grant g
      SET credential_id = c.credential_id,
          authorized_by_type = 'employee',
          authorized_by_id = g.owner_employee_id
      FROM amazon_sp_api.amazon_credential c
      WHERE c.account_id = g.account_id
    `);
    await client.query(`
      UPDATE amazon_sp_api.employee_account_binding b
      SET workspace_tenant_id = b.workspace_id,
          account_id = g.account_id,
          unbound_at = CASE WHEN b.status = 'unbound' THEN b.updated_at ELSE NULL END
      FROM amazon_sp_api.connection_grant g
      WHERE g.issuer = b.issuer AND g.connection_id = b.connection_id
    `);
    await client.query(`
      UPDATE amazon_sp_api.authorization_attempt a
      SET started_by_type = 'employee',
          started_by_id = a.employee_id,
          issuer_scope = a.issuer,
          account_id = g.account_id,
          completed_at = a.consumed_at,
          updated_at = COALESCE(a.consumed_at, a.created_at)
      FROM amazon_sp_api.connection_grant g
      WHERE g.issuer = a.issuer AND g.connection_id = a.connection_id
    `);
    await client.query(`
      UPDATE amazon_sp_api.authorization_attempt
      SET started_by_type = 'employee',
          started_by_id = employee_id,
          issuer_scope = issuer,
          updated_at = created_at
      WHERE started_by_type IS NULL
    `);

    const expected = await client.query<CountRow>(`
      SELECT
        (SELECT COUNT(*) FROM amazon_sp_api.external_account_credential) AS accounts,
        (SELECT COUNT(*) FROM amazon_sp_api.oauth_connection) AS credentials,
        (SELECT COUNT(*) FROM amazon_sp_api.employee_account_binding WHERE status = 'active') AS active_bindings
    `);
    const actual = await client.query<CountRow>(`
      SELECT
        (SELECT COUNT(*) FROM amazon_sp_api.amazon_account) AS accounts,
        (SELECT COUNT(*) FROM amazon_sp_api.amazon_credential) AS credentials,
        (SELECT COUNT(*) FROM amazon_sp_api.employee_account_binding
          WHERE status = 'active' AND account_id IS NOT NULL AND workspace_tenant_id IS NOT NULL) AS active_bindings
    `);
    const expectedCounts = expected.rows[0]!;
    const actualCounts = actual.rows[0]!;
    const result: AccountLifecycleBackfillResult = {
      accounts: count(actualCounts.accounts),
      credentials: count(actualCounts.credentials),
      activeBindings: count(actualCounts.active_bindings),
    };
    if (
      result.accounts !== count(expectedCounts.accounts)
      || result.credentials !== count(expectedCounts.credentials)
      || result.activeBindings !== count(expectedCounts.active_bindings)
    ) {
      throw new Error("account lifecycle backfill count mismatch");
    }

    const integrity = await client.query<{ failures: number | string }>(`
      SELECT
        (SELECT COUNT(*) FROM amazon_sp_api.external_account_credential old
          LEFT JOIN amazon_sp_api.amazon_account next USING (account_id)
          WHERE next.account_id IS NULL)
        + (SELECT COUNT(*) FROM amazon_sp_api.oauth_connection old
          JOIN amazon_sp_api.external_account_credential a
            ON a.external_account_id = old.selling_partner_id
           AND a.owner_workspace_id = old.tenant_id
          JOIN amazon_sp_api.amazon_credential next ON next.account_id = a.account_id
          WHERE next.encrypted_refresh_token IS DISTINCT FROM old.refresh_token
             OR next.refresh_token_revision <> old.credential_revision)
        + (SELECT COUNT(*) FROM amazon_sp_api.connection_grant
          WHERE credential_id IS NULL OR authorized_by_type IS NULL OR authorized_by_id IS NULL)
        AS failures
    `);
    if (count(integrity.rows[0]!.failures) > 0) {
      throw new Error("account lifecycle backfill integrity check failed");
    }

    await client.query(`
      INSERT INTO amazon_sp_api.data_backfill (name, details)
      VALUES ($1, $2)
    `, [ACCOUNT_LIFECYCLE_BACKFILL, result]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
