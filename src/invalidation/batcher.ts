import type { Logger } from '../utils/logger.js';
import { HttpClient } from './http-client.js';
import type { InvalidateItem } from './types.js';

export interface BatcherOptions {
  windowMs: number;
  maxSize: number;
}

/**
 * In-process debouncer + flusher.
 *
 * Replaces the pg-boss + workers tier from grailsmarket/backend PR #178.
 * - collect items via add()
 * - flush whenever buffer reaches maxSize, or windowMs elapses since first item
 * - delegates HTTP/retry to HttpClient
 *
 * On non-retryable failure the chunk is dropped after logging — same behaviour
 * as the original pg-boss worker which would also fail-fast and retire the job.
 */
export class InvalidationBatcher {
  private buffer: InvalidateItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly client: HttpClient,
    private readonly options: BatcherOptions,
    private readonly logger: Logger,
  ) {}

  add(item: InvalidateItem): void {
    if (this.stopped) {
      this.logger.warn({ item }, 'Dropping invalidation; batcher stopped');
      return;
    }

    this.buffer.push(item);

    if (this.buffer.length >= this.options.maxSize) {
      void this.flush('size');
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush('timer');
      }, this.options.windowMs);
    }
  }

  async flush(reason: 'size' | 'timer' | 'shutdown' = 'timer'): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    if (this.flushing) await this.flushing.catch(() => undefined);

    const chunk = this.buffer.splice(0, this.buffer.length);
    this.flushing = (async () => {
      try {
        await this.client.send(chunk);
        this.logger.debug({ reason, itemCount: chunk.length }, 'Flushed invalidation chunk');
      } catch (err) {
        this.logger.error(
          { err, reason, itemCount: chunk.length },
          'Failed to flush invalidation chunk',
        );
      }
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush('shutdown');
  }

  pendingCount(): number {
    return this.buffer.length;
  }
}
