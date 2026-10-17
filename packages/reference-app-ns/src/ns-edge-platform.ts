/**
 * ns-edge-platform.ts — the phone's `EdgeNodePlatform`: `@serfab/cadre-core/edge-node`'s
 * `createEdgeNode` over SQLite (`@optimystic/db-p2p-storage-ns` over
 * `@nativescript-community/sqlite`). Everything else — the start and stop transitions, owner
 * genesis, the saved start, joining another cadre, moving strands, acting on a removal — is the
 * edge node's. The NativeScript counterpart of `@serfab/cadre-rn/phone-node`.
 *
 * Two kinds of database:
 *
 * - **`sereus-peer-identity`**, one per install: the key store (the identity, the owner key, the
 *   joined-strand and strand-move records) in the `kv` table's `b_val` column, and the edge
 *   node's node-local records (the saved start, the dissolve marker, each party's trusted-owner
 *   anchor, bootstrap peers, enrolled-machine count and strand network state) in its `s_val`
 *   column. It cannot be party-scoped: the party id is read out of it.
 * - **`sereus-<scope>`**, one per cadre-core storage scope: the party's control database and each
 *   strand's, opened on first use and closed by every stop.
 */
import { DEFAULT_IDENTITY_KEY_ID, KeyStoreAccessError, type KeyId, type KeyStore } from '@serfab/cadre-core';
import {
	createEdgeNode,
	lazyRawStorage,
	type EdgeNode,
	type EdgeNodePlatform,
	type EdgeNodeStorage,
	type NodeLocalKv,
} from '@serfab/cadre-core/edge-node';
import {
	DEFAULT_PEER_KEY_NAME,
	openOptimysticNSDb,
	SqliteKVStore,
	SqliteRawStorage,
	syncSqliteDb,
	type OptimysticNSDBHandle,
} from '@optimystic/db-p2p-storage-ns';
import { deleteDatabase } from '@nativescript-community/sqlite';
import { nsDbPath } from './ns-db-path';

/** `EdgeNodeStorage.id`: one app, one node. */
export const NS_STORAGE_ID = 'sereus-ns';

/** The database of the key store and the node-local records: the name phones have held their identity under. */
export const IDENTITY_DB_NAME = 'sereus-peer-identity';

/**
 * `kv` key of the identity slot (`DEFAULT_IDENTITY_KEY_ID`): the row `loadOrCreateNSPeerKey` wrote
 * before the edge node, libp2p protobuf bytes in `b_val`, so a phone keeps its peer id across the
 * upgrade.
 */
export const PEER_KEY_KV_KEY = DEFAULT_PEER_KEY_NAME;

/** `kv` key prefix of every other key-store slot; the slot id follows verbatim. */
export const KEY_STORE_KV_PREFIX = 'keystore.';

/** Database name of a cadre-core storage scope, whose key is already within `[a-z0-9._-]`. */
function scopeDbName(scope: string): string {
	return `sereus-${scope}`;
}

/** The phone's edge node. Called once, at module load of `cadre-phone.ts`. */
export function createNsEdgeNode(): EdgeNode {
	return createEdgeNode(nsEdgePlatform());
}

/** The platform {@link createNsEdgeNode} runs over; its database handles are its own. */
export function nsEdgePlatform(): EdgeNodePlatform {
	const identity = new SharedOpen(openIdentityDb);
	return {
		keyStore: sqliteKeyStore(async () => (await identity.get()).db),
		storage: nsEdgeStorage(identity),
		// Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an ed25519 author
		// key — see `getChatSAppConfig`). Relax the fail-closed schema policy so the demo can form
		// strands. Production nodes must leave this unset.
		configure: (config) => ({ ...config, requireSignedSchemas: false }),
	};
}

// ── The identity database ─────────────────────────────────────────────────────

/** The identity database and the one node-local store over it. */
interface IdentityDb {
	db: OptimysticNSDBHandle;
	/**
	 * Empty prefix, not `SqliteKVStore`'s default `'optimystic:txn:'`: the node-local keys are the
	 * literal `start-options`, `trusted-owners.<partyId>`, … strings this app has always written.
	 */
	kv: SqliteKVStore;
}

