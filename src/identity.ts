import type { ConnectedAccountJwtVerifier } from "./connected-account.js";

export interface ConnectedAccountEmployeePrincipal {
  authType: "connected-account";
  credentialKind?: "employee_jwt";
  tenantId: string;
  issuer: string;
  employeeId: string;
  kid: string;
  expiresAt: string;
  scopes: ReadonlySet<string>;
}

export interface TestAgentPrincipal {
  authType: "test_agent";
  credentialKind: "test_agent_token";
  tenantId: "tenant-1";
  agentRecordId: string;
  agentId: string;
  scopes: ReadonlySet<string>;
}

export type AmazonPrincipal = ConnectedAccountEmployeePrincipal | TestAgentPrincipal;

export function createAmazonAuthenticator(options: {
  connected-accountVerifier?: ConnectedAccountJwtVerifier;
  authenticateTestAgent?: (token: string) => Promise<TestAgentPrincipal | null>;
}) {
  return async (token: string): Promise<AmazonPrincipal | null> => {
    try {
      if (token.startsWith("oat_")) {
        return await options.authenticateTestAgent?.(token) ?? null;
      }
      const identity = options.connected-accountVerifier?.verify(token);
      return identity ? {
        authType: "connected-account",
        credentialKind: "employee_jwt",
        tenantId: identity.workspaceId,
        issuer: identity.issuer,
        employeeId: identity.employeeId,
        kid: identity.kid,
        expiresAt: identity.expiresAt,
        scopes: identity.scopes,
      } : null;
    } catch {
      return null;
    }
  };
}
