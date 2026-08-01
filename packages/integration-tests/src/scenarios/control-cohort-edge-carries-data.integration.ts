/**
 * The control-cohort edge CARRIES DATA — not merely exists.
 *
 * `control-cohort-three-node-isolation.integration.ts` proves that
 * `CadreNode.reconcileControlCohort` is what FORMS the B→C connection, but its
 * end-state check says twice, in its own comments, that the revision it
 * observes may still have travelled through A — it proves the cohort converges
 * with B↔C in place, not that the B↔C wire carries anything. This scenario
 * closes exactly that gap with an ORDERING argument:
 *
 *  1. Boot the same A/B/C topology (B listens on nothing — nobody can ever
 *     dial B), with B's recurring reconcile timer at 10 minutes so it provably
 *     never fires in-test.
 *  2. Sever B from A: the test gater denies every future dial to A, then B
 *     hangs up. B now holds ZERO connections and stays that way unless B
 *     itself dials out.
 *  3. A ~4s negative window re-asserts at every checkpoint: B has zero
 *     connections, A has none to B, B's peerStore still holds no address for
 *     C — while C's signed record stays resolvable on B, so the absence of a
 *     link is "nothing dialled", not "nothing to dial".
 *  4. C authors a NEW revision of its own `CadrePeer` row (R1) while B is
 *     provably absent from the network, with the batch coordinator pinned to C
 *     for exactly this write (see PIN SCOPING below).
 *  5. The production routine `B.reconcileControlCohort()` opens B→C — the only
 *     connection B gains (the gater holds A out).
 *  6. B observes R1 — with the coordinator pinned to C again, so the read is
 *     answered BY C — while every open control connection B holds is to C, at
 *     every poll. Therefore R1 crossed the B↔C edge.
 *
 * Both regressions the coverage gap names are caught here: a peer that never
 * gets seated in the other's replication cohort, and a connection opened on a
 * network the database does not use, each leave step 6 timing out.
 *
 * WHY THE COORDINATOR IS PINNED TO C for the R1 write (load-bearing, not just
 * determinism): a control write commits on a super-majority of its cohort, and
 * Cadre leaves Optimystic's default 0.75 threshold (`CONTROL_CLUSTER_POLICY` in
 * `quereus-plugin-sereus/src/cluster-size.ts`). C's own cohort excludes B (C
 * never connected to B, so C's peerStore never classified it), so a
 * C-coordinated write needs only {A, C} and commits while B is unreachable; an
 * A-coordinated write could still demand a promise from B — A's peerStore
 * classified B before the sever and that classification survives disconnection
 * — which nobody can reach, so it would never commit.
 *
 * PIN SCOPING — the pin is applied TWICE, never across the reconcile pass:
 *
 *  - pin 1 brackets the R1 write (step 4) only.
 *  - pin 2 brackets the carry read (step 6) onward: B's post-link reads must be
 *    answered by C, not out of B's own stale local state. B was absent from the
 *    {A, C} write that committed R1, so nothing B holds locally can contain R1
 *    — an unpinned carry read could serve B's own stale view forever and time
 *    the test out even though the edge works.
 *  - the pin MUST be off while `B.reconcileControlCohort()` runs (step 5): the
 *    pass starts by reading the CadrePeer table on B (`listMembers`, the
 *    membership-gate refresh) and a live Optimystic read syncs from the network
 *    through the transactor first. With the pin active, B's read is routed to
 *    coordinator C — which B cannot dial yet (no address) — and the read
 *    throws, so the pass aborts before it ever dials anyone: the exact
 *    chicken-and-egg (reaching C requires reconcile, reconcile requires
 *    reading, reading requires reaching C) that the reconcile pass exists to
 *    break. Unpinned, B's transactor falls back to self-coordination and the
 *    read is served from B's local (pre-sever) replicated state, which is
 *    exactly what production offers an isolated node.
 *
 * WHY THE NEGATIVE WINDOW CANNOT ACCIDENTALLY FORM B↔C: everything B's
 * transactor could dial comes from FRET / the libp2p peerStore, and B's
 * peerStore holds no address for C (re-asserted every checkpoint). A
 * `findCoordinator` result is a peer id; the dial then needs addresses and
 * finds none. The only component that can turn C's signed record into a
 * dialable address is `CadreNode.resolveControlDialAddrs`, which only the
 * reconcile pass calls.
 *
 * Honest scope: carriage is demonstrated in the READ direction (B pulls R1
 * across the edge). The write direction (B promising a C-coordinated write
 * over the same edge) is implied by B's cohort seating but not separately
 * asserted here.
 */

