import type { Express, Response } from "express";

export const PUBLIC_MCP_PATH = "/mcp/amazon";

export interface AmazonPortalOptions {
  publicOrigin: string;
  version: string;
  toolCount: number;
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
  return {
    service: {
      name: "Amazon SP-API",
      version: options.version,
      toolCount: options.toolCount,
    },
    mcp: {
      transport: "streamable-http",
      url: new URL(PUBLIC_MCP_PATH, options.publicOrigin).toString(),
      // Single-user build: MCP is unauthenticated and binds loopback only.
      authenticated: false,
    },
    oauth: {
      loginUrl: new URL("/oauth/amazon/login", options.publicOrigin).toString(),
      redirectUrl: new URL("/oauth/amazon/callback", options.publicOrigin).toString(),
      sellerCentralManageUrl: "https://sellercentral.amazon.com/apps/manage",
    },
    accounts: {
      listUrl: new URL("/api/v1/accounts", options.publicOrigin).toString(),
      authorizationAttemptsUrl: new URL(
        "/api/v1/accounts/authorization-attempts",
        options.publicOrigin,
      ).toString(),
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
