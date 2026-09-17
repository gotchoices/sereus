/**
 * Control-cohort reconcile as the SOLE connector — a three-node isolation proof.
 *
 * What this proves that the 2-node scenario cannot:
 * `control-cohort-auto-convergence.integration.ts` shows a node reaching
 * end-to-end convergence with no test-side `dial()`, but in a two-node party the
 * first (and only) connection is necessarily made by the cold-start path
 * (`applySeed`'s owner dial). `reconcileControlCohort` can only dial siblings
 * that are ALREADY in the replicated `CadrePeer` table, so in that topology it
 * never has a connection of its own to form. Here it does:
 *
 *         A  (storage, own owner, listens on ws, NO relay)
 *        / \
 *       /   \   both cold-start via applySeed (the production path)
 *      B     C
 *      ^     |
 *      |     |  C listens on ws; C's peerStore holds no dialable addr for B
 *      +-----+  B: listenAddrs: []  → C physically CANNOT dial B
 *         B dials C — the assertion under test
 *
 * The link is a reconcile pass's own dial, not merely a link that exists. FRET
 * and Optimystic both dial addressed peers on their own, and Optimystic can put
 * C's address in B's peerStore from a cluster record A sends B (the
 * `harness/control-trio.ts` header, B'S DIAL GATE, names both paths). So B boots
 * with a harness dial gate that denies every dial to C except while a reconcile
 * pass runs through `dialsToC.reconcile`, and each case checks that the link B
 * ends up holding was opened by a pass's OWN dial (`dialsToC.openingPass`) — a
 * pass skips a peer something else already connected, so a window in which FRET
 * or the transactor got there first is discarded and retried rather than credited
 * to the pass that happened to be running.
 *
 * The pass learns C's address from C's signed `CadrePeer` row, replicated to B
 * through A. B never applies a seed that names C (C did not exist when B's seed
 * was minted — asserted in the harness), and the load-bearing case checks C's
 * record resolvable on B right before its passes; `resolveControlDialAddrs`
 * falls back to the peerStore only when the record resolves to nothing.
 *
 * Why B listens on NOTHING: it is the client-only RN/phone shape, and it makes
 * the direction of the link unambiguous. C cannot dial B (no listen addrs, and
 * B's own `CadrePeer` row therefore carries no address for C to resolve), so any
 * B↔C connection is necessarily one B opened — and `direction === 'outbound'` on
 * B's side is asserted on top of that.
 *
 * Why no relay: three local nodes plus a circuit relay produces unstable relayed
 * links (see the design notes in `push-wake-e2e.integration.ts`); every node here
 * is directly dialable over loopback WebSockets, so no relay is needed.
 *
 * Both cases pre-pin A's owner key into B's and C's NODE-LOCAL trusted-owner
 * anchor (`trustedOwners.pinnedKeys`), which does two things: their seeds are
 * accepted by the DEFAULT anchored trust policy with no per-call override, and
 * their authorized-member predicate (`listAuthorizedMembers`) is REAL rather
 * than riding the empty-anchor fail-open carve-out in
 * `admitInboundControlConnection` — so C admits B's inbound because B's row
 * carries A's verifiable voucher, not because C trusts nobody yet.
 *
 * Neither case contains a test-side `getControlNode().dial()`.
 */

