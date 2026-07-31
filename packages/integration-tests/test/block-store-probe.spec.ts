/**
 * Unit coverage for the raw-block-store probe the physical-replication proof rests on.
 *
 * WHY THIS EXISTS SEPARATELY. `src/harness/block-store-probe.ts` is the only thing
 * standing between "the joiner physically holds these blocks" and a test that passes
 * vacuously. Its scenario caller exercises exactly one shape: full coverage, narrowed by
 * an `include` predicate, against two live `MemoryRawStorage`s. Every guard clause —
 * missing `listBlockIds`, scope collapse, unknown strand, pending-only metadata — and
 * every gap kind other than `absent` (`behind`, `metadataOnly`) would otherwise ship
 * unexercised, so a probe that silently reported "no gap" for the wrong reason would look
 * exactly like a passing replication proof.
 *
 * These are pure unit tests over hand-seeded stores: no libp2p, no cadre node, no strand.
 * They live in `test/` (with the suite's other wiring specs) rather than `src/scenarios/`
 * because they need none of that setup.
 */

import { describe, expect, it } from 'vitest';
import { MemoryRawStorage, type IRawStorage } from '@optimystic/db-p2p';
import type { ActionId, BlockId, IBlock } from '@optimystic/db-core';

import {
	BlockStoreProbeError,
	blockCoverageIsComplete,
	captureRawStorage,
	compareBlockCoverage,
	formatBlockCoverageGap,
	newOrAdvancedSince,
	readBlockIndex,
} from '../src/harness/block-store-probe.js';

// ── Seeding helpers ─────────────────────────────────────────────────────────
// A block is "committed and materialized here" iff its metadata carries `latest` AND the
// content for that revision's actionId is retrievable. Every helper below writes exactly
// one of those two halves, so a test can produce each half-state deliberately.

/** The action id this suite uses for revision `rev` of `blockId` — stable and readable. */
function actionFor(blockId: BlockId, rev: number): ActionId {
	return `${blockId}-action-${rev}`;
}

function blockFor(blockId: BlockId): IBlock {
	return { header: { id: blockId, type: 'test', collectionId: blockId } };
}

/** Record `blockId` as committed at `rev` — metadata only, no content bytes. */
async function seedMetadata(store: IRawStorage, blockId: BlockId, rev: number): Promise<void> {
	const actionId = actionFor(blockId, rev);
	await store.saveRevision(blockId, rev, actionId);
	await store.saveMetadata(blockId, { ranges: [[rev, rev + 1]], latest: { actionId, rev } });
}

/** Record `blockId` as committed at `rev` WITH its content materialized. */
async function seedBlock(store: IRawStorage, blockId: BlockId, rev: number): Promise<void> {
	await seedMetadata(store, blockId, rev);
	await store.saveMaterializedBlock(blockId, actionFor(blockId, rev), blockFor(blockId));
}

