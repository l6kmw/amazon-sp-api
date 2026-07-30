// @ts-nocheck -- build-time generator for the frozen Amazon Swagger models.
import { execFileSync } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

const FROZEN_COMMIT = "6ad2ee14835a9aa31889ae5607ea4e1fcc90f3ad";
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error("usage: bun scripts/generate-sp-api-registry.ts <selling-partner-api-models checkout>");

const repositoryRoot = process.cwd();
const vendorDirectory = join(repositoryRoot, "vendor", "amazon-sp-api-models");
const generatedDirectory = join(repositoryRoot, "src", "generated");

const DOMAIN_BY_FAMILY = new Map([
  ["sellers-api-model", "seller"],
  ["catalog-items-api-model", "catalog"],
  ["product-type-definitions-api-model", "catalog"],
  ["vehicles-api-model", "catalog"],
  ["listings-items-api-model", "listings"],
  ["listings-restrictions-api-model", "listings"],
  ["orders-api-model", "orders"],
  ["fba-inventory-api-model", "inventory"],
  ["supply-sources-api-model", "inventory"],
  ["product-fees-api-model", "pricing"],
  ["product-pricing-api-model", "pricing"],
  ["sales-api-model", "analytics"],
  ["customer-feedback-api-model", "analytics"],
  ["replenishment-api-model", "analytics"],
  ["finances-api-model", "finances"],
  ["seller-wallet-api-model", "finances"],
  ["amazon-warehousing-and-distribution-model", "warehousing"],
  ["fba-inbound-eligibility-api-model", "fulfillment"],
  ["fulfillment-inbound-api-model", "fulfillment"],
  ["fulfillment-outbound-api-model", "fulfillment"],
  ["shipping-api-model", "shipping"],
  ["merchant-fulfillment-api-model", "shipping"],
  ["services-api-model", "services"],
  ["aplus-content-api-model", "content"],
  ["reports-api-model", "reports"],
  ["data-kiosk-api-model", "data_kiosk"],
  ["feeds-api-model", "feeds"],
  ["notifications-api-model", "integrations"],
  ["application-integrations-api-model", "integrations"],
]);

// Normalized from Amazon's operation role mapping on 2026-07-28. Only
// non-restricted Seller alternatives are retained; type-dependent APIs are
// narrowed again by the runtime report/feed/notification allowlists.
const ROLES_BY_FAMILY = new Map([
  ["catalog-items-api-model", ["Product Listing"]],
  ["product-type-definitions-api-model", ["Inventory and Order Tracking", "Product Listing"]],
  ["vehicles-api-model", ["Product Listing"]],
  ["listings-items-api-model", ["Inventory and Order Tracking", "Product Listing"]],
  ["listings-restrictions-api-model", ["Product Listing"]],
  ["orders-api-model", ["Inventory and Order Tracking"]],
  ["fba-inventory-api-model", ["Amazon Fulfillment", "Product Listing"]],
  ["supply-sources-api-model", ["Selling Partner Insights"]],
  ["product-fees-api-model", ["Pricing", "Product Listing"]],
  ["product-pricing-api-model", ["Pricing", "Product Listing"]],
  ["sales-api-model", ["Inventory and Order Tracking", "Product Listing"]],
  ["customer-feedback-api-model", ["Brand Analytics", "Selling Partner Insights"]],
  ["replenishment-api-model", ["Brand Analytics", "Inventory and Order Tracking"]],
  ["finances-api-model", ["Finance and Accounting"]],
  ["amazon-warehousing-and-distribution-model", ["Amazon Warehousing and Distribution"]],
  ["fba-inbound-eligibility-api-model", ["Amazon Fulfillment"]],
  ["fulfillment-inbound-api-model", ["Amazon Fulfillment"]],
  ["aplus-content-api-model", ["Brand Analytics", "Product Listing"]],
  ["reports-api-model", ["Reports; role depends on report type"]],
  ["data-kiosk-api-model", ["Brand Analytics"]],
  ["feeds-api-model", ["Feeds; role depends on feed type"]],
  ["notifications-api-model", ["Notifications; role depends on notification type"]],
]);

function rolesFor(operation) {
  if (operation.family === "sellers-api-model") {
    return operation.operationId === "getAccount"
      ? ["Finance and Accounting"]
      : ["Product Listing", "Selling Partner Insights"];
  }
  return ROLES_BY_FAMILY.get(operation.family) ?? [];
}

function regionsFor(operation) {
  if (
    (operation.family === "sellers-api-model" && operation.operationId === "getAccount") ||
    operation.family === "vehicles-api-model"
  ) return ["eu"];
  return ["na", "eu", "fe"];
}

