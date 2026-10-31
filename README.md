# ens-records-indexer

Standalone ENS records indexer that watches Ethereum for resolver record changes and POSTs cache-invalidation requests to the ENS metadata service. ENS V1 indexing remains enabled; ENS V2 support is opt-in alongside it.

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
- After each successful invalidation, POSTs the same names to `/cache/preload` to warm avatar + header images. Preload is best-effort — failures are logged and swallowed so they never block invalidation.
- Retries `408/429/502/503/504` with backoff `1, 2, 4, 8, 16 s`. Fails fast on non-retryable status codes.
- Persists last-processed-block to `data/state.json` so restarts don't re-emit work.
- When configured, also polls ENS V2 event topics across all resolver addresses, resolves bundle membership through the ENS worker, and invalidates each affected name and registry/token tuple.
- Tracks V2 resolver assignments from deployment, including assignments made before a registry is attached. This preserves the information needed to invalidate names after a default bundle is removed.

## Architecture

```
Ethereum logs ──► ENSIndexer ──► InvalidationBatcher ──► HttpClient ──► /cache/invalidate
                  (poll loop)     (debounce + dedupe)     (retry/backoff)  └─► /cache/preload (best-effort)
                       │
                       └─► NameResolver ──► The Graph ENS subgraph
                       │
                       └─► StateStore ──► data/state.json
                       │
                       └─► EnsV2Processor ──► ENS worker (bundle membership + token identities)
```

## Configuration

Set the following environment variables:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `RPC_URL` | yes | — | Ethereum RPC (Alchemy/Infura) |
| `CHAIN_ID` | yes | — | `1` mainnet, `11155111` sepolia, `17000` holesky |
| `METADATA_INVALIDATION_BASE_URL` | yes | — | Base URL of the metadata service |
| `METADATA_INVALIDATION_AUTH_TOKEN` | yes | — | Bearer token for `/cache/invalidate` (alias: `CACHE_INVALIDATION_AUTH_TOKEN`) |
| `CACHE_PRELOAD_TOKEN` | no | invalidation token | Bearer token for `/cache/preload` if the service scopes it separately (aliases: `METADATA_PRELOAD_AUTH_TOKEN`, `CACHE_PRELOAD_AUTH_TOKEN`) |
| `THE_GRAPH_ENS_SUBGRAPH_URL` | yes | — | Subgraph endpoint URL |
| `THE_GRAPH_API_KEY` | no | — | Sent as `Bearer` if set |
| `START_BLOCK` | no | latest − 25 | Used only on first run |
| `POLL_INTERVAL_MS` | no | 2000 | |
| `CONFIRMATIONS` | no | 12 | Match grailsmarket indexer |
| `LOG_RANGE_BLOCKS` | no | 100 | Blocks per `eth_getLogs` request; use `5` for QuickNode Discover plan |
| `BATCH_WINDOW_MS` | no | 2000 | |
| `BATCH_MAX_SIZE` | no | 100 | Maximum 100, matching the metadata API limit |
| `ENS_V2_WORKER_URL` | no | disabled | ENS worker with V2 indexing enabled, on the same network as `CHAIN_ID`; requires `ENS_V2_START_BLOCK` |
| `ENS_V2_START_BLOCK` | with V2 | — | Inclusive deployment block, at or before the earliest V2 `ResolverUpdated`; independent of the V1 `START_BLOCK` and checkpoint |
| `STATE_PATH` | no | `./data/state.json` | |
| `PORT` | no | 8080 | Healthcheck server |
| `LOG_LEVEL` | no | `info` | pino levels |

## Running locally

```bash
npm install
# Export the environment variables above in your shell.
npm run dev
```

Health endpoints:

- `GET /health` → 200 if a block was processed in the last 60 s, 503 otherwise.
- `GET /` (or `/status`) → JSON with last-processed-block, lag, network.

With V2 enabled, status also includes `ensV2.lastProcessedBlock` and `ensV2.lagBlocks`. Health requires recent progress from both streams.

## ENS V2 record invalidation

Enable V2 by setting both `ENS_V2_WORKER_URL` and `ENS_V2_START_BLOCK`. Use the worker and deployment block configured for your backend's network. V2 is additive: the existing V1 Graph endpoint and resolver subscriptions are still used.