/** A store whose backend does not implement the optional `listBlockIds`. */
function storeWithoutListing(): IRawStorage {
	return new Proxy(new MemoryRawStorage(), {
		get: (target, prop, receiver) => (prop === 'listBlockIds' ? undefined : Reflect.get(target, prop, receiver)),
	}) as IRawStorage;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('readBlockIndex', () => {
	it('maps every committed block to its latest revision', async () => {
		const store = new MemoryRawStorage();
		await seedBlock(store, 'block-a', 3);
		await seedBlock(store, 'block-b', 7);

		const index = await readBlockIndex(store);

		expect([...index.keys()].sort()).toEqual(['block-a', 'block-b']);
		expect(index.get('block-a')).toEqual({ actionId: actionFor('block-a', 3), rev: 3 });
		expect(index.get('block-b')?.rev).toBe(7);
	});

	it('omits blocks whose metadata carries no committed revision', async () => {
		// `savePendingTransaction` seeds metadata for a block that has NOT committed here.
		// Counting it would let an uncommitted block satisfy a durability claim.
		const store = new MemoryRawStorage();
		await seedBlock(store, 'committed', 1);
		await store.savePendingTransaction('pending-only', actionFor('pending-only', 1), { insert: blockFor('pending-only') });

		expect([...(await readBlockIndex(store)).keys()]).toEqual(['committed']);
	});

	it('throws rather than reporting an empty index when the backend cannot enumerate', async () => {
		// An empty index makes every coverage assertion built on it pass vacuously, so this
		// must be loud. `BlockStoreProbeError` specifically, so it never reads as a timeout.
		await expect(readBlockIndex(storeWithoutListing())).rejects.toThrow(BlockStoreProbeError);
		await expect(readBlockIndex(storeWithoutListing())).rejects.toThrow(/listBlockIds/);
	});
});

describe('captureRawStorage', () => {
	it('hands back the SAME store for a repeated scope', async () => {
		// cadre-core asks the provider again whenever a strand runtime is rebuilt; a fresh
		// store per call would silently drop the strand's blocks on resume.
		const capture = captureRawStorage();
		const first = capture.provider('strand-1');
		expect(capture.provider('strand-1')).toBe(first);
		expect(capture.provider('control')).not.toBe(first);
	});

	it('reports the scopes it was asked for, in ask order', () => {
		const capture = captureRawStorage();
		capture.provider('control');
		capture.provider('strand-1');
		expect(capture.scopes()).toEqual(['control', 'strand-1']);
	});

	it('refuses to serve the control scope as a strand', () => {
		const capture = captureRawStorage();
		capture.provider('control');
		expect(() => capture.forStrand('control')).toThrow(BlockStoreProbeError);
	});

	it('names the scopes it did see when asked for a strand it never made', () => {
		const capture = captureRawStorage();
		capture.provider('control');
		expect(() => capture.forStrand('strand-missing')).toThrow(/scopes seen so far: \[control\]/);
	});

	it('refuses a capture whose factory collapses every scope into one store', () => {
		// A shared singleton would fold control blocks into every strand comparison — and
		// two nodes sharing it would compare a store with itself.
		const shared = new MemoryRawStorage();
		const capture = captureRawStorage(() => shared);
		capture.provider('control');
		capture.provider('strand-1');
		expect(() => capture.forStrand('strand-1')).toThrow(/SAME raw store/);
	});
});

describe('compareBlockCoverage (unnarrowed — the default two-argument form)', () => {
	it('reports no gap when the target holds every source block', async () => {
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 1);
		await seedBlock(target, 'block-a', 1);

		const gap = await compareBlockCoverage(source, target);
		expect(blockCoverageIsComplete(gap)).toBe(true);
		expect(formatBlockCoverageGap(gap)).toBe('no gap (target covers source)');
	});

	it('names the blocks the target has never seen', async () => {
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 1);
		await seedBlock(source, 'block-missing', 1);
		await seedBlock(target, 'block-a', 1);

		const gap = await compareBlockCoverage(source, target);
		expect(gap.absent).toEqual(['block-missing']);
		expect(formatBlockCoverageGap(gap)).toContain('absent: [block-missing]');
	});

	it('names a block the target holds at a STALER revision', async () => {
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 5);
		await seedBlock(target, 'block-a', 2);

		const gap = await compareBlockCoverage(source, target);
		expect(gap.behind).toEqual([{ blockId: 'block-a', sourceRev: 5, targetRev: 2 }]);
		expect(formatBlockCoverageGap(gap)).toContain('source rev 5 > target rev 2');
	});

	it('names a block the target knows about but holds no content bytes for', async () => {
		// The half-state a replication bug most plausibly produces: metadata propagated,
		// payload did not. Coverage that accepted it would prove nothing about durability.
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 1);
		await seedMetadata(target, 'block-a', 1);

		const gap = await compareBlockCoverage(source, target);
		expect(gap.metadataOnly).toEqual(['block-a']);
		expect(gap.absent).toEqual([]);
		expect(formatBlockCoverageGap(gap)).toContain('metadata-only');
	});

	it('accepts content stored as a promoted transaction rather than a materialized block', async () => {
		// A block committed locally has its transform promoted into the transaction store;
		// only a block replicated in lands materialized. Demanding one shape would report a
		// false negative for whichever half arrived the other way.
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 1);
		await seedMetadata(target, 'block-a', 1);
		await target.saveTransaction('block-a', actionFor('block-a', 1), { insert: blockFor('block-a') });

		expect(blockCoverageIsComplete(await compareBlockCoverage(source, target))).toBe(true);
	});

	it('is one-directional: a target that is AHEAD or holds extra blocks is still covering', async () => {
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 2);
		await seedBlock(target, 'block-a', 9);
		await seedBlock(target, 'block-target-only', 1);

		expect(blockCoverageIsComplete(await compareBlockCoverage(source, target))).toBe(true);
	});

	it('propagates the enumeration guard instead of reporting full coverage', async () => {
		// An unreadable SOURCE index is the vacuity case: zero source blocks compare clean.
		await expect(compareBlockCoverage(storeWithoutListing(), new MemoryRawStorage())).rejects.toThrow(BlockStoreProbeError);
	});
});

