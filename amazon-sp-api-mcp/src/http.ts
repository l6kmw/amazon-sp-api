import { randomUUID, timingSafeEqual } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";

import type { AmazonPrincipal } from "./identity.js";
import {
  ConnectedAccountAccountError,
  type ConnectedAccountAccountService,
  type ConnectedAccountPrincipal,
} from "./connected-account-accounts.js";
import { normalizeRequestId, runWithToolRequestContext } from "./errors.js";
import { CONNECTED_ACCOUNT_DISCOVERY_MANIFEST, CONNECTED_ACCOUNT_PROTOCOL_SCOPES } from "./connected-account.js";
import { actorTypeFromAuth } from "./logger.js";
import { isLoopbackAddress, mcpMetrics } from "./metrics.js";
import { NULL_LOGGER, type StructuredLogger } from "./logger.js";
import type { PrincipalRequestLimiter } from "./rate-limit.js";

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: {
    tokenStore: "ok" | "error";
    oauthInternal: "ok" | "error";
    encryptionKey: "ok" | "error";
    postgres?: "ok" | "error";
    redis?: "ok" | "error";
    identityService?: "ok" | "error";
  };
}

const NOT_READY: ReadinessResult = {
  status: "not_ready",
  checks: {
    tokenStore: "error",
    oauthInternal: "error",
    encryptionKey: "error",
  },
};

function hasValidBearerToken(request: Request, expected: string): boolean {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

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
  return principal.authType === "connected-account" && principal.scopes.has(scope);
}

function connected-accountError(response: Response, error: unknown): void {
  if (error instanceof ConnectedAccountAccountError) {
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
    throw new ConnectedAccountAccountError(400, "invalid_request", "Request body must be an object");
  }
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new ConnectedAccountAccountError(400, "invalid_request", "Request body contains unknown fields");
  }
  return body as Record<string, unknown>;
}

function connectionId(value: unknown): string {
  if (typeof value !== "string" || !/^con_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ConnectedAccountAccountError(400, "invalid_request", "connectionId is invalid");
  }
  return value;
}

function attemptId(value: unknown): string {
  if (typeof value !== "string" || !/^att_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ConnectedAccountAccountError(400, "invalid_request", "attemptId is invalid");
  }
  return value;
}

