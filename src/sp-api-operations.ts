import { buildSchema, Kind, parse, validate, type DocumentNode, type SelectionSetNode } from "graphql";
import { z, type ZodTypeAny } from "zod";

import { AmazonMcpError } from "./errors.js";
import {
  SP_API_DATA_KIOSK_SCHEMAS,
  SP_API_MODEL_COMMIT,
  SP_API_MODEL_SCHEMAS,
  SP_API_OPERATIONS,
} from "./generated/sp-api-registry.js";
import { SpApiError, type AmazonRegion, type SpApiReader } from "./sp-api-client.js";

export const SP_API_DOMAINS = [
  "seller", "catalog", "listings", "orders", "inventory", "pricing",
  "analytics", "finances", "warehousing", "fulfillment", "shipping",
  "services", "content", "reports", "data_kiosk", "feeds", "integrations",
] as const;
export type SpApiDomain = (typeof SP_API_DOMAINS)[number];

interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  required?: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  allOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
}

interface OperationParameter {
  name: string;
  required: boolean;
  schema: JsonSchema;
}

export interface SpApiReadOperation {
  action: string;
  domain: SpApiDomain;
  operationId: string;
  modelId: string;
  version: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  roles: readonly string[];
  regions: readonly AmazonRegion[];
  retry: "idempotent" | "never_on_uncertain_failure";
  parameters: {
    path: readonly OperationParameter[];
    query: readonly OperationParameter[];
    body?: { required: boolean; schema: JsonSchema };
  };
  responseSchema: JsonSchema;
}

export const READ_OPERATIONS = SP_API_OPERATIONS as unknown as readonly SpApiReadOperation[];
export const FROZEN_SP_API_MODEL_COMMIT = SP_API_MODEL_COMMIT;

const ACCOUNT_BOUND_PARAMETERS = new Set(["sellerId", "sellingPartnerId"]);
const REPORT_TYPES = new Set([
  "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
  "GET_MERCHANT_LISTINGS_ALL_DATA",
  "GET_MERCHANT_LISTINGS_DATA",
  "GET_MERCHANT_LISTINGS_INACTIVE_DATA",
  "GET_MERCHANT_LISTINGS_DATA_BACK_COMPAT",
  "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
  "GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA",
  "GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA",
  "GET_FBA_INVENTORY_PLANNING_DATA",
  "GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT",
  "GET_SALES_AND_TRAFFIC_REPORT",
  "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
]);
const FEED_TYPES = new Set([
  "JSON_LISTINGS_FEED",
  "POST_FLAT_FILE_INVLOADER_DATA",
  "POST_FLAT_FILE_PRICEANDQUANTITYONLY_UPDATE_DATA",
  "POST_INVENTORY_AVAILABILITY_DATA",
  "POST_PRODUCT_DATA",
  "POST_PRODUCT_PRICING_DATA",
]);
const NOTIFICATION_TYPES = new Set([
  "ACCOUNT_STATUS_CHANGED",
  "ANY_OFFER_CHANGED",
  "B2B_ANY_OFFER_CHANGED",
  "FBA_OUTBOUND_SHIPMENT_STATUS",
  "FEE_PROMOTION",
  "FULFILLMENT_ORDER_STATUS",
  "ITEM_INVENTORY_EVENT_CHANGE",
  "LISTING_ITEM_ISSUES_CHANGE",
  "LISTINGS_ITEM_MFN_QUANTITY_CHANGE",
  "LISTINGS_ITEM_STATUS_CHANGE",
  "ORDER_CHANGE",
  "PRICING_HEALTH",
  "PRODUCT_TYPE_DEFINITIONS_CHANGE",
  "REPORT_PROCESSING_FINISHED",
  "TRANSACTION_UPDATE",
]);
const ORDER_PII_SEGMENTS = new Set(["BUYER", "RECIPIENT", "PACKAGES", "PAYMENT", "TAX"]);
const DOCUMENT_OPERATIONS = new Set(["getReportDocument", "getDocument", "getFeedDocument"]);

export function isDocumentReadOperation(operation: SpApiReadOperation): boolean {
  return DOCUMENT_OPERATIONS.has(operation.operationId);
}

function definitionsFor(modelId: string): Readonly<Record<string, JsonSchema>> {
  return (SP_API_MODEL_SCHEMAS as unknown as Record<string, Record<string, JsonSchema>>)[modelId] ?? {};
}

