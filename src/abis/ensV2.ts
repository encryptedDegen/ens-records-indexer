import { parseAbi } from 'viem';

export const ENS_V2_EVENTS = parseAbi([
  'event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)',
  'event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)',
  'event Cleared(uint256 indexed recordId)',
  'event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)',
  'event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)',
  'event TokenRegenerated(uint256 indexed oldTokenId, uint256 indexed newTokenId)',
]);
