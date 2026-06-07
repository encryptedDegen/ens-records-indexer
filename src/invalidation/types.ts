import type { MetadataInvalidationNetwork } from '../config.js';

export interface InvalidateItem {
  network: MetadataInvalidationNetwork;
  name?: string;
  tokenId?: string;
}

/** Which images to warm for a name. The service defaults to `both` when omitted. */
export type PreloadKind = 'avatar' | 'header' | 'both';

/**
 * A single entry for the `/cache/preload` endpoint. We only ever warm via the
 * network+name path (we have no CIDs on hand), so `name` is required here.
 */
export interface PreloadItem {
  network: MetadataInvalidationNetwork;
  name: string;
  kind?: PreloadKind;
}

/** Shape of a successful `/cache/preload` response (we only read the counts). */
export interface PreloadResponse {
  ok: boolean;
  warmed: number;
  failed: number;
  items?: unknown[];
}

export type { MetadataInvalidationNetwork };
