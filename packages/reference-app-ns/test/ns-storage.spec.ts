/**
 * `ns-storage.ts` — the cache of SQLite opens behind the lazy per-scope
 * `IRawStorage` proxy: one open per database name, and a failed open forgotten so
 * the next operation retries.
 *
 * The cache is module state with no injection seam, so every test calls
 * `loadModule()`, which does `vi.resetModules()` before a dynamic import and so
 * starts from an empty cache.
 *
 * The one-line delegating methods are not tested one by one: each takes its
 * signature from `IRawStorage`, so a wrong delegation is a type error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * All doubles live in one `vi.hoisted` block, and the mock factory returns
 * closures over its single state object — see the same block in
 * `cadre-phone.spec.ts` for why.
 */
const H = vi.hoisted(() => {
	/** Stands in for `SqliteRawStorage`; only the methods these tests call. */
	class FakeSqliteRawStorage {
		constructor(readonly db: { name: string }) {}

		async getMetadata(blockId: string): Promise<unknown> {
			state.metadataCalls.push({ storage: this, blockId });
			return sentinels.metadata;
		}

		async *listRevisions(blockId: string, startRev: number, endRev: number): AsyncIterable<unknown> {
			state.listRevisionsCalls.push([blockId, startRev, endRev]);
			yield* sentinels.revisions;
		}
	}

	const sentinels = {
		metadata: { tag: 'metadata' },
		revisions: [{ tag: 'rev-1' }, { tag: 'rev-2' }],
	};

	const state = {
		/** Database names passed to `openOptimysticNSDb`, in order. */
		opens: [] as string[],
		/** Each queued error fails one open, in order. */
		openErrors: [] as Error[],
		metadataCalls: [] as { storage: FakeSqliteRawStorage; blockId: string }[],
		listRevisionsCalls: [] as [string, number, number][],
	};

	function reset(): void {
		state.opens = [];
		state.openErrors = [];
		state.metadataCalls = [];
		state.listRevisionsCalls = [];
	}

	async function openOptimysticNSDb(name: string): Promise<{ name: string }> {
		state.opens.push(name);
		const error = state.openErrors.shift();
		if (error) throw error;
		return { name };
	}

	return { state, reset, sentinels, openOptimysticNSDb, FakeSqliteRawStorage };
});

vi.mock('@optimystic/db-p2p-storage-ns', () => ({
	openOptimysticNSDb: H.openOptimysticNSDb,
	SqliteRawStorage: H.FakeSqliteRawStorage,
}));

/** Fresh module instance, so the module-level open cache never crosses tests. */
async function loadModule(): Promise<typeof import('../src/ns-storage')> {
	vi.resetModules();
	return import('../src/ns-storage');
}

beforeEach(() => {
	H.reset();
});

describe('makeLazyNsStorage', () => {
	it('opens each database once, however many proxies and operations share it', async () => {
		const { makeLazyNsStorage } = await loadModule();
		const a1 = makeLazyNsStorage('a');
		const a2 = makeLazyNsStorage('a');
		const b = makeLazyNsStorage('b');

		await Promise.all([a1.getMetadata('x'), a2.getMetadata('y'), b.getMetadata('z')]);
		await a1.getMetadata('later');

		expect(H.state.opens).toEqual(['sereus-a', 'sereus-b']);
		const storageFor = (blockId: string) =>
			H.state.metadataCalls.find((call) => call.blockId === blockId)?.storage;
		expect(storageFor('x')).toBeDefined();
		expect(storageFor('y')).toBe(storageFor('x'));
		expect(storageFor('later')).toBe(storageFor('x'));
		expect(storageFor('z')).not.toBe(storageFor('x'));
	});

	it('reports a failed open to the operations awaiting it, then retries on the next one', async () => {
		const openError = new Error('sqlite plugin not ready');
		H.state.openErrors.push(openError);
		const { makeLazyNsStorage } = await loadModule();
		const storage = makeLazyNsStorage('a');

		const outcomes = await Promise.allSettled([storage.getMetadata('x'), storage.getMetadata('y')]);

		expect(outcomes).toEqual([
			{ status: 'rejected', reason: openError },
			{ status: 'rejected', reason: openError },
		]);
		expect(H.state.opens).toEqual(['sereus-a']);

		expect<unknown>(await storage.getMetadata('z')).toBe(H.sentinels.metadata);
		expect(H.state.opens).toEqual(['sereus-a', 'sereus-a']);
	});

	it('streams listRevisions from the delegate, opening only once iteration starts', async () => {
		const { makeLazyNsStorage } = await loadModule();

		const revisions = makeLazyNsStorage('a').listRevisions('block', 3, 7);
		expect(H.state.opens).toEqual([]);

		const yielded: unknown[] = [];
		for await (const revision of revisions) yielded.push(revision);

		expect(yielded).toEqual(H.sentinels.revisions);
		expect(H.state.listRevisionsCalls).toEqual([['block', 3, 7]]);
		expect(H.state.opens).toEqual(['sereus-a']);
	});
});
