import { describe, expect, it, vi } from 'vitest';
import { InvalidationBatcher } from '../src/invalidation/batcher.js';
import type { HttpClient } from '../src/invalidation/http-client.js';

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof InvalidationBatcher.prototype.constructor>[2];
}

function fakeClient() {
  const send = vi.fn().mockResolvedValue(undefined);
  return { send } as unknown as HttpClient & { send: ReturnType<typeof vi.fn> };
}

describe('InvalidationBatcher', () => {
  it('flushes when buffer reaches maxSize', async () => {
    const client = fakeClient();
    const batcher = new InvalidationBatcher(
      client,
      { windowMs: 10_000, maxSize: 2 },
      silentLogger(),
    );

    batcher.add({ network: 'mainnet', name: 'a.eth' });
    batcher.add({ network: 'mainnet', name: 'b.eth' });

    // size-triggered flush is fire-and-forget; await a microtask cycle
    await new Promise((r) => setImmediate(r));
    await batcher.flush();

    expect((client as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
    const arg = (client as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]![0];
    expect(arg).toHaveLength(2);
  });

  it('flushes on shutdown via stop()', async () => {
    const client = fakeClient();
    const batcher = new InvalidationBatcher(
      client,
      { windowMs: 10_000, maxSize: 100 },
      silentLogger(),
    );

    batcher.add({ network: 'mainnet', name: 'foo.eth' });
    await batcher.stop();

    expect((client as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
  });

  it('drops items added after stop()', async () => {
    const client = fakeClient();
    const batcher = new InvalidationBatcher(
      client,
      { windowMs: 10_000, maxSize: 100 },
      silentLogger(),
    );

    await batcher.stop();
    batcher.add({ network: 'mainnet', name: 'foo.eth' });

    expect(batcher.pendingCount()).toBe(0);
  });

  it('does nothing when buffer is empty', async () => {
    const client = fakeClient();
    const batcher = new InvalidationBatcher(
      client,
      { windowMs: 10, maxSize: 100 },
      silentLogger(),
    );

    await batcher.flush();
    expect((client as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
});
