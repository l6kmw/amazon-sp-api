import { createHmac } from "node:crypto";
import { getToolRequestContext } from "./errors.js";
import { SP_API_OPERATIONS } from "./generated/sp-api-registry.js";

export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean;

/** Stable public error_code values allowed in logs/metrics. */
export const LOG_ERROR_CODES = [
  "invalid_tool_arguments",
  "unauthorized",
  "forbidden",
  "AMAZON_ROLE_REQUIRED",
  "resource_not_found",
  "resource_changed",
  "conflict",
  "upstream_error",
  "timeout",
  "configuration_required",
  "internal_error",
  "rate_limited",
  "auth_rejected",
  "scope_rejected",
  "tenant_rejected",
  "protocol_error",
  "lwa_failed",
  "sp_api_failed",
  "unknown",
] as const;

export type LogErrorCode = (typeof LOG_ERROR_CODES)[number];

const COMMON_FIELDS = [
  "request_id",
  "result",
  "duration_ms",
  "error_code",
  "service",
] as const;

/**
 * Fixed event dictionary. Unknown events/fields are dropped (fail closed for content).
 * Values are extra field names allowed beyond COMMON_FIELDS.
 */
export const EVENT_FIELD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "mcp.auth.rejected": [],
  "mcp.scope.rejected": ["actor_type", "actor_id_hash"],
  "mcp.tenant.rejected": ["actor_type", "actor_id_hash"],
  "mcp.request.completed": ["method", "tool", "actor_type", "actor_id_hash"],
  "mcp.request.failed": ["method", "tool", "actor_type", "actor_id_hash"],
  "mcp.tool.completed": ["tool", "actor_type", "actor_id_hash", "issuer_alias"],
  "mcp.tool.failed": ["tool", "actor_type", "actor_id_hash", "issuer_alias"],
  "mcp.argument_log.failed": ["tool", "actor_type", "actor_id_hash"],
  "mcp.alert.persist_failed": ["tool", "actor_type", "actor_id_hash"],
  "lwa.refresh.completed": ["result", "attempt"],
  "lwa.refresh.failed": ["error_code", "attempt"],
  "lwa.refresh.rotation_skipped": ["reason_code"],
  "lwa.lock.wait": [],
  "mcp.pagination.budget_exhausted": ["tool", "pages_completed", "budget_ms"],
  "sp_api.request.completed": ["operation", "result", "attempt"],
  "sp_api.request.failed": ["operation", "error_code", "attempt", "upstream_status"],
  "readiness.check": ["dependency", "status"],
  "config.loaded": ["config_version"],
  "rotation.key": ["key_id", "key_class", "status"],
  // Test-only event used by unit tests of the logger itself.
  "logger.self_test": ["status"],
};

const TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const ACTOR_TYPES = new Set(["connected-account", "test_agent", "unknown"]);
const RESULTS = new Set(["success", "error", "rejected", "timeout"]);
const METHODS = new Set([
  "initialize",
  "tools/list",
  "tools/call",
  "ping",
  "unknown",
]);
const OPERATIONS = new Set([
  "marketplace_participations",
  "search_orders",
  "get_order",
  "inventory_summaries",
  "search_listings",
  "get_listing_item",
  ...SP_API_OPERATIONS.map((operation) => operation.operationId),
  "unknown",
]);
const DEPENDENCIES = new Set([
  "postgres",
  "redis",
  "oauth",
  "encryption_key",
  "token_store",
  "unknown",
]);
const KEY_CLASSES = new Set(["current", "legacy", "unknown"]);
const REASON_CODES = new Set([
  "store_not_writable",
  "conflict",
  "missing",
  "unknown",
]);

export interface StructuredLogger {
  hash(value: string | undefined): string | undefined;
  write(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  droppedCount(): number;
}

export const NULL_LOGGER: StructuredLogger = {
  hash: () => undefined,
  write: () => undefined,
  droppedCount: () => 0,
};

function isLogValue(value: unknown): value is LogValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function clampDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, 3_600_000);
}

