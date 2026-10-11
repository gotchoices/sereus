import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PeerId } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { dialAddr, dialPeerAddrs, directBeforeRelayed, tryAddrsInTurn, withTrailingPeerId, SelfRelayOnlyError, type AddrDialer } from '../src/peer-dial.js';
import { startSilentServer, type SilentServer } from './silent-server.js';

/**
 * `dialPeerAddrs` against real libp2p nodes: the dial `CadreNode` makes to a
 * sibling or bootstrap peer from a list of candidate addresses, and the dials
 * `SeedBootstrapService` makes to an owner.
 *
 * The case that motivated it: a phone borrowing a node from a cadre-host was
 * handed the node's LAN addresses, which the host's firewall silently dropped,
 * ahead of the forwarded loopback address that worked. One `libp2p.dial()` over
 * that list tries the addresses one after another under a single deadline, so the
 * dropped ones used it all up. Here the dropped addresses are loopback TCP servers
 * that never answer the WebSocket upgrade (`silent-server.ts`).
 *
 * Checked against real libp2p rather than doubles because most of the claims are
 * about libp2p's dialing — that a one-address dial of a transport the node lacks
 * fails at once, that an attempt reaches its own address while another dial of
 * the same peer is in flight, which a dial through libp2p's queue would join
 * instead, that an open connection is handed back as the queue would have, and
 * that the node's stop ends an attempt the queue no longer tracks — so an upgrade
 * that changes any of them fails here.
 */

const nodes: Libp2p[] = [];
const silentServers: SilentServer[] = [];

afterEach(async () => {
	await Promise.all(nodes.splice(0).map((node) => node.stop()));
	await Promise.all(silentServers.splice(0).map((server) => server.close()));
});

/** Per-address limit the timing cases use: small enough to keep the suite fast. */
const PER_ADDRESS_MS = 400;

/**
 * Room for scheduling on a loaded machine. Wide on purpose: the claims are that a
 * dial ends near a chosen number rather than at the whole budget, and the budgets
 * below keep those apart by more than this.
 */
const SLACK_MS = 1_000;

