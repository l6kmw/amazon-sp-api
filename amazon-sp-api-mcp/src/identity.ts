import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { ConnectedAccountJwtVerifier } from "./connected-account.js";

export type AmazonPrincipal =
  | { authType: "legacy"; tenantId?: string }
  | { authType: "legacy"; tenantId: string }
  | {
    authType: "connected-account";
    tenantId: string;
    issuer: string;
    employeeId: string;
    kid: string;
    expiresAt: string;
    scopes: ReadonlySet<string>;
  };

export interface IdentityVerifier {
  verify(token: string): Promise<AmazonPrincipal | null>;
}

function isLocalIdentityHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "host.docker.internal") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return hostname === "::1";
}

export class LegacyIdentityVerifier implements IdentityVerifier {
  readonly #url: URL;
  readonly #fetch: typeof fetch;

  constructor(options: { url: string; fetchImpl?: typeof fetch }) {
    this.#url = new URL(options.url);
    const secureRemote = this.#url.protocol === "https:";
    const localPlaintext = this.#url.protocol === "http:" && isLocalIdentityHost(this.#url.hostname);
    if ((!secureRemote && !localPlaintext) || this.#url.username || this.#url.password) {
      throw new Error("identity validation URL must use HTTPS unless it targets a local endpoint");
    }
    this.#fetch = options.fetchImpl || fetch;
  }

  async verify(token: string): Promise<AmazonPrincipal | null> {
    const response = await this.#fetch(this.#url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { authenticated?: boolean; user_id?: string };
    if (!body.authenticated || !body.user_id?.match(/^[A-Za-z0-9_-]{1,128}$/)) return null;
    return { authType: "legacy", tenantId: body.user_id };
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createAmazonAuthenticator(options: {
  legacyToken?: string;
  allowLegacyAuth?: boolean;
  legacyTenantId?: string;
  identityVerifier: IdentityVerifier;
  connected-accountVerifier?: ConnectedAccountJwtVerifier;
}) {
  return async (token: string): Promise<AmazonPrincipal | null> => {
    if (
      options.allowLegacyAuth &&
      options.legacyToken &&
      constantTimeEqual(token, options.legacyToken)
    ) {
      return {
        authType: "legacy",
        ...(options.legacyTenantId ? { tenantId: options.legacyTenantId } : {}),
      };
    }
    if (token.startsWith("oat_")) {
      try {
        return await options.identityVerifier.verify(token);
      } catch {
        return null;
      }
    }
    try {
      const identity = options.connected-accountVerifier?.verify(token);
      return identity ? {
        authType: "connected-account",
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
