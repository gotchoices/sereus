/**
 * Control-database writes into a REAL multi-machine cohort — the harness's first
 * scenario that proves a write was offered to more than the machine that issued it.
 *
 * WHAT A CONTROL COHORT IS. A party's control database (its members, its strands,
 * its invitations) is not stored on one machine. Every block of it is replicated to a
 * set of the party's machines — the COHORT — and a write commits only once a
 * super-majority of that set approves it. Which machines end up in the cohort is
 * decided by `Libp2pKeyPeerNetwork.findCluster`, driven by FRET, the peer-discovery
 * ring each node maintains.
 *
 * WHY A PASSING WRITE PROVES NOTHING ON ITS OWN. A cohort of ONE — just the writer —
 * commits on the writer's own vote, because `allowClusterDownsize` defaults to true.
 * So a control write that merely succeeds is equally consistent with "three machines
 * agreed" and with "one machine wrote to itself". Measured on
 * `happy-path.integration.ts` with two drone nodes: 213 of 213 cohort selections
 * reported a single peer, and every write passed. Any claim about multi-machine
 * consensus therefore has to establish the cohort SIZE separately — which is what
 * this file does, via `harness/control-cohort.ts`.
 *
 * IT IS A START-UP RACE, NOT A STRUCTURAL GAP. The owner's ring reaches every party
 * member within a few seconds of `createTestParty` resolving (measured: sub-second for
 * a three-node party, about five seconds worst observed). Those 213 single-peer
 * selections were writes issued before the ring had converged. Waiting fixes them, so
 * every case below waits — `waitForControlCohort` — rather than reaching for a patch.
 * Do NOT shorten that wait to make this file feel faster: a too-tight budget turns a
 * real convergence into a flake.
 *
 * THE ONE THING WAITING CANNOT FIX. `createTestParty`'s drone nodes dial only the
 * owner, never each other. FRET can classify only a peer it can reach, so a DRONE's
 * cohort tops out at two members (itself + the owner) forever — no amount of waiting
 * makes a drone see a sibling drone. That cap is asserted directly in case 1, and it
 * is why case 3 forces a cohort rather than waiting for one.
 *
 * WHY `happy-path.integration.ts` WAS NOT RETROFITTED INSTEAD. It is the suite's
 * broad smoke test. Binding its writes to a three-machine cohort would bind the canary
 * to the unanimity bar — at three machines a super-majority is `ceil(3 x 0.75) = 3`,
 * i.e. EVERY machine must approve — which is a known fragility documented in
 * `docs/architecture.md` → "Replication cluster size". A flaky canary costs more than it
 * buys, so the multi-machine claim lives here and `happy-path` only carries a comment
 * saying what it does and does not exercise.
 *
 * MEASURED OUTCOMES (single machine, localhost websockets; several consecutive runs of
 * this file alone, recorded so a future change of behaviour shows up as a change of
 * these numbers — treat them as the observed spread, not as bounds anything asserts):
 *   - case 1, drone cap ........... as described every run, ~8.4–8.7 s (the failing
 *     probe's own 8 s budget dominates; the two waits before it resolve well under 1 s)
 *   - case 2, waited real cohort .. COMMITTED every run, ~0.7–1.0 s
 *   - case 3, forced cohort ....... COMMITTED every run, ~0.2–0.4 s
 *   - whole file .................. ~23–25 s
 *
 * A three-machine cohort of HEALTHY machines therefore clears the unanimity bar
 * comfortably: the unanimity fragility is about what happens
 * when one of the three is slow or silent (measured in
 * `control-write-degraded-cohort-member.integration.ts`), not about the healthy case.
 * If a write here ever starts failing with
 * `Failed to get super-majority: N/3 approvals (needed 3, ...)`, that fragility has
 * reached the healthy path — report it against that slug rather than lowering the
 * threshold, which `debt-harness-supermajority-threshold-diverges-from-production`
 * deliberately aligned with production.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import debug from 'debug';
import {
	TestCadreNetwork, waitForControlCohort, observeControlCohorts, forceFullCohort, pinCoordinator
} from '../harness/index.js';
import type {
	TestParty, TestStrand, ControlCohortObserverHandle, ForcedCohortHandle, PinnedCoordinatorHandle
} from '../harness/index.js';
import { loadSimpleSApp } from '../fixtures/index.js';

const log = debug('sereus:integration:party-cohort');

// ── Deadlines ─────────────────────────────────────────────────────────────────
//
// A control write that fails on the unanimity bar settles at roughly 20–40 s: two
// 10 s `ClusterClient` response-deadline attempts per pend round, and the number of
// rounds is not deterministic. Each `it` timeout below is sized above the sum of the
// deadlines its body can pay, so a genuine hang is reported by the named assertion
// rather than by vitest's anonymous test timeout.

/**
 * Budget for the probe that must FAIL — a drone asked for a three-member cohort.
 * Deliberately short: the cap is permanent (see the header), so waiting the helper's
 * 15 s default would only make the file slower without making the case any more true.
 */
