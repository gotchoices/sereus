/**
 * The control-cohort harness helpers' own contract — no control writes.
 *
 * `harness/control-cohort.ts` lets a scenario ask "how many machines would a control
 * write actually be offered to right now?", wait for that number to reach a target, and
 * record what the real `findCluster` returned. `harness/forced-cluster.ts` can pin that
 * set to a constant (`forceFullCohort`) and pin which member coordinates the write
 * (`pinCoordinator`). Everything downstream that claims a multi-machine control write
 * rests on those helpers being right, so this file pins their behaviour cheaply: it
 * boots two small parties, probes them, and asserts the sizes, the member ids, every
 * accepted node shape, the argument-validation throws and the patch/restore lifecycle.
 *
 * There are no writes here at all, so the whole file runs in seconds — the one slow
 * step is waiting out the ~5 s FRET ring convergence on the three-node party.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Libp2p, PeerId } from '@libp2p/interface';
import { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import {
	createTestParty, shutdownTestParty, readControlCohort, waitForControlCohort,
	observeControlCohorts, forceFullCohort, pinCoordinator, CONTROL_COHORT_PROBE_KEY
} from '../harness/index.js';
import type { TestParty, TestCadreNode, CohortNodeSource } from '../harness/index.js';

/**
 * A `CadreNode`-shaped cohort source over an already-started libp2p node.
 *
 * The real `CadreNode` branch of `resolveControlLibp2p` is discriminated purely by the
 * presence of `getControlNode`, so this stands in for one without booting a cadre — which
 * the only scenario that uses real `CadreNode`s cannot currently do (see
 * `docs/STATUS.md` → `control-write-degraded-cohort-member`).
 *
 * NOTE: a stand-in cannot catch a `CadreNode` that GAINS a `libp2p` property, which would
 * silently re-route the resolver to the `TestCadreNode` branch (see the doc comment on
 * `resolveControlLibp2p`). Only a real instance would; re-check when that scenario runs.
 */
function asCadreNodeSource(controlNode: Libp2p | null): CohortNodeSource {
	return { getControlNode: () => controlNode } as unknown as CohortNodeSource;
}

/**
 * An exclusion entry as `NetworkTransactor` passes them. `pinCoordinator` compares
 * `excludedPeers` by `toString()` only, so a party node's peer id string is enough — the
 * harness never hands out real `PeerId` objects.
 */
function asPeerId(id: string): PeerId {
	return { toString: () => id } as unknown as PeerId;
}

/**
 * Ask the patched prototype directly. `forceFullCohort` / `pinCoordinator` install
 * substitutes that never touch `this`, so this observes exactly what they installed
 * without reaching into a node's private key-network instances.
 */