import { describe, it, expect } from 'vitest';
import {
	waitUntil, sleep,
	bootControlTrio, stopControlTrio,
	hasOutboundTo, connectionsTo,
} from '../harness/index.js';
import type { ControlTrioHandles } from '../harness/index.js';

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-cohort reconcile as sole connector (three nodes, no manual dial)', () => {
	it('B automatically dials C once C\'s record replicates through A', async () => {
		const handles: ControlTrioHandles = {};
		try {
			// Short cadence so the recurring reconcile fires several times inside the
			// window; nothing else in this test drives a pass.
			const { B, C, cPeerId, dialsToC } = await bootControlTrio({ reconcileMsB: 2_000, handles });
			// B's gate denies C outside the passes `dialsToC` runs, and the trigger
			// under test is B's own timer. Route B's own reconcile triggers (the
			// timer, and `self:peer:update`) through `dialsToC.reconcile`, which
			// opens the gate for exactly each pass and records it.
			B.reconcileControlCohort = () => dialsToC.reconcile();

			// THE ASSERTION. A pass on B's timer opens B→C (B is the only side that
			// can dial), and it is that pass's own dial: the pass holding the live
			// connection is one that reported dialling C.
			await waitUntil(
				() => dialsToC.openingPass() !== undefined,
				{ timeoutMs: 60_000, intervalMs: 250, description: "a reconcile pass on B's timer dials C, and B still holds that outbound connection" }
			);
			expect(dialsToC.openingPass()?.dialed).toContain(cPeerId);

			// End-state check that the resulting cohort actually works: C authors a
			// NEW row revision after B↔C formed, and B's view catches up to it.
			// Honest scope: that revision may still reach B via A — this asserts the
			// cohort converges with B↔C in place, it is NOT a proof of the B↔C wire.
			//
			// Polled rather than called once: a 3-member cohort commits on Optimystic's
			// default 0.75 super-majority over a cluster downsized to the 3 peers
			// present — i.e. unanimity — so a single stream reset during the churn of
			// B↔C forming fails the commit outright. Production retries the identical
			// call on the record heartbeat; `waitUntil` logs each throw under the
			// `sereus:integration:wait` debug namespace rather than eating it.
			await waitUntil(
				async () => (await C.registerSelf()) === 'refreshed',
				{ timeoutMs: 60_000, intervalMs: 1_000, description: 'C re-publishes its record into the 3-member cohort' }
			);
			const republished = await C.getControlDatabase()!.queryPeerRecord(cPeerId);
			expect(republished).not.toBeNull();
			const freshUpdatedAt = republished!.updatedAt;
			await waitUntil(
				async () => {
					const seen = await B.getControlDatabase()!.queryPeerRecord(cPeerId);
					return !!seen && seen.updatedAt >= freshUpdatedAt;
				},
				{ timeoutMs: 45_000, intervalMs: 250, description: "B observes C's re-published record revision" }
			);
		} finally {
			await stopControlTrio(handles);
		}
	}, 120_000);

	it('is load-bearing: without a reconcile pass B never reaches C, and one pass forms the link', async () => {
		const handles: ControlTrioHandles = {};
		try {
			// `reconcileMs` is read once when the refresh timers are wired, so it
			// cannot be changed mid-test — hence a second boot. 10 minutes means the
			// recurring timer provably never fires inside this test.
			const { B, cPeerId, dialsToC } = await bootControlTrio({ reconcileMsB: 600_000, handles });

			// ── Negative window. For ~5s: B can RESOLVE C (the record is there) but
			//    holds no connection to it. B's dial gate denies every dial to C in
			//    this window, so FRET and the transactor — which do dial addressed
			//    peers on their own — cannot form the link either. B's peerStore is
			//    deliberately NOT checked: Optimystic may legitimately have merged
			//    C's address into it from a cluster record (harness/control-trio.ts
			//    header, B'S DIAL GATE).
			//
			// NOTE: a failure here means a dial got past B's gate — including one
			// from a reconcile pass the test did not run (a `self:peer:update`-
			// triggered pass, say), which the gate denies as well. Log dial stacks
			// in `gateB`'s hooks to find the opener.
			let checkpoints = 0;
			let resolvedCheckpoints = 0;
			for (let elapsed = 0; elapsed < 5_000; elapsed += 250) {
				expect(connectionsTo(B, cPeerId)).toHaveLength(0);
				checkpoints++;
				if ((await B.resolvePeerAddrs(cPeerId)).length > 0) resolvedCheckpoints++;
				await sleep(250);
			}
			// The record stayed resolvable at EVERY checkpoint, so the absence of a
			// connection above is not "B had nothing to dial" — it is "nothing dialed".
			expect(checkpoints).toBeGreaterThan(0);
			expect(resolvedCheckpoints).toBe(checkpoints);

			// Last checkpoint before the passes: C's record resolves on B, so the
			// pass's dial takes the record's addresses — `resolveControlDialAddrs`
			// consults the peerStore only when the record resolves to nothing.
			expect((await B.resolvePeerAddrs(cPeerId)).length).toBeGreaterThan(0);

			// ── The public routine the timer would have called — not a raw dial().
			//    Polled rather than called exactly once: if B's own row has not yet
			//    replicated to C, C's `admitInboundControlConnection` denies and the
			//    connection dies moments after `dial()` resolves, so a single pass can
			//    lose that race. Each iteration is a real production reconcile pass,
			//    run with B's dials to C allowed for exactly that pass.
			await waitUntil(
				async () => {
					if (hasOutboundTo(B, cPeerId)) return true;
					await dialsToC.reconcile();
					// The membership gater denies AFTER the dialer's upgrade completes,
					// so a refused dial looks momentarily successful — re-check on the
					// next poll rather than accepting this pass's immediate state.
					return false;
				},
				{ timeoutMs: 60_000, intervalMs: 1_000, description: 'an explicit reconcile pass dials C' }
			);
			expect(dialsToC.passes().length).toBeGreaterThan(0);
			expect(hasOutboundTo(B, cPeerId)).toBe(true);
			// The link B holds was opened by a pass's own dial. Had FRET or the
			// transactor opened it inside a pass's window, that pass would have
			// skipped C as already connected, and `reconcile` would have closed the
			// link so a later pass could dial it — the loop above would still be
			// running, not here.
			expect(dialsToC.openingPass()?.dialed).toContain(cPeerId);
		} finally {
			await stopControlTrio(handles);
		}
	}, 120_000);
});