async function openIdentityDb(): Promise<IdentityDb> {
	const db = await openOptimysticNSDb(nsDbPath(IDENTITY_DB_NAME));
	return { db, kv: new SqliteKVStore(db, '') };
}

/** The key store slot's `kv` key. A persistence contract: renaming one orphans every installed phone's key. */
function keyStoreKvKey(keyId: KeyId): string {
	return keyId === DEFAULT_IDENTITY_KEY_ID ? PEER_KEY_KV_KEY : KEY_STORE_KV_PREFIX + keyId;
}

/** Above every key that starts with a prefix, in SQLite's binary text order: U+10FFFF is the highest code point. */
const PREFIX_UPPER_BOUND = '\u{10FFFF}';

/**
 * The phone's key store: a cadre-core `KeyStore` over the `kv` table's `b_val` column, the column
 * `loadOrCreateNSPeerKey` uses (`SqliteKVStore` uses only `s_val`). A row whose `b_val` is not
 * bytes is reported as `KeyStoreAccessError`, never as an empty slot, which the identity loader or
 * owner genesis would fill with a new key. Each write is followed by a synced commit, as the
 * identity write always was: a key may found a party, and one lost to a power cut after that
 * would leave the party with an owner nobody holds.
 *
 * NOTE: plaintext, as the identity already was. The owner key and the strand-move records now
 * sit in the same unencrypted SQLite file as the identity, and the trusted-owner anchor beside
 * them; whoever adds NativeScript secure storage (Keychain / Keystore) moves the identity, the
 * owner key and the anchor together, since moving one alone protects nothing.
 */
