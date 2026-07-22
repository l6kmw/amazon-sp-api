import { spawnSync } from "node:child_process";

const image = process.argv[2] || process.env.AMAZON_IMAGE || "amazon-sp-api:local";
const imports = [
  "/app/amazon-oauth-service/server.mjs",
  "/app/amazon-sp-api-mcp/dist/server.js",
  "/app/docker/config-loader.mjs",
];

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
    `await Promise.all(${JSON.stringify(imports)}.map((module) => import(module)));`,
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
