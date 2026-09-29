import { SP_API_OPERATIONS } from "./generated/sp-api-registry.js";

/**
 * Low-cardinality Prometheus-text metrics for Amazon ConnectedAccount MCP.
 * Labels are allowlisted and unknown values collapse to "unknown".
 */

export type MetricLabels = Record<string, string>;

const MAX_LABEL_KEYS = 6;
const MAX_LABEL_VALUE_LEN = 64;
const MAX_SERIES = 2_000;

const TOOL = /^[A-Za-z0-9_]{1,64}$/;
const ERROR_CODES = new Set([
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
  "protocol_error",
  "unknown",
]);
const ACTOR = new Set(["employee_jwt", "test_agent", "unknown"]);
const RESULT = new Set(["success", "error", "rejected"]);
const OPERATION = new Set([
  "marketplace_participations",
  "search_orders",
  "get_order",
  "inventory_summaries",
  "search_listings",
  "get_listing_item",
  ...SP_API_OPERATIONS.map((operation) => operation.operationId),
  "unknown",
]);
const DEPENDENCY = new Set([
  "postgres",
  "redis",
  "oauth",
  "encryption_key",
  "token_store",
  "unknown",
]);
const KEY_CLASS = new Set(["current", "legacy", "unknown"]);
const ALLOWED_LABEL_KEYS = new Set([
  "tool",
  "error_code",
  "actor_type",
  "result",
  "operation",
  "dependency",
  "key_class",
  "kid",
  "le",
]);

/** Frozen latency buckets in seconds for tool and SP-API histograms. */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

function normalizeLabelValue(key: string, value: string): string | null {
  const trimmed = value.trim().slice(0, MAX_LABEL_VALUE_LEN);
  if (!trimmed) return "unknown";
  switch (key) {
    case "tool":
      return TOOL.test(trimmed) ? trimmed : "unknown";
    case "error_code":
      return ERROR_CODES.has(trimmed) ? trimmed : "unknown";
    case "actor_type":
      return ACTOR.has(trimmed) ? trimmed : "unknown";
    case "result":
      return RESULT.has(trimmed) ? trimmed : "unknown";
    case "operation":
      return OPERATION.has(trimmed) ? trimmed : "unknown";
    case "dependency":
      return DEPENDENCY.has(trimmed) ? trimmed : "unknown";
    case "key_class":
      return KEY_CLASS.has(trimmed) ? trimmed : "unknown";
    case "kid":
      return /^[A-Za-z0-9._:-]{1,32}$/.test(trimmed) ? trimmed : "unknown";
    case "le":
      return trimmed;
    default:
      return null;
  }
}

function seriesKey(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`);
  return `${name}|${parts.join(",")}`;
}

function sanitizeLabels(labels: MetricLabels): MetricLabels | null {
  const keys = Object.keys(labels);
  if (keys.length > MAX_LABEL_KEYS) return null;
  const out: MetricLabels = {};
  for (const key of keys.sort()) {
    if (!ALLOWED_LABEL_KEYS.has(key)) continue;
    const normalized = normalizeLabelValue(key, labels[key] ?? "unknown");
    if (normalized === null) continue;
    out[key] = normalized;
  }
  return out;
}

export class MetricsRegistry {
  readonly #counters = new Map<string, { help: string; samples: Map<string, { labels: MetricLabels; value: number }> }>();
  readonly #gauges = new Map<string, { help: string; samples: Map<string, { labels: MetricLabels; value: number }> }>();
  readonly #histograms = new Map<string, {
    help: string;
    buckets: readonly number[];
    samples: Map<string, { labels: MetricLabels; counts: number[]; sum: number; count: number }>;
  }>();
  #series = 0;

  constructor(readonly prefix = "amazon_connected_account_") {}

  #ensureCounter(name: string, help: string) {
    const full = this.prefix + name;
    let entry = this.#counters.get(full);
    if (!entry) {
      entry = { help, samples: new Map() };
      this.#counters.set(full, entry);
    }
    return entry;
  }

  #ensureGauge(name: string, help: string) {
    const full = this.prefix + name;
    let entry = this.#gauges.get(full);
    if (!entry) {
      entry = { help, samples: new Map() };
      this.#gauges.set(full, entry);
    }
    return entry;
  }

  #ensureHistogram(name: string, help: string, buckets: readonly number[]) {
    const full = this.prefix + name;
    let entry = this.#histograms.get(full);
    if (!entry) {
      entry = { help, buckets, samples: new Map() };
      this.#histograms.set(full, entry);
    }
    return entry;
  }

  #takeSeries(key: string, exists: boolean): boolean {
    if (exists) return true;
    if (this.#series >= MAX_SERIES) return false;
    this.#series += 1;
    return true;
  }

  inc(name: string, help: string, labels: MetricLabels = {}, amount = 1): void {
    const safe = sanitizeLabels(labels);
    if (!safe || amount < 0 || !Number.isFinite(amount)) return;
    const entry = this.#ensureCounter(name, help);
    const key = seriesKey(name, safe);
    const existing = entry.samples.get(key);
    if (!this.#takeSeries(key, Boolean(existing))) return;
    entry.samples.set(key, {
      labels: safe,
      value: (existing?.value ?? 0) + amount,
    });
  }

  setGauge(name: string, help: string, value: number, labels: MetricLabels = {}): void {
    const safe = sanitizeLabels(labels);
    if (!safe || !Number.isFinite(value)) return;
    const entry = this.#ensureGauge(name, help);
    const key = seriesKey(name, safe);
    const existing = entry.samples.get(key);
    if (!this.#takeSeries(key, Boolean(existing))) return;
    entry.samples.set(key, { labels: safe, value });
  }

  observeSeconds(
    name: string,
    help: string,
    seconds: number,
    labels: MetricLabels = {},
    buckets: readonly number[] = LATENCY_BUCKETS_SECONDS,
  ): void {
    const safe = sanitizeLabels(labels);
    if (!safe || !Number.isFinite(seconds) || seconds < 0) return;
    const entry = this.#ensureHistogram(name, help, buckets);
    const key = seriesKey(name, safe);
    let sample = entry.samples.get(key);
    if (!sample) {
      if (!this.#takeSeries(key, false)) return;
      sample = {
        labels: safe,
        counts: buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      entry.samples.set(key, sample);
    }
    for (let i = 0; i < buckets.length; i += 1) {
      if (seconds <= buckets[i]!) {
        sample.counts[i] = (sample.counts[i] ?? 0) + 1;
      }
    }
    sample.sum += seconds;
    sample.count += 1;
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, entry] of this.#counters) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const sample of entry.samples.values()) {
        lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
    for (const [name, entry] of this.#gauges) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const sample of entry.samples.values()) {
        lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
    for (const [name, entry] of this.#histograms) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const sample of entry.samples.values()) {
        // counts[i] already = observations with value <= buckets[i]
        for (let i = 0; i < entry.buckets.length; i += 1) {
          lines.push(
            `${name}_bucket${formatLabels({ ...sample.labels, le: String(entry.buckets[i]) })} ${sample.counts[i] ?? 0}`,
          );
        }
        lines.push(`${name}_bucket${formatLabels({ ...sample.labels, le: "+Inf" })} ${sample.count}`);
        lines.push(`${name}_sum${formatLabels(sample.labels)} ${sample.sum}`);
        lines.push(`${name}_count${formatLabels(sample.labels)} ${sample.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

function formatLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  return `{${keys.map((key) => `${key}="${escapeLabel(labels[key]!)}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const mcpMetrics = new MetricsRegistry();
