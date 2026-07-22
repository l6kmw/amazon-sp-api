import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open } from "node:fs/promises";

import { loadDockerConfig } from "./config-loader.mjs";

const configFile = process.env.AMAZON_CONFIG_FILE || "/app/config.yaml";
const oauthScript = process.env.AMAZON_OAUTH_SCRIPT || "/app/amazon-oauth-service/server.mjs";
const mcpScript = process.env.AMAZON_MCP_SCRIPT || "/app/amazon-sp-api-mcp/dist/server.js";

let children = [];
let shuttingDown = false;

function start(name, script, environment) {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV || "production", ...environment },
    stdio: "inherit",
  });
  child.name = name;
  children.push(child);
  return child;
}

async function waitForOAuth(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (response.ok && body.status === "ok" && body.lwaConfigured === true) return;
    } catch {
      // OAuth may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("OAuth service did not become healthy within 30 seconds");
}

function stop(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000).unref();
}

async function secureDataPath(dataDirectory, tokenStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(dataDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("OAuth data path must be a real directory");
  }
  await chmod(dataDirectory, 0o700);

  const tokenFile = await open(tokenStoreFile, "a", 0o600);
  await tokenFile.close();
  const tokenMetadata = await lstat(tokenStoreFile);
  if (!tokenMetadata.isFile() || tokenMetadata.isSymbolicLink()) {
    throw new Error("Token Store must be a regular file");
  }
  await chmod(tokenStoreFile, 0o600);
}

async function main() {
  const { oauthEnv, mcpEnv, oauthPort, dataDirectory, tokenStoreFile } = await loadDockerConfig(configFile);
  await secureDataPath(dataDirectory, tokenStoreFile);

  const oauth = start("oauth", oauthScript, oauthEnv);
  oauth.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[amazon-container] oauth exited unexpectedly (${signal || code})`);
      process.exitCode = code || 1;
      stop();
    }
  });
  await waitForOAuth(oauthPort);

  const mcp = start("mcp", mcpScript, mcpEnv);
  mcp.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[amazon-container] mcp exited unexpectedly (${signal || code})`);
      process.exitCode = code || 1;
      stop();
    }
  });

  await Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve))));
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}

main().catch((error) => {
  console.error(`[amazon-container] startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
  stop();
});
