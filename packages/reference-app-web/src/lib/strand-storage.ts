/**
 * strand-storage.ts — per-strand IndexedDB `IRawStorage` provider for the
 * browser CadreNode.
 *
 * `CadreNodeConfig.storage.provider` is a **synchronous** factory
 * `(key: string) => IRawStorage`, and cadre-core partitions each network's data
 * by key:
 *   - the control network calls `provider('control')` (see
 *     `cadre-core/src/cadre-node.ts` → `createControlNode`), and
 *   - each strand calls `provider(strandId)` (see
 *     `cadre-core/src/strand-instance-manager.ts` → `resolveStrandStorage`).
 *
 * But `IndexedDBRawStorage` wraps an **already-open** `OptimysticWebDBHandle`
 * (the opener `openOptimysticWebDb` is async) and has no per-strand namespacing —
 * every block key lives in one IndexedDB database. RN sidesteps this because its
 * LevelDB opener is synchronous; the web handle is not.
 *
 * Bridge: pre-open one handle per key (a distinct IndexedDB database named
 * `sereus-strand-<key>`) **before** the sync provider is hit, stash the handles,
 * and have the provider return `new IndexedDBRawStorage(handle)` for the
 * requested key. The reference app drives the control bring-up and `addStrand`
 * explicitly, so every key is known ahead of the factory call (call
 * `openStores([...])` first). Returning a single cached `IndexedDBRawStorage`
 * per key keeps the libp2p storageRepo and the bootstrap-mode local transactor
 * (which share the instance) pointed at the same handle.
 */

import {
	IndexedDBRawStorage,
	openOptimysticWebDb,
	type OptimysticWebDBHandle,
} from '@optimystic/db-p2p-storage-web';
import type { IRawStorage } from '@optimystic/db-p2p';

/** IndexedDB database-name prefix; one database per control/strand key. */
const DB_PREFIX = 'sereus-strand-';

/**
 * The key cadre-core uses for the control network's raw storage. Must match the
 * literal `'control'` passed by `CadreNode.createControlNode` — keep in sync.
 */
export const CONTROL_STORE_KEY = 'control';

const handles = new Map<string, OptimysticWebDBHandle>();
const storages = new Map<string, IRawStorage>();

/**
 * Pre-open (and cache) an IndexedDB handle + `IndexedDBRawStorage` for each key.
 * Idempotent per key — a key already open is skipped. Must be awaited before the
 * synchronous {@link storageProvider} is invoked for that key (i.e. before
 * `node.start()` for `'control'` and before `node.addStrand(...)` for a strand).
 */
export async function openStores(keys: string[]): Promise<void> {
	for (const key of keys) {
		if (handles.has(key)) continue;
		const handle = await openOptimysticWebDb(DB_PREFIX + key);
		handles.set(key, handle);
		storages.set(key, new IndexedDBRawStorage(handle));
	}
}

/**
 * Synchronous storage factory handed to `CadreNodeConfig.storage.provider`.
 * Returns the pre-opened `IndexedDBRawStorage` for `key`. Throws a clear error
 * if the key was not pre-opened — that is a wiring bug (a strand/control key
 * reached the provider before `openStores` ran), not a recoverable condition.
 */
export function storageProvider(key: string): IRawStorage {
	const storage = storages.get(key);
	if (!storage) {
		throw new Error(
			`strand-storage: no pre-opened IndexedDB handle for "${key}". ` +
				`Call openStores(['${key}']) before start()/addStrand().`,
		);
	}
	return storage;
}

/** The open IndexedDB handle for `key`, or null if not opened. */
export function getStoreHandle(key: string): OptimysticWebDBHandle | null {
	return handles.get(key) ?? null;
}

/** The `IRawStorage` for `key`, or null if not opened (used by diagnostics). */
export function getStoreStorage(key: string): IRawStorage | null {
	return storages.get(key) ?? null;
}

/** Close every open handle and drop the caches. Mirrors the old `db.close()`. */
export async function closeStores(): Promise<void> {
	for (const handle of handles.values()) {
		handle.close();
	}
	handles.clear();
	storages.clear();
}
