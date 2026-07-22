import { loadDockerConfig } from "./config-loader.mjs";

async function check(url, { expectJson = false, timeoutMs = 2_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  if (!expectJson) return;
  const body = await response.json();
  if (!body || typeof body !== "object") throw new Error(`${url} returned invalid JSON`);
  // /readyz uses status: "ready"; /healthz uses status: "ok"
  if (url.endsWith("/readyz")) {
    if (body.status !== "ready") throw new Error(`${url} is not ready`);
  } else if (body.status !== "ok") {
    throw new Error(`${url} is not ok`);
  }
}

try {
  const { oauthPort, mcpPort } = await loadDockerConfig();
  await Promise.all([
    check(`http://127.0.0.1:${oauthPort}/healthz`, { expectJson: true }),
    check(`http://127.0.0.1:${mcpPort}/healthz`, { expectJson: true }),
    check(`http://127.0.0.1:${mcpPort}/readyz`, { expectJson: true, timeoutMs: 3_000 }),
  ]);
} catch {
  process.exitCode = 1;
}
