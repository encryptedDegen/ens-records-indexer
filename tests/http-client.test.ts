import { describe, expect, it } from 'vitest';
import {
  dedupeInvalidationItems,
  toPreloadItems,
} from '../src/invalidation/http-client.js';

describe('dedupeInvalidationItems', () => {
  it('drops items with neither name nor tokenId', () => {
    const out = dedupeInvalidationItems([
      { network: 'mainnet' },
      { network: 'mainnet', name: '' },
      { network: 'mainnet', tokenId: '' },
    ]);
    expect(out).toEqual([]);
  });

  it('lowercases names and trims tokenIds', () => {
    const out = dedupeInvalidationItems([
      { network: 'mainnet', name: 'Foo.ETH', tokenId: '  123  ' },
    ]);
    expect(out).toEqual([{ network: 'mainnet', name: 'foo.eth', tokenId: '123' }]);
  });

  it('dedupes by (network, name, tokenId)', () => {
    const out = dedupeInvalidationItems([
      { network: 'mainnet', name: 'foo.eth', tokenId: '1' },
      { network: 'mainnet', name: 'FOO.ETH', tokenId: '1' },
      { network: 'sepolia', name: 'foo.eth', tokenId: '1' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps name-only and token-only as separate keys', () => {
    const out = dedupeInvalidationItems([
      { network: 'mainnet', name: 'foo.eth' },
      { network: 'mainnet', tokenId: '1' },
      { network: 'mainnet', name: 'foo.eth', tokenId: '1' },
    ]);
    expect(out).toHaveLength(3);
  });
});

describe('toPreloadItems', () => {
  it('drops token-only items (no name to warm)', () => {
    const out = toPreloadItems([
      { network: 'mainnet', tokenId: '1' },
      { network: 'mainnet', name: '' },
    ]);
    expect(out).toEqual([]);
  });

  it('lowercases and trims names, omitting tokenId and kind', () => {
    const out = toPreloadItems([
      { network: 'mainnet', name: '  Foo.ETH  ', tokenId: '123' },
    ]);
    expect(out).toEqual([{ network: 'mainnet', name: 'foo.eth' }]);
  });

  it('dedupes by (network, name)', () => {
    const out = toPreloadItems([
      { network: 'mainnet', name: 'foo.eth', tokenId: '1' },
      { network: 'mainnet', name: 'FOO.ETH', tokenId: '2' },
      { network: 'sepolia', name: 'foo.eth' },
    ]);
    expect(out).toEqual([
      { network: 'mainnet', name: 'foo.eth' },
      { network: 'sepolia', name: 'foo.eth' },
    ]);
  });
});
