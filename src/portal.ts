import type { Express, Response } from "express";

import { CONNECTED_ACCOUNT_PROTOCOL_SCOPES } from "./connected-account.js";

export const PUBLIC_MCP_PATH = "/mcp/amazon";

export interface AmazonPortalOptions {
  publicOrigin: string;
  version: string;
  toolCount: number;
  connectedAccountEnabled: boolean;
  connectedAccountAudience?: string;
  connectedAccountOrigins: string[];
  connectedAccountJwtKeys: Array<{ kid: string; issuer: string }>;
}

function setPortalSecurityHeaders(response: Response): void {
  response.setHeader("content-security-policy", [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "));
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

export function publicAmazonPortalConfig(options: AmazonPortalOptions) {
  const providerBaseUrl = new URL("/connected-account/v1/", options.publicOrigin).toString();
  const connectedAccountOrigin = options.connectedAccountOrigins[0];
  return {
    service: {
      name: "Amazon SP-API",
      version: options.version,
      toolCount: options.toolCount,
    },
    mcp: {
      transport: "streamable-http",
      url: new URL(PUBLIC_MCP_PATH, options.publicOrigin).toString(),
      headerName: "Authorization",
      headerTemplate: "Bearer <CONNECTED_ACCOUNT_JWT>",
    },
    oauth: {
      loginUrl: new URL("/oauth/amazon/login", options.publicOrigin).toString(),
      redirectUrl: new URL("/oauth/amazon/callback", options.publicOrigin).toString(),
      sellerCentralManageUrl: "https://sellercentral.amazon.com/apps/manage",
    },
    provider: {
      enabled: options.connectedAccountEnabled,
      discoveryUrl: new URL(
        "/.well-known/connected-account",
        options.publicOrigin,
      ).toString(),
      apiBaseUrl: providerBaseUrl,
      authCheckUrl: new URL("auth/check", providerBaseUrl).toString(),
      audience: options.connectedAccountAudience ?? "",
      jwtKeys: options.connectedAccountJwtKeys,
      requiredScopes: [...CONNECTED_ACCOUNT_PROTOCOL_SCOPES],
      employeeConsoleUrl: connectedAccountOrigin
        ? new URL("/employees", connectedAccountOrigin).toString()
        : "",
    },
  };
}

export function registerAmazonPortal(app: Express, options: AmazonPortalOptions): void {
  app.use("/amazon", (_request, response, next) => {
    setPortalSecurityHeaders(response);
    next();
  });
  app.get("/amazon/api/config", (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(publicAmazonPortalConfig(options));
  });
}
