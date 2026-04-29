import { afterEach, describe, expect, it } from 'vitest';
import { getMetadataInvalidationNetwork, loadConfig } from '../src/config.js';

const ENV_KEYS = [
  'RPC_URL',
  'CHAIN_ID',
  'METADATA_INVALIDATION_BASE_URL',
  'METADATA_INVALIDATION_AUTH_TOKEN',
  'THE_GRAPH_ENS_SUBGRAPH_URL',
  'THE_GRAPH_API_KEY',
  'PORT',
  'CONFIRMATIONS',
];

function setEnv(values: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('getMetadataInvalidationNetwork', () => {
  it('maps known chain ids', () => {
    expect(getMetadataInvalidationNetwork(1)).toBe('mainnet');
    expect(getMetadataInvalidationNetwork(11155111)).toBe('sepolia');
    expect(getMetadataInvalidationNetwork(17000)).toBe('holesky');
  });

  it('returns null for unknown chain ids', () => {
    expect(getMetadataInvalidationNetwork(8453)).toBeNull();
  });
});

describe('loadConfig', () => {
  it('loads with required env vars', () => {
    setEnv({
      RPC_URL: 'https://eth.example.com',
      CHAIN_ID: '1',
      METADATA_INVALIDATION_BASE_URL: 'https://meta.example.com',
      METADATA_INVALIDATION_AUTH_TOKEN: 'tok',
      THE_GRAPH_ENS_SUBGRAPH_URL: 'https://graph.example.com',
    });
    const cfg = loadConfig();
    expect(cfg.chainId).toBe(1);
    expect(cfg.confirmations).toBe(12);
    expect(cfg.batchMaxSize).toBe(100);
    expect(cfg.metadataInvalidation.authToken).toBe('tok');
  });

  it('throws on missing required vars', () => {
    setEnv({});
    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });
});
