import { z } from 'zod';

const ENV_VAR_LABELS: Record<string, string> = {
  rpcUrl: 'RPC_URL',
  chainId: 'CHAIN_ID',
  startBlock: 'START_BLOCK',
  pollIntervalMs: 'POLL_INTERVAL_MS',
  confirmations: 'CONFIRMATIONS',
  logRangeBlocks: 'LOG_RANGE_BLOCKS',
  batchWindowMs: 'BATCH_WINDOW_MS',
  batchMaxSize: 'BATCH_MAX_SIZE',
  'metadataInvalidation.baseUrl': 'METADATA_INVALIDATION_BASE_URL',
  'metadataInvalidation.authToken':
    'METADATA_INVALIDATION_AUTH_TOKEN or CACHE_INVALIDATION_AUTH_TOKEN',
  'theGraph.ensSubgraphUrl': 'THE_GRAPH_ENS_SUBGRAPH_URL',
  'theGraph.apiKey': 'THE_GRAPH_API_KEY',
  statePath: 'STATE_PATH',
  port: 'PORT',
  logLevel: 'LOG_LEVEL',
};

const ConfigSchema = z.object({
  rpcUrl: z.string().url(),
  chainId: z.number().int().positive(),
  startBlock: z.number().int().nonnegative().optional(),
  pollIntervalMs: z.number().int().positive().default(2_000),
  confirmations: z.number().int().nonnegative().default(12),
  logRangeBlocks: z.number().int().positive().default(100),
  batchWindowMs: z.number().int().positive().default(2_000),
  batchMaxSize: z.number().int().positive().default(100),
  metadataInvalidation: z.object({
    baseUrl: z.string().url(),
    authToken: z.string().min(1),
  }),
  theGraph: z.object({
    ensSubgraphUrl: z.string().url(),
    apiKey: z.string().optional(),
  }),
  statePath: z.string().default('./data/state.json'),
  port: z.number().int().positive().default(8080),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function parseIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function loadConfig(): AppConfig {
  const raw = {
    rpcUrl: readEnv('RPC_URL'),
    chainId: parseIntEnv(readEnv('CHAIN_ID')),
    startBlock: parseIntEnv(readEnv('START_BLOCK')),
    pollIntervalMs: parseIntEnv(readEnv('POLL_INTERVAL_MS')),
    confirmations: parseIntEnv(readEnv('CONFIRMATIONS')),
    logRangeBlocks: parseIntEnv(readEnv('LOG_RANGE_BLOCKS')),
    batchWindowMs: parseIntEnv(readEnv('BATCH_WINDOW_MS')),
    batchMaxSize: parseIntEnv(readEnv('BATCH_MAX_SIZE')),
    metadataInvalidation: {
      baseUrl: readEnv('METADATA_INVALIDATION_BASE_URL'),
      authToken: readEnv(
        'METADATA_INVALIDATION_AUTH_TOKEN',
        'CACHE_INVALIDATION_AUTH_TOKEN',
      ),
    },
    theGraph: {
      ensSubgraphUrl: readEnv('THE_GRAPH_ENS_SUBGRAPH_URL'),
      apiKey: readEnv('THE_GRAPH_API_KEY'),
    },
    statePath: readEnv('STATE_PATH'),
    port: parseIntEnv(readEnv('PORT')),
    logLevel: readEnv('LOG_LEVEL'),
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        const envVar = ENV_VAR_LABELS[path];
        const label = envVar ? `${path} (${envVar})` : path;
        return `  ${label}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export type MetadataInvalidationNetwork = 'mainnet' | 'sepolia' | 'holesky';

export function getMetadataInvalidationNetwork(
  chainId: number,
): MetadataInvalidationNetwork | null {
  switch (chainId) {
    case 1:
      return 'mainnet';
    case 11155111:
      return 'sepolia';
    case 17000:
      return 'holesky';
    default:
      return null;
  }
}
