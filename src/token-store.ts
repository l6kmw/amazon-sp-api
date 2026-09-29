import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AmazonMcpError } from "./errors.js";
import {
  createKeyring,
  createSingleKeyKeyring,
  decryptSecret as decryptEnvelope,
  encryptSecret as encryptEnvelope,
  parseEncryptionKey as parseKeyMaterial,
  TokenCryptoError,
} from "./token-crypto.js";

export type TokenKeyring = ReturnType<typeof createSingleKeyKeyring>;
export type SecretEnvelope = ReturnType<typeof encryptEnvelope> | {
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
};

/** @deprecated Prefer SecretEnvelope; kept for call-site compatibility. */
export type EncryptedSecret = SecretEnvelope;

export interface StoredToken {
  refreshToken: EncryptedSecret;
  authorizedAt?: string;
  tenantId?: string;
  revision?: number;
  tokenType?: string;
  connectedAccountAttemptId?: string;
}

export type TokenFile = Record<string, StoredToken>;

interface CachedTokenFile {
  signature: string;
  tokens: TokenFile;
}

export interface RefreshTokenCredential {
  refreshToken: string;
  revision: number;
  credentialId?: string;
  credentialOwnerId?: string;
}

export interface RefreshTokenProvider {
  getRefreshToken(sellingPartnerId: string, tenantId: string): Promise<string>;
  getRefreshCredential?(
    sellingPartnerId: string,
    tenantId: string,
  ): Promise<RefreshTokenCredential>;
  compareAndSetRefreshToken?(options: {
    sellingPartnerId: string;
    tenantId: string;
    expectedRevision: number;
    newRefreshToken: string;
  }): Promise<"updated" | "conflict" | "missing">;
}

export interface AmazonConnection {
  sellingPartnerId: string;
  authorizedAt: string;
}

export interface ConnectionStore extends RefreshTokenProvider {
  initialize(): Promise<void>;
  save(
    sellingPartnerId: string,
    tenantId: string,
    tokenResponse: { refresh_token: string; token_type?: string },
    metadata?: { connectedAccountAttemptId?: string },
  ): Promise<void>;
  list(tenantId: string): Promise<AmazonConnection[]>;
  disconnect(tenantId: string, sellingPartnerId: string): Promise<boolean>;
  findConnectedAccountCompletion(tenantId: string, attemptId: string): Promise<AmazonConnection | null>;
  checkHealth(): Promise<"ok" | "error">;
  close(): Promise<void>;
}

export class TokenStoreError extends AmazonMcpError {
  constructor(message: string) {
    super("INTERNAL", message);
    this.name = "TokenStoreError";
  }
}

export class ConnectionConflictError extends Error {
  constructor() {
    super("selling partner is already connected");
    this.name = "ConnectionConflictError";
  }
}

export function parseEncryptionKey(value: string): Buffer {
  try {
    return parseKeyMaterial(value);
  } catch {
    throw new TokenStoreError("Amazon token encryption key must be 32 bytes");
  }
}

export function createTokenKeyringFromConfig(options: {
  encryptionKey?: string;
  currentKeyId?: string;
  keys?: Record<string, string>;
}): TokenKeyring {
  if (options.keys && options.currentKeyId) {
    try {
      return createKeyring({
        currentKeyId: options.currentKeyId,
        keys: options.keys,
      });
    } catch (error) {
      throw new TokenStoreError(
        error instanceof Error ? error.message : "invalid encryption keyring",
      );
    }
  }
  if (!options.encryptionKey) {
    throw new TokenStoreError("encryption key is required");
  }
  try {
    return createSingleKeyKeyring(options.encryptionKey, options.currentKeyId ?? "k0");
  } catch {
    throw new TokenStoreError("Amazon token encryption key must be 32 bytes");
  }
}

export function decryptSecret(
  secret: EncryptedSecret,
  keyOrKeyring: Buffer | TokenKeyring,
  credentialId = "unknown",
): string {
  try {
    const keyring = Buffer.isBuffer(keyOrKeyring)
      ? createKeyring({ currentKeyId: "k0", keys: { k0: keyOrKeyring } })
      : keyOrKeyring;
    return decryptEnvelope(secret, keyring, { credentialId });
  } catch (error) {
    throw new TokenStoreError(
      error instanceof TokenCryptoError
        ? error.message
        : "stored refresh token could not be decrypted",
    );
  }
}

export function encryptSecret(
  plaintext: string,
  keyring: TokenKeyring,
  credentialId: string,
): SecretEnvelope {
  try {
    return encryptEnvelope(plaintext, keyring, { credentialId });
  } catch (error) {
    throw new TokenStoreError(
      error instanceof TokenCryptoError
        ? error.message
        : "refresh token could not be encrypted",
    );
  }
}

