import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { PeerUnreachableError } from '../src/peer-dial.js';
import { startSilentServer, type SilentServer } from './silent-server.js';

/**
 * A phone-shaped owner reaches a node whose address list starts with addresses that
 * never answer: on the reconcile pass that adding it as a drone starts, and when claiming it.
 *
 * The shape of a phone borrowing or claiming a node from a cadre-host: the phone cannot
 * listen, so it must dial, and the addresses it was handed are the only ones it has. The
 * host's addresses that never answer — LAN addresses its firewall drops, or a public
 * address the home router does not loop back — come before the one that works. One
 * `dial()` over the whole list spends the time allowed on the first of them, and the
 * working address is never tried.
 *
 * The drone is a plain libp2p node rather than a `CadreNode`: the claim is about the
 * owner's dial, and a plain node accepts it without a control database of its own. The
 * claimed node is a `CadreNode` started with a claim secret, since the claim has to be
 * answered. The dropped addresses are loopback servers that never answer (`silent-server.ts`).
 */

/**
 * Small, so the test is quick; the per-peer limit below is what the old dial would exhaust.
 *
 * The live address has to connect inside this after the two silent ones each spend it. Measured
 * (the `dial-past-dead:` lines each case prints, whole pass past the two silent addresses):
 * isolated 1120 ms (reconcile) and 1154 ms (claim); under a full `yarn workspace @serfab/cadre-core
 * test` run, three runs, 1204–1357 ms (reconcile) and 1274–1513 ms (claim). So the live dial plus
 * the pass's remaining work took at most 357 ms of this limit under load (the claim's figure also
 * holds the seed exchange after the dial). Raise this only on a measurement showing the live
 * attempt itself timing out.
 */
const PER_ADDRESS_MS = 500;
const PER_PEER_MS = 5_000;
/** Scheduling room on a loaded machine; far below the per-peer limit the old dial needed. */
const SLACK_MS = 2_000;

describe('CadreNode — adding a drone whose first addresses never answer', () => {
	it('connects on the reconcile pass the add starts, past two silent addresses, with no other dial', async () => {
		const drone = await createLibp2p({
			addresses: { listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
			transports: [webSockets()],
			connectionEncrypters: [noise()],
			streamMuxers: [yamux()],
		});
		const silent: SilentServer[] = [await startSilentServer(), await startSilentServer()];
		const owner = await buildPhoneOwner();

		try {
			await startAsOwnOwner(owner);

			const dronePeerId = drone.peerId.toString();
			const droneWs = drone.getMultiaddrs().map((addr) => addr.toString()).find((addr) => addr.includes('/ws'));
			expect(droneWs).toBeDefined();
			const addStarted = Date.now();
			await owner.node.addDrone({
				dronePeerId,
				droneMultiaddrs: [...silent.map((server) => server.wsAddr), droneWs!],
			});
			const addMs = Date.now() - addStarted;
			// Nothing is dialed inside addDrone; the drone's row change starts the pass that
			// dials, about 50 ms later, and a pass joined mid-flight (the one start() kicks)
			// would have listed siblings before the add. Waiting for the connection, rather
			// than running a pass here, measures the pass the add itself earns.
			expect(connectionsTo(owner.node, dronePeerId)).toEqual([]);
			const started = Date.now();
			await waitForOutboundConnection(owner.node, dronePeerId, 2 * PER_ADDRESS_MS + SLACK_MS);
			const elapsed = Date.now() - started;
			console.log(`dial-past-dead: addDrone took ${addMs} ms; its reconcile pass connected past two silent addresses ${elapsed} ms after it returned`);

			// Both silent addresses were really tried first, each for its own limit —
			// and the connection came in far under the per-peer limit a single dial
			// over the list would have spent on the first of them.
			expect(silent.map((server) => server.accepted() > 0)).toEqual([true, true]);
			expect(elapsed).toBeGreaterThanOrEqual(2 * PER_ADDRESS_MS - 50);
			expect(elapsed).toBeLessThan(2 * PER_ADDRESS_MS + SLACK_MS);
		} finally {
			await owner.node.stop();
			await drone.stop();
			await Promise.all(silent.map((server) => server.close()));
		}
	}, 60_000);
});

describe('CadreNode — claiming a node whose first addresses never answer', () => {
	it('reaches the node past two silent addresses and the claim is accepted', async () => {
		const secret = randomBytes(32).toString('base64url');
		const claimable = new CadreNode({
			controlNetwork: { partyId: 'unclaimed', bootstrapNodes: [] },
			profile: 'transaction',
			storage: { provider: new MemoryRawStorage() },
			network: { transports: [webSockets()], listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] },
			claim: { secret, record: async () => {} },
		});
		const silent: SilentServer[] = [await startSilentServer(), await startSilentServer()];
		const owner = await buildPhoneOwner();

		try {
			await claimable.start();
			const nodePeerId = claimable.peerId!.toString();
			const nodeWs = claimable.getMultiaddrs().find((addr) => addr.includes('/ws'));
			expect(nodeWs).toBeDefined();
			await startAsOwnOwner(owner);

			const started = Date.now();
			await owner.node.claimNode({
				peerId: nodePeerId,
				multiaddrs: [...silent.map((server) => server.wsAddr), nodeWs!],
				secret,
			});
			const elapsed = Date.now() - started;
			console.log(`dial-past-dead: claim past two silent addresses took ${elapsed} ms`);

			expect(claimable.isAwaitingClaim()).toBe(false);
			expect(silent.map((server) => server.accepted() > 0)).toEqual([true, true]);
			// The old single dial spent the whole seed-delivery deadline (28.5 s) on the first.
			expect(elapsed).toBeGreaterThanOrEqual(2 * PER_ADDRESS_MS - 50);
			expect(elapsed).toBeLessThan(2 * PER_ADDRESS_MS + SLACK_MS);
		} finally {
			await owner.node.stop();
			await claimable.stop();
			await Promise.all(silent.map((server) => server.close()));
		}
	}, 60_000);

	it('rejects with PeerUnreachableError naming the node when no address answers', async () => {
		const nodePeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const silent: SilentServer[] = [await startSilentServer(), await startSilentServer()];
		const owner = await buildPhoneOwner();

		try {
			await startAsOwnOwner(owner);

			const failure = await owner.node.claimNode({
				peerId: nodePeerId,
				multiaddrs: silent.map((server) => server.wsAddr),
				secret: randomBytes(32).toString('base64url'),
			}).catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(PeerUnreachableError);
			expect(failure).toMatchObject({ peerId: nodePeerId });
			expect(silent.map((server) => server.accepted() > 0)).toEqual([true, true]);
		} finally {
			await owner.node.stop();
			await Promise.all(silent.map((server) => server.close()));
		}
	}, 60_000);
});

