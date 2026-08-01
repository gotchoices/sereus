/**
 * Two-node convergence for party-wide strand removal (`unpublishStrand`).
 *
 * The regression anchor for the claim in docs/architecture.md ("Strand Membership
 * Bootstrap" → party-wide removal) and the `unpublishStrand` doc comment: *every
 * node of the party stops its instance once its watcher observes the missing
 * `Strand` row*. All prior coverage asserts on the node that ISSUED the removal —
 * `packages/cadre-core/test/strand-unpublish.spec.ts` stands in for a sibling by
 * deleting the row out from under a single node. This scenario is the first
 * cross-machine proof, and underneath it the first proof anywhere that a
 * control-plane DELETE becomes visible to a sibling reader at all
 * (`control-db-two-node-convergence` proves an INSERT converges;
 * `control-write-degraded-cohort-member` exercises `removePeer` but reads the
 * result back on the writer).
 *
 * Recipe notes (all load-bearing):
 * - CONNECT BEFORE WRITE, both the publish and the removal: a delete committed
 *   with a cluster of one is the separate delete-while-alone durability gap
 *   (`plan/control-delete-while-alone-tombstone`), deliberately out of scope.
 * - B is NOT its own owner (`bootPair`), so every row it observes arrived over
 *   the wire — Phase 1's `strand:discovered` is the anti-vacuity anchor proving
 *   a genuine network read before the removal is ever issued.
 * - B joins with an explicit `mode: 'bootstrap'`: left to inference,
 *   `selectStrandMode` would pick `'networked'` (A is a `CadrePeer` sibling) and
 *   B would resolve an empty strand-network seed since A runs no instance. The
 *   subject here is the control-plane watcher, not strand-data replication.
 * - Gate on events, never a sleep (except the quiet window, which is derived
 *   from the configured poll cadence rather than hardcoded).
 *
 * Deliberately NOT covered here:
 * - delete-while-alone durability (its own ticket, above);
 * - A running its own instance of the strand — A-side convergence is
 *   unit-covered by `strand-unpublish.spec.ts`; a second instance costs a
 *   strand-node boot for no new assertion;
 * - closed strands and `MemberPrivateKey` destruction (unit-covered);
 * - filter-excluded siblings (unit-covered: a node whose `strandFilter` never
 *   admitted the strand never observes the removal);
 * - a third node.
 */

import { describe, it, expect } from 'vitest';
import type { CadreNode, StrandRow } from '@serfab/cadre-core';
import {
	bootPair,
	connectControlNodes,
	createSignedSAppConfig,
	sleep,
	waitUntil,
} from '../harness/index.js';

// ═══════════════════════════════════════════════════════════════════════════════

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * Watcher poll cadence on BOTH nodes. Every poll is a network scan of
 * `CadreControl.Strand`, so keep this no shorter than 1 s; every quiet window
 * below is derived from it so a cadence change cannot silently turn a real
 * assertion vacuous.
 */
const STRAND_WATCH_MS = 1_000;

/** "…and it stays that way" window for Phase 4, five polls wide. */
const QUIET_WINDOW_MS = STRAND_WATCH_MS * 5;

/** One shared budget for every converge wait (discovery, stop, re-discovery). */
const CONVERGE_BUDGET_MS = 30_000;

/** Every strand lifecycle event B emits, in order, with the discovered rows kept. */
function collectStrandEvents(node: CadreNode): {
	discovered: string[];
	discoveredRows: StrandRow[];
	started: string[];
	stopped: string[];
	errors: string[];
} {
	const events = {
		discovered: [] as string[],
		discoveredRows: [] as StrandRow[],
		started: [] as string[],
		stopped: [] as string[],
		errors: [] as string[],
	};
	node.on('strand:discovered', ({ strandId, strand }) => {
		events.discovered.push(strandId);
		events.discoveredRows.push(strand);
	});
	node.on('strand:started', ({ strandId }) => void events.started.push(strandId));
	node.on('strand:stopped', ({ strandId }) => void events.stopped.push(strandId));
	node.on('strand:error', ({ strandId }) => void events.errors.push(strandId));
	return events;
}

