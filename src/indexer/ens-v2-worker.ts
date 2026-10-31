import { z } from 'zod';
import { normalize } from 'viem/ens';
import type { MetadataInvalidationNetwork } from '../config.js';

const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_UINT256 = (1n << 256n) - 1n;
const NOT_FOUND = Symbol('not found');

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((address) => address.toLowerCase() as `0x${string}`);
const uint256Schema = z.string().regex(/^(?:0x[0-9a-fA-F]{1,64}|\d{1,78})$/)
  .pipe(z.string().refine((value) => BigInt(value) <= MAX_UINT256, 'must fit uint256'))
  .transform((value) => BigInt(value).toString());
const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const healthSchema = z.object({
  ok: z.literal(true),
  chain: z.string(),
  indexer: z.object({ last_block: safeIntegerSchema.nullable() }),
});
const resolverSchema = z.object({
  address: addressSchema,
  default_record_id: uint256Schema.nullable(),
});
const namesPageSchema = z.object({
  resolver: addressSchema,
  record_id: uint256Schema,
  is_default: z.boolean(),
  total: safeIntegerSchema,
  limit: safeIntegerSchema,
  offset: safeIntegerSchema,
  names: z.array(z.object({
    name: z.string().min(1),
    linked: z.boolean(),
    registered: z.boolean(),
  })),
});
const nameSchema = z.object({
  name: z.string().min(1),
  registry: addressSchema,
  token_id: uint256Schema.nullable(),
  status: z.enum(['registered', 'reserved', 'unregistered']),
});
const tokenSchema = nameSchema.extend({ name: z.string().min(1).nullable() });

export interface EnsV2Name {
  name: string;
  registry: `0x${string}`;
  tokenId: string;
}

/** Reads the ENS worker's indexed topology after its cursor has caught up to our logs. */
export class EnsV2Worker {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly network: MetadataInvalidationNetwork) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async assertSynced(toBlock: bigint): Promise<void> {
    const indexedBlock = await this.indexedBlock();
    if (indexedBlock < toBlock) {
      throw new Error(`ENS V2 worker is behind: indexed ${indexedBlock}, required ${toBlock}`);
    }
  }

  async getResolver(address: string): Promise<{ defaultRecordId: string | null } | null> {
    const resolver = addressSchema.parse(address);
    const path = `/v2/resolvers/${resolver}`;
    const body = await this.get(path);
    if (body === NOT_FOUND) return null;
    const result = this.parse(resolverSchema, body, path);
    if (result.address !== resolver) throw new Error('ENS V2 worker returned a different resolver');
    return { defaultRecordId: result.default_record_id };
  }

  async getRecordNames(address: string, recordId: bigint): Promise<string[]> {
    if (recordId === 0n) return []; // Zero removes a link; it is not a record bundle.
    const resolver = addressSchema.parse(address);
    const id = uint256Schema.parse(recordId.toString());
    const before = await this.indexedBlock();
    const names = new Set<string>();
    let total: number | undefined;
    let isDefault: boolean | undefined;
    let offset = 0;

    do {
      const path = `/v2/resolvers/${resolver}/records/${id}/names?limit=${PAGE_SIZE}&offset=${offset}&include_unregistered=true`;
      const body = await this.get(path);
      if (body === NOT_FOUND) {
        if (offset === 0) return [];
        throw new Error('ENS V2 worker resolver disappeared during pagination');
      }
      const page = this.parse(namesPageSchema, body, path);
      if (
        page.resolver !== resolver || page.record_id !== id ||
        page.limit !== PAGE_SIZE || page.offset !== offset ||
        (total !== undefined && page.total !== total) ||
        (isDefault !== undefined && page.is_default !== isDefault) ||
        page.names.length !== Math.min(PAGE_SIZE, page.total - offset)
      ) {
        throw new Error('ENS V2 worker returned inconsistent record-name pagination');
      }
      total = page.total;
      isDefault = page.is_default;
      for (const { name } of page.names) {
        if (names.has(name)) throw new Error('ENS V2 worker returned duplicate names during pagination');
        names.add(name);
      }
      offset += page.names.length;
    } while (offset < total);

    // Offset pages can skip names when links change between requests, even if the total
    // stays constant. A changed cursor makes the caller retry the entire block range.
    if (total > PAGE_SIZE && await this.indexedBlock() !== before) {
      throw new Error('ENS V2 worker advanced during record-name pagination');
    }
    return [...names];
  }

  async getName(name: string): Promise<EnsV2Name | null> {
    const normalizedName = normalize(name);
    const path = `/v2/n/${encodeURIComponent(normalizedName)}`;
    const body = await this.get(path);
    if (body === NOT_FOUND) return null;
    const result = this.parse(nameSchema, body, path);
    if (result.name !== normalizedName) throw new Error('ENS V2 worker returned a different name');
    // Premigrated V1 names have a reserved V2 entry but still use their V1 NFT.
    // Returning no V2 identity lets the caller invalidate the legacy name paths.
    return result.status === 'reserved' || result.token_id === null ? null : {
      name: result.name,
      registry: result.registry,
      tokenId: result.token_id,
    };
  }

  async getToken(registry: string, tokenId: bigint): Promise<EnsV2Name | null> {
    const address = addressSchema.parse(registry);
    const id = uint256Schema.parse(tokenId.toString());
    const path = `/v2/token/${address}/${id}`;
    const body = await this.get(path);
    if (body === NOT_FOUND) return null;
    const result = this.parse(tokenSchema, body, path);
    if (result.registry !== address) throw new Error('ENS V2 worker returned a different registry');
    return result.name === null || result.token_id === null ? null : {
      name: result.name,
      registry: result.registry,
      tokenId: result.token_id,
    };
  }

  private async indexedBlock(): Promise<bigint> {
    const result = this.parse(healthSchema, await this.get('/health', false), '/health');
    if (result.chain !== this.network) {
      throw new Error(`ENS V2 worker chain mismatch: expected ${this.network}, received ${result.chain}`);
    }
    if (result.indexer.last_block === null) throw new Error('ENS V2 worker has not indexed any blocks');
    return BigInt(result.indexer.last_block);
  }

  private async get(path: string, allowNotFound = true): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 && allowNotFound) return NOT_FOUND;
    if (!response.ok) throw new Error(`ENS V2 worker request failed: ${path} returned HTTP ${response.status}`);
    return response.json();
  }

  private parse<T extends z.ZodTypeAny>(schema: T, body: unknown, path: string): z.output<T> {
    const result = schema.safeParse(body);
    if (!result.success) throw new Error(`Invalid ENS V2 worker response for ${path}: ${result.error.message}`);
    return result.data;
  }
}
