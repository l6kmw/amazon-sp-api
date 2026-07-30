import type { Express, Request, Response } from "express";
import type { Pool } from "pg";

import { authorizeAdminControl, type AdminAgentService } from "./admin-agents.js";
import { auditRequest, type AdminAuditService, type AuditEvent } from "./admin-audit.js";
import type { AdminSessionManager } from "./admin-session.js";
import type { ReadinessResult } from "./http.js";
import { SP_API_DOMAINS, type SpApiDomain } from "./sp-api-operations.js";

/* ------------------------------------------------------------------ */
/*  Dashboard Stats                                                    */
/* ------------------------------------------------------------------ */

interface DashboardRow {
  total_accounts: string;
  active_accounts: string;
  active_bindings: string;
  active_test_agents: string;
  recent_errors: string;
  status_active: string;
  status_pending: string;
  status_error: string;
  status_disconnected: string;
}

/* ------------------------------------------------------------------ */
/*  Config Status                                                      */
/* ------------------------------------------------------------------ */

export interface AdminDashboardDeps {
  pool: Pool;
  lwaClientId: string;
  lwaClientSecret: string;
  applicationId: string;
  publicOrigin: string;
  readinessCheck?: () => Promise<ReadinessResult>;
  toolCount: number;
  mcpEndpoint: string;
  connected-accountKeyringConfigured: boolean;
}

/* ------------------------------------------------------------------ */
/*  Capabilities (derived from SP-API operation registry)              */
/* ------------------------------------------------------------------ */

interface CapabilityEntry {
  tool_name: string;
  title: string;
  description: string;
  domain: string;
  action: string;
  amazon_role: string;
  supported_regions: string[];
  availability: "available" | "permission_required";
  is_readonly: boolean;
}

const DOMAIN_LABELS: Record<SpApiDomain, string> = {
  seller: "Seller Identity",
  catalog: "Catalog Items",
  listings: "Listings",
  orders: "Orders",
  inventory: "FBA Inventory",
  pricing: "Pricing",
  analytics: "Analytics",
  finances: "Finances",
  warehousing: "Warehousing",
  fulfillment: "Fulfillment",
  shipping: "Shipping",
  services: "Services",
  content: "A+ Content",
  reports: "Reports",
  data_kiosk: "Data Kiosk",
  feeds: "Feeds",
  integrations: "Integrations",
};

