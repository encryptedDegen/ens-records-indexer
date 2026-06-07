import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { InvalidateItem, PreloadItem, PreloadResponse } from './types.js';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
// Preload is best-effort cache warming, so we retry far less aggressively than
// invalidation — a misconfigured/unavailable preload endpoint must not stall
// the flush pipeline (and thus invalidation throughput) for ~31s per batch.
const PRELOAD_RETRY_DELAYS_MS = [1_000, 4_000];
const USER_AGENT = `ens-records-indexer/${process.env.npm_package_version ?? '0.1.0'}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeItem(item: InvalidateItem): InvalidateItem | null {
  const name = item.name?.trim().toLowerCase();
  const tokenId = item.tokenId?.trim();
  if (!name && !tokenId) return null;

  const out: InvalidateItem = { network: item.network };
  if (name) out.name = name;
  if (tokenId) out.tokenId = tokenId;
  return out;
}

function dedupeKey(item: InvalidateItem): string {
  if (item.name && item.tokenId) {
    return `${item.network}|name:${item.name}|token:${item.tokenId}`;
  }
  if (item.name) return `${item.network}|name:${item.name}`;
  return `${item.network}|token:${item.tokenId}`;
}

export function dedupeInvalidationItems(items: InvalidateItem[]): InvalidateItem[] {
  const map = new Map<string, InvalidateItem>();
  for (const item of items) {
    const normalized = normalizeItem(item);
    if (!normalized) continue;
    map.set(dedupeKey(normalized), normalized);
  }
  return [...map.values()];
}

/**
 * Derive the `/cache/preload` payload from invalidation items.
 *
 * Preload's network+name path needs a name, and we have no CIDs on hand, so
 * token-only items are dropped. `kind` is omitted, letting the service warm
 * both avatar + header by default — matching the keys this indexer watches.
 */
export function toPreloadItems(items: InvalidateItem[]): PreloadItem[] {
  const map = new Map<string, PreloadItem>();
  for (const item of items) {
    const name = item.name?.trim().toLowerCase();
    if (!name) continue;
    const key = `${item.network}|${name}`;
    if (!map.has(key)) map.set(key, { network: item.network, name });
  }
  return [...map.values()];
}

export class HttpClient {
  private readonly endpoint_invalidate: string;
  private readonly endpoint_preload: string;
  private readonly invalidateAuthToken: string;
  private readonly preloadAuthToken: string;

  constructor(
    config: AppConfig,
    private readonly logger: Logger,
  ) {
    const base = config.metadataInvalidation.baseUrl.replace(/\/+$/, '');
    this.endpoint_invalidate = `${base}/cache/invalidate`;
    this.endpoint_preload = `${base}/cache/preload`;
    this.invalidateAuthToken = config.metadataInvalidation.authToken;
    this.preloadAuthToken =
      config.metadataInvalidation.preloadAuthToken ??
      config.metadataInvalidation.authToken;
  }

  async send_invalidate(items: InvalidateItem[]): Promise<void> {
    const deduped = dedupeInvalidationItems(items);
    if (deduped.length === 0) {
      this.logger.debug('Skipping invalidation batch with no valid items');
      return;
    }

    const response = await this.postWithRetry(
      this.endpoint_invalidate,
      this.invalidateAuthToken,
      { items: deduped },
      { label: 'invalidation', itemCount: deduped.length, retryDelaysMs: RETRY_DELAYS_MS },
    );

    this.logger.info(
      { itemCount: deduped.length, status: response.status },
      'Invalidation batch sent',
    );
  }

  /**
   * Warm caches for the just-invalidated names. Best-effort: invalidation has
   * already succeeded by the time this runs, so a preload failure is logged and
   * swallowed rather than propagated.
   */
  async send_preload(items: InvalidateItem[]): Promise<void> {
    const preloadItems = toPreloadItems(items);
    if (preloadItems.length === 0) {
      this.logger.debug('Skipping preload batch with no name-bearing items');
      return;
    }

    try {
      const response = await this.postWithRetry(
        this.endpoint_preload,
        this.preloadAuthToken,
        { items: preloadItems },
        { label: 'preload', itemCount: preloadItems.length, retryDelaysMs: PRELOAD_RETRY_DELAYS_MS },
      );

      const summary = await this.readPreloadSummary(response);
      this.logger.info(
        { itemCount: preloadItems.length, status: response.status, ...summary },
        'Preload batch sent',
      );
    } catch (err) {
      this.logger.warn(
        { err, itemCount: preloadItems.length },
        'Preload batch failed; continuing (best-effort cache warming)',
      );
    }
  }

  private async readPreloadSummary(
    response: Response,
  ): Promise<{ warmed?: number; failed?: number }> {
    try {
      const json = (await response.json()) as Partial<PreloadResponse>;
      return { warmed: json.warmed, failed: json.failed };
    } catch {
      return {};
    }
  }

  private async postWithRetry(
    url: string,
    token: string,
    body: unknown,
    context: { label: string; itemCount: number; retryDelaysMs: number[] },
  ): Promise<Response> {
    const { label, itemCount, retryDelaysMs } = context;

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      let response: Response | null = null;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) return response;

        const text = await response.text();
        const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);
        const error = new Error(
          `metadata ${label} failed (${response.status}): ${text}`,
        ) as Error & { nonRetryable?: boolean };

        if (!isRetryable) {
          error.nonRetryable = true;
          throw error;
        }
        if (attempt === retryDelaysMs.length - 1) throw error;

        this.logger.warn(
          {
            attempt: attempt + 1,
            delayMs: retryDelaysMs[attempt],
            itemCount,
            status: response.status,
          },
          `Retrying ${label} after retryable HTTP error`,
        );
      } catch (err) {
        if ((err as { nonRetryable?: boolean }).nonRetryable) throw err;
        if (attempt === retryDelaysMs.length - 1) throw err;

        this.logger.warn(
          {
            attempt: attempt + 1,
            delayMs: retryDelaysMs[attempt],
            itemCount,
            status: response?.status,
            err,
          },
          `Retrying ${label} after request failure`,
        );
      }

      await sleep(retryDelaysMs[attempt]!);
    }

    // Unreachable: the loop returns the ok response or throws on the final
    // attempt. Present only so the function is provably Response-returning.
    throw new Error(`metadata ${label} exhausted retries`);
  }
}