import { describe, it, expect } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Connection, ConnectionGater } from '@libp2p/interface';
import type { CadreNode } from '@serfab/cadre-core';
import {
	bootControlTrio, stopControlTrio,
	connectionsTo, hasOutboundTo, peerStoreAddrsFor,
	pinCoordinator, readCohort,
	waitUntil, sleep
} from '../harness/index.js';
import type { ControlTrioHandles, PinnedCoordinatorHandle } from '../harness/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SeverableGater {
	/** Pass as `network.connectionGater`; denies nothing until {@link sever}. */
	gater: ConnectionGater;
	/** Deny every FUTURE dial to `peerId`. Idempotent. */
	sever(peerId: string): void;
}

/**
 * A connection gater that starts fully permissive and can be flipped mid-test
 * to deny all dials to one peer. The denied peer id is supplied at `sever()`
 * time (not construction) because the gater must exist before the trio boots,
 * while A's peer id only exists after A starts.
 *
 * Covers both paths libp2p's dial queue consults — `denyDialPeer` on the
 * peer-id path and `denyDialMultiaddr` on the per-address path — plus
 * `denyOutboundConnection` as belt-and-braces at the upgrader.
 */
function severableDialGater(): SeverableGater {
	let denied: string | undefined;
	return {
		gater: {
			denyDialPeer: (peerId) => denied !== undefined && peerId.toString() === denied,
			denyDialMultiaddr: (ma) => {
				if (denied === undefined) return false;
				// The dial target is the LAST p2p component (earlier ones name relays).
				const p2p = ma.getComponents().filter((c) => c.name === 'p2p').pop();
				return p2p?.value === denied;
			},
			denyOutboundConnection: (peerId, _maConn) => denied !== undefined && peerId.toString() === denied
		},
		sever(peerId: string) { denied = peerId; }
	};
}

