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
 * - **One wrap per inner instance** (WeakMap memo): storage providers may
 *   legitimately return the same `IRawStorage` for repeated calls (cadre-core's
 *   file provider memoizes; quiesce → resume replays the launch config), and the
 *   strand backfill path shares the instance the node was built with. Two live
 *   caches over one backend would each miss the other's writes; the memo makes the
 *   wrap idempotent instead — a caller wrapping an already-wrapped or
 *   already-seen instance gets the same object back. It also keeps a resumed
 *   strand's cache warm.
 * - **A Sereus process owns its data stores** — no second process writes the same
 *   backend, which is the invariant's other half.
 *
 * `MemoryRawStorage` is returned unwrapped on upstream's own guidance: the backend
 * is already in-memory, so the cache adds bookkeeping with nothing to save.
 *
 * NOTE: no `dispose()` is wired — the memoized wrap shares its inner storage's
 * lifetime, and a departed store's entries are cold and evicted by the shared
 * pool under pressure (upstream documents skipped dispose as leaking only that).
 * Revisit if pool `stats()` ever shows dead-store occupancy mattering.
 */

// Imported from the `/rn` entry — the platform-neutral surface (no Node-only
// transports) — because `composeStrand` reaches this module on the browser path
// too. Both db-p2p entrypoints re-export the same storage modules, so class
// identity (the `instanceof` checks below) is unaffected on Node.
import { CachedRawStorage, MemoryRawStorage, type IRawStorage } from '@optimystic/db-p2p/rn';

const wraps = new WeakMap<IRawStorage, CachedRawStorage>();

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
	}
	return wrapped;
}
