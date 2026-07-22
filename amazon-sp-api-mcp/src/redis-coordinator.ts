import { createHash, randomBytes } from "node:crypto";

import { createClient } from "redis";

import { AmazonMcpError } from "./errors.js";

export interface SharedAccessToken {
  accessToken: string;
  expiresAt: number;
}

export interface AccessTokenCoordinator {
  get(key: string): Promise<SharedAccessToken | undefined>;
  set(key: string, token: SharedAccessToken): Promise<void>;
  delete(key: string): Promise<void>;
  runWithLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  checkHealth(): Promise<"ok" | "error">;
  close(): Promise<void>;
}

type RedisClient = ReturnType<typeof createClient>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RedisAccessTokenCoordinator implements AccessTokenCoordinator {
  readonly #client: RedisClient;
  readonly #namespace: string;
  readonly #ownsClient: boolean;
  readonly #lockTtlMs: number;
  readonly #lockWaitMs: number;
  #connecting?: Promise<void>;

  constructor(options: {
    redisUrl?: string;
    client?: RedisClient;
    namespace?: string;
    lockTtlMs?: number;
    lockWaitMs?: number;
  }) {
    if (!options.client && !options.redisUrl) {
      throw new Error("redisUrl or client is required");
    }
    this.#client = options.client ?? createClient({ url: options.redisUrl });
    this.#client.on("error", () => {});
    this.#namespace = options.namespace ?? "amazon-sp-api";
    this.#ownsClient = !options.client;
    this.#lockTtlMs = options.lockTtlMs ?? 20_000;
    this.#lockWaitMs = options.lockWaitMs ?? 25_000;
  }

  async get(key: string): Promise<SharedAccessToken | undefined> {
    await this.#connect();
    const raw = await this.#client.get(this.#key("access", key));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<SharedAccessToken>;
      if (
        typeof value.accessToken !== "string" ||
        typeof value.expiresAt !== "number" ||
        value.expiresAt <= Date.now()
      ) {
        await this.delete(key);
        return undefined;
      }
      return { accessToken: value.accessToken, expiresAt: value.expiresAt };
    } catch {
      await this.delete(key);
      return undefined;
    }
  }

  async set(key: string, token: SharedAccessToken): Promise<void> {
    await this.#connect();
    const ttl = Math.max(1, token.expiresAt - Date.now());
    await this.#client.set(this.#key("access", key), JSON.stringify(token), { PX: ttl });
  }

  async delete(key: string): Promise<void> {
    await this.#connect();
    await this.#client.del(this.#key("access", key));
  }

  async runWithLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    await this.#connect();
    const lockKey = this.#key("lock", key);
    const owner = randomBytes(18).toString("base64url");
    const deadline = Date.now() + this.#lockWaitMs;
    while (await this.#client.set(lockKey, owner, { NX: true, PX: this.#lockTtlMs }) !== "OK") {
      if (Date.now() >= deadline) {
        throw new AmazonMcpError(
          "UPSTREAM_LWA",
          "Timed out waiting for the shared LWA refresh lock",
          true,
        );
      }
      await sleep(40 + Math.floor(Math.random() * 30));
    }
    try {
      return await operation();
    } finally {
      await this.#client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys: [lockKey], arguments: [owner] },
      );
    }
  }

  async checkHealth(): Promise<"ok" | "error"> {
    try {
      await this.#connect();
      return await this.#client.ping() === "PONG" ? "ok" : "error";
    } catch {
      return "error";
    }
  }

  async close(): Promise<void> {
    if (this.#ownsClient && this.#client.isOpen) await this.#client.close();
  }

  #key(kind: "access" | "lock", value: string): string {
    const digest = createHash("sha256").update(value).digest("base64url");
    return `${this.#namespace}:${kind}:${digest}`;
  }

  async #connect(): Promise<void> {
    if (this.#client.isReady) return;
    if (!this.#connecting) {
      this.#connecting = this.#client.connect().then(() => undefined);
    }
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }
}
