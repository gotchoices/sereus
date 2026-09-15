import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { withTrailingPeerId } from '../src/peer-record.js';

/**
 * The claim `CadreNode.resolveControlDialAddrs` rests on when a phone dials a node it
 * added from the addresses it was handed: one `dial()` over a list that names a
 * transport the dialer lacks still connects over the transport it has, because
 * libp2p's dial queue drops undialable addresses before dialing instead of failing
 * the whole list. A lent cadre-host node reports TCP and `/ws` addresses; a React
 * Native phone dials WebSockets only.
 *
 * Checked against real libp2p rather than asserted, so an upgrade that changes the
 * rule fails here instead of leaving the phone unable to reach the node. Plain libp2p
 * nodes, not `CadreNode`s: the question is entirely about the dial queue.
 */

const nodes: Libp2p[] = [];

afterEach(async () => {
	await Promise.all(nodes.splice(0).map((node) => node.stop()));
});

describe('one dial over a mixed-transport address list', () => {
	it('connects a WebSocket-only node over /ws when the list names TCP first', async () => {
		const lent = await startNode([tcp(), webSockets()], ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws']);
		const phone = await startNode([webSockets()], []);
		const lentId = lent.peerId.toString();

		const handedOver = handedOverAddrs(lent);
		expect(handedOver.map(String).some((addr) => !addr.includes('/ws'))).toBe(true);
		expect(handedOver.map(String).some((addr) => addr.includes('/ws'))).toBe(true);

		const connection = await phone.dial(handedOver);

		expect(connection.remotePeer.toString()).toBe(lentId);
		expect(connection.remoteAddr.toString()).toContain('/ws');
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

/**
 * The lent node's listen addresses in the shape an owner is handed them — bare, TCP
 * first — then bound to its peer id the way `CadreNode.bootstrapDialAddrs` binds a
 * retained entry.
 */
function handedOverAddrs(lent: Libp2p): Multiaddr[] {
	const suffix = `/p2p/${lent.peerId.toString()}`;
	const bare = lent.getMultiaddrs().map((addr) => addr.toString().replace(suffix, ''));
	const tcpFirst = [...bare.filter((addr) => !addr.includes('/ws')), ...bare.filter((addr) => addr.includes('/ws'))];
	return tcpFirst
		.map((addr) => withTrailingPeerId(multiaddr(addr), lent.peerId.toString()))
		.filter((addr): addr is Multiaddr => addr !== null);
}
