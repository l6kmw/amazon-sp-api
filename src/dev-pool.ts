import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hashAdminPassword } from "./admin-auth.js";

interface TableRow {
  [key: string]: unknown;
}

export async function createDevMemoryPool(): Promise<Pool> {
  const adminPasswordHash = await hashAdminPassword("admin");

  const tables: Record<string, TableRow[]> = {
    "amazon_sp_api.schema_migration": [
      { version: 1, name: "baseline", applied_at: new Date() },
      { version: 2, name: "expand_control_plane_and_account_lifecycle", applied_at: new Date() },
      { version: 3, name: "allow_independent_seller_credentials", applied_at: new Date() },
    ],
    "amazon_sp_api.app_user": [
      {
        id: "tenant-1",
        username: "admin",
        password_hash: adminPasswordHash,
        role: "admin",
        status: "active",
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
    "amazon_sp_api.app_agent": [
      {
        id: "agent_demo_01",
        user_id: "tenant-1",
        agent_id: "agent-order-bot",
        name: "订单自动化 Agent",
        purpose: "自动同步与检查订单状态",
        status: "active",
        api_token_hash: createHash("sha256").update("oat_demo_token_12345").digest("hex"),
        api_token_hint: "oat_demo…2345",
        api_token_created_at: new Date(),
        last_used_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
    "amazon_sp_api.audit_log": [
      {
        id: "audit_01",
        timestamp: new Date().toISOString(),
        actor_type: "browser_session",
        actor_id: "admin",
        action: "session.login",
        resource_type: "app_user",
        resource_id: "tenant-1",
        result: "success",
        error_code: null,
        request_id: "req_demo_01",
        detail: {},
        created_at: new Date(),
      },
    ],
    "amazon_sp_api.amazon_account": [
      {
        account_id: "acct_us_main",
        external_account_id: "A3RESTfulSellerUS",
        display_name: "Amazon US 主店铺",
        status: "active",
        created_at: new Date(Date.now() - 30 * 86400000),
        updated_at: new Date(),
      },
      {
        account_id: "acct_eu_flagship",
        external_account_id: "A1EURegionalSeller",
        display_name: "Amazon EU 旗舰店",
        status: "active",
        created_at: new Date(Date.now() - 15 * 86400000),
        updated_at: new Date(),
      },
      {
        account_id: "acct_jp_store",
        external_account_id: "A2FEAsiaStore",
        display_name: "Amazon JP 专营店",
        status: "active",
        created_at: new Date(Date.now() - 5 * 86400000),
        updated_at: new Date(),
      },
    ],
    "amazon_sp_api.amazon_credential": [
      {
        credential_id: "cred_us_01",
        account_id: "acct_us_main",
        region: "NA",
        status: "active",
        key_id: "k0",
        revision: 1,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        credential_id: "cred_eu_01",
        account_id: "acct_eu_flagship",
        region: "EU",
        status: "active",
        key_id: "k0",
        revision: 1,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        credential_id: "cred_jp_01",
        account_id: "acct_jp_store",
        region: "FE",
        status: "active",
        key_id: "k0",
        revision: 1,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
    "amazon_sp_api.connection_grant": [
      {
        connection_id: "con_us_main_01",
        issuer: "https://example.com/issuers/example",
        account_id: "acct_us_main",
        credential_id: "cred_us_01",
        status: "active",
        created_at: new Date(),
      },
      {
        connection_id: "con_eu_flagship_01",
        issuer: "https://example.com/issuers/example",
        account_id: "acct_eu_flagship",
        credential_id: "cred_eu_01",
        status: "active",
        created_at: new Date(),
      },
      {
        connection_id: "con_jp_store_01",
        issuer: "https://example.com/issuers/example",
        account_id: "acct_jp_store",
        credential_id: "cred_jp_01",
        status: "active",
        created_at: new Date(),
      },
    ],
    "amazon_sp_api.employee_registry": [
      {
        issuer: "https://example.com/issuers/example",
        employee_id: "emp_zhang_san",
        workspace_id: "tenant-1",
        first_seen_at: new Date(Date.now() - 30 * 86400000),
        last_seen_at: new Date(),
      },
      {
        issuer: "https://example.com/issuers/example",
        employee_id: "emp_li_si",
        workspace_id: "tenant-1",
        first_seen_at: new Date(Date.now() - 10 * 86400000),
        last_seen_at: new Date(),
      },
    ],
    "amazon_sp_api.employee_account_binding": [
      {
        issuer: "https://example.com/issuers/example",
        employee_id: "emp_zhang_san",
        connection_id: "con_us_main_01",
        account_id: "acct_us_main",
        remark: "US 主店负责人",
        status: "active",
        bound_at: new Date(),
        unbound_at: null,
      },
      {
        issuer: "https://example.com/issuers/example",
        employee_id: "emp_li_si",
        connection_id: "con_eu_flagship_01",
        account_id: "acct_eu_flagship",
        remark: "欧洲站代表",
        status: "active",
        bound_at: new Date(),
        unbound_at: null,
      },
    ],
    "amazon_sp_api.authorization_attempt": [],
  };

  const clientMock: PoolClient = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.trim().toLowerCase();

      if (s.startsWith("begin") || s.startsWith("commit") || s.startsWith("rollback") || s.includes("pg_advisory_xact_lock")) {
        return { rows: [], command: "OK", rowCount: 0, oid: 0, fields: [] };
      }

      // SELECT COUNT(*) from tables
      if (s.includes("as total_accounts")) {
        return {
          rows: [{
            total_accounts: String(tables["amazon_sp_api.amazon_account"]!.length),
            active_accounts: String(tables["amazon_sp_api.amazon_account"]!.filter((a) => a.status === "active").length),
            active_bindings: String(tables["amazon_sp_api.employee_account_binding"]!.filter((b) => b.status === "active").length),
            active_test_agents: String(tables["amazon_sp_api.app_agent"]!.filter((a) => a.status === "active").length),
            recent_errors: String(tables["amazon_sp_api.audit_log"]!.filter((l) => l.result === "failed").length),
            status_active: String(tables["amazon_sp_api.amazon_credential"]!.filter((c) => c.status === "active").length),
            status_pending: String(tables["amazon_sp_api.amazon_credential"]!.filter((c) => c.status === "pending").length),
            status_error: String(tables["amazon_sp_api.amazon_credential"]!.filter((c) => c.status !== "active" && c.status !== "pending").length),
            status_disconnected: String(tables["amazon_sp_api.connection_grant"]!.filter((g) => g.status === "disconnected").length),
          }],
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
        };
      }

      if (s.includes("select count(*)")) {
        let count = 0;
        if (s.includes("amazon_account")) count = tables["amazon_sp_api.amazon_account"]!.length;
        else if (s.includes("app_agent")) count = tables["amazon_sp_api.app_agent"]!.length;
        else if (s.includes("employee_account_binding")) count = tables["amazon_sp_api.employee_account_binding"]!.filter((b) => b.status === "active").length;
        else if (s.includes("employee_registry")) count = tables["amazon_sp_api.employee_registry"]!.length;
        else if (s.includes("audit_log")) count = tables["amazon_sp_api.audit_log"]!.length;
        return { rows: [{ count: String(count), total: String(count) }], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
      }

      // SELECT app_user
      if (s.includes("from amazon_sp_api.app_user")) {
        const rows = tables["amazon_sp_api.app_user"]!;
        if (params.length > 0 && typeof params[0] === "string") {
          return { rows: rows.filter((r) => r.id === params[0] || r.username === params[0]), command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
        }
        return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
      }

      // SELECT app_agent
      if (s.includes("from amazon_sp_api.app_agent")) {
        const rows = tables["amazon_sp_api.app_agent"]!;
        if (s.includes("api_token_hash = $1")) {
          const matched = rows.filter((r) => r.api_token_hash === params[0]);
          return { rows: matched, command: "SELECT", rowCount: matched.length, oid: 0, fields: [] };
        }
        return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
      }

      // INSERT INTO app_agent
      if (s.includes("insert into amazon_sp_api.app_agent")) {
        const newAgent: TableRow = {
          id: params[0] as string,
          user_id: "tenant-1",
          agent_id: params[1] as string,
          name: params[2] as string,
          purpose: params[3] as string,
          status: "active",
          api_token_hash: params[4] as string,
          api_token_hint: params[5] as string,
          api_token_created_at: new Date(),
          last_used_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        tables["amazon_sp_api.app_agent"]!.unshift(newAgent);
        return { rows: [newAgent], command: "INSERT", rowCount: 1, oid: 0, fields: [] };
      }

      // UPDATE app_agent
      if (s.includes("update amazon_sp_api.app_agent")) {
        const agentId = params[0] as string;
        const row = tables["amazon_sp_api.app_agent"]!.find((r) => r.id === agentId);
        if (row) {
          if (s.includes("status =")) row.status = params[3] ?? row.status;
          if (s.includes("api_token_hash = null")) {
            row.api_token_hash = null;
            row.api_token_hint = "";
          } else if (s.includes("api_token_hash = $2")) {
            row.api_token_hash = params[1];
            row.api_token_hint = params[2];
          }
          return { rows: [row], command: "UPDATE", rowCount: 1, oid: 0, fields: [] };
        }
        return { rows: [], command: "UPDATE", rowCount: 0, oid: 0, fields: [] };
      }

      // SELECT audit_log
      if (s.includes("from amazon_sp_api.audit_log")) {
        const rows = tables["amazon_sp_api.audit_log"]!;
        return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
      }

      // INSERT INTO audit_log
      if (s.includes("insert into amazon_sp_api.audit_log")) {
        const newLog: TableRow = {
          id: `audit_${randomBytes(8).toString("hex")}`,
          timestamp: new Date().toISOString(),
          actor_type: params[0] ?? "browser_session",
          actor_id: params[1] ?? "admin",
          action: params[3] ?? "action",
          resource_type: params[4] ?? "resource",
          resource_id: params[5] ?? "id",
          result: params[6] ?? "success",
          error_code: params[7] ?? null,
          request_id: params[8] ?? "req_1",
          detail: {},
          created_at: new Date(),
        };
        tables["amazon_sp_api.audit_log"]!.unshift(newLog);
        return { rows: [newLog], command: "INSERT", rowCount: 1, oid: 0, fields: [] };
      }

      // SELECT amazon_account
      if (s.includes("from amazon_sp_api.amazon_account")) {
        const accounts = tables["amazon_sp_api.amazon_account"]!;
        const creds = tables["amazon_sp_api.amazon_credential"]!;
        const bindings = tables["amazon_sp_api.employee_account_binding"]!;

        if (s.includes("where acct.account_id = $1")) {
          const acct = accounts.find((a) => a.account_id === params[0]);
          if (!acct) return { rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] };
          const cred = creds.find((c) => c.account_id === acct.account_id);
          const activeBindings = bindings.filter((b) => b.account_id === acct.account_id && b.status === "active").length;
          return {
            rows: [{
              account_id: acct.account_id,
              display_name: acct.display_name,
              selling_partner_id: acct.external_account_id,
              region: cred?.region ?? "NA",
              status: acct.status,
              credential_status: cred?.status ?? "pending",
              credential_revision: cred?.revision ?? 1,
              last_refreshed_at: cred?.updated_at ?? new Date(),
              key_id: cred?.key_id ?? "k0",
              active_bindings_count: String(activeBindings),
              created_at: acct.created_at,
            }],
            command: "SELECT",
            rowCount: 1,
            oid: 0,
            fields: [],
          };
        }

        const rows = accounts.map((acct) => {
          const cred = creds.find((c) => c.account_id === acct.account_id);
          const activeBindings = bindings.filter((b) => b.account_id === acct.account_id && b.status === "active").length;
          return {
            account_id: acct.account_id,
            display_name: acct.display_name,
            selling_partner_id: acct.external_account_id,
            region: cred?.region ?? "NA",
            status: acct.status,
            credential_status: cred?.status ?? "pending",
            credential_revision: cred?.revision ?? 1,
            last_refreshed_at: cred?.updated_at ?? new Date(),
            active_bindings_count: String(activeBindings),
            created_at: acct.created_at,
          };
        });
        return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
      }

      // SELECT employee_registry
      if (s.includes("from amazon_sp_api.employee_registry")) {
        const employees = tables["amazon_sp_api.employee_registry"]!;
        const bindings = tables["amazon_sp_api.employee_account_binding"]!;
        const rows = employees.map((e) => {
          const activeCnt = bindings.filter((b) => b.employee_id === e.employee_id && b.status === "active").length;
          const totalCnt = bindings.filter((b) => b.employee_id === e.employee_id).length;
          return {
            employee_id: e.employee_id,
            issuer: e.issuer,
            first_seen_at: e.first_seen_at,
            last_seen_at: e.last_seen_at,
            active_bindings_count: String(activeCnt),
            total_bindings_count: String(totalCnt),
          };
        });
        return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
      }

      // SELECT employee_account_binding
      if (s.includes("from amazon_sp_api.employee_account_binding")) {
        const bindings = tables["amazon_sp_api.employee_account_binding"]!;
        const accounts = tables["amazon_sp_api.amazon_account"]!;
        if (params.length >= 2) {
          const matched = bindings.filter((b) => b.issuer === params[0] && b.employee_id === params[1]);
          const rows = matched.map((b) => {
            const acct = accounts.find((a) => a.account_id === b.account_id);
            return {
              connection_id: b.connection_id,
              account_id: b.account_id,
              display_name: acct?.display_name ?? "",
              selling_partner_id: acct?.external_account_id ?? "",
              remark: b.remark,
              bound_at: b.bound_at,
              unbound_at: b.unbound_at,
              status: b.status,
            };
          });
          return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
        }
        return { rows: bindings, command: "SELECT", rowCount: bindings.length, oid: 0, fields: [] };
      }

      // Default fallback
      return { rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] };
    },
    release() {},
  } as unknown as PoolClient;

  return {
    async query(sql: string, params: unknown[] = []) {
      return clientMock.query(sql, params);
    },
    async connect() {
      return clientMock;
    },
    async end() {},
  } as unknown as Pool;
}
