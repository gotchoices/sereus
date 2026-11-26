/**
 * The one place cadre-core puts a read cache in front of a scope's block store.
 *
 * Both seams that open a scope's storage — `CadreNode` for the control database and
 * `StrandInstanceManager` for each strand — hand Optimystic a `NodeStorage` whose `blocks` is
 * the cached view, and hold the lease for the scope's runtime lifetime. One helper so the two
 * cannot drift on the shape they build or on who releases what.
 */

import { withReadCache, type NodeStorage, type ReadCacheLease } from '@optimystic/db-p2p';

/** A scope's storage as a node is handed it, with this scope's claim on the cache behind `blocks`. */
export interface CachedNodeStorage {
	/** The opened storage with `blocks` replaced by its cached view. */
	readonly storage: NodeStorage;
	/** This scope's lease on that cache, or `undefined` when the store passed through unwrapped. */
	readonly lease: ReadCacheLease | undefined;
}

/**
 * `opened` with a leased read cache in front of its `blocks`, labelled `scope` in the shared
 * cache pool's `stats()`.
 *
 * **Why cadre-core wraps rather than letting the node do it.** A node calls `withReadCache` on
 * the `blocks` it is given and releases its lease when IT stops — but cadre-core rebuilds a
 * strand's libp2p node across runtimes over one store, on a hibernation wake and on every
 * runtime rebuild, and upstream starts a cache cold once the last lease over a location has
 * released. Wrapping here and holding the lease for the scope's lifetime is what keeps the cache
 * warm across those rebuilds. A `blocks` that already reports `readCached` is passed through by
 * the node and takes no lease of its own, which is upstream's documented "a host that attaches
 * its own read cache and hands the result in keeps owning it".
 *
 * `pieces` and `kv` are carried through untouched, and `blocks` is the only field replaced: the
 * cache reports the INNER store's identity, so `blockStoreCountsPieces` still finds `blocks` and
 * `pieces` in one location and the node's account does not count the pieces twice. Do not reorder
 * this so that `pieces` comes from a different value than `blocks` did.
 */
export function cachedNodeStorage(opened: NodeStorage, scope: string): CachedNodeStorage {
	const { storage: blocks, lease } = withReadCache(opened.blocks, scope);
	return { storage: { ...opened, blocks }, lease };
}

/**
 * Release a scope's claim on its cache, logging rather than throwing: the storage is already
 * unreferenced by the time a scope stops, and failing a teardown over cache bookkeeping would
 * leave the caller unable to tear the scope down. Idempotent, as `ReadCacheLease.release` is.
 *
 * The cache is emptied and unregistered from the shared pool only when the LAST lease over that
 * location releases, so one scope stopping never retires a cache another live scope reads through.
 * Nothing here closes the storage the embedder opened — that handle stays theirs (`types.ts`,
 * `StorageConfig.open`).
 */
export async function releaseReadCacheLease(
	lease: ReadCacheLease | undefined,
	label: string,
	log: (format: string, ...args: unknown[]) => void
): Promise<void> {
	if (!lease) {
		return;
	}
	try {
		await lease.release();
	} catch (error) {
		log('Failed to release the read-cache lease for %s: %o', label, error);
	}
}
