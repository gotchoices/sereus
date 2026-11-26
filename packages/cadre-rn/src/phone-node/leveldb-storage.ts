/**
 * The phone's `EdgeNodeStorage`: one rn-leveldb database per cadre-core storage scope, named
 * `<storagePrefix><scope>`, holding all of that scope's node storage — its blocks, the node-local
 * records that must survive a restart, its blob pieces and, for a strand, its offline journal; and
 * one more database (`nodeLocalDb`) holding the edge node's node-local records under
 * `nodeLocalKvPrefix`. rn-leveldb holds a lock per name, so one left open fails the next start;
 * `close` is what the edge node calls on every stop so that cannot happen.
 */

import {
	LevelDBKVStore,
	levelDbNodeStorage,
	openOptimysticRNDb,
	type RNLevelDBOpenFn,
	type RNLevelDBWriteBatchCtor,
} from '@optimystic/db-p2p-storage-rn';
import type { IKVStore, NodeStorage, OpenNodeStorage } from '@optimystic/db-p2p';
import type { EdgeNodeStorage, NodeLocalKv, RemovableSlot } from '@serfab/cadre-core/edge-node';

/**
 * `rn-leveldb`, as the app passes it:
 * `{ openFn: (n, c, e) => new LevelDB(n, c, e), WriteBatch: LevelDBWriteBatch, destroy: (name) => LevelDB.destroyDB(name) }`.
 */
export interface LevelDBNative {
	openFn: RNLevelDBOpenFn;
	WriteBatch: RNLevelDBWriteBatchCtor;
	/** rn-leveldb's `LevelDB.destroyDB(name)`: deletes a closed database; throws when it is open. */
	destroy: (name: string) => void;
}

/** The database names this storage opens. Each is a persistence contract: see `PhoneNodeNames`. */
export interface LevelDBStorageNames {
	storagePrefix: string;
	nodeLocalDb: string;
	nodeLocalKvPrefix: string;
}

/** An open rn-leveldb handle, as `openOptimysticRNDb` returns it. */
type LevelDbHandle = ReturnType<typeof openOptimysticRNDb>;

export class LevelDBEdgeStorage implements EdgeNodeStorage {
	/** The storage prefix: two phone nodes over the same prefix would share every database. */
	readonly id: string;
	/** Every database opened, by name, so `close` can close them all. */
	private readonly databases = new Map<string, LevelDbHandle>();
	/**
	 * The one key-value store over the open node-local database. A write resolves into the store's
	 * write group before it reaches the database, so a second store over the same handle would
	 * neither read it back nor flush it. Closed, which flushes it, before the database is.
	 */
	private nodeLocalStore: LevelDBKVStore | null = null;
	/**
	 * Each scope's node storage, by scope.
	 *
	 * **One `levelDbNodeStorage` call per handle, and this memo is what guarantees it.** The call's
	 * block store claims the handle in Optimystic's read-cache pool, so a second call over an open
	 * handle throws outright rather than handing a node a view that cannot see the first's writes.
	 * Every caller for a scope — the node, and `offlineJournal` — therefore gets this one value.
	 */
	private readonly storages = new Map<string, OpenNodeStorage>();

	constructor(
		private readonly leveldb: LevelDBNative,
		private readonly names: LevelDBStorageNames,
		/** The party's trusted-owner anchor, which the phone keeps in its secure store rather than here. */
		private readonly anchorSlot: (partyId: string) => RemovableSlot,
		/** `EdgeNodeStorage.allotmentBytes`: declared, because LevelDB reports no free space. */
		readonly allotmentBytes: number,
	) {
		this.id = names.storagePrefix;
	}

	/**
	 * All of the scope's storage over the scope's own database. Synchronous throughout — the handle
	 * and the three stores are all opened by constructors that touch nothing yet — so two concurrent
	 * first asks for one scope cannot both reach the one-call-per-handle rule above.
	 */
	async nodeStorage(scope: string): Promise<NodeStorage> {
		return this.scopeStorage(scope);
	}

	/**
	 * The scope's own key-value store, not a second one over its handle: Optimystic lists the
	 * journal's key prefix in `NODE_KV_NAMESPACES` so one store serves both, and two stores over one
	 * handle do not see each other's unflushed writes.
	 */
	async offlineJournal(scope: string): Promise<IKVStore> {
		return this.scopeStorage(scope).kv;
	}

	/** rn-leveldb's `destroyDB` throws on an open database, so this storage's own handle on it closes first. */
	async destroyScope(scope: string): Promise<void> {
		const name = this.names.storagePrefix + scope;
		const storage = this.storages.get(scope);
		this.storages.delete(scope);
		const db = this.databases.get(name);
		this.databases.delete(name);
		try {
			// Commits what the key-value store holds and releases the block store's cache-pool claim,
			// which is what lets a relaunch of this scope open the handle and call the factory again.
			await storage?.close();
		} finally {
			await db?.close();
		}
		this.leveldb.destroy(name);
	}

	nodeLocal(): NodeLocalKv {
		this.nodeLocalStore ??= new LevelDBKVStore(this.database(this.names.nodeLocalDb), this.names.nodeLocalKvPrefix);
		return this.nodeLocalStore;
	}

	trustedOwnerSlot(partyId: string): RemovableSlot {
		return this.anchorSlot(partyId);
	}

	async close(): Promise<void> {
		const store = this.nodeLocalStore;
		this.nodeLocalStore = null;
		const storages = [...this.storages.values()];
		this.storages.clear();
		const open = [...this.databases.values()];
		this.databases.clear();
		if (store) await closeLogged('the node-local store', store);
		// Node storage before handles: each commits what its stores hold and releases its cache-pool
		// claim, which a closed handle would make impossible.
		for (const storage of storages) await closeLogged('a scope\'s node storage', storage);
		for (const db of open) await closeLogged('a database', db);
	}

	/** The scope's node storage, opening its database and its three stores on first use. */
	private scopeStorage(scope: string): OpenNodeStorage {
		let storage = this.storages.get(scope);
		if (!storage) {
			storage = levelDbNodeStorage(this.database(this.names.storagePrefix + scope));
			this.storages.set(scope, storage);
		}
		return storage;
	}

	/** The open database of this name, opening it on first use: one native handle per name. */
	private database(name: string): LevelDbHandle {
		let db = this.databases.get(name);
		if (!db) {
			const { openFn, WriteBatch } = this.leveldb;
			db = openOptimysticRNDb({ openFn, WriteBatch, name });
			this.databases.set(name, db);
		}
		return db;
	}
}

/** {@link LevelDBEdgeStorage.close}'s rule: a failure closing one is logged and the rest still close. */
async function closeLogged(what: string, closable: { close(): Promise<void> }): Promise<void> {
	try {
		await closable.close();
	} catch (err) {
		console.warn(`[cadre-rn/phone-node] closing ${what} failed:`, err);
	}
}