function resolved(schema: JsonSchema, definitions: Readonly<Record<string, JsonSchema>>): JsonSchema {
  const name = schema.$ref?.match(/^#\/definitions\/(.+)$/)?.[1];
  return name ? definitions[name] ?? {} : schema;
}

function schemaToZod(
  source: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth = 0,
  references = new Set<string>(),
): ZodTypeAny {
  if (depth > 20) return z.unknown();
  if (source.$ref) {
    if (references.has(source.$ref)) return z.unknown();
    return schemaToZod(resolved(source, definitions), definitions, depth + 1, new Set([...references, source.$ref]));
  }
  if (source.allOf?.length) {
    return source.allOf.map((item) => schemaToZod(item, definitions, depth + 1, references))
      .reduce((left, right) => z.intersection(left, right));
  }
  const alternatives = source.oneOf ?? source.anyOf;
  if (alternatives?.length) {
    const variants = alternatives.map((item) => schemaToZod(item, definitions, depth + 1, references));
    return variants.length === 1 ? variants[0]! : z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  if (source.enum?.length) {
    const literals = source.enum.map((value) => z.literal(value as string | number | boolean));
    return literals.length === 1
      ? literals[0]!
      : z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  if (source.type === "string" || (!source.type && ["date", "date-time", "uuid", "uri"].includes(source.format ?? ""))) {
    let value = z.string().max(Math.min(source.maxLength ?? 32_768, 65_536));
    if (source.minLength !== undefined) value = value.min(source.minLength);
    if (source.pattern) value = value.regex(new RegExp(source.pattern));
    if (source.format === "date-time") value = value.datetime({ offset: true });
    return value;
  }
  if (source.type === "integer") {
    let value = z.number().int();
    if (source.minimum !== undefined) value = value.min(source.minimum);
    if (source.maximum !== undefined) value = value.max(source.maximum);
    return value;
  }
  if (source.type === "number") {
    let value = z.number().finite();
    if (source.minimum !== undefined) value = value.min(source.minimum);
    if (source.maximum !== undefined) value = value.max(source.maximum);
    return value;
  }
  if (source.type === "boolean") return z.boolean();
  if (source.type === "array" || source.items) {
    return z.array(schemaToZod(source.items ?? {}, definitions, depth + 1, references))
      .min(source.minItems ?? 0)
      .max(Math.min(source.maxItems ?? 100, 200));
  }
  if (source.type === "object" || source.properties || source.additionalProperties) {
    const required = new Set(source.required ?? []);
    const shape = Object.fromEntries(Object.entries(source.properties ?? {}).map(([name, schema]) => {
      const validator = schemaToZod(schema, definitions, depth + 1, references);
      return [name, required.has(name) ? validator : validator.optional()];
    }));
    const object = z.object(shape);
    if (source.additionalProperties === true) return object.catchall(z.unknown());
    if (source.additionalProperties && typeof source.additionalProperties === "object") {
      return object.catchall(schemaToZod(source.additionalProperties, definitions, depth + 1, references));
    }
    return object.strict();
  }
  return z.unknown();
}

function parameterShape(parameters: readonly OperationParameter[], modelId: string) {
  const definitions = definitionsFor(modelId);
  return Object.fromEntries(parameters
    .filter((parameter) => !ACCOUNT_BOUND_PARAMETERS.has(parameter.name))
    .map((parameter) => {
      const validator = schemaToZod(parameter.schema, definitions);
      return [parameter.name, parameter.required ? validator : validator.optional()];
    }));
}

function operationVariant(operation: SpApiReadOperation) {
  if (isDocumentReadOperation(operation)) {
    return z.object({
      action: z.literal(operation.action),
      account_id: z.string().regex(/^acct_[A-Za-z0-9_-]{16,128}$/),
      region: z.enum(["na", "eu", "fe"]),
      job_id: z.string().min(1).max(256),
      cursor: z.string().min(32).max(4096).optional(),
    }).strict();
  }
  const definitions = definitionsFor(operation.modelId);
  const body = operation.parameters.body
    ? schemaToZod(operation.parameters.body.schema, definitions)
    : z.never().optional();
  return z.object({
    action: z.literal(operation.action),
    account_id: z.string().regex(/^acct_[A-Za-z0-9_-]{16,128}$/),
    region: z.enum(["na", "eu", "fe"]),
    path: z.object(parameterShape(operation.parameters.path, operation.modelId)).strict().default({}),
    query: z.object(parameterShape(operation.parameters.query, operation.modelId)).strict().default({}),
    body: operation.parameters.body?.required ? body : body.optional(),
  }).strict();
}

export function domainInputSchema(domain: SpApiDomain): ZodTypeAny {
  const actions = READ_OPERATIONS.filter((operation) => operation.domain === domain).map((operation) => operation.action);
  if (actions.length === 0) {
    return z.object({
      action: z.never(),
      account_id: z.string().regex(/^acct_[A-Za-z0-9_-]{16,128}$/),
      region: z.enum(["na", "eu", "fe"]),
    }).strict();
  }
  return z.object({
    action: z.enum(actions as [string, ...string[]]),
    account_id: z.string().regex(/^acct_[A-Za-z0-9_-]{16,128}$/),
    region: z.enum(["na", "eu", "fe"]),
    path: z.record(z.unknown()).optional(),
    query: z.record(z.unknown()).optional(),
    body: z.unknown().optional(),
    job_id: z.string().min(1).max(256).optional(),
    cursor: z.string().min(32).max(4096).optional(),
  }).strict();
}

export function validateOperationInput(operation: SpApiReadOperation, input: unknown): void {
  const parsed = operationVariant(operation).parse(input) as { region: AmazonRegion };
  if (!operation.regions.includes(parsed.region)) {
    throw new AmazonMcpError("REGION_MISMATCH", "operation is not available in the selected Amazon region");
  }
}

export function operationForAction(domain: SpApiDomain, action: string): SpApiReadOperation {
  const operation = READ_OPERATIONS.find((item) => item.domain === domain && item.action === action);
  if (!operation) throw new AmazonMcpError("INVALID_FILTER", "unsupported read action");
  return operation;
}

function values(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function requireAllowlist(value: unknown, allowed: ReadonlySet<string>, field: string): void {
  for (const item of values(value)) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new AmazonMcpError("INVALID_FILTER", `${field} is not in the non-restricted Seller allowlist`);
    }
  }
}

function requireAllowlistedValue(value: unknown, allowed: ReadonlySet<string>, field: string): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new AmazonMcpError("INVALID_FILTER", `${field} is not in the non-restricted Seller allowlist`);
  }
  return value;
}

