import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../utils/logger.js';

export interface IndexerState {
  lastProcessedBlock: number;
  updatedAt: string;
}

export class StateStore {
  constructor(
    private readonly statePath: string,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<IndexerState | null> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IndexerState>;
      if (typeof parsed.lastProcessedBlock !== 'number') return null;
      return {
        lastProcessedBlock: parsed.lastProcessedBlock,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        this.logger.info({ statePath: this.statePath }, 'No prior state file; starting fresh');
        return null;
      }
      this.logger.warn({ err }, 'Failed to read state file; starting fresh');
      return null;
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
