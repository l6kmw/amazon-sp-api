import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { NULL_LOGGER, type StructuredLogger } from "./logger.js";

export const MCP_ARGUMENT_LOG_RETENTION_MS = 168 * 60 * 60 * 1_000;
export const MCP_ARGUMENT_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

const LOG_FILE_PATTERN = /^mcp-arguments-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

export interface McpArgumentLogInput {
  requestId: string;
  tool: string;
  actorType: "employee_jwt" | "test_agent" | "unknown";
  actorIdHash?: string;
  argumentsPresent: boolean;
  arguments: unknown;
}

export interface McpArgumentLogger {
  log(input: McpArgumentLogInput): Promise<void>;
  close(): Promise<void>;
}

export const NULL_MCP_ARGUMENT_LOGGER: McpArgumentLogger = {
  async log() {},
  async close() {},
};

function hourKey(date: Date): string {
  return date.toISOString().slice(0, 13);
}

function logFileTime(name: string): number | undefined {
  const key = LOG_FILE_PATTERN.exec(name)?.[1];
  if (!key) return undefined;
  const timestamp = Date.parse(`${key}:00:00.000Z`);
  if (!Number.isFinite(timestamp) || hourKey(new Date(timestamp)) !== key) return undefined;
  return timestamp;
}

export class McpArgumentFileLogger implements McpArgumentLogger {
  readonly #directory: string;
  readonly #logger: StructuredLogger;
  readonly #now: () => Date;
  readonly #cleanupIntervalMs: number;
  #queue: Promise<void> = Promise.resolve();
  #timer?: NodeJS.Timeout;
  #initialized = false;
  #closed = false;

  constructor(options: {
    directory: string;
    logger?: StructuredLogger;
    now?: () => Date;
    cleanupIntervalMs?: number;
  }) {
    this.#directory = options.directory;
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#now = options.now ?? (() => new Date());
    this.#cleanupIntervalMs = options.cleanupIntervalMs
      ?? MCP_ARGUMENT_LOG_CLEANUP_INTERVAL_MS;
  }

  async initialize(): Promise<void> {
    if (this.#initialized || this.#closed) return;
    this.#initialized = true;
    await this.#enqueue(() => this.#cleanupSafely());
    if (this.#closed) return;
    this.#timer = setInterval(() => {
      if (!this.#closed) void this.#enqueue(() => this.#cleanupSafely());
    }, this.#cleanupIntervalMs);
    this.#timer.unref();
  }

  async log(input: McpArgumentLogInput): Promise<void> {
    if (this.#closed) return;
    await this.#enqueue(async () => {
      try {
        await this.#write(input);
      } catch {
        this.#reportFailure(input);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#queue;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.#queue.then(operation);
    this.#queue = pending.catch(() => undefined);
    return pending;
  }

  async #ensureDirectory(): Promise<void> {
    const parent = path.dirname(this.#directory);
    const dataDirectory = path.dirname(parent);
    const dataMetadata = await lstat(dataDirectory);
    if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) {
      throw new Error("MCP argument log data path must be a real directory");
    }
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error("MCP argument log parent must be a real directory");
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("MCP argument log path must be a real directory");
    }
    await chmod(this.#directory, 0o700);
  }

  async #write(input: McpArgumentLogInput): Promise<void> {
    await this.#ensureDirectory();
    const now = this.#now();
    const serializedArguments = input.argumentsPresent
      ? JSON.stringify(input.arguments)
      : undefined;
    const entry = {
      timestamp: now.toISOString(),
      event: "mcp.tool.arguments.received",
      request_id: input.requestId,
      tool: input.tool,
      actor_type: input.actorType,
      ...(input.actorIdHash ? { actor_id_hash: input.actorIdHash } : {}),
      arguments_present: input.argumentsPresent,
      arguments_bytes: serializedArguments === undefined
        ? 0
        : Buffer.byteLength(serializedArguments, "utf8"),
      ...(input.argumentsPresent ? { arguments: input.arguments } : {}),
    };
    const file = path.join(
      this.#directory,
      `mcp-arguments-${hourKey(now)}.jsonl`,
    );
    const handle = await open(
      file,
      constants.O_APPEND
        | constants.O_CREAT
        | constants.O_WRONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error("MCP argument log file must be a single-link regular file");
      }
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  async #cleanupSafely(): Promise<void> {
    try {
      await this.#cleanup();
    } catch {
      this.#reportFailure();
    }
  }

  async #cleanup(): Promise<void> {
    await this.#ensureDirectory();
    const cutoff = this.#now().getTime() - MCP_ARGUMENT_LOG_RETENTION_MS;
    const entries = await readdir(this.#directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || logFileTime(entry.name) === undefined) continue;
      const file = path.join(this.#directory, entry.name);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const createdAt = metadata.birthtimeMs > 0
        ? metadata.birthtimeMs
        : metadata.ctimeMs;
      if (createdAt >= cutoff) continue;
      await unlink(file);
    }
  }

  #reportFailure(input?: McpArgumentLogInput): void {
    this.#logger.write("error", "mcp.argument_log.failed", {
      ...(input ? {
        request_id: input.requestId,
        tool: input.tool,
        actor_type: input.actorType,
        actor_id_hash: input.actorIdHash,
      } : {}),
      result: "error",
      error_code: "internal_error",
    });
  }
}
