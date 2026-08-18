import { describe, it, expect } from 'vitest';
import { CachedRawStorage, MemoryRawStorage, defaultCachePool, type IRawStorage } from '@optimystic/db-p2p';
import { wrapStorageWithCache, disposeStorageCache } from '../src/cached-storage.js';

/**
 * `wrapStorageWithCache` is the one place Sereus opts every embedder-supplied
 * `IRawStorage` into upstream's write-through cache, and its correctness rests on a
 * single rule the module doc states: **one live cache per backend**. Two caches over
 * one store would each miss the other's writes (upstream `docs/storage.md` Invariant
 * 1), so the memo is not an optimisation — it is what makes overlapping call sites
 * safe. cadre-core wraps at its node seams and `composeStrand` wraps again over
 * whatever it is handed; both must land on the same object.
 *
 * The wiring itself (which seams call this, with which label) is asserted where the
 * wiring lives — `cadre-core/test/cadre-node-control-node-options.spec.ts` and
 * `strand-instance-manager-backfill.spec.ts`. This spec owns the function's own
 * contract, in the package that owns the function.
 *
 * `{} as IRawStorage` is enough for every case here: `CachedRawStorage`'s constructor
 * only feature-detects the optional members, so no method is ever called.
 *
 * Note the import split, which is load-bearing: the module under test imports its
 * classes from `@optimystic/db-p2p/rn` (the platform-neutral entry, because the browser
 * path reaches it) while this spec imports them from the default entry. Both entries
 * re-export the same storage modules, so the `instanceof` checks inside must still see
 * one class — if a packaging change ever duplicated them, the pass-through cases here
 * fail rather than the cache silently double-wrapping in production.
 */
describe('wrapStorageWithCache', () => {
	it('wraps a plain storage in the write-through cache', () => {
		const inner = {} as IRawStorage;

		const wrapped = wrapStorageWithCache(inner, 'plain');

		expect(wrapped).toBeInstanceOf(CachedRawStorage);
		expect(wrapped).not.toBe(inner);
	});

	it('returns the SAME cache for repeated wraps of one instance', () => {
		const inner = {} as IRawStorage;

		expect(wrapStorageWithCache(inner, 'memoized')).toBe(wrapStorageWithCache(inner, 'memoized'));
	});

	it('ignores the label on a repeat wrap rather than minting a second cache', () => {
		// The seams disagree in principle — cadre-core labels the control store
		// 'control' while a caller downstream may pass a strand id. A second cache
		// over one backend is the failure mode that matters; a stale pool label is not.
		const inner = {} as IRawStorage;
		const first = wrapStorageWithCache(inner, 'first-label');

		expect(wrapStorageWithCache(inner, 'second-label')).toBe(first);
	});

	it('is idempotent over an already-cached storage', () => {
		// `composeStrand` re-wraps storage cadre-core already wrapped; wrapping the
		// wrapper would put two caches in series over one backend.
		const wrapped = wrapStorageWithCache({} as IRawStorage, 'already-wrapped');

		expect(wrapStorageWithCache(wrapped, 'again')).toBe(wrapped);
	});

	it('passes MemoryRawStorage through unwrapped', () => {
		// Upstream's own guidance: the backend is already in memory, so the cache is
		// pure bookkeeping. Every in-process test harness relies on this.
		const inner = new MemoryRawStorage();

		expect(wrapStorageWithCache(inner, 'memory')).toBe(inner);
	});

	it('keeps distinct instances on distinct caches', () => {
		// Two stores are two backends; sharing a cache between them would alias
		// name-derived header block ids across stores.
		const a = wrapStorageWithCache({} as IRawStorage, 'a');
		const b = wrapStorageWithCache({} as IRawStorage, 'b');

		expect(a).not.toBe(b);
	});
});

/**
 * The release half of the ownership rule. cadre-core resolves one store per scope per
 * runtime and calls this when that runtime ends; without it the retired wrapper's
 * registration stays in the shared pool for the process lifetime (`unregisterStore`
 * is the only removal), one orphan per stop in a process designed to run for weeks.
 *
 * The second test is the reason dispose has to touch the memo at all: `wraps` is keyed
 * by the INNER instance, so a provider that returns a stable instance per scope (the
 * web reference app, the integration harness) would otherwise be handed the disposed
 * wrapper back on the scope's next launch.
 */
describe('disposeStorageCache', () => {
	it('retires the pool registration the wrap created', async () => {
		const before = defaultCachePool().stats().stores.length;
		const wrapped = wrapStorageWithCache({} as IRawStorage, 'disposable');
		expect(defaultCachePool().stats().stores.length).toBe(before + 1);

		await disposeStorageCache(wrapped);

		expect(defaultCachePool().stats().stores.length).toBe(before);
	});

	it('evicts the memo, so re-wrapping the same inner instance yields a LIVE cache', async () => {
		const inner = {} as IRawStorage;
		const first = wrapStorageWithCache(inner, 'relaunch');

		await disposeStorageCache(first);
		const second = wrapStorageWithCache(inner, 'relaunch');

		expect(second).not.toBe(first);
		expect(second).toBeInstanceOf(CachedRawStorage);
	});

	it('leaves a live successor alone when handed an already-disposed wrapper', async () => {
		// Dispose is keyed on identity, not on the inner instance: a late second dispose
		// of a retired wrapper must not evict the memo entry its successor now owns.
		const inner = {} as IRawStorage;
		const first = wrapStorageWithCache(inner, 'double-dispose');
		await disposeStorageCache(first);
		const second = wrapStorageWithCache(inner, 'double-dispose');

		await disposeStorageCache(first);

		expect(wrapStorageWithCache(inner, 'double-dispose')).toBe(second);
	});

	it('is a no-op for storage this module returned unwrapped', async () => {
		// Callers hand back whatever `wrapStorageWithCache` gave them, which for an
		// in-memory backend is the backend itself — no instanceof test at the call site.
		const inner = new MemoryRawStorage();

		await expect(disposeStorageCache(wrapStorageWithCache(inner, 'memory'))).resolves.toBeUndefined();
	});
});
