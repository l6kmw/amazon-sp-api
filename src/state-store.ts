import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ExpiringRecord {
  expiresAt?: number;
}

export interface ExpiringStore<T extends ExpiringRecord = ExpiringRecord> {
  initialize(): Promise<void>;
  create(record: Omit<T, "expiresAt">): Promise<string>;
  get(value: string): Promise<T | null>;
  delete(value: string): Promise<void>;
  consume(value: string, accepts?: (record: T) => boolean): Promise<T | null>;
  checkHealth(): Promise<"ok" | "error">;
  close(): Promise<void>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export class FileExpiringStore<T extends ExpiringRecord = ExpiringRecord>
implements ExpiringStore<T> {
  readonly #file: string;
  readonly #ttlMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, ttlMs = 10 * 60_000) {
    this.#file = file;
    this.#ttlMs = ttlMs;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
  }

  create(record: Omit<T, "expiresAt">): Promise<string> {
    return this.#run(async () => {
      const now = Date.now();
      const records = await readJson<Record<string, T>>(this.#file, {});
      for (const [key, value] of Object.entries(records)) {
        if ((value.expiresAt ?? 0) <= now) delete records[key];
      }
      const id = randomBytes(32).toString("base64url");
      records[digest(id)] = { ...record, expiresAt: now + this.#ttlMs } as T;
      await writeJson(this.#file, records);
      return id;
    });
  }

  get(value: string): Promise<T | null> {
    return this.#run(async () => {
      const records = await readJson<Record<string, T>>(this.#file, {});
      const key = digest(value);
      const record = records[key] ?? records[value];
      if (!record) return null;
      if ((record.expiresAt ?? 0) <= Date.now()) {
        delete records[key];
        delete records[value];
        await writeJson(this.#file, records);
        return null;
      }
      return record;
    });
  }

  delete(value: string): Promise<void> {
    return this.#run(async () => {
      const records = await readJson<Record<string, T>>(this.#file, {});
      delete records[digest(value)];
      delete records[value];
      await writeJson(this.#file, records);
    });
  }

  consume(value: string, accepts: (record: T) => boolean = () => true): Promise<T | null> {
    return this.#run(async () => {
      const records = await readJson<Record<string, T>>(this.#file, {});
      const key = digest(value);
      const record = records[key] ?? records[value];
      if (!record || (record.expiresAt ?? 0) <= Date.now()) {
        if (record) {
          delete records[key];
          delete records[value];
          await writeJson(this.#file, records);
        }
        return null;
      }
      if (!accepts(record)) return null;
      delete records[key];
      delete records[value];
      await writeJson(this.#file, records);
      return record;
    });
  }

  async checkHealth(): Promise<"ok" | "error"> {
    try {
      await this.#run(() => readJson(this.#file, {}));
      return "ok";
    } catch {
      return "error";
    }
  }

  async close(): Promise<void> {}

  #run<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
