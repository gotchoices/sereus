import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { TypedEventEmitter } from 'main-event';
import type { Connection, Libp2p, Libp2pEvents, PeerId, PrivateKey } from '@libp2p/interface';
import { buildBlockTransferProtocol } from '@optimystic/db-p2p';
import { MemoryStrandPeerBookStore, type StrandPeerEntry } from '../src/strand-peer-book.js';
import {
	STRAND_PEER_BOOK_PROTOCOL,
	signStrandPeerEntry,
	verifyStrandPeerBookFrame,
	type SignedStrandPeerEntry
} from '../src/strand-peer-book-protocol.js';
import { StrandPeerBookSwap } from '../src/strand-peer-book-swap.js';
import { duplexPair, type MockStream } from './wake-stream-helpers.js';

/**
 * The strand peer book swap, end to end in one process: two `StrandPeerBookSwap`
 * drivers on mock libp2p nodes whose connections are `duplexPair` streams, so the
 * real receiver and the real client run the real protocol against each other with
 * no network. Verification is pinned at the frame layer, where the rejection happens.
 */

const STRAND = 'strand-swap';
const PREFIX = `/optimystic/strand-${STRAND}`;
const BLOCK_TRANSFER = buildBlockTransferProtocol(PREFIX);
/** What a strand peer that speaks the swap lists in its identify. */
const SWAP_PEER_PROTOCOLS = [BLOCK_TRANSFER, STRAND_PEER_BOOK_PROTOCOL];

type StreamHandler = (stream: MockStream, connection: Connection) => void;

/** A strand libp2p node reduced to what the swap touches, wired for in-process dialing. */
interface MockNode {
	key: PrivateKey;
	peerId: PeerId;
	id: string;
	libp2p: Libp2p;
	/** The node's own announced addresses; change and dispatch `self:peer:update` to rotate. */
	addrs: string[];
	handlers: Map<string, StreamHandler>;
	/** Live connections by remote peer id (what `getConnections` and the peer store report). */
	connected: Map<string, { peer: MockNode; connection: Connection }>;
	events: TypedEventEmitter<Libp2pEvents>;
	/** Streams this node opened, by remote peer id — the throttle's observable. */
	dialed: string[];
}

async function mockNode(port: number): Promise<MockNode> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key);
	const id = peerId.toString();
	const events = new TypedEventEmitter<Libp2pEvents>();
	const node: MockNode = {
		key, peerId, id, events,
		addrs: [`/ip4/203.0.113.${port}/tcp/${4000 + port}/ws/p2p/${id}`],
		handlers: new Map(),
		connected: new Map(),
		dialed: [],
		libp2p: undefined as unknown as Libp2p
	};
	node.libp2p = Object.assign(events, {
		peerId,
		getMultiaddrs: () => node.addrs.map((a) => multiaddr(a)),
		getConnections: () => [...node.connected.values()].map((c) => c.connection),
		peerStore: {
			get: async (wanted: PeerId) => {
				const link = node.connected.get(wanted.toString());
				if (!link) {
					const error = new Error('not found');
					error.name = 'NotFoundError';
					throw error;
				}
				return { protocols: SWAP_PEER_PROTOCOLS, addresses: link.peer.addrs.map((a) => ({ multiaddr: multiaddr(a) })) };
			}
		},
		handle: async (protocol: string, handler: StreamHandler) => { node.handlers.set(protocol, handler); },
		unhandle: async (protocol: string) => { node.handlers.delete(protocol); }
	}) as unknown as Libp2p;
	return node;
}

/** A connection from `from` to `to`: `newStream` runs `to`'s handler over a duplex pair. */
function connection(from: MockNode, to: MockNode): Connection {
	const conn = {
		remotePeer: to.peerId,
		remoteAddr: multiaddr(to.addrs[0]),
		newStream: async (protocol: string) => {
			from.dialed.push(to.id);
			const handler = to.handlers.get(protocol);
			if (!handler) throw new Error(`${to.id} does not handle ${protocol}`);
			const { clientStream, serverStream } = duplexPair();
			handler(serverStream, { remotePeer: from.peerId } as unknown as Connection);
			return clientStream;
		}
	};
	return conn as unknown as Connection;
}

/** Connect two nodes both ways (no identify event yet — the test dispatches that). */
function connect(a: MockNode, b: MockNode): void {
	a.connected.set(b.id, { peer: b, connection: connection(a, b) });
	b.connected.set(a.id, { peer: a, connection: connection(b, a) });
}

