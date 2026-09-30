import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { LOCAL_ACCOUNT_PRINCIPAL, LOCAL_PRINCIPAL } from "./local-identity.js";/**
 * Operator details for the public legal pages (company profile + privacy policy).
 * These pages are shown to Amazon during seller-app review, so a self-hosted
 * deployment must present its own entity. Unset values stay as literal
 * placeholders rather than silently rendering someone else's company.
 */
export interface OperatorProfile {
  name: string;
  legalName?: string;
  legalNameEn?: string;
  url?: string;
  wwwUrl?: string;
  email?: string;
  siteUrl?: string;
  initial?: string;
  registrationId?: string;
}

function renderLegalPage(templatePath: string, operator?: OperatorProfile): string {
  const html = fs.readFileSync(templatePath, "utf8");
  if (!operator) return html;
  const values: Record<string, string> = {
    OPERATOR_NAME: operator.name,
    OPERATOR_INITIAL: operator.initial ?? operator.name.slice(0, 1).toUpperCase(),
    COPYRIGHT_YEAR: String(new Date().getFullYear()),
  };
  for (const [key, value] of Object.entries({
    OPERATOR_LEGAL_NAME: operator.legalName,
    OPERATOR_LEGAL_NAME_EN: operator.legalNameEn,
    OPERATOR_URL: operator.url,
    OPERATOR_WWW_URL: operator.wwwUrl ?? operator.url,
    OPERATOR_EMAIL: operator.email,
    OPERATOR_SITE_URL: operator.siteUrl,
    OPERATOR_REGISTRATION_ID: operator.registrationId,
  })) {
    if (value !== undefined) values[key] = value;
  }
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

import type { AmazonPrincipal } from "./identity.js";
import {
  ConnectedAccountError,
  type ConnectedAccountService,
  type ConnectedAccountPrincipal,
} from "./connected-accounts.js";
import {
  normalizeRequestId,
  runWithToolRequestContext,
  type ToolRequestContext,
} from "./errors.js";
import { actorTypeFromAuth, NULL_LOGGER, type StructuredLogger } from "./logger.js";
import {
  NULL_MCP_ARGUMENT_LOGGER,
  type McpArgumentLogger,
} from "./mcp-argument-logger.js";
import { isLoopbackAddress, mcpMetrics } from "./metrics.js";
import { PUBLIC_MCP_PATH } from "./portal.js";
import {
  registerAmazonPortal,
  type AmazonPortalOptions,
} from "./portal.js";

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: {
    lwa: "ok" | "error";
    tokenStore: "ok" | "error";
    encryptionKey: "ok" | "error";
    postgres?: "ok" | "error";
    redis?: "ok" | "error";
  };
}

const NOT_READY: ReadinessResult = {
  status: "not_ready",
  checks: {
    lwa: "error",
    tokenStore: "error",
    encryptionKey: "error",
  },
};

function bearerToken(request: Request): string {
  const authorization = request.header("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function methodNotAllowed(response: Response): void {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
}

function hasConnectedAccountScope(principal: AmazonPrincipal, scope: string): boolean {
  return principal.authType === "employee_jwt" && principal.scopes.has(scope);
}

const CONNECTED_ACCOUNT_CATALOG_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
]);

function hasMcpAccess(principal: AmazonPrincipal, request: Request): boolean {
  if (principal.scopes.has("mcp:invoke")) return true;
  if (!principal.scopes.has("mcp:catalog")) return false;
  if (request.method === "GET") return true;
  if (request.method !== "POST") return false;
  return CONNECTED_ACCOUNT_CATALOG_METHODS.has(request.body?.method);
}

function connectedAccountError(response: Response, error: unknown): void {
  if (error instanceof ConnectedAccountError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({
    error: { code: "internal_error", message: "Internal server error" },
  });
}

function objectBody(request: Request, allowedKeys: readonly string[]): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConnectedAccountError(400, "invalid_request", "Request body must be an object");
  }
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new ConnectedAccountError(400, "invalid_request", "Request body contains unknown fields");
  }
  return body as Record<string, unknown>;
}