describe('dialPeerAddrs — addresses that never answer', () => {
	it('reaches the working address after two silent ones, where one dial over the list does not', async () => {
		const target = await startNode([webSockets()], ['/ip4/127.0.0.1/tcp/0/ws']);
		const dialer = await startNode([webSockets()], []);
		const dead = [await silentServer(), await silentServer()];
		const addrs = [...dead.map((server) => bound(server.wsAddr, target)), ...wsAddrs(target)];
		const totalMs = 2 * PER_ADDRESS_MS + 2 * SLACK_MS;

		const started = Date.now();
		const connection = await dialPeerAddrs(dialer, target.peerId.toString(), addrs, { perAddressMs: PER_ADDRESS_MS, totalMs }, 'test dial');
		const elapsed = Date.now() - started;

		expect(connection.remotePeer.toString()).toBe(target.peerId.toString());
		expect(connection.remoteAddr.toString()).toContain('/ws');
		expect(elapsed).toBeLessThan(2 * PER_ADDRESS_MS + SLACK_MS);
		// Each silent address was really dialed, for its full limit. If the second dial
		// joined the first one's aborted libp2p dial instead, it would fail in about a
		// millisecond without touching the network, and this would come in near one limit.
		expect(dead.map((server) => server.accepted() > 0)).toEqual([true, true]);
		expect(elapsed).toBeGreaterThanOrEqual(2 * PER_ADDRESS_MS - 50);

		// The failure being fixed, pinned so a libp2p change to it shows up — from a
		// second dialer, since the first now holds a connection. All three addresses are
		// loopback, so libp2p keeps their order, and the first silent one holds the single
		// dial until the whole budget is gone.
		const oneDial = await startNode([webSockets()], []);
		const before = Date.now();
		await expect(oneDial.dial(addrs, { signal: AbortSignal.timeout(totalMs) })).rejects.toThrow();
		expect(Date.now() - before).toBeGreaterThanOrEqual(totalMs - 50);
	});

	it('dials every address even while another dial of the same peer is in flight', async () => {
		const target = await startNode([webSockets()], ['/ip4/127.0.0.1/tcp/0/ws']);
		// libp2p's own per-address limit, kept well past this test so the concurrent dial's
		// job is still on its first address when every attempt here has ended.
		const dialer = await startNode([webSockets()], [], { addressDialTimeout: 10_000, dialTimeout: 10_000 });
		const dead = [await silentServer(), await silentServer()];
		const addrs = [...dead.map((server) => bound(server.wsAddr, target)), ...wsAddrs(target)];
		await dialer.peerStore.merge(target.peerId, { multiaddrs: [multiaddr(dead[0].wsAddr)] });
		const totalMs = 2 * PER_ADDRESS_MS + 2 * SLACK_MS;

		const ours = dialPeerAddrs(dialer, target.peerId.toString(), addrs, { perAddressMs: PER_ADDRESS_MS, totalMs }, 'test dial');
		// What FRET's membership probe does once the peer's addresses are in the address
		// book: a dial by peer id, which libp2p's queue joins to any job for that id.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const other = new AbortController();
		const concurrent = dialer.dial(target.peerId, { signal: other.signal }).catch(() => undefined);
		try {
			const connection = await ours;
			expect(connection.remotePeer.toString()).toBe(target.peerId.toString());
			expect(dead.map((server) => server.accepted() > 0)).toEqual([true, true]);
		} finally {
			other.abort();
			await concurrent;
		}
	});

	it('stops at the total limit when no address answers, naming the addresses it never tried', async () => {
		const target = await startNode([webSockets()], ['/ip4/127.0.0.1/tcp/0/ws']);
		const dialer = await startNode([webSockets()], []);
		const dead = await Promise.all([1, 2, 3, 4].map(() => silentServer()));
		const addrs = dead.map((server) => bound(server.wsAddr, target));
		// Two full attempts, a shortened third, and no time left for the fourth.
		const totalMs = 2.5 * PER_ADDRESS_MS;

		const started = Date.now();
		const error = await dialPeerAddrs(dialer, target.peerId.toString(), addrs, { perAddressMs: PER_ADDRESS_MS, totalMs }, 'test dial')
			.then(() => null, (err: unknown) => err as Error);
		const elapsed = Date.now() - started;

		expect(error?.message).toMatch(/test dial failed for all 4 candidate addresses/);
		expect(error?.message).toContain(`${addrs[3].toString()} — not tried`);
		expect(elapsed).toBeGreaterThanOrEqual(totalMs - 50);
		expect(elapsed).toBeLessThan(totalMs + SLACK_MS);
		expect(dead.map((server) => server.accepted() > 0)).toEqual([true, true, true, false]);
	});
});

