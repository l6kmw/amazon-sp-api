import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AmazonPrincipal } from "./identity.js";
import type {
  ConnectionService,
  ConnectedAccountAuthorizationCompletion,
} from "./connection-service.js";

const PROVIDER_KEY = "amazon-sp-api";
const ATTEMPT_TTL_MS = 10 * 60_000;

export type ConnectedAccountPrincipal = Extract<AmazonPrincipal, { authType: "employee_jwt" }>;
export type MaybePromise<T> = T | Promise<T>;

export interface ConnectedAccountProtocol {
  connectionId: string;
  externalAccountId: string;
  providerKey: typeof PROVIDER_KEY;
  displayName: string;
  status: "active";
  remark?: string;
  boundAt?: string;
  metadata: { account_id: string };
}

export interface ConnectedAccountAuthorizationAttempt {
  attemptId: string;
  status: "pending" | "active" | "failed" | "expired";
  expiresAt: string;
  authorizationUrl?: string;
  connection?: ConnectedAccountProtocol;
  errorCode?: string;
}

export class ConnectedAccountError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly code: "invalid_request" | "not_found" | "conflict" | "upstream_error",
    message: string,
  ) {
    super(message);
    this.name = "ConnectedAccountError";
  }
}

export interface ConnectedAccountService {
  createAuthorizationAttempt(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountAuthorizationAttempt>;
  getAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationAttempt>;
  listAccounts(principal: ConnectedAccountPrincipal): MaybePromise<ConnectedAccountProtocol[]>;
  resolveAccount(
    principal: ConnectedAccountPrincipal,
    accountId: string,
  ): MaybePromise<ConnectedAccountProtocol>;
  refreshAccounts(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountProtocol[]>;
  lookupAccounts(
    principal: ConnectedAccountPrincipal,
    connectionIds: readonly string[],
  ): MaybePromise<ConnectedAccountProtocol[]>;
  bindAccount(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
  ): MaybePromise<{ account: ConnectedAccountProtocol; created: boolean }>;
  shareAccount(
    owner: ConnectedAccountPrincipal,
    connectionId: string,
    target: ConnectedAccountPrincipal,
  ): MaybePromise<{ account: ConnectedAccountProtocol; created: boolean }>;
  unshareAccount(
    owner: ConnectedAccountPrincipal,
    connectionId: string,
    target: ConnectedAccountPrincipal,
  ): MaybePromise<void>;
  updateRemark(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    remark: string,
  ): MaybePromise<ConnectedAccountProtocol>;
  unbindAccount(principal: ConnectedAccountPrincipal, connectionId: string): MaybePromise<void>;
  disconnect(principal: ConnectedAccountPrincipal, connectionId: string): MaybePromise<void>;
}

type OAuthBridge = Pick<
  ConnectionService,
  "createConnectedAccountAuthorizationURL" | "getConnectedAccountAuthorizationCompletion" | "listConnections" |
  "disconnectIfPresent"
>;

interface AttemptRow {
  attempt_id: string;
  status: ConnectedAccountAuthorizationAttempt["status"];
  connection_id: string | null;
  error_code: string | null;
  expires_at: string;
}

interface AccountRow {
  account_id: string;
  connection_id: string;
  external_account_id: string;
  display_name: string;
  remark: string | null;
  bound_at: string | null;
}

function opaqueId(prefix: "acct" | "att" | "con"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function connectionFromRow(row: AccountRow): ConnectedAccountProtocol {
  return {
    connectionId: row.connection_id,
    externalAccountId: row.external_account_id,
    providerKey: PROVIDER_KEY,
    displayName: row.display_name,
    status: "active",
    ...(row.remark !== null ? { remark: row.remark } : {}),
    ...(row.bound_at !== null ? { boundAt: row.bound_at } : {}),
    metadata: { account_id: row.account_id },
  };
}

export class ConnectedAccountStore implements ConnectedAccountService {
  readonly #database: DatabaseSync;
  readonly #oauth: OAuthBridge;
  readonly #authorizationOrigin: string;
  readonly #now: () => Date;

  constructor(options: {
    file: string;
    oauth: OAuthBridge;
    authorizationOrigin: string;
    now?: () => Date;
  }) {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(options.file);
    this.#oauth = options.oauth;
    this.#authorizationOrigin = options.authorizationOrigin;
    this.#now = options.now ?? (() => new Date());
    this.#database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS employee_registry (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (issuer, employee_id)
      );
      CREATE TABLE IF NOT EXISTS external_account_credential (
        account_id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
        authorized_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider_key, external_account_id, owner_workspace_id)
      );
      CREATE TABLE IF NOT EXISTS connection_grant (
        issuer TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES external_account_credential(account_id),
        owner_employee_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (issuer, connection_id),
        UNIQUE (issuer, account_id, owner_employee_id)
      );
      CREATE TABLE IF NOT EXISTS employee_account_binding (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'unbound')),
        remark TEXT,
        bound_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (issuer, employee_id, connection_id),
        FOREIGN KEY (issuer, connection_id) REFERENCES connection_grant(issuer, connection_id)
      );
      CREATE TABLE IF NOT EXISTS authorization_attempt (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'expired')),
        connection_id TEXT,
        error_code TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        PRIMARY KEY (issuer, employee_id, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS employee_binding_connection_idx
        ON employee_account_binding(issuer, connection_id, status);
    `);
  }

  close(): void {
    this.#database.close();
  }

  async createAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
  ): Promise<ConnectedAccountAuthorizationAttempt> {
    this.#touchEmployee(principal);
    const attemptId = opaqueId("att");
    const now = this.#now().toISOString();
    const expiresAt = new Date(this.#now().getTime() + ATTEMPT_TTL_MS).toISOString();
    this.#database.prepare(`
      INSERT INTO authorization_attempt
        (issuer, employee_id, attempt_id, status, expires_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(principal.issuer, principal.employeeId, attemptId, expiresAt, now);

    try {
      const authorizationUrl = await this.#oauth.createConnectedAccountAuthorizationURL(
        principal.tenantId,
        attemptId,
        this.#authorizationOrigin,
      );
      return { attemptId, status: "pending", authorizationUrl, expiresAt };
    } catch {
      this.#database.prepare(`
        UPDATE authorization_attempt
        SET status = 'failed', error_code = 'oauth_unavailable'
        WHERE issuer = ? AND employee_id = ? AND attempt_id = ?
      `).run(principal.issuer, principal.employeeId, attemptId);
      throw new ConnectedAccountError(502, "upstream_error", "Authorization service unavailable");
    }
  }

  async getAuthorizationAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
  ): Promise<ConnectedAccountAuthorizationAttempt> {
    this.#touchEmployee(principal);
    let attempt = this.#attempt(principal, attemptId);
    if (!attempt) throw new ConnectedAccountError(404, "not_found", "Attempt not found");

    if (attempt.status === "pending" && Date.parse(attempt.expires_at) <= this.#now().getTime()) {
      this.#database.prepare(`
        UPDATE authorization_attempt SET status = 'expired', error_code = 'authorization_expired'
        WHERE issuer = ? AND employee_id = ? AND attempt_id = ? AND status = 'pending'
      `).run(principal.issuer, principal.employeeId, attemptId);
      attempt = this.#attempt(principal, attemptId)!;
    }

    if (attempt.status === "pending") {
      let completion: ConnectedAccountAuthorizationCompletion | null;
      try {
        completion = await this.#oauth.getConnectedAccountAuthorizationCompletion(
          principal.tenantId,
          attemptId,
        );
      } catch {
        throw new ConnectedAccountError(502, "upstream_error", "Authorization service unavailable");
      }
      if (completion) {
        this.#completeAttempt(principal, attemptId, completion);
        attempt = this.#attempt(principal, attemptId)!;
      }
    }

    const response: ConnectedAccountAuthorizationAttempt = {
      attemptId: attempt.attempt_id,
      status: attempt.status,
      expiresAt: attempt.expires_at,
    };
    if (attempt.error_code) response.errorCode = attempt.error_code;
    if (attempt.status === "active" && attempt.connection_id) {
      response.connection = this.#connectionForGrant(principal, attempt.connection_id, false);
    }
    return response;
  }

  listAccounts(principal: ConnectedAccountPrincipal): ConnectedAccountProtocol[] {
    this.#touchEmployee(principal);
    return (this.#database.prepare(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM employee_account_binding b
      JOIN connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN external_account_credential a ON a.account_id = g.account_id
      WHERE b.issuer = ? AND b.employee_id = ? AND b.status = 'active'
        AND g.status = 'active' AND a.status = 'active'
      ORDER BY b.bound_at, g.connection_id
    `).all(principal.issuer, principal.employeeId) as unknown as AccountRow[])
      .map(connectionFromRow);
  }

  resolveAccount(
    principal: ConnectedAccountPrincipal,
    accountId: string,
  ): ConnectedAccountProtocol {
    this.#touchEmployee(principal);
    const row = this.#database.prepare(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM employee_account_binding b
      JOIN connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN external_account_credential a ON a.account_id = g.account_id
      WHERE b.issuer = ? AND b.employee_id = ? AND b.status = 'active'
        AND g.status = 'active' AND a.account_id = ? AND a.status = 'active'
    `).get(principal.issuer, principal.employeeId, accountId) as unknown as AccountRow | undefined;
    if (!row) throw new ConnectedAccountError(404, "not_found", "Account not found");
    return connectionFromRow(row);
  }

  async refreshAccounts(principal: ConnectedAccountPrincipal): Promise<ConnectedAccountProtocol[]> {
    return this.listAccounts(principal);
  }

  lookupAccounts(
    principal: ConnectedAccountPrincipal,
    connectionIds: readonly string[],
  ): ConnectedAccountProtocol[] {
    const wanted = new Set(connectionIds);
    return this.listAccounts(principal).filter((account) => wanted.has(account.connectionId));
  }

  bindAccount(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
  ): { account: ConnectedAccountProtocol; created: boolean } {
    this.#touchEmployee(principal);
    this.#connectionForGrant(principal, connectionId, false);
    const existing = this.#database.prepare(`
      SELECT status FROM employee_account_binding
      WHERE issuer = ? AND employee_id = ? AND connection_id = ?
    `).get(principal.issuer, principal.employeeId, connectionId) as { status: string } | undefined;
    const now = this.#now().toISOString();
    this.#database.prepare(`
      INSERT INTO employee_account_binding
        (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        status = 'active',
        bound_at = CASE WHEN employee_account_binding.status = 'active'
          THEN employee_account_binding.bound_at ELSE excluded.bound_at END,
        updated_at = excluded.updated_at
    `).run(
      principal.issuer,
      principal.employeeId,
      principal.tenantId,
      connectionId,
      now,
      now,
    );
    return {
      account: this.#connectionForGrant(principal, connectionId, true),
      created: existing?.status !== "active",
    };
  }

  shareAccount(
    owner: ConnectedAccountPrincipal,
    connectionId: string,
    target: ConnectedAccountPrincipal,
  ): { account: ConnectedAccountProtocol; created: boolean } {
    this.#touchEmployee(owner);
    if (target.issuer !== owner.issuer) {
      throw new ConnectedAccountError(404, "not_found", "Connection not found");
    }
    this.#touchEmployee(target);
    this.#connectionForGrant(owner, connectionId, false);
    const existing = this.#database.prepare(`
      SELECT status FROM employee_account_binding
      WHERE issuer = ? AND employee_id = ? AND connection_id = ?
    `).get(owner.issuer, target.employeeId, connectionId) as { status: string } | undefined;
    const now = this.#now().toISOString();
    this.#database.prepare(`
      INSERT INTO employee_account_binding
        (issuer, employee_id, workspace_id, connection_id, status, bound_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT (issuer, employee_id, connection_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        status = 'active',
        bound_at = CASE WHEN employee_account_binding.status = 'active'
          THEN employee_account_binding.bound_at ELSE excluded.bound_at END,
        updated_at = excluded.updated_at
    `).run(owner.issuer, target.employeeId, target.tenantId, connectionId, now, now);
    return {
      account: this.#connectionForBinding(target, connectionId),
      created: existing?.status !== "active",
    };
  }

  unshareAccount(owner: ConnectedAccountPrincipal, connectionId: string, target: ConnectedAccountPrincipal): void {
    this.#touchEmployee(owner);
    if (target.issuer !== owner.issuer || target.employeeId === owner.employeeId) {
      throw new ConnectedAccountError(404, "not_found", "Connection not found");
    }
    this.#connectionForGrant(owner, connectionId, false);
    this.#database.prepare(`
      UPDATE employee_account_binding SET status = 'unbound', updated_at = ?
      WHERE issuer = ? AND employee_id = ? AND connection_id = ? AND status = 'active'
    `).run(this.#now().toISOString(), owner.issuer, target.employeeId, connectionId);
  }

  updateRemark(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    remark: string,
  ): ConnectedAccountProtocol {
    this.#touchEmployee(principal);
    const result = this.#database.prepare(`
      UPDATE employee_account_binding SET remark = ?, updated_at = ?
      WHERE issuer = ? AND employee_id = ? AND connection_id = ? AND status = 'active'
    `).run(remark, this.#now().toISOString(), principal.issuer, principal.employeeId, connectionId);
    if (result.changes === 0) {
      throw new ConnectedAccountError(404, "not_found", "Binding not found");
    }
    return this.#connectionForBinding(principal, connectionId);
  }

  unbindAccount(principal: ConnectedAccountPrincipal, connectionId: string): void {
    this.#touchEmployee(principal);
    const result = this.#database.prepare(`
      UPDATE employee_account_binding SET status = 'unbound', updated_at = ?
      WHERE issuer = ? AND employee_id = ? AND connection_id = ?
    `).run(this.#now().toISOString(), principal.issuer, principal.employeeId, connectionId);
    if (result.changes === 0) {
      throw new ConnectedAccountError(404, "not_found", "Binding not found");
    }
  }

  async disconnect(principal: ConnectedAccountPrincipal, connectionId: string): Promise<void> {
    this.#touchEmployee(principal);
    const grant = this.#database.prepare(`
      SELECT a.external_account_id, a.owner_workspace_id
      FROM connection_grant g
      JOIN external_account_credential a ON a.account_id = g.account_id
      WHERE g.issuer = ? AND g.owner_employee_id = ? AND g.connection_id = ?
    `).get(principal.issuer, principal.employeeId, connectionId) as {
      external_account_id: string;
      owner_workspace_id: string;
    } | undefined;
    if (!grant) throw new ConnectedAccountError(404, "not_found", "Connection not found");
    await this.#oauth.disconnectIfPresent(grant.owner_workspace_id, grant.external_account_id);
    const now = this.#now().toISOString();
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE connection_grant SET status = 'disconnected', updated_at = ?
        WHERE issuer = ? AND owner_employee_id = ? AND connection_id = ?
      `).run(now, principal.issuer, principal.employeeId, connectionId);
      this.#database.prepare(`
        UPDATE employee_account_binding SET status = 'unbound', updated_at = ?
        WHERE issuer = ? AND connection_id = ?
      `).run(now, principal.issuer, connectionId);
    });
  }

  #touchEmployee(principal: ConnectedAccountPrincipal): void {
    const now = this.#now().toISOString();
    this.#database.prepare(`
      INSERT INTO employee_registry
        (issuer, employee_id, workspace_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (issuer, employee_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        last_seen_at = excluded.last_seen_at
    `).run(principal.issuer, principal.employeeId, principal.tenantId, now, now);
  }

  #attempt(principal: ConnectedAccountPrincipal, attemptId: string): AttemptRow | undefined {
    return this.#database.prepare(`
      SELECT attempt_id, status, connection_id, error_code, expires_at
      FROM authorization_attempt
      WHERE issuer = ? AND employee_id = ? AND attempt_id = ?
    `).get(principal.issuer, principal.employeeId, attemptId) as unknown as AttemptRow | undefined;
  }

  #completeAttempt(
    principal: ConnectedAccountPrincipal,
    attemptId: string,
    completion: ConnectedAccountAuthorizationCompletion,
  ): void {
    const now = this.#now().toISOString();
    this.#transaction(() => {
      const account = this.#database.prepare(`
        SELECT account_id FROM external_account_credential
        WHERE provider_key = ? AND external_account_id = ? AND owner_workspace_id = ?
      `).get(PROVIDER_KEY, completion.sellingPartnerId, principal.tenantId) as
        { account_id: string } | undefined;
      const accountId = account?.account_id ?? opaqueId("acct");
      this.#database.prepare(`
        INSERT INTO external_account_credential
          (account_id, provider_key, external_account_id, owner_workspace_id, display_name,
           status, authorized_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT (provider_key, external_account_id, owner_workspace_id) DO UPDATE SET
          display_name = excluded.display_name,
          status = 'active',
          authorized_at = excluded.authorized_at,
          updated_at = excluded.updated_at
      `).run(
        accountId,
        PROVIDER_KEY,
        completion.sellingPartnerId,
        principal.tenantId,
        `Amazon seller ${completion.sellingPartnerId}`,
        completion.authorizedAt,
        now,
        now,
      );
      const existingGrant = this.#database.prepare(`
        SELECT connection_id FROM connection_grant
        WHERE issuer = ? AND account_id = ? AND owner_employee_id = ?
      `).get(principal.issuer, accountId, principal.employeeId) as
        { connection_id: string } | undefined;
      const connectionId = existingGrant?.connection_id ?? opaqueId("con");
      this.#database.prepare(`
        INSERT INTO connection_grant
          (issuer, connection_id, account_id, owner_employee_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT (issuer, account_id, owner_employee_id) DO UPDATE SET
          status = 'active', updated_at = excluded.updated_at
      `).run(principal.issuer, connectionId, accountId, principal.employeeId, now, now);
      this.#database.prepare(`
        UPDATE authorization_attempt
        SET status = 'active', connection_id = ?, error_code = NULL, consumed_at = ?
        WHERE issuer = ? AND employee_id = ? AND attempt_id = ? AND status = 'pending'
      `).run(connectionId, now, principal.issuer, principal.employeeId, attemptId);
    });
  }

  #connectionForBinding(principal: ConnectedAccountPrincipal, connectionId: string): ConnectedAccountProtocol {
    const row = this.#database.prepare(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM employee_account_binding b
      JOIN connection_grant g
        ON g.issuer = b.issuer AND g.connection_id = b.connection_id
      JOIN external_account_credential a ON a.account_id = g.account_id
      WHERE b.issuer = ? AND b.employee_id = ? AND b.connection_id = ?
        AND b.status = 'active' AND g.status = 'active' AND a.status = 'active'
    `).get(principal.issuer, principal.employeeId, connectionId) as unknown as AccountRow | undefined;
    if (!row) throw new ConnectedAccountError(404, "not_found", "Connection not found");
    return connectionFromRow(row);
  }

  #connectionForGrant(
    principal: ConnectedAccountPrincipal,
    connectionId: string,
    requireBinding: boolean,
  ): ConnectedAccountProtocol {
    const row = this.#database.prepare(`
      SELECT a.account_id, g.connection_id, a.external_account_id, a.display_name,
             b.remark, b.bound_at
      FROM connection_grant g
      JOIN external_account_credential a ON a.account_id = g.account_id
      LEFT JOIN employee_account_binding b
        ON b.issuer = g.issuer AND b.employee_id = g.owner_employee_id
       AND b.connection_id = g.connection_id AND b.status = 'active'
      WHERE g.issuer = ? AND g.owner_employee_id = ? AND g.connection_id = ?
        AND g.status = 'active' AND a.status = 'active'
        ${requireBinding ? "AND b.connection_id IS NOT NULL" : ""}
    `).get(principal.issuer, principal.employeeId, connectionId) as unknown as AccountRow | undefined;
    if (!row) throw new ConnectedAccountError(404, "not_found", "Connection not found");
    return connectionFromRow(row);
  }

  #transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
