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
 *     never fires in-test. B's harness dial gate denies every dial to C from
 *     B's start (see WHY THE NEGATIVE WINDOW CANNOT ACCIDENTALLY FORM B↔C).
 *  2. Sever B from A: B's dial gate denies every future dial to A, then B
 *     hangs up. B now holds ZERO connections and stays that way unless B
 *     itself dials out.
 *  3. A ~4s negative window re-asserts at every checkpoint: B has zero
 *     connections and A has none to B — while C's signed record stays
 *     resolvable on B, so the absence of a link is "nothing dialled", not
 *     "nothing to dial".
 *  4. C authors a NEW revision of its own `CadrePeer` row (R1) while B is
 *     provably absent from the network, with the batch coordinator pinned to C
 *     for exactly this write (see PIN SCOPING below).
 *  5. The production routine `B.reconcileControlCohort()`, run with B's dials
 *     to C allowed for exactly that pass, opens B→C and reports dialling C —
 *     the only connection B gains (the gate still holds A out).
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
 *    coordinator C, to which B holds no connection. Either the read throws and
 *    the pass aborts before it ever dials anyone — the exact chicken-and-egg
 *    (reaching C requires reconcile, reconcile requires reading, reading
 *    requires reaching C) that the reconcile pass exists to break — or, when
 *    B's peerStore happens to hold C's address, the transactor dials C itself
 *    while the pass has the gate open, and the pass then skips C as already
 *    connected, so the step-5 check fails. Unpinned, B's transactor falls back
 *    to self-coordination and the read is served from B's local (pre-sever)
 *    replicated state, which is exactly what production offers an isolated
 *    node.
 *
 * WHY THE NEGATIVE WINDOW CANNOT ACCIDENTALLY FORM B↔C: B's harness dial gate
 * denies every dial to C except during the reconcile pass step 5 runs. An empty
 * address book is NOT what holds B off: Optimystic merges C's address into B's
 * peerStore when a cluster record A sends B names it, and FRET dials addressed
 * ring neighbours on its own — the sever itself triggers FRET's departure
 * announce, which dialled C within a millisecond in 3 of 9 measured runs before
 * the gate existed. Both paths, and the measurement, are described in the
 * `harness/control-trio.ts` header (B'S DIAL GATE). A connection-count failure
 * inside the window therefore means something bypassed the gate.
 *
 * Honest scope: carriage is demonstrated in the READ direction (B pulls R1
 * across the edge). The write direction (B promising a C-coordinated write
 * over the same edge) is implied by B's cohort seating but not separately
 * asserted here.
 */

import { describe, it, expect } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Connection } from '@libp2p/interface';
import type { CadreNode } from '@serfab/cadre-core';
import {
	bootControlTrio, stopControlTrio,
	connectionsTo, hasOutboundTo,
	pinCoordinator, readCohort,
	waitUntil, sleep
} from '../harness/index.js';
import type { ControlTrioHandles, PinnedCoordinatorHandle } from '../harness/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Every OPEN connection B's control libp2p currently holds, to anyone. */
function openControlConnections(node: CadreNode): Connection[] {
	return (node.getControlNode()?.getConnections() ?? [])
		.filter((c) => c.status === 'open');
}

/**
 * Did this read fail because Optimystic refused to SELF-COORDINATE rather than
 * because the data is gone? An isolated node whose high-water mark remembers a
 * larger network blocks self-coordination — `partition-detected`, or
 * `grace-period-not-elapsed` until 30 s (`selfCoordinationConfig.gracePeriodMs`)
 * have passed since its last connection — see
 * `Libp2pKeyPeerNetwork.shouldAllowSelfCoordination` in `../optimystic`. That is
 * correct behavior for a node that just lost the network, and it is a property
 * of B's isolation, not a counterexample to anything this scenario claims.
 */
function isSelfCoordinationBlocked(error: unknown): boolean {
	return String((error as { message?: string })?.message ?? error).includes('Self-coordination blocked');
}

/**
 * `waitUntil`, but a condition that keeps THROWING reports its last error and
 * `context` on timeout. Plain `waitUntil` logs a throw and treats it as "not
 * yet", so a poll whose every attempt fails the same way — the known failure
 * shape in this suite — otherwise times out with no cause attached at all.
 */
async function waitUntilOrExplain(
	condition: () => Promise<boolean>,
	options: { timeoutMs: number; intervalMs: number; description: string },
	context: string
): Promise<void> {
	let lastError: unknown;
	try {
		await waitUntil(async () => {
			try {
				const done = await condition();
				lastError = undefined;
				return done;
			} catch (error) {
				lastError = error;
				return false;
			}
		}, options);
	} catch (timeout) {
		// The timeout is the cause; the condition's own last failure — the part a
		// human actually needs — is quoted into the message.
		throw new Error(`${String(timeout)}`
			+ (lastError ? `; last error: ${String(lastError)}` : '')
			+ `; ${context}`, { cause: timeout });
	}
}

/**
 * Run `body`, re-throwing any failure with `context` appended. The polls below
 * get that treatment from `waitUntilOrExplain`; the STRAIGHT-LINE reads need it
 * just as much — an aggregate transactor error names a raw peer id, which is
 * unattributable without the peer map.
 */
