import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../utils/logger.js';

const AddressSchema = z.custom<`0x${string}`>(
  (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value),
);
const BlockSchema = z.number().int().safe().nonnegative();
const V2StateSchema = z.object({
  chainId: z.number().int().positive(),
  startBlock: BlockSchema,
  lastProcessedBlock: z.number().int().safe().min(-1),
  resolverTargets: z.record(z.string().regex(/^0x[0-9a-fA-F]{40}$/), z.array(z.object({
    registry: AddressSchema,
    tokenId: z.string().regex(/^\d+$/),
  }))),
});
const StateSchema = z.object({
  lastProcessedBlock: BlockSchema,
  updatedAt: z.string().default(() => new Date().toISOString()),
  ensV2: V2StateSchema.optional(),
});

export type EnsV2State = z.infer<typeof V2StateSchema>;
export type IndexerState = z.infer<typeof StateSchema>;

export class StateStore {
  constructor(
    private readonly statePath: string,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<IndexerState | null> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      return StateSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        this.logger.info({ statePath: this.statePath }, 'No prior state file; starting fresh');
        return null;
      }
      // Silently resetting would discard the resolver history needed to
      // invalidate names when a default bundle is removed.
      throw new Error(`Failed to load indexer state at ${this.statePath}`, { cause: err });
    }
  }

  async save(state: IndexerState): Promise<void> {
    const dir = path.dirname(this.statePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, this.statePath);
  }
}
