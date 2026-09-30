/**
 * Single-user identity surface.
 *
 * This build has no Employee JWT and no agent tokens: every request runs as the
 * fixed local owner defined in `local-identity.ts`. The principal type below is
 * kept because the tool layer, logger and metrics all describe their caller
 * through it.
 */
export interface LocalOwnerPrincipal {
  authType: "employee_jwt";
  credentialKind?: "employee_jwt";
  tenantId: string;
  issuer: string;
  employeeId: string;
  kid: string;
  expiresAt: string;
  scopes: ReadonlySet<string>;
}

export type AmazonPrincipal = LocalOwnerPrincipal;
