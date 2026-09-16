import { describe, it, expect } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { startSilentServer, type SilentServer } from './silent-server.js';

/**
 * A node that adds a drone connects to it on its next reconcile pass even when the
 * addresses it was handed start with ones that never answer.
 *
 * The shape of a phone borrowing a node from a cadre-host: the phone cannot listen,
 * so it must dial; the lent node's own record is unsigned until that dial succeeds,
 * so the addresses `addDrone` retained are the only ones it has; and the host's LAN
 * addresses, which its firewall silently drops, came before the loopback address
 * forwarded to the phone. Before the pass dialed each address on its own time limit,
 * one `dial()` over the whole list spent the per-peer limit on the first dropped
 * address, and the connection never formed — on this pass or any later one.
 *
 * The drone is a plain libp2p node rather than a `CadreNode`: the claim is about the
 * owner's dial, and a plain node accepts it without a control database of its own.
 * The dropped addresses are loopback servers that never answer (`silent-server.ts`).
 */

/** Small, so the test is quick; the per-peer limit below is what the old dial would exhaust. */
const PER_ADDRESS_MS = 500;
const PER_PEER_MS = 5_000;
/** Scheduling room on a loaded machine; far below the per-peer limit the old dial needed. */
const SLACK_MS = 2_000;

describe('CadreNode — adding a drone whose first addresses never answer', () => {
	it('connects on one reconcile pass, past two silent addresses, with no other dial', async () => {
		const drone = await createLibp2p({
			addresses: { listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
			transports: [webSockets()],
			connectionEncrypters: [noise()],
			streamMuxers: [yamux()],
		});
		const silent: SilentServer[] = [await startSilentServer(), await startSilentServer()];
		const ownerKey = await generateKeyPair('Ed25519');
		const owner = new CadreNode({
			controlNetwork: { partyId: `dial-past-dead-${Math.random().toString(36).slice(2)}`, bootstrapNodes: [] },
			privateKey: ownerKey,
			profile: 'transaction',
			storage: { provider: new MemoryRawStorage() },
			network: {
				// The phone's posture: WebSockets only, nothing to listen on.
				transports: [webSockets()],
				listenAddrs: [],
				controlCohort: {
					perAddressDialTimeoutMs: PER_ADDRESS_MS,
					dialTimeoutMs: PER_PEER_MS,
					// Only the pass this test runs; no timed pass may dial in between.
					reconcileMs: 3_600_000,
				},
			},
		});

		try {
			await owner.start();
			await makeOwnOwner(owner, ownerKey);
			// Let the pass `start()` kicks off finish first: a call made while it runs
			// joins it, and it listed siblings before the drone existed.
			await owner.reconcileControlCohort();

			const dronePeerId = drone.peerId.toString();
			const droneWs = drone.getMultiaddrs().map((addr) => addr.toString()).find((addr) => addr.includes('/ws'));
			expect(droneWs).toBeDefined();
			await owner.addDrone({
				dronePeerId,
				droneMultiaddrs: [...silent.map((server) => server.wsAddr), droneWs!],
			});
			expect(connectionsTo(owner, dronePeerId)).toEqual([]);

			const started = Date.now();
			await owner.reconcileControlCohort();
			const elapsed = Date.now() - started;

			const connections = connectionsTo(owner, dronePeerId);
			expect(connections.some((c) => c.status === 'open' && c.direction === 'outbound')).toBe(true);
			// Both silent addresses were really tried first, each for its own limit —
			// and the whole pass came in far under the per-peer limit a single dial
			// over the list would have spent on the first of them.
			expect(silent.map((server) => server.accepted() > 0)).toEqual([true, true]);
			expect(elapsed).toBeGreaterThanOrEqual(2 * PER_ADDRESS_MS - 50);
			expect(elapsed).toBeLessThan(2 * PER_ADDRESS_MS + SLACK_MS);
		} finally {
			await owner.stop();
			await drone.stop();
			await Promise.all(silent.map((server) => server.close()));
		}
	}, 60_000);
});

/**
 * Owner genesis on the node itself — what the phone's `runOwnerGenesis` does: enroll
 * its own key in `OwnerKey` and bring up seed-bootstrap, so `addDrone` can owner-sign
 * the drone's `CadrePeer` row.
 */
async function makeOwnOwner(node: CadreNode, key: Awaited<ReturnType<typeof generateKeyPair>>): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	expect(db).not.toBeNull();
	await db!.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

function connectionsTo(node: CadreNode, peerId: string): ReturnType<Libp2p['getConnections']> {
	return (node.getControlNode()?.getConnections() ?? []).filter((c) => c.remotePeer.toString() === peerId);
}
