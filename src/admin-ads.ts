import type { Express, Request, Response } from "express";
import { z } from "zod";

import { authorizeAdminControl, type AdminAgentService } from "./admin-agents.js";
import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import type { AdminSessionManager } from "./admin-session.js";

const bindingSchema = z.object({
  connection_id: z.string(),
  issuer: z.string(),
  employee_id: z.string(),
  status: z.enum(["active", "unbound"]),
  remark: z.string().nullable(),
  bound_at: z.string(),
  updated_at: z.string(),
  is_owner: z.boolean(),
}).strict();

const accountSchema = z.object({
  provider_key: z.literal("amazon-ads"),
  account_id: z.string(),
  connection_id: z.string(),
  external_account_id: z.string(),
  display_name: z.string(),
  status: z.enum(["active", "disconnected", "profile_missing"]),
  owner_issuer: z.string(),
  owner_employee_id: z.string(),
  active_bindings_count: z.number().int().nonnegative(),
  updated_at: z.string(),
  region: z.enum(["na", "eu", "fe"]).optional(),
  country_code: z.string().optional(),
  currency_code: z.string().optional(),
  account_type: z.string().optional(),
  marketplace_id: z.string().optional(),
  bindings: z.array(bindingSchema),
}).strict();

const employeeSchema = z.object({
  issuer: z.string(),
  employee_id: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  active_bindings_count: z.number().int().nonnegative(),
  total_bindings_count: z.number().int().nonnegative(),
}).strict();

const accountListSchema = z.object({
  items: z.array(accountSchema),
  total: z.number().int().nonnegative(),
}).strict();

const employeeListSchema = z.object({
  items: z.array(employeeSchema),
  total: z.number().int().nonnegative(),
}).strict();

const sharedSchema = z.object({ shared: z.literal(true) }).strict();

export type AdminAdsAccount = z.infer<typeof accountSchema>;
export type AdminAdsEmployee = z.infer<typeof employeeSchema>;

export class AdminAdsProxyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AdminAdsProxyError";
  }
}

export interface AdminAdsService {
  listAccounts(): Promise<{ items: AdminAdsAccount[]; total: number }>;
  getAccount(accountId: string): Promise<AdminAdsAccount>;
  listEmployees(): Promise<{ items: AdminAdsEmployee[]; total: number }>;
  shareBinding(connectionId: string, issuer: string, employeeId: string): Promise<void>;
  unshareBinding(connectionId: string, issuer: string, employeeId: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
}

export class LoopbackAdminAdsClient implements AdminAdsService {
  readonly #origin: string;

  constructor(origin = "http://127.0.0.1:8790") {
    const value = new URL(origin);
    if (
      value.protocol !== "http:" || value.hostname !== "127.0.0.1" ||
      value.username || value.password || value.pathname !== "/" || value.search || value.hash
    ) {
      throw new Error("Ads admin origin must be an exact 127.0.0.1 HTTP origin");
    }
    this.#origin = value.origin;
  }

  listAccounts() {
    return this.#json("/accounts", accountListSchema);
  }

  getAccount(accountId: string) {
    return this.#json(`/accounts/${encodeURIComponent(accountId)}`, accountSchema);
  }

  listEmployees() {
    return this.#json("/employees", employeeListSchema);
  }

  async shareBinding(connectionId: string, issuer: string, employeeId: string): Promise<void> {
    await this.#json("/account-bindings", sharedSchema, {
      method: "POST",
      body: JSON.stringify({ connection_id: connectionId, issuer, employee_id: employeeId }),
    });
  }

  async unshareBinding(connectionId: string, issuer: string, employeeId: string): Promise<void> {
    const query = new URLSearchParams({ issuer, employee_id: employeeId });
    await this.#empty(`/account-bindings/${encodeURIComponent(connectionId)}?${query}`, "DELETE");
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.#empty(`/connections/${encodeURIComponent(connectionId)}`, "DELETE");
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, init);
    const text = await response.text();
    if (text.length > 1_000_000) throw new AdminAdsProxyError(502, "upstream_error", "Ads response is too large");
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw new AdminAdsProxyError(502, "upstream_error", "Ads response is invalid");
    }
  }

  async #empty(path: string, method: "DELETE"): Promise<void> {
    const response = await this.#request(path, { method });
    if (response.status !== 204) {
      throw new AdminAdsProxyError(502, "upstream_error", "Ads response is invalid");
    }
  }

  async #request(path: string, init: RequestInit): Promise<globalThis.Response> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.#origin}/_internal/admin/amazon-ads${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw new AdminAdsProxyError(503, "upstream_error", "Amazon Ads service is unavailable");
    }
    if (!response.ok) {
      const status = [400, 404, 409].includes(response.status) ? response.status : 502;
      const code = response.status === 404 ? "not_found"
        : response.status === 409 ? "conflict"
          : response.status === 400 ? "invalid_request" : "upstream_error";
      throw new AdminAdsProxyError(status, code, "Amazon Ads management request failed");
    }
    return response;
  }
}

