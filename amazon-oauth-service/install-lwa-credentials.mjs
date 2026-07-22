import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const credentialKeys = new Set([
  "AMAZON_LWA_CLIENT_ID",
  "AMAZON_LWA_CLIENT_SECRET",
]);

export function installLwaCredentials(incoming, target) {
  if (!incoming || !target) {
    throw new Error("Credential and target file paths are required");
  }
  const temporary = `${target}.new`;

  try {
    const credentialLines = readFileSync(incoming, "utf8").trim().split(/\n/);
    if (
      credentialLines.length !== 2 ||
      credentialLines.some((line) => !credentialKeys.has(line.split("=", 1)[0]))
    ) {
      throw new Error("Unexpected credential file shape");
    }

    const existingLines = readFileSync(target, "utf8")
      .split(/\n/)
      .filter((line) => line && !credentialKeys.has(line.split("=", 1)[0]));

    writeFileSync(
      temporary,
      `${existingLines.concat(credentialLines).join("\n")}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    for (const path of [incoming, temporary]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  installLwaCredentials(
    process.argv[2],
    process.argv[3] || "/etc/amazon-oauth-service.env",
  );
  console.log("Amazon LWA credentials installed");
}
