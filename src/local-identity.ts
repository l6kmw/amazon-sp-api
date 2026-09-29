import type { ConnectedAccountProtocol } from "./connected-accounts.js";
import { ConnectedAccountError, type ConnectedAccountService } from "./connected-accounts.js";

/**
 * Single-user identity.
 *
 * This build serves exactly one operator. There is no Connected Account
 * Protocol, no Employee JWT, and no per-tenant isolation: every request is
 * attributed to the fixed local owner below. MCP is unauthenticated because the
 * service binds to loopback only — see `server.ts`.
 */
export const LOCAL_OWNER = {
  issuer: "local",
  employeeId: "local",
  workspaceId: "local",
} as const;

/**
 * The principal every request runs as. It deliberately keeps the
 * `employee_jwt` discriminant so the existing tool layer, metrics and logging
 * keep working unchanged; the identity it reports is the local owner.
 */
export const LOCAL_PRINCIPAL = {
  authType: "employee_jwt" as const,
  credentialKind: "employee_jwt" as const,
  tenantId: LOCAL_OWNER.workspaceId,
  issuer: LOCAL_OWNER.issuer,
  employeeId: LOCAL_OWNER.employeeId,
  kid: "local",
  expiresAt: "9999-12-31T23:59:59.000Z",
  scopes: new Set(["mcp:invoke", "mcp:catalog"]),
};

/**
 * The principal shape the account store expects (issuer/employeeId/workspaceId).
 * Kept as a distinct export so the HTTP layer does not need to know the
 * protocol's ConnectedAccountPrincipal type.
 */
export const LOCAL_ACCOUNT_PRINCIPAL = {
  authType: "employee_jwt" as const,
  tenantId: LOCAL_OWNER.workspaceId,
  issuer: LOCAL_OWNER.issuer,
  employeeId: LOCAL_OWNER.employeeId,
  kid: "local",
  expiresAt: "9999-12-31T23:59:59.000Z",
  scopes: new Set(["mcp:invoke", "mcp:catalog", "connected_accounts:manage"]),
};

export function isLocalLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized.startsWith("127.");
}

/**
 * Adapts the file-backed ConnectedAccountStore to the account access policy the
 * MCP tools expect. The store already scopes rows by principal, so the local
 * owner sees exactly the accounts it bound.
 */
export interface LocalAccountAccess {
  account: ConnectedAccountProtocol;
  credentialOwnerId: string;
}

export interface LocalAccountAccessPolicy {
  // The single-user build ignores the principal argument, but the signatures
  // mirror the multi-tenant policy so the tool layer is unchanged.
  listAccounts(principal?: unknown): Promise<ConnectedAccountProtocol[]>;
  resolveAccount(
    principal: unknown,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<LocalAccountAccess>;
}

export function createLocalAccountAccessPolicy(
  accounts: ConnectedAccountService,
): LocalAccountAccessPolicy {
  return {
    async listAccounts(): Promise<ConnectedAccountProtocol[]> {
      return await accounts.listAccounts(LOCAL_ACCOUNT_PRINCIPAL);
    },
    async resolveAccount(_principal: unknown, accountId: string, _signal?: AbortSignal) {
      try {
        const account = await accounts.resolveAccount(LOCAL_ACCOUNT_PRINCIPAL, accountId);
        return { account, credentialOwnerId: LOCAL_OWNER.workspaceId };
      } catch (error) {
        if (error instanceof ConnectedAccountError) throw error;
        throw new ConnectedAccountError(404, "not_found", "Account not found");
      }
    },
  };
}