const DRONE_CAP_PROBE_TIMEOUT_MS = 8_000;

// ── Local helpers ─────────────────────────────────────────────────────────────

/** How an awaited operation settled: its value on success, its error on failure. */
interface Settled<T> {
	/** Defined only when {@link Settled.error} is null. */
	value: T | undefined;
	error: unknown | null;
	elapsedMs: number;
}

/**
 * Await `op`, capturing how it settled and how long it took instead of throwing, so
 * the outcome can be logged before it is asserted. The value is carried through so a
 * read-back can assert the exact row the write created, not merely that a row exists.
 *
 * NOTE: `control-write-degraded-cohort-member.integration.ts` carries its own copy of
 * this and of {@link errorChainText}. Two small copies in two scenario files is
 * cheaper than a harness module nobody else imports; if a THIRD file needs them,
 * extract all three into `harness/` at that point rather than adding another copy.
 */
async function settle<T>(op: () => Promise<T>): Promise<Settled<T>> {
	const startedAt = Date.now();
	let value: T | undefined;
	const error = await op().then((result) => { value = result; return null; }, (e: unknown) => e);
	return { value, error, elapsedMs: Date.now() - startedAt };
}

/**
 * Flatten an error's `.cause` chain into one searchable string — Quereus wraps the
 * transactor's failure, so matching on the outermost message alone under-reports.
 */
function errorChainText(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current != null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			parts.push(current.message);
			current = current.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.join(' | ');
}

