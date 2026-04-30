import { createPublicClient, decodeEventLog, http, type Log, type PublicClient } from 'viem';
import { mainnet, sepolia, holesky } from 'viem/chains';
import {
  CURRENT_PUBLIC_RESOLVER_ADDRESSES,
  INVALIDATING_TEXT_KEYS,
  LEGACY_PUBLIC_RESOLVER_ADDRESS,
  TEXT_RESOLVER_EVENTS,
} from '../abis/publicResolver.js';
import {
  type AppConfig,
  getMetadataInvalidationNetwork,
  type MetadataInvalidationNetwork,
} from '../config.js';
import type { InvalidationBatcher } from '../invalidation/batcher.js';
import type { Logger } from '../utils/logger.js';
import { NameResolver } from './name-resolver.js';
import { StateStore } from './state.js';

function chainForId(chainId: number) {
  switch (chainId) {
    case 1:
      return mainnet;
    case 11155111:
      return sepolia;
    case 17000:
      return holesky;
    default:
      throw new Error(`Unsupported CHAIN_ID: ${chainId}`);
  }
}

const STARTUP_LOOKBACK_BLOCKS = 25n; // ~5 minutes on mainnet

export interface IndexerStatus {
  network: MetadataInvalidationNetwork;
  lastProcessedBlock: number;
  chainTipBlock: number;
  lagBlocks: number;
  lastBlockProcessedAt: number;
}

export class ENSIndexer {
  private readonly client: PublicClient;
  private readonly network: MetadataInvalidationNetwork;
  private readonly resolver: NameResolver;
  private readonly state: StateStore;
  private readonly confirmations: bigint;
  private readonly logRangeBlocks: bigint;

  private running = false;
  private lastProcessedBlock = 0n;
  private chainTipBlock = 0n;
  private lastBlockProcessedAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly batcher: InvalidationBatcher,
    private readonly logger: Logger,
  ) {
    const network = getMetadataInvalidationNetwork(config.chainId);
    if (!network) throw new Error(`No metadata network for chainId=${config.chainId}`);
    this.network = network;

    const chain = chainForId(config.chainId);
    this.client = createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.resolver = new NameResolver(config, logger);
    this.state = new StateStore(config.statePath, logger);
    this.confirmations = BigInt(config.confirmations);
    this.logRangeBlocks = BigInt(config.logRangeBlocks);
  }

  status(): IndexerStatus {
    return {
      network: this.network,
      lastProcessedBlock: Number(this.lastProcessedBlock),
      chainTipBlock: Number(this.chainTipBlock),
      lagBlocks: Math.max(0, Number(this.chainTipBlock - this.lastProcessedBlock)),
      lastBlockProcessedAt: this.lastBlockProcessedAt,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const tip = await this.client.getBlockNumber();
    this.chainTipBlock = tip;

    const persisted = await this.state.load();
    if (persisted) {
      this.lastProcessedBlock = BigInt(persisted.lastProcessedBlock);
      this.logger.info(
        { lastProcessedBlock: persisted.lastProcessedBlock, tip: tip.toString() },
        'Resuming from persisted state',
      );
    } else if (this.config.startBlock !== undefined) {
      this.lastProcessedBlock = BigInt(this.config.startBlock);
      this.logger.info({ startBlock: this.config.startBlock }, 'Starting from configured block');
    } else {
      this.lastProcessedBlock = tip - STARTUP_LOOKBACK_BLOCKS;
      this.logger.info(
        { startBlock: this.lastProcessedBlock.toString() },
        'Starting from tip - lookback',
      );
    }

    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error({ err }, 'Indexer tick failed; backing off');
        await sleep(this.config.pollIntervalMs * 5);
        continue;
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  private async tick(): Promise<void> {
    const tip = await this.client.getBlockNumber();
    this.chainTipBlock = tip;

    const safeTip = tip - this.confirmations;
    if (safeTip <= this.lastProcessedBlock) return;

    let cursor = this.lastProcessedBlock + 1n;
    while (cursor <= safeTip) {
      const toBlock =
        cursor + this.logRangeBlocks - 1n > safeTip
          ? safeTip
          : cursor + this.logRangeBlocks - 1n;

      await this.processRange(cursor, toBlock);

      this.lastProcessedBlock = toBlock;
      this.lastBlockProcessedAt = Date.now();
      await this.state.save({
        lastProcessedBlock: Number(toBlock),
        updatedAt: new Date().toISOString(),
      });

      cursor = toBlock + 1n;
    }
  }

  private async processRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const [modernLogs, legacyLogs] = await Promise.all([
      this.client.getLogs({
        address: [...CURRENT_PUBLIC_RESOLVER_ADDRESSES],
        event: TEXT_RESOLVER_EVENTS.TextChanged,
        fromBlock,
        toBlock,
      }),
      this.client.getLogs({
        address: LEGACY_PUBLIC_RESOLVER_ADDRESS,
        event: TEXT_RESOLVER_EVENTS.LegacyTextChanged,
        fromBlock,
        toBlock,
      }),
    ]);

    const all: Array<{ log: Log; legacy: boolean }> = [
      ...modernLogs.map((log) => ({ log: log as Log, legacy: false })),
      ...legacyLogs.map((log) => ({ log: log as Log, legacy: true })),
    ];
    all.sort((a, b) => {
      const blockDiff = Number((a.log.blockNumber ?? 0n) - (b.log.blockNumber ?? 0n));
      if (blockDiff !== 0) return blockDiff;
      return (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0);
    });

    if (all.length === 0) return;

    this.logger.debug(
      { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), logs: all.length },
      'Processing TextChanged logs',
    );

    for (const { log, legacy } of all) {
      try {
        await this.handleResolverLog(log, legacy);
      } catch (err) {
        this.logger.error({ err, txHash: log.transactionHash }, 'Failed to handle resolver log');
      }
    }
  }

  private async handleResolverLog(log: Log, legacy: boolean): Promise<void> {
    const decoded = decodeEventLog({
      abi: [
        legacy
          ? TEXT_RESOLVER_EVENTS.LegacyTextChanged
          : TEXT_RESOLVER_EVENTS.TextChanged,
      ],
      data: log.data,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });

    const args = decoded.args as { node?: `0x${string}`; key?: string };
    const key = typeof args.key === 'string' ? args.key.toLowerCase() : '';
    if (!INVALIDATING_TEXT_KEYS.has(key)) return;
    if (!args.node) return;

    const nodeTokenId = BigInt(args.node).toString();
    const resolved = await this.resolver.resolveTokenIdToNameData(nodeTokenId);

    const item = {
      network: this.network,
      ...(resolved?.name ? { name: resolved.name.toLowerCase() } : {}),
      tokenId: resolved?.correctTokenId ?? nodeTokenId,
    };

    this.batcher.add(item);

    this.logger.info(
      {
        key,
        name: item.name ?? null,
        tokenId: item.tokenId,
        legacy,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber?.toString(),
      },
      'Queued ENS metadata invalidation',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