describe('dialPeerAddrs — a list naming a transport the dialer lacks', () => {
	it('connects a WebSocket-only node over /ws when the list names TCP first, without waiting on TCP', async () => {
		// A lent cadre-host node reports TCP and `/ws` addresses; a React Native phone
		// dials WebSockets only. Nothing filters the TCP entries out beforehand: a
		// one-address dial of one is rejected by libp2p before it touches the network.
		const lent = await startNode([tcp(), webSockets()], ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws']);
		const phone = await startNode([webSockets()], []);
		const listening = listenAddrs(lent);
		const tcpFirst = [
			...listening.filter((addr) => !addr.toString().includes('/ws')),
			...listening.filter((addr) => addr.toString().includes('/ws')),
		];
		expect(tcpFirst[0].toString()).not.toContain('/ws');

		const started = Date.now();
		const connection = await dialPeerAddrs(phone, lent.peerId.toString(), tcpFirst, { perAddressMs: 5_000, totalMs: 10_000 }, 'test dial');

		expect(connection.remotePeer.toString()).toBe(lent.peerId.toString());
		expect(connection.remoteAddr.toString()).toContain('/ws');
		expect(Date.now() - started).toBeLessThan(SLACK_MS);
	});
});

describe('dialPeerAddrs — addresses that relay through the dialer itself', () => {
	// What a relay holds for a phone with a reservation on it: the phone's circuit address names the
	// relay — this dialer — as its hop, and dialing it can only fail with `Can not dial self`.
	it('skips a self-relayed address and dials the others', async () => {
		const self = await newPeerId();
		const target = await newPeerId();
		// Relayed like the skipped one, so ordering alone would keep the self-relayed address first.
		const throughOther = circuitVia(await newPeerId(), target);
		const dialer = recordingDialer(self);

		const connection = await dialPeerAddrs(dialer, target.toString(), [circuitVia(self, target), throughOther], { perAddressMs: 100, totalMs: 100 }, 'test dial');

		expect(dialer.dialed.map(String)).toEqual([throughOther.toString()]);
		expect(connection).toBe(dialer.connection);
	});

	it('rejects with SelfRelayOnlyError, dialing nothing, when every address relays through the dialer', async () => {
		const self = await newPeerId();
		const target = await newPeerId();
		const dialer = recordingDialer(self);
		const addrs = [circuitVia(self, target), circuitVia(self, target, '/ip4/10.0.0.2/tcp/4001/ws')];

		await expect(dialPeerAddrs(dialer, target.toString(), addrs, { perAddressMs: 100, totalMs: 100 }, 'test dial'))
			.rejects.toBeInstanceOf(SelfRelayOnlyError);
		expect(dialer.dialed).toEqual([]);
	});
});

describe('dialPeerAddrs — binding every address to the peer expected', () => {
	it('binds a bare address and drops one naming another peer', async () => {
		const self = await newPeerId();
		const target = await newPeerId();
		const other = await newPeerId();
		const dialer = recordingDialer(self);
		const bare = multiaddr('/ip4/10.0.0.1/tcp/4001/ws');

		await dialPeerAddrs(dialer, target.toString(), [bare, multiaddr(`/ip4/10.0.0.2/tcp/4001/ws/p2p/${other.toString()}`)], { perAddressMs: 100, totalMs: 100 }, 'test dial');

		expect(dialer.dialed.map(String)).toEqual([`${bare.toString()}/p2p/${target.toString()}`]);
	});

	it('rejects without dialing when no address binds to the peer', async () => {
		const self = await newPeerId();
		const dialer = recordingDialer(self);
		const addrs = [multiaddr(`/ip4/10.0.0.2/tcp/4001/ws/p2p/${(await newPeerId()).toString()}`)];

		await expect(dialPeerAddrs(dialer, (await newPeerId()).toString(), addrs, { perAddressMs: 100, totalMs: 100 }, 'test dial'))
			.rejects.toThrow(/none of the 1 candidate addresses binds to/);
		expect(dialer.dialed).toEqual([]);
	});
});

describe('dialPeerAddrs — a connection already open to the peer', () => {
	it('hands back the open connection without dialing', async () => {
		// What libp2p's dial queue did before dialing (`findExistingConnection`) and the
		// transport manager does not: the silent address sits first, so a dial would be held
		// there for its whole limit.
		const target = await startNode([webSockets()], ['/ip4/127.0.0.1/tcp/0/ws']);
		const dialer = await startNode([webSockets()], []);
		const open = await dialer.dial(wsAddrs(target)[0]);
		const dead = await silentServer();
		const addrs = [bound(dead.wsAddr, target), ...wsAddrs(target)];

		const connection = await dialPeerAddrs(dialer, target.peerId.toString(), addrs, { perAddressMs: PER_ADDRESS_MS, totalMs: 2 * PER_ADDRESS_MS }, 'test dial');

		expect(connection).toBe(open);
		expect(dead.accepted()).toBe(0);
	});
});

describe('dialAddr — the node stops with an attempt in flight', () => {
	it('rejects the attempt promptly, naming the stop', async () => {
		// The queue aborted its jobs at shutdown; a transport-manager dial has no such tie, so
		// the helper listens for the node's `stop` event instead.
		const dialer = await startNode([webSockets()], []);
		const dead = await silentServer();
		const attempt = dialAddr(dialer, boundTo(dead.wsAddr, await newPeerId()), new AbortController().signal, 'test dial');
		await until(() => dead.accepted() > 0);

		const stopped = Date.now();
		await dialer.stop();
		await expect(attempt).rejects.toThrow(/the node stopped/);
		expect(Date.now() - stopped).toBeLessThan(SLACK_MS);
	});
});

describe('directBeforeRelayed', () => {
	it('moves circuit-relay addresses after direct ones, keeping each group in order', () => {
		const relayId = '12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
		const circuitA = multiaddr(`/ip4/9.9.9.9/tcp/4001/p2p/${relayId}/p2p-circuit`);
		const circuitB = multiaddr(`/dns4/r.example.org/tcp/443/wss/p2p/${relayId}/p2p-circuit`);
		const lan = multiaddr('/ip4/192.168.1.5/tcp/4002/ws');
		const loopback = multiaddr('/ip4/127.0.0.1/tcp/4002/ws');

		expect(directBeforeRelayed([circuitA, lan, circuitB, loopback]).map(String))
			.toEqual([lan, loopback, circuitA, circuitB].map(String));
	});
});

describe('tryAddrsInTurn', () => {
	it('throws the only attempt\'s own error when there is one address', async () => {
		await expect(tryAddrsInTurn([multiaddr('/ip4/1.1.1.1/tcp/1')], { perAddressMs: 100, totalMs: 100 }, 'x', async () => {
			throw new Error('the only reason');
		})).rejects.toThrow('the only reason');
	});

	it('refuses an empty list', async () => {
		await expect(tryAddrsInTurn([], { perAddressMs: 100, totalMs: 100 }, 'x', async () => 'unreachable'))
			.rejects.toThrow(/no candidate addresses/);
	});

	it('aborts the signal of an attempt that runs past its limit', async () => {
		const signals: AbortSignal[] = [];
		const addrs = [multiaddr('/ip4/1.1.1.1/tcp/1'), multiaddr('/ip4/2.2.2.2/tcp/2')];

		const result = await tryAddrsInTurn(addrs, { perAddressMs: 50, totalMs: 1_000 }, 'x', (addr, signal) => {
			signals.push(signal);
			// The first never settles on its own — only the limit can end it.
			return addr === addrs[0] ? new Promise<never>(() => {}) : Promise.resolve('second');
		});

		expect(result).toBe('second');
		expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
	});
});

async function newPeerId(): Promise<PeerId> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
}

