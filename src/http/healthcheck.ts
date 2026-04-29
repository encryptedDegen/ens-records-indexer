import http from 'node:http';
import type { ENSIndexer } from '../indexer/ens-indexer.js';
import type { Logger } from '../utils/logger.js';

export interface HealthcheckServer {
  close: () => Promise<void>;
}

const STALE_THRESHOLD_MS = 60_000;

export function startHealthcheckServer(
  port: number,
  indexer: ENSIndexer,
  logger: Logger,
): HealthcheckServer {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const status = indexer.status();
    const lagMs = status.lastBlockProcessedAt
      ? Date.now() - status.lastBlockProcessedAt
      : Number.POSITIVE_INFINITY;
    const healthy = lagMs < STALE_THRESHOLD_MS;

    if (url.startsWith('/health')) {
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: healthy,
          lagMs: Number.isFinite(lagMs) ? lagMs : null,
          ...status,
        }),
      );
      return;
    }

    if (url === '/' || url.startsWith('/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'ens-records-indexer',
          version: process.env.npm_package_version ?? '0.1.0',
          status,
          lagMs: Number.isFinite(lagMs) ? lagMs : null,
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => {
    logger.info({ port }, 'Healthcheck server listening');
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