function queryMetrics(selectionSet: SelectionSetNode, depth = 1): { fields: number; depth: number } {
  let fields = 0;
  let maximum = depth;
  for (const selection of selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) continue;
    fields += 1;
    if (selection.name.value.startsWith("__")) {
      throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk introspection is not allowed");
    }
    if (selection.selectionSet) {
      const nested = queryMetrics(selection.selectionSet, depth + 1);
      fields += nested.fields;
      maximum = Math.max(maximum, nested.depth);
    }
  }
  return { fields, depth: maximum };
}

function validateDataKioskQuery(value: unknown): void {
  if (typeof value !== "string" || value.length > 8_000) {
    throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk query must contain at most 8000 characters");
  }
  let document: DocumentNode;
  try {
    document = parse(value, { maxTokens: 4_000 });
  } catch {
    throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk query is not valid GraphQL");
  }
  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length !== 1 || operations[0]?.operation !== "query") {
    throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk allows exactly one query operation");
  }
  const metrics = queryMetrics(operations[0].selectionSet);
  if (metrics.depth > 12 || metrics.fields > 200) {
    throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk query exceeds the depth or field limit");
  }
  const roots = operations[0].selectionSet.selections
    .filter((selection) => selection.kind === Kind.FIELD)
    .map((selection) => selection.name.value);
  if (roots.length !== 1 || !(roots[0]! in SP_API_DATA_KIOSK_SCHEMAS)) {
    throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk query must use one current Seller schema");
  }
  const schema = buildSchema(SP_API_DATA_KIOSK_SCHEMAS[roots[0] as keyof typeof SP_API_DATA_KIOSK_SCHEMAS]);
  if (validate(schema, document).length > 0) {
    throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk query does not match the frozen Seller schema");
  }
}

