# Amazon SP-API model snapshot

- Source: https://github.com/amzn/selling-partner-api-models
- Commit: `6ad2ee14835a9aa31889ae5607ea4e1fcc90f3ad`
- Normalization: `bun scripts/generate-sp-api-registry.ts <checkout>`
- Coverage: 353 operations; 93 included by the read-only Seller policy.

The runtime image uses only the generated operation registry and normalized schema subset.
