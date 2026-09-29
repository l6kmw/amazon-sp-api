import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { registerAdminAccountRoutes } from "./admin-accounts.js";
import { registerAdminAdsRoutes, type AdminAdsService } from "./admin-ads.js";
import { registerAdminAgentRoutes, type AdminAgentService } from "./admin-agents.js";
import { registerAdminAuditRoutes, type AdminAuditService } from "./admin-audit.js";
import { registerAdminBindingRoutes } from "./admin-bindings.js";
import { registerAdminDashboardRoutes, type AdminDashboardDeps } from "./admin-dashboard.js";
import { registerAdminOaRoutes, type AdminOaOptions } from "./admin-oa.js";
import { registerAdminSessionRoutes, type AdminSessionManager } from "./admin-session.js";
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
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST, CONNECTED_ACCOUNT_PROTOCOL_SCOPES } from "./connected-account.js";
import { actorTypeFromAuth, NULL_LOGGER, type StructuredLogger } from "./logger.js";
import {
  NULL_MCP_ARGUMENT_LOGGER,
  type McpArgumentLogger,
} from "./mcp-argument-logger.js";
import { isLoopbackAddress, mcpMetrics } from "./metrics.js";
import { PUBLIC_MCP_PATH } from "./portal.js";
import type { PostgresConnectedAccountStore } from "./postgres-connected-accounts.js";
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
  connectedAccountManifest?: typeof CONNECTED_ACCOUNT_DISCOVERY_MANIFEST;
  connectedAccountService?: ConnectedAccountService;
  adminSessions?: AdminSessionManager;
  adminAgents?: AdminAgentService;
  adminAudits?: AdminAuditService;
  adminBindingAccounts?: PostgresConnectedAccountStore;
  adminDashboard?: AdminDashboardDeps;
  adminAds?: AdminAdsService;
  adminOa?: AdminOaOptions;
  portal?: AmazonPortalOptions;
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
      response.sendFile(privacyPath, (error) => error ? next(error) : undefined);
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
      response.sendFile(companyPath, (error) => error ? next(error) : undefined);
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

  if (options.adminSessions && options.adminAudits) {
    registerAdminSessionRoutes(app, options.adminSessions, options.adminAudits);
    if (options.adminOa) {
      registerAdminOaRoutes(app, options.adminSessions, options.adminAudits, options.adminOa);
    }
    registerAdminAuditRoutes(app, options.adminSessions, options.adminAudits, options.adminAgents);
    if (options.adminAgents) {
      registerAdminAgentRoutes(app, options.adminSessions, options.adminAgents, options.adminAudits);
      if (options.adminBindingAccounts) {
        registerAdminBindingRoutes(
          app,
          options.adminSessions,
          options.adminAgents,
          options.adminAudits,
          options.adminBindingAccounts,
        );
      }
      if (options.adminDashboard) {
        registerAdminDashboardRoutes(
          app,
          options.adminSessions,
          options.adminAgents,
          options.adminAudits,
          options.adminDashboard,
        );
        registerAdminAccountRoutes(
          app,
          options.adminSessions,
          options.adminAgents,
          options.adminAudits,
          options.adminDashboard.pool,
        );
      }
      if (options.adminAds) {
        registerAdminAdsRoutes(
          app,
          options.adminSessions,
          options.adminAgents,
          options.adminAudits,
          options.adminAds,
        );
      }
    }
  }

  if (options.connectedAccountManifest) {
    app.get("/.well-known/connected-account", (_request, response) => {
      response.setHeader("cache-control", "no-store");
      response.json(options.connectedAccountManifest);
    });

    app.get("/connected-account/v1/auth/check", async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const principal = options.authenticate
        ? await options.authenticate(bearerToken(request))
        : null;
      if (!principal || principal.authType !== "employee_jwt") {
        response.setHeader("www-authenticate", "Bearer");
        response.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
        return;
      }
      if (!CONNECTED_ACCOUNT_PROTOCOL_SCOPES.some((scope) => principal.scopes.has(scope))) {
        response.status(403).json({ error: { code: "forbidden", message: "Required scope is missing" } });
        return;
      }
      response.json({
        authenticated: true,
        employeeId: principal.employeeId,
        issuer: principal.issuer,
        kid: principal.kid,
        expiresAt: principal.expiresAt,
      });
    });

    if (options.connectedAccountService) {
      const manage = (
        handler: (
          request: Request,
          response: Response,
          principal: ConnectedAccountPrincipal,
        ) => Promise<void> | void,
      ) => async (request: Request, response: Response) => {
        response.setHeader("cache-control", "no-store");
        const principal = options.authenticate
          ? await options.authenticate(bearerToken(request))
          : null;
        if (!principal || principal.authType !== "employee_jwt") {
          response.setHeader("www-authenticate", "Bearer");
          response.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
          return;
        }
        if (!hasConnectedAccountScope(principal, "connected_accounts:manage")) {
          response.status(403).json({
            error: { code: "forbidden", message: "Required scope is missing" },
          });
          return;
        }
        try {
          await handler(request, response, principal);
        } catch (error) {
          connectedAccountError(response, error);
        }
      };

      app.get("/connected-account/v1/accounts", manage(async (_request, response, principal) => {
        response.json({ items: await options.connectedAccountService!.listAccounts(principal) });
      }));

      app.post("/connected-account/v1/accounts/refresh", manage(async (request, response, principal) => {
        if (request.body !== undefined) objectBody(request, []);
        response.json({ items: await options.connectedAccountService!.refreshAccounts(principal) });
      }));

      app.post("/connected-account/v1/accounts/lookup", manage(async (request, response, principal) => {
        const body = objectBody(request, ["connectionIds"]);
        if (
          !Array.isArray(body.connectionIds) ||
          body.connectionIds.length > 100 ||
          body.connectionIds.some((value) => typeof value !== "string")
        ) {
          throw new ConnectedAccountError(
            400,
            "invalid_request",
            "connectionIds must be an array of at most 100 strings",
          );
        }
        const ids = [...new Set(body.connectionIds.map(connectionId))];
        response.json({ items: await options.connectedAccountService!.lookupAccounts(principal, ids) });
      }));

      app.post("/connected-account/v1/authorization-attempts", manage(async (
        request,
        response,
        principal,
      ) => {
        if (request.body !== undefined) objectBody(request, []);
        const attempt = await options.connectedAccountService!.createAuthorizationAttempt(principal);
        response.status(201).json(attempt);
      }));

      app.get("/connected-account/v1/authorization-attempts/:attemptId", manage(async (
        request,
        response,
        principal,
      ) => {
        const attempt = await options.connectedAccountService!.getAuthorizationAttempt(
          principal,
          attemptId(request.params.attemptId),
        );
        response.json(attempt);
      }));

      app.post("/connected-account/v1/account-bindings", manage(async (request, response, principal) => {
        const body = objectBody(request, ["connectionId"]);
        const result = await options.connectedAccountService!.bindAccount(
          principal,
          connectionId(body.connectionId),
        );
        response.status(result.created ? 201 : 200).json(result.account);
      }));

      app.put("/connected-account/v1/account-bindings/:connectionId/remark", manage(async (
        request,
        response,
        principal,
      ) => {
        const body = objectBody(request, ["remark"]);
        if (typeof body.remark !== "string" || [...body.remark].length > 80) {
          throw new ConnectedAccountError(
            400,
            "invalid_request",
            "remark must contain at most 80 Unicode characters",
          );
        }
        response.json(await options.connectedAccountService!.updateRemark(
          principal,
          connectionId(request.params.connectionId),
          body.remark,
        ));
      }));

      app.delete("/connected-account/v1/account-bindings/:connectionId", manage(async (
        request,
        response,
        principal,
      ) => {
        await options.connectedAccountService!.unbindAccount(
          principal,
          connectionId(request.params.connectionId),
        );
        response.status(204).end();
      }));

      app.delete("/connected-account/v1/connections/:connectionId", manage(async (
        request,
        response,
        principal,
      ) => {
        await options.connectedAccountService!.disconnect(
          principal,
          connectionId(request.params.connectionId),
        );
        response.status(204).end();
      }));
    }
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
    const token = bearerToken(request);
    const principal = options.authenticate
      ? await options.authenticate(token)
      : null;
    if (!principal) {
      logger.write("warn", "mcp.auth.rejected", {
        request_id: requestId,
        error_code: "auth_rejected",
        result: "rejected",
      });
      mcpMetrics.inc("mcp_auth_failures_total", "MCP authentication failures", {
        error_code: "auth_rejected",
      });
      response.setHeader("www-authenticate", "Bearer");
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const actorIdHash = logger.hash(
      principal.authType === "employee_jwt" ? principal.employeeId : principal.agentId,
    );
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
    const actorIdHash = logger.hash(
      principal.authType === "employee_jwt" ? principal.employeeId : principal.agentId,
    );
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
        if (toolContext.failureCode && options.adminAudits) {
          try {
            await options.adminAudits.record({
              actorType: principal.authType === "employee_jwt" ? "employee_jwt" : "agent_token",
              actorId: actorIdHash ?? "unknown",
              agentRecordId: principal.authType === "test_agent"
                ? principal.agentRecordId
                : undefined,
              action: "mcp.tool.failed",
              resourceType: "mcp_tool",
              resourceId: tool,
              requestId,
            }, "failed", toolContext.failureCode);
          } catch {
            logger.write("error", "mcp.alert.persist_failed", {
              request_id: requestId,
              tool,
              actor_type: actorType,
              actor_id_hash: actorIdHash,
              result: "error",
              error_code: "internal_error",
            });
          }
        }
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
