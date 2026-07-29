/**
 * Write-while-alone re-replication over the live control network.
 *
 * The inverse of `control-db-two-node-convergence.integration.ts`. That scenario
 * CONNECTS BEFORE WRITING so the cohort is ≥2 and the commit broadcasts. This one
 * does the opposite — the writer authors a control row while it is ALONE (no
 * sibling connected), so Optimystic commits it **local-only** (the block's cluster
 * is ≤1, so nothing is broadcast). It then connects and asserts the row still
 * converges to the reader, proving `control-write-ensure-replicated`: the writer
 * re-issues its local-only writes on the 0→≥1 control-connection growth edge.
 *
 * Without the fix these tests HANG (the reader never observes the row) — they are
 * the regression guard for the write-while-alone durability gap.
 *
 * `bootPair` still boots A and B DISCONNECTED (no dial yet), but A vouches B
 * (`authorizePeer`) right after B starts — a control-DB write, not a dial — so that
 * A's inbound connection gate (`admitInboundControlConnection`) will later admit B's
 * connect attempt. Without the vouch, A's cold-start carve-out (which admits any
 * peer while A has zero authorized members) closes the moment this scenario's own
 * `authorizePeer(xPeerId)` write lands, and B's connect would be refused.
 *
 * The connection itself is still formed with a test-only manual `dial()` over the
 * public `getControlNode()` seam (as the sibling convergence scenario does) — that
 * only forms the cohort; the RE-REPLICATION of the pre-connection write is the
 * production behaviour under test and is NOT test-scaffolded.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import { waitUntil, waitForCadrePeerConverged } from '../harness/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** WebSocket + circuit-relay transports, matching the other e2e scenarios. */
function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

interface NodeOpts {
	partyId: string;
	privateKey: PrivateKey;
	profile?: 'storage' | 'transaction';
	enableRelay?: boolean;
	listenAddrs?: string[];
}

/** Build a `CadreNodeConfig` for one control-network node. */
function nodeConfig(opts: NodeOpts): CadreNodeConfig {
	return {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		privateKey: opts.privateKey,
		network: {
			transports: wsTransports(),
			listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.enableRelay ? { enableRelay: true } : {}),
		},
		hibernation: { enabled: false },
	};
}

/** Make a freshly-started node its own control owner (genesis). */
async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and wait
 * until BOTH sides report it (the test-only stand-in for production cohort
 * discovery). The writer seeing the inbound connection is what fires its
 * `connection:open` growth edge and drains the write-while-alone queue.
 */
async function connectControlNodes(reader: CadreNode, writer: CadreNode): Promise<void> {
	const readerNode = reader.getControlNode()!;
	const writerNode = writer.getControlNode()!;
	const writerAddrs = writerNode.getMultiaddrs();
	expect(writerAddrs.length).toBeGreaterThan(0);

	await readerNode.dial(writerAddrs[0]!);
	await waitUntil(() => readerNode.getConnections().length > 0, {
		timeoutMs: 15_000,
		intervalMs: 250,
		description: 'reader control node connects to writer',
	});
	await waitUntil(() => writerNode.getConnections().length > 0, {
		timeoutMs: 15_000,
		intervalMs: 250,
		description: 'writer control node sees inbound connection from reader',
	});
}

/** A real Ed25519 peer id for a peer that is NEVER started (a pure row subject). */
async function randomPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/**
 * Boot node A (owner + writer, storage profile so it holds the CadrePeer
 * blocks) and node B (a plain READER — never its own owner), on a fresh party,
 * DISCONNECTED. Caller owns shutdown.
 */
async function bootPair(tag: string): Promise<{ A: CadreNode; B: CadreNode }> {
	const partyId = `ctrl-alone-${tag}-${Date.now()}`;

	const aKey = await generateKeyPair('Ed25519');
	const A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
	await A.start();
	await makeOwnOwner(A, aKey);

	const bKey = await generateKeyPair('Ed25519');
	const B = new CadreNode(nodeConfig({ partyId, privateKey: bKey, profile: 'transaction' }));
	await B.start();

	// A vouches B so A's inbound connection gate admits B's dial once A's authorized
	// set is non-empty (mirrors `bootPair` in control-db-two-node-convergence).
	await A.authorizePeer(B.peerId!.toString());

	return { A, B };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-DB write-while-alone re-replication', () => {
	it('re-replicates an owner CadrePeer row written while alone, once the cohort forms', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('cadrepeer'));

			// WRITE BEFORE CONNECT: A authorizes X while B is disconnected → local-only commit.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			// Sanity: A is genuinely alone at write time (no control connections).
			expect(A.getControlNode()!.getConnections().length).toBe(0);

			// NOW connect. A's connection:open drains the queue and re-issues the X write,
			// which — now that the cohort is ≥2 — broadcasts. Without the fix this hangs.
			await connectControlNodes(B, A);

			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 30_000,
				description: 'B observes the X CadrePeer row written on A while alone',
			});
			// ADDRESSABLE surface on purpose (`isMember` — row presence): the subject is
			// the write-while-alone re-replication drain, not trust. B pins no owner key,
			// so the trust-facing `isAuthorizedMember` would be false here by design —
			// the authorized surface is proven in push-wake-e2e scenario 4.
			expect(await B.isMember(xPeerId)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 60_000);

	it('converges a DeviceToken self-registered while alone, once the cohort forms', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('devtoken'));
			const aPeerId = A.peerId!.toString();

			// A publishes its OWN CadrePeer record AND DeviceToken while ALONE → both
			// commit local-only. (registerSelf is idempotent with the startup publish.)
			await A.registerSelf();
			await A.registerDeviceToken('fcm', 'tok-written-while-alone');
			expect(A.getControlNode()!.getConnections().length).toBe(0);

			// Connect — A's growth edge re-touches BOTH self rows so they broadcast.
			await connectControlNodes(B, A);

			// B resolving A's push token requires A's CadrePeer.PublicKey AND DeviceToken,
			// both of which reach B only via the re-replication drain.
			await waitUntil(
				async () => {
					const rec = await B!.resolveDeviceToken(aPeerId);
					return rec?.token === 'tok-written-while-alone';
				},
				{
					timeoutMs: 30_000,
					intervalMs: 250,
					description: 'B resolves A DeviceToken re-replicated after cohort growth',
				}
			);
			const resolved = await B.resolveDeviceToken(aPeerId);
			expect(resolved?.token).toBe('tok-written-while-alone');
			expect(resolved?.platform).toBe('fcm');
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 60_000);
});