The worker must expose `/health`, `/v2/n/:name`, `/v2/token/:registry/:tokenId`, `/v2/resolvers/:address`, and `/v2/resolvers/:address/records/:id/names`. These are the APIs implemented by [ensv2-records](https://github.com/Nomentum-Labs/ensv2-records). The worker must report the matching chain and have indexed at least the end of the event range. Failed lookups, lag, invalid responses, and inconsistent pagination retry the range without advancing the V2 checkpoint.

| Event | Invalidations |
|---|---|
| `TextUpdated` for `avatar` or `header` | Every name linked to the bundle, including names inheriting it as the default |
| `AddressUpdated` | The bundle's names, since address changes can affect NFT avatar ownership checks |
| `Cleared` | The bundle's names; supported for compatibility although current contracts do not emit it |
| `Linked` for a name | That name, including unlinking with record ID zero |
| `Linked` for the root | Historical resolver assignments plus the current default bundle's names, including when the default is removed |
| `ResolverUpdated` | The name and its event/current registry-token identities; also retains the resolver assignment |
| `TokenRegenerated` | Both old and new token IDs, plus the current ID if the worker is ahead |

Record IDs are scoped to their emitting resolver and are never used as name hashes or token IDs. Named links are DNS-decoded and checked against their node. Bundle names are paginated with `include_unregistered=true`, so explicitly linked V1 names are also invalidated. V2 requests include `{ network, name, contract, tokenId }`; `contract` is the parent registry. Preloading remains name-based.

On first enablement, V2 replays from its deployment block even if V1 is already at the tip. The V1 stream continues between V2 ranges. Persist the state file on a volume: it contains separate cursors and historical resolver assignments. Changing the deployment block or chain requires a new state path. Corrupt state now fails startup instead of silently losing this history.

The assignment history is intentionally retained after resolver changes, so default changes may cause harmless extra invalidations. This is necessary because the worker no longer enumerates names inheriting a default after that default is removed. Start V2 at the deployment block, not at the current tip, to build complete history.

Event definitions and bundle semantics follow the [ENS V2 indexing guide](https://docs.ens.domains/ensv2/indexing/).

## Deployment

`Dockerfile` and `railway.json` are ready. On Railway:

1. Connect the repo, pick "Dockerfile" builder.
2. Set the env vars above.
3. Mount a volume at `./data` to persist `state.json` across deploys.
4. If using QuickNode's Discover plan, set `LOG_RANGE_BLOCKS=5`.

## Known gaps

The original V1 subscriptions retain these limitations:

- **Only avatar + header keys are invalidated.** Other text records (description, url, etc.) are ignored.
- **Only the three known PublicResolver addresses are watched.** Custom resolvers are ignored.
- **No `AddrChanged` / `NewResolver` / `NameWrapped` / `NameUnwrapped` events.** The grailsmarket WAL listener used to catch some of these via DB triggers; this standalone service does not.
- **No `NameRegistered` / `Transfer` / `NameRenewed`.** Same reason.

V2 support here covers record changes, links, resolver assignments, and token regeneration. It does not provide general registration, expiry, transfer, or registry hierarchy invalidation. The worker supplies current name/token identities; this service does not reconstruct historical subtree names or every alias of a shared subregistry.

V1 names using a PermissionedResolver are covered when explicitly linked to a bundle. V1 names that only inherit its default bundle are not enumerated by the worker; supporting those also requires indexing V1 registry resolver assignments.

Invalidation delivery retains the existing best-effort policy: failed HTTP batches are logged and dropped after retries, and pending batches live in memory. The checkpoint tracks indexed events, not durable HTTP delivery. An abrupt shutdown can lose pending invalidations; graceful shutdown waits for the active range and then drains the batcher. Preload failures never block invalidation.

## Why not just use the grailsmarket pipeline?

We are still using it. This service is a focused, decoupled deployment that doesn't need Postgres, pg-boss, Elasticsearch, or the API service to function. It's intended to either replace or shadow that pipeline — see the migration plan in `ens-indexer-extraction-plan.md`.

## Layout

```
src/
├── index.ts                    # entrypoint
├── config.ts                   # zod-validated env config
├── abis/publicResolver.ts      # V1 TextChanged ABIs + resolver addresses
├── abis/ensV2.ts               # V2 record, link, and registry event ABIs
├── indexer/
│   ├── ens-indexer.ts          # poll loop, log filtering, dispatch
│   ├── name-resolver.ts        # The Graph node→name lookup
│   ├── ens-v2-worker.ts        # paginated worker topology/identity lookups
│   ├── ens-v2-processor.ts     # V2 event fan-out and resolver assignment history
│   └── state.ts                # V1/V2 cursors and resolver history persistence
├── invalidation/
│   ├── batcher.ts              # debounce + flush
│   ├── http-client.ts          # invalidate + preload POSTs, retry/backoff, dedupe
│   └── types.ts
├── http/healthcheck.ts         # /health, /status
└── utils/logger.ts             # pino
tests/
├── batcher.test.ts
├── ens-indexer.test.ts
├── ens-v2-processor.test.ts
├── ens-v2-worker.test.ts
├── http-client.test.ts
├── state.test.ts
└── config.test.ts
```

## License

MIT