function connectionId(value: unknown): string {
  if (typeof value !== "string" || !/^con_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ConnectedAccountError(400, "invalid_request", "connectionId is invalid");
  }
  return value;
}

function attemptId(value: unknown): string {
  if (typeof value !== "string" || !/^att_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ConnectedAccountError(400, "invalid_request", "attemptId is invalid");
  }
  return value;
}

function toolArgumentCalls(body: unknown): Array<{
  tool: string;
  argumentsPresent: boolean;
  arguments: unknown;
}> {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
    const request = message as Record<string, unknown>;
    if (request.method !== "tools/call") return [];
    const params = typeof request.params === "object"
      && request.params !== null
      && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : undefined;
    const argumentsPresent = params !== undefined
      && Object.prototype.hasOwnProperty.call(params, "arguments");
    return [{
      tool: typeof params?.name === "string" ? params.name : "unknown",
      argumentsPresent,
      arguments: argumentsPresent ? params.arguments : undefined,
    }];
  });
}

export function createAmazonMcpHttpApp(options: {
  authenticate?: (token: string) => Promise<AmazonPrincipal | null>;
  host: string;
  allowedHosts: string[];
  createServer: (principal: AmazonPrincipal) => McpServer;
  toolCount?: number;
  version: string;
  lwaConfigured?: boolean;
  readinessCheck?: () => Promise<ReadinessResult>;
  logger?: StructuredLogger;
  argumentLogger?: Pick<McpArgumentLogger, "log">;
  connectedAccountService?: ConnectedAccountService;
  portal?: AmazonPortalOptions;
  operator?: OperatorProfile;
}) {
  const logger = options.logger ?? NULL_LOGGER;
  const argumentLogger = options.argumentLogger ?? NULL_MCP_ARGUMENT_LOGGER;
  const app = createMcpExpressApp({
    host: options.host,
    allowedHosts: options.allowedHosts,
  });
  app.disable("x-powered-by");
  if (options.portal) {
    registerAmazonPortal(app, options.portal);
    app.get("/amazon/api/status", async (_request, response) => {
      response.setHeader("cache-control", "no-store");
      try {
        const result = await options.readinessCheck?.();
        if (!result || result.status !== "ready") {
          response.status(503).json({ status: "not_ready" });
          return;
        }
        response.json({ status: "ready" });
      } catch {
        response.status(503).json({ status: "not_ready" });
      }
    });
  }

  const healthHandler = (_request: Request, response: Response) => {
    response.setHeader("cache-control", "no-store");
    response.json({
      status: "ok",
      tools: options.toolCount ?? 6,
      version: options.version,
      lwaConfigured: options.lwaConfigured ?? false,
    });
  };
  app.get("/healthz", healthHandler);
  app.get("/mcp/healthz", healthHandler);

  app.get("/admin-config.js", (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    const publicBaseURL = options.portal?.publicOrigin || "";
    response.send(`window.__AMAZON_SP_API_ADMIN_CONFIG__ = {
  publicBaseURL: ${JSON.stringify(publicBaseURL)},
  providerName: "Amazon SP-API",
  mcpPath: ${JSON.stringify(PUBLIC_MCP_PATH)}
};`);
  });

  const webDistPath = path.resolve(process.cwd(), "web/admin/dist");
  const privacyPath = [
    path.join(webDistPath, "privacy.html"),
    path.resolve(process.cwd(), "web/admin/public/privacy.html"),
  ].find((candidate) => fs.existsSync(candidate));
  if (privacyPath) {
    app.get("/privacy", (_request, response, next) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("x-content-type-options", "nosniff");
      response.send(renderLegalPage(privacyPath, options.operator));
    });
  }
  const companyPath = [
    path.join(webDistPath, "company.html"),
    path.resolve(process.cwd(), "web/admin/public/company.html"),
  ].find((candidate) => fs.existsSync(candidate));
  if (companyPath) {
    app.get("/company", (_request, response, next) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("x-content-type-options", "nosniff");
      response.send(renderLegalPage(companyPath, options.operator));
    });
  }
  if (fs.existsSync(webDistPath)) {
    app.use(express.static(webDistPath, {
      index: "index.html",
      setHeaders: (res, filePath) => {
        if (
          filePath.endsWith("index.html")
          || filePath.endsWith("admin-config.js")
          || filePath.endsWith("company.html")
          || filePath.endsWith("privacy.html")
        ) {
          res.setHeader("cache-control", "no-store");
        } else {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        }
      }
    }));
  }


  // Single-user: minimal account API. There is no Connected Account Protocol,
  // no JWT, and no tenant scoping — the service binds loopback only.
  if (options.connectedAccountService) {
    app.get("/api/v1/accounts", async (_request, response) => {
      response.setHeader("cache-control", "no-store");
      try {
        const accounts = await options.connectedAccountService!.listAccounts(LOCAL_ACCOUNT_PRINCIPAL);
        response.json({ items: accounts });
      } catch (error) {
        connectedAccountError(response, error);
      }
    });

    app.post("/api/v1/accounts/authorization-attempts", async (_request, response) => {
      response.setHeader("cache-control", "no-store");
      try {
        const attempt = await options.connectedAccountService!.createAuthorizationAttempt(
          LOCAL_ACCOUNT_PRINCIPAL,
        );
        response.status(201).json(attempt);
      } catch (error) {
        connectedAccountError(response, error);
      }
    });

    app.get("/api/v1/accounts/authorization-attempts/:attemptId", async (request, response) => {
      response.setHeader("cache-control", "no-store");
      try {
        const attempt = await options.connectedAccountService!.getAuthorizationAttempt(
          LOCAL_ACCOUNT_PRINCIPAL,
          String(request.params.attemptId ?? ""),
        );
        response.json(attempt);
      } catch (error) {
        connectedAccountError(response, error);
      }
    });

    app.delete("/api/v1/accounts/:connectionId", async (request, response) => {
      response.setHeader("cache-control", "no-store");
      try {
        await options.connectedAccountService!.disconnect(
          LOCAL_ACCOUNT_PRINCIPAL,
          String(request.params.connectionId ?? ""),
        );
        response.status(204).end();
      } catch (error) {
        connectedAccountError(response, error);
      }
    });
  }


  app.get("/readyz", async (_request, response) => {
    response.setHeader("cache-control", "no-store");
    try {
      const result = await options.readinessCheck?.();
      if (!result || result.status !== "ready") response.status(503);
      response.json(result ?? NOT_READY);
    } catch {
      response.status(503).json(NOT_READY);
    }
  });

  app.use("/mcp", async (request: Request, response: Response, next: NextFunction) => {
    const requestId = normalizeRequestId(request.header("x-request-id") ?? randomUUID());
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    // Single-user build: the service binds loopback only, so MCP is not
    // authenticated. Every call runs as the fixed local owner.
    const principal = LOCAL_PRINCIPAL;
    const actorIdHash = logger.hash(principal.employeeId);
    if (!hasMcpAccess(principal, request)) {
      logger.write("warn", "mcp.scope.rejected", {
        request_id: requestId,
        actor_type: actorTypeFromAuth(principal.authType),
        actor_id_hash: actorIdHash,
        error_code: "scope_rejected",
        result: "rejected",
      });
      mcpMetrics.inc("mcp_scope_failures_total", "MCP scope failures", {
        error_code: "scope_rejected",
        actor_type: actorTypeFromAuth(principal.authType),
      });
      response.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Required scope is missing" },
        id: request.body?.id ?? null,
      });
      return;
    }
    if (!principal.tenantId) {
      logger.write("warn", "mcp.tenant.rejected", {
        request_id: requestId,
        actor_type: actorTypeFromAuth(principal.authType),
        actor_id_hash: actorIdHash,
        error_code: "unauthorized",
        result: "rejected",
      });
      response.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Tenant identity required" },
        id: request.body?.id ?? null,
      });
      return;
    }
    response.locals.amazonPrincipal = principal;
    next();
  });

  app.post("/mcp", async (request, response) => {
    const startedAt = performance.now();
    const requestId = String(response.locals.requestId);
    const principal = response.locals.amazonPrincipal as AmazonPrincipal;
    const method = typeof request.body?.method === "string" ? request.body.method : "unknown";
    const tool = method === "tools/call"
      ? (typeof request.body?.params?.name === "string" ? request.body.params.name : "unknown")
      : undefined;
    const actorType = actorTypeFromAuth(principal.authType);
    const actorIdHash = logger.hash(principal.employeeId);
    const methodLabel = METHODS_FOR_LOG.has(method) ? method : "unknown";
    const argumentCalls = toolArgumentCalls(request.body);
    const toolContext: ToolRequestContext = {
      requestId,
      ...(tool ? { tool } : {}),
    };
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      await runWithToolRequestContext(toolContext, async () => {
        for (const argumentCall of argumentCalls) {
          try {
            await argumentLogger.log({
              requestId,
              tool: argumentCall.tool,
              actorType,
              actorIdHash,
              argumentsPresent: argumentCall.argumentsPresent,
              arguments: argumentCall.arguments,
            });
          } catch {
            logger.write("error", "mcp.argument_log.failed", {
              request_id: requestId,
              tool: argumentCall.tool,
              actor_type: actorType,
              actor_id_hash: actorIdHash,
              result: "error",
              error_code: "internal_error",
            });
          }
        }
        server = options.createServer(principal);
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      });
    } catch {
      logger.write("error", "mcp.request.failed", {
        request_id: requestId,
        method: methodLabel,
        ...(tool ? { tool } : {}),
        actor_type: actorType,
        actor_id_hash: actorIdHash,
        error_code: "protocol_error",
        result: "error",
      });
      mcpMetrics.inc("mcp_protocol_failures_total", "MCP protocol failures", {
        error_code: "protocol_error",
        actor_type: actorType,
      });
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const result = toolContext.failureCode || response.statusCode >= 400 ? "error" : "success";
      logger.write("info", "mcp.request.completed", {
        request_id: requestId,
        method: methodLabel,
        ...(tool ? { tool } : {}),
        actor_type: actorType,
        actor_id_hash: actorIdHash,
        result,
        ...(toolContext.failureCode ? { error_code: toolContext.failureCode } : {}),
        duration_ms: durationMs,
      });
      if (method === "tools/call" && tool) {
        logger.write(
          result === "success" ? "info" : "warn",
          result === "success" ? "mcp.tool.completed" : "mcp.tool.failed",
          {
            request_id: requestId,
            tool,
            actor_type: actorType,
            actor_id_hash: actorIdHash,
            result,
            ...(toolContext.failureCode ? { error_code: toolContext.failureCode } : {}),
            duration_ms: durationMs,
          },
        );
        mcpMetrics.inc("mcp_tool_results_total", "MCP tool call results", {
          tool,
          result,
          actor_type: actorType,
        });
        mcpMetrics.observeSeconds("mcp_tool_duration_seconds", "MCP tool duration", durationMs / 1000, {
          tool,
          result,
          actor_type: actorType,
        });
      }
    }
  });

  app.get("/internal/metrics", (request, response) => {
    response.setHeader("cache-control", "no-store");
    const remote = request.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      response.status(404).end();
      return;
    }
    response.status(200);
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.send(mcpMetrics.renderPrometheus());
  });

  app.get("/mcp", (_request, response) => methodNotAllowed(response));
  app.delete("/mcp", (_request, response) => methodNotAllowed(response));

  return app;
}

const METHODS_FOR_LOG = new Set([
  "initialize",
  "tools/list",
  "tools/call",
  "ping",
]);