/** Every machine in `party`, owner first — the full membership a cohort can reach. */
function allPartyPeerIds(party: TestParty): string[] {
	return [party.ownerNode.peerId, ...party.droneNodes.map((d) => d.peerId)];
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('control writes into a real multi-machine cohort (harness party)', () => {
	let network: TestCadreNetwork;
	/** Case 1 — cohort shape only, no writes. */
	let capParty: TestParty;
	/** Case 2 — the waited, unforced write. Its own party so a failed write cannot bleed. */
	let waitedParty: TestParty;
	/** Case 3 — the forced write. Same reason for its own party. */
	let forcedParty: TestParty;

	// Held at describe scope so `afterAll` can unwind a patch a mid-case failure left
	// live. Each case still restores its own in a `finally`; these are the safety net.
	let activeObserver: ControlCohortObserverHandle | null = null;
	let activeForced: ForcedCohortHandle | null = null;
	let activePinned: PinnedCoordinatorHandle | null = null;

	beforeAll(async () => {
		network = new TestCadreNetwork({ verbose: true });
		// All three parties up front: the later cases' rings converge while case 1 runs,
		// so no case pays the ~5 s warm-up twice. Three parties x three machines = nine
		// nodes, which is the whole port budget this file takes.
		capParty = await network.createParty({ name: 'cohort-cap', droneCount: 2 });
		waitedParty = await network.createParty({ name: 'cohort-waited-write', droneCount: 2 });
		forcedParty = await network.createParty({ name: 'cohort-forced-write', droneCount: 2 });
	}, 180_000);

	afterAll(async () => {
		// Reverse order of application — `key-network-patch.ts` throws rather than
		// reinstating a stale `findCluster`, and a patch left live here would follow the
		// prototype into whatever runs next in this worker.
		activePinned?.restore();
		activeForced?.restore();
		activeObserver?.restore();
		activePinned = null;
		activeForced = null;
		activeObserver = null;
		// Runs no matter how `beforeAll` ended: a party whose creation or wait threw still
		// has live nodes holding ports.
		await network?.shutdown();
	}, 120_000);

	// ── Case 1 ────────────────────────────────────────────────────────────────────

	it('reaches all three machines from the owner, and caps at two from a drone', async () => {
		// The owner is the only machine that can see the whole party, and it does — this
		// is the wait every writing case depends on.
		const ownerView = await waitForControlCohort(capParty, 3);
		expect([...ownerView].sort()).toEqual([...allPartyPeerIds(capParty)].sort());

		const drone = capParty.droneNodes[0]!;
		// A drone does see the owner, so its two-member cohort is a real cohort, not a
		// node that failed to converge at all.
		const droneView = await waitForControlCohort(capParty, 2, { node: drone });
		expect([...droneView].sort()).toEqual([drone.peerId, capParty.ownerNode.peerId].sort());

		// …and it never sees the third machine. Asserted on the OBSERVED SIZE in the
		// message, not merely on "it threw": a wiring fault (no attached key network, an
		// unsatisfiable `minPeers`) also throws, and would pass a bare `rejects.toThrow`.
		const capped = await settle(() =>
			waitForControlCohort(capParty, 3, { node: drone, timeoutMs: DRONE_CAP_PROBE_TIMEOUT_MS }));
		log('drone cap probe settled in %dms: %s', capped.elapsedMs,
			capped.error === null ? 'RESOLVED (unexpected)' : errorChainText(capped.error));
		expect(capped.error, "a drone reached a three-member cohort — the sibling-drone cap is gone, "
			+ 'and this file\'s reason for forcing case 3 with it').not.toBeNull();
		// `[12]`, not a literal 2: the drone's converged view is 2 and that is what every
		// run has reported, but FRET can transiently drop a classification, and a probe
		// that happened to time out at 1 would still be the cap this case asserts. What
		// must never match is a 3 — and that the two-member view is a REAL cohort rather
		// than a node that never converged is already established by the wait above.
		expect(errorChainText(capped.error)).toMatch(/saw a cohort of [12] .*needed 3/s);
	}, 90_000);

	// ── Case 2 ────────────────────────────────────────────────────────────────────

	it('commits a real control write once the cohort really spans three machines', async () => {
		const schema = await loadSimpleSApp();
		// Establish the claim BEFORE writing: this returned set is the evidence that the
		// write below had three machines available to it.
		const cohort = await waitForControlCohort(waitedParty, 3);
		expect([...cohort].sort()).toEqual([...allPartyPeerIds(waitedParty)].sort());

		const observer = observeControlCohorts();
		activeObserver = observer;
		// `callCount` and `cohortSizes` can legitimately differ in length (a call whose
		// delegate threw counts in the former only), so the slice baseline is taken from
		// the sizes array itself. Both are zero on a fresh observer; taking them anyway
		// keeps the assertions correct if the observer is ever started earlier.
		const callBaseline = observer.callCount();
		const sizeBaseline = observer.cohortSizes().length;

		let outcome: Settled<TestStrand>;
		let sizesDuringWrite: number[];
		try {
			// The same write path `happy-path` uses, so it goes through the real
			// `CadreControl` CHECK constraints rather than a bespoke insert.
			outcome = await settle(() => network.createStrand(waitedParty, { schema, type: 'o' }));
			sizesDuringWrite = observer.cohortSizes().slice(sizeBaseline);
			expect(observer.callCount(),
				'cohort discovery was never consulted — the write did not go through findCluster')
				.toBeGreaterThan(callBaseline);
		} finally {
			observer.restore();
			activeObserver = null;
		}

		console.log(`[measured] waited three-machine control write: ${outcome.elapsedMs}ms, `
			+ `error: ${outcome.error === null ? 'none (COMMITTED)' : errorChainText(outcome.error)}, `
			+ `cohort sizes seen: ${JSON.stringify(sizesDuringWrite)}`);

		// ANTI-VACUITY — and the subtlety that makes this different from case 3.
		// `observeControlCohorts` patches the PROTOTYPE, so it records selections made by
		// EVERY node in this vitest worker, drones included — and a drone legitimately sees
		// two (the header's permanent cap). Asserting that every recorded size is three is
		// therefore WRONG here and would fail against a perfectly correct system. The
		// honest claim is that at least one selection during the write spanned the whole
		// party. Do not "tighten" this to `.every`.
		expect(sizesDuringWrite.some((n) => n >= 3),
			`no cohort selection during the write reached 3 machines (saw ${JSON.stringify(sizesDuringWrite)})`)
			.toBe(true);

		expect(outcome.error, 'the write into a three-machine cohort failed').toBeNull();

		// Read the row back BY ID: the write resolving and the row landing are separate
		// claims, and a bare "some row exists" would also pass against a stale or foreign
		// row if this party ever stopped being single-write.
		const strands = await waitedParty.controlDatabase.queryStrands();
		expect(strands.map((s) => s.Id)).toContain(outcome.value!.strandId);
	}, 180_000);

	// ── Case 3 ────────────────────────────────────────────────────────────────────

	it('commits a control write against a forced three-machine cohort', async () => {
		const schema = await loadSimpleSApp();
		// Force before pinning: the pin WRAPS whatever `findCluster` is installed, so the
		// reverse order would leave it re-ordering the real (unforced) selection.
		const forced = forceFullCohort([forcedParty.ownerNode, ...forcedParty.droneNodes]);
		activeForced = forced;
		const pinned = pinCoordinator([forcedParty.ownerNode]);
		activePinned = pinned;

		const callBaseline = forced.callCount();
		const sizeBaseline = forced.cohortSizes().length;

		let outcome: Settled<TestStrand>;
		let sizesDuringWrite: number[];
		try {
			outcome = await settle(() => network.createStrand(forcedParty, { schema, type: 'o' }));
			sizesDuringWrite = forced.cohortSizes().slice(sizeBaseline);
			expect(forced.callCount(),
				'the forced cohort was never consulted — the write bypassed cluster discovery')
				.toBeGreaterThan(callBaseline);
		} finally {
			// Reverse order of application: unpin, then un-force.
			pinned.restore();
			activePinned = null;
			forced.restore();
			activeForced = null;
		}

		console.log(`[measured] forced three-machine control write: ${outcome.elapsedMs}ms, `
			+ `error: ${outcome.error === null ? 'none (COMMITTED)' : errorChainText(outcome.error)}, `
			+ `cohort sizes seen: ${JSON.stringify(sizesDuringWrite)}`);

		// ANTI-VACUITY — and here `.every` IS correct, unlike case 2: forcing SUBSTITUTES
		// the selection for every node in the process, so a drone's own selection is the
		// forced trio too. A recorded size other than three would mean something bypassed
		// the force entirely.
		expect(sizesDuringWrite.every((n) => n === 3),
			`a cohort consultation returned other than 3 machines (saw ${JSON.stringify(sizesDuringWrite)})`)
			.toBe(true);

		expect(outcome.error, 'the write into the forced three-machine cohort failed').toBeNull();

		const strands = await forcedParty.controlDatabase.queryStrands();
		expect(strands.map((s) => s.Id)).toContain(outcome.value!.strandId);
	}, 180_000);
});
