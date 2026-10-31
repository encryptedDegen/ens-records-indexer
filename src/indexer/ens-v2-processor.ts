import { decodeEventLog, hexToBytes, type Address, type Log } from 'viem'
import { namehash, normalize } from 'viem/ens'
import { ENS_V2_EVENTS } from '../abis/ensV2.js'
import { INVALIDATING_TEXT_KEYS } from '../abis/publicResolver.js'
import type { MetadataInvalidationNetwork } from '../config.js'
import { dedupeInvalidationItems } from '../invalidation/http-client.js'
import type { InvalidateItem } from '../invalidation/types.js'
import type { Logger } from '../utils/logger.js'
import type { EnsV2Worker } from './ens-v2-worker.js'

type ResolverTarget = { registry: Address; tokenId: string }

/** Historical associations keep default-record removals discoverable. */
export type V2ResolverTargets = Record<string, ResolverTarget[]>

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
type DecodedEvent = ReturnType<typeof decodeResolverEvent>

function decodeResolverEvent(log: Log) {
	return decodeEventLog({
		abi: ENS_V2_EVENTS,
		data: log.data,
		topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
		strict: true,
	})
}

function decodeDnsName(encoded: `0x${string}`): string {
	const bytes = hexToBytes(encoded)
	const decoder = new TextDecoder('utf-8', { fatal: true })
	const labels: string[] = []
	let offset = 0

	while (offset < bytes.length) {
		const length = bytes[offset++]!
		if (length === 0) {
			if (offset !== bytes.length)
				throw new Error('Trailing bytes after DNS name')
			return labels.join('.')
		}
		if (offset + length > bytes.length)
			throw new Error('Truncated DNS label')
		const label = decoder.decode(bytes.subarray(offset, offset + length))
		if (label.includes('.') || label.includes('\0')) {
			throw new Error('Invalid character in DNS label')
		}
		labels.push(label)
		offset += length
	}

	throw new Error('Unterminated DNS name')
}

export class EnsV2Processor {
	private targets: V2ResolverTargets = {}

	constructor(
		private readonly worker: EnsV2Worker,
		private readonly network: MetadataInvalidationNetwork,
		private readonly logger: Logger,
	) {}

	snapshot(): V2ResolverTargets {
		return structuredClone(this.targets)
	}

	restore(targets: V2ResolverTargets): void {
		this.targets = structuredClone(targets)
	}

