import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CONNECTED_ACCOUNT_PROTOCOL_SCOPES = [
  "config:check",
  "mcp:catalog",
  "mcp:invoke",
  "connected_accounts:manage",
] as const;

export interface ConnectedAccountJwtKey {
  kid: string;
  issuer: string;
  secret: string;
}

export interface VerifiedConnectedAccountIdentity {
  issuer: string;
  employeeId: string;
  workspaceId: string;
  kid: string;
  expiresAt: string;
  scopes: ReadonlySet<string>;
}

export const CONNECTED_ACCOUNT_DISCOVERY_MANIFEST = {
  protocolVersion: "1.0",
  providerKey: "amazon-sp-api",
  displayName: "Amazon SP-API",
  authorizationFlow: "redirect",
  capabilities: {
    multiAccount: true,
    sharedEmployeeBinding: true,
    independentOwnerAuthorization: true,
    remark: true,
    refresh: true,
    unbind: true,
  },
  runtime: {
    listAccountsTool: "amazon_list_accounts",
    accountIdArgument: "account_id",
  },
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | undefined {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    return record(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function numericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasAudience(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((item) => item === expected);
}

export function connected-accountWorkspaceId(issuer: string, employeeId: string): string {
  const issuerHash = createHash("sha256").update(issuer).digest().subarray(0, 12);
  return `jwt-employee:${issuerHash.toString("base64url")}:${employeeId}`;
}

export class ConnectedAccountJwtVerifier {
  readonly #audience: string;
  readonly #keys: ReadonlyMap<string, ConnectedAccountJwtKey>;
  readonly #now: () => number;

  constructor(options: {
    audience: string;
    keys: Iterable<ConnectedAccountJwtKey>;
    now?: () => number;
  }) {
    this.#audience = options.audience;
    this.#keys = new Map([...options.keys].map((key) => [key.kid, key]));
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  verify(token: string): VerifiedConnectedAccountIdentity | null {
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    const header = decodeBase64UrlJson(encodedHeader);
    const payload = decodeBase64UrlJson(encodedPayload);
    if (
      header?.alg !== "HS256" ||
      header.typ !== "JWT" ||
      !nonEmptyString(header.kid) ||
      !payload
    ) return null;

    const key = this.#keys.get(header.kid);
    if (!key) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) return null;

    let actualSignature: Buffer;
    try {
      actualSignature = Buffer.from(encodedSignature, "base64url");
    } catch {
      return null;
    }
    const expectedSignature = createHmac("sha256", key.secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) return null;

    if (
      payload.iss !== key.issuer ||
      !hasAudience(payload.aud, this.#audience) ||
      !nonEmptyString(payload.sub) ||
      !nonEmptyString(payload.jti) ||
      !numericDate(payload.iat) ||
      !numericDate(payload.nbf) ||
      !numericDate(payload.exp) ||
      typeof payload.scope !== "string"
    ) return null;

    const lifetime = payload.exp - payload.iat;
    const now = this.#now();
    const clockSkewSeconds = 30;
    if (
      lifetime <= 0 ||
      lifetime > 300 ||
      payload.nbf >= payload.exp ||
      payload.iat > now + clockSkewSeconds ||
      payload.nbf > now + clockSkewSeconds ||
      payload.exp <= now - clockSkewSeconds
    ) return null;

    const scopes = new Set(payload.scope.split(/\s+/).filter(Boolean));
    if (scopes.size === 0) return null;
    return {
      issuer: key.issuer,
      employeeId: payload.sub,
      workspaceId: connected-accountWorkspaceId(key.issuer, payload.sub),
      kid: key.kid,
      expiresAt: new Date(payload.exp * 1_000).toISOString(),
      scopes,
    };
  }
}
