#!/usr/bin/env bash
# Local / optional CI release gate for Amazon SP-API ConnectedAccount stack.
# Requires Node 22+. Does not create shared remote CI without operator approval.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null; then
  echo "node is required" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Node.js >= 22 required (found $(node -v))" >&2
  exit 1
fi

echo "==> install"
npm ci
npm --prefix amazon-oauth-service ci
npm --prefix amazon-sp-api-mcp ci

echo "==> unit tests / typecheck / build"
npm test
npm run typecheck:mcp
npm run build:mcp

echo "==> sensitive canary scan (source + docs)"
# Fail if obvious secret material patterns appear outside tests/fixtures.
if rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/*.test.*' \
  --glob '!**/package-lock.json' --glob '!scripts/ci-gate.sh' \
  'Atza\||Atzr\||eyJhbGciOi|BEGIN (RSA |OPENSSH )?PRIVATE KEY' .; then
  echo "canary: potential secret material found" >&2
  exit 1
fi
echo "canary: no high-risk token patterns in non-test sources"

echo "==> docker config tests"
npm run test:docker-config

if [[ "${CI_GATE_DOCKER_IMAGE:-}" == "true" ]]; then
  TAG="amazon-sp-api:ci-$(git rev-parse --short HEAD)"
  echo "==> docker image runtime import ($TAG)"
  docker build -f docker/Dockerfile -t "$TAG" .
  npm run test:docker-image -- "$TAG"
fi

echo "==> ci-gate OK"