export function createAmazonMcpHttpApp(options: {
  authToken?: string;
  authenticate?: (token: string) => Promise<AmazonPrincipal | null>;
  host: string;
  allowedHosts: string[];
  createServer: (principal: AmazonPrincipal) => McpServer;
  toolCount?: number;
  version: string;
  readinessCheck?: () => Promise<ReadinessResult>;
  logger?: StructuredLogger;
  requestLimiter?: PrincipalRequestLimiter;
  connected-accountManifest?: typeof CONNECTED_ACCOUNT_DISCOVERY_MANIFEST;
  connected-accountAccounts?: ConnectedAccountAccountService;
}) {
  const logger = options.logger ?? NULL_LOGGER;
  const app = createMcpExpressApp({
    host: options.host,
    allowedHosts: options.allowedHosts,
  });
  app.disable("x-powered-by");

  const healthHandler = (_request: Request, response: Response) => {
    response.setHeader("cache-control", "no-store");
    response.json({
      status: "ok",
      tools: options.toolCount ?? 6,
      version: options.version,
    });
  };
  app.get("/healthz", healthHandler);
  app.get("/mcp/healthz", healthHandler);

  if (options.connected-accountManifest) {
    app.get("/.well-known/connected-account", (_request, response) => {
      response.setHeader("cache-control", "no-store");
      response.json(options.connected-accountManifest);
    });

    app.get("/connected-account/v1/auth/check", async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const principal = options.authenticate
        ? await options.authenticate(bearerToken(request))
        : null;
      if (!principal || principal.authType !== "connected-account") {
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

    if (options.connected-accountAccounts) {
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
        if (!principal || principal.authType !== "connected-account") {
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
          connected-accountError(response, error);
        }
      };

      app.get("/connected-account/v1/accounts", manage(async (_request, response, principal) => {
        response.json({ items: await options.connected-accountAccounts!.listAccounts(principal) });
      }));

      app.post("/connected-account/v1/accounts/refresh", manage(async (request, response, principal) => {
        objectBody(request, []);
        response.json({ items: await options.connected-accountAccounts!.refreshAccounts(principal) });
      }));

      app.post("/connected-account/v1/accounts/lookup", manage(async (request, response, principal) => {
        const body = objectBody(request, ["connectionIds"]);
        if (
          !Array.isArray(body.connectionIds) ||
          body.connectionIds.length > 100 ||
          body.connectionIds.some((value) => typeof value !== "string")
        ) {
          throw new ConnectedAccountAccountError(
            400,
            "invalid_request",
            "connectionIds must be an array of at most 100 strings",
          );
        }
        const ids = [...new Set(body.connectionIds.map(connectionId))];
        response.json({ items: await options.connected-accountAccounts!.lookupAccounts(principal, ids) });
      }));

      app.post("/connected-account/v1/authorization-attempts", manage(async (
        request,
        response,
        principal,
      ) => {
        objectBody(request, []);
        const attempt = await options.connected-accountAccounts!.createAuthorizationAttempt(principal);
        response.status(201).json(attempt);
      }));

      app.get("/connected-account/v1/authorization-attempts/:attemptId", manage(async (
        request,
        response,
        principal,
      ) => {
        const attempt = await options.connected-accountAccounts!.getAuthorizationAttempt(
          principal,
          attemptId(request.params.attemptId),
        );
        response.json(attempt);
      }));

      app.post("/connected-account/v1/account-bindings", manage(async (request, response, principal) => {
        const body = objectBody(request, ["connectionId"]);
        const result = await options.connected-accountAccounts!.bindAccount(
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
          throw new ConnectedAccountAccountError(
            400,
            "invalid_request",
            "remark must contain at most 80 Unicode characters",
          );
        }
        response.json(await options.connected-accountAccounts!.updateRemark(
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
        await options.connected-accountAccounts!.unbindAccount(
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
        await options.connected-accountAccounts!.disconnect(
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
    let principal: AmazonPrincipal | null = null;
    if (options.authenticate) {
      principal = await options.authenticate(token);
    } else if (options.authToken && hasValidBearerToken(request, options.authToken)) {
      principal = { authType: "legacy" };
    }
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
    if (principal.authType === "connected-account" && !hasConnectedAccountScope(principal, "mcp:invoke")) {
      logger.write("warn", "mcp.scope.rejected", {
        request_id: requestId,
        actor_type: actorTypeFromAuth(principal.authType),
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
    const limit = options.requestLimiter?.acquire(principal.tenantId);
    if (limit && !limit.accepted) {
      logger.write("warn", "mcp.rate_limited", {
        request_id: requestId,
        actor_type: actorTypeFromAuth(principal.authType),
        error_code: "rate_limited",
        result: "rejected",
      });
      mcpMetrics.inc("mcp_rate_limited_total", "MCP rate limited requests", {
        actor_type: actorTypeFromAuth(principal.authType),
        error_code: "rate_limited",
      });
      response.setHeader("retry-after", String(limit.retryAfterSeconds));
      response.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Too many requests" },
        id: null,
      });
      return;
    }
    if (limit?.accepted) {
      const release = limit.release;
      response.once("finish", release);
      response.once("close", release);
    }
    response.locals.amazonPrincipal = principal;
    next();
  });

  app.post("/mcp", async (request, response) => {
    const startedAt = performance.now();
    const requestId = String(response.locals.requestId);
    const principal = response.locals.amazonPrincipal as AmazonPrincipal;
    const method = typeof request.body?.method === "string" ? request.body.method : "unknown";
    const tool = method === "tools/call" && typeof request.body?.params?.name === "string"
      ? request.body.params.name
      : undefined;
    const server = options.createServer(response.locals.amazonPrincipal as AmazonPrincipal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const actorType = actorTypeFromAuth(principal.authType);
    const methodLabel = METHODS_FOR_LOG.has(method) ? method : "unknown";
    try {
      await runWithToolRequestContext({
        requestId,
        ...(tool ? { tool } : {}),
      }, async () => {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      });
    } catch {
      logger.write("error", "mcp.request.failed", {
        request_id: requestId,
        method: methodLabel,
        ...(tool ? { tool } : {}),
        actor_type: actorType,
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
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const result = response.statusCode >= 400 ? "error" : "success";
      logger.write("info", "mcp.request.completed", {
        request_id: requestId,
        method: methodLabel,
        ...(tool ? { tool } : {}),
        actor_type: actorType,
        result,
        duration_ms: durationMs,
      });
      if (method === "tools/call" && tool) {
        logger.write(result === "success" ? "info" : "warn", "mcp.tool.completed", {
          request_id: requestId,
          tool,
          actor_type: actorType,
          result,
          duration_ms: durationMs,
        });
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
