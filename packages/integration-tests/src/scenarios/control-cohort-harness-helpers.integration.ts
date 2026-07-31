/**
 * The control-cohort harness helpers' own contract — no control writes.
 *
 * `harness/control-cohort.ts` lets a scenario ask "how many machines would a control
 * write actually be offered to right now?", wait for that number to reach a target, and
 * record what the real `findCluster` returned. `harness/forced-cluster.ts` can pin that
 * set to a constant. Everything downstream that claims a multi-machine control write
 * rests on those helpers being right, so this file pins their behaviour cheaply: it
 * boots two small parties, probes them, and asserts the sizes, the member ids, the
 * argument-validation throws and the patch/restore lifecycle.
 *
 * There are no writes here at all, so the whole file runs in seconds — the one slow
 * step is waiting out the ~5 s FRET ring convergence on the three-node party.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	createTestParty, shutdownTestParty, readControlCohort, waitForControlCohort,
	observeControlCohorts, forceFullCohort
} from '../harness/index.js';
import type { TestParty } from '../harness/index.js';

// ═══════════════════════════════════════════════════════════════════════════════

describe('control-cohort harness helpers', () => {
	/** Owner only — the degenerate cohort every helper must still handle. */
	let solo: TestParty;
	/** Owner + two drones — the topology the multi-machine write scenario uses. */
	let trio: TestParty;

	beforeAll(async () => {
		solo = await createTestParty({ name: 'cohort-helpers-solo', droneCount: 0 });
		trio = await createTestParty({ name: 'cohort-helpers-trio', droneCount: 2 });
	}, 120_000);

	afterAll(async () => {
		// Both shutdowns must run even if the first throws, or the second party's
		// ports leak for the rest of the run. The runtime filter is load-bearing
		// despite the non-optional types: a beforeAll that throws between the two
		// creations leaves the second binding unassigned.
		const outcomes = await Promise.allSettled(
			[solo, trio].filter((p): p is TestParty => p !== undefined).map((p) => shutdownTestParty(p)));
		for (const outcome of outcomes) {
			if (outcome.status === 'rejected') console.warn('afterAll: party shutdown failed:', outcome.reason);
		}
	}, 60_000);

	it('resolves at once for a one-node party, with exactly the owner', async () => {
		// `findCluster` always includes self, so this must succeed on the first poll
		// rather than deadlocking on a party that has nobody to converge with.
		const started = Date.now();
		const members = await waitForControlCohort(solo, 1);
		expect(members).toEqual([solo.ownerNode.peerId]);
		// Well inside the 15 s default: a first-poll success, not a slow convergence.
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 30_000);

	it("reaches the whole party from the owner's view once the ring converges", async () => {
		// Measured at ~5 s after party creation; the helper's 15 s default is ~3× that.
		const members = await waitForControlCohort(trio, 3);
		expect([...members].sort()).toEqual(
			[trio.ownerNode.peerId, ...trio.droneNodes.map((d) => d.peerId)].sort());
		// A one-shot read of the same view now agrees with the wait.
		expect((await readControlCohort(trio)).length).toBeGreaterThanOrEqual(3);
	}, 60_000);

	it('throws immediately — not after a timeout — for a cohort the party cannot field', async () => {
		const started = Date.now();
		await expect(waitForControlCohort(trio, 4)).rejects.toThrow(
			/party cohort-helpers-trio has 3 node\(s\).*cohort of 4 can never form/s);
		// The claim is that no polling happened at all, so this is far below the
		// 15 s default budget rather than merely under it.
		expect(Date.now() - started).toBeLessThan(1_000);
	}, 30_000);

	it('rejects a minPeers below one rather than passing vacuously', async () => {
		await expect(waitForControlCohort(trio, 0)).rejects.toThrow(/minPeers must be an integer >= 1/);
		await expect(waitForControlCohort(trio, -1)).rejects.toThrow(/minPeers must be an integer >= 1/);
	}, 30_000);

	it('names the party and the observed size when the wait times out', async () => {
		// A DRONE's view, deliberately: drones dial only the owner and never each
		// other, so a drone's cohort caps at 2 (self + owner) permanently. That makes
		// this timeout a property of the topology rather than a race against ring
		// warm-up — the alternative (a 1 ms budget on a fresh party) would flake the
		// day the ring warms faster than the assertion.
		const drone = trio.droneNodes[0]!;
		await expect(waitForControlCohort(trio, 3, { node: drone, timeoutMs: 2_000, intervalMs: 250 }))
			.rejects.toThrow(/party cohort-helpers-trio node .* saw a cohort of \d+ .* needed 3/s);
	}, 30_000);

	it('observes real findCluster calls and restores idempotently', async () => {
		const observer = observeControlCohorts();
		try {
			const members = await readControlCohort(trio);
			expect(observer.callCount()).toBeGreaterThan(0);
			// The observer must PASS THROUGH, not substitute: the size it recorded is
			// the size the caller saw.
			expect(observer.cohortSizes()).toContain(members.length);
		} finally {
			observer.restore();
		}
		const afterRestore = observer.callCount();
		// Second restore is a no-op, and the real method is back — a further read is
		// not recorded by the (already restored) observer.
		observer.restore();
		await readControlCohort(trio);
		expect(observer.callCount()).toBe(afterRestore);
	}, 30_000);

	it('forces a full cohort from harness party nodes', async () => {
		// The regression this case exists for: `forceFullCohort` used to take only
		// `CadreNode`s and reach through `getControlNode()`, so a `TestParty` could
		// not use it at all.
		const forced = forceFullCohort([trio.ownerNode, ...trio.droneNodes]);
		try {
			const members = await readControlCohort(trio);
			expect([...members].sort()).toEqual(
				[trio.ownerNode.peerId, ...trio.droneNodes.map((d) => d.peerId)].sort());
			expect(forced.callCount()).toBeGreaterThan(0);
			expect(forced.cohortSizes().every((n) => n === 3)).toBe(true);
			// A drone's view is forced too — the patch is on the prototype, so it is
			// not per-node, and this is the case a wait can never reach.
			expect((await readControlCohort(trio, trio.droneNodes[0]!)).length).toBe(3);
		} finally {
			forced.restore();
		}
		// Restored: the real method answers again, and the handle stops counting.
		const afterRestore = forced.callCount();
		await readControlCohort(trio);
		expect(forced.callCount()).toBe(afterRestore);
	}, 30_000);
});
