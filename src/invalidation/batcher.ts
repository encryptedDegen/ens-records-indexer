import type { Logger } from '../utils/logger.js';
import type { HttpClient } from './http-client.js';
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
 * On failure the chunk is dropped after logging. Only one chunk is in flight
 * at a time, and every request respects maxSize even when one event fans out
 * to many names while a previous request is pending.
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

  flush(reason: 'size' | 'timer' | 'shutdown' = 'timer'): Promise<void> {
    this.clearTimer();

    // Join the active drain even if its current chunk emptied the buffer.
    // In particular, shutdown must wait for that request and its preload.
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return Promise.resolve();

    this.flushing = this.drain(reason).finally(() => {
      this.flushing = null;
      this.clearTimer();

      // An add() can run between the drain resolving and this continuation.
      // Include those items before resolving callers waiting on the flush.
      if (this.buffer.length > 0) return this.flush(reason);
    });
    return this.flushing;
  }

  private async drain(reason: 'size' | 'timer' | 'shutdown'): Promise<void> {
    while (this.buffer.length > 0) {
      const chunk = this.buffer.splice(0, this.options.maxSize);
      try {
        await this.client.send_invalidate(chunk);
        this.logger.debug({ reason, itemCount: chunk.length }, 'Flushed invalidation chunk');
        // Warm caches for the names we just invalidated. Best-effort: send_preload
        // logs and swallows its own failures, so it never masks a successful flush.
        await this.client.send_preload(chunk);
      } catch (err) {
        this.logger.error(
          { err, reason, itemCount: chunk.length },
          'Failed to flush invalidation chunk',
        );
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