interface PhoneOwner {
	node: CadreNode;
	key: Awaited<ReturnType<typeof generateKeyPair>>;
}

/** A phone-posture owner node, not yet started, with the small dial limits above. */
async function buildPhoneOwner(): Promise<PhoneOwner> {
	const key = await generateKeyPair('Ed25519');
	const node = new CadreNode({
		controlNetwork: { partyId: `dial-past-dead-${Math.random().toString(36).slice(2)}`, bootstrapNodes: [] },
		privateKey: key,
		profile: 'transaction',
		storage: { provider: new MemoryRawStorage() },
		network: {
			// The phone's posture: WebSockets only, nothing to listen on.
			transports: [webSockets()],
			listenAddrs: [],
			controlCohort: {
				perAddressDialTimeoutMs: PER_ADDRESS_MS,
				dialTimeoutMs: PER_PEER_MS,
				// No backstop pass inside a test: the passes that dial here are the ones a
				// membership change starts (addDrone, claimNode) and the ones a test runs.
				// A dial those passes leave unconnected is retried 15 s later, past every case.
				reconcileMs: 3_600_000,
			},
		},
	});
	return { node, key };
}

/**
 * Start `owner` and run owner genesis on it — what the phone's `runOwnerGenesis` does:
 * enroll its own key in `OwnerKey` and bring up seed-bootstrap, so `addDrone` can
 * owner-sign the drone's `CadrePeer` row and `claimNode` can sign its seed.
 */
async function startAsOwnOwner(owner: PhoneOwner): Promise<void> {
	await owner.node.start();
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(owner.key);
	const db = owner.node.getControlDatabase();
	expect(db).not.toBeNull();
	await db!.insertOwnerKey(publicKeyB64);
	await owner.node.initializeSeedBootstrap(privateKeyB64);
	// Let the pass `start()` kicks off finish first: a call made while it runs joins it,
	// and it listed siblings before anything the test adds existed.
	await owner.node.reconcileControlCohort();
}

function connectionsTo(node: CadreNode, peerId: string): ReturnType<Libp2p['getConnections']> {
	return (node.getControlNode()?.getConnections() ?? []).filter((c) => c.remotePeer.toString() === peerId);
}

/** Resolve once `node` holds an open outbound control connection to `peerId`; reject after `timeoutMs`. */
async function waitForOutboundConnection(node: CadreNode, peerId: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!connectionsTo(node, peerId).some((c) => c.status === 'open' && c.direction === 'outbound')) {
		if (Date.now() > deadline) {
			throw new Error(`no outbound control connection to ${peerId} within ${timeoutMs} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
