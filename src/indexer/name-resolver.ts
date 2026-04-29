import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';

export interface ResolvedNameData {
  name: string | null;
  correctTokenId: string | null;
}

/**
 * Resolve an ENS node hash (from a TextChanged event) to a name + canonical
 * tokenId, via The Graph's ENS subgraph.
 *
 * Strategy mirrors grailsmarket/backend services/indexer/src/services/ens-resolver.ts:
 *   1. Try as a namehash (domain id). Catches wrapped names + subnames.
 *   2. If miss, try as a labelhash with parent=eth. Catches unwrapped 2LD .eth.
 *
 * Returns null if both lookups fail or the response shape is unexpected.
 */
export class NameResolver {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async resolveTokenIdToNameData(tokenId: string): Promise<ResolvedNameData | null> {
    let hex: string;
    try {
      hex = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
    } catch {
      this.logger.warn({ tokenId }, 'Cannot convert tokenId to hex');
      return null;
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.theGraph.apiKey) {
      headers.authorization = `Bearer ${this.config.theGraph.apiKey}`;
    }

    // ── 1. Namehash lookup ──────────────────────────────────────────
    const namehashQuery = `
      query ByNamehash($namehash: String!) {
        domain(id: $namehash) {
          id
          name
          labelName
          labelhash
        }
      }
    `;
    try {
      const res = await fetch(this.config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: namehashQuery, variables: { namehash: hex } }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { domain?: { id: string; name?: string; labelhash?: string } };
          errors?: unknown;
        };
        if (!json.errors && json.data?.domain?.name) {
          return {
            name: json.data.domain.name,
            correctTokenId: tokenId,
          };
        }
      } else {
        this.logger.warn(
          { status: res.status, lookup: 'namehash' },
          'Subgraph namehash lookup non-OK',
        );
      }
    } catch (err) {
      this.logger.warn({ err, lookup: 'namehash' }, 'Subgraph namehash lookup failed');
    }

    // ── 2. Labelhash fallback (unwrapped 2LD .eth) ──────────────────
    const labelhashQuery = `
      query ByLabelhash($labelhash: String!) {
        domains(
          where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }
          first: 1
        ) {
          id
          name
          labelhash
        }
      }
    `;
    try {
      const res = await fetch(this.config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: labelhashQuery, variables: { labelhash: hex } }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { domains?: Array<{ id: string; name?: string }> };
          errors?: unknown;
        };
        const domain = json.data?.domains?.[0];
        if (!json.errors && domain?.name) {
          // tokenId for unwrapped 2LD names is the labelhash (same as input).
          return { name: domain.name, correctTokenId: tokenId };
        }
      } else {
        this.logger.warn(
          { status: res.status, lookup: 'labelhash' },
          'Subgraph labelhash lookup non-OK',
        );
      }
    } catch (err) {
      this.logger.warn({ err, lookup: 'labelhash' }, 'Subgraph labelhash lookup failed');
    }

    return null;
  }
}
