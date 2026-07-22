import { createHash, randomBytes } from "node:crypto";

import { createClient } from "redis";

function digest(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export class RedisStateStore {
  constructor(options) {
    if (!options.client && !options.redisUrl) throw new Error("redisUrl or client is required");
    this.client = options.client || createClient({ url: options.redisUrl });
    this.client.on("error", () => {});
    this.namespace = options.namespace;
    this.ttlMs = options.ttlMs || 10 * 60 * 1000;
    this.ownsClient = !options.client;
    this.connecting = null;
  }

  async initialize() {
    await this.connect();
  }

  async create(record) {
    await this.connect();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = randomBytes(32).toString("base64url");
      const stored = await this.client.set(
        this.key(id),
        JSON.stringify(record),
        { NX: true, PX: this.ttlMs },
      );
      if (stored === "OK") return id;
    }
    throw new Error("could not allocate a unique OAuth state");
  }

  async get(value) {
    await this.connect();
    const raw = await this.client.get(this.key(value));
    return raw ? JSON.parse(raw) : null;
  }

  async delete(value) {
    await this.connect();
    await this.client.del(this.key(value));
  }

  async consume(value, accepts = () => true) {
    await this.connect();
    const key = this.key(value);
    const raw = await this.client.get(key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!accepts(record)) return null;
    const consumed = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); return ARGV[1] else return false end",
      { keys: [key], arguments: [raw] },
    );
    return consumed ? record : null;
  }

  async checkHealth() {
    try {
      await this.connect();
      return await this.client.ping() === "PONG";
    } catch {
      return false;
    }
  }

  async close() {
    if (this.ownsClient && this.client.isOpen) await this.client.close();
  }

  key(value) {
    return `${this.namespace}:${digest(value)}`;
  }

  async connect() {
    if (this.client.isReady) return;
    if (!this.connecting) this.connecting = this.client.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
}
