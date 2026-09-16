import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { dialPeerAddrs, directBeforeRelayed, tryAddrsInTurn } from '../src/peer-dial.js';
import { withTrailingPeerId } from '../src/peer-record.js';
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
 * Checked against real libp2p rather than doubles because two of the claims are
 * about libp2p's dial queue — that a one-address dial of a transport the node
 * lacks fails at once, and that timing out one address and dialing the next for
 * the same peer does not join the aborted dial — so an upgrade that changes either
 * fails here.
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
		const connection = await dialPeerAddrs(dialer, addrs, { perAddressMs: PER_ADDRESS_MS, totalMs }, 'test dial');
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

	it('stops at the total limit when no address answers, naming the addresses it never tried', async () => {
		const target = await startNode([webSockets()], ['/ip4/127.0.0.1/tcp/0/ws']);
		const dialer = await startNode([webSockets()], []);
		const dead = await Promise.all([1, 2, 3, 4].map(() => silentServer()));
		const addrs = dead.map((server) => bound(server.wsAddr, target));
		// Two full attempts, a shortened third, and no time left for the fourth.
		const totalMs = 2.5 * PER_ADDRESS_MS;

		const started = Date.now();
		const error = await dialPeerAddrs(dialer, addrs, { perAddressMs: PER_ADDRESS_MS, totalMs }, 'test dial')
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
		const connection = await dialPeerAddrs(phone, tcpFirst, { perAddressMs: 5_000, totalMs: 10_000 }, 'test dial');

		expect(connection.remotePeer.toString()).toBe(lent.peerId.toString());
		expect(connection.remoteAddr.toString()).toContain('/ws');
		expect(Date.now() - started).toBeLessThan(SLACK_MS);
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

async function startNode(transports: Libp2pOptions['transports'], listen: string[]): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen },
		transports,
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

/** `addr` bound to `node`'s peer id, as `CadreNode` binds every dial candidate. */
function bound(addr: string, node: Libp2p): Multiaddr {
	const withId = withTrailingPeerId(multiaddr(addr), node.peerId.toString());
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