export function validateDocumentJob(operation: SpApiReadOperation, job: Record<string, unknown>): {
  documentId: string;
  context: string;
  } {
  if (job.processingStatus !== "DONE") {
    throw new AmazonMcpError("INVALID_FILTER", "the Amazon read job is not complete");
  }
  if (operation.operationId === "getReportDocument") {
    const reportType = requireAllowlistedValue(job.reportType, REPORT_TYPES, "reportType");
    if (typeof job.reportDocumentId !== "string") {
      throw new AmazonMcpError("INVALID_FILTER", "the report has no result document");
    }
    return { documentId: job.reportDocumentId, context: `report:${reportType}` };
  }
  if (operation.operationId === "getFeedDocument") {
    const feedType = requireAllowlistedValue(job.feedType, FEED_TYPES, "feedType");
    if (typeof job.resultFeedDocumentId !== "string") {
      throw new AmazonMcpError("INVALID_FILTER", "the feed has no result document");
    }
    return { documentId: job.resultFeedDocumentId, context: `feed:${feedType}` };
  }
  validateDataKioskQuery(job.query);
  if (typeof job.dataDocumentId !== "string") {
    throw new AmazonMcpError("INVALID_FILTER", "the Data Kiosk query has no data document");
  }
  const root = (job.query as string).match(/\{\s*([_A-Za-z][_0-9A-Za-z]*)/)?.[1] ?? "unknown";
  return { documentId: job.dataDocumentId, context: `data_kiosk:${root}` };
}

export function validateOperationPolicy(operation: SpApiReadOperation, input: {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}): void {
  if (operation.domain === "orders") {
    const included = input.query?.includedData;
    for (const item of values(included)) {
      if (typeof item === "string" && ORDER_PII_SEGMENTS.has(item)) {
        throw new AmazonMcpError("INVALID_FILTER", "Orders PII data segments are not allowed");
      }
    }
  }
  if (operation.domain === "reports") {
    const body = input.body as Record<string, unknown> | undefined;
    requireAllowlist(body?.reportType ?? input.query?.reportTypes, REPORT_TYPES, "reportType");
  }
  if (operation.domain === "feeds") requireAllowlist(input.query?.feedTypes, FEED_TYPES, "feedTypes");
  if (operation.domain === "integrations") {
    requireAllowlist(input.path?.notificationType ?? input.query?.notificationType, NOTIFICATION_TYPES, "notificationType");
  }
  if (operation.operationId === "createQuery") {
    validateDataKioskQuery((input.body as Record<string, unknown> | undefined)?.query);
  }
}

function operationPath(operation: SpApiReadOperation, supplied: Record<string, unknown>, seller: string): string {
  const pathValues = { ...supplied };
  for (const parameter of operation.parameters.path) {
    if (ACCOUNT_BOUND_PARAMETERS.has(parameter.name)) pathValues[parameter.name] = seller;
  }
  return operation.path.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathValues[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new AmazonMcpError("INVALID_FILTER", `missing path parameter ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

const SENSITIVE_RESPONSE_KEY = /(?:^buyer|recipient|shipTo|address|phone|email|contact|firstName|lastName|fullName|contactName|tracking|payment|bankAccount|taxRegistration|customizedUrl|DocumentId|documentUrl|preSignedUrl|encryptionDetails|^url$)/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function allowedDataKioskQuery(value: unknown): boolean {
  try {
    validateDataKioskQuery(value);
    return true;
  } catch {
    return false;
  }
}

function enforceResponsePolicy(operation: SpApiReadOperation, value: unknown): unknown {
  const body = record(value);
  if (!body) return value;
  if (operation.domain === "seller" && operation.operationId === "getAccount") {
    const { business: _business, primaryContact: _primaryContact, ...safe } = body.payload
      ? record(body.payload) ?? {}
      : body;
    return body.payload ? { ...body, payload: safe } : safe;
  }
  if (operation.operationId === "getReport") {
    requireAllowlistedValue(body.reportType, REPORT_TYPES, "reportType");
  }
  if (operation.operationId === "getReports") {
    return {
      ...body,
      reports: Array.isArray(body.reports)
        ? body.reports.filter((item) => REPORT_TYPES.has(String(record(item)?.reportType ?? "")))
        : [],
    };
  }
  if (operation.operationId === "getFeed") {
    requireAllowlistedValue(body.feedType, FEED_TYPES, "feedType");
  }
  if (operation.operationId === "getFeeds") {
    return {
      ...body,
      feeds: Array.isArray(body.feeds)
        ? body.feeds.filter((item) => FEED_TYPES.has(String(record(item)?.feedType ?? "")))
        : [],
    };
  }
  if (operation.operationId === "getQuery") {
    if (!allowedDataKioskQuery(body.query)) {
      throw new AmazonMcpError("INVALID_FILTER", "Data Kiosk query is outside the current Seller schema");
    }
  }
  if (operation.operationId === "getQueries") {
    return {
      ...body,
      queries: Array.isArray(body.queries)
        ? body.queries.filter((item) => allowedDataKioskQuery(record(item)?.query))
        : [],
    };
  }
  return value;
}

function projectResponse(
  value: unknown,
  source: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth = 0,
): unknown {
  if (depth > 20) return undefined;
  const schema = resolved(source, definitions);
  if (schema.allOf?.length) {
    return Object.assign({}, ...schema.allOf.map((part) => projectResponse(value, part, definitions, depth + 1))
      .filter((item) => item && typeof item === "object" && !Array.isArray(item)));
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives?.length) {
    return alternatives.map((part) => projectResponse(value, part, definitions, depth + 1))
      .sort((left, right) => JSON.stringify(right ?? "").length - JSON.stringify(left ?? "").length)[0];
  }
  if (Array.isArray(value)) {
    if (!schema.items) return [];
    return value.slice(0, 200).map((item) => projectResponse(item, schema.items!, definitions, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {}).slice(0, 500)) {
      if (!(name in input) || SENSITIVE_RESPONSE_KEY.test(name)) continue;
      const projected = projectResponse(input[name], property, definitions, depth + 1);
      if (projected !== undefined) output[name] = projected;
    }
    if (schema.additionalProperties) {
      const additional = schema.additionalProperties === true ? {} : schema.additionalProperties;
      for (const [name, item] of Object.entries(input).slice(0, 500)) {
        if (name in output || name in (schema.properties ?? {}) || SENSITIVE_RESPONSE_KEY.test(name)) continue;
        const projected = projectResponse(item, additional, definitions, depth + 1);
        if (projected !== undefined) output[name] = projected;
      }
    }
    return output;
  }
  if (typeof value === "string") return value.slice(0, 65_536);
  if (["number", "boolean"].includes(typeof value) || value === null) return value;
  return undefined;
}

export class SpApiCapabilityTracker {
  readonly #status = new Map<string, "available" | "permission_required">();

  get(tenantId: string, accountId: string, operationId: string): "unknown" | "available" | "permission_required" {
    return this.#status.get(JSON.stringify([tenantId, accountId, operationId])) ?? "unknown";
  }

  set(tenantId: string, accountId: string, operationId: string, status: "available" | "permission_required"): void {
    this.#status.set(JSON.stringify([tenantId, accountId, operationId]), status);
  }
}

export async function executeReadOperation(options: {
  client: SpApiReader;
  operation: SpApiReadOperation;
  tenantId: string;
  accountId: string;
  sellingPartnerId: string;
  region: AmazonRegion;
  input: { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
  capabilities?: SpApiCapabilityTracker;
  internalDocumentJob?: boolean;
}): Promise<unknown> {
  validateOperationPolicy(options.operation, options.input);
  if (!options.client.request) throw new AmazonMcpError("INTERNAL", "SP-API request registry is unavailable");
  if (options.operation.operationId === "cancelReport") {
    await executeReadOperation({
      ...options,
      operation: operationForAction("reports", "getReport"),
      input: { path: { reportId: options.input.path?.reportId } },
    });
  }
  if (options.operation.operationId === "cancelQuery") {
    await executeReadOperation({
      ...options,
      operation: operationForAction("data_kiosk", "getQuery"),
      input: { path: { queryId: options.input.path?.queryId } },
    });
  }
  try {
    const response = await options.client.request({
      sellingPartnerId: options.sellingPartnerId,
      tenantId: options.tenantId,
      region: options.region,
      operation: options.operation.operationId,
      method: options.operation.method,
      path: operationPath(options.operation, options.input.path ?? {}, options.sellingPartnerId),
      query: options.input.query,
      body: options.input.body,
      retryMode: options.operation.retry === "idempotent" ? "safe" : "never",
    });
    options.capabilities?.set(options.tenantId, options.accountId, options.operation.operationId, "available");
    const policyResponse = enforceResponsePolicy(options.operation, response);
    if (options.internalDocumentJob) return policyResponse;
    return projectResponse(
      policyResponse,
      options.operation.responseSchema,
      definitionsFor(options.operation.modelId),
    );
  } catch (error) {
    if (error instanceof SpApiError && error.status === 403) {
      options.capabilities?.set(options.tenantId, options.accountId, options.operation.operationId, "permission_required");
      throw new AmazonMcpError(
        "AMAZON_ROLE_REQUIRED",
        `Amazon role required for ${options.operation.operationId}`,
        false,
        { operation: options.operation.operationId, role: options.operation.roles.join(" | ") },
      );
    }
    throw error;
  }
}
