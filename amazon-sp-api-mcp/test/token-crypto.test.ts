import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  createKeyring,
  createSingleKeyKeyring,
  decryptSecret,
  encryptSecret,
  envelopeVersionLabel,
  isLegacyUnversionedEnvelope,
  LEGACY_UNVERSIONED,
} from "../src/token-crypto.js";

test("encrypts v2 envelopes and decrypts with AAD-bound key_id", () => {
  const keyring = createSingleKeyKeyring(Buffer.alloc(32, 7).toString("base64"), "k1");
  const envelope = encryptSecret("refresh-secret", keyring, { credentialId: "A1SELLER" });
  assert.equal(envelope.version, 2);
  assert.equal(envelope.key_id, "k1");
  assert.equal(envelopeVersionLabel(envelope), "v2:k1");
  assert.equal(
    decryptSecret(envelope, keyring, { credentialId: "A1SELLER" }),
    "refresh-secret",
  );
  assert.throws(
    () => decryptSecret(envelope, keyring, { credentialId: "A2OTHER" }),
    /could not be decrypted|aad/i,
  );
});

test("reads legacy-unversioned envelopes and rejects unknown versions", () => {
  const key = Buffer.alloc(32, 9);
  const keyring = createKeyring({ currentKeyId: "k0", keys: { k0: key } });
  // Build legacy ciphertext with no AAD (historical format).
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("legacy-refresh", "utf8"), cipher.final()]);
  const legacy = {
    algorithm: "aes-256-gcm" as const,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  assert.equal(isLegacyUnversionedEnvelope(legacy), true);
  assert.equal(envelopeVersionLabel(legacy), LEGACY_UNVERSIONED);
  assert.equal(decryptSecret(legacy, keyring, { credentialId: "A1" }), "legacy-refresh");

  assert.throws(
    () => decryptSecret({
      version: 99,
      key_id: "k0",
      algorithm: "aes-256-gcm",
      ciphertext: legacy.ciphertext,
      iv: legacy.iv,
      tag: legacy.tag,
    }, keyring, { credentialId: "A1" }),
    /unsupported token encryption version/,
  );
  assert.throws(
    () => decryptSecret({
      version: 2,
      key_id: "missing",
      algorithm: "aes-256-gcm",
      ciphertext: legacy.ciphertext,
      iv: legacy.iv,
      tag: legacy.tag,
    }, keyring, { credentialId: "A1" }),
    /not available/,
  );
});
