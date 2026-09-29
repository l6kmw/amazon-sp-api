import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  link,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { createStructuredLogger } from "../src/logger.js";
import {
  MCP_ARGUMENT_LOG_RETENTION_MS,
  McpArgumentFileLogger,
  type McpArgumentLogInput,
} from "../src/mcp-argument-logger.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLogDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "amazon-mcp-argument-log-"));
  temporaryDirectories.push(root);
  return join(root, "logs", "mcp-arguments");
}

function input(overrides: Partial<McpArgumentLogInput> = {}): McpArgumentLogInput {
  return {
    requestId: "request-12345678",
    tool: "amazon_search_orders",
    actorType: "employee_jwt",
    actorIdHash: "0123456789abcdef",
    argumentsPresent: true,
    arguments: { account_id: "acct_0123456789abcdef" },
    ...overrides,
  };
}

async function readJsonLines(file: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(file, "utf8");
  return contents.trimEnd().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileCreatedAt(file: string): Promise<number> {
  const metadata = await stat(file);
  return metadata.birthtimeMs > 0 ? metadata.birthtimeMs : metadata.ctimeMs;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

test("writes complete arguments and distinguishes explicit null from missing arguments", async () => {
  const directory = await temporaryLogDirectory();
  const now = new Date("2026-08-10T06:15:30.000Z");
  const logger = new McpArgumentFileLogger({ directory, now: () => now });
  await logger.initialize();

  const completeArguments = {
    account_id: "acct_0123456789abcdef",
    filters: { statuses: ["Shipped", "Unshipped"], note: "订单" },
    nextToken: "next-token-value",
  };
  await logger.log(input({ requestId: "request-complete", arguments: completeArguments }));
  await logger.log(input({ requestId: "request-null", arguments: null }));
  await logger.log(input({
    requestId: "request-missing",
    argumentsPresent: false,
    arguments: undefined,
  }));
  await logger.close();

  const records = await readJsonLines(join(directory, "mcp-arguments-2026-08-10T06.jsonl"));
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    timestamp: now.toISOString(),
    event: "mcp.tool.arguments.received",
    request_id: "request-complete",
    tool: "amazon_search_orders",
    actor_type: "employee_jwt",
    actor_id_hash: "0123456789abcdef",
    arguments_present: true,
    arguments_bytes: Buffer.byteLength(JSON.stringify(completeArguments), "utf8"),
    arguments: completeArguments,
  });
  assert.equal(records[1]?.arguments_present, true);
  assert.equal(records[1]?.arguments_bytes, 4);
  assert.equal(records[1]?.arguments, null);
  assert.equal(records[2]?.arguments_present, false);
  assert.equal(records[2]?.arguments_bytes, 0);
  assert.equal(Object.hasOwn(records[2]!, "arguments"), false);
});

test("serializes concurrent writes into complete JSONL records", async () => {
  const directory = await temporaryLogDirectory();
  const now = new Date("2026-08-10T07:00:00.000Z");
  const logger = new McpArgumentFileLogger({ directory, now: () => now });
  await logger.initialize();

  const count = 40;
  await Promise.all(Array.from({ length: count }, (_, index) => logger.log(input({
    requestId: `request-concurrent-${index}`,
    arguments: { index, payload: `value-${index}-${"x".repeat(1_024)}` },
  }))));
  await logger.close();

  const file = join(directory, "mcp-arguments-2026-08-10T07.jsonl");
  const rawLines = (await readFile(file, "utf8")).trimEnd().split("\n");
  assert.equal(rawLines.length, count);
  const records = rawLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    new Set(records.map((record) => record.request_id)),
    new Set(Array.from({ length: count }, (_, index) => `request-concurrent-${index}`)),
  );
  assert.ok(records.every((record) =>
    typeof record.arguments === "object" && record.arguments !== null));
});

