import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("reads the checked-in legacy token fixture and preserves the file schema on write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-token-golden-"));
  directories.push(directory);
  const file = join(directory, "tokens.json");
  await copyFile(new URL("./fixtures/legacy-tokens.json", import.meta.url), file);
  const store = new EncryptedFileTokenStore({
    file,
    encryptionKey: Buffer.alloc(32, 9).toString("base64"),
    allowedSellingPartnerIds: ["A1LEGACY", "A1NEW"],
  });
  assert.equal(
    await store.getRefreshToken("A1LEGACY", "tenant-legacy"),
    "legacy-refresh-token",
  );
  await store.save("A1NEW", "tenant-new", {
    refresh_token: "new-refresh-token",
    token_type: "bearer",
  });
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.A1LEGACY.authorizedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(written.A1NEW.refreshToken.version, 2);
  assert.equal(written.A1NEW.refreshToken.key_id, "k0");
  assert.equal(await store.getRefreshToken("A1NEW", "tenant-new"), "new-refresh-token");
});

test("atomically compares and updates rotated refresh credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amazon-token-cas-"));
  directories.push(directory);
  const file = join(directory, "tokens.json");
  const store = new EncryptedFileTokenStore({
    file,
    encryptionKey: Buffer.alloc(32, 10).toString("base64"),
    allowedSellingPartnerIds: ["A1SELLER"],
  });
  await store.initialize();
  await store.save("A1SELLER", "tenant-1", { refresh_token: "first" });
  assert.equal(await store.compareAndSetRefreshToken({
    sellingPartnerId: "A1SELLER",
    tenantId: "tenant-1",
    expectedRevision: 1,
    newRefreshToken: "second",
  }), "updated");
  assert.equal(await store.compareAndSetRefreshToken({
    sellingPartnerId: "A1SELLER",
    tenantId: "tenant-1",
    expectedRevision: 1,
    newRefreshToken: "stale",
  }), "conflict");
  assert.equal(await store.getRefreshToken("A1SELLER", "tenant-1"), "second");
});
