/**
 * strand-storage.ts — per-scope IndexedDB storage for the browser's edge node.
 *
 * cadre-core partitions each network's data by storage scope key: the control network's is
 * `controlStorageScope(partyId)` (`cadre-core/src/storage-scope.ts`), each strand's is its strand
 * id. Every key cadre-core mints is already within `[a-z0-9._-]`, so this module concatenates it
 * into a database name (`sereus-strand-<key>`) without escaping.
 *
 * `indexedDbNodeStorage` opens all of one scope's storage over an **already-open**
 * `OptimysticWebDBHandle`: the blocks, the node-local records the node keeps across a reload (its
 * blob records, the owed-blob and under-replication ledgers, the clock's high-water mark and its
 * transaction state) and the blob pieces this tab holds. The three share the one handle, so the
 * database's byte count — the origin's estimate — measures all of it.
 *
 * A scope's database opens on its first use: nothing is opened ahead of a start or an `addStrand`,
 * and a strand the control network lists gets storage like any other. One handle and one node
 * storage per key, cached here until {@link closeStores} (which the edge node calls on every stop),
 * so every caller for a scope shares one set of stores and diagnostics can read the control
 * database once the node has opened it ({@link getStoreHandle}). A strand's offline journal
 * ({@link openJournal}) is that same storage's `kv`.
 */

import {
	indexedDbNodeStorage,
	openOptimysticWebDb,
	type OptimysticWebDBHandle,
} from '@optimystic/db-p2p-storage-web';
import type { IKVStore, IRawStorage, OpenNodeStorage } from '@optimystic/db-p2p';

/** IndexedDB database-name prefix; one database per scope key. */
const DB_PREFIX = 'sereus-strand-';

/**
 * The key of the database holding this tab's **node-local** `kv` records — its key store
 * (identity, owner key, joined-strand and strand-move records) and the edge node's node-local
 * records (the saved start, the dissolve marker, each party's trusted-owner anchor, bootstrap
 * peers, enrolled-machine count and strand network state; see `node-local-slots.ts`).
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
const storages = new Map<string, OpenNodeStorage>();
/** Opens in flight, so two first uses of one key (a strand's read and its write) share one open. */
const opening = new Map<string, Promise<OptimysticWebDBHandle>>();

/** The open handle for `key`, opening its database on first use. One handle per key until {@link closeStores}. */
export async function openHandle(key: string): Promise<OptimysticWebDBHandle> {
	const open = handles.get(key);
	if (open) return open;
	const inFlight = opening.get(key);
	if (inFlight) return inFlight;
	const pending = openOptimysticWebDb(DB_PREFIX + key);
	opening.set(key, pending);
	try {
		const handle = await pending;
		handles.set(key, handle);
		return handle;
	} finally {
		opening.delete(key);
	}
}

/**
 * All of `key`'s node storage, over {@link openHandle}'s handle: `EdgeNodeStorage.nodeStorage`. One
 * set of stores per key until {@link closeStores}, because each store serves its unflushed writes
 * from memory and a second set over the handle would not see them.
 */
export async function openNodeStorage(key: string): Promise<OpenNodeStorage> {
	// NOTE: a call whose handle was cached before a concurrent closeStores cleared the maps caches a
	// storage over a closed handle. The edge node stops its strands before closing storage, so no
	// build asks then; if one ever can, check the handle is still `handles.get(key)`.
	const handle = await openHandle(key);
	let storage = storages.get(key);
	if (!storage) {
		// Synchronous after the await, so two first uses of one key cannot both open a set of stores.
		storage = indexedDbNodeStorage(handle);
		storages.set(key, storage);
	}
	return storage;
}

/**
 * The strand's offline journal for `key`: `EdgeNodeStorage.offlineJournal`, which is that scope's
 * OWN key-value store and never a second one over its handle. Optimystic declares the journal's key
 * prefix among the node's own key-value namespaces for exactly this sharing, so the journal's keys
 * stay out of every block listing — and it is the same default prefix the plugin's browser connect
 * uses over a database of this name (`connectToStrandBrowser`).
 */
export async function openJournal(key: string): Promise<IKVStore> {
	return (await openNodeStorage(key)).kv;
}

/** The open IndexedDB handle for `key`, or null if not opened. */
export function getStoreHandle(key: string): OptimysticWebDBHandle | null {
	return handles.get(key) ?? null;
}

/** The block store for `key`, or null if not opened: diagnostics reads its backend label and byte count. */
export function getStoreStorage(key: string): IRawStorage | null {
	return storages.get(key)?.blocks ?? null;
}

/**
 * Close every open handle and drop the caches: `EdgeNodeStorage.close`. Each scope's node storage
 * commits what its stores still hold before its handle closes; a failure doing so is logged and the
 * rest still close. Waits for an open in flight first, so it cannot land a handle after the clear.
 */
export async function closeStores(): Promise<void> {
	await Promise.allSettled([...opening.values()]);
	const open = [...handles.entries()];
	handles.clear();
	const stores = [...storages.values()];
	storages.clear();
	for (const storage of stores) await closeLogged('a node storage', storage);
	for (const [, handle] of open) handle.close();
}

async function closeLogged(what: string, closable: { close?(): Promise<void> }): Promise<void> {
	try {
		await closable.close?.();
	} catch (err) {
		console.warn(`[reference-app-web] closing ${what} failed:`, err);
	}
}

/**
 * {@link deleteStore} gave up: another connection keeps the database open, in practice a second
 * tab of this site still running the party it belongs to. The deletion stays queued in the
 * browser and runs once that connection closes.
 */
export class StoreDeleteBlockedError extends Error {
	constructor(readonly key: string) {
		super(`IndexedDB database ${DB_PREFIX + key} is open in another tab of this site; it is deleted once that tab closes`);
		this.name = 'StoreDeleteBlockedError';
	}
}

/**
 * Keys whose deletion this page asked for and another connection blocked. A second request for
 * one would queue behind the first and settle only when that connection closes, so it is refused
 * at once instead.
 */
const blockedDeletes = new Set<string>();

/**
 * Delete the database of `key`, closing this page's handle on it first: `EdgeNodeStorage.destroyScope`.
 * Succeeds when there is no such database. Throws {@link StoreDeleteBlockedError} rather than
 * waiting while another tab holds it open: the browser fires `blocked` and would otherwise wait
 * for as long as that tab runs.
 */
export async function deleteStore(key: string): Promise<void> {
	if (blockedDeletes.has(key)) throw new StoreDeleteBlockedError(key);
	const inFlight = opening.get(key);
	if (inFlight) await inFlight.catch(() => undefined);
	const storage = storages.get(key);
	storages.delete(key);
	// Before the handle, as in closeStores: the stores commit what they hold through it.
	if (storage) await closeLogged('a node storage', storage);
	handles.get(key)?.close();
	handles.delete(key);
	await deleteDatabase(key);
}

function deleteDatabase(key: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(DB_PREFIX + key);
		request.onsuccess = () => {
			blockedDeletes.delete(key);
			resolve();
		};
		request.onerror = () => {
			blockedDeletes.delete(key);
			reject(request.error ?? new Error(`Deleting IndexedDB database ${DB_PREFIX + key} failed`));
		};
		// NOTE: read as another tab holding the database open. The spec also fires `blocked` for this
		// page's own connection while it closes with a transaction still running, which the edge
		// node's stop (awaiting `node.stop()` before `close`) should rule out; if the card ever says
		// to close other tabs with none open, wait briefly for `success` here before giving up.
		request.onblocked = () => {
			blockedDeletes.add(key);
			reject(new StoreDeleteBlockedError(key));
		};
	});
}