function event(request: Request, response: Response, action: string, resourceId: string): AuditEvent {
  return {
    actorType: "browser_session",
    actorId: "anonymous",
    action,
    resourceType: "amazon_ads_connection",
    resourceId,
    requestId: auditRequest(request, response),
  };
}

function connectionId(value: unknown): string | null {
  return typeof value === "string" && /^con_[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
}

function field(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength ? value : null;
}

function failure(response: Response, error: unknown): void {
  if (error instanceof AdminAdsProxyError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
}

async function auditedFailure(
  audits: AdminAuditService,
  audit: AuditEvent,
  response: Response,
  error: unknown,
): Promise<void> {
  const denied = error instanceof AdminAdsProxyError && [400, 404, 409].includes(error.status);
  const code = error instanceof AdminAdsProxyError ? error.code : "internal_error";
  await audits.record(audit, denied ? "denied" : "failed", code).catch(() => undefined);
  failure(response, error);
}

export function registerAdminAdsRoutes(
  app: Express,
  sessions: AdminSessionManager,
  agents: AdminAgentService,
  audits: AdminAuditService,
  ads: AdminAdsService,
): void {
  const authorize = async (
    request: Request,
    response: Response,
    audit: AuditEvent,
    csrf: boolean,
  ) => authorizeAdminControl(request, response, sessions, agents, audits, audit, csrf);

  app.get("/api/v1/admin/providers/amazon-ads/accounts", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "amazon_ads.accounts.list", "all");
    try {
      if (!await authorize(request, response, audit, false)) return;
      const result = await ads.listAccounts();
      await audits.record(audit, "success");
      response.json(result);
    } catch (error) { await auditedFailure(audits, audit, response, error); }
  });

  app.get("/api/v1/admin/providers/amazon-ads/accounts/:accountId", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const accountId = field(request.params.accountId, 80);
    const audit = event(request, response, "amazon_ads.accounts.detail", accountId ?? "invalid");
    try {
      if (!await authorize(request, response, audit, false)) return;
      if (!accountId) throw new AdminAdsProxyError(400, "invalid_request", "Invalid account ID");
      const result = await ads.getAccount(accountId);
      await audits.record(audit, "success");
      response.json(result);
    } catch (error) { await auditedFailure(audits, audit, response, error); }
  });

  app.get("/api/v1/admin/providers/amazon-ads/employees", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "amazon_ads.employees.list", "all");
    try {
      if (!await authorize(request, response, audit, false)) return;
      const result = await ads.listEmployees();
      await audits.record(audit, "success");
      response.json(result);
    } catch (error) { await auditedFailure(audits, audit, response, error); }
  });

  app.post("/api/v1/admin/providers/amazon-ads/account-bindings", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = request.body as Record<string, unknown> | undefined;
    const id = body && connectionId(body.connection_id);
    const issuer = body && field(body.issuer, 512);
    const employeeId = body && field(body.employee_id, 512);
    const audit = event(request, response, "amazon_ads.binding.share", id ?? "invalid");
    try {
      if (!await authorize(request, response, audit, true)) return;
      if (
        !body || Array.isArray(body) ||
        Object.keys(body).some((key) => !["connection_id", "issuer", "employee_id"].includes(key)) ||
        !id || !issuer || !employeeId
      ) throw new AdminAdsProxyError(400, "invalid_request", "Invalid request");
      await ads.shareBinding(id, issuer, employeeId);
      await audits.record(audit, "success");
      response.status(201).json({ shared: true });
    } catch (error) { await auditedFailure(audits, audit, response, error); }
  });

  app.delete(
    "/api/v1/admin/providers/amazon-ads/account-bindings/:connectionId",
    async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const id = connectionId(request.params.connectionId);
      const issuer = field(request.query.issuer, 512);
      const employeeId = field(request.query.employee_id, 512);
      const audit = event(request, response, "amazon_ads.binding.unshare", id ?? "invalid");
      try {
        if (!await authorize(request, response, audit, true)) return;
        if (
          !id || !issuer || !employeeId ||
          Object.keys(request.query).some((key) => !["issuer", "employee_id"].includes(key))
        ) throw new AdminAdsProxyError(400, "invalid_request", "Invalid request");
        await ads.unshareBinding(id, issuer, employeeId);
        await audits.record(audit, "success");
        response.status(204).end();
      } catch (error) { await auditedFailure(audits, audit, response, error); }
    },
  );

  app.delete("/api/v1/admin/providers/amazon-ads/connections/:connectionId", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const id = connectionId(request.params.connectionId);
    const audit = event(request, response, "amazon_ads.connection.disconnect", id ?? "invalid");
    try {
      if (!await authorize(request, response, audit, true)) return;
      if (!id) throw new AdminAdsProxyError(400, "invalid_request", "Invalid connection ID");
      await ads.disconnect(id);
      await audits.record(audit, "success");
      response.status(204).end();
    } catch (error) { await auditedFailure(audits, audit, response, error); }
  });
}
