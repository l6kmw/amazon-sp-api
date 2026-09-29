import type { Pool } from "pg";

import type { ConnectedAccountProtocol } from "./connected-accounts.js";
import { ConnectedAccountError } from "./connected-accounts.js";
import type { AmazonPrincipal } from "./identity.js";
import { abortablePoolQuery } from "./postgres-query.js";

interface AccessRow {
  account_id: string;
  connection_id: string;
  selling_partner_id: string;
  display_name: string;
  credential_owner_id: string;
  remark: string | null;
  bound_at: Date | string | null;
}

export interface AmazonAccountAccess {
  account: ConnectedAccountProtocol;
  credentialOwnerId: string;
}

export interface AccountAccessPolicy {
  listAccounts(
    principal: AmazonPrincipal,
    signal?: AbortSignal,
  ): Promise<ConnectedAccountProtocol[]>;
  resolveAccount(
    principal: AmazonPrincipal,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<AmazonAccountAccess>;
}

function account(row: AccessRow): ConnectedAccountProtocol {
  return {
    connectionId: row.connection_id,
    externalAccountId: row.selling_partner_id,
    providerKey: "amazon-sp-api",
    displayName: row.display_name,
    status: "active",
    ...(row.remark !== null ? { remark: row.remark } : {}),
    ...(row.bound_at !== null
      ? { boundAt: new Date(row.bound_at).toISOString() }
      : {}),
    metadata: { account_id: row.account_id },
  };
}

export class PostgresAccountAccessPolicy implements AccountAccessPolicy {
  constructor(readonly pool: Pool) {}

  async listAccounts(
    principal: AmazonPrincipal,
    signal?: AbortSignal,
  ): Promise<ConnectedAccountProtocol[]> {
    const result = principal.authType === "employee_jwt"
      ? await abortablePoolQuery<AccessRow>(this.pool, `
          SELECT a.account_id, g.connection_id, a.selling_partner_id, a.display_name,
                 c.credential_owner_id, b.remark, b.bound_at
          FROM amazon_sp_api.employee_account_binding b
          JOIN amazon_sp_api.connection_grant g
            ON g.issuer = b.issuer AND g.connection_id = b.connection_id
          JOIN amazon_sp_api.amazon_account a ON a.account_id = g.account_id
          JOIN amazon_sp_api.amazon_credential c ON c.credential_id = g.credential_id
          WHERE b.issuer = $1 AND b.employee_id = $2 AND b.status = 'active'
            AND g.status = 'active' AND a.status = 'active' AND c.status = 'active'
          ORDER BY b.bound_at, g.connection_id
        `, [principal.issuer, principal.employeeId], signal)
      : await abortablePoolQuery<AccessRow>(this.pool, `
          SELECT DISTINCT ON (a.account_id)
                 a.account_id, g.connection_id, a.selling_partner_id, a.display_name,
                 c.credential_owner_id, NULL::text AS remark, NULL::timestamptz AS bound_at
          FROM amazon_sp_api.amazon_account a
          JOIN amazon_sp_api.connection_grant g
            ON g.account_id = a.account_id AND g.status = 'active'
          JOIN amazon_sp_api.amazon_credential c
            ON c.credential_id = g.credential_id AND c.status = 'active'
          WHERE a.status = 'active'
          ORDER BY a.account_id, g.issuer, g.connection_id
        `, [], signal);
    return result.rows.map(account);
  }

  async resolveAccount(
    principal: AmazonPrincipal,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<AmazonAccountAccess> {
    const result = principal.authType === "employee_jwt"
      ? await abortablePoolQuery<AccessRow>(this.pool, `
          SELECT a.account_id, g.connection_id, a.selling_partner_id, a.display_name,
                 c.credential_owner_id, b.remark, b.bound_at
          FROM amazon_sp_api.employee_account_binding b
          JOIN amazon_sp_api.connection_grant g
            ON g.issuer = b.issuer AND g.connection_id = b.connection_id
          JOIN amazon_sp_api.amazon_account a ON a.account_id = g.account_id
          JOIN amazon_sp_api.amazon_credential c ON c.credential_id = g.credential_id
          WHERE b.issuer = $1 AND b.employee_id = $2 AND b.status = 'active'
            AND g.status = 'active' AND a.status = 'active' AND c.status = 'active'
            AND a.account_id = $3
        `, [principal.issuer, principal.employeeId, accountId], signal)
      : await abortablePoolQuery<AccessRow>(this.pool, `
          SELECT a.account_id, g.connection_id, a.selling_partner_id, a.display_name,
                 c.credential_owner_id, NULL::text AS remark, NULL::timestamptz AS bound_at
          FROM amazon_sp_api.amazon_account a
          JOIN amazon_sp_api.connection_grant g
            ON g.account_id = a.account_id AND g.status = 'active'
          JOIN amazon_sp_api.amazon_credential c
            ON c.credential_id = g.credential_id AND c.status = 'active'
          WHERE a.status = 'active' AND a.account_id = $1
          ORDER BY g.issuer, g.connection_id
          LIMIT 1
        `, [accountId], signal);
    const row = result.rows[0];
    if (!row) throw new ConnectedAccountError(404, "not_found", "Account not found");
    return { account: account(row), credentialOwnerId: row.credential_owner_id };
  }

}
