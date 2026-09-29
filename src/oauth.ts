import { randomBytes } from "node:crypto";

import { Router, type Request, type Response } from "express";

import type { RuntimeConfig } from "./config.js";
import type { AuthorizationIntent } from "./connection-service.js";
import type { ExpiringRecord, ExpiringStore } from "./state-store.js";
import { ConnectionConflictError, type ConnectionStore } from "./token-store.js";

const AMAZON_DOMAIN_SUFFIXES = [
  "amazon.com", "amazon.ca", "amazon.com.mx", "amazon.com.br", "amazon.co.uk",
  "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.nl", "amazon.se",
  "amazon.pl", "amazon.com.tr", "amazon.co.jp", "amazon.com.au", "amazon.in",
  "amazon.sg", "amazon.ae", "amazon.sa", "amazon.eg", "amazon.co.za", "amazon.ie",
  "amazon.com.be",
];

const DEFAULT_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const AMAZON_INTENT_COOKIE = "amazon_oauth_intent";

export interface OAuthState extends ExpiringRecord {
  sellingPartnerId: string;
  tenantId: string;
  connectedAccountAttemptId?: string;
  connectedAccountOrigin?: string;
}

export class OAuthInputError extends Error {}
export class OAuthConfigurationError extends Error {}
export class OAuthUpstreamError extends Error {}

function isAmazonHost(hostname: string): boolean {
  return AMAZON_DOMAIN_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

export function validateAmazonCallbackUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthInputError("amazon_callback_uri is invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    !isAmazonHost(url.hostname) || !url.pathname.startsWith("/apps/authorize/confirm/")
  ) {
    throw new OAuthInputError("amazon_callback_uri is not an allowed Amazon URI");
  }
  return url;
}

function requiredParam(searchParams: URLSearchParams, name: string, maxLength = 4096): string {
  const value = searchParams.get(name);
  if (!value || value.length > maxLength) throw new OAuthInputError(`${name} is required`);
  return value;
}

function validateSellingPartnerId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new OAuthInputError("selling_partner_id is invalid");
  }
  return value;
}

function requestCookie(request: Request, name: string): string {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function intentCookie(value: string, maxAge = 600): string {
  return `${AMAZON_INTENT_COOKIE}=${encodeURIComponent(value)}; Path=/oauth/amazon; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function sellerAuthorizationURL(config: RuntimeConfig, intentId: string): string {
  const url = new URL(config.authorizationUri);
  url.searchParams.set("application_id", config.applicationId);
  url.searchParams.set("state", intentId);
  if (config.applicationVersion) url.searchParams.set("version", config.applicationVersion);
  return url.toString();
}

function sendJson(response: Response, status: number, body: unknown): void {
  response.set(DEFAULT_HEADERS).status(status).type("application/json").send(`${JSON.stringify(body)}\n`);
}

function sendRedirect(response: Response, location: string, headers: Record<string, string> = {}): void {
  response.set({ ...DEFAULT_HEADERS, ...headers }).redirect(302, location);
}

function sendSuccess(response: Response): void {
  response.set(DEFAULT_HEADERS).status(200).type("html").send(
    "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Amazon 授权完成</title><body><h1>Amazon 授权已完成</h1><p>可以关闭此页面并返回 ConnectedAccount。</p></body></html>",
  );
}

function sendConnectedAccountSuccess(
  response: Response,
  attemptId: string,
  targetOrigin: string,
): void {
  const nonce = randomBytes(18).toString("base64");
  const message = JSON.stringify({
    type: "connected-account:authorization-completed",
    attemptId,
    status: "active",
  }).replaceAll("<", "\\u003c");
  const origin = JSON.stringify(targetOrigin).replaceAll("<", "\\u003c");
  response.set({
    ...DEFAULT_HEADERS,
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  }).status(200).type("html").send(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Amazon 授权完成</title><body><h1>Amazon 授权已完成</h1><p>可以关闭此页面并返回 ConnectedAccount。</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${message},${origin})}</script></body></html>`,
  );
}

export async function exchangeAuthorizationCode(options: {
  code: string;
  config: Pick<RuntimeConfig, "lwaClientId" | "lwaClientSecret" | "redirectUri">;
  fetchImpl?: typeof fetch;
}): Promise<{ refresh_token: string; token_type?: string }> {
  const { code, config, fetchImpl = fetch } = options;
  if (!config.lwaClientId || !config.lwaClientSecret) {
    throw new OAuthConfigurationError("Amazon LWA credentials are not configured");
  }
  const response = await fetchImpl("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.lwaClientId,
      client_secret: config.lwaClientSecret,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new OAuthUpstreamError(`LWA token exchange failed with status ${response.status}`);
  }
  const body = await response.json() as { refresh_token?: string; token_type?: string };
  if (!body.refresh_token) throw new OAuthUpstreamError("LWA response did not include a refresh token");
  return { refresh_token: body.refresh_token, token_type: body.token_type };
}

