import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Internal Amazon MCP codes used by existing throw sites. */
export type AmazonMcpErrorCode =
  | "TENANT_REQUIRED"
  | "NOT_CONNECTED"
  | "SELLER_REQUIRED"
  | "SELLER_FORBIDDEN"
  | "SELLER_NOT_ALLOWED"
  | "AUTH_EXPIRED"
  | "IDENTITY_REJECTED"
  | "REGION_MISMATCH"
  | "INVALID_FILTER"
  | "RATE_LIMITED"
  | "UPSTREAM_SP_API"
  | "UPSTREAM_OAUTH"
  | "UPSTREAM_LWA"
  | "INTERNAL";

/** Public ConnectedAccount tool error codes (snake_case). */
export type ConnectedAccountPublicErrorCode =
  | "invalid_tool_arguments"
  | "unauthorized"
  | "forbidden"
  | "resource_not_found"
  | "resource_changed"
  | "conflict"
  | "upstream_error"
  | "timeout"
  | "configuration_required"
  | "internal_error"
  | "rate_limited";

export type AmazonMcpErrorDetails = Record<string, string | number | boolean>;

export interface AmazonMcpErrorPayload {
  code: AmazonMcpErrorCode;
  message: string;
  retryable: boolean;
  details?: AmazonMcpErrorDetails;
}

export interface ConnectedAccountToolErrorIssue {
  field: string;
  received: string;
  expected: string;
  fix: string;
}

export interface ConnectedAccountPublicErrorBody {
  code: ConnectedAccountPublicErrorCode;
  tool: string;
  message: string;
  detail?: string;
  http_status: number;
  request_id: string;
  next_action: string;
  issues?: ConnectedAccountToolErrorIssue[];
}

export interface ConnectedAccountPublicErrorEnvelope {
  error: ConnectedAccountPublicErrorBody;
}

export interface ToolRequestContext {
  requestId: string;
  tool?: string;
}

const toolRequestContext = new AsyncLocalStorage<ToolRequestContext>();

const PUBLIC_ERROR_MESSAGES: Readonly<Record<AmazonMcpErrorCode, string>> = {
  TENANT_REQUIRED: "Tenant identity required",
  NOT_CONNECTED: "Amazon seller is not connected for the current user",
  SELLER_REQUIRED: "A sellingPartnerId is required",
  SELLER_FORBIDDEN: "Amazon seller belongs to a different tenant",
  SELLER_NOT_ALLOWED: "Amazon seller is not enabled by the platform",
  AUTH_EXPIRED: "Amazon authorization has expired; reconnect the seller",
  IDENTITY_REJECTED: "Tenant identity was rejected",
  REGION_MISMATCH: "Amazon marketplaces must belong to one region",
  INVALID_FILTER: "Amazon tool arguments are invalid",
  RATE_LIMITED: "Amazon request rate limit exceeded",
  UPSTREAM_SP_API: "Amazon SP-API request failed",
  UPSTREAM_OAUTH: "Amazon OAuth service request failed",
  UPSTREAM_LWA: "Amazon LWA token exchange failed",
  INTERNAL: "Amazon MCP tool failed unexpectedly",
};

const PUBLIC_CODE_MESSAGES: Readonly<Record<ConnectedAccountPublicErrorCode, string>> = {
  invalid_tool_arguments: "Tool arguments are invalid",
  unauthorized: "Authentication is required or has expired",
  forbidden: "The current identity is not allowed to perform this action",
  resource_not_found: "The requested resource was not found for this identity",
  resource_changed: "The resource changed; re-read and retry",
  conflict: "The request conflicts with the current resource state",
  upstream_error: "The upstream provider request failed",
  timeout: "The operation timed out; query status before retrying",
  configuration_required: "Provider configuration is incomplete",
  internal_error: "An internal error occurred",
  rate_limited: "Request rate limit exceeded",
};

const NEXT_ACTIONS: Readonly<Record<ConnectedAccountPublicErrorCode, string>> = {
  invalid_tool_arguments: "Fix the reported argument issues and retry",
  unauthorized: "Obtain a new short-lived Employee JWT and retry",
  forbidden: "Check scope and account binding, then retry with an allowed account",
  resource_not_found: "List accounts or resources again and use a current identifier",
  resource_changed: "Re-read the full resource, merge changes, and retry",
  conflict: "Inspect current state and keep the original idempotency key if applicable",
  upstream_error: "Retry only if retryable; otherwise inspect request_id with an operator",
  timeout: "Query operation status before retrying; do not blind-retry writes",
  configuration_required: "Contact an administrator to complete provider configuration",
  internal_error: "Retry later and provide request_id to an operator; do not retry with secrets",
  rate_limited: "Wait for retry-after and reduce request rate",
};

