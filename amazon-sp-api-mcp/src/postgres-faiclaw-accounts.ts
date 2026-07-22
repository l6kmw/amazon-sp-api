import { randomBytes } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig } from "pg";

import {
  ConnectedAccountAccountError,
  type ConnectedAccountAccountService,
  type ConnectedAccountAuthorizationAttempt,
  type ConnectedAccountConnectedAccount,
  type ConnectedAccountPrincipal,
} from "./connected-account-accounts.js";
import type {
  AmazonOAuthClient,
  ConnectedAccountAuthorizationCompletion,
} from "./oauth-client.js";

const PROVIDER_KEY = "amazon-sp-api";
const ATTEMPT_TTL_MS = 10 * 60_000;

type OAuthBridge = Pick<
  AmazonOAuthClient,
  "createConnectedAccountAuthorizationURL" | "getConnectedAccountAuthorizationCompletion" | "listConnections"
>;

interface AttemptRow {
  attempt_id: string;
  status: ConnectedAccountAuthorizationAttempt["status"];
  connection_id: string | null;
  error_code: string | null;
  expires_at: Date | string;
}

interface AccountRow {
  account_id: string;
  connection_id: string;
  external_account_id: string;
  display_name: string;
  remark: string | null;
  bound_at: Date | string | null;
}

