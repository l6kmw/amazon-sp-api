#!/usr/bin/env bash
# Local / optional CI release gate for Amazon SP-API ConnectedAccount stack.
# Requires Node >=22.13.0 and Bun. Does not create shared remote CI without operator approval.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null; then
  echo "node is required" >&2
  exit 1
fi

if ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && (b>13 || (b===13 && c>=0))) ? 0 : 1)'; then
  echo "Node.js >= 22.13.0 required (found $(node -v))" >&2
  exit 1
fi

if ! command -v bun >/dev/null; then
  echo "Bun is required" >&2
  exit 1
fi

echo "==> install"
bun install --frozen-lockfile

echo "==> unit tests / typecheck / build"
bun run test
bun run typecheck
bun run build

echo "==> generated registry / configuration / diff checks"
node --input-type=module -e 'import { readFile } from "node:fs/promises"; import YAML from "yaml"; const value=YAML.parse(await readFile("config.example.yaml","utf8"), { uniqueKeys:true }); if (!value || typeof value!=="object" || "mcp" in value) process.exit(1)'
if rg -n 'host\.docker\.internal:8080|LegacyIdentityVerifier|identityValidationURL|identityHealthURL' src; then
  echo "removed external identity dependency found in runtime source" >&2
  exit 1
fi
git diff --check

echo "==> sensitive canary scan (source + docs)"
# Fail if obvious secret material patterns appear outside tests/fixtures.
if rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/*.test.*' \
  --glob '!**/bun.lock' --glob '!scripts/ci-gate.sh' \
  'Atza\||Atzr\||eyJhbGciOi|BEGIN (RSA |OPENSSH )?PRIVATE KEY' .; then
  echo "canary: potential secret material found" >&2
  exit 1
fi
echo "canary: no high-risk token patterns in non-test sources"

echo "==> docker config tests"
bun run test:docker-config

if [[ "${CI_GATE_DOCKER_IMAGE:-}" == "true" ]]; then
  TAG="amazon-sp-api:ci-$(git rev-parse --short HEAD)"
  echo "==> docker image runtime import ($TAG)"
  docker build -f docker/Dockerfile -t "$TAG" .
  bun run test:docker-image -- "$TAG"
fi

echo "==> ci-gate OK"