const HTTP_STATUS: Readonly<Record<ConnectedAccountPublicErrorCode, number>> = {
  invalid_tool_arguments: 400,
  unauthorized: 401,
  forbidden: 403,
  resource_not_found: 404,
  resource_changed: 409,
  conflict: 409,
  upstream_error: 502,
  timeout: 504,
  configuration_required: 503,
  internal_error: 500,
  rate_limited: 429,
};

const INTERNAL_TO_PUBLIC: Readonly<Record<AmazonMcpErrorCode, ConnectedAccountPublicErrorCode>> = {
  TENANT_REQUIRED: "unauthorized",
  NOT_CONNECTED: "resource_not_found",
  SELLER_REQUIRED: "invalid_tool_arguments",
  SELLER_FORBIDDEN: "forbidden",
  SELLER_NOT_ALLOWED: "forbidden",
  AUTH_EXPIRED: "unauthorized",
  IDENTITY_REJECTED: "unauthorized",
  REGION_MISMATCH: "invalid_tool_arguments",
  INVALID_FILTER: "invalid_tool_arguments",
  RATE_LIMITED: "rate_limited",
  UPSTREAM_SP_API: "upstream_error",
  UPSTREAM_OAUTH: "upstream_error",
  UPSTREAM_LWA: "upstream_error",
  INTERNAL: "internal_error",
};

const ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(PUBLIC_ERROR_MESSAGES));
const DETAIL_KEYS = new Set(["status", "requestId", "retryAfterSeconds"]);
const MAX_DETAIL_LENGTH = 256;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function runWithToolRequestContext<T>(
  context: ToolRequestContext,
  operation: () => T,
): T {
  return toolRequestContext.run(context, operation);
}

export function getToolRequestContext(): ToolRequestContext | undefined {
  return toolRequestContext.getStore();
}

export function normalizeRequestId(value: unknown): string {
  if (typeof value === "string" && REQUEST_ID_PATTERN.test(value)) return value;
  return randomUUID();
}

export function mapInternalErrorCode(code: AmazonMcpErrorCode): ConnectedAccountPublicErrorCode {
  return INTERNAL_TO_PUBLIC[code];
}

function clampDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : trimmed;
}

function extractToolName(errorMessage: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 128);
  const fromContext = toolRequestContext.getStore()?.tool;
  if (fromContext) return fromContext;
  const match = errorMessage.match(/Invalid arguments for tool ([A-Za-z0-9_-]+)/);
  if (match?.[1]) return match[1];
  const missing = errorMessage.match(/Tool ([A-Za-z0-9_-]+) not found/);
  if (missing?.[1]) return missing[1];
  return "unknown";
}

function buildPublicEnvelope(options: {
  code: ConnectedAccountPublicErrorCode;
  tool: string;
  message?: string;
  detail?: string;
  requestId?: string;
  issues?: ConnectedAccountToolErrorIssue[];
  retryAfterSeconds?: number;
}): ConnectedAccountPublicErrorEnvelope {
  const requestId = normalizeRequestId(
    options.requestId ?? toolRequestContext.getStore()?.requestId,
  );
  const body: ConnectedAccountPublicErrorBody = {
    code: options.code,
    tool: options.tool.slice(0, 128) || "unknown",
    message: options.message?.trim() || PUBLIC_CODE_MESSAGES[options.code],
    http_status: HTTP_STATUS[options.code],
    request_id: requestId,
    next_action: NEXT_ACTIONS[options.code],
  };
  const detail = clampDetail(options.detail);
  // internal_error must not carry diagnostic detail.
  if (detail && options.code !== "internal_error") body.detail = detail;
  if (options.issues && options.issues.length > 0) body.issues = options.issues;
  if (
    options.code === "rate_limited" &&
    typeof options.retryAfterSeconds === "number" &&
    Number.isFinite(options.retryAfterSeconds) &&
    options.retryAfterSeconds >= 0
  ) {
    body.detail = clampDetail(
      `retry_after_seconds=${Math.min(Math.floor(options.retryAfterSeconds), 3600)}`,
    );
  }
  return { error: body };
}

export function formatConnectedAccountToolError(options: {
  code: ConnectedAccountPublicErrorCode;
  tool?: string;
  message?: string;
  detail?: string;
  requestId?: string;
  issues?: ConnectedAccountToolErrorIssue[];
  retryAfterSeconds?: number;
}): string {
  return JSON.stringify(buildPublicEnvelope({
    ...options,
    tool: options.tool ?? extractToolName("", options.tool),
  }));
}

