import { createHash, randomBytes } from "node:crypto";

import type { Express, Request, Response } from "express";
import type { Pool, PoolClient } from "pg";

import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import type { AdminSessionClaims, AdminSessionManager } from "./admin-session.js";
import type { TestAgentPrincipal } from "./identity.js";

interface AgentRow {
  id: string;
  agent_id: string;
  name: string;
  purpose: string;
  status: "active" | "disabled";
  api_token_hint: string;
  api_token_created_at: Date | string | null;
  last_used_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface AdminAgent {
  id: string;
  agent_id: string;
  name: string;
  purpose: string;
  status: "active" | "disabled";
  api_token_configured: boolean;
  api_token_hint: string;
  api_token_created_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function agent(row: AgentRow): AdminAgent {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    api_token_configured: row.api_token_created_at !== null,
    api_token_hint: row.api_token_hint,
    api_token_created_at: iso(row.api_token_created_at),
    last_used_at: iso(row.last_used_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

function token(): { plaintext: string; hash: string; hint: string } {
  const plaintext = `oat_${randomBytes(32).toString("base64url")}`;
  return {
    plaintext,
    hash: createHash("sha256").update(plaintext).digest("hex"),
    hint: `${plaintext.slice(0, 10)}…${plaintext.slice(-4)}`,
  };
}

export class AdminAgentService {
  constructor(readonly pool: Pool) {}

  async authenticateToken(plaintext: string): Promise<TestAgentPrincipal | null> {
    if (!/^oat_[A-Za-z0-9_-]{43}$/.test(plaintext)) return null;
    const result = await this.pool.query<{ id: string; agent_id: string }>(`
      UPDATE amazon_sp_api.app_agent
      SET last_used_at = NOW()
      WHERE user_id = 'tenant-1' AND status = 'active'
        AND api_token_hash = $1
      RETURNING id, agent_id
    `, [createHash("sha256").update(plaintext).digest("hex")]);
    const row = result.rows[0];
    return row ? {
      authType: "test_agent",
      credentialKind: "test_agent_token",
      tenantId: "tenant-1",
      agentRecordId: row.id,
      agentId: row.agent_id,
      scopes: new Set([
        "config:check",
        "mcp:catalog",
        "mcp:invoke",
        "connected_accounts:manage",
      ]),
    } : null;
  }

  async list(): Promise<AdminAgent[]> {
    const result = await this.pool.query<AgentRow>(`
      SELECT id, agent_id, name, purpose, status, api_token_hint,
             api_token_created_at, last_used_at, created_at, updated_at
      FROM amazon_sp_api.app_agent
      WHERE user_id = 'tenant-1'
      ORDER BY created_at DESC, id DESC
    `);
    return result.rows.map(agent);
  }

  async create(input: { agentId: string; name: string; purpose: string }, client?: PoolClient): Promise<{
    agent: AdminAgent;
    apiToken: string;
  }> {
    const credential = token();
    const result = await (client ?? this.pool).query<AgentRow>(`
      INSERT INTO amazon_sp_api.app_agent
        (id, user_id, agent_id, name, purpose, status,
         api_token_hash, api_token_hint, api_token_created_at)
      VALUES ($1, 'tenant-1', $2, $3, $4, 'active', $5, $6, NOW())
      RETURNING id, agent_id, name, purpose, status, api_token_hint,
                api_token_created_at, last_used_at, created_at, updated_at
    `, [
      `agent_${randomBytes(18).toString("base64url")}`,
      input.agentId,
      input.name,
      input.purpose,
      credential.hash,
      credential.hint,
    ]);
    return { agent: agent(result.rows[0]!), apiToken: credential.plaintext };
  }

  async update(id: string, input: {
    name?: string;
    purpose?: string;
    status?: "active" | "disabled";
  }, client?: PoolClient): Promise<AdminAgent | null> {
    const result = await (client ?? this.pool).query<AgentRow>(`
      UPDATE amazon_sp_api.app_agent
      SET name = COALESCE($2, name),
          purpose = COALESCE($3, purpose),
          status = COALESCE($4, status),
          updated_at = NOW()
      WHERE id = $1 AND user_id = 'tenant-1'
      RETURNING id, agent_id, name, purpose, status, api_token_hint,
                api_token_created_at, last_used_at, created_at, updated_at
    `, [id, input.name ?? null, input.purpose ?? null, input.status ?? null]);
    return result.rows[0] ? agent(result.rows[0]) : null;
  }

  async rotateToken(id: string, client?: PoolClient): Promise<{ agent: AdminAgent; apiToken: string } | null> {
    const credential = token();
    const result = await (client ?? this.pool).query<AgentRow>(`
      UPDATE amazon_sp_api.app_agent
      SET api_token_hash = $2, api_token_hint = $3,
          api_token_created_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = 'tenant-1'
      RETURNING id, agent_id, name, purpose, status, api_token_hint,
                api_token_created_at, last_used_at, created_at, updated_at
    `, [id, credential.hash, credential.hint]);
    return result.rows[0]
      ? { agent: agent(result.rows[0]), apiToken: credential.plaintext }
      : null;
  }

  async revokeToken(id: string, client?: PoolClient): Promise<AdminAgent | null> {
    const result = await (client ?? this.pool).query<AgentRow>(`
      UPDATE amazon_sp_api.app_agent
      SET api_token_hash = NULL, api_token_hint = '',
          api_token_created_at = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = 'tenant-1'
      RETURNING id, agent_id, name, purpose, status, api_token_hint,
                api_token_created_at, last_used_at, created_at, updated_at
    `, [id]);
    return result.rows[0] ? agent(result.rows[0]) : null;
  }
}

function body(request: Request): Record<string, unknown> | null {
  return typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : null;
}

function stringField(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.trim().length >= min && value.length <= max
    ? value.trim()
    : null;
}

export async function authorizeAdminControl(
  request: Request,
  response: Response,
  sessions: AdminSessionManager,
  agents: AdminAgentService,
  audits: AdminAuditService,
  event: AuditEvent,
  csrf: boolean,
): Promise<AdminSessionClaims | TestAgentPrincipal | null> {
  const claims = await sessions.session(request);
  if (claims) {
    event.actorId = claims.username;
    if (csrf && !sessions.validCsrf(request, claims)) {
      await audits.record(event, "denied", "csrf_invalid");
      response.status(403).json({ error: { code: "csrf_invalid", message: "Invalid CSRF token" } });
      return null;
    }
    return claims;
  }
  const authorization = request.header("authorization") ?? "";
  const principal = authorization.startsWith("Bearer ")
    ? await agents.authenticateToken(authorization.slice(7))
    : null;
  if (!principal || !principal.scopes.has("connected_accounts:manage")) {
    await audits.record(event, "denied", "unauthorized");
    response.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
    return null;
  }
  event.actorType = "agent_token";
  event.actorId = principal.agentId;
  event.agentRecordId = principal.agentRecordId;
  return principal;
}

class AgentRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function failure(response: Response, error: unknown): void {
  if (error instanceof AgentRouteError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if ((error as { code?: string }).code === "23505") {
    response.status(409).json({ error: { code: "conflict", message: "Agent already exists" } });
    return;
  }
  response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
}

function event(request: Request, response: Response, action: string, resourceId: string): AuditEvent {
  return {
    actorType: "browser_session",
    actorId: "anonymous",
    action,
    resourceType: "test_agent",
    resourceId,
    requestId: auditRequest(request, response),
  };
}

export function registerAdminAgentRoutes(
  app: Express,
  sessions: AdminSessionManager,
  agents: AdminAgentService,
  audits: AdminAuditService,
): void {
  const classify = (error: unknown) => error instanceof AgentRouteError
    ? { result: "denied" as const, errorCode: error.code }
    : (error as { code?: string }).code === "23505"
      ? { result: "denied" as const, errorCode: "conflict" }
      : { result: "failed" as const, errorCode: "internal_error" };
  const deny = async (audit: AuditEvent, response: Response, code = "invalid_request") => {
    await audits.record(audit, "denied", code);
    response.status(400).json({ error: { code, message: "Invalid request" } });
  };

  app.get("/api/v1/admin/agents", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "agent.list", "all");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;
      response.json({ items: await agents.list() });
    } catch (error) { failure(response, error); }
  });

  app.post("/api/v1/admin/agents", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "agent.create", "new");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      const value = body(request);
      if (!value || Object.keys(value).some((key) => !["agent_id", "name", "purpose"].includes(key))) {
        await deny(audit, response); return;
      }
      const agentId = stringField(value.agent_id, 1, 128);
      const name = stringField(value.name, 1, 64);
      const purpose = value.purpose === undefined ? "" : stringField(value.purpose, 0, 200);
      if (!agentId || !name || purpose === null) { await deny(audit, response); return; }
      audit.resourceId = agentId;
      const created = await audits.run(audit, (client) => agents.create({ agentId, name, purpose }, client), classify);
      response.status(201).json({ agent: created.agent, api_token: created.apiToken });
    } catch (error) { failure(response, error); }
  });

  app.patch("/api/v1/admin/agents/:id", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "agent.update", request.params.id);
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      const value = body(request);
      if (!value || Object.keys(value).length === 0
        || Object.keys(value).some((key) => !["name", "purpose", "status"].includes(key))) {
        await deny(audit, response); return;
      }
      const name = value.name === undefined ? undefined : stringField(value.name, 1, 64);
      const purpose = value.purpose === undefined ? undefined : stringField(value.purpose, 0, 200);
      const status = value.status === undefined ? undefined
        : value.status === "active" || value.status === "disabled" ? value.status : null;
      if (name === null || purpose === null || status === null) { await deny(audit, response); return; }
      const updated = await audits.run(audit, async (client) => {
        const value = await agents.update(request.params.id, { name, purpose, status }, client);
        if (!value) throw new AgentRouteError(404, "not_found", "Agent not found");
        return value;
      }, classify);
      response.json(updated);
    } catch (error) { failure(response, error); }
  });

  app.post("/api/v1/admin/agents/:id/api-token", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "agent.token.rotate", request.params.id);
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      const rotated = await audits.run(audit, async (client) => {
        const value = await agents.rotateToken(request.params.id, client);
        if (!value) throw new AgentRouteError(404, "not_found", "Agent not found");
        return value;
      }, classify);
      response.json({ agent: rotated.agent, api_token: rotated.apiToken });
    } catch (error) { failure(response, error); }
  });

  app.delete("/api/v1/admin/agents/:id/api-token", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "agent.token.revoke", request.params.id);
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      const revoked = await audits.run(audit, async (client) => {
        const value = await agents.revokeToken(request.params.id, client);
        if (!value) throw new AgentRouteError(404, "not_found", "Agent not found");
        return value;
      }, classify);
      response.json(revoked);
    } catch (error) { failure(response, error); }
  });
}
