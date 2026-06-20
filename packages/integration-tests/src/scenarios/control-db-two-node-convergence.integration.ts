/**
 * Two-node control-DB convergence over the live control network.
 *
 * INTENDED as the regression anchor for the claim that the `CadreControl` store
 * **replicates peer-to-peer** across a party's cadre nodes (docs/architecture.md
 * — `CadrePeer` as the "authoritative, replicated form"). Building it surfaced
 * that the claim is **not yet true in the wiring**, so this file currently
 * documents the gap and ships the proven recipe ready to flip once it closes.
 *
 * ── What the investigation found (root cause — read before reviewing) ─────────
 *
 * The source ticket's premise was that the control DB already replicates via the
 * Optimystic network transactor and only *cohort discovery* was missing. That is
 * WRONG. The CadreControl tables are **not network-backed at all**:
 *
 *   - `ControlDatabase.initialize()` registers the optimystic plugin with
 *     `default_transactor: 'network'`, but it never calls
 *     `db.setDefaultVtabName('optimystic')` / `setDefaultVtabArgs(...)`. So the
 *     `declare schema CadreControl { table ... }` tables (which carry no per-table
 *     `using optimystic(...)`) fall back to Quereus's built-in IN-MEMORY vtab.
 *   - The strand path does the opposite: `connectToStrand`
 *     (@serfab/quereus-plugin-sereus) sets the default vtab + args + hydrates
 *     before applying its schema, so strand tables ARE network-backed — which is
 *     why strand replication converges (strand-formation/convergence-stress) in
 *     ~1.5s while the control DB never converges.
 *   - Empirical proof: with `DEBUG=optimystic:*`, a control write emits ZERO
 *     optimystic lines (no transactor/cluster/coordinator activity); the
 *     analogous strand write emits thousands.
 *
 * A spike that adds the missing `setDefaultVtabName` + `setDefaultVtabArgs` +
 * `hydrate` to `ControlDatabase` made BOTH cases below converge for real (primary
 * connect-then-write in ~2.0s; the write-then-connect local-only row healed via
 * pull-on-read once the cohort formed). BUT it also broke 9 cadre-core
 * consent-path tests (`control-formation-invite.spec.ts`,
 * `strand-formation-consent.spec.ts`, `control-authorization-binding.spec.ts`)
 * with `CHECK constraint failed: Monotonic` — the network transactor's
 * `committed.*` snapshot / deferred-CHECK / multi-statement-transaction semantics
 * differ from the in-memory vtab that `redeemInvitation`/`recordFormationUsage`
 * rely on. Network-backing the control DB is therefore a substantial production
 * change (it must reconcile those transaction semantics), tracked separately in
 * `tickets/.../control-db-network-backed`. It is NOT the same concern as
 * `control-network-cohort-discovery` (auto-connect): even with perfect
 * connectivity, in-memory tables cannot replicate.
 *
 * ── What this file delivers now ──────────────────────────────────────────────
 *
 *   1. A RUNNING tripwire (`current behaviour`) that exercises the full recipe —
 *      direct control-network dial + both-sides wait + authority write + poll —
 *      and asserts the row does NOT cross to the peer. When `control-db-network-
 *      backed` lands, convergence will start happening inside the window and this
 *      test will go RED, prompting whoever fixes the wiring to delete it and
 *      un-skip the target below.
 *   2. A SKIPPED target (`target behaviour`) holding the proven positive
 *      convergence assertion, verified to pass in the spike. Un-skip it (and drop
 *      the tripwire) the moment the control DB is network-backed.
 *
 * Both stand in for production control-cohort discovery with a test-only manual
 * `dial()` over the existing public `getControlNode()` seam — exactly as the
 * strand scenarios manually dial strand nodes.
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
	// ── CURRENT BEHAVIOUR (tripwire): control tables are in-memory, so a row
	//    written on A never crosses to B even with the cohort connected. Delete
	//    this test and un-skip the target below once `control-db-network-backed`
	//    wires the control tables to the network transactor. ───────────────────

	it('does NOT yet replicate a CadrePeer row cross-node (control tables are in-memory — see control-db-network-backed)', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('gap'));

			// Form the cohort BEFORE the write (the recipe that converges for strands).
			await connectControlNodes(B, A);

			// A authority-signs + inserts a CadrePeer row for a third peer X.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true); // the write commits LOCALLY on A

			// TRIPWIRE: today B never observes X — the CadreControl tables are not
			// network-backed (see file header). The window is comfortably longer than
			// the ~2s convergence the wiring spike achieved, so once the control DB is
			// network-backed this rejection STOPS and the test fails loudly, signalling
			// "delete me; un-skip the target".
			await expect(
				waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
					timeoutMs: 12_000,
					description: 'B observes the X CadrePeer row written on A',
				}),
			).rejects.toThrow(/Timeout/);

			// The production authorization gate confirms the gap: B does not recognise X.
			expect(await B.isMember(xPeerId)).toBe(false);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 40_000);

	// ── TARGET BEHAVIOUR (skipped): the proven positive convergence assertion.
	//    Verified to PASS (~2.0s) in the wiring spike that added
	//    setDefaultVtabName/setDefaultVtabArgs/hydrate to ControlDatabase. Un-skip
	//    this (and delete the tripwire above) once `control-db-network-backed`
	//    lands. The recipe is intentionally identical to the strand scenarios. ──

	it.skip('replicates an authority-written CadrePeer row from node A to node B over the live control network', async () => {
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
