/**
 * The phone's `EdgeNodeStorage`: one rn-leveldb database per cadre-core storage scope, named
 * `<storagePrefix><scope>`, holding the scope's blocks and, for a strand, its offline journal; and
 * one more (`nodeLocalDb`) holding the node-local records under `nodeLocalKvPrefix`. rn-leveldb
 * holds a lock per name, so one left open fails the next start; `close` is what the edge node
 * calls on every stop so that cannot happen.
 */

import {
	LevelDBKVStore,
	LevelDBRawStorage,
	openOptimysticRNDb,
	type RNLevelDBOpenFn,
	type RNLevelDBWriteBatchCtor,
} from '@optimystic/db-p2p-storage-rn';
import type { IKVStore, IRawStorage } from '@optimystic/db-p2p';
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
	/** Each strand scope's offline journal, by scope: one store per handle, as {@link nodeLocalStore} is. */
	private readonly journals = new Map<string, LevelDBKVStore>();

	constructor(
		private readonly leveldb: LevelDBNative,
		private readonly names: LevelDBStorageNames,
		/** The party's trusted-owner anchor, which the phone keeps in its secure store rather than here. */
		private readonly anchorSlot: (partyId: string) => RemovableSlot,
	) {
		this.id = names.storagePrefix;
	}

	rawStorage(scope: string): IRawStorage {
		return new LevelDBRawStorage(this.database(this.names.storagePrefix + scope));
	}

	/**
	 * Over the scope's database, whose key-value keys are tagged apart from its blocks', under the
	 * store's default key prefix, as the browser's journal is.
	 */
	async offlineJournal(scope: string): Promise<IKVStore> {
		let journal = this.journals.get(scope);
		if (!journal) {
			journal = new LevelDBKVStore(this.database(this.names.storagePrefix + scope));
			this.journals.set(scope, journal);
		}
		return journal;
	}

	/** rn-leveldb's `destroyDB` throws on an open database, so this storage's own handle on it closes first. */
	async destroyScope(scope: string): Promise<void> {
		const name = this.names.storagePrefix + scope;
		const journal = this.journals.get(scope);
		this.journals.delete(scope);
		const db = this.databases.get(name);
		this.databases.delete(name);
		try {
			await journal?.close();
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
		const journals = [...this.journals.values()];
		this.journals.clear();
		const open = [...this.databases.values()];
		this.databases.clear();
		if (store) await closeLogged('the node-local store', store);
		for (const journal of journals) await closeLogged('an offline journal', journal);
		for (const db of open) await closeLogged('a database', db);
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