export class EncryptedFileTokenStore implements ConnectionStore {
  readonly #file: string;
  readonly #keyring: TokenKeyring;
  readonly #allowedSellingPartnerIds: ReadonlySet<string>;
  #cachedTokenFile?: CachedTokenFile;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    file: string;
    encryptionKey: string;
    allowedSellingPartnerIds: Iterable<string>;
    keyring?: TokenKeyring;
  }) {
    this.#file = options.file;
    this.#keyring = options.keyring ?? createTokenKeyringFromConfig({
      encryptionKey: options.encryptionKey,
    });
    this.#allowedSellingPartnerIds = new Set(options.allowedSellingPartnerIds);
    if (this.#allowedSellingPartnerIds.size === 0) {
      throw new TokenStoreError("at least one selling partner must be allowed");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    try {
      await stat(this.#file);
    } catch {
      await writeFile(this.#file, "{}\n", { mode: 0o600, flag: "wx" }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  }

  async save(
    sellingPartnerId: string,
    tenantId: string,
    tokenResponse: { refresh_token: string; token_type?: string },
    metadata: { connectedAccountAttemptId?: string } = {},
  ): Promise<void> {
    await this.#run(async () => {
      const tokens = await this.#readTokens(false);
      const currentTenantId = tokens[sellingPartnerId]?.tenantId;
      if (currentTenantId && currentTenantId !== tenantId) throw new ConnectionConflictError();
      const previousRevision = tokens[sellingPartnerId]?.revision ?? 0;
      tokens[sellingPartnerId] = {
        authorizedAt: new Date().toISOString(),
        refreshToken: encryptSecret(tokenResponse.refresh_token, this.#keyring, sellingPartnerId),
        tenantId,
        tokenType: tokenResponse.token_type || "bearer",
        revision: previousRevision + 1,
        ...(metadata.connectedAccountAttemptId ? { connectedAccountAttemptId: metadata.connectedAccountAttemptId } : {}),
      };
      await this.#writeTokens(tokens);
    });
  }

  async list(tenantId: string): Promise<AmazonConnection[]> {
    return this.#run(async () => {
      const tokens = await this.#readTokens(false);
      return Object.entries(tokens)
        .filter(([, token]) => token.tenantId === tenantId)
        .map(([sellingPartnerId, token]) => ({
          authorizedAt: token.authorizedAt ?? "",
          sellingPartnerId,
        }))
        .sort((left, right) => left.sellingPartnerId.localeCompare(right.sellingPartnerId));
    });
  }

  async disconnect(tenantId: string, sellingPartnerId: string): Promise<boolean> {
    return this.#run(async () => {
      const tokens = await this.#readTokens(false);
      if (tokens[sellingPartnerId]?.tenantId !== tenantId) return false;
      delete tokens[sellingPartnerId];
      await this.#writeTokens(tokens);
      return true;
    });
  }

  async findConnectedAccountCompletion(
    tenantId: string,
    attemptId: string,
  ): Promise<AmazonConnection | null> {
    return this.#run(async () => {
      const tokens = await this.#readTokens(false);
      for (const [sellingPartnerId, token] of Object.entries(tokens)) {
        if (token.tenantId === tenantId && token.connectedAccountAttemptId === attemptId) {
          return { authorizedAt: token.authorizedAt ?? "", sellingPartnerId };
        }
      }
      return null;
    });
  }

  async getRefreshToken(sellingPartnerId: string, tenantId: string): Promise<string> {
    const credential = await this.getRefreshCredential(sellingPartnerId, tenantId);
    return credential.refreshToken;
  }

  async getRefreshCredential(
    sellingPartnerId: string,
    tenantId: string,
  ): Promise<RefreshTokenCredential> {
    if (!tenantId) {
      throw new AmazonMcpError("TENANT_REQUIRED", "tenant identity is required");
    }
    if (!this.#allowedSellingPartnerIds.has(sellingPartnerId)) {
      throw new AmazonMcpError(
        "SELLER_NOT_ALLOWED",
        "selling partner is not allowed",
      );
    }

    const tokens = await this.#readTokens();
    const stored = tokens[sellingPartnerId];
    if (!stored?.refreshToken) {
      throw new AmazonMcpError(
        "NOT_CONNECTED",
        "selling partner has not completed Amazon OAuth",
      );
    }
    if (stored.tenantId !== tenantId) {
      throw new AmazonMcpError(
        "SELLER_FORBIDDEN",
        "selling partner belongs to a different tenant",
      );
    }
    return {
      refreshToken: decryptSecret(stored.refreshToken, this.#keyring, sellingPartnerId),
      revision: typeof stored.revision === "number" && stored.revision > 0
        ? stored.revision
        : 1,
      credentialId: `file:${tenantId}:${sellingPartnerId}`,
      credentialOwnerId: tenantId,
    };
  }

  async compareAndSetRefreshToken(options: {
    sellingPartnerId: string;
    tenantId: string;
    expectedRevision: number;
    newRefreshToken: string;
  }): Promise<"updated" | "conflict" | "missing"> {
    return this.#run(async () => {
      const tokens = await this.#readTokens(false);
      const stored = tokens[options.sellingPartnerId];
      if (!stored || stored.tenantId !== options.tenantId) return "missing";
      const revision = stored.revision ?? 1;
      if (revision !== options.expectedRevision) return "conflict";
      stored.refreshToken = encryptSecret(
        options.newRefreshToken,
        this.#keyring,
        options.sellingPartnerId,
      );
      stored.revision = revision + 1;
      await this.#writeTokens(tokens);
      return "updated";
    });
  }

  async checkHealth(): Promise<"ok" | "error"> {
    try {
      await this.#readTokens(false);
      return "ok";
    } catch {
      return "error";
    }
  }

  async close(): Promise<void> {}

  async #readTokens(useCache = true): Promise<TokenFile> {
    let signature: string;
    try {
      const metadata = await stat(this.#file);
      signature = `${metadata.mtimeMs}:${metadata.size}`;
    } catch {
      throw new TokenStoreError("token store could not be read");
    }

    if (useCache && this.#cachedTokenFile?.signature === signature) {
      return this.#cachedTokenFile.tokens;
    }

    try {
      const tokens = JSON.parse(await readFile(this.#file, "utf8")) as TokenFile;
      this.#cachedTokenFile = { signature, tokens };
      return tokens;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new TokenStoreError("token store is not valid JSON");
      }
      throw new TokenStoreError("token store could not be read");
    }
  }

  async #writeTokens(tokens: TokenFile): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
    this.#cachedTokenFile = undefined;
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