export function normalizeToolErrorMessage(errorMessage: string): string {
  try {
    const parsed: unknown = JSON.parse(errorMessage);
    if (
      isRecord(parsed) &&
      typeof parsed.code === "string" &&
      ERROR_CODES.has(parsed.code) &&
      typeof parsed.message === "string" &&
      typeof parsed.retryable === "boolean"
    ) {
      const internalCode = parsed.code as AmazonMcpErrorCode;
      const publicCode = mapInternalErrorCode(internalCode);
      const details = isRecord(parsed.details)
        ? Object.fromEntries(
          Object.entries(parsed.details).filter(
            (entry): entry is [string, string | number | boolean] =>
              DETAIL_KEYS.has(entry[0]) &&
              ["string", "number", "boolean"].includes(typeof entry[1]) &&
              (typeof entry[1] !== "string" || entry[1].length <= 256),
          ),
        )
        : undefined;
      const requestId = typeof details?.requestId === "string"
        ? details.requestId
        : undefined;
      const retryAfterSeconds = typeof details?.retryAfterSeconds === "number"
        ? details.retryAfterSeconds
        : undefined;
      // Prefer canonical public messages; never echo raw internal diagnostic text
      // for internal_error. Safe limited detail may include upstream status only.
      const detail = publicCode === "internal_error"
        ? undefined
        : typeof details?.status === "number"
          ? `upstream_status=${details.status}`
          : clampDetail(
            parsed.message !== PUBLIC_ERROR_MESSAGES[internalCode]
              ? parsed.message
              : undefined,
          );
      return JSON.stringify(buildPublicEnvelope({
        code: publicCode,
        tool: extractToolName(errorMessage),
        message: PUBLIC_CODE_MESSAGES[publicCode],
        detail,
        requestId,
        retryAfterSeconds,
      }));
    }

    // Already a public envelope — re-freeze allowed fields only.
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code = parsed.error.code;
      if (typeof code === "string" && code in PUBLIC_CODE_MESSAGES) {
        return JSON.stringify(buildPublicEnvelope({
          code: code as ConnectedAccountPublicErrorCode,
          tool: typeof parsed.error.tool === "string" ? parsed.error.tool : "unknown",
          message: typeof parsed.error.message === "string"
            ? parsed.error.message
            : undefined,
          detail: typeof parsed.error.detail === "string" ? parsed.error.detail : undefined,
          requestId: typeof parsed.error.request_id === "string"
            ? parsed.error.request_id
            : undefined,
        }));
      }
    }
  } catch {
    // The MCP SDK formats schema validation failures as human-readable text.
  }

  if (errorMessage.includes("Input validation error:")) {
    return JSON.stringify(buildPublicEnvelope({
      code: "invalid_tool_arguments",
      tool: extractToolName(errorMessage),
      message: PUBLIC_CODE_MESSAGES.invalid_tool_arguments,
      detail: "One or more tool arguments failed schema validation",
    }));
  }

  return JSON.stringify(buildPublicEnvelope({
    code: "internal_error",
    tool: extractToolName(errorMessage),
    message: PUBLIC_CODE_MESSAGES.internal_error,
  }));
}

export class AmazonMcpError extends Error {
  readonly code: AmazonMcpErrorCode;
  readonly retryable: boolean;
  readonly details?: AmazonMcpErrorDetails;
  readonly humanMessage: string;

  constructor(
    code: AmazonMcpErrorCode,
    message: string,
    retryable = false,
    details?: AmazonMcpErrorDetails,
  ) {
    const payload: AmazonMcpErrorPayload = { code, message, retryable };
    if (details && Object.keys(details).length > 0) payload.details = details;
    super(JSON.stringify(payload));
    this.name = "AmazonMcpError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.humanMessage = message;
  }

  toJSON(): AmazonMcpErrorPayload {
    const payload: AmazonMcpErrorPayload = {
      code: this.code,
      message: this.humanMessage,
      retryable: this.retryable,
    };
    if (this.details && Object.keys(this.details).length > 0) payload.details = this.details;
    return payload;
  }

  toPublicEnvelope(tool?: string): ConnectedAccountPublicErrorEnvelope {
    return buildPublicEnvelope({
      code: mapInternalErrorCode(this.code),
      tool: tool ?? extractToolName(this.message, tool),
      message: PUBLIC_CODE_MESSAGES[mapInternalErrorCode(this.code)],
      detail: mapInternalErrorCode(this.code) === "internal_error"
        ? undefined
        : clampDetail(this.humanMessage !== PUBLIC_ERROR_MESSAGES[this.code]
          ? this.humanMessage
          : undefined),
      requestId: typeof this.details?.requestId === "string"
        ? this.details.requestId
        : undefined,
      retryAfterSeconds: typeof this.details?.retryAfterSeconds === "number"
        ? this.details.retryAfterSeconds
        : undefined,
    });
  }
}