function sanitizeField(
  event: string,
  key: string,
  value: unknown,
): LogValue | undefined {
  if (!isLogValue(value)) return undefined;
  if (typeof value === "string" && value.length > 128) return undefined;

  switch (key) {
    case "request_id":
      return typeof value === "string" && REQUEST_ID.test(value) ? value : undefined;
    case "duration_ms":
      return clampDuration(value);
    case "error_code":
      return typeof value === "string" && (LOG_ERROR_CODES as readonly string[]).includes(value)
        ? value
        : "unknown";
    case "result":
      return typeof value === "string" && RESULTS.has(value) ? value : undefined;
    case "service":
      return value === "mcp" || value === "oauth" ? value : undefined;
    case "tool":
      return typeof value === "string" && TOOL_NAME.test(value) ? value : "unknown";
    case "actor_type":
      return typeof value === "string" && ACTOR_TYPES.has(value) ? value : "unknown";
    case "actor_id_hash":
      return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value)
        ? value
        : undefined;
    case "issuer_alias":
      return typeof value === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(value)
        ? value
        : undefined;
    case "method":
      return typeof value === "string" && METHODS.has(value) ? value : "unknown";
    case "operation":
      return typeof value === "string" && OPERATIONS.has(value) ? value : "unknown";
    case "attempt":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10
        ? value
        : undefined;
    case "pages_completed":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
        ? value
        : undefined;
    case "budget_ms":
      return clampDuration(value);
    case "upstream_status":
      return event === "sp_api.request.failed" &&
        typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
        ? value
        : undefined;
    case "dependency":
      return typeof value === "string" && DEPENDENCIES.has(value) ? value : "unknown";
    case "status":
      if (event.startsWith("readiness.") || event === "logger.self_test" || event === "rotation.key") {
        return typeof value === "string" && ["ok", "error", "ready", "not_ready", "success", "failed"].includes(value)
          ? value
          : undefined;
      }
      return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
        ? value
        : undefined;
    case "key_id":
      return typeof value === "string" && KEY_ID.test(value) ? value : undefined;
    case "key_class":
      return typeof value === "string" && KEY_CLASSES.has(value) ? value : "unknown";
    case "config_version":
      return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value)
        ? value
        : undefined;
    case "reason_code":
      return typeof value === "string" && REASON_CODES.has(value) ? value : "unknown";
    default:
      return undefined;
  }
}

export function createStructuredLogger(options: {
  hashKey: string;
  service?: "mcp" | "oauth";
  write?: (line: string, level: LogLevel) => void;
}): StructuredLogger {
  const service = options.service ?? "mcp";
  let dropped = 0;
  const output = options.write ?? ((line, level) => {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  });

  return {
    hash(value) {
      if (!value) return undefined;
      return createHmac("sha256", options.hashKey).update(value).digest("hex").slice(0, 16);
    },
    droppedCount() {
      return dropped;
    },
    write(level, event, fields = {}) {
      try {
        const allowedExtras = EVENT_FIELD_ALLOWLIST[event];
        if (!allowedExtras) {
          dropped += 1;
          return;
        }
        const allowed = new Set<string>([...COMMON_FIELDS, ...allowedExtras]);
        const safe: Record<string, LogValue> = { service };
        const context = getToolRequestContext();
        const contextualFields = context
          ? { ...fields, request_id: context.requestId }
          : fields;
        for (const [key, value] of Object.entries(contextualFields)) {
          if (!allowed.has(key)) {
            dropped += 1;
            continue;
          }
          const sanitized = sanitizeField(event, key, value);
          if (sanitized === undefined) {
            dropped += 1;
            continue;
          }
          safe[key] = sanitized;
        }
        output(JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          event,
          ...safe,
        }), level);
      } catch {
        dropped += 1;
      }
    },
  };
}

export function actorTypeFromAuth(
  authType: string | undefined,
): "connected-account" | "test_agent" | "unknown" {
  if (authType === "connected-account" || authType === "test_agent") return authType;
  return "unknown";
}
