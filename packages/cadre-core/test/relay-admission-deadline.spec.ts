import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';
import { createMembershipConnectionGater, type InboundAdmissionPolicy } from '../src/membership-connection-gater.js';

/**
 * The relay-only not-reserving deadline against a real WebSocket transport:
 * when the deadline fires, does the STRANGER'S end of the socket actually go
 * away?
 *
 * `membership-connection-gater.spec.ts` covers the deadline's logic with
 * doubles, and cannot answer that — a double records whatever call it is given.
 * The bug this pins was exactly there: the deadline used to call
 * `maConn.abort()`, which on `@libp2p/websockets` marks the local end `aborted`
 * without sending anything, so the relay dropped the connection from its own
 * list while the stranger kept an open socket indefinitely — one leaked socket
 * per stranger on a public relay. Every doubles case still passed.
 *
 * So this spec asserts from the DIALER's side, over a real socket, and the
 * nodes keep libp2p's stock connection monitor: its ~10 s ping interval means
 * the only way the old code could ever have satisfied this is a ping failure at
 * ~15 s, well past the window below.
 */

const nodes: Libp2p[] = [];

afterEach(async () => {
	await Promise.all(nodes.splice(0).map((node) => node.stop()));
});

/** Short enough to keep the spec fast, long enough to survive the upgrade on a loaded machine. */
const DEADLINE_MS = 1_000;

/** How long the dialer's connection may survive the deadline. Far under the ~15 s a ping failure would take. */
const DROP_WINDOW_MS = 5_000;

describe('relay-only not-reserving deadline (real WebSocket transport)', () => {
	it('drops the stranger\'s own end of the connection, not just the relay\'s', async () => {
		const relayOnly: InboundAdmissionPolicy = {
			admitInbound: () => 'admit-for-relay',
			admitRelayReservation: () => false,
		};
		const relay = await startNode(['/ip4/127.0.0.1/tcp/0/ws'], createMembershipConnectionGater(relayOnly, undefined, 2_000, DEADLINE_MS));
		const stranger = await startNode([]);
		const relayAddr = relay.getMultiaddrs().find((addr) => addr.toString().includes('/ws'));
		expect(relayAddr).toBeDefined();

		await stranger.dial(multiaddr(relayAddr!.toString()));
		expect(openTo(stranger, relay)).toBe(true);

		const started = Date.now();
		while (openTo(stranger, relay) && Date.now() - started < DROP_WINDOW_MS) {
			await delay(100);
		}

		expect(openTo(stranger, relay)).toBe(false);
	});
});

async function startNode(listen: string[], connectionGater?: ReturnType<typeof createMembershipConnectionGater>): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen },
		transports: [webSockets()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		connectionGater,
	});
	nodes.push(node);
	return node;
}

/** Does `from` still hold an open connection to `to`? */
function openTo(from: Libp2p, to: Libp2p): boolean {
	return from.getConnections().some((c) => c.remotePeer.toString() === to.peerId.toString() && c.status === 'open');
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
