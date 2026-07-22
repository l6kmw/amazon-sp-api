import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { EncryptedFileTokenStore } from "../src/token-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("decrypts the OAuth service token format and enforces the allowlist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-mcp-token-test-"));
  directories.push(directory);
  const file = join(directory, "tokens.json");
  const key = Buffer.alloc(32, 11);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("refresh-token", "utf8"), cipher.final()]);
  await writeFile(
    file,
    JSON.stringify({
      A1SELLER: {
        tenantId: "user-1",
        refreshToken: {
          algorithm: "aes-256-gcm",
          ciphertext: ciphertext.toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
        },
      },
    }),
  );

  const store = new EncryptedFileTokenStore({
    file,
    encryptionKey: key.toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });

  assert.equal(await store.getRefreshToken("A1SELLER", "user-1"), "refresh-token");
  await assert.rejects(
    store.getRefreshToken("A1SELLER", "user-2"),
    (error: unknown) => (error as { code?: string }).code === "SELLER_FORBIDDEN",
  );
  await assert.rejects(
    store.getRefreshToken("A2SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "SELLER_NOT_ALLOWED",
  );
});

test("refreshes the cached token file when its metadata changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-mcp-token-test-"));
  directories.push(directory);
  const file = join(directory, "tokens.json");
  const key = Buffer.alloc(32, 15);
  const encrypted = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm" as const,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  };
  await writeFile(file, JSON.stringify({
    A1SELLER: { tenantId: "user-1", refreshToken: encrypted("refresh-one") },
  }));
  const store = new EncryptedFileTokenStore({
    file,
    encryptionKey: key.toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });

  assert.equal(await store.getRefreshToken("A1SELLER", "user-1"), "refresh-one");
  assert.equal(await store.getRefreshToken("A1SELLER", "user-1"), "refresh-one");
  const before = await stat(file);
  await writeFile(file, JSON.stringify({
    A1SELLER: { tenantId: "user-1", refreshToken: encrypted("refresh-token-two") },
  }));
  const after = await stat(file);
  assert.notEqual(`${before.mtimeMs}:${before.size}`, `${after.mtimeMs}:${after.size}`);
  assert.equal(await store.getRefreshToken("A1SELLER", "user-1"), "refresh-token-two");
});

test("returns stable errors for unreadable and invalid token stores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-mcp-token-test-"));
  directories.push(directory);
  const missingFile = join(directory, "missing.json");
  const invalidFile = join(directory, "invalid.json");
  const key = Buffer.alloc(32, 13);
  const missingStore = new EncryptedFileTokenStore({
    file: missingFile,
    encryptionKey: key.toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });
  await assert.rejects(
    missingStore.getRefreshToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "INTERNAL",
  );

  await writeFile(invalidFile, "not-json");
  const invalidStore = new EncryptedFileTokenStore({
    file: invalidFile,
    encryptionKey: key.toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });
  await assert.rejects(
    invalidStore.getRefreshToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "INTERNAL",
  );
});

test("reports a seller without an OAuth token as not connected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-mcp-token-test-"));
  directories.push(directory);
  const file = join(directory, "tokens.json");
  const key = Buffer.alloc(32, 14);
  await writeFile(file, "{}");
  const store = new EncryptedFileTokenStore({
    file,
    encryptionKey: key.toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });

  await assert.rejects(
    store.getRefreshToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
  );
});

test("rejects an unbound token for tenant-scoped access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-mcp-token-test-"));
  directories.push(directory);
  const file = join(directory, "tokens.json");
  const key = Buffer.alloc(32, 12);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("refresh-token", "utf8"), cipher.final()]);
  await writeFile(
    file,
    JSON.stringify({
      A1SELLER: {
        refreshToken: {
          algorithm: "aes-256-gcm",
          ciphertext: ciphertext.toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
        },
      },
    }),
  );

  const store = new EncryptedFileTokenStore({
    file,
    encryptionKey: key.toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });

  await assert.rejects(
    store.getRefreshToken("A1SELLER", ""),
    (error: unknown) => (error as { code?: string }).code === "TENANT_REQUIRED",
  );
  await assert.rejects(
    store.getRefreshToken("A1SELLER", "user-1"),
    (error: unknown) => (error as { code?: string }).code === "SELLER_FORBIDDEN",
  );
});
