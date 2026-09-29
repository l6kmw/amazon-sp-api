import { randomBytes } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig } from "pg";

import { migratePostgres, POSTGRES_SCHEMA_VERSION } from "./postgres-migrations.js";
import {
  ConnectedAccountError,
  type ConnectedAccountService,
  type ConnectedAccountAuthorizationAttempt,
  type ConnectedAccountProtocol,
  type ConnectedAccountPrincipal,
} from "./connected-accounts.js";
import type {
  ConnectionService,
  ConnectedAccountAuthorizationCompletion,
} from "./connection-service.js";

const PROVIDER_KEY = "amazon-sp-api";
const ATTEMPT_TTL_MS = 10 * 60_000;

type OAuthBridge = Pick<
  ConnectionService,
  "createConnectedAccountAuthorizationURL" | "cancelAuthorizationURL" |
  "getConnectedAccountAuthorizationCompletion" | "listConnections" | "disconnectIfPresent"
>;

interface AttemptRow {
  attempt_id: string;
  status: ConnectedAccountAuthorizationAttempt["status"];
  connection_id: string | null;
  error_code: string | null;
  created_at: Date | string;
  expires_at: Date | string;
}

export interface AdminAuthorizationAttempt extends ConnectedAccountAuthorizationAttempt {
  createdAt: string;
}

interface AccountRow {
  account_id: string;
  connection_id: string;
  external_account_id: string;
  display_name: string;
  remark: string | null;
  bound_at: Date | string | null;
}