const patchedPrototype = Libp2pKeyPeerNetwork.prototype as unknown as {
	findCluster(key: Uint8Array): Promise<Record<string, unknown>>;
	findCoordinator(key: Uint8Array, options?: { excludedPeers?: PeerId[] }): Promise<PeerId>;
};

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

	it('accepts a bare started Libp2p as a cohort source', async () => {
		// The third `resolveControlLibp2p` branch — neither a CadreNode nor a
		// TestCadreNode, just the node itself.
		const forced = forceFullCohort([solo.ownerNode.libp2p]);
		try {
			expect(await readControlCohort(solo)).toEqual([solo.ownerNode.peerId]);
			expect(forced.cohortSizes()).toContain(1);
		} finally {
			forced.restore();
		}
	}, 30_000);

	it('accepts a CadreNode-shaped source, reading through getControlNode', async () => {
		// The branch the degraded-cohort scenario would exercise if its `beforeAll` ran;
		// covered here so the widening is not resting entirely on the type-checker.
		const forced = forceFullCohort([asCadreNodeSource(solo.ownerNode.libp2p)]);
		try {
			expect(await readControlCohort(solo)).toEqual([solo.ownerNode.peerId]);
			expect(forced.cohortSizes()).toContain(1);
		} finally {
			forced.restore();
		}
	}, 30_000);

	it('blames an unstarted CadreNode rather than dialling nothing', () => {
		// `getControlNode()` returns null until `start()`; forcing on that would build a
		// cohort entry with no address, which downstream looks like a dial failure.
		expect(() => forceFullCohort([asCadreNodeSource(null)]))
			.toThrow(/no started control node/);
	});

	it('rejects a non-object source by naming what it got', () => {
		expect(() => forceFullCohort([null as unknown as CohortNodeSource]))
			.toThrow(/expected a node object; got null/);
		expect(() => forceFullCohort(['not-a-node' as unknown as CohortNodeSource]))
			.toThrow(/expected a node object; got string/);
	});

	it('names the shape it could not recognise rather than forcing an empty cohort', () => {
		expect(() => forceFullCohort([{ notANode: true } as unknown as CohortNodeSource]))
			.toThrow(/unrecognised node shape.*notANode/s);
	});

	it('refuses a node listed twice, which would force a cohort smaller than asked for', () => {
		// Same libp2p node reached through two different source shapes: the entries
		// would collapse to one key and `cohortSizes()` would report 1, not 2.
		expect(() => forceFullCohort([solo.ownerNode, solo.ownerNode.libp2p]))
			.toThrow(/was listed twice/);
	});

	it('blames the wiring, not the network, when a node carries no attached key network', async () => {
		const unattached: TestCadreNode = { ...solo.ownerNode, libp2p: {} as unknown as Libp2p };
		// Must be a named throw rather than a poll to the 15 s timeout blaming FRET.
		await expect(readControlCohort(solo, unattached))
			.rejects.toThrow(/exposes no attached keyNetwork/);
		await expect(waitForControlCohort(solo, 1, { node: unattached }))
			.rejects.toThrow(/exposes no attached keyNetwork/);
	}, 30_000);

	it('pins the coordinator to the first candidate the caller has not excluded', async () => {
		const [droneA, droneB] = [trio.droneNodes[0]!, trio.droneNodes[1]!];
		const forced = forceFullCohort([trio.ownerNode, droneA, droneB]);
		const pinned = pinCoordinator([droneA, droneB]);
		try {
			expect((await patchedPrototype.findCoordinator(CONTROL_COHORT_PROBE_KEY)).toString())
				.toBe(droneA.peerId);
			// The transactor's re-coordination path: a failed coordinator comes back as an
			// exclusion, and the next candidate must serve rather than the pin re-picking it.
			expect((await patchedPrototype.findCoordinator(
				CONTROL_COHORT_PROBE_KEY, { excludedPeers: [asPeerId(droneA.peerId)] })).toString())
				.toBe(droneB.peerId);
			await expect(patchedPrototype.findCoordinator(CONTROL_COHORT_PROBE_KEY, {
				excludedPeers: [asPeerId(droneA.peerId), asPeerId(droneB.peerId)]
			})).rejects.toThrow(/every pinned coordinator candidate is excluded/);
			expect(pinned.callCount()).toBe(3);
		} finally {
			// Reverse order of application: unpin before un-forcing.
			pinned.restore();
			forced.restore();
		}
	}, 30_000);

	it('re-keys the cohort candidates-first without changing its membership', async () => {
		const drone = trio.droneNodes[1]!;
		const forced = forceFullCohort([trio.ownerNode, trio.droneNodes[0]!, drone]);
		const pinned = pinCoordinator([drone]);
		try {
			const members = Object.keys(await patchedPrototype.findCluster(CONTROL_COHORT_PROBE_KEY));
			// Set-cover keeps the first-inserted peer among those tied on coverage, so the
			// pinned candidate leading is the whole mechanism — but nobody may be dropped.
			expect(members[0]).toBe(drone.peerId);
			expect([...members].sort()).toEqual(
				[trio.ownerNode.peerId, ...trio.droneNodes.map((d) => d.peerId)].sort());
		} finally {
			pinned.restore();
			forced.restore();
		}
		// Both patches really are off: the real cohort read answers again.
		expect((await readControlCohort(trio)).length).toBeGreaterThanOrEqual(1);
	}, 30_000);

	it('refuses an empty coordinator candidate set', () => {
		expect(() => pinCoordinator([])).toThrow(/empty candidate set/);
	});

	it('refuses an out-of-order restore instead of reinstating a stale findCluster', async () => {
		const forced = forceFullCohort([solo.ownerNode]);
		const observer = observeControlCohorts();
		try {
			// The observer wraps the forcer, so the forcer is no longer the top of the
			// stack: un-forcing here would drop the observer's wrapper on the floor.
			expect(() => forced.restore()).toThrow(/reverse order of application/);
		} finally {
			observer.restore();
			// The throw does not latch — with the observer gone this now succeeds.
			forced.restore();
		}
		// Both really are off: the real method answers and neither handle counts.
		const forcedCalls = forced.callCount();
		const observedCalls = observer.callCount();
		await readControlCohort(solo);
		expect(forced.callCount()).toBe(forcedCalls);
		expect(observer.callCount()).toBe(observedCalls);
	}, 30_000);
});
