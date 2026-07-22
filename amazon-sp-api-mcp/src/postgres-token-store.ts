import { Pool, type PoolConfig } from "pg";

import { AmazonMcpError } from "./errors.js";
import {
  createTokenKeyringFromConfig,
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
  type RefreshTokenCredential,
  type RefreshTokenProvider,
  type TokenKeyring,
} from "./token-store.js";

interface TokenRow {
  tenant_id: string;
  refresh_token: EncryptedSecret;
  credential_revision: number | string | null;
}

export class PostgresRefreshTokenStore implements RefreshTokenProvider {
  readonly #pool: Pool;
  readonly #keyring: TokenKeyring;
  readonly #allowedSellingPartnerIds: ReadonlySet<string>;

  constructor(options: {
    databaseUrl?: string;
    pool?: Pool;
    encryptionKey: string;
    allowedSellingPartnerIds: Iterable<string>;
    keyring?: TokenKeyring;
  }) {
    if (!options.pool && !options.databaseUrl) {
      throw new Error("databaseUrl or pool is required");
    }
    const config: PoolConfig = options.databaseUrl
      ? { connectionString: options.databaseUrl, max: 10 }
      : {};
    this.#pool = options.pool ?? new Pool(config);
    this.#keyring = options.keyring ?? createTokenKeyringFromConfig({
      encryptionKey: options.encryptionKey,
    });
    this.#allowedSellingPartnerIds = new Set(options.allowedSellingPartnerIds);
    if (this.#allowedSellingPartnerIds.size === 0) {
      throw new Error("at least one selling partner must be allowed");
    }
  }

  async initialize(): Promise<void> {
    await this.#pool.query(`
      ALTER TABLE amazon_sp_api.oauth_connection
        ADD COLUMN IF NOT EXISTS credential_revision BIGINT NOT NULL DEFAULT 1
    `);
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
    if (!this.#allowedSellingPartnerIds.has(sellingPartnerId)) {
      throw new AmazonMcpError("SELLER_NOT_ALLOWED", "selling partner is not allowed");
    }
    const result = await this.#pool.query<TokenRow>(`
      SELECT tenant_id, refresh_token, credential_revision
      FROM amazon_sp_api.oauth_connection
      WHERE selling_partner_id = $1 AND status = 'active'
    `, [sellingPartnerId]);
    const stored = result.rows[0];
    if (!stored?.refresh_token) {
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "selling partner has not completed Amazon OAuth",
      );
    }
    if (stored.tenant_id !== tenantId) {
      throw new AmazonMcpError(
        "SELLER_FORBIDDEN",
        "selling partner belongs to a different tenant",
      );
    }
    const revision = Number(stored.credential_revision ?? 1);
    return {
      refreshToken: decryptSecret(stored.refresh_token, this.#keyring, sellingPartnerId),
      revision: Number.isFinite(revision) && revision > 0 ? revision : 1,
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
      UPDATE amazon_sp_api.oauth_connection
      SET refresh_token = $1,
          credential_revision = credential_revision + 1,
          updated_at = NOW()
      WHERE selling_partner_id = $2
        AND tenant_id = $3
        AND status = 'active'
        AND credential_revision = $4
      RETURNING selling_partner_id
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
    await this.#pool.end();
  }
}
