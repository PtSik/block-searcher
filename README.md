# Block Searcher

A TypeScript HTTP API that maps Unix timestamps to nearby Ethereum blocks or Solana slots,
and looks up a timestamp from a block number or slot. Built with Hono on Cloudflare Workers.

The project demonstrates JSON-RPC integration, binary search, request validation and tests
running in the Workers runtime. It is an experimental lookup service, not a blockchain indexer.

## Quick start

Requirements: Node.js 22 or later and npm. Tests use mocked RPC responses and need no API keys.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

To query a real network locally:

```bash
cp .dev.vars.example .dev.vars
# Replace the example URLs with your own Ethereum and Solana RPC endpoints.
npm run dev
```

Only the endpoint for the requested chain is required. Keep credential-bearing RPC URLs in
`.dev.vars` locally and Worker secrets in production, never in source or `[vars]`.
See [Cloudflare's secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

## API

`GET /api` accepts exactly one lookup mode. `chain` is `evm` (default) or `solana`.
`evm` targets the Ethereum network configured by `EVM_RPC_URL`; there is no network selector.

```bash
# Unix seconds -> closest block; up to five comma-separated timestamps
curl 'http://localhost:8787/api?chain=evm&timestamps=1700000000,1700000060'

# Block number -> Unix seconds
curl 'http://localhost:8787/api?chain=evm&blockNumber=18000000'

# Solana slot -> Unix seconds
curl 'http://localhost:8787/api?chain=solana&blockNumber=250000000'
```

Responses map each input string to a number. For a synthetic chain whose block 0 has timestamp
100 and block 1 has timestamp 110, `/api?timestamps=100` returns `{"100":0}` and
`/api?blockNumber=1` returns `{"1":110}`.

| Situation | Response |
| --- | --- |
| Successful lookup | `200`, input-to-result map |
| Failed item in a timestamp batch | `200`, that input maps to `null` |
| Invalid chain, input or conflicting lookup modes | `400` |
| Missing RPC configuration | `503` |
| Failed block/slot-to-timestamp lookup | `502`, generic error |

Inputs must be non-negative safe integers. Timestamps are seconds, not milliseconds.
Provider error details are not returned because they can contain credentials.

## Search and tradeoffs

The Ethereum search compares the target timestamp with the middle block and halves the range
until it finds an exact match or the nearest visited block: O(log N) RPC lookups, assuming
monotonic block timestamps. Ties retain the first equally close candidate visited. Targets
outside the chain's time range resolve to the nearest boundary block.

Solana uses a binary search and a bounded neighboring-slot refinement. **This implementation
requires timestamps to be available for the queried slots, including slot 0.** Skipped slots
and pruned RPC history can make a lookup fail; the API does not claim to solve sparse historical
slot lookup. The refinement stops when it finds a candidate within 60 seconds or reaches its
search limit, so it is approximate rather than a guarantee of the globally nearest slot.

Timestamp caches belong to a single request. This prevents data from one RPC configuration
being reused by another and avoids a growing process-wide cache, at the cost of more RPC calls
across requests. Transient timestamp fetches retry at most three times. Batches run sequentially
and are limited to five inputs.

Before exposing a paid endpoint broadly, configure provider quotas and edge rate limiting.
There is no application-level authentication, persistent cache or reorganization tracking.

## Project map

- `src/index.ts`: Hono application and routes.
- `src/routes/api.ts`: validation, configuration and response contract.
- `src/utils/block-fetcher.ts`: request-scoped RPC client and search algorithms.
- `test/block.fetcher.test.ts`: synthetic-chain and HTTP behavior tests; no live RPC calls.
- `.github/workflows/ci.yml`: typecheck, tests and a dry-run bundle build; no automatic deploy.

## Deployment

`npm run build` packages the Worker locally without publishing it. Configure your own
Cloudflare account, Worker name and `EVM_RPC_URL` / `SOLANA_RPC_URL` secrets before a real
deployment. `npm run deploy` publishes to the selected account; it is separate from CI.

Use npm and the committed `package-lock.json` for reproducible installs.
