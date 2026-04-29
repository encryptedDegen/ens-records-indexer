import { z } from 'zod';

const ConfigSchema = z.object({
  rpcUrl: z.string().url(),
  chainId: z.number().int().positive(),
  startBlock: z.number().int().nonnegative().optional(),
  pollIntervalMs: z.number().int().positive().default(2_000),
  confirmations: z.number().int().nonnegative().default(12),
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

export function loadConfig(): AppConfig {
  const raw = {
    rpcUrl: process.env.RPC_URL,
    chainId: parseIntEnv(process.env.CHAIN_ID),
    startBlock: parseIntEnv(process.env.START_BLOCK),
    pollIntervalMs: parseIntEnv(process.env.POLL_INTERVAL_MS),
    confirmations: parseIntEnv(process.env.CONFIRMATIONS),
    batchWindowMs: parseIntEnv(process.env.BATCH_WINDOW_MS),
    batchMaxSize: parseIntEnv(process.env.BATCH_MAX_SIZE),
    metadataInvalidation: {
      baseUrl: process.env.METADATA_INVALIDATION_BASE_URL,
      authToken: process.env.METADATA_INVALIDATION_AUTH_TOKEN,
    },
    theGraph: {
      ensSubgraphUrl: process.env.THE_GRAPH_ENS_SUBGRAPH_URL,
      apiKey: process.env.THE_GRAPH_API_KEY,
    },
    statePath: process.env.STATE_PATH,
    port: parseIntEnv(process.env.PORT),
    logLevel: process.env.LOG_LEVEL,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
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