function opaqueId(prefix: "acct" | "att" | "con"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function connectionFromRow(row: AccountRow): ConnectedAccountConnectedAccount {
  return {
    connectionId: row.connection_id,
    externalAccountId: row.external_account_id,
    providerKey: PROVIDER_KEY,
    displayName: row.display_name,
    status: "active",
    ...(row.remark !== null ? { remark: row.remark } : {}),
    ...(row.bound_at !== null ? { boundAt: iso(row.bound_at) } : {}),
    metadata: { account_id: row.account_id },
  };
}

export class PostgresConnectedAccountAccountStore implements ConnectedAccountAccountService {
  readonly #pool: Pool;
  readonly #oauth: OAuthBridge;
  readonly #authorizationOrigin: string;
  readonly #now: () => Date;

  constructor(options: {
    databaseUrl?: string;
    pool?: Pool;
    oauth: OAuthBridge;
    authorizationOrigin: string;
    now?: () => Date;
  }) {
    if (!options.pool && !options.databaseUrl) {
      throw new Error("databaseUrl or pool is required");
    }
    const config: PoolConfig = options.databaseUrl
      ? { connectionString: options.databaseUrl, max: 10 }
      : {};
    this.#pool = options.pool ?? new Pool(config);
    this.#oauth = options.oauth;
    this.#authorizationOrigin = options.authorizationOrigin;
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(`
        SELECT pg_advisory_xact_lock(
          hashtext('amazon_sp_api'),
          hashtext('schema_migration')
        )
      `);
      await client.query(`
      CREATE SCHEMA IF NOT EXISTS amazon_sp_api;
      CREATE TABLE IF NOT EXISTS amazon_sp_api.schema_version (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.employee_registry (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (issuer, employee_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.external_account_credential (
        account_id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
        authorized_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (provider_key, external_account_id, owner_workspace_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.connection_grant (
        issuer TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES amazon_sp_api.external_account_credential(account_id),
        owner_employee_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (issuer, connection_id),
        UNIQUE (issuer, account_id, owner_employee_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.employee_account_binding (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'unbound')),
        remark TEXT,
        bound_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (issuer, employee_id, connection_id),
        FOREIGN KEY (issuer, connection_id)
          REFERENCES amazon_sp_api.connection_grant(issuer, connection_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.authorization_attempt (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'expired')),
        connection_id TEXT,
        error_code TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        PRIMARY KEY (issuer, employee_id, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS employee_binding_connection_idx
        ON amazon_sp_api.employee_account_binding(issuer, connection_id, status);
      INSERT INTO amazon_sp_api.schema_version (component, version, updated_at)
      VALUES ('connected-account_accounts', 1, NOW())
      ON CONFLICT (component) DO UPDATE
        SET version = EXCLUDED.version, updated_at = EXCLUDED.updated_at;
      `);
    });
  }

  async checkHealth(): Promise<"ok" | "error"> {
    try {
      const result = await this.#pool.query<{ version: number }>(`
        SELECT version FROM amazon_sp_api.schema_version
        WHERE component = 'connected-account_accounts'
      `);
      return result.rows[0]?.version === 1 ? "ok" : "error";
    } catch {
      return "error";
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async createAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
  ): Promise<ConnectedAccountAuthorizationAttempt> {
    await this.#touchEmployee(principal);
    const attemptId = opaqueId("att");
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
    await this.#pool.query(`
      INSERT INTO amazon_sp_api.authorization_attempt
        (issuer, employee_id, attempt_id, status, expires_at, created_at)
      VALUES ($1, $2, $3, 'pending', $4, $5)
    `, [principal.issuer, principal.employeeId, attemptId, expiresAt, now]);

    try {
      const authorizationUrl = await this.#oauth.createConnectedAccountAuthorizationURL(
        principal.tenantId,
        attemptId,
        this.#authorizationOrigin,
      );
      return {
        attemptId,
        status: "pending",
        authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      };
    } catch {
      await this.#pool.query(`
        UPDATE amazon_sp_api.authorization_attempt
        SET status = 'failed', error_code = 'oauth_unavailable'
        WHERE issuer = $1 AND employee_id = $2 AND attempt_id = $3
      `, [principal.issuer, principal.employeeId, attemptId]);
      throw new ConnectedAccountAccountError(502, "upstream_error", "Authorization service unavailable");
    }
  }

  async getAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationAttempt> {
    await this.#touchEmployee(principal);
    let attempt = await this.#attempt(principal, attemptId);
    if (!attempt) throw new ConnectedAccountAccountError(404, "not_found", "Attempt not found");

    if (attempt.status === "pending" && Date.parse(iso(attempt.expires_at)) <= this.#now().getTime()) {
      await this.#pool.query(`
        UPDATE amazon_sp_api.authorization_attempt
        SET status = 'expired', error_code = 'authorization_expired'
        WHERE issuer = $1 AND employee_id = $2 AND attempt_id = $3 AND status = 'pending'
      `, [principal.issuer, principal.employeeId, attemptId]);
      attempt = (await this.#attempt(principal, attemptId))!;
    }

    if (attempt.status === "pending") {
      let completion: ConnectedAccountAuthorizationCompletion | null;
      try {
        completion = await this.#oauth.getConnectedAccountAuthorizationCompletion(
          principal.tenantId,
          attemptId,
        );
      } catch {
        throw new ConnectedAccountAccountError(502, "upstream_error", "Authorization service unavailable");
      }
      if (completion) {
        await this.#completeAttempt(principal, attemptId, completion);
        attempt = (await this.#attempt(principal, attemptId))!;
      }
    }

    const response: ConnectedAccountAuthorizationAttempt = {
      attemptId: attempt.attempt_id,
      status: attempt.status,
      expiresAt: iso(attempt.expires_at),
    };
    if (attempt.error_code) response.errorCode = attempt.error_code;
    if (attempt.status === "active" && attempt.connection_id) {
      response.connection = await this.#connectionForGrant(
        this.#pool,
        principal,
        attempt.connection_id,
        false,
      );
    }
    return response;
  }

  async listAccounts(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountConnectedAccount[]> {
    await this.#touchEmployee(principal);
    const result = await this.#pool.query<AccountRow>(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.employee_account_binding b
      JOIN amazon_sp_api.connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      WHERE b.issuer = $1 AND b.employee_id = $2 AND b.status = 'active'
        AND g.owner_employee_id = $2 AND g.status = 'active' AND a.status = 'active'
      ORDER BY b.bound_at, g.connection_id
    `, [principal.issuer, principal.employeeId]);
    return result.rows.map(connectionFromRow);
  }

  async resolveAccount(
    principal: ConnectedAccountPrincipal,
    accountId: string,
  ): Promise<ConnectedAccountConnectedAccount> {
    await this.#touchEmployee(principal);
    const result = await this.#pool.query<AccountRow>(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.employee_account_binding b
      JOIN amazon_sp_api.connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      WHERE b.issuer = $1 AND b.employee_id = $2 AND b.status = 'active'
        AND g.owner_employee_id = $2 AND g.status = 'active'
        AND a.account_id = $3 AND a.status = 'active'
    `, [principal.issuer, principal.employeeId, accountId]);
    const row = result.rows[0];
    if (!row) throw new ConnectedAccountAccountError(404, "not_found", "Account not found");
    return connectionFromRow(row);
  }

  async refreshAccounts(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountConnectedAccount[]> {
    await this.#touchEmployee(principal);
    let connections: Awaited<ReturnType<OAuthBridge["listConnections"]>>;
    try {
      connections = await this.#oauth.listConnections(principal.tenantId, true);
    } catch {
      throw new ConnectedAccountAccountError(502, "upstream_error", "Authorization service unavailable");
    }
    await this.#pool.query(`
      UPDATE amazon_sp_api.external_account_credential
      SET status = CASE
        WHEN external_account_id = ANY($2::text[]) THEN 'active'
        ELSE 'error'
      END,
      updated_at = $3
      WHERE provider_key = $1 AND owner_workspace_id = $4
    `, [
      PROVIDER_KEY,
      connections.map((connection) => connection.sellingPartnerId),
      this.#now(),
      principal.tenantId,
    ]);
    return this.listAccounts(principal);
  }

  async lookupAccounts(
    principal: ConnectedAccountPrincipal,
    connectionIds: readonly string[],
  ): Promise<ConnectedAccountConnectedAccount[]> {
    const wanted = new Set(connectionIds);
    return (await this.listAccounts(principal))
      .filter((account) => wanted.has(account.connectionId));
  }

  async bindAccount(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
  ): Promise<{ account: ConnectedAccountConnectedAccount; created: boolean }> {
    await this.#touchEmployee(principal);
    return this.#transaction(async (client) => {
      await this.#connectionForGrant(client, principal, connectionId, false);
      const existing = await client.query<{ status: string }>(`
        SELECT status FROM amazon_sp_api.employee_account_binding
        WHERE issuer = $1 AND employee_id = $2 AND connection_id = $3
        FOR UPDATE
      `, [principal.issuer, principal.employeeId, connectionId]);
      const now = this.#now();
      await client.query(`
        INSERT INTO amazon_sp_api.employee_account_binding
          (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', $5, $5)
        ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          status = 'active',
          bound_at = CASE WHEN amazon_sp_api.employee_account_binding.status = 'active'
            THEN amazon_sp_api.employee_account_binding.bound_at ELSE EXCLUDED.bound_at END,
          updated_at = EXCLUDED.updated_at
      `, [principal.issuer, principal.employeeId, principal.tenantId, connectionId, now]);
      return {
        account: await this.#connectionForGrant(client, principal, connectionId, true),
        created: existing.rows[0]?.status !== "active",
      };
    });
  }

  async updateRemark(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    remark: string,
  ): Promise<ConnectedAccountConnectedAccount> {
    await this.#touchEmployee(principal);
    return this.#transaction(async (client) => {
      const result = await client.query(`
        UPDATE amazon_sp_api.employee_account_binding
        SET remark = $1, updated_at = $2
        WHERE issuer = $3 AND employee_id = $4 AND connection_id = $5 AND status = 'active'
      `, [remark, this.#now(), principal.issuer, principal.employeeId, connectionId]);
      if (result.rowCount === 0) {
        throw new ConnectedAccountAccountError(404, "not_found", "Binding not found");
      }
      return this.#connectionForGrant(client, principal, connectionId, true);
    });
  }

  async unbindAccount(principal: ConnectedAccountPrincipal, connectionId: string): Promise<void> {
    await this.#touchEmployee(principal);
    await this.#connectionForGrant(this.#pool, principal, connectionId, false);
    await this.#pool.query(`
      UPDATE amazon_sp_api.employee_account_binding
      SET status = 'unbound', updated_at = $1
      WHERE issuer = $2 AND employee_id = $3 AND connection_id = $4
    `, [this.#now(), principal.issuer, principal.employeeId, connectionId]);
  }

  async disconnect(principal: ConnectedAccountPrincipal, connectionId: string): Promise<void> {
    await this.#touchEmployee(principal);
    await this.#transaction(async (client) => {
      const grant = await client.query(`
        SELECT status FROM amazon_sp_api.connection_grant
        WHERE issuer = $1 AND owner_employee_id = $2 AND connection_id = $3
        FOR UPDATE
      `, [principal.issuer, principal.employeeId, connectionId]);
      if (!grant.rows[0]) {
        throw new ConnectedAccountAccountError(404, "not_found", "Connection not found");
      }
      const now = this.#now();
      await client.query(`
        UPDATE amazon_sp_api.connection_grant
        SET status = 'disconnected', updated_at = $1
        WHERE issuer = $2 AND owner_employee_id = $3 AND connection_id = $4
      `, [now, principal.issuer, principal.employeeId, connectionId]);
      await client.query(`
        UPDATE amazon_sp_api.employee_account_binding
        SET status = 'unbound', updated_at = $1
        WHERE issuer = $2 AND connection_id = $3
      `, [now, principal.issuer, connectionId]);
    });
  }

  async #touchEmployee(principal: ConnectedAccountPrincipal): Promise<void> {
    const now = this.#now();
    await this.#pool.query(`
      INSERT INTO amazon_sp_api.employee_registry
        (issuer, employee_id, workspace_id, first_seen_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (issuer, employee_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        last_seen_at = EXCLUDED.last_seen_at
    `, [principal.issuer, principal.employeeId, principal.tenantId, now]);
  }

  async #attempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
  ): Promise<AttemptRow | undefined> {
    const result = await this.#pool.query<AttemptRow>(`
      SELECT attempt_id, status, connection_id, error_code, expires_at
      FROM amazon_sp_api.authorization_attempt
      WHERE issuer = $1 AND employee_id = $2 AND attempt_id = $3
    `, [principal.issuer, principal.employeeId, attemptId]);
    return result.rows[0];
  }

  async #completeAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
    completion: ConnectedAccountAuthorizationCompletion,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      const locked = await client.query<{ status: string }>(`
        SELECT status FROM amazon_sp_api.authorization_attempt
        WHERE issuer = $1 AND employee_id = $2 AND attempt_id = $3
        FOR UPDATE
      `, [principal.issuer, principal.employeeId, attemptId]);
      if (locked.rows[0]?.status !== "pending") return;

      const now = this.#now();
      const account = await client.query<{ account_id: string }>(`
        INSERT INTO amazon_sp_api.external_account_credential
          (account_id, provider_key, external_account_id, owner_workspace_id, display_name,
           status, authorized_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)
        ON CONFLICT (provider_key, external_account_id, owner_workspace_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          status = 'active',
          authorized_at = EXCLUDED.authorized_at,
          updated_at = EXCLUDED.updated_at
        RETURNING account_id
      `, [
        opaqueId("acct"),
        PROVIDER_KEY,
        completion.sellingPartnerId,
        principal.tenantId,
        `Amazon seller ${completion.sellingPartnerId}`,
        completion.authorizedAt,
        now,
      ]);
      const accountId = account.rows[0]!.account_id;
      const grant = await client.query<{ connection_id: string }>(`
        INSERT INTO amazon_sp_api.connection_grant
          (issuer, connection_id, account_id, owner_employee_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', $5, $5)
        ON CONFLICT (issuer, account_id, owner_employee_id) DO UPDATE SET
          status = 'active', updated_at = EXCLUDED.updated_at
        RETURNING connection_id
      `, [principal.issuer, opaqueId("con"), accountId, principal.employeeId, now]);
      await client.query(`
        UPDATE amazon_sp_api.authorization_attempt
        SET status = 'active', connection_id = $1, error_code = NULL, consumed_at = $2
        WHERE issuer = $3 AND employee_id = $4 AND attempt_id = $5 AND status = 'pending'
      `, [
        grant.rows[0]!.connection_id,
        now,
        principal.issuer,
        principal.employeeId,
        attemptId,
      ]);
    });
  }

  async #connectionForGrant(
    database: Pool | PoolClient,
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    requireBinding: boolean,
  ): Promise<ConnectedAccountConnectedAccount> {
    const result = await database.query<AccountRow>(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.connection_grant g
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      LEFT JOIN amazon_sp_api.employee_account_binding b
        ON b.issuer = g.issuer AND b.employee_id = g.owner_employee_id
       AND b.connection_id = g.connection_id AND b.status = 'active'
      WHERE g.issuer = $1 AND g.owner_employee_id = $2 AND g.connection_id = $3
        AND g.status = 'active' AND a.status = 'active'
        ${requireBinding ? "AND b.connection_id IS NOT NULL" : ""}
    `, [principal.issuer, principal.employeeId, connectionId]);
    const row = result.rows[0];
    if (!row) throw new ConnectedAccountAccountError(404, "not_found", "Connection not found");
    return connectionFromRow(row);
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
