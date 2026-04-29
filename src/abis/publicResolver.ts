import { parseAbi } from 'viem';

// Modern resolver — TextChanged with the new (key, value) signature.
export const TEXT_RESOLVER_ABI = parseAbi([
  'event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)',
]);

// Legacy resolver — TextChanged without the value field.
export const LEGACY_TEXT_RESOLVER_ABI = parseAbi([
  'event TextChanged(bytes32 indexed node, string indexed indexedKey, string key)',
]);

export const TEXT_RESOLVER_EVENTS = {
  TextChanged: TEXT_RESOLVER_ABI[0],
  LegacyTextChanged: LEGACY_TEXT_RESOLVER_ABI[0],
} as const;

// ENS docs list these public resolvers on mainnet — we mirror grailsmarket/backend PR #178.
export const CURRENT_PUBLIC_RESOLVER_ADDRESSES = [
  '0xF29100983E058B709F3D539b0c765937B804AC15',
  '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
] as const satisfies readonly `0x${string}`[];

export const LEGACY_PUBLIC_RESOLVER_ADDRESS =
  '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41' as const satisfies `0x${string}`;

// Keys we want to invalidate on. v1 = avatar + header.
export const INVALIDATING_TEXT_KEYS = new Set(['avatar', 'header']);