	async processLogs(logs: Log[], toBlock: bigint): Promise<InvalidateItem[]> {
		const events: Array<{ log: Log; event: DecodedEvent }> = []
		for (const log of logs) {
			try {
				const event = decodeResolverEvent(log)
				if (
					event.eventName === 'TextUpdated' &&
					!INVALIDATING_TEXT_KEYS.has(event.args.key.toLowerCase())
				)
					continue

				events.push({ log, event })
			} catch (err) {
				this.logger.warn(
					{ err, txHash: log.transactionHash },
					'Ignoring invalid ENSv2 event',
				)
			}
		}
		if (events.length === 0) return []

		events.sort((a, b) => {
			const leftBlock = a.log.blockNumber ?? 0n
			const rightBlock = b.log.blockNumber ?? 0n
			if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1
			return (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0)
		})

		await this.worker.assertSynced(toBlock)

		// The worker exposes current state. Share lookups across this range so
		// repeated updates to one bundle fan out only once.
		const resolvers = new Map<
			string,
			ReturnType<EnsV2Worker['getResolver']>
		>()
		const names = new Map<string, ReturnType<EnsV2Worker['getName']>>()
		const tokens = new Map<string, ReturnType<EnsV2Worker['getToken']>>()
		const bundles = new Set<string>()
		const items: InvalidateItem[] = []

		const getResolver = (address: Address) => {
			let result = resolvers.get(address)
			if (!result) {
				result = this.worker.getResolver(address)
				resolvers.set(address, result)
			}
			return result
		}

		const getToken = (registry: Address, tokenId: bigint) => {
			const key = `${registry}:${tokenId}`
			let result = tokens.get(key)
			if (!result) {
				result = this.worker.getToken(registry, tokenId)
				tokens.set(key, result)
			}
			return result
		}

		const emitToken = (
			name: string,
			registry: Address,
			tokenId: string,
		) => {
			items.push({
				network: this.network,
				name,
				contract: registry,
				tokenId,
			})
		}

		const emitName = async (name: string) => {
			try {
				name = normalize(name)
			} catch (err) {
				this.logger.warn(
					{ err, name },
					'Ignoring invalid ENSv2 record name',
				)
				return
			}
			let result = names.get(name)
			if (!result) {
				result = this.worker.getName(name)
				names.set(name, result)
			}
			const token = await result
			if (token) emitToken(token.name, token.registry, token.tokenId)
			else items.push({ network: this.network, name })
		}

		const emitBundle = async (resolver: Address, recordId: bigint) => {
			// Zero is the unlink sentinel, never a bundle to look up.
			if (recordId === 0n) return
			const key = `${resolver}:${recordId}`
			if (bundles.has(key)) return
			bundles.add(key)
			for (const name of await this.worker.getRecordNames(
				resolver,
				recordId,
			)) {
				await emitName(name)
			}
		}

		for (const { log, event } of events) {
			const address = log.address.toLowerCase() as Address
			switch (event.eventName) {
				case 'ResolverUpdated': {
					const resolver = event.args.resolver.toLowerCase()
					if (resolver !== ZERO_ADDRESS) {
						const targets = (this.targets[resolver] ??= [])
						const tokenId = event.args.tokenId.toString()
						if (
							!targets.some(
								target =>
									target.registry === address &&
									target.tokenId === tokenId,
							)
						) {
							targets.push({ registry: address, tokenId })
						}
					}
					// Child registries can assign resolvers before their parent is
					// attached. Preserve the association until the worker can name it.
					const token = await getToken(address, event.args.tokenId)
					if (!token) break
					emitToken(token.name, token.registry, token.tokenId)
					emitToken(
						token.name,
						address,
						event.args.tokenId.toString(),
					)
					break
				}
				case 'TokenRegenerated': {
					const token = await getToken(address, event.args.newTokenId)
					if (!token) break
					emitToken(
						token.name,
						address,
						event.args.oldTokenId.toString(),
					)
					emitToken(
						token.name,
						address,
						event.args.newTokenId.toString(),
					)
					emitToken(token.name, token.registry, token.tokenId)
					break
				}
				case 'TextUpdated':
				case 'AddressUpdated':
				case 'Cleared': {
					if (await getResolver(address))
						await emitBundle(address, event.args.recordId)
					break
				}
				case 'Linked': {
					let name: string
					try {
						name = decodeDnsName(event.args.name)
						if (
							namehash(name).toLowerCase() !==
							event.args.node.toLowerCase()
						) {
							throw new Error(
								'Linked name does not match its node',
							)
						}
						if (name) name = normalize(name)
					} catch (err) {
						this.logger.warn(
							{ err, txHash: log.transactionHash },
							'Ignoring invalid ENSv2 linked name',
						)
						break
					}

					const resolver = await getResolver(address)
					if (!resolver) break

					if (name) {
						await emitName(name)
					} else {
						// A root link changes the default for every name using this
						// resolver, including names no longer returned after an unlink.
						for (const target of this.targets[address] ?? []) {
							const token = await getToken(
								target.registry,
								BigInt(target.tokenId),
							)
							if (token) {
								emitToken(
									token.name,
									token.registry,
									token.tokenId,
								)
								emitToken(
									token.name,
									target.registry,
									target.tokenId,
								)
							}
						}
						if (resolver.defaultRecordId !== null) {
							await emitBundle(
								address,
								BigInt(resolver.defaultRecordId),
							)
						}
					}
					break
				}
			}
		}

		return dedupeInvalidationItems(items)
	}
}
