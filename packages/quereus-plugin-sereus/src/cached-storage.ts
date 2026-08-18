/**
 * Wrap an embedder-supplied `IRawStorage` in `@optimystic/db-p2p`'s write-through
 * raw-storage cache (`CachedRawStorage`) before handing it to a node or transactor.
 *
 * Why: bringing a control database or strand up is raw-storage-operation bound —
 * uncached, a cold start re-reads the same handful of blocks ~2000 times (see the
 * budget history in cadre-core's `test/control-start-storage-op-budget.spec.ts` and
 * the sereus tickets `complete/optimystic-block-read-amplification-on-control-start`
 * + `complete/optimystic-schema-catalog-reread-per-write-blows-storage-budgets`).
 * Upstream ships the remedy as an opt-in wrapper — adoption is deliberately the
 * consumer's choice — and this module is where Sereus opts in. It lives in this
 * package (not cadre-core) for the same reason `cluster-size.ts` does: both the SQL
 * plugin's own connectors (`composeStrand`, including the browser/IndexedDB path,
 * where per-operation latency is highest) and cadre-core's control/strand seams
 * need the identical wrap, and two copies could disagree.
 *
 * Soundness rests on the cache's single-process-owner invariant (upstream
 * docs/storage.md §6): every write to the backend must funnel through the wrapped
 * instance. Two rules uphold that:
 *
 * - **One wrap per inner instance** (WeakMap memo): the same `IRawStorage` reaches
 *   this function from several seams at once — cadre-core's node wiring and the
 *   strand backfill share the instance the node was built with, and the SQL
 *   plugin's `composeStrand` re-wraps whatever it is handed. Two live caches over
 *   one backend would each miss the other's writes; the memo makes the wrap
 *   idempotent instead — a caller wrapping an already-wrapped or already-seen
 *   instance gets the same object back.
 * - **A Sereus process owns its data stores** — no second process writes the same
 *   backend, which is the invariant's other half.
 *
 * `MemoryRawStorage` is returned unwrapped on upstream's own guidance: the backend
 * is already in-memory, so the cache adds bookkeeping with nothing to save.
 *
 * The memo dedupes *concurrent* seams; it is not what keeps a cache alive across a
 * runtime rebuild. That is cadre-core's job, and it does it by OWNERSHIP: one
 * resolved store per scope per runtime lifetime — a strand's store for the life of
 * its instance (a hibernation quiesce → resume reuses the store already resolved,
 * so the wake lands on a warm cache), the control store for the life of one
 * `CadreNode.start()`. Because the store outlives the rebuild, so does its wrap,
 * whether or not the embedder's provider returns a stable instance.
 *
 * When a scope's runtime stops for good, cadre-core calls {@link disposeStorageCache}
 * — the release half of that ownership. Without it the retired wrapper's
 * `CacheStoreHandle` would stay in the shared pool's registry for the process
 * lifetime (`unregisterStore` is the only removal), one orphan per stop.
 */

// Imported from the `/rn` entry — the platform-neutral surface (no Node-only
// transports) — because `composeStrand` reaches this module on the browser path
// too. Both db-p2p entrypoints re-export the same storage modules, so class
// identity (the `instanceof` checks below) is unaffected on Node.
import { CachedRawStorage, MemoryRawStorage, type IRawStorage } from '@optimystic/db-p2p/rn';

const wraps = new WeakMap<IRawStorage, CachedRawStorage>();

/**
 * Reverse of `wraps`, so {@link disposeStorageCache} can evict the memo entry it
 * cannot otherwise find — `wraps` is keyed by the inner instance, and dispose is
 * handed the wrapper.
 */
const inners = new WeakMap<CachedRawStorage, IRawStorage>();

/**
 * The cached view of `storage`, memoized per instance. `label` names the store in
 * the shared pool's `stats()` (e.g. `control`, or the strand id).
 */
export function wrapStorageWithCache(storage: IRawStorage, label: string): IRawStorage {
	if (storage instanceof MemoryRawStorage || storage instanceof CachedRawStorage) {
		return storage;
	}
	let wrapped = wraps.get(storage);
	if (!wrapped) {
		wrapped = new CachedRawStorage(storage, undefined, label);
		wraps.set(storage, wrapped);
		inners.set(wrapped, storage);
	}
	return wrapped;
}

/**
 * Release the cache wrapper {@link wrapStorageWithCache} returned: unregister it from
 * the shared pool and forget the memo, so a later re-wrap of the same inner instance
 * gets a live cache rather than this retired one. A disposed wrapper must never be
 * handed out again — its pool store id is retired and never reused — and providers
 * that return a stable instance per scope (the web reference app's `strand-storage.ts`,
 * the integration harness's `captureRawStorage`) would get exactly that back on a
 * relaunch if the memo were left in place.
 *
 * No-op for anything this module returned unwrapped (e.g. `MemoryRawStorage`), so
 * callers need no `instanceof` test. Only the wrapper is released: the inner store the
 * embedder returned is never closed — that handle stays the embedder's to manage.
 */
export async function disposeStorageCache(storage: IRawStorage): Promise<void> {
	if (!(storage instanceof CachedRawStorage)) {
		return;
	}
	const inner = inners.get(storage);
	if (inner) {
		inners.delete(storage);
		// Only evict the memo if it still points at THIS wrapper: a re-wrap after an
		// earlier dispose has already installed a live successor we must not drop.
		if (wraps.get(inner) === storage) {
			wraps.delete(inner);
		}
	}
	await storage.dispose();
}
