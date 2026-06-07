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

type FakeClient = HttpClient & {
  send_invalidate: ReturnType<typeof vi.fn>;
  send_preload: ReturnType<typeof vi.fn>;
};

function fakeClient(): FakeClient {
  const send_invalidate = vi.fn().mockResolvedValue(undefined);
  const send_preload = vi.fn().mockResolvedValue(undefined);
  return { send_invalidate, send_preload } as unknown as FakeClient;
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

    expect(client.send_invalidate).toHaveBeenCalledTimes(1);
    const arg = client.send_invalidate.mock.calls[0]![0];
    expect(arg).toHaveLength(2);

    // preload is fired for the same chunk after a successful invalidation
    expect(client.send_preload).toHaveBeenCalledTimes(1);
    expect(client.send_preload.mock.calls[0]![0]).toBe(arg);
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

    expect(client.send_invalidate).toHaveBeenCalledTimes(1);
    expect(client.send_preload).toHaveBeenCalledTimes(1);
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
    expect(client.send_invalidate).not.toHaveBeenCalled();
    expect(client.send_preload).not.toHaveBeenCalled();
  });
});
