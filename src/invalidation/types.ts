import type { MetadataInvalidationNetwork } from '../config.js';

export interface InvalidateItem {
  network: MetadataInvalidationNetwork;
  name?: string;
  tokenId?: string;
}

export type { MetadataInvalidationNetwork };
