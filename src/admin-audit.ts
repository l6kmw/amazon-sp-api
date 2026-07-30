import { randomUUID } from "node:crypto";

import type { Express, Request, Response } from "express";
import type { Pool, PoolClient } from "pg";

import type { AdminAgentService } from "./admin-agents.js";
import type { AdminSessionManager } from "./admin-session.js";

export type AuditActorType = "browser_session" | "agent_token" | "employee_jwt" | "system";
export type AuditResult = "success" | "denied" | "failed";

export interface AuditEvent {
  actorType: AuditActorType;
  actorId: string;
  agentRecordId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId?: string | null;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string;
  agent_record_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  result: AuditResult;
  error_code: string | null;
  request_id: string | null;
  created_at: Date | string;
}

export interface AdminAuditLog {
  id: string;
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string;
  agent_record_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  result: AuditResult;
  error_code: string | null;
  request_id: string | null;
  created_at: string;
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

function auditLog(row: AuditRow): AdminAuditLog {
  return { ...row, created_at: new Date(row.created_at).toISOString() };
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

export function auditRequest(request: Request, response: Response): string {
  const requestId = safeRequestId(request.header("x-request-id"));
  response.setHeader("x-request-id", requestId);
  return requestId;
}

export class AdminAuditService {
  constructor(readonly pool: Pool) {}

  async record(
    event: AuditEvent,
    result: AuditResult,
    errorCode: string | null = null,
    queryable: Queryable = this.pool,
  ): Promise<void> {
    await queryable.query(`
      INSERT INTO amazon_sp_api.audit_log
        (tenant_id, actor_type, actor_id, agent_record_id, action,
         resource_type, resource_id, result, error_code, request_id)
      VALUES ('tenant-1', $1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      event.actorType,
      event.actorId.slice(0, 128),
      event.agentRecordId?.slice(0, 128) ?? null,
      event.action.slice(0, 128),
      event.resourceType.slice(0, 128),
      event.resourceId.slice(0, 128),
      result,
      errorCode?.slice(0, 128) ?? null,
      event.requestId?.slice(0, 128) ?? null,
    ]);
  }

  async run<T>(
    event: AuditEvent,
    operation: (client: PoolClient) => Promise<T>,
    classify: (error: unknown) => { result: Exclude<AuditResult, "success">; errorCode: string }
      = () => ({ result: "failed", errorCode: "internal_error" }),
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await this.record(event, "success", null, client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const failure = classify(error);
      await this.record(event, failure.result, failure.errorCode).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(input: {
    limit: number;
    beforeId?: string;
    actorType?: AuditActorType;
    action?: string;
    resourceType?: string;
    result?: AuditResult;
    requestId?: string;
    from?: string;
    to?: string;
  }): Promise<{ items: AdminAuditLog[]; nextCursor: string | null }> {
    const values: unknown[] = [];
    const where = ["tenant_id = 'tenant-1'"];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      where.push(`${sql} $${values.length}`);
    };
    if (input.beforeId) add("id <", input.beforeId);
    if (input.actorType) add("actor_type =", input.actorType);
    if (input.action) add("action =", input.action);
    if (input.resourceType) add("resource_type =", input.resourceType);
    if (input.result) add("result =", input.result);
    if (input.requestId) add("request_id =", input.requestId);
    if (input.from) add("created_at >=", input.from);
    if (input.to) add("created_at <=", input.to);
    values.push(input.limit + 1);
    const result = await this.pool.query<AuditRow>(`
      SELECT id::text, tenant_id, actor_type, actor_id, agent_record_id,
             action, resource_type, resource_id, result, error_code,
             request_id, created_at
      FROM amazon_sp_api.audit_log
      WHERE ${where.join(" AND ")}
      ORDER BY id DESC
      LIMIT $${values.length}
    `, values);
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    return {
      items: rows.map(auditLog),
      nextCursor: hasMore ? rows.at(-1)!.id : null,
    };
  }
}

function one(query: Request["query"], name: string): string | undefined {
  const value = query[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function registerAdminAuditRoutes(
  app: Express,
  sessions: AdminSessionManager,
  audits: AdminAuditService,
  agents?: AdminAgentService,
): void {
  app.get("/api/v1/admin/audit-logs", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    auditRequest(request, response);
    try {
      const claims = await sessions.session(request);
      const authorization = request.header("authorization") ?? "";
      const agent = !claims && agents && authorization.startsWith("Bearer ")
        ? await agents.authenticateToken(authorization.slice(7))
        : null;
      if (!claims && (!agent || !agent.scopes.has("connected_accounts:manage"))) {
        response.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
        return;
      }
      const allowedQuery = new Set([
        "limit", "cursor", "actor_type", "action", "resource_type", "result", "request_id", "from", "to",
      ]);
      const invalidQueryShape = Object.entries(request.query).some(([key, value]) =>
        !allowedQuery.has(key) || (value !== undefined && typeof value !== "string"),
      );
      const limitText = one(request.query, "limit");
      const limit = limitText === undefined ? 50 : Number(limitText);
      const beforeId = one(request.query, "cursor");
      const actorType = one(request.query, "actor_type");
      const result = one(request.query, "result");
      const action = one(request.query, "action");
      const resourceType = one(request.query, "resource_type");
      const requestId = one(request.query, "request_id");
      const from = one(request.query, "from");
      const to = one(request.query, "to");
      if (
        invalidQueryShape
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || (beforeId !== undefined && !/^[1-9][0-9]*$/.test(beforeId))
        || (actorType !== undefined && !["browser_session", "agent_token", "employee_jwt", "system"].includes(actorType))
        || (result !== undefined && !["success", "denied", "failed"].includes(result))
        || [action, resourceType, requestId].some((value) => value !== undefined && value.length > 128)
        || [from, to].some((value) => value !== undefined && Number.isNaN(Date.parse(value)))
      ) {
        response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
        return;
      }
      const page = await audits.list({
        limit,
        beforeId,
        actorType: actorType as AuditActorType | undefined,
        action,
        resourceType,
        result: result as AuditResult | undefined,
        requestId,
        from,
        to,
      });
      response.json({ items: page.items, next_cursor: page.nextCursor });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}
