import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { controlNodeConfig, freshPartyId, scopedWithin } from './control-db-node-helpers.js';
import { CountingRawStorage, formatBreakdown, formatSnapshot, StorageOpCounter, type OpSnapshot } from './storage-op-counter.js';

/**
 * **What this protects: the NUMBER of raw-storage operations a control-database
 * start performs.**
 *
 * Bringing `ControlDatabase` up is neither CPU- nor network-bound. Its duration is
 * (operations issued against `IRawStorage`) × (what one such operation costs on the
 * device). On an idle developer machine one operation costs ~1 ms and a cold start
 * looks fine; on a loaded disk or a phone's flash under launch contention the same
 * operation costs 50–90 ms and the identical start takes tens of seconds and reads
 * as a frozen app. So the operation count — not wall clock — is the thing worth
 * pinning: it is deterministic, and it is what a regression would move.
 *
 * The amplification itself is NOT fixable from this repo. It is produced inside
 * `@optimystic/db-p2p` (the same handful of blocks are re-read dozens of times per
 * start), and the decision about whether and where to fix it is carried by
 * `tickets/blocked/optimystic-block-read-amplification-on-control-start.md`, which
 * holds the full measurement and the ruled-out hypotheses. **This spec is not that
 * fix.** It is the guard that keeps the cost visible and stops it growing silently,
 * and it stands whatever is decided upstream.
 *
 * Nothing else in the suite would notice a change that doubled the count: the only
 * other signal is wall clock, which stays green on an idle machine while the
 * device-facing behaviour gets worse.
 *
 * Deliberately backed by `MemoryRawStorage` rather than files — the COUNT is what is
 * asserted, so an in-memory backend keeps the spec fast and free of filesystem noise
 * while issuing exactly the same operations a file backend would. It does: the cold
 * figure below is identical to the one the blocked ticket measured over
 * `FileRawStorage`.
 *
 * The counts reproduce exactly — three consecutive runs gave byte-identical
 * per-method breakdowns — which is what makes a budget this close to the measurement
 * safe. If a run ever comes out a few operations off rather than wildly over, that
 * non-determinism is itself the finding; do not paper over it by widening the budget.
 *
 * Companions: `control-database-solo.spec.ts` (same cadre-of-one shape, asserting
 * behaviour rather than cost) and `control-database-solo-warm-start.spec.ts` (the
 * file-backed warm start, whose per-operation deadlines are hang detectors — this
 * spec is the reason they should not have to be widened).
 */

/** `start()`/`stop()` bring libp2p up and down; a bounded budget, only a hang detector. */
const LIFECYCLE_TIMEOUT_MS = 30_000;

/** `within` scoped to this spec's failure label: `storage-op-budget control op <label> …`. */
const within = scopedWithin('storage-op-budget');

/**
 * The measured figures, and the budgets sitting modestly above them.
 *
 * Re-measure by reading the `[storage-op-budget]` lines this spec prints — they carry the
 * same per-method breakdown the blocked ticket tabulates. **They only appear under
 * `vitest run --reporter=verbose`**: vitest's default reporter shows a passing test's
 * console output nowhere, so a plain `vitest run` prints not one of these lines. Every
 * assertion below therefore also embeds the breakdown in its own message, so a FAILURE is
 * self-diagnosing (which method grew, over how many blocks) without a re-run.
 *
 * When a change moves a number, update BOTH the measurement and its date here — a budget
 * with no provenance cannot tell the next reader whether the count grew or the budget was
 * always wrong.
 */
const MEASURED_ON = '2026-08-12';
/**
 * Cold: first-ever start against empty storage — 8 control tables and 1 index
 * created. 1541 operations over 21 blocks, of which `getMetadata` alone is 720 over
 * the same 21: each block's metadata is read ~34 times in one start. Only 130 of the
 * 1541 are writes. Identical to the figure the blocked ticket measured against
 * `FileRawStorage`, so the count is a property of the storage layer's call pattern,
 * not of the backend.
 */
const COLD: Budget = { ops: 1541, blocks: 21, opBudget: 1700, blockBudget: 24 };
/**
 * Warm: a second start against the storage the cold one left behind — the catalog
 * hydrates instead of the schema being applied, so the count drops roughly 5×. The
 * distinct-block count goes UP by one (22): the cold run had not yet written the
 * owner-key row this spec's genesis step leaves behind.
 *
 * A warm start is not the cheap case in the field — the worst stall on record was one
 * (`hydrate: 7774ms` then `loadSchema: 7929ms`) — so it carries its own budget rather
 * than hiding under the cold one.
 *
 * NOTE: only the COLD figure has been cross-checked against `FileRawStorage` (the blocked
 * ticket measured the same 1541 there). The warm one is memory-only, and both starts here
 * share ONE live storage object, so nothing is re-read across a process boundary. That is
 * sound while the operation count stays a property of the repo layer's call pattern, as
 * the cold cross-check shows it is. If a change ever makes the warm path backend-sensitive
 * — a decode step, a cache, anything only a file-backed restart exercises — this figure
 * stops standing for a real device restart; pin it against `fileStorageProvider` then
 * (`control-db-node-helpers.ts`, the shape `control-database-solo-warm-start.spec.ts`
 * uses), which costs wall clock and is why it was not done speculatively.
 */
const WARM: Budget = { ops: 315, blocks: 22, opBudget: 360, blockBudget: 25 };

/** What was measured for one phase, and the ceiling allowed above it. */
interface Budget {
	/** Operations the phase issued when it was measured, on {@link MEASURED_ON}. */
	ops: number;
	/** Distinct blocks it touched when it was measured. */
	blocks: number;
	/** Ceiling for total operations; a run above it is a regression. */
	opBudget: number;
	/** Ceiling for distinct blocks; a run above it means new persistent structures. */
	blockBudget: number;
}

