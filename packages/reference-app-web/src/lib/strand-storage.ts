/**
 * strand-storage.ts — per-scope IndexedDB storage for the browser's edge node.
 *
 * cadre-core partitions each network's data by storage scope key: the control network's is
 * `controlStorageScope(partyId)` (`cadre-core/src/storage-scope.ts`), each strand's is its strand
 * id. Every key cadre-core mints is already within `[a-z0-9._-]`, so this module concatenates it
 * into a database name (`sereus-strand-<key>`) without escaping.
 *
 * `IndexedDBRawStorage` wraps an **already-open** `OptimysticWebDBHandle`, and the opener is
 * async, while `EdgeNodeStorage.rawStorage` is synchronous. The platform (`web-edge-platform.ts`)
 * returns cadre-core's `lazyRawStorage` over {@link openStore}, so a scope's database opens on its
 * first use: nothing is opened ahead of a start or an `addStrand`, and a strand the control
 * network lists gets storage like any other. One handle and one `IndexedDBRawStorage` per key,
 * cached here until {@link closeStores} (which the edge node calls on every stop), so two proxies
 * over one scope share a store and diagnostics can read the control database once the node has
 * opened it ({@link getStoreHandle}).
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
const storages = new Map<string, IRawStorage>();
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

/** The `IndexedDBRawStorage` for `key`, over {@link openHandle}'s handle. One per key until {@link closeStores}. */
export async function openStore(key: string): Promise<IRawStorage> {
	const handle = await openHandle(key);
	let storage = storages.get(key);
	if (!storage) {
		storage = new IndexedDBRawStorage(handle);
		storages.set(key, storage);
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

/**
 * Close every open handle and drop the caches: `EdgeNodeStorage.close`. Each storage applies
 * what it still holds before its handle closes; a failure doing so is logged and the rest still
 * close. Waits for an open in flight first, so it cannot land a handle after the clear.
 */
export async function closeStores(): Promise<void> {
	await Promise.allSettled([...opening.values()]);
	const open = [...handles.entries()];
	handles.clear();
	const stores = [...storages.values()];
	storages.clear();
	for (const storage of stores) await closeStorage(storage);
	for (const [, handle] of open) handle.close();
}

async function closeStorage(storage: IRawStorage): Promise<void> {
	try {
		await storage.close?.();
	} catch (err) {
		console.warn('[reference-app-web] closing a raw storage failed:', err);
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
	if (storage) await closeStorage(storage);
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
