import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { AmazonMcpError } from "./errors.js";
import {
  READ_OPERATIONS,
  executeReadOperation,
  validateDocumentJob,
  type SpApiReadOperation,
} from "./sp-api-operations.js";
import { SpApiError, type AmazonRegion, type SpApiReader } from "./sp-api-client.js";
import type { TokenKeyring } from "./token-store.js";

const CURSOR_TTL_MS = 15 * 60_000;
const PAGE_BYTES = 256 * 1024;
const PAGE_RECORDS = 200;
const CURSOR_AAD_PREFIX = "amazon-sp-api-document-cursor|v1|";
const DOCUMENT_HOST = /(?:^|\.)(?:amazonaws\.com|amazonaws\.com\.cn)$/i;

interface CursorPayload {
  tenantId: string;
  employeeId: string;
  accountId: string;
  operation: string;
  jobId: string;
  documentId: string;
  context: string;
  offset: number;
  expiresAt: number;
}

interface CursorEnvelope {
  v: 1;
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface DocumentPage {
  records: string[];
  record_count: number;
  bytes: number;
  next_cursor?: string;
  expires_in_seconds?: number;
}

function cursorKey(material: Buffer, keyId: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    material,
    Buffer.from("amazon-sp-api-document-cursor-v1", "utf8"),
    Buffer.from(keyId, "utf8"),
    32,
  ));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class DocumentCursorCodec {
  readonly #keyring: TokenKeyring;
  readonly #now: () => number;

  constructor(keyring: TokenKeyring, now: () => number = Date.now) {
    this.#keyring = keyring;
    this.#now = now;
  }

  encode(payload: Omit<CursorPayload, "expiresAt">): string {
    const kid = this.#keyring.currentKeyId;
    const material = this.#keyring.keys.get(kid);
    if (!material) throw new AmazonMcpError("INTERNAL", "document cursor key is unavailable");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cursorKey(material, kid), iv);
    cipher.setAAD(Buffer.from(`${CURSOR_AAD_PREFIX}${kid}`, "utf8"));
    const plaintext = Buffer.from(JSON.stringify({
      ...payload,
      expiresAt: this.#now() + CURSOR_TTL_MS,
    }), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: CursorEnvelope = {
      v: 1,
      kid,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  }

  decode(token: string): CursorPayload {
    try {
      if (token.length > 4096) throw new Error("oversized cursor");
      const envelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as CursorEnvelope;
      if (envelope.v !== 1 || typeof envelope.kid !== "string") throw new Error("invalid cursor");
      const material = this.#keyring.keys.get(envelope.kid);
      if (!material) throw new Error("unknown cursor key");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        cursorKey(material, envelope.kid),
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(`${CURSOR_AAD_PREFIX}${envelope.kid}`, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const payload = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")) as CursorPayload;
      if (
        typeof payload.tenantId !== "string" ||
        typeof payload.employeeId !== "string" ||
        typeof payload.accountId !== "string" ||
        typeof payload.operation !== "string" ||
        typeof payload.jobId !== "string" ||
        typeof payload.documentId !== "string" ||
        typeof payload.context !== "string" ||
        !Number.isSafeInteger(payload.offset) || payload.offset < 0 ||
        !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= this.#now()
      ) throw new Error("invalid or expired cursor");
      return payload;
    } catch {
      throw new AmazonMcpError("INVALID_FILTER", "document cursor is invalid or expired");
    }
  }
}

function jobOperationFor(documentOperation: SpApiReadOperation): {
  operation: SpApiReadOperation;
  pathParameter: string;
} {
  const mapping = documentOperation.operationId === "getReportDocument"
    ? { domain: "reports", action: "getReport", pathParameter: "reportId" }
    : documentOperation.operationId === "getFeedDocument"
      ? { domain: "feeds", action: "getFeed", pathParameter: "feedId" }
      : { domain: "data_kiosk", action: "getQuery", pathParameter: "queryId" };
  const operation = READ_OPERATIONS.find((item) => item.domain === mapping.domain && item.action === mapping.action);
  if (!operation) throw new AmazonMcpError("INTERNAL", "document job operation is unavailable");
  return { operation, pathParameter: mapping.pathParameter };
}

function metadataUrl(value: unknown): { url: URL; compressed: boolean } {
  const body = record(value);
  const raw = body?.url ?? body?.documentUrl;
  if (typeof raw !== "string") throw new AmazonMcpError("UPSTREAM_SP_API", "Amazon document URL is missing");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AmazonMcpError("UPSTREAM_SP_API", "Amazon document URL was rejected");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") || !DOCUMENT_HOST.test(url.hostname)
  ) {
    throw new AmazonMcpError("UPSTREAM_SP_API", "Amazon document URL was rejected");
  }
  return { url, compressed: body?.compressionAlgorithm === "GZIP" };
}

async function pageFromResponse(response: Response, compressed: boolean, offset: number): Promise<{
  content: Buffer;
  hasMore: boolean;
}> {
  if (!response.ok || !response.body) {
    throw new AmazonMcpError("UPSTREAM_SP_API", "Amazon document download failed", response.status >= 500);
  }
  let stream: Readable = Readable.fromWeb(response.body as never);
  if (compressed && response.headers.get("content-encoding")?.toLowerCase() !== "gzip") {
    stream = stream.pipe(createGunzip());
  }
  let remainingSkip = offset;
  const chunks: Buffer[] = [];
  let length = 0;
  let lines = 0;
  let hasMore = false;
  try {
    for await (const raw of stream) {
      let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (remainingSkip >= chunk.length) {
        remainingSkip -= chunk.length;
        continue;
      }
      if (remainingSkip > 0) {
        chunk = chunk.subarray(remainingSkip);
        remainingSkip = 0;
      }
      let take = Math.min(chunk.length, PAGE_BYTES - length);
      for (let index = 0; index < take; index += 1) {
        if (chunk[index] === 0x0a && ++lines === PAGE_RECORDS) {
          take = index + 1;
          break;
        }
      }
      if (take > 0) {
        chunks.push(chunk.subarray(0, take));
        length += take;
      }
      if (take < chunk.length || length >= PAGE_BYTES || lines >= PAGE_RECORDS) {
        hasMore = true;
        break;
      }
    }
  } catch {
    throw new AmazonMcpError("UPSTREAM_SP_API", "Amazon document could not be decompressed", true);
  } finally {
    stream.destroy();
  }
  if (remainingSkip > 0) throw new AmazonMcpError("INVALID_FILTER", "document cursor offset is no longer available");
  let content = Buffer.concat(chunks, length);
  while (content.length > 0 && (content[content.length - 1]! & 0xc0) === 0x80) {
    content = content.subarray(0, content.length - 1);
    hasMore = true;
  }
  return { content, hasMore };
}

export class AmazonDocumentReader {
  readonly #client: SpApiReader;
  readonly #cursor: DocumentCursorCodec;
  readonly #fetch: typeof fetch;

  constructor(options: { client: SpApiReader; keyring: TokenKeyring; fetchImpl?: typeof fetch }) {
    this.#client = options.client;
    this.#cursor = new DocumentCursorCodec(options.keyring);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async readPage(options: {
    operation: SpApiReadOperation;
    tenantId: string;
    employeeId: string;
    accountId: string;
    sellingPartnerId: string;
    region: AmazonRegion;
    jobId: string;
    cursor?: string;
  }): Promise<DocumentPage> {
    const jobSpec = jobOperationFor(options.operation);
    const job = record(await executeReadOperation({
      client: this.#client,
      operation: jobSpec.operation,
      tenantId: options.tenantId,
      accountId: options.accountId,
      sellingPartnerId: options.sellingPartnerId,
      region: options.region,
      input: { path: { [jobSpec.pathParameter]: options.jobId } },
      internalDocumentJob: true,
    })) ?? {};
    const descriptor = validateDocumentJob(options.operation, job);
    const decoded = options.cursor ? this.#cursor.decode(options.cursor) : undefined;
    if (decoded && (
      decoded.tenantId !== options.tenantId ||
      decoded.employeeId !== options.employeeId ||
      decoded.accountId !== options.accountId ||
      decoded.operation !== options.operation.operationId ||
      decoded.jobId !== options.jobId ||
      decoded.documentId !== descriptor.documentId ||
      decoded.context !== descriptor.context
    )) {
      throw new AmazonMcpError("INVALID_FILTER", "document cursor does not belong to this employee, account or job");
    }
    if (!this.#client.request) throw new AmazonMcpError("INTERNAL", "SP-API request registry is unavailable");
    let metadata: unknown;
    try {
      metadata = await this.#client.request({
        sellingPartnerId: options.sellingPartnerId,
        tenantId: options.tenantId,
        region: options.region,
        operation: options.operation.operationId,
        method: options.operation.method,
        path: options.operation.path.replace(/\{[^}]+\}/, encodeURIComponent(descriptor.documentId)),
        retryMode: "safe",
      });
    } catch (error) {
      if (error instanceof SpApiError && error.status === 403) {
        throw new AmazonMcpError("AMAZON_ROLE_REQUIRED", "Amazon role required for document read", false, {
          operation: options.operation.operationId,
          role: options.operation.roles.join(" | "),
        });
      }
      throw error;
    }
    const download = metadataUrl(metadata);
    const response = await this.#fetch(download.url, {
      headers: { accept: "text/plain, application/json, application/octet-stream" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const offset = decoded?.offset ?? 0;
    const page = await pageFromResponse(response, download.compressed, offset);
    const text = page.content.toString("utf8");
    const records = text.split(/\r?\n/).filter((value) => value.length > 0).slice(0, PAGE_RECORDS);
    const nextCursor = page.hasMore
      ? this.#cursor.encode({
        tenantId: options.tenantId,
        employeeId: options.employeeId,
        accountId: options.accountId,
        operation: options.operation.operationId,
        jobId: options.jobId,
        documentId: descriptor.documentId,
        context: descriptor.context,
        offset: offset + page.content.length,
      })
      : undefined;
    return {
      records,
      record_count: records.length,
      bytes: page.content.length,
      ...(nextCursor ? { next_cursor: nextCursor, expires_in_seconds: CURSOR_TTL_MS / 1000 } : {}),
    };
  }
}