test("rotates files on UTC hour boundaries and enforces directory and file permissions", async () => {
  const directory = await temporaryLogDirectory();
  let now = new Date("2026-08-10T23:59:59.999Z");
  const logger = new McpArgumentFileLogger({ directory, now: () => now });
  await logger.initialize();
  await logger.log(input({ requestId: "request-before-hour" }));
  now = new Date("2026-08-11T00:00:00.000Z");
  await logger.log(input({ requestId: "request-after-hour" }));
  await logger.close();

  const first = join(directory, "mcp-arguments-2026-08-10T23.jsonl");
  const second = join(directory, "mcp-arguments-2026-08-11T00.jsonl");
  assert.equal((await readJsonLines(first))[0]?.request_id, "request-before-hour");
  assert.equal((await readJsonLines(second))[0]?.request_id, "request-after-hour");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first)).mode & 0o777, 0o600);
  assert.equal((await stat(second)).mode & 0o777, 0o600);
});

test("rejects a symlinked log parent without writing arguments outside the data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "amazon-mcp-argument-log-symlink-"));
  temporaryDirectories.push(root);
  const redirected = join(root, "redirected");
  const parent = join(root, "logs");
  const directory = join(parent, "mcp-arguments");
  await mkdir(redirected);
  await symlink(redirected, parent, "dir");
  const lines: string[] = [];
  const logger = new McpArgumentFileLogger({
    directory,
    logger: createStructuredLogger({
      hashKey: "mcp-argument-log-symlink-test",
      write(line) { lines.push(line); },
    }),
  });

  await assert.doesNotReject(logger.log(input({ arguments: { secret: "raw-value" } })));
  await logger.close();

  assert.equal(await exists(join(redirected, "mcp-arguments")), false);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /raw-value/u);
});

test("rejects multiply-linked and non-regular hourly log files", async () => {
  const now = new Date("2026-08-10T09:00:00.000Z");
  const hardLinkDirectory = await temporaryLogDirectory();
  await mkdir(hardLinkDirectory, { recursive: true });
  const victim = join(hardLinkDirectory, "operator-record.txt");
  const hardLink = join(hardLinkDirectory, "mcp-arguments-2026-08-10T09.jsonl");
  await writeFile(victim, "operator-owned\n");
  await link(victim, hardLink);
  const hardLinkLogger = new McpArgumentFileLogger({
    directory: hardLinkDirectory,
    now: () => now,
  });

  await assert.doesNotReject(hardLinkLogger.log(input()));
  await hardLinkLogger.close();
  assert.equal(await readFile(victim, "utf8"), "operator-owned\n");

  const fifoDirectory = await temporaryLogDirectory();
  await mkdir(fifoDirectory, { recursive: true });
  const fifo = join(fifoDirectory, "mcp-arguments-2026-08-10T09.jsonl");
  await execFileAsync("mkfifo", [fifo]);
  const reader = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const fifoLines: string[] = [];
  const fifoLogger = new McpArgumentFileLogger({
    directory: fifoDirectory,
    now: () => now,
    logger: createStructuredLogger({
      hashKey: "mcp-argument-log-fifo-test",
      write(line) { fifoLines.push(line); },
    }),
  });
  try {
    await assert.doesNotReject(fifoLogger.log(input()));
  } finally {
    await fifoLogger.close();
    await reader.close();
  }
  assert.equal(fifoLines.length, 1);
  assert.match(fifoLines[0]!, /"event":"mcp\.argument_log\.failed"/u);
  assert.doesNotMatch(fifoLines[0]!, /account_id/u);
});

test("close flushes writes already queued and ignores later writes", async () => {
  const directory = await temporaryLogDirectory();
  const now = new Date("2026-08-10T08:00:00.000Z");
  const logger = new McpArgumentFileLogger({ directory, now: () => now });
  await logger.initialize();

  const pending = logger.log(input({ requestId: "request-before-close" }));
  await logger.close();
  await pending;
  await logger.log(input({ requestId: "request-after-close" }));

  const records = await readJsonLines(join(directory, "mcp-arguments-2026-08-10T08.jsonl"));
  assert.deepEqual(records.map((record) => record.request_id), ["request-before-close"]);
});

