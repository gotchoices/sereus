/**
 * Cold-start bootstrap RETRY: a joining node recovers from a refused first dial.
 *
 * The acceptance proof for `cold-start-control-redial`. The sibling scenario
 * (`control-cohort-auto-convergence.integration.ts`) proves the happy cold start:
 * `applySeed`'s single owner dial lands, and the in-node reconcile keeps the
 * cohort connected from there. This one removes that luck.
 *
 * `SeedBootstrapService.applySeed` dials the seed's owner peers exactly ONCE,
 * best-effort — a throw is logged and swallowed, and the seed still reports
 * success. Before the fix nothing ever dialed again: `reconcileControlCohort`
 * enumerates siblings from the REPLICATED `CadrePeer` table, which is empty at
 * cold start precisely because no connection was ever established, so every pass
 * returned at its sibling check. A node whose first dial lost the race was
 * stranded permanently.
 *
 * The failure is forced with no test doubles, using the production gate that
 * causes it in the field: B applies A's seed BEFORE A vouches B, so A's
 * membership connection gater refuses the inbound connection. A vouches B only
 * afterwards; B must then find its way back in on its own.
 *
 * Two details make the proof unambiguous:
 *  - B listens on NOTHING (`listenAddrs: []`, the client-only profile an RN/phone
 *    node uses). A therefore cannot dial B, so the connection that eventually
 *    exists can only be one B dialed.
 *  - The assertion checks `direction === 'outbound'` on B's side as well.
 *
 * Without the cold-start branch in `reconcileControlCohort`, step 5 below times
 * out: B logs `refreshAuthorizedControlPeers(reconcile)` every pass and never
 * dials anything.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, ed25519KeyPairFromLibp2p, pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import {
	waitUntil, waitForCadrePeerConverged,
	controlNodeConfig, makeOwnOwner, randomPeerId, connectionsTo,
} from '../harness/index.js';

// ═══════════════════════════════════════════════════════════════════════════════

describe('Cold-start bootstrap retry (first dial refused)', () => {
	it('B recovers from a refused seed dial and converges on a later reconcile pass', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			const partyId = `cold-retry-${Date.now()}`;

			// A: owner + storage (holds the CadrePeer blocks) + relay.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
			await A.start();
			await makeOwnOwner(A, aKey);
			const aPeerId = A.peerId!.toString();

			// B: a client-only reader (listens on nothing, so only B can start a
			// connection) with a short reconcile cadence, so the cold-start branch
			// fires several times inside the convergence window.
			const bKey = await generateKeyPair('Ed25519');
			B = new CadreNode(controlNodeConfig({
				partyId, privateKey: bKey, profile: 'transaction', listenAddrs: [], reconcileMs: 2_000
			}));
			await B.start();
			const bPeerId = B.peerId!.toString();

			// Wait for A to self-register its own CadrePeer row WITH a dialable address,
			// so the seed it mints carries A's owner address for B to dial.
			await waitUntil(
				async () => {
					const rec = await A!.getControlDatabase()!.queryPeerRecord(aPeerId);
					return !!rec && rec.addrs.length > 0;
				},
				{ timeoutMs: 20_000, intervalMs: 250, description: 'A self-registers a CadrePeer row with addrs' }
			);

			// 1. Arm A's inbound gate. `admitInboundControlConnection` admits everyone
			//    while A knows of no authorized member at all, so vouch a decoy peer
			//    (never started, pure row subject) to close that cold-start carve-out.
			//    Now A denies any inbound peer it has not vouched — which is B.
			const decoyPeerId = await randomPeerId();
			await A.authorizePeer(decoyPeerId);

			// 2. B applies A's seed while still UNVOUCHED. The seed itself is accepted
			//    (signature + pinned owner key), but its one owner dial cannot survive
			//    A's gate. This is the production failure the ticket describes — an
			//    owner that is momentarily unreachable produces the same state.
			const { publicKeyB64: aOwnerKey } = ed25519KeyPairFromLibp2p(aKey);
			const seed = await A.createSeed();
			const applied = await B.applySeed(seed, { trustPolicy: pinnedKeyTrustPolicy([aOwnerKey]) });
			expect(applied.success).toBe(true);
			// A is the seed's only owner peer with an address, so exactly one dial is
			// attempted. `ownerDialsFailed` is deliberately NOT asserted: A's gate denies
			// AFTER the dialer's upgrade completes, so the dial may or may not throw.
			expect(applied.ownerDialsAttempted).toBe(1);

			// 3. Confirm the first dial really did not stick. A's deny lands AFTER the
			//    dialer's upgrade completes (see createMembershipConnectionGater), so
			//    `dial()` may resolve and the connection die moments later — poll for
			//    the settled state rather than asserting on the dial's return value.
			await waitUntil(
				() => connectionsTo(B!, aPeerId).length === 0,
				{ timeoutMs: 10_000, intervalMs: 200, description: "B's cold-start seed dial is refused" }
			);

			// 4. A vouches B, exactly as a delayed/retried onboarding would. Nothing
			//    dials on B's behalf here: B listens on nothing, so A cannot reach it,
			//    and B's one seed dial is already spent.
			await A.authorizePeer(bPeerId);

			// 5. THE REGRESSION ASSERTION. Only the cold-start branch of
			//    `reconcileControlCohort` can produce this connection — B's CadrePeer
			//    table is still empty, so the steady-state sibling path has nothing to
			//    enumerate. `direction === 'outbound'` proves B dialed it.
			await waitUntil(
				() => connectionsTo(B!, aPeerId).some((c) => c.direction === 'outbound'),
				{ timeoutMs: 45_000, intervalMs: 250, description: 'B re-dials A from its retained seed addresses' }
			);

			// 6. And the recovered connection is a working control cohort: a row A
			//    writes now (a third peer X that exists ONLY as a row — never started,
			//    never known to B locally) replicates to B by pull-on-read.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 45_000,
				description: 'B observes the X CadrePeer row after cold-start recovery'
			});
			expect(await B.isMember(xPeerId)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 120_000);
});
