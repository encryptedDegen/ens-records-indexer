# ens-records-indexer

Standalone ENS records indexer that watches Ethereum for resolver text-record changes and POSTs cache-invalidation requests to the [`ens-metadata-flarecloud`](https://github.com/grailsmarket) metadata service.

This is the extracted indexer half of [grailsmarket/backend#178](https://github.com/grailsmarket/backend/pull/178), repackaged as a single deployable Node service.

## Deploy on Railway

Railway one-click deploy buttons require a Railway template. After creating a template from this repo, add the template code to this button URL:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/YOUR_TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=ens-records-indexer)
```

## What it does

- Polls Ethereum for `TextChanged` events from ENS public resolvers (current + legacy).
- Filters to keys we care about — currently **`avatar`** and **`header`**.
- Resolves the affected node hash to an ENS name via The Graph's ENS subgraph (namehash first, labelhash fallback).
- Batches up to 100 invalidations every 2 s and POSTs them to `/cache/invalidate` with bearer auth.
- Retries `408/429/502/503/504` with backoff `1, 2, 4, 8, 16 s`. Fails fast on non-retryable status codes.
- Persists last-processed-block to `data/state.json` so restarts don't re-emit work.

## Architecture

```
Ethereum logs ──► ENSIndexer ──► InvalidationBatcher ──► HttpClient ──► /cache/invalidate
                  (poll loop)     (debounce + dedupe)     (retry/backoff)
                       │
                       └─► NameResolver ──► The Graph ENS subgraph
                       │
                       └─► StateStore ──► data/state.json
```

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `RPC_URL` | yes | — | Ethereum RPC (Alchemy/Infura) |
| `CHAIN_ID` | yes | — | `1` mainnet, `11155111` sepolia, `17000` holesky |
| `METADATA_INVALIDATION_BASE_URL` | yes | — | Base URL of the metadata service |
| `METADATA_INVALIDATION_AUTH_TOKEN` | yes | — | Bearer token |
| `THE_GRAPH_ENS_SUBGRAPH_URL` | yes | — | Subgraph endpoint URL |
| `THE_GRAPH_API_KEY` | no | — | Sent as `Bearer` if set |
| `START_BLOCK` | no | latest − 25 | Used only on first run |
| `POLL_INTERVAL_MS` | no | 2000 | |
| `CONFIRMATIONS` | no | 12 | Match grailsmarket indexer |
| `LOG_RANGE_BLOCKS` | no | 100 | Blocks per `eth_getLogs` request; use `5` for QuickNode Discover plan |
| `BATCH_WINDOW_MS` | no | 2000 | |
| `BATCH_MAX_SIZE` | no | 100 | |
| `STATE_PATH` | no | `./data/state.json` | |
| `PORT` | no | 8080 | Healthcheck server |
| `LOG_LEVEL` | no | `info` | pino levels |

## Running locally

```bash
npm install
cp .env.example .env  # fill in secrets
npm run dev
```

Health endpoints:

- `GET /health` → 200 if a block was processed in the last 60 s, 503 otherwise.
- `GET /` (or `/status`) → JSON with last-processed-block, lag, network.

## Deployment

`Dockerfile` and `railway.json` are ready. On Railway:

1. Connect the repo, pick "Dockerfile" builder.
2. Set the env vars above.
3. Mount a volume at `./data` to persist `state.json` across deploys.
4. If using QuickNode's Discover plan, set `LOG_RANGE_BLOCKS=5`.

## v1 known gaps

These exist in the source PR (`grailsmarket/backend#178`) and we've preserved them in v1:

- **Only avatar + header keys are invalidated.** Other text records (description, url, etc.) are ignored.
- **Only the three known PublicResolver addresses are watched.** Custom resolvers are ignored.
- **No `AddrChanged` / `NewResolver` / `NameWrapped` / `NameUnwrapped` events.** The grailsmarket WAL listener used to catch some of these via DB triggers; this standalone service does not.
- **No `NameRegistered` / `Transfer` / `NameRenewed`.** Same reason.

v1.1 will fold these in with a topic-only resolver filter and direct onchain event coverage.

## Why not just use the grailsmarket pipeline?

We are still using it. This service is a focused, decoupled deployment that doesn't need Postgres, pg-boss, Elasticsearch, or the API service to function. It's intended to either replace or shadow that pipeline — see the migration plan in `ens-indexer-extraction-plan.md`.

## Layout

```
src/
├── index.ts                    # entrypoint
├── config.ts                   # zod-validated env config
├── abis/publicResolver.ts      # TextChanged ABIs + resolver addresses
├── indexer/
│   ├── ens-indexer.ts          # poll loop, log filtering, dispatch
│   ├── name-resolver.ts        # The Graph node→name lookup
│   └── state.ts                # last-processed-block persistence
├── invalidation/
│   ├── batcher.ts              # debounce + flush
│   ├── http-client.ts          # POST + retry/backoff + dedupe
│   └── types.ts
├── http/healthcheck.ts         # /health, /status
└── utils/logger.ts             # pino
tests/
├── batcher.test.ts
├── http-client.test.ts
└── config.test.ts
```

## License

MIT
