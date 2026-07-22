/**
 * Port of shared/token-crypto.mjs — keep behavior in lockstep with OAuth token-crypto.mjs.
 */
// @ts-nocheck
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const ENVELOPE_VERSION_V2 = 2;
export const LEGACY_UNVERSIONED = "legacy-unversioned";
export const PROVIDER_KEY = "amazon-sp-api";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export class TokenCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

export function parseEncryptionKey(value) {
  if (typeof value !== "string" || !value) {
    throw new TokenCryptoError("encryption key is required");
  }
  const key = /^[a-fA-F0-9]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new TokenCryptoError("encryption key must be 32 bytes");
  }
  return key;
}

/**
 * @param {{ currentKeyId: string, keys: Record<string, string|Buffer> }} options
 */
export function createKeyring(options) {
  if (!options?.currentKeyId || !KEY_ID_PATTERN.test(options.currentKeyId)) {
    throw new TokenCryptoError("currentKeyId is invalid");
  }
  if (options.currentKeyId === LEGACY_UNVERSIONED) {
    throw new TokenCryptoError("currentKeyId must not be legacy-unversioned");
  }
  const keys = new Map();
  for (const [keyId, material] of Object.entries(options.keys ?? {})) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new TokenCryptoError("key id is invalid");
    }
    if (keys.has(keyId)) {
      throw new TokenCryptoError("duplicate key id in keyring");
    }
    keys.set(keyId, Buffer.isBuffer(material) ? material : parseEncryptionKey(material));
  }
  if (!keys.has(options.currentKeyId)) {
    throw new TokenCryptoError("currentKeyId is missing from keyring");
  }
  return {
    currentKeyId: options.currentKeyId,
    keys,
    has(keyId) {
      return keys.has(keyId);
    },
  };
}

/** Single-key compatibility keyring used by existing AMAZON_TOKEN_ENCRYPTION_KEY deployments. */
export function createSingleKeyKeyring(encryptionKey, currentKeyId = "k0") {
  return createKeyring({
    currentKeyId,
    keys: { [currentKeyId]: encryptionKey },
  });
}

function requireBase64(value, label, expectedBytes) {
  if (typeof value !== "string" || !value) {
    throw new TokenCryptoError(`${label} is required`);
  }
  let buffer;
  try {
    buffer = Buffer.from(value, "base64");
  } catch {
    throw new TokenCryptoError(`${label} is not valid base64`);
  }
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    throw new TokenCryptoError(`${label} has invalid length`);
  }
  if (buffer.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    // Accept standard base64; loose check for padding variants only.
  }
  return buffer;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isLegacyUnversionedEnvelope(value) {
  if (!isRecord(value)) return false;
  if ("version" in value || "key_id" in value) return false;
  const keys = Object.keys(value).sort();
  return keys.join(",") === "algorithm,ciphertext,iv,tag"
    && value.algorithm === ALGORITHM
    && typeof value.ciphertext === "string"
    && typeof value.iv === "string"
    && typeof value.tag === "string";
}

export function isVersionedEnvelope(value) {
  if (!isRecord(value)) return false;
  return value.version === ENVELOPE_VERSION_V2
    && typeof value.key_id === "string"
    && value.algorithm === ALGORITHM
    && typeof value.ciphertext === "string"
    && typeof value.iv === "string"
    && typeof value.tag === "string";
}

export function buildAad(options) {
  const version = String(options.version);
  const keyId = options.keyId;
  const provider = options.provider ?? PROVIDER_KEY;
  const credentialId = options.credentialId;
  if (!KEY_ID_PATTERN.test(keyId)) throw new TokenCryptoError("aad key_id is invalid");
  if (!provider || provider.length > 64) throw new TokenCryptoError("aad provider is invalid");
  if (!credentialId || credentialId.length > 256) throw new TokenCryptoError("aad credential id is invalid");
  return Buffer.from(`${version}|${keyId}|${provider}|${credentialId}`, "utf8");
}

/**
 * Encrypt plaintext as version=2 envelope using the current keyring key.
 * @param {string} plaintext
 * @param {ReturnType<typeof createKeyring>} keyring
 * @param {{ credentialId: string, provider?: string }} aadContext
 */
export function encryptSecret(plaintext, keyring, aadContext) {
  if (typeof plaintext !== "string" || !plaintext) {
    throw new TokenCryptoError("plaintext is required");
  }
  const keyId = keyring.currentKeyId;
  const key = keyring.keys.get(keyId);
  if (!key) throw new TokenCryptoError("current encryption key is unavailable");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const aad = buildAad({
    version: ENVELOPE_VERSION_V2,
    keyId,
    provider: aadContext.provider,
    credentialId: aadContext.credentialId,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: ENVELOPE_VERSION_V2,
    key_id: keyId,
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt legacy-unversioned or versioned v2 envelope.
 * @param {unknown} envelope
 * @param {ReturnType<typeof createKeyring>} keyring
 * @param {{ credentialId: string, provider?: string }} aadContext
 */
export function decryptSecret(envelope, keyring, aadContext) {
  if (isLegacyUnversionedEnvelope(envelope)) {
    return decryptLegacy(envelope, keyring);
  }
  if (!isRecord(envelope) || !("version" in envelope)) {
    throw new TokenCryptoError("unsupported token encryption envelope");
  }
  if (envelope.version !== ENVELOPE_VERSION_V2) {
    throw new TokenCryptoError("unsupported token encryption version");
  }
  if (!isVersionedEnvelope(envelope)) {
    throw new TokenCryptoError("versioned token encryption envelope is invalid");
  }
  if (!KEY_ID_PATTERN.test(envelope.key_id)) {
    throw new TokenCryptoError("envelope key_id is invalid");
  }
  const key = keyring.keys.get(envelope.key_id);
  if (!key) {
    throw new TokenCryptoError("encryption key id is not available");
  }
  const iv = requireBase64(envelope.iv, "iv", IV_BYTES);
  const tag = requireBase64(envelope.tag, "tag", TAG_BYTES);
  const ciphertext = requireBase64(envelope.ciphertext, "ciphertext");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(buildAad({
      version: ENVELOPE_VERSION_V2,
      keyId: envelope.key_id,
      provider: aadContext.provider,
      credentialId: aadContext.credentialId,
    }));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenCryptoError("stored refresh token could not be decrypted");
  }
}

function decryptLegacy(envelope, keyring) {
  // Prefer current key, then any configured key (migration window).
  const candidates = [keyring.currentKeyId, ...keyring.keys.keys()];
  const seen = new Set();
  let lastError;
  for (const keyId of candidates) {
    if (seen.has(keyId)) continue;
    seen.add(keyId);
    const key = keyring.keys.get(keyId);
    if (!key) continue;
    try {
      const iv = requireBase64(envelope.iv, "iv", IV_BYTES);
      const tag = requireBase64(envelope.tag, "tag", TAG_BYTES);
      const ciphertext = requireBase64(envelope.ciphertext, "ciphertext");
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw new TokenCryptoError(
    lastError instanceof TokenCryptoError
      ? lastError.message
      : "stored refresh token could not be decrypted",
  );
}

export function envelopeVersionLabel(envelope) {
  if (isLegacyUnversionedEnvelope(envelope)) return LEGACY_UNVERSIONED;
  if (isVersionedEnvelope(envelope)) return `v${envelope.version}:${envelope.key_id}`;
  return "unknown";
}

export function assertKeyMaterialEqual(left, right) {
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new TokenCryptoError("encryption key material mismatch");
  }
}
