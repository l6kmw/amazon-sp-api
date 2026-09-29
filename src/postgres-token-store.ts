import { Pool, type PoolConfig } from "pg";

import { AmazonMcpError } from "./errors.js";
import { migratePostgres } from "./postgres-migrations.js";
import {
  createTokenKeyringFromConfig,
  ConnectionConflictError,
  decryptSecret,
  encryptSecret,
  type AmazonConnection,
  type ConnectionStore,
  type EncryptedSecret,
  type RefreshTokenCredential,
  type TokenFile,
  type TokenKeyring,
} from "./token-store.js";

interface TokenRow {
  tenant_id: string;
  refresh_token: EncryptedSecret;
  credential_revision: number | string | null;
  credential_id: string | null;
  credential_owner_id: string | null;
}

export class PostgresRefreshTokenStore implements ConnectionStore {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #keyring: TokenKeyring;

  constructor(options: {
    databaseUrl?: string;
    pool?: Pool;
    encryptionKey: string;
    keyring?: TokenKeyring;
  }) {
    if (!options.pool && !options.databaseUrl) {
      throw new Error("databaseUrl or pool is required");
    }
    const config: PoolConfig = options.databaseUrl
      ? { connectionString: options.databaseUrl, max: 10 }
      : {};
    this.#pool = options.pool ?? new Pool(config);
    this.#ownsPool = !options.pool;
    this.#keyring = options.keyring ?? createTokenKeyringFromConfig({
      encryptionKey: options.encryptionKey,
    });
  }

  async initialize(): Promise<void> {
    await migratePostgres(this.#pool);
  }

  async save(
    sellingPartnerId: string,
    tenantId: string,
    tokenResponse: { refresh_token: string; token_type?: string },
    metadata: { connectedAccountAttemptId?: string } = {},
  ): Promise<void> {
    const now = new Date();
    const result = await this.#pool.query(`
      WITH saved AS (
        INSERT INTO amazon_sp_api.oauth_connection
          (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
           connected_account_attempt_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $3, $3)
        ON CONFLICT (selling_partner_id, tenant_id) DO UPDATE SET
          authorized_at = EXCLUDED.authorized_at,
          refresh_token = EXCLUDED.refresh_token,
          token_type = EXCLUDED.token_type,
          connected_account_attempt_id = EXCLUDED.connected_account_attempt_id,
          credential_revision = amazon_sp_api.oauth_connection.credential_revision + 1,
          status = 'active',
          updated_at = EXCLUDED.updated_at
        RETURNING *
      ), synced AS (
        INSERT INTO amazon_sp_api.amazon_credential
          (credential_id, account_id, credential_owner_id, encrypted_refresh_token,
           refresh_token_revision, status, authorized_at, created_at, updated_at)
        SELECT 'cred_' || md5(a.account_id || ':' || saved.tenant_id), a.account_id, saved.tenant_id, saved.refresh_token,
               saved.credential_revision, 'active', saved.authorized_at,
               saved.created_at, saved.updated_at
        FROM saved
        JOIN amazon_sp_api.external_account_credential legacy
          ON legacy.external_account_id = saved.selling_partner_id
         AND legacy.owner_workspace_id = saved.tenant_id
        JOIN amazon_sp_api.amazon_account a ON a.account_id = legacy.account_id
        ON CONFLICT (account_id, credential_owner_id) DO UPDATE SET
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          refresh_token_revision = EXCLUDED.refresh_token_revision,
          status = 'active',
          authorized_at = EXCLUDED.authorized_at,
          updated_at = EXCLUDED.updated_at
        RETURNING credential_id
      )
      SELECT selling_partner_id FROM saved
    `, [
      sellingPartnerId,
      tenantId,
      now,
      encryptSecret(tokenResponse.refresh_token, this.#keyring, sellingPartnerId),
      tokenResponse.token_type || "bearer",
      metadata.connectedAccountAttemptId || null,
    ]);
    if ((result.rowCount ?? 0) === 0) throw new ConnectionConflictError();
  }

  async importEncryptedConnections(tokens: TokenFile): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const [sellingPartnerId, token] of Object.entries(tokens)) {
        if (!token.tenantId || !token.refreshToken || !token.authorizedAt) {
          throw new Error("token file contains an invalid connection");
        }
        const result = await client.query(`
          WITH saved AS (
            INSERT INTO amazon_sp_api.oauth_connection
              (selling_partner_id, tenant_id, authorized_at, refresh_token, token_type,
               connected_account_attempt_id, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $3, $3)
            ON CONFLICT (selling_partner_id, tenant_id) DO UPDATE SET
                  authorized_at = EXCLUDED.authorized_at,
              refresh_token = EXCLUDED.refresh_token,
              token_type = EXCLUDED.token_type,
              connected_account_attempt_id = EXCLUDED.connected_account_attempt_id,
              status = 'active',
              updated_at = EXCLUDED.updated_at
            RETURNING *
          ), synced AS (
            INSERT INTO amazon_sp_api.amazon_credential
              (credential_id, account_id, credential_owner_id, encrypted_refresh_token,
               refresh_token_revision, status, authorized_at, created_at, updated_at)
            SELECT 'cred_' || md5(a.account_id || ':' || saved.tenant_id), a.account_id, saved.tenant_id, saved.refresh_token,
                   saved.credential_revision, 'active', saved.authorized_at,
                   saved.created_at, saved.updated_at
            FROM saved
            JOIN amazon_sp_api.external_account_credential legacy
              ON legacy.external_account_id = saved.selling_partner_id
             AND legacy.owner_workspace_id = saved.tenant_id
            JOIN amazon_sp_api.amazon_account a ON a.account_id = legacy.account_id
            ON CONFLICT (account_id, credential_owner_id) DO UPDATE SET
              encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
              refresh_token_revision = EXCLUDED.refresh_token_revision,
              status = 'active',
              authorized_at = EXCLUDED.authorized_at,
              updated_at = EXCLUDED.updated_at
            RETURNING credential_id
          )
          SELECT selling_partner_id FROM saved
        `, [
          sellingPartnerId,
          token.tenantId,
          token.authorizedAt,
          token.refreshToken,
          token.tokenType || "bearer",
          token.connectedAccountAttemptId || null,
        ]);
        if ((result.rowCount ?? 0) === 0) throw new ConnectionConflictError();
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string): Promise<AmazonConnection[]> {
    const result = await this.#pool.query(`
      SELECT selling_partner_id, authorized_at
      FROM amazon_sp_api.oauth_connection
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY selling_partner_id
    `, [tenantId]);
    return result.rows.map((row) => ({
      authorizedAt: new Date(row.authorized_at).toISOString(),
      sellingPartnerId: row.selling_partner_id,
    }));
  }

  async disconnect(tenantId: string, sellingPartnerId: string): Promise<boolean> {
    const result = await this.#pool.query(`
      WITH disconnected AS (
        UPDATE amazon_sp_api.oauth_connection
        SET status = 'disconnected', refresh_token = NULL, connected_account_attempt_id = NULL,
            updated_at = NOW()
        WHERE tenant_id = $1 AND selling_partner_id = $2 AND status = 'active'
        RETURNING *
      ), synced AS (
        UPDATE amazon_sp_api.amazon_credential credential
        SET status = 'revoked', encrypted_refresh_token = NULL,
            updated_at = disconnected.updated_at
        FROM disconnected
        JOIN amazon_sp_api.amazon_account account
          ON account.selling_partner_id = disconnected.selling_partner_id
        WHERE credential.account_id = account.account_id
          AND credential.credential_owner_id = disconnected.tenant_id
        RETURNING credential.credential_id
      )
      SELECT selling_partner_id FROM disconnected
    `, [tenantId, sellingPartnerId]);
    return (result.rowCount ?? 0) > 0;
  }

  async findConnectedAccountCompletion(
    tenantId: string,
    attemptId: string,
  ): Promise<AmazonConnection | null> {
    const result = await this.#pool.query(`
      SELECT selling_partner_id, authorized_at
      FROM amazon_sp_api.oauth_connection
      WHERE tenant_id = $1 AND connected_account_attempt_id = $2 AND status = 'active'
    `, [tenantId, attemptId]);
    const row = result.rows[0];
    return row ? {
      authorizedAt: new Date(row.authorized_at).toISOString(),
      sellingPartnerId: row.selling_partner_id,
    } : null;
  }

  async getRefreshToken(sellingPartnerId: string, tenantId: string): Promise<string> {
    const credential = await this.getRefreshCredential(sellingPartnerId, tenantId);
    return credential.refreshToken;
  }

  async getRefreshCredential(
    sellingPartnerId: string,
    tenantId: string,
  ): Promise<RefreshTokenCredential> {
    if (!tenantId) {
      throw new AmazonMcpError("TENANT_REQUIRED", "tenant identity is required");
    }
    const result = await this.#pool.query<TokenRow>(`
      WITH accessible AS (
        SELECT credential.credential_id, credential.credential_owner_id,
               credential.encrypted_refresh_token AS refresh_token,
               credential.refresh_token_revision AS credential_revision,
               owner_token.tenant_id
        FROM amazon_sp_api.amazon_account account
        JOIN amazon_sp_api.amazon_credential credential
          ON credential.account_id = account.account_id AND credential.status = 'active'
        JOIN amazon_sp_api.oauth_connection owner_token
          ON owner_token.selling_partner_id = account.selling_partner_id
         AND owner_token.tenant_id = credential.credential_owner_id
         AND owner_token.status = 'active'
        JOIN amazon_sp_api.connection_grant g
          ON g.account_id = account.account_id
         AND g.credential_id = credential.credential_id
         AND g.status = 'active'
        LEFT JOIN amazon_sp_api.employee_account_binding binding
          ON binding.issuer = g.issuer
         AND binding.connection_id = g.connection_id
         AND binding.workspace_id = $2
         AND binding.status = 'active'
        WHERE account.selling_partner_id = $1
          AND (credential.credential_owner_id = $2 OR binding.workspace_id IS NOT NULL)
        ORDER BY (credential.credential_owner_id = $2) DESC, credential.credential_id
        LIMIT 1
      )
      SELECT tenant_id, refresh_token, credential_revision,
             credential_id, credential_owner_id
      FROM accessible
      UNION ALL
      SELECT legacy_token.tenant_id, legacy_token.refresh_token,
             legacy_token.credential_revision, NULL, legacy_token.tenant_id
      FROM amazon_sp_api.oauth_connection legacy_token
      WHERE legacy_token.selling_partner_id = $1 AND legacy_token.tenant_id = $2
        AND legacy_token.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM accessible)
      LIMIT 1
    `, [sellingPartnerId, tenantId]);
    const stored = result.rows[0];
    if (!stored) {
      const seller = await this.#pool.query<{
        same_tenant: boolean | null;
        active: boolean | null;
      }>(`
        SELECT BOOL_OR(tenant_id = $2) AS same_tenant,
               BOOL_OR(status = 'active') AS active
        FROM amazon_sp_api.oauth_connection
        WHERE selling_partner_id = $1
      `, [sellingPartnerId, tenantId]);
      if (seller.rows[0]?.same_tenant) {
        throw new AmazonMcpError(
          "NOT_CONNECTED",
          "selling partner has not completed Amazon OAuth",
        );
      }
      if (seller.rows[0]?.active) {
        throw new AmazonMcpError(
          "SELLER_FORBIDDEN",
          "selling partner belongs to a different tenant",
        );
      }
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "selling partner has not completed Amazon OAuth",
      );
    }
    if (!stored.refresh_token) {
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "selling partner has not completed Amazon OAuth",
      );
    }
    const revision = Number(stored.credential_revision ?? 1);
    return {
      refreshToken: decryptSecret(stored.refresh_token, this.#keyring, sellingPartnerId),
      revision: Number.isFinite(revision) && revision > 0 ? revision : 1,
      credentialId: stored.credential_id ?? `legacy:${stored.tenant_id}:${sellingPartnerId}`,
      credentialOwnerId: stored.credential_owner_id ?? stored.tenant_id,
    };
  }

  async compareAndSetRefreshToken(options: {
    sellingPartnerId: string;
    tenantId: string;
    expectedRevision: number;
    newRefreshToken: string;
  }): Promise<"updated" | "conflict" | "missing"> {
    const encrypted = encryptSecret(
      options.newRefreshToken,
      this.#keyring,
      options.sellingPartnerId,
    );
    const result = await this.#pool.query(`
      WITH updated AS (
        UPDATE amazon_sp_api.oauth_connection
        SET refresh_token = $1,
            credential_revision = credential_revision + 1,
            updated_at = NOW()
        WHERE selling_partner_id = $2
          AND tenant_id = $3
          AND status = 'active'
          AND credential_revision = $4
        RETURNING *
      ), synced AS (
        UPDATE amazon_sp_api.amazon_credential credential
        SET encrypted_refresh_token = updated.refresh_token,
            refresh_token_revision = updated.credential_revision,
            last_refresh_at = updated.updated_at,
            updated_at = updated.updated_at
        FROM updated
        JOIN amazon_sp_api.amazon_account account
          ON account.selling_partner_id = updated.selling_partner_id
        WHERE credential.account_id = account.account_id
          AND credential.credential_owner_id = updated.tenant_id
        RETURNING credential.credential_id
      )
      SELECT selling_partner_id FROM updated
    `, [
      encrypted,
      options.sellingPartnerId,
      options.tenantId,
      options.expectedRevision,
    ]);
    if ((result.rowCount ?? 0) > 0) return "updated";
    const existing = await this.#pool.query(`
      SELECT 1 FROM amazon_sp_api.oauth_connection
      WHERE selling_partner_id = $1 AND tenant_id = $2 AND status = 'active'
    `, [options.sellingPartnerId, options.tenantId]);
    return (existing.rowCount ?? 0) > 0 ? "conflict" : "missing";
  }

  async checkHealth(): Promise<"ok" | "error"> {
    try {
      await this.#pool.query("SELECT 1 FROM amazon_sp_api.oauth_connection LIMIT 1");
      return "ok";
    } catch {
      return "error";
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}