function buildCapabilities(): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];

  // Core identity and lifecycle tools
  entries.push(
    {
      tool_name: "amazon_get_identity",
      title: "获取当前身份",
      description: "Returns authenticated MCP identity summary",
      domain: "seller",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_list_accounts",
      title: "列出 Seller 账号",
      description: "Lists connected Amazon seller accounts visible to authenticated identity",
      domain: "seller",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_get_read_capabilities",
      title: "查看只读能力目录",
      description: "Lists allowlisted frozen Amazon read capabilities and their status",
      domain: "seller",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_list_marketplaces",
      title: "发现市场",
      description: "Auto-discovers and lists participating Amazon marketplaces",
      domain: "seller",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_business_snapshot",
      title: "业务概览",
      description: "High-level operational health snapshot across participating marketplaces",
      domain: "seller",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_connection_health",
      title: "连接健康检查",
      description: "Diagnostic check for Seller API LWA token and connectivity",
      domain: "seller",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
  );

  // Domain-specific read tools
  for (const domain of SP_API_DOMAINS) {
    entries.push({
      tool_name: `amazon_${domain}_read`,
      title: `${DOMAIN_LABELS[domain]} 只读查询`,
      description: `Executes a frozen read-only ${DOMAIN_LABELS[domain]} SP-API operation`,
      domain,
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    });
  }

  // Specialized tools
  entries.push(
    {
      tool_name: "amazon_search_orders",
      title: "搜索订单",
      description: "Searches non-PII order records by date range",
      domain: "orders",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_get_order",
      title: "获取订单",
      description: "Gets order summary without buyer/recipient PII",
      domain: "orders",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_list_order_items",
      title: "列出订单项",
      description: "Returns non-PII item list for a specific order",
      domain: "orders",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_list_inventory_summaries",
      title: "库存汇总",
      description: "Lists FBA inventory summaries",
      domain: "inventory",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_search_listings",
      title: "搜索 Listings",
      description: "Searches read-only Listing summaries (status, issues, fulfillment)",
      domain: "listings",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_get_listing_item",
      title: "获取 Listing 详情",
      description: "Gets detailed listing item by seller SKU and marketplace",
      domain: "listings",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
    {
      tool_name: "amazon_get_inventory_by_sku",
      title: "按 SKU 查库存",
      description: "Gets FBA inventory summary for a single seller SKU",
      domain: "inventory",
      action: "read",
      amazon_role: "",
      supported_regions: ["NA", "EU", "FE"],
      availability: "available",
      is_readonly: true,
    },
  );

  return entries;
}

const CAPABILITIES = buildCapabilities();

/* ------------------------------------------------------------------ */
/*  Route helpers                                                      */
/* ------------------------------------------------------------------ */

function event(request: Request, response: Response, action: string, resourceId: string): AuditEvent {
  return {
    actorType: "browser_session",
    actorId: "anonymous",
    action,
    resourceType: "admin_dashboard",
    resourceId,
    requestId: auditRequest(request, response),
  };
}

/* ------------------------------------------------------------------ */
/*  Route registration                                                 */
/* ------------------------------------------------------------------ */

export function registerAdminDashboardRoutes(
  app: Express,
  sessions: AdminSessionManager,
  agents: AdminAgentService,
  audits: AdminAuditService,
  deps: AdminDashboardDeps,
): void {
  // GET /api/v1/admin/dashboard — aggregate stats from PostgreSQL
  app.get("/api/v1/admin/dashboard", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "dashboard.view", "stats");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;
      const result = await deps.pool.query<DashboardRow>(`
        SELECT
          (SELECT COUNT(*)::text FROM amazon_sp_api.amazon_account) AS total_accounts,
          (SELECT COUNT(*)::text FROM amazon_sp_api.amazon_account WHERE status = 'active') AS active_accounts,
          (SELECT COUNT(*)::text FROM amazon_sp_api.employee_account_binding WHERE status = 'active') AS active_bindings,
          (SELECT COUNT(*)::text FROM amazon_sp_api.app_agent WHERE user_id = 'tenant-1' AND status = 'active') AS active_test_agents,
          (SELECT COUNT(*)::text FROM amazon_sp_api.audit_log WHERE result = 'failed' AND created_at > NOW() - INTERVAL '24 hours') AS recent_errors,
          (SELECT COUNT(*)::text FROM amazon_sp_api.amazon_credential WHERE status = 'active') AS status_active,
          (SELECT COUNT(*)::text FROM amazon_sp_api.amazon_credential WHERE status = 'pending') AS status_pending,
          (SELECT COUNT(*)::text FROM amazon_sp_api.amazon_credential WHERE status NOT IN ('active', 'pending')) AS status_error,
          (SELECT COUNT(*)::text FROM amazon_sp_api.connection_grant WHERE status = 'disconnected') AS status_disconnected
      `);
      const row = result.rows[0]!;
      await audits.record(audit, "success");
      response.json({
        total_accounts: Number(row.total_accounts),
        active_accounts: Number(row.active_accounts),
        active_bindings: Number(row.active_bindings),
        active_test_agents: Number(row.active_test_agents),
        credential_status_counts: {
          active: Number(row.status_active),
          pending: Number(row.status_pending),
          error: Number(row.status_error),
          disconnected: Number(row.status_disconnected),
        },
        recent_errors_count: Number(row.recent_errors),
      });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  // GET /api/v1/admin/amazon-config-status — infrastructure readiness
  app.get("/api/v1/admin/amazon-config-status", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "config.status", "infrastructure");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      const readiness = await deps.readinessCheck?.();
      await audits.record(audit, "success");
      response.json({
        lwa_client_id_configured: Boolean(deps.lwaClientId),
        lwa_client_secret_configured: Boolean(deps.lwaClientSecret),
        application_id_configured: Boolean(deps.applicationId),
        public_origin: deps.publicOrigin,
        oauth_callback_url: `${deps.publicOrigin}/oauth/amazon/callback`,
        postgres_status: readiness?.checks.postgres ?? "error",
        redis_status: readiness?.checks.redis ?? "error",
        credential_keyring_status: readiness?.checks.encryptionKey ?? "error",
        connected-account_keyring_status: deps.connected-accountKeyringConfigured ? "ok" : "error",
      });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  // GET /api/v1/admin/capabilities — read-only capability catalog
  app.get("/api/v1/admin/capabilities", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "capabilities.list", "catalog");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      let filtered = CAPABILITIES;
      const domain = typeof request.query.domain === "string" ? request.query.domain : undefined;
      const availability = typeof request.query.availability === "string" ? request.query.availability : undefined;

      if (domain) {
        filtered = filtered.filter((cap) => cap.domain === domain);
      }
      if (availability) {
        filtered = filtered.filter((cap) => cap.availability === availability);
      }

      await audits.record(audit, "success");
      response.json(filtered);
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  // GET /api/v1/admin/mcp-config — MCP endpoint configuration
  app.get("/api/v1/admin/mcp-config", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const audit = event(request, response, "mcp.config", "endpoint");
    try {
      if (!await authorizeAdminControl(request, response, sessions, agents, audits, audit, false)) return;

      const readiness = await deps.readinessCheck?.();
      const healthStatus = readiness?.status === "ready" ? "ok" as const
        : readiness ? "degraded" as const
          : "down" as const;

      // Build tool descriptions from static capabilities
      const tools = CAPABILITIES.map((cap) => ({
        name: cap.tool_name,
        description: cap.description,
      }));

      await audits.record(audit, "success");
      response.json({
        endpoint: `${deps.publicOrigin}${deps.mcpEndpoint}`,
        transport: "streamable-http",
        header_name: "Authorization",
        health_status: healthStatus,
        registered_tools_count: deps.toolCount,
        tools,
      });
    } catch {
      response.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });
}
