# Contributing

## Development

Requirements: Node.js >= 22.13 and [Bun](https://bun.sh/).

```bash
bun install
bun run typecheck    # tsc --noEmit
bun run test:unit    # unit tests
bun run build        # compile to dist/
```

The full release gate (adds the Python acceptance-script tests and a diff check):

```bash
bun run ci-gate
```

## Architecture notes

This is the single-user build. It binds loopback only, runs unauthenticated MCP,
and stores everything under `storage.dataDirectory`. There is no PostgreSQL, no
Redis, and no Connected Account Protocol — see `README.md`.

Every request runs as the fixed local owner defined in `src/local-identity.ts`.
If you add a route, it needs no authentication, but it must not assume more than
one owner.

## Pull requests

- One logical change per PR.
- Keep `bun run ci-gate` green.
- Do not commit `config.yaml`, `.env`, or anything under `storage.dataDirectory`.
  These hold LWA credentials and encryption keys.
