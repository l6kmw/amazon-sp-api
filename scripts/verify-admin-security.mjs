import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

async function files(root, extensions) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extensions.has(extname(path))) result.push(path);
    }
  }
  await walk(root);
  return result;
}

const sourceFiles = await files("web/admin/src", new Set([".ts", ".tsx"]));
const builtFiles = await files("web/admin/dist", new Set([".html", ".js", ".css"]));
const checks = [
  ["browser persistence", /\b(?:localStorage|sessionStorage|indexedDB)\b/g],
  ["native confirm", /window\.confirm\s*\(/g],
  ["fake configuration", /https:\/\/api\.example\.com|keyring_main/g],
  ["unsafe blank window", /window\.open\([^\n]*["']_blank["'](?![^\n]*noopener)/g],
  ["secret-like console output", /console\.(?:log|info|warn|error)\s*\([^)]*(?:token|secret|oauth|code|state)/gi],
  ["literal high-entropy oat token", /oat_[A-Za-z0-9_-]{32,}/g],
];
const findings = [];
for (const file of [...sourceFiles, ...builtFiles]) {
  const content = await readFile(file, "utf8");
  for (const [name, pattern] of checks) {
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(`${name}: ${file}:${line}`);
    }
  }
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(`admin security: ${sourceFiles.length} source + ${builtFiles.length} built files passed`);
