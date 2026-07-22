export const ENVELOPE_VERSION_V2: 2;
export const LEGACY_UNVERSIONED: "legacy-unversioned";
export const PROVIDER_KEY: "amazon-sp-api";

export class TokenCryptoError extends Error {
  constructor(message: string);
}

export interface TokenKeyring {
  currentKeyId: string;
  keys: Map<string, Buffer>;
  has(keyId: string): boolean;
}

export interface AadContext {
  credentialId: string;
  provider?: string;
}

export type LegacyEnvelope = {
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
};

export type VersionedEnvelope = {
  version: 2;
  key_id: string;
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
};

export type SecretEnvelope = LegacyEnvelope | VersionedEnvelope;

export function parseEncryptionKey(value: string): Buffer;
export function createKeyring(options: {
  currentKeyId: string;
  keys: Record<string, string | Buffer>;
}): TokenKeyring;
export function createSingleKeyKeyring(
  encryptionKey: string,
  currentKeyId?: string,
): TokenKeyring;
export function isLegacyUnversionedEnvelope(value: unknown): value is LegacyEnvelope;
export function isVersionedEnvelope(value: unknown): value is VersionedEnvelope;
export function buildAad(options: {
  version: number | string;
  keyId: string;
  provider?: string;
  credentialId: string;
}): Buffer;
export function encryptSecret(
  plaintext: string,
  keyring: TokenKeyring,
  aadContext: AadContext,
): VersionedEnvelope;
export function decryptSecret(
  envelope: unknown,
  keyring: TokenKeyring,
  aadContext: AadContext,
): string;
export function envelopeVersionLabel(envelope: unknown): string;
export function assertKeyMaterialEqual(left: Buffer, right: Buffer): void;