describe('newOrAdvancedSince', () => {
	const baseline = new Map([
		['unchanged', { actionId: 'a', rev: 4 }],
		['advanced', { actionId: 'b', rev: 4 }],
	]);
	const include = newOrAdvancedSince(baseline);

	it('accepts a block absent from the baseline', () => {
		expect(include('brand-new', { actionId: 'c', rev: 1 })).toBe(true);
	});

	it('accepts a block whose revision has advanced', () => {
		expect(include('advanced', { actionId: 'b2', rev: 5 })).toBe(true);
	});

	it('rejects a block sitting at its baseline revision', () => {
		expect(include('unchanged', { actionId: 'a', rev: 4 })).toBe(false);
	});

	it('rejects a block reported BELOW its baseline revision', () => {
		// Not expected in practice; asserted so a future `!==` rewrite cannot turn a
		// nonsensical rollback into an included block.
		expect(include('unchanged', { actionId: 'a', rev: 3 })).toBe(false);
	});

	it('accepts everything against an empty baseline', () => {
		expect(newOrAdvancedSince(new Map())('anything', { actionId: 'x', rev: 0 })).toBe(true);
	});
});

describe('compareBlockCoverage narrowed by include', () => {
	it('ignores source blocks the predicate rejects, and only those', async () => {
		// The shape the physical-replication proof runs: the pre-baseline block is missing
		// from the target and must NOT count, while a post-baseline one still must.
		const source = new MemoryRawStorage();
		const target = new MemoryRawStorage();
		await seedBlock(source, 'pre-baseline', 1);
		await seedBlock(source, 'post-baseline', 1);
		await seedBlock(target, 'post-baseline', 1);

		const baseline = await readBlockIndex(source);
		await seedBlock(source, 'later-still', 1);

		expect(blockCoverageIsComplete(await compareBlockCoverage(source, target))).toBe(false);
		const narrowed = await compareBlockCoverage(source, target, { include: newOrAdvancedSince(baseline) });
		expect(narrowed.absent).toEqual(['later-still']);
	});

	it('an all-rejecting predicate reports full coverage — the vacuity a caller must floor', async () => {
		// Documented, not endorsed: `include` can make coverage trivially true, which is
		// exactly why the scenario asserts the size of the compared set before gating on it.
		const source = new MemoryRawStorage();
		await seedBlock(source, 'block-a', 1);

		const gap = await compareBlockCoverage(source, new MemoryRawStorage(), { include: () => false });
		expect(blockCoverageIsComplete(gap)).toBe(true);
	});
});
