import type { Express, Request, Response } from "express";
import type { Pool } from "pg";

import { authorizeAdminControl, type AdminAgentService } from "./admin-agents.js";
import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import type { AdminSessionManager } from "./admin-session.js";

/* ------------------------------------------------------------------ */
/*  Row types                                                          */
/* ------------------------------------------------------------------ */

interface AccountListRow {
  account_id: string;
  display_name: string;
  selling_partner_id: string;
  region: string;
  marketplace_ids: string[];
  status: string;
  credential_status: string;
  credential_revision: number;
  last_refreshed_at: Date | string | null;
  active_bindings_count: string;
  created_at: Date | string;
}

interface AccountDetailRow extends AccountListRow {
  key_id: string;
}

interface BindingRow {
  connection_id: string;
  employee_id: string;
  issuer: string;
  remark: string | null;
  bound_at: Date | string;
  unbound_at: Date | string | null;
  status: string;
}

interface EmployeeSummaryRow {
  employee_id: string;
  issuer: string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  active_bindings_count: string;
  total_bindings_count: string;
}

interface EmployeeBindingRow {
  connection_id: string;
  account_id: string;
  display_name: string;
  selling_partner_id: string;
  remark: string | null;
  bound_at: Date | string;
  status: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function maskSellerId(sellerId: string): string {
  if (sellerId.length <= 6) return "***";
  return `${sellerId.slice(0, 3)}${"*".repeat(sellerId.length - 6)}${sellerId.slice(-3)}`;
}

function event(request: Request, response: Response, action: string, resourceId: string): AuditEvent {
  return {
    actorType: "browser_session",
    actorId: "anonymous",
    action,
    resourceType: "admin_accounts",
    resourceId,
    requestId: auditRequest(request, response),
  };
}

/* ------------------------------------------------------------------ */
/*  Route registration                                                 */
/* ------------------------------------------------------------------ */

export function registerAdminAccountRoutes(
  app: Express,
  sessions: AdminSessionManager,
  agents: AdminAgentService,
  audits: AdminAuditService,
  pool: Pool,
): void {

  // GET /api/v1/admin/accounts — paginated account list
  app.get("/api/v1/admin/accounts", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "accounts.list", "all");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      const status = typeof request.query.status === "string" ? request.query.status : undefined;
      const query = typeof request.query.query === "string" ? request.query.query : undefined;
      const page = Math.max(1, Number(request.query.page) || 1);
      const limit = 20;
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (status && status !== "all") {
        conditions.push(`COALESCE(cred.status, 'pending') = $${paramIndex++}`);
        params.push(status);
      }
      if (query) {
        conditions.push(`(acct.display_name ILIKE $${paramIndex} OR acct.selling_partner_id ILIKE $${paramIndex})`);
        params.push(`%${query}%`);
        paramIndex++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countResult = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM amazon_sp_api.amazon_account acct
        LEFT JOIN amazon_sp_api.amazon_credential cred
          ON cred.credential_id = (
            SELECT g.credential_id FROM amazon_sp_api.connection_grant g
            WHERE g.account_id = acct.account_id AND g.credential_id IS NOT NULL
            ORDER BY (g.status = 'active') DESC, g.updated_at DESC, g.connection_id
            LIMIT 1
          )
        ${where}
      `, params);

      const total = Number(countResult.rows[0]?.count ?? 0);
      const totalPages = Math.max(1, Math.ceil(total / limit));

      const result = await pool.query<AccountListRow>(`
        SELECT
          acct.account_id,
          acct.display_name,
          acct.selling_partner_id,
          COALESCE(acct.region, 'NA') AS region,
          acct.marketplace_ids,
          acct.status,
          COALESCE(cred.status, 'pending') AS credential_status,
          COALESCE(cred.refresh_token_revision, 0)::int AS credential_revision,
          cred.last_refresh_at AS last_refreshed_at,
          COALESCE(bindings.cnt, 0)::text AS active_bindings_count,
          acct.created_at
        FROM amazon_sp_api.amazon_account acct
        LEFT JOIN amazon_sp_api.amazon_credential cred
          ON cred.credential_id = (
            SELECT g.credential_id FROM amazon_sp_api.connection_grant g
            WHERE g.account_id = acct.account_id AND g.credential_id IS NOT NULL
            ORDER BY (g.status = 'active') DESC, g.updated_at DESC, g.connection_id
            LIMIT 1
          )
        LEFT JOIN (
          SELECT b.account_id, COUNT(*)::int AS cnt
          FROM amazon_sp_api.employee_account_binding b
          WHERE b.status = 'active'
          GROUP BY b.account_id
        ) bindings ON bindings.account_id = acct.account_id
        ${where}
        ORDER BY acct.created_at DESC, acct.account_id DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, limit, offset]);

