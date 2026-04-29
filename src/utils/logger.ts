import pino from 'pino';

export function createLogger(level: string = process.env.LOG_LEVEL || 'info') {
  return pino({
    level,
    base: { service: 'ens-records-indexer' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
