import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Peer, PeerId } from '@libp2p/interface';
import { selfAddressesChanged } from '../src/self-address-update.js';

/**
 * The filter `CadreNode` applies to `self:peer:update` before re-publishing its self record.
 * The case it exists for is the first: a protocol handler registered on a running node changes
 * the node's own peer-store entry without changing an address, and must not cost a `CadrePeer`
 * write (`control-write-degraded-cohort-member` measured that write re-driving a write under test).
 */

const TCP = '/ip4/127.0.0.1/tcp/4001';
const WS = '/ip4/127.0.0.1/tcp/4002/ws';

let id: PeerId;

beforeAll(async () => {
	id = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
});

function peer(addrs: readonly string[], protocols: readonly string[] = []): Peer {
	return {
		id,
		addresses: addrs.map((addr) => ({ multiaddr: multiaddr(addr), isCertified: false })),
		protocols: [...protocols],
		metadata: new Map(),
		tags: new Map()
	};
}

describe('selfAddressesChanged', () => {
	it('is false when only the protocol list changed', () => {
		expect(selfAddressesChanged({ previous: peer([TCP, WS], ['/a/1.0.0']), peer: peer([TCP, WS], ['/a/1.0.0', '/b/1.0.0']) })).toBe(false);
	});

	it('is false for the same addresses in another order', () => {
		expect(selfAddressesChanged({ previous: peer([TCP, WS]), peer: peer([WS, TCP]) })).toBe(false);
	});

	it('is true when an address is added, removed or replaced', () => {
		expect(selfAddressesChanged({ previous: peer([TCP]), peer: peer([TCP, WS]) })).toBe(true);
		expect(selfAddressesChanged({ previous: peer([TCP, WS]), peer: peer([TCP]) })).toBe(true);
		expect(selfAddressesChanged({ previous: peer([TCP]), peer: peer([WS]) })).toBe(true);
	});

	it('is true when there is no previous entry to compare with', () => {
		expect(selfAddressesChanged({ peer: peer([TCP]) })).toBe(true);
	});
});