export function createAmazonOAuthRouter(options: {
  config: RuntimeConfig;
  stateStore: ExpiringStore<OAuthState>;
  intentStore: ExpiringStore<AuthorizationIntent>;
  connectionStore: ConnectionStore;
  exchangeCode?: typeof exchangeAuthorizationCode;
  onConnectionSaved?: (tenantId: string, sellingPartnerId: string) => Promise<void> | void;
}) {
  const { config, stateStore, intentStore, connectionStore } = options;
  const exchangeCode = options.exchangeCode ?? exchangeAuthorizationCode;
  const router = Router();

  const route = (handler: (request: Request, response: Response) => Promise<void>) =>
    async (request: Request, response: Response) => {
      try {
        await handler(request, response);
      } catch (error) {
        if (error instanceof OAuthInputError) return sendJson(response, 400, { error: error.message });
        if (error instanceof OAuthConfigurationError) {
          return sendJson(response, 503, { error: "service_not_configured" });
        }
        if (error instanceof ConnectionConflictError) {
          return sendJson(response, 409, { error: "connection_conflict" });
        }
        if (error instanceof OAuthUpstreamError) {
          console.error("[amazon-oauth] Amazon token exchange failed");
          return sendJson(response, 502, { error: "amazon_token_exchange_failed" });
        }
        console.error("[amazon-oauth] unexpected request failure");
        return sendJson(response, 500, { error: "internal_error" });
      }
    };

  router.get("/oauth/amazon/login", route(async (request, response) => {
    const url = new URL(request.originalUrl, config.publicOrigin);
    const callbackUri = validateAmazonCallbackUri(requiredParam(url.searchParams, "amazon_callback_uri"));
    const amazonState = requiredParam(url.searchParams, "amazon_state", 2048);
    const sellingPartnerId = validateSellingPartnerId(
      requiredParam(url.searchParams, "selling_partner_id", 128),
    );
    const version = url.searchParams.get("version");
    if (version && version !== "beta") throw new OAuthInputError("version is invalid");
    const intent = await intentStore.consume(requestCookie(request, AMAZON_INTENT_COOKIE));
    if (!intent) throw new OAuthInputError("authorization intent is invalid or expired");
    const state = await stateStore.create({
      sellingPartnerId,
      tenantId: intent.tenantId,
      ...(intent.connectedAccountAttemptId ? {
        connectedAccountAttemptId: intent.connectedAccountAttemptId,
        connectedAccountOrigin: intent.connectedAccountOrigin,
      } : {}),
    });
    callbackUri.searchParams.set("amazon_state", amazonState);
    callbackUri.searchParams.set("state", state);
    callbackUri.searchParams.set("redirect_uri", config.redirectUri);
    if (version) callbackUri.searchParams.set("version", version);
    sendRedirect(response, callbackUri.toString(), { "set-cookie": intentCookie("", 0) });
  }));

  router.get("/oauth/amazon/start", route(async (request, response) => {
    const url = new URL(request.originalUrl, config.publicOrigin);
    const intentId = requiredParam(url.searchParams, "intent", 256);
    if (!(await intentStore.get(intentId))) {
      throw new OAuthInputError("authorization intent is invalid or expired");
    }
    sendRedirect(response, sellerAuthorizationURL(config, intentId), {
      "set-cookie": intentCookie(intentId),
    });
  }));

  router.get("/oauth/amazon/renew", route(async (request, response) => {
    const url = new URL(request.originalUrl, config.publicOrigin);
    const intentId = requiredParam(url.searchParams, "intent", 256);
    if (!(await intentStore.get(intentId))) {
      throw new OAuthInputError("authorization intent is invalid or expired");
    }
    sendRedirect(response, config.sellerCentralManageURL, {
      "set-cookie": intentCookie(intentId),
    });
  }));

  router.get("/oauth/amazon/callback", route(async (request, response) => {
    const url = new URL(request.originalUrl, config.publicOrigin);
    const state = requiredParam(url.searchParams, "state", 256);
    const sellingPartnerId = validateSellingPartnerId(
      requiredParam(url.searchParams, "selling_partner_id", 128),
    );
    const code = requiredParam(url.searchParams, "spapi_oauth_code", 4096);
    let stateRecord = await stateStore.consume(
      state,
      (record) => record.sellingPartnerId === sellingPartnerId,
    );
    if (!stateRecord) {
      const intent = await intentStore.consume(state);
      if (intent) stateRecord = { ...intent, sellingPartnerId };
    }
    if (!stateRecord) throw new OAuthInputError("state is invalid or expired");
    const tokenResponse = await exchangeCode({ code, config });
    await connectionStore.save(sellingPartnerId, stateRecord.tenantId, tokenResponse, {
      connectedAccountAttemptId: stateRecord.connectedAccountAttemptId,
    });
    await options.onConnectionSaved?.(stateRecord.tenantId, sellingPartnerId);
    if (stateRecord.connectedAccountAttemptId && stateRecord.connectedAccountOrigin) {
      sendConnectedAccountSuccess(response, stateRecord.connectedAccountAttemptId, stateRecord.connectedAccountOrigin);
    } else if (config.successRedirectUri) {
      sendRedirect(response, config.successRedirectUri);
    } else {
      sendSuccess(response);
    }
  }));

  return router;
}