const EXCLUDED_FAMILIES = new Map([
  ["application-management-api-model", "application_control_plane"],
  ["delivery-by-amazon", "restricted_role"],
  ["easy-ship-model", "restricted_role"],
  ["external-fulfillment", "restricted_role"],
  ["fulfillment-outbound-api-model", "binary_or_pii"],
  ["invoices-api-model", "restricted_role"],
  ["merchant-fulfillment-api-model", "binary_or_pii"],
  ["messaging-api-model", "binary_or_pii"],
  ["services-api-model", "restricted_role"],
  ["shipment-invoicing-api-model", "restricted_role"],
  ["shipping-api-model", "restricted_role"],
  ["solicitations-api-model", "business_state_change"],
  ["tokens-api-model", "restricted_data_token"],
  ["uploads-api-model", "binary_or_pii"],
]);

const DEPRECATED_MODELS = new Set([
  "catalog-items-api-model/catalogItemsV0",
  "catalog-items-api-model/catalogItems_2020-12-01",
  "finances-api-model/financesV0",
  "listings-items-api-model/listingsItems_2020-09-01",
  "orders-api-model/ordersV0",
]);

const NON_SELLER_MODELS = new Set([
  "seller-wallet-api-model/sellerWallet_2024-03-01",
  "finances-api-model/transfers_2024-06-01",
]);

const SAFE_QUERY_OPERATIONS = new Set([
  "checkInboundEligibility",
  "validateContentDocumentAsinRelations",
  "getMyFeesEstimateForSKU",
  "getMyFeesEstimateForASIN",
  "getMyFeesEstimates",
  "getItemOffersBatch",
  "getListingOffersBatch",
  "getFeaturedOfferExpectedPriceBatch",
  "getCompetitiveSummary",
  "getSellingPartnerMetrics",
  "listOfferMetrics",
  "listOffers",
  "createQuery",
  "cancelQuery",
  "createReport",
  "cancelReport",
]);

const NON_RETRYABLE_CREATE = new Set(["createQuery", "createReport"]);
const GRANTLESS_NOTIFICATION_OPERATIONS = new Set([
  "getDestination",
  "getDestinations",
  "getSubscriptionById",
]);
const BINARY_OPERATIONS = /(?:Labels?|BillOfLading|DeliveryChallanDocument|Invoice|DocumentUpload|ShipmentDocuments|CollectionForm)$/i;

function classify(operation) {
  const domain = DOMAIN_BY_FAMILY.get(operation.family) ?? "excluded";
  const modelKey = `${operation.family}/${operation.model}`;
  if (operation.family.startsWith("vendor-")) {
    return { domain, included: false, reason: "vendor_only" };
  }
  const familyReason = EXCLUDED_FAMILIES.get(operation.family);
  if (familyReason) return { domain, included: false, reason: familyReason };
  if (DEPRECATED_MODELS.has(modelKey)) {
    return { domain, included: false, reason: "deprecated_or_replaced_version" };
  }
  if (NON_SELLER_MODELS.has(modelKey)) {
    return { domain, included: false, reason: "non_seller_financial_provider_role" };
  }
  if (operation.family === "notifications-api-model" && GRANTLESS_NOTIFICATION_OPERATIONS.has(operation.operationId)) {
    return { domain, included: false, reason: "grantless_application_control_plane" };
  }
  if (operation.operationId.includes("ReportSchedule")) {
    return { domain, included: false, reason: "report_schedule_control_plane" };
  }
  if (BINARY_OPERATIONS.test(operation.operationId)) {
    return { domain, included: false, reason: "binary_document" };
  }
  if (operation.method === "get") return { domain, included: true, reason: "seller_read" };
  if (SAFE_QUERY_OPERATIONS.has(operation.operationId)) {
    return { domain, included: true, reason: "allowlisted_read_workflow" };
  }
  return { domain, included: false, reason: "changes_business_or_control_state" };
}

function stripSchema(value) {
  if (Array.isArray(value)) return value.map(stripSchema);
  if (!value || typeof value !== "object") return value;
  const kept = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("x-") || ["description", "title", "example", "examples", "xml"].includes(key)) continue;
    kept[key] = stripSchema(item);
  }
  return kept;
}

function resolveLocalReference(document, value) {
  if (!value?.$ref?.startsWith("#/")) return value;
  return value.$ref.slice(2).split("/").reduce((current, part) => current?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

function operationParameters(document, pathItem, operation) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => resolveLocalReference(document, parameter));
  const result = { path: [], query: [], body: undefined };
  for (const parameter of parameters) {
    if (!parameter || parameter.in === "header") continue;
    if (parameter.in === "body") {
      result.body = { required: Boolean(parameter.required), schema: stripSchema(parameter.schema ?? {}) };
      continue;
    }
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const schema = stripSchema({ ...parameter });
    delete schema.name;
    delete schema.in;
    delete schema.required;
    result[parameter.in].push({
      name: parameter.name,
      required: Boolean(parameter.required),
      schema,
    });
  }
  return result;
}

function successResponseSchema(document, operation) {
  const code = Object.keys(operation.responses ?? {}).filter((value) => /^2\d\d$/.test(value)).sort()[0];
  if (!code) return {};
  const response = resolveLocalReference(document, operation.responses[code]);
  return stripSchema(response?.schema ?? {});
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

const head = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== FROZEN_COMMIT) throw new Error(`model checkout must be ${FROZEN_COMMIT}; received ${head}`);