test("startup cleanup uses file creation time and preserves the 168-hour boundary and unknown files", async () => {
  const expiredDirectory = await temporaryLogDirectory();
  await mkdir(expiredDirectory, { recursive: true });
  const expired = join(expiredDirectory, "mcp-arguments-2026-08-03T11.jsonl");
  const unknown = join(expiredDirectory, "operator-notes.jsonl");
  await Promise.all([writeFile(expired, "expired\n"), writeFile(unknown, "unknown\n")]);
  const expiredCreatedAt = await fileCreatedAt(expired);
  const expiredLogger = new McpArgumentFileLogger({
    directory: expiredDirectory,
    now: () => new Date(expiredCreatedAt + MCP_ARGUMENT_LOG_RETENTION_MS + 1),
  });
  await expiredLogger.initialize();
  await expiredLogger.close();
  assert.equal(await exists(expired), false);
  assert.equal(await exists(unknown), true);

  const boundaryDirectory = await temporaryLogDirectory();
  await mkdir(boundaryDirectory, { recursive: true });
  const boundary = join(boundaryDirectory, "mcp-arguments-2026-08-03T12.jsonl");
  await writeFile(boundary, "boundary\n");
  const boundaryCreatedAt = await fileCreatedAt(boundary);
  const boundaryLogger = new McpArgumentFileLogger({
    directory: boundaryDirectory,
    now: () => new Date(boundaryCreatedAt + MCP_ARGUMENT_LOG_RETENTION_MS),
  });
  await boundaryLogger.initialize();
  await boundaryLogger.close();
  assert.equal(await exists(boundary), true);
});

test("periodic cleanup runs without request traffic", async () => {
  const directory = await temporaryLogDirectory();
  let now = new Date();
  const logger = new McpArgumentFileLogger({
    directory,
    now: () => now,
    cleanupIntervalMs: 20,
  });
  await logger.initialize();

  const expired = join(directory, "mcp-arguments-2026-08-03T11.jsonl");
  const unknown = join(directory, "do-not-delete.txt");
  await Promise.all([
    writeFile(expired, "expired\n"),
    writeFile(unknown, "unknown\n"),
  ]);
  now = new Date(await fileCreatedAt(expired) + MCP_ARGUMENT_LOG_RETENTION_MS + 1);
  await waitFor(async () => !(await exists(expired)));
  await logger.close();

  assert.equal(await exists(unknown), true);
});

test("write failures do not reject and emit a parameter-free structured failure event", async () => {
  const root = await mkdtemp(join(tmpdir(), "amazon-mcp-argument-log-failure-"));
  temporaryDirectories.push(root);
  const directory = join(root, "not-a-directory");
  await writeFile(directory, "occupied");
  const lines: string[] = [];
  const structuredLogger = createStructuredLogger({
    hashKey: "mcp-argument-log-failure-test",
    write(line) { lines.push(line); },
  });
  const logger = new McpArgumentFileLogger({ directory, logger: structuredLogger });
  const secret = "must-not-appear-in-stdout";

  await assert.doesNotReject(logger.log(input({ arguments: { secret } })));
  await logger.close();

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.event, "mcp.argument_log.failed");
  assert.equal(record.request_id, "request-12345678");
  assert.equal(record.result, "error");
  assert.equal(record.error_code, "internal_error");
  assert.equal(record.tool, "amazon_search_orders");
  assert.equal(record.actor_type, "employee_jwt");
  assert.equal(record.actor_id_hash, "0123456789abcdef");
  assert.doesNotMatch(lines[0]!, /must-not-appear-in-stdout|arguments|account_id/u);
});

test("cleanup failures do not reject and emit a parameter-free structured failure event", async () => {
  const root = await mkdtemp(join(tmpdir(), "amazon-mcp-argument-cleanup-failure-"));
  temporaryDirectories.push(root);
  const directory = join(root, "not-a-directory");
  await writeFile(directory, "occupied");
  const lines: string[] = [];
  const logger = new McpArgumentFileLogger({
    directory,
    logger: createStructuredLogger({
      hashKey: "mcp-argument-cleanup-failure-test",
      write(line) { lines.push(line); },
    }),
  });

  await assert.doesNotReject(logger.initialize());
  await logger.close();

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(record).toSorted(),
    ["error_code", "event", "level", "result", "service", "timestamp"],
  );
  assert.equal(record.event, "mcp.argument_log.failed");
  assert.equal(record.error_code, "internal_error");
});
