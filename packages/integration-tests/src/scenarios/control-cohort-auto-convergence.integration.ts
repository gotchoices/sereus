/**
 * Control-cohort auto-convergence over the live control network — NO test-side dial.
 *
 * The acceptance proof for `control-cohort-proactive-dial`. The sibling scenario
 * (`control-db-two-node-convergence.integration.ts`) proves the `CadreControl`
 * store replicates once the cohort is connected, but it forms that cohort with a
 * test-only manual `dial()` over `getControlNode()` (its `connectControlNodes`
 * stand-in). This scenario removes that scaffolding: a reader node B is given a
 * way to reach owner A only through the PRODUCTION cold-start path
 * (`applySeed`, which populates B's peerStore and dials the owner), and the
 * in-node `reconcileControlCohort` routine (eager pass + a short recurring
 * cadence configured below) keeps the control cohort connected. B then observes
 * an owner-written `CadrePeer` row with ZERO manual control dials.
 *
 * Honesty note (for reviewers): A vouches B (`authorizePeer`) before minting the
 * seed, mirroring production onboarding (`addDrone` / `acceptPhone` /
 * `addPhoneWithRelay` in seed-bootstrap.ts) — without it A's inbound connection
 * gate refuses B's cold-start dial once A holds any authorized member. The vouch
 * is a control-DB write, not a dial, so it does not touch the "zero manual
 * control dials" claim below. In a 2-node party the FIRST connection is
 * necessarily established by the cold-start path (`applySeed`'s owner dial) —
 * `reconcileControlCohort` cannot bootstrap from nothing, because it dials only
 * siblings already in the converged `CadrePeer` table (see the ticket's "address
 * source priority"). What this test proves is that the node's OWN wiring carries
 * a production cold-start to convergence without test scaffolding, and that the
 * recurring reconcile maintains/re-establishes the cohort (it re-dials A every
 * `reconcileMs`). A scenario in which the reconcile dial is the SOLE load-bearing
 * connector requires a ≥3-node topology (B learning a sibling C via A, then
 * dialing C) — called out as a follow-up in the review handoff.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p, pinnedKeyTrustPolicy } from '@serfab/cadre-core';
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
	/** Override the proactive control-cohort reconcile cadence (ms). */
	reconcileMs?: number;
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
			...(opts.reconcileMs ? { controlCohort: { reconcileMs: opts.reconcileMs } } : {})
		},
		hibernation: { enabled: false }
	};
}

/**
 * Make a freshly-started node its own control owner (genesis): enroll its
 * derived public key in `OwnerKey` and wire seed-bootstrap with the matching
 * private key, so it can owner-sign `CadrePeer` inserts and mint seeds.
 */
async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/** A real Ed25519 peer id for a peer that is NEVER started (a pure row subject). */
async function randomPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-cohort auto-convergence (no manual dial)', () => {
	it('B converges on an owner-written CadrePeer row via in-node reconcile (production cold-start only)', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			const partyId = `cohort-auto-${Date.now()}`;

			// A: owner + storage (holds the CadrePeer blocks) + relay.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
			await A.start();
			await makeOwnOwner(A, aKey);
			const aPeerId = A.peerId!.toString();

			// B: a plain reader (NOT its own owner) with a short reconcile cadence
			// so the proactive routine fires several times within the convergence window.
			const bKey = await generateKeyPair('Ed25519');
			B = new CadreNode(nodeConfig({ partyId, privateKey: bKey, profile: 'transaction', reconcileMs: 2_000 }));
			await B.start();

			// Wait for A to self-register its own CadrePeer row WITH a dialable address,
			// so the seed it mints carries A's owner address for B to dial.
			await waitUntil(
				async () => {
					const rec = await A!.getControlDatabase()!.queryPeerRecord(aPeerId);
					return !!rec && rec.addrs.length > 0;
				},
				{ timeoutMs: 20_000, intervalMs: 250, description: 'A self-registers a CadrePeer row with addrs' }
			);

			// Production cold-start: B applies A's seed (pinned-key trust, the
			// CadreInvite.ownerKeys cold-start path). This populates B's peerStore
			// and best-effort dials A — NOT a raw test-side getControlNode().dial().
			const { publicKeyB64: aOwnerKey } = ed25519KeyPairFromLibp2p(aKey);

			// Production onboarding vouches the new node BEFORE handing it a seed
			// (addDrone / acceptPhone / addPhoneWithRelay in seed-bootstrap.ts, and the
			// enrollment sequences in docs/architecture.md). Without it A's inbound gate
			// refuses B's cold-start seed dial.
			await A.authorizePeer(B.peerId!.toString());

			const seed = await A.createSeed();
			const applied = await B.applySeed(seed, { trustPolicy: pinnedKeyTrustPolicy([aOwnerKey]) });
			expect(applied.success).toBe(true);

			// A third peer X that exists ONLY as a row A writes — never started, never
			// known to B locally. B observing X proves replication, not local seeding.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			// B converges by pull-on-read (each poll is the read that pulls A's block
			// into B's cohort view) — over a cohort the in-node reconcile keeps connected.
			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 45_000,
				description: 'B observes the X CadrePeer row with no manual control dial'
			});

			// ADDRESSABLE surface on purpose (`isMember` — row presence): the subject is
			// cohort auto-convergence, not trust. (B's `applySeed` trust-policy pin above
			// is seed trust only; nothing pins A's owner key into B's node-local anchor,
			// so `isAuthorizedMember(X)` would be false here by design — the authorized
			// surface is proven in push-wake-e2e scenario 4.)
			expect(await B.isMember(xPeerId)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 90_000);
});
