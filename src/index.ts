import { loadConfig } from './config.js';
import { ENSIndexer } from './indexer/ens-indexer.js';
import { InvalidationBatcher } from './invalidation/batcher.js';
import { HttpClient } from './invalidation/http-client.js';
import { startHealthcheckServer } from './http/healthcheck.js';
import { createLogger } from './utils/logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(
    {
      chainId: config.chainId,
      confirmations: config.confirmations,
      logRangeBlocks: config.logRangeBlocks,
      pollIntervalMs: config.pollIntervalMs,
      batchWindowMs: config.batchWindowMs,
      batchMaxSize: config.batchMaxSize,
    },
    'Starting ens-records-indexer',
  );

  const httpClient = new HttpClient(config, logger);
  const batcher = new InvalidationBatcher(
    httpClient,
    { windowMs: config.batchWindowMs, maxSize: config.batchMaxSize },
    logger,
  );
  const indexer = new ENSIndexer(config, batcher, logger);
  await indexer.start();

  const server = startHealthcheckServer(config.port, indexer, logger);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    try {
      await indexer.stop();
      await batcher.stop();
      await server.close();
    } catch (err) {
      logger.error({ err }, 'Shutdown error');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