// `StorageOpCounter`, `CountingRawStorage` and the formatters live in
// `storage-op-counter.ts`, shared with `strand-solo-write-budget.spec.ts`. The
// budgets below passing unchanged is the proof the hoist was faithful.

/**
 * Assert one phase against its budget.
 *
 * Two-sided on purpose. The ceiling is the regression guard. The FLOOR is the
 * anti-vacuity guard: if the node ever stops routing through the storage this spec
 * hands it — a config rename, a provider that is silently ignored — the count
 * collapses to near zero and a ceiling-only assertion passes while measuring
 * nothing. A genuine improvement trips the same floor, which is the intended
 * prompt to re-measure and tighten rather than to leave stale headroom.
 *
 * Every message carries the per-method breakdown, because vitest's default reporter prints
 * a passing test's `console.log` nowhere: a bare total says the count grew, the breakdown
 * says WHICH method grew, and a reader should not need a second run under
 * `--reporter=verbose` to learn that.
 */
function expectWithinBudget(phase: string, snapshot: OpSnapshot, budget: Budget): void {
	const provenance = `measured ${budget.ops} ops over ${budget.blocks} distinct blocks on ${MEASURED_ON}`;
	const breakdown = `This run, calls/distinct-blocks by method: ${formatBreakdown(snapshot)}.`;
	expect(
		snapshot.total,
		`${phase} start issued ${snapshot.total} raw-storage operations, over the budget of ${budget.opBudget} (${provenance}). `
		+ 'Start duration is operations × per-operation storage latency, so this is a real slowdown on a loaded disk or a phone. '
		+ 'This fires FIRST when a control table is added too — check the distinct-block budget below before reading it as pure slowdown. '
		+ `See tickets/blocked/optimystic-block-read-amplification-on-control-start.md. ${breakdown}`
	).toBeLessThanOrEqual(budget.opBudget);

	expect(
		snapshot.distinctBlocks,
		`${phase} start touched ${snapshot.distinctBlocks} distinct blocks, over the budget of ${budget.blockBudget} (${provenance}). `
		+ 'More distinct blocks means new persistent structures, not more redundancy — check what was added rather than widening the total budget. '
		+ `The total-operation budget above will have fired on the same cause; widen both deliberately or neither. ${breakdown}`
	).toBeLessThanOrEqual(budget.blockBudget);

	// The floor: half the measured figure. Wide enough that ordinary noise never trips
	// it, narrow enough that "the storage is no longer in the path" always does.
	const floor = Math.floor(budget.ops / 2);
	expect(
		snapshot.total,
		`${phase} start issued only ${snapshot.total} raw-storage operations, far below the ${provenance}. `
		+ 'Either this spec is no longer measuring the real storage path (check that the node is still given this storage), '
		+ `or the amplification genuinely improved — in which case re-measure and TIGHTEN the budget rather than leaving the headroom. ${breakdown}`
	).toBeGreaterThan(floor);
}

describe('control database start, raw-storage operation budget', () => {
	it('stays within its operation budget on a cold start and on a warm restart', async () => {
		const partyId = freshPartyId('storage-op-budget');
		const keyStore = new InMemoryKeyStore();
		const counter = new StorageOpCounter();
		// One storage instance across both runs — the same warm-restart shape
		// `control-database-solo.spec.ts` uses, so the second start enters the
		// catalog-hydrate path rather than re-creating the schema.
		const storage = new CountingRawStorage(new MemoryRawStorage(), counter);
		const config = () => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage });

		// --- Cold: first ever start, empty storage ---------------------------------
		const first = new CadreNode(config());
		let ownerPublicKey: string;
		let cold: OpSnapshot;
		try {
			counter.reset();
			await within('first.start() (cold)', LIFECYCLE_TIMEOUT_MS, () => first.start());
			// Snapshot immediately: everything after this point is the spec's own doing.
			cold = counter.snapshot();
			console.log(formatSnapshot('storage-op-budget', 'cold start', cold));

			// Genesis AFTER the snapshot, so it costs the cold budget nothing. Its
			// purpose is the warm run below: without a written row, a warm start that
			// silently came up on an empty database would be indistinguishable from one
			// that hydrated, and the warm budget would be measuring the wrong path.
			const owner = first.getIdentityOwnerKey();
			ownerPublicKey = owner.publicKeyB64;
			const db = first.getControlDatabase();
			expect(db).not.toBeNull();
			expect(await within('ensureOwnerKey() (genesis)', LIFECYCLE_TIMEOUT_MS, () => db!.ensureOwnerKey(ownerPublicKey)))
				.toBe(true);
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
		}

		// --- Warm: second start over what the first left behind ---------------------
		const second = new CadreNode(config());
		let warm: OpSnapshot;
		try {
			counter.reset();
			await within('second.start() (warm)', LIFECYCLE_TIMEOUT_MS, () => second.start());
			warm = counter.snapshot();
			console.log(formatSnapshot('storage-op-budget', 'warm restart', warm));

			// Anti-vacuity: the warm start really did read the prior session's rows.
			const db = second.getControlDatabase();
			expect(db).not.toBeNull();
			expect(await within('hasOwnerKey() (warm)', LIFECYCLE_TIMEOUT_MS, () => db!.hasOwnerKey())).toBe(true);
			expect(await within('getOwnerKeys() (warm)', LIFECYCLE_TIMEOUT_MS, () => db!.getOwnerKeys()))
				.toEqual(new Set([ownerPublicKey]));
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
		}

		expectWithinBudget('cold', cold, COLD);
		expectWithinBudget('warm', warm, WARM);
	}, 180_000);
});