/** Every OPEN connection B's control libp2p currently holds, to anyone. */
function openControlConnections(node: CadreNode): Connection[] {
	return (node.getControlNode()?.getConnections() ?? [])
		.filter((c) => c.status === 'open');
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-cohort edge carries data (three nodes, severed backbone)', () => {
	it('a revision authored on C while B is fully isolated reaches B only across the reconcile-formed B→C connection', async () => {
		const handles: ControlTrioHandles = {};
		const severable = severableDialGater();
		let writePin: PinnedCoordinatorHandle | undefined;
		let carryPin: PinnedCoordinatorHandle | undefined;
		try {
			// ── 1. Boot. reconcileMs 10 min: B's recurring reconcile timer provably
			//       never fires inside this test; only explicit passes dial.
			const { A, B, C, aPeerId, bPeerId, cPeerId } = await bootControlTrio({
				reconcileMsB: 600_000, handles, gaterB: severable.gater
			});

			// ── 2. Baseline, while B↔A is still up and every read path is healthy.
			const baseline = await B.getControlDatabase()!.queryPeerRecord(cPeerId);
			expect(baseline).not.toBeNull();
			const r0 = baseline!.updatedAt;
			expect(hasOutboundTo(B, aPeerId)).toBe(true);
			expect(connectionsTo(B, cPeerId)).toHaveLength(0);
			// A cannot ever re-form the link from its side: B's own CadrePeer row
			// carries no addresses (B listens on nothing), so A has nothing to
			// resolve. The row's address set is time-independent — B never gains a
			// listen address — so asserting it here, before the sever churns any
			// streams, covers the whole test.
			expect(await A.resolvePeerAddrs(bPeerId)).toHaveLength(0);
			// Bracket, pre-sever side: C's signed record IS resolvable on B (the boot
			// gate already polled this to true; re-asserted here so the claim sits
			// visibly next to the sever it brackets).
			expect((await B.resolvePeerAddrs(cPeerId)).length).toBeGreaterThan(0);

			// ── 3. Sever B from A: deny all future dials to A, then hang up. Nobody
			//       can dial B (no listen addrs), so B is now fully isolated and
			//       stays that way unless B itself dials out.
			severable.sever(aPeerId);
			await B.getControlNode()!.hangUp(peerIdFromString(aPeerId));
			await waitUntil(
				() => openControlConnections(B).length === 0,
				{ timeoutMs: 15_000, intervalMs: 250, description: 'B holds zero open control connections after the sever' }
			);
			// `hangUp` resolves when B's side is closed; A learns of the close a beat
			// later (its own close event). Wait for A's side to drain too, or the
			// window's very first `connectionsTo(A, bPeerId)` checkpoint races it.
			await waitUntil(
				() => connectionsTo(A, bPeerId).length === 0,
				{ timeoutMs: 15_000, intervalMs: 250, description: "A's side of the severed connection drains" }
			);

			// ── 4. Negative window (~4s of checkpoints, 250ms apart). B stays fully
			//       isolated while C's record stays RESOLVABLE on B — so the absence
			//       of a link is "nothing dialled", not "nothing to dial". The
			//       resolvability read is served from B's local pre-sever replicated
			//       state via transactor self-coordination (no pin is active); the
			//       peerStore check per iteration is what proves nothing but the
			//       record path could later supply C's address.
			//
			// NOTE: if this window ever fails on a connection count, the first
			// suspect is a `self:peer:update`-triggered reconcile pass on B
			// (`startRecordRefresh` wires one alongside the interval, so the
			// 10-minute cadence does not suppress it). B listens on nothing, so its
			// address set should never change mid-test. Diagnose with
			// DEBUG='sereus:cadre:node'.
			for (let checkpoint = 0; checkpoint < 16; checkpoint++) {
				expect(openControlConnections(B)).toHaveLength(0);
				expect(connectionsTo(A, bPeerId)).toHaveLength(0);
				expect(await peerStoreAddrsFor(B, cPeerId)).toHaveLength(0);
				expect((await B.resolvePeerAddrs(cPeerId)).length).toBeGreaterThan(0);
				await sleep(250);
			}

			// ── 5. C authors R1 while B is provably absent, with the coordinator
			//       pinned to C for exactly this write (file header, PIN SCOPING).
			//       Precondition first: C's cohort must exclude B, or the write needs
			//       a promise from an unreachable peer and would burn the whole
			//       timeout — fail fast with a readable message instead.
			expect(await readCohort(C.getControlNode()!, 'C (pre-R1)')).not.toContain(bPeerId);
			writePin = pinCoordinator([C]);
			let r1: number;
			try {
				// Polled, never called once: a 3-member-cohort control write is
				// effectively unanimous, so a single stream reset fails the commit
				// outright; production retries on the record heartbeat.
				await waitUntil(
					async () => (await C.registerSelf()) === 'refreshed',
					{ timeoutMs: 60_000, intervalMs: 1_000, description: 'C authors R1 (a fresh self-record revision) while B is isolated' }
				);
				const authored = await C.getControlDatabase()!.queryPeerRecord(cPeerId);
				expect(authored).not.toBeNull();
				r1 = authored!.updatedAt;
			} finally {
				// The write pin must be gone before B's reconcile pass runs — see the
				// file header (PIN SCOPING) for the chicken-and-egg it would create.
				writePin.restore();
			}
			expect(r1).toBeGreaterThan(r0);
			// R1 was authored with B provably absent from the network.
			expect(openControlConnections(B)).toHaveLength(0);

			// ── 6. Link: the production routine, polled the same way the isolation
			//       scenario polls it — the membership gate denies AFTER the
			//       dialer's upgrade completes, so a single pass can lose the
			//       admission race. Each pass dials the owner A first (denied by
			//       the severed gater; `dialControlSibling` logs and swallows
			//       per-peer failures, so the denied sibling never aborts the
			//       pass) and then the non-owner fill, C.
			let passes = 0;
			await waitUntil(
				async () => {
					if (hasOutboundTo(B, cPeerId)) return true;
					passes++;
					await B.reconcileControlCohort();
					return false;
				},
				{ timeoutMs: 60_000, intervalMs: 1_000, description: 'an explicit reconcile pass dials C' }
			);
			expect(passes).toBeGreaterThan(0);
			// B's open control connection set is exactly {C}: one outbound
			// connection, and nothing to anyone else — the gater held A out.
			const linked = openControlConnections(B);
			for (const conn of linked) expect(conn.remotePeer.toString()).toBe(cPeerId);
			const outboundToC = linked.filter((c) => c.direction === 'outbound');
			expect(outboundToC).toHaveLength(1);
			const linkConnId = outboundToC[0]!.id;

			// ── 7. Carry: B observes R1, with the coordinator pinned to C again so
			//       the read is answered BY C across the just-formed edge — B's own
			//       local state cannot contain R1 (B was absent from the write), so
			//       an unpinned read could serve B's stale view forever. A manual
			//       poll loop, NOT `waitUntil` — the per-iteration invariant (every
			//       open connection B holds is to C) must abort the test
			//       immediately, and `waitUntil` swallows a throwing condition as
			//       "not yet".
			carryPin = pinCoordinator([C]);
			const deadline = Date.now() + 60_000;
			let carried = false;
			let lastReadError: unknown;
			while (Date.now() < deadline) {
				for (const conn of openControlConnections(B)) {
					expect(conn.remotePeer.toString()).toBe(cPeerId);
				}
				try {
					const seen = await B.getControlDatabase()!.queryPeerRecord(cPeerId);
					lastReadError = undefined;
					if (seen && seen.updatedAt >= r1) { carried = true; break; }
				} catch (error) {
					// A read can race connection churn; the invariant above already ran
					// this iteration, so treat the read as "not yet" and surface the
					// error only if the poll never converges.
					lastReadError = error;
				}
				await sleep(250);
			}
			if (!carried) {
				// The peer-id map turns an aggregate transactor error naming a raw
				// peer id into something a human can attribute without a debug rerun.
				throw new Error(
					`B never observed C's isolated revision (updatedAt >= ${r1}) within 60s`
					+ (lastReadError ? `; last read error: ${String(lastReadError)}` : '')
					+ `; peers: A=${aPeerId} B=${bPeerId} C=${cPeerId}`);
			}
			// The SAME connection recorded at link time is still the open one — R1
			// crossed that connection, not a later replacement.
			const openNow = openControlConnections(B);
			for (const conn of openNow) expect(conn.remotePeer.toString()).toBe(cPeerId);
			expect(openNow.some((c) => c.id === linkConnId)).toBe(true);

			// ── 8. Closing: C is seated in B's replication cohort (the first
			//       regression the coverage gap names), and BOTH pins were actually
			//       consulted, so neither can have silently no-opped: the write pin
			//       served C's own reads around the R1 write, the carry pin routed
			//       B's carry read to C.
			expect(await readCohort(B.getControlNode()!, 'B (post-carry)')).toContain(cPeerId);
			expect(writePin.callCount()).toBeGreaterThan(0);
			expect(carryPin.callCount()).toBeGreaterThan(0);
		} finally {
			// Reverse order of application; both restores are idempotent and the two
			// pins never overlap (the write pin is restored before the carry pin is
			// applied), so this is safe on every failure path.
			carryPin?.restore();
			writePin?.restore();
			await stopControlTrio(handles);
		}
	}, 120_000);
});
