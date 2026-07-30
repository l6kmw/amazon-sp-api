import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { AmazonDocumentReader, DocumentCursorCodec } from "../src/document-reader.js";
import { operationForAction } from "../src/sp-api-operations.js";
import type { SpApiReader } from "../src/sp-api-client.js";
import { createKeyring } from "../src/token-crypto.js";

const key0 = Buffer.alloc(32, 1);
const key1 = Buffer.alloc(32, 2);
const keyring = createKeyring({ currentKeyId: "k1", keys: { k0: key0, k1: key1 } });

test("reads documents in stateless 200-record pages without returning the presigned URL", async () => {
  const body = Array.from({ length: 250 }, (_, index) => JSON.stringify({ row: index + 1 })).join("\n") + "\n";
  const calls: string[] = [];
  const client: SpApiReader = {
    async get() { return {}; },
    async request(options) {
      calls.push(options.operation);
      if (options.operation === "getReport") {
        return {
          reportId: "report-1",
          reportType: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
          processingStatus: "DONE",
          createdTime: "2026-07-28T00:00:00Z",
          reportDocumentId: "document-1",
        };
      }
      return {
        reportDocumentId: "document-1",
        url: "https://safe-bucket.s3.amazonaws.com/document-1",
      };
    },
  };
  const reader = new AmazonDocumentReader({
    client,
    keyring,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/jsonl" },
    }),
  });
  const operation = operationForAction("reports", "getReportDocument");
  const common = {
    operation,
    tenantId: "workspace-1",
    employeeId: "employee-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na" as const,
    jobId: "report-1",
  };
  const first = await reader.readPage(common);
  assert.equal(first.record_count, 200);
  assert.ok(first.bytes <= 256 * 1024);
  assert.ok(first.next_cursor);
  assert.doesNotMatch(JSON.stringify(first), /amazonaws|document-1/);

  await assert.rejects(
    reader.readPage({ ...common, employeeId: "employee-2", cursor: first.next_cursor }),
    /does not belong to this employee/,
  );

  const second = await reader.readPage({ ...common, cursor: first.next_cursor });
  assert.equal(second.record_count, 50);
  assert.equal(second.next_cursor, undefined);
  assert.deepEqual(calls, [
    "getReport", "getReportDocument", "getReport", "getReport", "getReportDocument",
  ]);
});

test("cursor key rotation works and cross-employee replay is rejected", async () => {
  const codec = new DocumentCursorCodec(keyring);
  const token = codec.encode({
    tenantId: "workspace-1",
    employeeId: "employee-1",
    accountId: "acct_0123456789abcdef",
    operation: "getReportDocument",
    jobId: "report-1",
    documentId: "document-1",
    context: "report:GET_FLAT_FILE_OPEN_LISTINGS_DATA",
    offset: 100,
  });
  const rotated = new DocumentCursorCodec(createKeyring({
    currentKeyId: "k2",
    keys: { k1: key1, k2: Buffer.alloc(32, 3) },
  }));
  assert.equal(rotated.decode(token).offset, 100);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => rotated.decode(tampered), /invalid or expired/);

  const startedAt = 1_000_000;
  const expiring = new DocumentCursorCodec(keyring, () => startedAt);
  const expiringToken = expiring.encode({
    tenantId: "workspace-1",
    employeeId: "employee-1",
    accountId: "acct_0123456789abcdef",
    operation: "getReportDocument",
    jobId: "report-1",
    documentId: "document-1",
    context: "report:GET_FLAT_FILE_OPEN_LISTINGS_DATA",
    offset: 0,
  });
  assert.throws(
    () => new DocumentCursorCodec(keyring, () => startedAt + 15 * 60_000 + 1).decode(expiringToken),
    /invalid or expired/,
  );
});

test("rejects non-Amazon document URLs and restricted report types", async () => {
  const operation = operationForAction("reports", "getReportDocument");
  const client: SpApiReader = {
    async get() { return {}; },
    async request(options) {
      if (options.operation === "getReport") {
        return {
          reportId: "report-1",
          reportType: "GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL",
          processingStatus: "DONE",
          createdTime: "2026-07-28T00:00:00Z",
          reportDocumentId: "document-1",
        };
      }
      return { url: "https://attacker.example/document" };
    },
  };
  const reader = new AmazonDocumentReader({ client, keyring });
  await assert.rejects(reader.readPage({
    operation,
    tenantId: "workspace-1",
    employeeId: "employee-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na",
    jobId: "report-1",
  }), /non-restricted Seller allowlist/);
});

test("rejects a non-Amazon download URL even for an allowlisted report", async () => {
  const operation = operationForAction("reports", "getReportDocument");
  const client: SpApiReader = {
    async get() { return {}; },
    async request(options) {
      if (options.operation === "getReport") {
        return {
          reportId: "report-1",
          reportType: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
          processingStatus: "DONE",
          createdTime: "2026-07-28T00:00:00Z",
          reportDocumentId: "document-1",
        };
      }
      return { url: "https://attacker.example/document" };
    },
  };
  const reader = new AmazonDocumentReader({ client, keyring });
  await assert.rejects(reader.readPage({
    operation,
    tenantId: "workspace-1",
    employeeId: "employee-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na",
    jobId: "report-1",
  }), /document URL was rejected/);
});

test("decompresses GZIP documents without persisting or returning their URL", async () => {
  const content = "one\ntwo\n";
  const client: SpApiReader = {
    async get() { return {}; },
    async request(options) {
      if (options.operation === "getReport") {
        return {
          reportId: "report-1",
          reportType: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
          processingStatus: "DONE",
          createdTime: "2026-07-28T00:00:00Z",
          reportDocumentId: "document-1",
        };
      }
      return {
        url: "https://safe-bucket.s3.amazonaws.com/document-1",
        compressionAlgorithm: "GZIP",
      };
    },
  };
  const reader = new AmazonDocumentReader({
    client,
    keyring,
    fetchImpl: async () => new Response(new Uint8Array(gzipSync(content)), { status: 200 }),
  });
  const page = await reader.readPage({
    operation: operationForAction("reports", "getReportDocument"),
    tenantId: "workspace-1",
    employeeId: "employee-1",
    accountId: "acct_0123456789abcdef",
    sellingPartnerId: "A1SELLER",
    region: "na",
    jobId: "report-1",
  });
  assert.deepEqual(page.records, ["one", "two"]);
  assert.doesNotMatch(JSON.stringify(page), /amazonaws|document-1/);
});