/** Ids in a node's own control-DB `Strand` view — each read is a pull-on-read. */
async function strandIdsSeenBy(node: CadreNode): Promise<string[]> {
	return (await node.getControlDatabase()!.queryStrands()).map((row) => row.Id);
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Two-node strand-unpublish sibling convergence', () => {
	it('stops the sibling instance once its watcher observes the removal, exactly once, and rediscovers a re-publish', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			// ── Phase 0 — bring-up. A: owner + writer (storage profile); B: plain
			// reader, vouched by A so its pull streams pass A's per-stream control-DB
			// gate. Connect BEFORE the publish and before the removal.
			({ A, B } = await bootPair('unpublish', 'ctrl', { strandWatchMs: STRAND_WATCH_MS }));
			await connectControlNodes(B, A);

			const strandId = `strand-unpub-e2e-${Date.now()}`;
			const events = collectStrandEvents(B);

			// ── Phase 1 — B discovers and runs the strand. B holds no sApp config for
			// the id, so its watcher's first sighting emits `strand:discovered`. B never
			// wrote the row and is not an owner: observing it at all proves a genuine
			// network read (the precondition for the removal path ever firing).
			await A.publishStrand(strandId);
			await waitUntil(() => events.discovered.length >= 1, {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: 'B discovers the strand row published on A',
			});
			expect(events.discovered).toEqual([strandId]);
			const strandRow = events.discoveredRows[0]!;
			expect(strandRow).toEqual({ Id: strandId, MemberPrivateKey: null, Type: 'o' });

			const instance = await B.addStrand({
				strandRow,
				sAppConfig: createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0'),
				mode: 'bootstrap',
			});
			expect(instance.status).toBe('active');
			expect(B.getStrand(strandId)).toBeDefined();
			expect(events.started).toEqual([strandId]);

			// ── Phase 2 — the removal, issued on A while connected. A's own view is
			// already unit-covered; this read is only a cheap sanity anchor.
			await A.unpublishStrand(strandId);
			expect(await strandIdsSeenBy(A)).not.toContain(strandId);

			// ── Phase 3 — the headline: B's watcher observes the missing row and stops
			// its instance. This is the cross-machine visibility of a control-plane
			// DELETE, proven nowhere else.
			await waitUntil(() => events.stopped.length >= 1, {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: 'B stops its strand instance after observing the removal',
			});
			expect(events.stopped).toEqual([strandId]);
			expect(B.getStrand(strandId)).toBeUndefined();
			expect(B.getStrands().size).toBe(0);
			expect(await strandIdsSeenBy(B)).not.toContain(strandId);

			// ── Phase 4 — exactly once, and no re-add. The watcher dropped the id from
			// `knownStrands` before firing the callback, so nothing further may fire
			// across a multi-poll quiet window.
			await sleep(QUIET_WINDOW_MS);
			expect(events.stopped).toEqual([strandId]);
			expect(events.discovered).toEqual([strandId]);
			expect(events.started).toEqual([strandId]);
			expect(events.errors).toEqual([]);

			// ── Phase 5 — a re-publish is rediscovered. Proves B's watcher CLEARED the
			// id rather than tombstoning it locally, and that the `Revocation` row the
			// delete filed is not read back as a live strand. Discovered, not
			// relaunched: B's sApp config died with the instance in Phase 3.
			await A.publishStrand(strandId);
			await waitUntil(() => events.discovered.length >= 2, {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: 'B rediscovers the re-published strand row',
			});
			expect(events.discovered).toEqual([strandId, strandId]);
			expect(B.getStrand(strandId)).toBeUndefined();
			expect(events.errors).toEqual([]);
		} finally {
			// B first: its watcher must not spend its last polls reading a dead peer.
			await B?.stop();
			await A?.stop();
		}
	}, 180_000);
});
