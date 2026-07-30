import { spawnSync } from "node:child_process";

const image = process.argv[2] || process.env.AMAZON_IMAGE || "amazon-sp-api:local";
const inspect = spawnSync(
  "docker",
  ["image", "inspect", image, "--format", "{{json .Config}}"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (inspect.status !== 0) {
  if (inspect.stderr) process.stderr.write(inspect.stderr);
  process.exit(inspect.status || 1);
}
const config = JSON.parse(inspect.stdout);
const ports = Object.keys(config.ExposedPorts ?? {});
if (ports.length !== 1 || ports[0] !== "8789/tcp") {
  throw new Error(`runtime image must expose only 8789/tcp; received ${ports.join(",")}`);
}
if (JSON.stringify(config.Entrypoint) !== JSON.stringify(["node", "/app/dist/server.js"])) {
  throw new Error(`runtime image entrypoint is not the single Node service: ${JSON.stringify(config.Entrypoint)}`);
}
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    `
      const fs = await import("node:fs");
      await import("/app/dist/server.js");
      if (fs.existsSync("/usr/local/bin/bun")) throw new Error("Bun must not be present in runtime image");
      if (fs.existsSync("/app/amazon-oauth-service") || fs.existsSync("/app/amazon-sp-api-mcp")) {
        throw new Error("legacy subpackages must not be present in runtime image");
      }
      if (fs.existsSync("/app/public/amazon")) {
        throw new Error("removed Amazon frontend must not be present in the runtime image");
      }
      const index = "/app/web/admin/dist/index.html";
      if (!fs.existsSync(index)) throw new Error("admin frontend index is missing from runtime image");
      const html = fs.readFileSync(index, "utf8");
      const assets = fs.readdirSync("/app/web/admin/dist/assets");
      const script = assets.find((name) => name.startsWith("index-") && name.endsWith(".js"));
      if (!script || !html.includes("/admin-config.js") || !html.includes("/assets/" + script)) {
        throw new Error("admin frontend runtime config or hashed JavaScript asset is missing");
      }
    `,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (result.error) {
  console.error(`Unable to run Docker: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status || 1;
} else {
  console.log(`Runtime imports verified in ${image}`);
}