      const items = result.rows.map((row) => ({
        account_id: row.account_id,
        display_name: row.display_name,
        selling_partner_id_masked: maskSellerId(row.selling_partner_id),
        region: row.region,
        marketplaces: row.marketplace_ids,
        status: row.status as "active" | "pending",
        credential_status: row.credential_status,
        credential_revision: row.credential_revision,
        active_bindings_count: Number(row.active_bindings_count),
        last_synced_at: iso(row.last_refreshed_at),
      }));

      await audits.record(audit, "success");
      response.json({ items, total, page, total_pages: totalPages });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  // GET /api/v1/admin/accounts/:id — account detail with bindings
  app.get("/api/v1/admin/accounts/:id", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const accountId = request.params.id;
    const audit = event(request, response, "accounts.detail", accountId);
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      const acctResult = await pool.query<AccountDetailRow>(`
        SELECT
          acct.account_id,
          acct.display_name,
          acct.selling_partner_id,
          COALESCE(acct.region, 'NA') AS region,
          acct.marketplace_ids,
          acct.status,
          COALESCE(cred.status, 'pending') AS credential_status,
          COALESCE(cred.refresh_token_revision, 0)::int AS credential_revision,
          cred.last_refresh_at AS last_refreshed_at,
          COALESCE(cred.encrypted_refresh_token->>'key_id', '') AS key_id,
          COALESCE(bindings.cnt, 0)::text AS active_bindings_count,
          acct.created_at
        FROM amazon_sp_api.amazon_account acct
        LEFT JOIN amazon_sp_api.amazon_credential cred
          ON cred.credential_id = (
            SELECT g.credential_id FROM amazon_sp_api.connection_grant g
            WHERE g.account_id = acct.account_id AND g.credential_id IS NOT NULL
            ORDER BY (g.status = 'active') DESC, g.updated_at DESC, g.connection_id
            LIMIT 1
          )
        LEFT JOIN (
          SELECT b.account_id, COUNT(*)::int AS cnt
          FROM amazon_sp_api.employee_account_binding b
          WHERE b.status = 'active'
          GROUP BY b.account_id
        ) bindings ON bindings.account_id = acct.account_id
        WHERE acct.account_id = $1
      `, [accountId]);

      const row = acctResult.rows[0];
      if (!row) {
        await audits.record(audit, "denied", "not_found");
        response.status(404).json({ error: { code: "not_found", message: "Account not found" } });
        return;
      }

      const bindingsResult = await pool.query<BindingRow>(`
        SELECT
          b.connection_id,
          b.employee_id,
          b.issuer,
          b.remark,
          b.bound_at,
          b.unbound_at,
          b.status
        FROM amazon_sp_api.employee_account_binding b
        WHERE b.account_id = $1
        ORDER BY b.bound_at DESC
      `, [accountId]);

      // Get last attempt info
      const attemptResult = await pool.query<{ status: string; error_code: string | null }>(`
        SELECT status, error_code
        FROM amazon_sp_api.authorization_attempt
        WHERE EXISTS (
          SELECT 1 FROM amazon_sp_api.connection_grant g
          WHERE g.account_id = $1 AND g.connection_id = amazon_sp_api.authorization_attempt.connection_id
        )
        ORDER BY created_at DESC
        LIMIT 1
      `, [accountId]);

      const attempt = attemptResult.rows[0];

      await audits.record(audit, "success");
      response.json({
        account_id: row.account_id,
        display_name: row.display_name,
        selling_partner_id_masked: maskSellerId(row.selling_partner_id),
        region: row.region,
        marketplaces: row.marketplace_ids,
        status: row.status,
        credential_status: row.credential_status,
        credential_revision: row.credential_revision,
        active_bindings_count: Number(row.active_bindings_count),
        last_synced_at: iso(row.last_refreshed_at),
        bindings: bindingsResult.rows.map((b) => ({
          connection_id: b.connection_id,
          employee_id: b.employee_id,
          issuer: b.issuer,
          remark: b.remark,
          bound_at: isoRequired(b.bound_at),
          unbound_at: iso(b.unbound_at),
          status: b.status,
        })),
        credential_info: {
          key_id: row.key_id,
          revision: row.credential_revision,
          last_refreshed_at: iso(row.last_refreshed_at),
        },
        last_attempt_status: attempt?.status ?? null,
        last_attempt_error: attempt?.error_code ?? null,
      });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  app.post("/api/v1/admin/accounts/:id/refresh", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const accountId = request.params.id;
    const audit = event(request, response, "accounts.refresh", accountId);
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, true)) return;
      if (
        request.body !== undefined
        && (
          typeof request.body !== "object"
          || request.body === null
          || Array.isArray(request.body)
          || Object.keys(request.body).length > 0
        )
      ) {
        await audits.record(audit, "denied", "invalid_request");
        response.status(400).json({ error: { code: "invalid_request", message: "Invalid request" } });
        return;
      }
      const exists = await pool.query(`
        SELECT 1 FROM amazon_sp_api.amazon_account WHERE account_id = $1
      `, [accountId]);
      if (!exists.rows[0]) {
        await audits.record(audit, "denied", "not_found");
        response.status(404).json({ error: { code: "not_found", message: "Account not found" } });
        return;
      }
      await audits.record(audit, "success");
      response.json({ refreshed: true });
    } catch {
      await audits.record(audit, "failed", "internal_error").catch(() => undefined);
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  // GET /api/v1/admin/connected-account-employees — paginated employee list
  app.get("/api/v1/admin/connected-account-employees", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "employees.list", "all");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      const offset = Math.max(0, Number(request.query.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));

      const countResult = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM amazon_sp_api.employee_registry
      `);
      const total = Number(countResult.rows[0]?.count ?? 0);

      const result = await pool.query<EmployeeSummaryRow>(`
        SELECT
          e.employee_id,
          e.issuer,
          e.first_seen_at,
          e.last_seen_at,
          COALESCE(active.cnt, 0)::text AS active_bindings_count,
          COALESCE(total.cnt, 0)::text AS total_bindings_count
        FROM amazon_sp_api.employee_registry e
        LEFT JOIN (
          SELECT b.issuer, b.employee_id, COUNT(*)::int AS cnt
          FROM amazon_sp_api.employee_account_binding b
          WHERE b.status = 'active'
          GROUP BY b.issuer, b.employee_id
        ) active ON active.issuer = e.issuer AND active.employee_id = e.employee_id
        LEFT JOIN (
          SELECT b.issuer, b.employee_id, COUNT(*)::int AS cnt
          FROM amazon_sp_api.employee_account_binding b
          GROUP BY b.issuer, b.employee_id
        ) total ON total.issuer = e.issuer AND total.employee_id = e.employee_id
        ORDER BY e.last_seen_at DESC, e.employee_id
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const items = result.rows.map((row) => ({
        employee_id: row.employee_id,
        issuer: row.issuer,
        first_seen_at: isoRequired(row.first_seen_at),
        last_seen_at: isoRequired(row.last_seen_at),
        active_bindings_count: Number(row.active_bindings_count),
        total_bindings_count: Number(row.total_bindings_count),
      }));

      await audits.record(audit, "success");
      response.json({ items, total, offset, limit });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  // GET /api/v1/admin/connected-account-employees/:id/accounts — employee's bound accounts
  app.get("/api/v1/admin/connected-account-employees/:id/accounts", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const employeeId = request.params.id;
    const issuer = typeof request.query.issuer === "string" ? request.query.issuer : undefined;
    const audit = event(request, response, "employees.accounts", employeeId);
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      if (!issuer) {
        await audits.record(audit, "denied", "invalid_request");
        response.status(400).json({ error: { code: "invalid_request", message: "issuer query parameter is required" } });
        return;
      }

      const result = await pool.query<EmployeeBindingRow>(`
        SELECT
          b.connection_id,
          b.account_id,
          COALESCE(acct.display_name, '') AS display_name,
          COALESCE(acct.selling_partner_id, '') AS selling_partner_id,
          b.remark,
          b.bound_at,
          b.status
        FROM amazon_sp_api.employee_account_binding b
        LEFT JOIN amazon_sp_api.amazon_account acct ON acct.account_id = b.account_id
        WHERE b.issuer = $1 AND b.employee_id = $2
        ORDER BY b.bound_at DESC
      `, [issuer, employeeId]);

      const items = result.rows.map((row) => ({
        connection_id: row.connection_id,
        employee_id: employeeId,
        issuer,
        account_id: row.account_id,
        display_name: row.display_name,
        selling_partner_id: maskSellerId(row.selling_partner_id),
        remark: row.remark,
        bound_at: isoRequired(row.bound_at),
        status: row.status,
      }));

      await audits.record(audit, "success");
      response.json(items);
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}
