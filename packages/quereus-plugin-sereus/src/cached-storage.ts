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
 * What the memo does NOT do is span a strand runtime rebuild. It is keyed on the
 * instance, and only some providers return a stable one per scope (the web
 * reference app's `strand-storage.ts`, the integration harness's
 * `captureRawStorage`); cadre-cli's file provider and the RN app's LevelDB one
 * mint a fresh `IRawStorage` on every call, and cadre-core calls the provider
 * again on every `buildStrandRuntime` — so each quiesce → resume gets a fresh,
 * cold cache and leaves the previous one registered with the shared pool. Not a
 * coherence problem (pool entries are keyed by a never-reused store id, and the
 * released runtime has stopped writing) but it forfeits the warm resume and never
 * calls `dispose()`. Owning one resolved store per strand instance is the fix;
 * `tickets/fix/strand-runtime-rebuild-remints-raw-storage.md` carries it, and no
 * `dispose()` is wired here until that lands because there is no lifetime to hang
 * it on.
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
