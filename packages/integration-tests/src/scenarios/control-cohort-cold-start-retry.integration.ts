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
 * A third detail is what makes the FORCED refusal reachable at all: A passes
 * `enableRelay: false`, and must keep passing it. Relay is NOT off by default
 * here — `CadreNode.relayServerEnabled` defaults it to `profile === 'storage'`,
 * and A is a storage node — so omitting the flag leaves the relay server ON. On
 * a node running it the gater answers an unplaceable peer with
 * `'admit-for-relay'` rather than a deny (see `membership-connection-gater.ts` →
 * "The relay-reservation seam"): B's dial is ADMITTED and only aborted at the
 * 5 s not-reserving deadline, and B — which learns of that abort no sooner than
 * its next connection-monitor ping — holds the dead connection `open` for
 * several seconds beyond that. Step 3 below then never observes the refusal it
 * exists to pin, and step 5 would be satisfied by the seed dial's own still-live
 * connection rather than by a re-dial, proving nothing. A relay-less owner is
 * also the sharper model of the failure this scenario is about: an owner that
 * refuses, or is simply unreachable, at the moment the seed lands.
 *
 * WHY STEP 3b STRIPS A FROM B's peerStore — read this before deleting that
 * step. Without it the scenario proves nothing: measured 2026-08-20, with
 * `CadreNode.dialColdStartBootstrap` neutralized it still went green in ~3.5 s,
 * because a SECOND dialer produces B's outbound connection. That dialer is
 * p2p-fret's stabilization loop (`FretService.stabilizeOnce`, re-armed every
 * 300 ms in active mode). It dials A by BARE PEER ID, and libp2p resolves a bare
 * id to an address out of B's libp2p peerStore — the entry
 * `SeedBootstrapService.applySeed` wrote when it made the dial step 3 watches
 * fail. FRET only treats a peer as dialable while it holds an address for it
 * (`isDialable = hasAddresses || isConnected`, and the address set is rebuilt
 * wholesale from `peerStore.all()` on every tick), so deleting that one entry
 * takes out the whole competing route — FRET's, optimystic's bare-peer-id dial
 * paths, and libp2p's own reconnect machinery lose their address for A together.
 *
 * `dialColdStartBootstrap` never touches the libp2p peerStore. It dials the
 * multiaddrs cadre-core retained in its OWN `bootstrapPeerStore` at seed-apply
 * time (`recordSeedBootstrapPeers`), binding each to A's peer id. The two
 * dialers have INDEPENDENT address sources, which is exactly what lets step 3b
 * remove one and leave the other intact; afterwards the cold-start branch is the
 * only thing left that can produce an outbound B→A connection, so step 5
 * measures that branch and nothing else. Nothing re-populates the stripped entry
 * in between: identify needs a connection (there is none), `warmSiblingAddrBook`
 * needs siblings (the table is empty), and `applySeed` has already run. Once the
 * cold-start dial lands, identify refills the entry normally — the strip is a
 * one-shot, and step 6 is unaffected.
 *
 * Measured at `370ad30` with the strip in place: branch intact → green 3/3
 * (~4 s); branch early-returning → RED 3/3, with no dialer at all reconnecting B
 * to A inside the full 45 s window. To re-verify after changing either side, add
 * an early `return` at the top of `CadreNode.dialColdStartBootstrap`, run
 * `yarn workspace @serfab/cadre-core build`, run this scenario and require RED at
 * step 5; then restore the file, rebuild, and require green.
 *
 * ABOUT THE FEATURE, not the test: in a live deployment the cold-start branch
 * overlaps with FRET's probes rather than standing alone — which cases each one
 * actually covers is written up in `docs/architecture.md` (control-cohort
 * reconcile → "Cold-start bootstrap retries"), not repeated here.
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

			// A: owner + storage (holds the CadrePeer blocks). `enableRelay: false` is
			// load-bearing and overrides the storage-profile default — see the module
			// doc: with the relay server on, A's gate admits B for relay instead of
			// refusing it, and step 3's forced refusal never happens.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: false }));
			await A.start();
			await makeOwnOwner(A, aKey);
			const aPeer = A.peerId!;
			const aPeerId = aPeer.toString();

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
			//    dialer's upgrade completes (noise negotiates the muxer in the security
			//    handshake's early data, see createMembershipConnectionGater), so
			//    `dial()` may resolve and the connection die moments later — poll for
			//    the settled state rather than asserting on the dial's return value.
			await waitUntil(
				() => connectionsTo(B!, aPeerId).length === 0,
				{ timeoutMs: 10_000, intervalMs: 200, description: "B's cold-start seed dial is refused" }
			);

			// 3b. Strip A from B's libp2p peerStore. LOAD-BEARING, not tidy-up — this
			//     is what gives step 5 its teeth, and the module doc above explains why
			//     at length. Short version: `applySeed`'s refused dial left A's address
			//     in that store, p2p-fret's stabilization loop dials A by bare peer id
			//     off exactly that entry, and it reconnects B on its own — so step 5
			//     passed even with the cold-start branch neutralized. Deleting the entry
			//     removes FRET's route and every other bare-peer-id dialer's with it.
			//     `dialColdStartBootstrap` dials cadre-core's own `bootstrapPeerStore`,
			//     which this deliberately does NOT touch, so it is left as the only
			//     producer of the outbound connection step 5 waits for.
			await B.getControlNode()!.peerStore.delete(aPeer);
			await waitUntil(
				async () => {
					const store = B!.getControlNode()!.peerStore;
					// Tolerates both shapes libp2p may leave behind: entry gone, or a bare
					// record with no addresses. Either one is un-dialable by peer id.
					return !(await store.has(aPeer)) || (await store.get(aPeer)).addresses.length === 0;
				},
				{ timeoutMs: 5_000, intervalMs: 100, description: "B's peerStore holds no address for A" }
			);

			// 4. A vouches B, exactly as a delayed/retried onboarding would. Nothing
			//    dials on B's behalf here: B listens on nothing, so A cannot reach it,
			//    and B's one seed dial is already spent.
			await A.authorizePeer(bPeerId);

			// 5. THE REGRESSION ASSERTION. Only the cold-start branch of
			//    `reconcileControlCohort` can produce this connection — B's CadrePeer
			//    table is still empty, so the steady-state sibling path has nothing to
			//    enumerate, and step 3b removed the peerStore address every bare-peer-id
			//    dialer needs. `direction === 'outbound'` proves B dialed it.
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
