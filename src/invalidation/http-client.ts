import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { InvalidateItem } from './types.js';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
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

export class HttpClient {
  private readonly endpoint: string;
  private readonly authToken: string;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const base = config.metadataInvalidation.baseUrl.replace(/\/+$/, '');
    this.endpoint = `${base}/cache/invalidate`;
    this.authToken = config.metadataInvalidation.authToken;
  }

  async send(items: InvalidateItem[]): Promise<void> {
    const deduped = dedupeInvalidationItems(items);
    if (deduped.length === 0) {
      this.logger.debug('Skipping invalidation batch with no valid items');
      return;
    }

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      let response: Response | null = null;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.authToken}`,
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify({ items: deduped }),
        });

        if (response.ok) {
          this.logger.info(
            { itemCount: deduped.length, status: response.status },
            'Invalidation batch sent',
          );
          return;
        }

        const body = await response.text();
        const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);
        const error = new Error(
          `metadata invalidation failed (${response.status}): ${body}`,
        ) as Error & { nonRetryable?: boolean };

        if (!isRetryable) {
          error.nonRetryable = true;
          throw error;
        }
        if (attempt === RETRY_DELAYS_MS.length - 1) throw error;

        this.logger.warn(
          {
            attempt: attempt + 1,
            delayMs: RETRY_DELAYS_MS[attempt],
            itemCount: deduped.length,
            status: response.status,
          },
          'Retrying invalidation after retryable HTTP error',
        );
      } catch (err) {
        if ((err as { nonRetryable?: boolean }).nonRetryable) throw err;
        if (attempt === RETRY_DELAYS_MS.length - 1) throw err;

        this.logger.warn(
          {
            attempt: attempt + 1,
            delayMs: RETRY_DELAYS_MS[attempt],
            itemCount: deduped.length,
            status: response?.status,
            err,
          },
          'Retrying invalidation after request failure',
        );
      }

      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}
