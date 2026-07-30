import type { Express, Request, Response } from "express";

import { authorizeAdminControl, type AdminAgentService } from "./admin-agents.js";
import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import type { AdminSessionManager } from "./admin-session.js";
import { ConnectedAccountAccountError } from "./connected-account-accounts.js";
import type {
  AdminAuthorizationAttempt,
  PostgresConnectedAccountAccountStore,
} from "./postgres-connected-account-accounts.js";

function body(request: Request): { issuer: string; connectionId: string } | null {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return null;
  if (Object.keys(request.body).some((key) => !["issuer", "connection_id"].includes(key))) return null;
  const { issuer, connection_id: connectionId } = request.body as Record<string, unknown>;
  if (
    typeof issuer !== "string" || issuer.length < 1 || issuer.length > 512
    || typeof connectionId !== "string" || !/^con_[A-Za-z0-9_-]{24}$/.test(connectionId)
  ) return null;
  return { issuer, connectionId };
}

function employeeId(value: string): string | null {
  return value.length >= 1 && value.length <= 128 ? value : null;
}

function authorizationBody(request: Request): { issuer: string; employeeId: string } | null {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return null;
  if (Object.keys(request.body).some((key) => !["issuer", "employee_id"].includes(key))) return null;
  const { issuer, employee_id: id } = request.body as Record<string, unknown>;
  if (
    typeof issuer !== "string" || issuer.length < 1 || issuer.length > 512
    || typeof id !== "string" || !employeeId(id)
  ) return null;
  return { issuer, employeeId: id };
}

function adminAttempt(attempt: AdminAuthorizationAttempt) {
  return {
    attempt_id: attempt.attemptId,
    status: attempt.status === "active" ? "completed" : attempt.status,
    ...(attempt.authorizationUrl ? { authorization_url: attempt.authorizationUrl } : {}),
    ...(attempt.connection ? { account_id: attempt.connection.metadata.account_id } : {}),
    created_at: attempt.createdAt,
    expires_at: attempt.expiresAt,
    ...(attempt.errorCode ? { error_code: attempt.errorCode } : {}),
  };
}

function event(
  request: Request,
  response: Response,
  action: string,
  resourceId: string,
): AuditEvent {
  return {
    actorType: "browser_session",
    actorId: "anonymous",
    action,
    resourceType: "employee_account_binding",
    resourceId,
    requestId: auditRequest(request, response),
  };
}