async function explain<T>(body: () => Promise<T>, context: string): Promise<T> {
	try {
		return await body();
	} catch (error) {
		throw new Error(`${String(error)}; ${context}`, { cause: error });
	}
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-cohort edge carries data (three nodes, severed backbone)', () => {
	it('a revision authored on C while B is fully isolated reaches B only across the reconcile-formed B→C connection', async () => {
		const handles: ControlTrioHandles = {};
		let writePin: PinnedCoordinatorHandle | undefined;
		let carryPin: PinnedCoordinatorHandle | undefined;
		try {
			// ── 1. Boot. reconcileMs 10 min: B's recurring reconcile timer provably
			//       never fires inside this test; only explicit passes dial.
			const { A, B, C, aPeerId, bPeerId, cPeerId, gateB, dialsToC } = await bootControlTrio({
				reconcileMsB: 600_000, handles
			});
			// Appended to every poll failure below: an aggregate transactor error names
			// a raw peer id, which is unattributable without this map (or a debug rerun).
			const peerMap = `peers: A=${aPeerId} B=${bPeerId} C=${cPeerId}`;

			// ── 2. Baseline, while B↔A is still up and every read path is healthy.
			const baseline = await explain(
				() => B.getControlDatabase()!.queryPeerRecord(cPeerId),
				`baseline read on B (step 2, pre-sever); ${peerMap}`);
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
			//       stays that way unless B itself dials out. A stays denied for
			//       the rest of the test; C stays denied outside step 6's passes.
			gateB.deny(aPeerId);
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
			//       isolated while C's record stays KNOWN to B — so the absence of a
			//       link is "nothing dialled", not "nothing to dial". B's peerStore
			//       is deliberately NOT checked: it may legitimately hold C's
			//       address (file header, WHY THE NEGATIVE WINDOW…), and B's dial
			//       gate, not an empty address book, is what holds B off C here.
			//       Nor is the gate asserted to have denied anything: whether
			//       anything tries depends on whether that address arrived (measured
			//       2026-09-16: 2 of 6 runs denied dials to C by the end of the
			//       window, each with C's address in B's peerStore; the other 4 had
			//       neither).
			//
			// The resolvability read is served from B's local pre-sever replicated
			// state (no pin is active). B has never received the `Revocation` block:
			// an owner files its ledger marker only on a connected reconcile pass,
			// and A has not run one when B is severed. So each lookup's revoked-stamp
			// read reaches no cohort member (`cohort-unreachable`), which
			// `ControlDatabase.queryRevokedStamps` answers as "no revocations known"
			// (see the NOTE there). Before that treatment this read threw at every
			// checkpoint. The one failure still tolerated is optimystic refusing to
			// self-coordinate (`isSelfCoordinationBlocked`): upstream `findCoordinator`
			// still raises it as a hard denial for some intents, though no run has
			// shown it since the Revocation read stopped throwing. A blocked read is
			// counted and tolerated; any OTHER read failure, and any
			// successful read that comes back EMPTY, still fails the test. Neither
			// tolerance weakens the ordering argument: B knew C's address before the
			// sever (bracket above) and dials C successfully in step 6, so "B had
			// nothing to dial" is ruled out from both sides regardless.
			//
			// NOTE: a connection count failing here means a dial got past B's gate,
			// which denies both A and C for the whole window — including any dial a
			// reconcile pass the test did not run would make (a
			// `self:peer:update`-triggered pass, say). Log dial stacks in `gateB`'s
			// hooks to find the opener; that is how FRET's departure announce was
			// found (harness/control-trio.ts header).
			let resolvedInWindow = 0;
			let selfCoordBlockedInWindow = 0;
			for (let checkpoint = 0; checkpoint < 16; checkpoint++) {
				expect(openControlConnections(B)).toHaveLength(0);
				expect(connectionsTo(A, bPeerId)).toHaveLength(0);
				try {
					expect((await B.resolvePeerAddrs(cPeerId)).length).toBeGreaterThan(0);
					resolvedInWindow++;
				} catch (error) {
					if (!isSelfCoordinationBlocked(error)) throw error;
					selfCoordBlockedInWindow++;
				}
				await sleep(250);
			}
			expect(resolvedInWindow + selfCoordBlockedInWindow).toBe(16);

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
				await waitUntilOrExplain(
					async () => (await C.registerSelf()) === 'refreshed',
					{ timeoutMs: 60_000, intervalMs: 1_000, description: 'C authors R1 (a fresh self-record revision) while B is isolated' },
					peerMap
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
			//       admission race. Each pass runs with B's dials to C allowed
			//       (`dialsToC.reconcile`) and dials the owner A first (denied by
			//       the sever; `dialControlSibling` logs and swallows per-peer
			//       failures, so the denied sibling never aborts the pass) and then
			//       the non-owner fill, C.
			await waitUntilOrExplain(
				async () => {
					if (hasOutboundTo(B, cPeerId)) return true;
					await dialsToC.reconcile();
					return false;
				},
				{ timeoutMs: 60_000, intervalMs: 1_000, description: 'an explicit reconcile pass dials C' },
				peerMap
			);
			expect(dialsToC.passes().length).toBeGreaterThan(0);
			// The pass that was running when B→C formed reports dialling C. Had FRET
			// or the transactor opened it inside that pass, the pass would have
			// skipped C as already connected.
			expect(dialsToC.openingPass()?.dialed).toContain(cPeerId);
			// B's open control connection set is exactly {C}: one outbound
			// connection, and nothing to anyone else — B's dial gate held A out.
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
				throw new Error(
					`B never observed C's isolated revision (updatedAt >= ${r1}) within 60s`
					+ (lastReadError ? `; last read error: ${String(lastReadError)}` : '')
					+ `; ${peerMap}`);
			}
			// The SAME connection recorded at link time is still the open one — R1
			// crossed that connection, not a later replacement.
			//
			// NOTE: this is deliberately strict. If libp2p ever recycles the edge
			// mid-carry (idle close + redial, or a transport upgrade), this assert
			// fails on a run where carriage actually worked. The claim would then
			// have to weaken to "every connection B has held since link time was to
			// C" — recorded via a `connection:open` listener on B from step 6 —
			// rather than connection identity. No such recycle has been observed.
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
