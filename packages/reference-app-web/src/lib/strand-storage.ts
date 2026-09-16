/**
 * strand-storage.ts — per-scope IndexedDB `IRawStorage` provider for the
 * browser CadreNode.
 *
 * `CadreNodeConfig.storage.provider` is a **synchronous** factory
 * `(scope: string) => IRawStorage`, and cadre-core partitions each network's data
 * by scope key:
 *   - the control network calls `provider(controlStorageScope(partyId))` (see
 *     `cadre-core/src/storage-scope.ts`, and `cadre-node.ts` →
 *     `resolveControlStorage`) — the key carries the party id, so two parties on
 *     one origin never share a control store; and
 *   - each strand calls `provider(strandId)` (see
 *     `cadre-core/src/strand-instance-manager.ts` → `resolveStrandStorage`).
 *
 * Every key cadre-core mints is already within `[A-Za-z0-9._-]`, so this module
 * concatenates it into a database name without escaping.
 *
 * But `IndexedDBRawStorage` wraps an **already-open** `OptimysticWebDBHandle`
 * (the opener `openOptimysticWebDb` is async) and has no per-scope namespacing —
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

/** IndexedDB database-name prefix; one database per scope key. */
const DB_PREFIX = 'sereus-strand-';

/**
 * The key of the database holding this tab's **node-local** `kv` records — its
 * Ed25519 identity, its persisted party id, the trusted-owner anchor, the
 * bootstrap peers, the enrolled-machine count (see `node-local-slots.ts`).
 *
 * NOT a cadre-core scope key. It is spelled `'control'` only because that is the
 * name the database has carried since before the control block store became
 * party-scoped, and renaming it would strand every existing tab's identity.
 *
 * It cannot be party-scoped, and that is the reason the two roles are split: the
 * party id is read OUT of this database, so the database cannot be named after it.
 *
 * ORPHANED ROWS. A tab upgraded across the party-scoping change still has its old,
 * unscoped control BLOCKS in this database's block object stores. Nothing reads or
 * deletes them — they belong to a party that was never recorded alongside them,
 * which is the defect being fixed; adopting them into any party's store would
 * reintroduce it. Dev builds only, so they simply sit there. Same posture as the
 * abandoned `sereus-peer-identity` database noted in
 * `reference-app-rn/src/cadre-phone.ts`.
 */
export const NODE_LOCAL_STORE_KEY = 'control';

const handles = new Map<string, OptimysticWebDBHandle>();
const storages = new Map<string, IRawStorage>();

/**
 * Pre-open (and cache) an IndexedDB handle + `IndexedDBRawStorage` for each key.
 * Idempotent per key — a key already open is skipped. Must be awaited before the
 * synchronous {@link storageProvider} is invoked for that key (i.e. before
 * `node.start()` for the party-scoped control key, and before `node.addStrand(...)`
 * for a strand). {@link NODE_LOCAL_STORE_KEY} goes through here too, but is opened
 * for `cadre-web.ts` to read directly rather than for cadre-core to ask for.
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