function failure(response: Response, error: unknown): void {
  if (error instanceof ConnectedAccountAccountError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
}

export function registerAdminBindingRoutes(
  app: Express,
  sessions: AdminSessionManager,
  agents: AdminAgentService,
  audits: AdminAuditService,
  accounts: PostgresConnectedAccountAccountStore,
): void {
  const classify = (error: unknown) => error instanceof ConnectedAccountAccountError
    ? { result: "denied" as const, errorCode: error.code }
    : { result: "failed" as const, errorCode: "internal_error" };

  app.post("/api/v1/admin/authorization-attempts", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const value = authorizationBody(request);
    const audit = event(
      request,
      response,
      "authorization.attempt.create",
      value ? `${value.issuer}:${value.employeeId}` : "invalid",
    );
    audit.resourceType = "authorization_attempt";
    let authorizationUrl: string | undefined;
    try {
      const actor = await authorizeAdminControl(request, response, sessions, agents, audits, audit, true);
      if (!actor) return;
      if (!value) {
        await audits.record(audit, "denied", "invalid_request");
        response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
        return;
      }
      const attempt = await audits.run(
        audit,
        async (client) => {
          const created = await accounts.adminCreateAuthorizationAttempt(
            value.issuer,
            value.employeeId,
            "username" in actor ? actor.username : actor.agentId,
            client,
          );
          audit.resourceId = created.attemptId;
          authorizationUrl = created.authorizationUrl;
          return created;
        },
        classify,
      );
      response.status(201).json(adminAttempt(attempt));
    } catch (error) {
      if (authorizationUrl) await accounts.cancelAdminAuthorizationURL(authorizationUrl).catch(() => undefined);
      failure(response, error);
    }
  });

  app.get("/api/v1/admin/authorization-attempts/:attemptId", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const id = /^att_[A-Za-z0-9_-]{24}$/.test(request.params.attemptId)
      ? request.params.attemptId
      : null;
    const audit = event(
      request,
      response,
      "authorization.attempt.read",
      id ?? "invalid",
    );
    audit.resourceType = "authorization_attempt";
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;
      if (!id) {
        await audits.record(audit, "denied", "invalid_request");
        response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
        return;
      }
      let completion;
      try {
        completion = await accounts.pollAdminAuthorizationCompletion(id);
      } catch {
        await audits.record(audit, "failed", "upstream_error").catch(() => undefined);
        response.status(502).json({ error: { code: "upstream_error", message: "Authorization service unavailable" } });
        return;
      }
      const attempt = await audits.run(
        audit,
        (client) => accounts.adminGetAuthorizationAttempt(id, completion, client),
        classify,
      );
      response.json(adminAttempt(attempt));
    } catch (error) { failure(response, error); }
  });

  app.post("/api/v1/admin/connected-account-employees/:employeeId/account-bindings", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const id = employeeId(request.params.employeeId);
    const value = body(request);
    const audit = event(
      request,
      response,
      "employee.binding.share",
      value && id ? `${value.issuer}:${id}:${value.connectionId}` : "invalid",
    );
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      if (!id || !value) {
        await audits.record(audit, "denied", "invalid_request");
        response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
        return;
      }
      const shared = await audits.run(audit, (client) => accounts.adminShareAccount(
        value.issuer,
        id,
        value.connectionId,
        client,
      ), classify);
      response.status(shared.created ? 201 : 200).json(shared.account);
    } catch (error) { failure(response, error); }
  });

  app.delete("/api/v1/admin/connections/:connectionId", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const connectionId = /^con_[A-Za-z0-9_-]{24}$/.test(request.params.connectionId)
      ? request.params.connectionId
      : null;
    const issuer = typeof request.query.issuer === "string" && request.query.issuer.length <= 512
      ? request.query.issuer
      : null;
    const audit = event(
      request,
      response,
      "connection.disconnect",
      issuer && connectionId ? `${issuer}:${connectionId}` : "invalid",
    );
    audit.resourceType = "connection_grant";
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      if (!connectionId || !issuer || Object.keys(request.query).some((key) => key !== "issuer")) {
        await audits.record(audit, "denied", "invalid_request");
        response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
        return;
      }
      await audits.run(
        audit,
        (client) => accounts.adminDisconnectConnection(issuer, connectionId, client),
        classify,
      );
      response.status(204).end();
    } catch (error) { failure(response, error); }
  });

  app.delete(
    "/api/v1/admin/connected-account-employees/:employeeId/account-bindings/:connectionId",
    async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const id = employeeId(request.params.employeeId);
      const connectionId = /^con_[A-Za-z0-9_-]{24}$/.test(request.params.connectionId)
        ? request.params.connectionId
        : null;
      const issuer = typeof request.query.issuer === "string" && request.query.issuer.length <= 512
        ? request.query.issuer
        : null;
      const audit = event(
        request,
        response,
        "employee.binding.unshare",
        issuer && id && connectionId ? `${issuer}:${id}:${connectionId}` : "invalid",
      );
      try {
        if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
        if (!id || !connectionId || !issuer || Object.keys(request.query).some((key) => key !== "issuer")) {
          await audits.record(audit, "denied", "invalid_request");
          response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
          return;
        }
        await audits.run(audit, (client) => accounts.adminUnshareAccount(
          issuer,
          id,
          connectionId,
          client,
        ), classify);
        response.status(204).end();
      } catch (error) { failure(response, error); }
    },
  );
}