/** `target`'s circuit address through a reservation it holds on `relay`, reached at `via`. */
function circuitVia(relay: PeerId, target: PeerId, via = '/ip4/10.0.0.1/tcp/4001/ws'): Multiaddr {
	return multiaddr(`${via}/p2p/${relay.toString()}/p2p-circuit/p2p/${target.toString()}`);
}

/** Poll `condition` every 10 ms until it holds, giving up after `SLACK_MS`. */
async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + SLACK_MS;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('condition never held');
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** An {@link AddrDialer} that records each address it is asked to dial and answers every one. */
function recordingDialer(peerId: PeerId): AddrDialer & { dialed: Multiaddr[]; connection: Connection } {
	const dialed: Multiaddr[] = [];
	const connection = {} as Connection;
	return {
		peerId,
		dialed,
		connection,
		dial: async (addr) => {
			dialed.push(addr);
			return connection;
		},
	};
}

async function startNode(
	transports: Libp2pOptions['transports'],
	listen: string[],
	connectionManager: Libp2pOptions['connectionManager'] = {},
): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen },
		transports,
		connectionManager,
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
	});
	nodes.push(node);
	return node;
}

async function silentServer(): Promise<SilentServer> {
	const server = await startSilentServer();
	silentServers.push(server);
	return server;
}

/** `addr` bound to `node`'s peer id, as every dial candidate is bound. */
function bound(addr: string, node: Libp2p): Multiaddr {
	return boundTo(addr, node.peerId);
}

function boundTo(addr: string, peerId: PeerId): Multiaddr {
	const withId = withTrailingPeerId(multiaddr(addr), peerId.toString());
	if (withId === null) {
		throw new Error(`cannot bind ${addr} to a peer id`);
	}
	return withId;
}

/**
 * `node`'s listen addresses, which libp2p already reports with its peer id —
 * re-parsed, since libp2p hands back its own copy of the multiaddr package's type.
 */
function listenAddrs(node: Libp2p): Multiaddr[] {
	return node.getMultiaddrs().map((addr) => multiaddr(addr.toString()));
}

/** `node`'s `/ws` listen addresses (see {@link listenAddrs}). */
function wsAddrs(node: Libp2p): Multiaddr[] {
	return listenAddrs(node).filter((addr) => addr.toString().includes('/ws'));
}