/** `node` identifies `peer` as a strand peer that speaks the swap. */
function identify(node: MockNode, peer: MockNode): void {
	node.events.safeDispatchEvent('peer:identify', {
		detail: {
			peerId: peer.peerId,
			protocols: SWAP_PEER_PROTOCOLS,
			listenAddrs: peer.addrs.map((a) => multiaddr(a)),
			connection: node.connected.get(peer.id)!.connection
		}
	});
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface Party {
	node: MockNode;
	store: MemoryStrandPeerBookStore;
	swap: StrandPeerBookSwap;
}

async function party(port: number, now: () => number): Promise<Party> {
	const node = await mockNode(port);
	const store = new MemoryStrandPeerBookStore('party', { now });
	const swap = new StrandPeerBookSwap(
		{ strandId: STRAND, libp2p: node.libp2p, protocolPrefix: PREFIX, store, privateKey: node.key },
		{ debounceMs: 0, now }
	);
	return { node, store, swap };
}

function held(store: MemoryStrandPeerBookStore, peerId: string): StrandPeerEntry | undefined {
	return store.entries(STRAND).find((e) => e.peerId === peerId);
}

describe('StrandPeerBookSwap round trip', () => {
	it('two connected peers end up holding each other\'s signed entry and a forwarded third party\'s', async () => {
		let clock = Date.now();
		const now = (): number => clock;
		const [a, b] = await Promise.all([party(1, now), party(2, now)]);
		// C: a third party A once met and holds a signed entry for; B has never met C.
		const c = await mockNode(3);
		const cEntry = await signStrandPeerEntry(c.key, STRAND, c.addrs, clock - 60_000);
		await a.store.merge(STRAND, { ...cEntry, lastSeenAt: clock - 60_000 });
		// An unsigned observation of A that B's observer made: the swap must upgrade it.
		await b.store.merge(STRAND, { peerId: a.node.id, addrs: [], issuedAt: 0, lastSeenAt: clock - 1 });

		a.swap.start();
		b.swap.start();
		await until(() => a.swap.ownEntry !== undefined && b.swap.ownEntry !== undefined, 'both own entries signed');
		expect(held(a.store, a.node.id)?.sig).toBe(a.swap.ownEntry!.sig);

		clock += 10;
		connect(a.node, b.node);
		identify(b.node, a.node);
		await until(() => held(b.store, c.id) !== undefined && held(a.store, b.node.id) !== undefined, 'the exchange lands both ways');

		// B holds A's own statement — signed, displacing the unsigned observation, seen now.
		const aInB = held(b.store, a.node.id)!;
		expect(aInB).toEqual({ ...a.swap.ownEntry!, lastSeenAt: clock });
		expect(aInB.addrs).toEqual(a.node.addrs);
		// B holds C's statement exactly as A forwarded it, never having met C.
		expect(held(b.store, c.id)).toEqual({ ...cEntry, lastSeenAt: 0 });
		// A holds B's own statement from the response.
		expect(held(a.store, b.node.id)).toEqual({ ...b.swap.ownEntry!, lastSeenAt: clock });
		// One stream: B dialed A; nothing dialed B (A never identified B in this test).
		expect(b.node.dialed).toEqual([a.node.id]);
		expect(a.node.dialed).toEqual([]);

		// A second identify inside the throttle window opens no second stream.
		identify(b.node, a.node);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(b.node.dialed).toEqual([a.node.id]);

		await Promise.all([a.swap.stop(), b.swap.stop()]);
	});

	it('an own-entry re-sign on self:peer:update reaches every connected strand peer past the throttle', async () => {
		let clock = Date.now();
		const now = (): number => clock;
		const [a, b] = await Promise.all([party(1, now), party(2, now)]);
		a.swap.start();
		b.swap.start();
		connect(a.node, b.node);
		identify(a.node, b.node);
		await until(() => held(b.store, a.node.id)?.sig !== undefined, 'the first exchange lands');
		const first = held(b.store, a.node.id)!;

		// A's relay reservation rotates: new address, event fires (twice, as libp2p does).
		clock += 1_000;
		a.node.addrs = [`/ip4/198.51.100.9/tcp/4001/ws/p2p/${a.node.id}`];
		a.node.events.safeDispatchEvent('self:peer:update', { detail: { peer: {}, previous: {} } } as never);
		a.node.events.safeDispatchEvent('self:peer:update', { detail: { peer: {}, previous: {} } } as never);
		await until(() => held(b.store, a.node.id)?.issuedAt !== first.issuedAt, 'the re-signed entry reaches B');

		const rotated = held(b.store, a.node.id)!;
		expect(rotated.addrs).toEqual(a.node.addrs);
		expect(rotated.issuedAt).toBeGreaterThan(first.issuedAt);
		expect(rotated.sig).not.toBe(first.sig);
		// Two streams from A in total: the identify exchange and the re-sign broadcast —
		// the debounced double event signed once.
		expect(a.node.dialed).toEqual([b.node.id, b.node.id]);

		await Promise.all([a.swap.stop(), b.swap.stop()]);
	});
});

describe('verifyStrandPeerBookFrame', () => {
	async function signer(): Promise<{ key: PrivateKey; id: string; addr: string }> {
		const key = await generateKeyPair('Ed25519');
		const id = peerIdFromPrivateKey(key).toString();
		return { key, id, addr: `/ip4/203.0.113.1/tcp/4001/ws/p2p/${id}` };
	}

	it('drops a tampered, a wrongly-signed and a future-dated entry individually and keeps their sibling', async () => {
		const now = 1_700_000_000_000;
		const [good, tampered, forged, future, impostor] = await Promise.all(
			Array.from({ length: 5 }, () => signer())
		);
		const goodEntry = await signStrandPeerEntry(good.key, STRAND, [good.addr], now);
		const tamperedEntry = { ...await signStrandPeerEntry(tampered.key, STRAND, [tampered.addr], now), addrs: [] };
		// An entry for `forged`'s peer id carrying a signature made by someone else's key.
		const forgedEntry: SignedStrandPeerEntry = {
			...await signStrandPeerEntry(impostor.key, STRAND, [], now),
			peerId: forged.id
		};
		const futureEntry = await signStrandPeerEntry(future.key, STRAND, [future.addr], now + 6 * 60 * 1000);

		const kept = await verifyStrandPeerBookFrame(
			STRAND,
			{ strandId: STRAND, entries: [tamperedEntry, goodEntry, forgedEntry, futureEntry] },
			'self',
			now
		);

		expect(kept).toEqual([goodEntry]);
	});

	it('refuses a frame naming another strand outright', async () => {
		const good = await signer();
		const entry = await signStrandPeerEntry(good.key, 'other-strand', [good.addr], 1);
		await expect(verifyStrandPeerBookFrame(STRAND, { strandId: 'other-strand', entries: [entry] }, 'self', 1))
			.rejects.toThrow(/names strand other-strand/);
	});
});