const operations = [];
const documents = new Map();
for (const file of (await filesBelow(join(sourceRoot, "models"))).sort()) {
  const document = JSON.parse(await readFile(file, "utf8"));
  const family = basename(dirname(file));
  const model = basename(file, ".json");
  const modelId = `${family}/${model}`;
  documents.set(modelId, document);
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "delete", "patch"]) {
      const definition = pathItem[method];
      if (!definition?.operationId) continue;
      const base = {
        modelId,
        family,
        model,
        version: document.info?.version ?? model,
        operationId: definition.operationId,
        method,
        path,
      };
      const policy = classify(base);
      operations.push({
        ...base,
        ...policy,
        roles: rolesFor(base),
        regions: regionsFor(base),
        dataClassification: policy.included ? "non_restricted_confidential" : "excluded",
        retry: policy.included
          ? NON_RETRYABLE_CREATE.has(base.operationId) ? "never_on_uncertain_failure" : "idempotent"
          : "not_applicable",
      });
    }
  }
}

operations.sort((left, right) =>
  `${left.modelId}\0${left.operationId}\0${left.method}\0${left.path}`
    .localeCompare(`${right.modelId}\0${right.operationId}\0${right.method}\0${right.path}`),
);
if (operations.length !== 353) throw new Error(`expected 353 frozen operations, found ${operations.length}`);

const actionCounts = new Map();
for (const operation of operations.filter((item) => item.included)) {
  const key = `${operation.domain}:${operation.operationId}`;
  actionCounts.set(key, (actionCounts.get(key) ?? 0) + 1);
}

const runtimeOperations = operations.filter((item) => item.included).map((item) => {
  const document = documents.get(item.modelId);
  const pathItem = document.paths[item.path];
  const definition = pathItem[item.method];
  const duplicate = actionCounts.get(`${item.domain}:${item.operationId}`) > 1;
  const suffix = item.model.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return {
    action: duplicate ? `${item.operationId}_${suffix}` : item.operationId,
    domain: item.domain,
    operationId: item.operationId,
    modelId: item.modelId,
    version: item.version,
    method: item.method.toUpperCase(),
    path: item.path,
    roles: item.roles,
    regions: item.regions,
    retry: item.retry,
    parameters: operationParameters(document, pathItem, definition),
    responseSchema: successResponseSchema(document, definition),
  };
});

const includedModelIds = new Set(runtimeOperations.map((item) => item.modelId));
const modelSchemas = Object.fromEntries([...includedModelIds].sort().map((modelId) => {
  const document = documents.get(modelId);
  return [modelId, stripSchema(document.definitions ?? document.components?.schemas ?? {})];
}));
const dataKioskSchemas = Object.fromEntries(await Promise.all([
  "analytics_economics_2024_03_15",
  "analytics_salesAndTraffic_2024_04_24",
].map(async (schema) => [
  schema,
  await readFile(join(sourceRoot, "schemas", "data-kiosk", `${schema}.graphql`), "utf8"),
])));

await mkdir(vendorDirectory, { recursive: true });
await mkdir(generatedDirectory, { recursive: true });
await writeFile(join(vendorDirectory, "operations.json"), `${JSON.stringify({
  source: "https://github.com/amzn/selling-partner-api-models",
  commit: FROZEN_COMMIT,
  operationCount: operations.length,
  includedCount: runtimeOperations.length,
  operations,
}, null, 2)}\n`);
await writeFile(join(vendorDirectory, "SOURCE.md"), `# Amazon SP-API model snapshot\n\n- Source: https://github.com/amzn/selling-partner-api-models\n- Commit: \`${FROZEN_COMMIT}\`\n- Normalization: \`bun scripts/generate-sp-api-registry.ts <checkout>\`\n- Coverage: ${operations.length} operations; ${runtimeOperations.length} included by the read-only Seller policy.\n\nThe runtime image uses only the generated operation registry and normalized schema subset.\n`);
await copyFile(join(sourceRoot, "LICENSE"), join(vendorDirectory, "LICENSE"));
await copyFile(join(sourceRoot, "NOTICE"), join(vendorDirectory, "NOTICE"));
await writeFile(join(generatedDirectory, "sp-api-registry.ts"), `// Generated from amzn/selling-partner-api-models ${FROZEN_COMMIT}. Do not edit.\nexport const SP_API_MODEL_COMMIT = ${JSON.stringify(FROZEN_COMMIT)} as const;\nexport const SP_API_OPERATIONS = ${JSON.stringify(runtimeOperations)} as const;\nexport const SP_API_MODEL_SCHEMAS = ${JSON.stringify(modelSchemas)} as const;\n`);
await appendFile(
  join(generatedDirectory, "sp-api-registry.ts"),
  `export const SP_API_DATA_KIOSK_SCHEMAS = ${JSON.stringify(dataKioskSchemas)} as const;\n`,
);

console.log(`generated ${runtimeOperations.length} included operations from ${operations.length} classified operations`);
