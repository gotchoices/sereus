/**
 * Two-node control-DB convergence over the live control network.
 *
 * The regression anchor for the claim that the `CadreControl` store **replicates
 * peer-to-peer** across a party's cadre nodes (docs/architecture.md — `CadrePeer`
 * as the "authoritative, replicated form"). Network-backing has now LANDED
 * (`control-db-network-backed`), so this asserts the positive convergence directly.
 *
 * How it was wired (context for reviewers):
 *
 * `ControlDatabase.initialize()` now mirrors `connectToStrand`
 * (@serfab/quereus-plugin-sereus): after registering the optimystic plugin and the
 * libp2p node it calls `db.setDefaultVtabName('optimystic')` +
 * `setDefaultVtabArgs({ transactor: 'network', ... })` and hydrates the catalog
 * BEFORE applying `CONTROL_SCHEMA`. The `declare schema CadreControl { table ... }`
 * tables carry no per-table `using optimystic(...)`, so routing the DEFAULT vtab to
 * the network transactor is what makes a control write replicate (a control write
 * now emits the same optimystic transactor/cluster/coordinator activity a strand
 * write does). Before that fix the tables fell back to Quereus's in-memory vtab and
 * never converged.
 *
 * Network-backing also required closing a transaction-semantics gap in the Optimystic
 * vtab: a deferred CHECK referencing `committed.<Table>` (the
 * `FormationUsage.Monotonic` anti-replay) must read the pre-transaction snapshot, so
 * the vtab now honours Quereus's `_readCommitted` flag (and enforces secondary-UNIQUE
 * constraints for the single-use StampId columns). That work lives in the
 * `../optimystic` workspace; the green cadre-core consent suite depends on it being
 * built and linked.
 *
 * This scenario isolates the *replication-given-a-connected-cohort* behavior, so it
 * still forms the cohort with a test-only manual `dial()` over the public
 * `getControlNode()` seam — exactly as the strand scenarios manually dial strand
 * nodes. Production auto-connect (nodes forming the control cohort with no manual
 * dial) now lands via `CadreNode.reconcileControlCohort` and is proven end-to-end,
 * with zero manual control dials, by `control-cohort-auto-convergence.integration.ts`.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, authorityKeyFromLibp2p } from '@serfab/cadre-core';
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

/**
 * Make a freshly-started node its own control authority (genesis): enroll its
 * derived public key in `AuthorityKey` and wire seed-bootstrap with the matching
 * private key, so it can authority-sign `CadrePeer` inserts into its control DB.
 * (Mirrors `makeOwnAuthority` in push-wake-e2e.integration.ts.)
 */
async function makeOwnAuthority(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertAuthorityKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and
 * wait until BOTH sides report it — the test-only stand-in for production
 * control-cohort discovery. Both-sides confirmation is a hard precondition of a
 * replicating write: only once each peer sees the connection can FRET place each
 * in the other's cohort for the control collection key.
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
 * Boot node A (authority + writer, storage profile so it holds the CadrePeer
 * blocks) and node B (a plain READER — deliberately NOT its own authority, so it
 * can never self-insert any CadrePeer row; every row it observes must have
 * arrived over the wire), on a fresh party. Caller owns shutdown.
 */
async function bootPair(tag: string): Promise<{ A: CadreNode; B: CadreNode }> {
	const partyId = `ctrl-${tag}-${Date.now()}`;

	const aKey = await generateKeyPair('Ed25519');
	const A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
	await A.start();
	await makeOwnAuthority(A, aKey);

	const bKey = await generateKeyPair('Ed25519');
	const B = new CadreNode(nodeConfig({ partyId, privateKey: bKey, profile: 'transaction' }));
	await B.start();

	return { A, B };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Two-node control-DB convergence', () => {
	// The control tables are network-backed (default vtab → optimystic network
	// transactor), so an authority-written CadrePeer row on A converges to a connected
	// reader B by pull-on-read. The recipe is intentionally identical to the strand
	// convergence scenarios.

	it('replicates an authority-written CadrePeer row from node A to node B over the live control network', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('converge'));

			// CONNECT BEFORE WRITE so the cohort is ≥2 and the commit is not local-only.
			await connectControlNodes(B, A);

			// A third peer X that exists ONLY as a row A writes — never started, never
			// known to B locally. B observing X proves replication, not local seeding.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			// B converges by READING (pull-on-read): each poll is the read that pulls
			// A's CadrePeer block into B's cohort view.
			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 30_000,
				description: 'B observes the X CadrePeer row written on A',
			});

			// The production authorization gate now passes on B via convergence, not seeding.
			expect(await B.isMember(xPeerId)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 60_000);
});