function sqliteKeyStore(open: () => Promise<OptimysticNSDBHandle>): KeyStore {
	const write = async (sql: string, ...params: (string | Uint8Array)[]): Promise<void> => {
		const db = await open();
		await db.prepare(sql).run(...params);
		await syncSqliteDb(db);
	};
	return {
		async get(keyId) {
			const key = keyStoreKvKey(keyId);
			const row = await (await open()).prepare('select b_val from kv where key = ?').get(key);
			if (row === undefined) return undefined;
			if (row.b_val instanceof Uint8Array) return row.b_val;
			throw new KeyStoreAccessError(keyId, `The kv key ${key} holds no key bytes`);
		},
		set: (keyId, keyMaterial) =>
			write(
				'insert into kv (key, s_val, b_val) values (?, null, ?) on conflict(key) do update set b_val = excluded.b_val',
				keyStoreKvKey(keyId),
				keyMaterial,
			),
		delete: (keyId) => write('delete from kv where key = ?', keyStoreKvKey(keyId)),
		async list() {
			const db = await open();
			const slots = await db
				.prepare('select key from kv where key >= ? and key < ?')
				.all(KEY_STORE_KV_PREFIX, KEY_STORE_KV_PREFIX + PREFIX_UPPER_BOUND);
			const identity = await db.prepare('select key from kv where key = ?').get(PEER_KEY_KV_KEY);
			const keyIds = slots.map((row) => String(row.key).slice(KEY_STORE_KV_PREFIX.length));
			return identity ? [DEFAULT_IDENTITY_KEY_ID, ...keyIds] : keyIds;
		},
	};
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** A scope's database and the one block store over it. */
interface ScopeDb {
	db: OptimysticNSDBHandle;
	storage: SqliteRawStorage;
}

/**
 * NOTE: `openOptimysticNSDb` opens the native handle and then applies the schema, and does not
 * close the handle if applying the schema throws; a retry then opens a second handle on the same
 * file. Fine while schema application does not fail in practice; if retried opens are ever seen
 * blocking on a leaked handle, the fix belongs in the upstream opener.
 *
 * NOTE: `SqliteRawStorage.listBlockIds` reads every block id into memory before yielding, and runs
 * at node startup and at each peer join. Cost on a large phone database is unmeasured; if either is
 * seen stalling, the upstream statement needs to page.
 */
async function openScopeDb(name: string): Promise<ScopeDb> {
	const db = await openOptimysticNSDb(nsDbPath(name));
	return { db, storage: new SqliteRawStorage(db) };
}

/**
 * The edge node's storage. `rawStorage` hands out a fresh lazy proxy per call over one open per
 * database name (cadre-core asks once per scope per runtime, and again after a strand stops), so
 * every proxy over a scope shares one connection and its prepared statements until `close`.
 * No `trustedOwnerSlot`: the anchor is the node-local record `trusted-owners.<partyId>`, the key
 * this app has always written, beside the identity it qualifies.
 */
function nsEdgeStorage(identity: SharedOpen<IdentityDb>): EdgeNodeStorage {
	const scopes = new Map<string, SharedOpen<ScopeDb>>();
	const scope = (name: string): SharedOpen<ScopeDb> => {
		let open = scopes.get(name);
		if (!open) {
			open = new SharedOpen(() => openScopeDb(name));
			scopes.set(name, open);
		}
		return open;
	};
	return {
		id: NS_STORAGE_ID,
		// `'power-loss'` is what `SqliteBatchBackend` fixes for every SQLite store, stated here
		// because the proxy is read before any open.
		rawStorage: (key) => lazyRawStorage(async () => (await scope(scopeDbName(key)).get()).storage, 'power-loss'),
		async destroyScope(key) {
			const name = scopeDbName(key);
			await closeScopeDb(name, await scopes.get(name)?.take());
			// `false` when there was no such file: absent resolves, as a deleted one does.
			// NOTE: on iOS the plugin removes the main file only, not its `-wal` / `-shm` side files;
			// a clean close has already checkpointed and removed them. If a close that failed (logged
			// above) is ever followed by a database of the same name reading stale pages, delete the
			// side files here too.
			deleteDatabase(nsDbPath(name));
		},
		nodeLocal: () => nodeLocalKv(identity),
		async close() {
			await closeIdentityDb(await identity.take());
			for (const [name, open] of scopes) await closeScopeDb(name, await open.take());
		},
	};
}

/** The node-local store over the identity database, reopened by the first call after a `close`. */
function nodeLocalKv(identity: SharedOpen<IdentityDb>): NodeLocalKv {
	const kv = async (): Promise<SqliteKVStore> => (await identity.get()).kv;
	return {
		get: async (key) => (await kv()).get(key),
		set: async (key, value) => (await kv()).set(key, value),
		delete: async (key) => (await kv()).delete(key),
		flush: async () => (await kv()).flush(),
	};
}

/** Flush and close the node-local store's database. A failure is logged: `EdgeNodeStorage.close` does not reject. */
async function closeIdentityDb(opened: IdentityDb | undefined): Promise<void> {
	if (!opened) return;
	await logFailure(`flushing ${IDENTITY_DB_NAME}`, () => opened.kv.flush());
	await logFailure(`closing ${IDENTITY_DB_NAME}`, () => opened.db.close());
}

/** Apply and sync what the block store still holds, then close its database; failures are logged. */
async function closeScopeDb(name: string, opened: ScopeDb | undefined): Promise<void> {
	if (!opened) return;
	await logFailure(`closing the block store of ${name}`, () => opened.storage.close());
	await logFailure(`closing ${name}`, () => opened.db.close());
}

async function logFailure(what: string, op: () => Promise<void>): Promise<void> {
	try {
		await op();
	} catch (err) {
		console.warn(`[reference-app-ns] ${what} failed:`, err);
	}
}

/**
 * One database's open, shared by every caller until {@link take}. The in-flight promise is
 * cached, not the handle, so two overlapping first uses share one native handle rather than each
 * leaking one, which blocks the next open of that file. A rejected open is forgotten, so the
 * next call retries while the calls that awaited it still get its rejection.
 */
class SharedOpen<T> {
	private opening: Promise<T> | null = null;

	constructor(private readonly open: () => Promise<T>) {}

	get(): Promise<T> {
		if (this.opening) return this.opening;
		const opening = this.open();
		this.opening = opening;
		// The rejection itself reaches every caller awaiting `opening`; this only forgets it.
		void opening.catch(() => {
			if (this.opening === opening) this.opening = null;
		});
		return opening;
	}

	/**
	 * Forget the open, so the next {@link get} opens afresh, and hand back what it opened for the
	 * caller to close; `undefined` when nothing was opened or the open failed (its caller saw why).
	 */
	async take(): Promise<T | undefined> {
		const opening = this.opening;
		this.opening = null;
		return opening ? opening.catch(() => undefined) : undefined;
	}
}
