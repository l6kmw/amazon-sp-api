import { readFile, stat } from "node:fs/promises";

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

interface StoredToken {
  refreshToken: EncryptedSecret;
  tenantId?: string;
  revision?: number;
}

type TokenFile = Record<string, StoredToken>;

interface CachedTokenFile {
  signature: string;
  tokens: TokenFile;
}

export interface RefreshTokenCredential {
  refreshToken: string;
  revision: number;
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

export class TokenStoreError extends AmazonMcpError {
  constructor(message: string) {
    super("INTERNAL", message);
    this.name = "TokenStoreError";
  }
}

export function parseEncryptionKey(value: string): Buffer {
  try {
    return parseKeyMaterial(value);
  } catch {
    throw new TokenStoreError("AMAZON_TOKEN_ENCRYPTION_KEY must be 32 bytes");
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
    throw new TokenStoreError("AMAZON_TOKEN_ENCRYPTION_KEY must be 32 bytes");
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

export class EncryptedFileTokenStore implements RefreshTokenProvider {
  readonly #file: string;
  readonly #keyring: TokenKeyring;
  readonly #allowedSellingPartnerIds: ReadonlySet<string>;
  #cachedTokenFile?: CachedTokenFile;

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
    };
  }

  async #readTokens(): Promise<TokenFile> {
    let signature: string;
    try {
      const metadata = await stat(this.#file);
      signature = `${metadata.mtimeMs}:${metadata.size}`;
    } catch {
      throw new TokenStoreError("token store could not be read");
    }

    if (this.#cachedTokenFile?.signature === signature) {
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
}