function opaqueId(prefix: "acct" | "att" | "con" | "cred"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function connectionFromRow(row: AccountRow): ConnectedAccountProtocol {
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

export class PostgresConnectedAccountStore implements ConnectedAccountService {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #oauth: OAuthBridge;
  readonly #authorizationOrigin: string;
  readonly #adminAuthorizationOrigin: string;
  readonly #now: () => Date;
  readonly #invalidateCredential?: (
    credentialId: string,
    revision: number,
    credentialOwnerId: string,
    sellingPartnerId: string,
  ) => Promise<void> | void;

  constructor(options: {
    databaseUrl?: string;
    pool?: Pool;
    oauth: OAuthBridge;
    authorizationOrigin: string;
    adminAuthorizationOrigin?: string;
    now?: () => Date;
    invalidateCredential?: (
      credentialId: string,
      revision: number,
      credentialOwnerId: string,
      sellingPartnerId: string,
    ) => Promise<void> | void;
  }) {
    if (!options.pool && !options.databaseUrl) {
      throw new Error("databaseUrl or pool is required");
    }
    const config: PoolConfig = options.databaseUrl
      ? { connectionString: options.databaseUrl, max: 10 }
      : {};
    this.#pool = options.pool ?? new Pool(config);
    this.#ownsPool = !options.pool;
    this.#oauth = options.oauth;
    this.#authorizationOrigin = options.authorizationOrigin;
    this.#adminAuthorizationOrigin = options.adminAuthorizationOrigin ?? options.authorizationOrigin;
    this.#now = options.now ?? (() => new Date());
    this.#invalidateCredential = options.invalidateCredential;
  }

  async initialize(): Promise<void> {
    await migratePostgres(this.#pool);
  }

  async checkHealth(): Promise<"ok" | "error"> {
    try {
      const result = await this.#pool.query<{ version: number }>(`
        SELECT COALESCE(MAX(version), 0)::int AS version
        FROM amazon_sp_api.schema_migration
      `);
      return result.rows[0]?.version === POSTGRES_SCHEMA_VERSION ? "ok" : "error";
    } catch {
      return "error";
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async adminCreateAuthorizationAttempt(
    issuer: string,
    employeeId: string,
    startedById: string,
    client: PoolClient,
  ): Promise<AdminAuthorizationAttempt> {
    const principal = await this.#registeredPrincipal(client, issuer, employeeId);
    const attemptId = opaqueId("att");
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
    await client.query(`
      INSERT INTO amazon_sp_api.authorization_attempt
        (issuer, employee_id, attempt_id, status, expires_at, created_at,
         started_by_type, started_by_id, issuer_scope, updated_at)
      VALUES ($1, $2, $3, 'pending', $4, $5, 'admin', $6, $1, $5)
    `, [issuer, employeeId, attemptId, expiresAt, now, startedById]);
    try {
      const authorizationUrl = await this.#oauth.createConnectedAccountAuthorizationURL(
        principal.tenantId,
        attemptId,
        this.#adminAuthorizationOrigin,
      );
      return {
        attemptId,
        status: "pending",
        authorizationUrl,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
    } catch {
      throw new ConnectedAccountError(502, "upstream_error", "Authorization service unavailable");
    }
  }

  async cancelAdminAuthorizationURL(url: string): Promise<void> {
    await this.#oauth.cancelAuthorizationURL(url);
  }

  async pollAdminAuthorizationCompletion(
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationCompletion | null> {
    const owner = await this.#pool.query<{ workspace_id: string }>(`
      SELECT e.workspace_id
      FROM amazon_sp_api.authorization_attempt a
      JOIN amazon_sp_api.employee_registry e
        ON e.issuer = a.issuer AND e.employee_id = a.employee_id
      WHERE a.attempt_id = $1 AND a.started_by_type = 'admin' AND a.status = 'pending'
    `, [attemptId]);
    const workspaceId = owner.rows[0]?.workspace_id;
    return workspaceId
      ? this.#oauth.getConnectedAccountAuthorizationCompletion(workspaceId, attemptId)
      : null;
  }

  async adminGetAuthorizationAttempt(
    attemptId: string,
    completion: ConnectedAccountAuthorizationCompletion | null,
    client: PoolClient,
  ): Promise<AdminAuthorizationAttempt> {
    const owner = await client.query<{
      issuer: string;
      employee_id: string;
      workspace_id: string;
      created_at: Date | string;
      expires_at: Date | string;
    }>(`
      SELECT a.issuer, a.employee_id, e.workspace_id, a.created_at, a.expires_at
      FROM amazon_sp_api.authorization_attempt a
      JOIN amazon_sp_api.employee_registry e
        ON e.issuer = a.issuer AND e.employee_id = a.employee_id
      WHERE a.attempt_id = $1 AND a.started_by_type = 'admin'
    `, [attemptId]);
    const row = owner.rows[0];
    if (!row) throw new ConnectedAccountError(404, "not_found", "Attempt not found");
    const attempt = await this.#getAuthorizationAttempt({
      authType: "employee_jwt",
      credentialKind: "employee_jwt",
      tenantId: row.workspace_id,
      issuer: row.issuer,
      employeeId: row.employee_id,
      kid: "employee_registry",
      expiresAt: iso(row.expires_at),
      scopes: new Set(["connected_accounts:manage"]),
    }, attemptId, client, completion);
    return { ...attempt, createdAt: iso(row.created_at) };
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
        (issuer, employee_id, attempt_id, status, expires_at, created_at,
         started_by_type, started_by_id, issuer_scope, updated_at)
      VALUES ($1, $2, $3, 'pending', $4, $5, 'employee', $2, $1, $5)
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
        SET status = 'failed', error_code = 'oauth_unavailable',
            completed_at = $1, updated_at = $1
        WHERE issuer = $2 AND employee_id = $3 AND attempt_id = $4
      `, [this.#now(), principal.issuer, principal.employeeId, attemptId]);
      throw new ConnectedAccountError(502, "upstream_error", "Authorization service unavailable");
    }
  }

  async getAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationAttempt> {
    await this.#touchEmployee(principal);
    return this.#getAuthorizationAttempt(principal, attemptId, this.#pool);
  }

  async #getAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
    database: Pool | PoolClient,
    knownCompletion?: ConnectedAccountAuthorizationCompletion | null,
  ): Promise<ConnectedAccountAuthorizationAttempt> {
    let attempt = await this.#attempt(principal, attemptId, database);
    if (!attempt) throw new ConnectedAccountError(404, "not_found", "Attempt not found");

    if (attempt.status === "pending" && Date.parse(iso(attempt.expires_at)) <= this.#now().getTime()) {
      await database.query(`
        UPDATE amazon_sp_api.authorization_attempt
        SET status = 'expired', error_code = 'authorization_expired',
            completed_at = $1, updated_at = $1
        WHERE issuer = $2 AND employee_id = $3 AND attempt_id = $4 AND status = 'pending'
      `, [this.#now(), principal.issuer, principal.employeeId, attemptId]);
      attempt = (await this.#attempt(principal, attemptId, database))!;
    }

    if (attempt.status === "pending") {
      let completion = knownCompletion;
      if (completion === undefined) {
        try {
          completion = await this.#oauth.getConnectedAccountAuthorizationCompletion(
            principal.tenantId,
            attemptId,
          );
        } catch {
          throw new ConnectedAccountError(502, "upstream_error", "Authorization service unavailable");
        }
      }
      if (completion) {
        await this.#completeAttempt(
          principal,
          attemptId,
          completion,
          database instanceof Pool ? undefined : database,
        );
        attempt = (await this.#attempt(principal, attemptId, database))!;
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
        database,
        principal,
        attempt.connection_id,
        false,
      );
    }
    return response;
  }

  async listAccounts(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountProtocol[]> {
    await this.#touchEmployee(principal);
    const result = await this.#pool.query<AccountRow>(`
      SELECT a.account_id, g.connection_id,
             COALESCE(next.selling_partner_id, a.external_account_id) AS external_account_id,
             COALESCE(next.display_name, a.display_name) AS display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.employee_account_binding b
      JOIN amazon_sp_api.connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      LEFT JOIN amazon_sp_api.amazon_account next ON next.account_id = a.account_id
      LEFT JOIN amazon_sp_api.amazon_credential credential ON credential.credential_id = g.credential_id
      WHERE b.issuer = $1 AND b.employee_id = $2 AND b.status = 'active'
        AND g.status = 'active' AND COALESCE(next.status, a.status) = 'active'
        AND (g.credential_id IS NULL OR credential.status = 'active')
      ORDER BY b.bound_at, g.connection_id
    `, [principal.issuer, principal.employeeId]);
    return result.rows.map(connectionFromRow);
  }

  async resolveAccount(
    principal: ConnectedAccountPrincipal,
    accountId: string,
  ): Promise<ConnectedAccountProtocol> {
    await this.#touchEmployee(principal);
    const result = await this.#pool.query<AccountRow>(`
      SELECT a.account_id, g.connection_id,
             COALESCE(next.selling_partner_id, a.external_account_id) AS external_account_id,
             COALESCE(next.display_name, a.display_name) AS display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.employee_account_binding b
      JOIN amazon_sp_api.connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      LEFT JOIN amazon_sp_api.amazon_account next ON next.account_id = a.account_id
      LEFT JOIN amazon_sp_api.amazon_credential credential ON credential.credential_id = g.credential_id
      WHERE b.issuer = $1 AND b.employee_id = $2 AND b.status = 'active'
        AND g.status = 'active' AND a.account_id = $3
        AND COALESCE(next.status, a.status) = 'active'
        AND (g.credential_id IS NULL OR credential.status = 'active')
    `, [principal.issuer, principal.employeeId, accountId]);
    const row = result.rows[0];
    if (!row) throw new ConnectedAccountError(404, "not_found", "Account not found");
    return connectionFromRow(row);
  }

  async refreshAccounts(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountProtocol[]> {
    return this.listAccounts(principal);
  }

  async lookupAccounts(
    principal: ConnectedAccountPrincipal,
    connectionIds: readonly string[],
  ): Promise<ConnectedAccountProtocol[]> {
    const wanted = new Set(connectionIds);
    return (await this.listAccounts(principal))
      .filter((account) => wanted.has(account.connectionId));
  }

  async bindAccount(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
  ): Promise<{ account: ConnectedAccountProtocol; created: boolean }> {
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
          (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at,
           workspace_tenant_id, account_id, unbound_at)
        SELECT $1, $2, $3, $4, 'active', $5, $5, $3, g.account_id, NULL
        FROM amazon_sp_api.connection_grant g
        WHERE g.issuer = $1 AND g.connection_id = $4
        ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          workspace_tenant_id = EXCLUDED.workspace_tenant_id,
          account_id = EXCLUDED.account_id,
          status = 'active',
          unbound_at = NULL,
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

  async shareAccount(
    owner: ConnectedAccountPrincipal,
    connectionId: string,
    target: ConnectedAccountPrincipal,
  ): Promise<{ account: ConnectedAccountProtocol; created: boolean }> {
    await this.#touchEmployee(owner);
    if (target.issuer !== owner.issuer) {
      throw new ConnectedAccountError(404, "not_found", "Connection not found");
    }
    await this.#touchEmployee(target);
    return this.#transaction(async (client) => {
      await this.#connectionForGrant(client, owner, connectionId, false);
      const existing = await client.query<{ status: string }>(`
        SELECT status FROM amazon_sp_api.employee_account_binding
        WHERE issuer = $1 AND employee_id = $2 AND connection_id = $3
        FOR UPDATE
      `, [owner.issuer, target.employeeId, connectionId]);
      const now = this.#now();
      await client.query(`
        INSERT INTO amazon_sp_api.employee_account_binding
          (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at,
           workspace_tenant_id, account_id, unbound_at)
        SELECT $1, $2, $3, $4, 'active', $5, $5, $3, g.account_id, NULL
        FROM amazon_sp_api.connection_grant g
        WHERE g.issuer = $1 AND g.connection_id = $4 AND g.status = 'active'
        ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          workspace_tenant_id = EXCLUDED.workspace_tenant_id,
          account_id = EXCLUDED.account_id,
          status = 'active', unbound_at = NULL,
          bound_at = CASE WHEN amazon_sp_api.employee_account_binding.status = 'active'
            THEN amazon_sp_api.employee_account_binding.bound_at ELSE EXCLUDED.bound_at END,
          updated_at = EXCLUDED.updated_at
      `, [owner.issuer, target.employeeId, target.tenantId, connectionId, now]);
      return {
        account: await this.#connectionForBinding(client, target, connectionId),
        created: existing.rows[0]?.status !== "active",
      };
    });
  }

  async unshareAccount(
    owner: ConnectedAccountPrincipal,
    connectionId: string,
    target: ConnectedAccountPrincipal,
  ): Promise<void> {
    await this.#touchEmployee(owner);
    if (target.issuer !== owner.issuer || target.employeeId === owner.employeeId) {
      throw new ConnectedAccountError(404, "not_found", "Connection not found");
    }
    await this.#transaction(async (client) => {
      await this.#connectionForGrant(client, owner, connectionId, false);
      const now = this.#now();
      await client.query(`
        UPDATE amazon_sp_api.employee_account_binding
        SET status = 'unbound', unbound_at = $1, updated_at = $1
        WHERE issuer = $2 AND employee_id = $3 AND connection_id = $4 AND status = 'active'
      `, [now, owner.issuer, target.employeeId, connectionId]);
    });
  }

  async adminShareAccount(
    issuer: string,
    employeeId: string,
    connectionId: string,
    client: PoolClient,
  ): Promise<{ account: ConnectedAccountProtocol; created: boolean }> {
    const employee = await client.query<{ workspace_id: string }>(`
      SELECT workspace_id FROM amazon_sp_api.employee_registry
      WHERE issuer = $1 AND employee_id = $2
    `, [issuer, employeeId]);
    const grant = await client.query<{ account_id: string }>(`
      SELECT account_id FROM amazon_sp_api.connection_grant
      WHERE issuer = $1 AND connection_id = $2 AND status = 'active'
    `, [issuer, connectionId]);
    if (!employee.rows[0] || !grant.rows[0]) {
      throw new ConnectedAccountError(404, "not_found", "Connection not found");
    }
    const existing = await client.query<{ status: string }>(`
      SELECT status FROM amazon_sp_api.employee_account_binding
      WHERE issuer = $1 AND employee_id = $2 AND connection_id = $3
      FOR UPDATE
    `, [issuer, employeeId, connectionId]);
    const now = this.#now();
    await client.query(`
      INSERT INTO amazon_sp_api.employee_account_binding
        (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at,
         workspace_tenant_id, account_id, unbound_at)
      VALUES ($1, $2, $3, $4, 'active', $5, $5, $3, $6, NULL)
      ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        workspace_tenant_id = EXCLUDED.workspace_tenant_id,
        account_id = EXCLUDED.account_id,
        status = 'active', unbound_at = NULL,
        bound_at = CASE WHEN amazon_sp_api.employee_account_binding.status = 'active'
          THEN amazon_sp_api.employee_account_binding.bound_at ELSE EXCLUDED.bound_at END,
        updated_at = EXCLUDED.updated_at
    `, [issuer, employeeId, employee.rows[0].workspace_id, connectionId, now, grant.rows[0].account_id]);
    const target = {
      authType: "employee_jwt" as const,
      tenantId: employee.rows[0].workspace_id,
      issuer,
      employeeId,
      kid: "admin-managed",
      expiresAt: now.toISOString(),
      scopes: new Set<string>(),
    };
    return {
      account: await this.#connectionForBinding(client, target, connectionId),
      created: existing.rows[0]?.status !== "active",
    };
  }

  async adminDisconnectConnection(
    issuer: string,
    connectionId: string,
    client: PoolClient,
  ): Promise<void> {
    const result = await client.query<{
      credential_id: string;
      credential_owner_id: string;
      refresh_token_revision: number | string;
      selling_partner_id: string;
    }>(`
      SELECT c.credential_id, c.credential_owner_id,
             c.refresh_token_revision, a.selling_partner_id
      FROM amazon_sp_api.connection_grant g
      JOIN amazon_sp_api.amazon_credential c ON c.credential_id = g.credential_id
      JOIN amazon_sp_api.amazon_account a ON a.account_id = g.account_id
      WHERE g.issuer = $1 AND g.connection_id = $2
      FOR UPDATE OF g, c
    `, [issuer, connectionId]);
    const connection = result.rows[0];
    if (!connection) {
      throw new ConnectedAccountError(404, "not_found", "Connection not found");
    }
    await this.#invalidateCredential?.(
      connection.credential_id,
      Number(connection.refresh_token_revision),
      connection.credential_owner_id,
      connection.selling_partner_id,
    );
    const now = this.#now();
    await client.query(`
      UPDATE amazon_sp_api.oauth_connection
      SET status = 'disconnected', refresh_token = NULL, connected_account_attempt_id = NULL,
          updated_at = $1
      WHERE tenant_id = $2 AND selling_partner_id = $3
    `, [now, connection.credential_owner_id, connection.selling_partner_id]);
    await client.query(`
      UPDATE amazon_sp_api.amazon_credential
      SET status = 'revoked', encrypted_refresh_token = NULL, updated_at = $1
      WHERE credential_id = $2
    `, [now, connection.credential_id]);
    await client.query(`
      UPDATE amazon_sp_api.connection_grant
      SET status = 'disconnected', updated_at = $1
      WHERE issuer = $2 AND connection_id = $3
    `, [now, issuer, connectionId]);
    await client.query(`
      UPDATE amazon_sp_api.employee_account_binding
      SET status = 'unbound', unbound_at = $1, updated_at = $1
      WHERE issuer = $2 AND connection_id = $3
    `, [now, issuer, connectionId]);
  }

  async adminUnshareAccount(
    issuer: string,
    employeeId: string,
    connectionId: string,
    client: PoolClient,
  ): Promise<void> {
    const binding = await client.query<{ owner_employee_id: string }>(`
      SELECT g.owner_employee_id
      FROM amazon_sp_api.connection_grant g
      JOIN amazon_sp_api.employee_account_binding b
        ON b.issuer = g.issuer AND b.connection_id = g.connection_id
      WHERE g.issuer = $1 AND g.connection_id = $2 AND b.employee_id = $3
      FOR UPDATE OF b
    `, [issuer, connectionId, employeeId]);
    if (!binding.rows[0] || binding.rows[0].owner_employee_id === employeeId) {
      throw new ConnectedAccountError(404, "not_found", "Binding not found");
    }
    const now = this.#now();
    await client.query(`
      UPDATE amazon_sp_api.employee_account_binding
      SET status = 'unbound', unbound_at = $1, updated_at = $1
      WHERE issuer = $2 AND employee_id = $3 AND connection_id = $4
    `, [now, issuer, employeeId, connectionId]);
  }

  async updateRemark(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    remark: string,
  ): Promise<ConnectedAccountProtocol> {
    await this.#touchEmployee(principal);
    return this.#transaction(async (client) => {
      const result = await client.query(`
        UPDATE amazon_sp_api.employee_account_binding
        SET remark = $1, updated_at = $2
        WHERE issuer = $3 AND employee_id = $4 AND connection_id = $5 AND status = 'active'
      `, [remark, this.#now(), principal.issuer, principal.employeeId, connectionId]);
      if (result.rowCount === 0) {
        throw new ConnectedAccountError(404, "not_found", "Binding not found");
      }
      return this.#connectionForBinding(client, principal, connectionId);
    });
  }

  async unbindAccount(principal: ConnectedAccountPrincipal, connectionId: string): Promise<void> {
    await this.#touchEmployee(principal);
    const result = await this.#pool.query(`
      UPDATE amazon_sp_api.employee_account_binding
      SET status = 'unbound', unbound_at = $1, updated_at = $1
      WHERE issuer = $2 AND employee_id = $3 AND connection_id = $4
    `, [this.#now(), principal.issuer, principal.employeeId, connectionId]);
    if (result.rowCount === 0) {
      throw new ConnectedAccountError(404, "not_found", "Binding not found");
    }
  }

  async disconnect(principal: ConnectedAccountPrincipal, connectionId: string): Promise<void> {
    await this.#touchEmployee(principal);
    const grant = await this.#pool.query<{
      selling_partner_id: string;
      credential_owner_id: string;
    }>(`
      SELECT COALESCE(a.selling_partner_id, legacy.external_account_id) AS selling_partner_id,
             COALESCE(c.credential_owner_id, legacy.owner_workspace_id) AS credential_owner_id
      FROM amazon_sp_api.connection_grant g
      JOIN amazon_sp_api.external_account_credential legacy ON legacy.account_id = g.account_id
      LEFT JOIN amazon_sp_api.amazon_account a ON a.account_id = g.account_id
      LEFT JOIN amazon_sp_api.amazon_credential c ON c.credential_id = g.credential_id
      WHERE g.issuer = $1 AND g.owner_employee_id = $2 AND g.connection_id = $3
    `, [principal.issuer, principal.employeeId, connectionId]);
    const owned = grant.rows[0];
    if (!owned) throw new ConnectedAccountError(404, "not_found", "Connection not found");
    await this.#oauth.disconnectIfPresent(
      owned.credential_owner_id,
      owned.selling_partner_id,
    );
    await this.#transaction(async (client) => {
      const now = this.#now();
      await client.query(`
        UPDATE amazon_sp_api.connection_grant
        SET status = 'disconnected', updated_at = $1
        WHERE issuer = $2 AND owner_employee_id = $3 AND connection_id = $4
      `, [now, principal.issuer, principal.employeeId, connectionId]);
      await client.query(`
        UPDATE amazon_sp_api.employee_account_binding
        SET status = 'unbound', unbound_at = $1, updated_at = $1
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
    database: Pool | PoolClient = this.#pool,
  ): Promise<AttemptRow | undefined> {
    const result = await database.query<AttemptRow>(`
      SELECT attempt_id, status, connection_id, error_code, created_at, expires_at
      FROM amazon_sp_api.authorization_attempt
      WHERE issuer = $1 AND employee_id = $2 AND attempt_id = $3
    `, [principal.issuer, principal.employeeId, attemptId]);
    return result.rows[0];
  }

  async #completeAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
    completion: ConnectedAccountAuthorizationCompletion,
    database?: PoolClient,
  ): Promise<void> {
    const operation = async (client: PoolClient) => {
      const locked = await client.query<{
        status: string;
        started_by_type: "admin" | "employee" | null;
        started_by_id: string | null;
      }>(`
        SELECT status, started_by_type, started_by_id FROM amazon_sp_api.authorization_attempt
        WHERE issuer = $1 AND employee_id = $2 AND attempt_id = $3
        FOR UPDATE
      `, [principal.issuer, principal.employeeId, attemptId]);
      const starter = locked.rows[0];
      if (starter?.status !== "pending") return;

      const now = this.#now();
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [principal.issuer, completion.sellingPartnerId],
      );
      const existingAccount = await client.query<{ account_id: string }>(`
        SELECT account_id FROM amazon_sp_api.amazon_account
        WHERE provider_key = $1 AND issuer_scope = $2 AND selling_partner_id = $3
        FOR UPDATE
      `, [PROVIDER_KEY, principal.issuer, completion.sellingPartnerId]);
      let accountId = existingAccount.rows[0]?.account_id;
      if (!accountId) {
        const legacy = await client.query<{ account_id: string }>(`
          INSERT INTO amazon_sp_api.external_account_credential
            (account_id, provider_key, external_account_id, owner_workspace_id, display_name,
             status, authorized_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)
          ON CONFLICT (provider_key, external_account_id, owner_workspace_id) DO UPDATE SET
            display_name = EXCLUDED.display_name, status = 'active',
            authorized_at = EXCLUDED.authorized_at, updated_at = EXCLUDED.updated_at
          RETURNING account_id
        `, [
          opaqueId("acct"), PROVIDER_KEY, completion.sellingPartnerId, principal.tenantId,
          `Amazon seller ${completion.sellingPartnerId}`, completion.authorizedAt, now,
        ]);
        accountId = legacy.rows[0]!.account_id;
      }
      const account = await client.query<{ account_id: string }>(`
        INSERT INTO amazon_sp_api.amazon_account
          (account_id, provider_key, issuer_scope, selling_partner_id, display_name, status,
           authorized_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)
        ON CONFLICT (provider_key, issuer_scope, selling_partner_id) DO UPDATE SET
          display_name = EXCLUDED.display_name, status = 'active',
          authorized_at = EXCLUDED.authorized_at, updated_at = EXCLUDED.updated_at
        RETURNING account_id
      `, [
        accountId, PROVIDER_KEY, principal.issuer, completion.sellingPartnerId,
        `Amazon seller ${completion.sellingPartnerId}`, completion.authorizedAt, now,
      ]);
      accountId = account.rows[0]!.account_id;
      const credential = await client.query<{ credential_id: string }>(`
        INSERT INTO amazon_sp_api.amazon_credential
          (credential_id, account_id, credential_owner_id, encrypted_refresh_token,
           refresh_token_revision, status, authorized_at, created_at, updated_at)
        SELECT $1, $2, $3, o.refresh_token, o.credential_revision, 'active',
               o.authorized_at, o.created_at, o.updated_at
        FROM amazon_sp_api.oauth_connection o
        WHERE o.selling_partner_id = $4 AND o.tenant_id = $3
          AND o.status = 'active' AND o.refresh_token IS NOT NULL
        ON CONFLICT (account_id, credential_owner_id) DO UPDATE SET
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          refresh_token_revision = EXCLUDED.refresh_token_revision,
          status = 'active', authorized_at = EXCLUDED.authorized_at,
          updated_at = EXCLUDED.updated_at
        RETURNING credential_id
      `, [opaqueId("cred"), accountId, principal.tenantId, completion.sellingPartnerId]);
      const grant = await client.query<{ connection_id: string }>(`
        INSERT INTO amazon_sp_api.connection_grant
          (issuer, connection_id, account_id, owner_employee_id, status, created_at, updated_at,
           credential_id, authorized_by_type, authorized_by_id)
        VALUES ($1, $2, $3, $4, 'active', $5, $5, $6, $7, $8)
        ON CONFLICT (issuer, account_id, owner_employee_id) DO UPDATE SET
          status = 'active',
          credential_id = COALESCE(EXCLUDED.credential_id, amazon_sp_api.connection_grant.credential_id),
          authorized_by_type = EXCLUDED.authorized_by_type,
          authorized_by_id = EXCLUDED.authorized_by_id,
          updated_at = EXCLUDED.updated_at
        RETURNING connection_id
      `, [
        principal.issuer,
        opaqueId("con"),
        accountId,
        principal.employeeId,
        now,
        credential.rows[0]?.credential_id ?? null,
        starter.started_by_type ?? "employee",
        starter.started_by_id ?? principal.employeeId,
      ]);
      await client.query(`
        INSERT INTO amazon_sp_api.employee_account_binding
          (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at,
           workspace_tenant_id, account_id, unbound_at)
        VALUES ($1, $2, $3, $4, 'active', $5, $5, $3, $6, NULL)
        ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          workspace_tenant_id = EXCLUDED.workspace_tenant_id,
          account_id = EXCLUDED.account_id,
          status = 'active', unbound_at = NULL,
          bound_at = CASE WHEN amazon_sp_api.employee_account_binding.status = 'active'
            THEN amazon_sp_api.employee_account_binding.bound_at ELSE EXCLUDED.bound_at END,
          updated_at = EXCLUDED.updated_at
      `, [
        principal.issuer,
        principal.employeeId,
        principal.tenantId,
        grant.rows[0]!.connection_id,
        now,
        accountId,
      ]);
      await client.query(`
        UPDATE amazon_sp_api.authorization_attempt
        SET status = 'active', connection_id = $1, account_id = $2,
            error_code = NULL, consumed_at = $3, completed_at = $3, updated_at = $3
        WHERE issuer = $4 AND employee_id = $5 AND attempt_id = $6 AND status = 'pending'
      `, [
        grant.rows[0]!.connection_id,
        accountId,
        now,
        principal.issuer,
        principal.employeeId,
        attemptId,
      ]);
    };
    if (database) await operation(database);
    else await this.#transaction(operation);
  }

  async #registeredPrincipal(
    database: Pool | PoolClient,
    issuer: string,
    employeeId: string,
  ): Promise<ConnectedAccountPrincipal> {
    const employee = await database.query<{ workspace_id: string }>(`
      SELECT workspace_id FROM amazon_sp_api.employee_registry
      WHERE issuer = $1 AND employee_id = $2
    `, [issuer, employeeId]);
    const workspaceId = employee.rows[0]?.workspace_id;
    if (!workspaceId) throw new ConnectedAccountError(404, "not_found", "Employee not found");
    return {
      authType: "employee_jwt",
      credentialKind: "employee_jwt",
      tenantId: workspaceId,
      issuer,
      employeeId,
      kid: "employee_registry",
      expiresAt: new Date(this.#now().getTime() + ATTEMPT_TTL_MS).toISOString(),
      scopes: new Set(["connected_accounts:manage"]),
    };
  }

  async #connectionForBinding(
    database: Pool | PoolClient,
    principal: ConnectedAccountPrincipal,
    connectionId: string,
  ): Promise<ConnectedAccountProtocol> {
    const result = await database.query<AccountRow>(`
      SELECT a.account_id, g.connection_id,
             COALESCE(next.selling_partner_id, a.external_account_id) AS external_account_id,
             COALESCE(next.display_name, a.display_name) AS display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.employee_account_binding b
      JOIN amazon_sp_api.connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      LEFT JOIN amazon_sp_api.amazon_account next ON next.account_id = a.account_id
      LEFT JOIN amazon_sp_api.amazon_credential credential ON credential.credential_id = g.credential_id
      WHERE b.issuer = $1 AND b.employee_id = $2 AND b.connection_id = $3
        AND b.status = 'active' AND g.status = 'active'
        AND COALESCE(next.status, a.status) = 'active'
        AND (g.credential_id IS NULL OR credential.status = 'active')
    `, [principal.issuer, principal.employeeId, connectionId]);
    const row = result.rows[0];
    if (!row) throw new ConnectedAccountError(404, "not_found", "Connection not found");
    return connectionFromRow(row);
  }

  async #connectionForGrant(
    database: Pool | PoolClient,
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    requireBinding: boolean,
  ): Promise<ConnectedAccountProtocol> {
    const result = await database.query<AccountRow>(`
      SELECT a.account_id, g.connection_id,
             COALESCE(next.selling_partner_id, a.external_account_id) AS external_account_id,
             COALESCE(next.display_name, a.display_name) AS display_name,
             b.remark, b.bound_at
      FROM amazon_sp_api.connection_grant g
      JOIN amazon_sp_api.external_account_credential a ON a.account_id = g.account_id
      LEFT JOIN amazon_sp_api.amazon_account next ON next.account_id = a.account_id
      LEFT JOIN amazon_sp_api.amazon_credential credential ON credential.credential_id = g.credential_id
      LEFT JOIN amazon_sp_api.employee_account_binding b
        ON b.issuer = g.issuer AND b.employee_id = g.owner_employee_id
       AND b.connection_id = g.connection_id AND b.status = 'active'
      WHERE g.issuer = $1 AND g.owner_employee_id = $2 AND g.connection_id = $3
        AND g.status = 'active' AND COALESCE(next.status, a.status) = 'active'
        AND (g.credential_id IS NULL OR credential.status = 'active')
        ${requireBinding ? "AND b.connection_id IS NOT NULL" : ""}
    `, [principal.issuer, principal.employeeId, connectionId]);
    const row = result.rows[0];
    if (!row) throw new ConnectedAccountError(404, "not_found", "Connection not found");
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
