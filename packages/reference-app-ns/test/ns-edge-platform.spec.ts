/**
 * `ns-edge-platform.ts` — the phone's edge-node platform over SQLite: what a phone
 * that ran this app before the edge node finds after the upgrade (its identity,
 * its saved start), and the key store's slot-to-row rules.
 *
 * Real SQL against a real SQLite: Node's built-in `node:sqlite`, behind
 * `@optimystic/db-p2p-storage-ns`'s own `wrapNSPluginDb`, stands in for the
 * NativeScript plugin. Only the opener is replaced, since the plugin needs a
 * device; `SqliteKVStore`, `SqliteRawStorage`, `syncSqliteDb` and
 * `loadOrCreateNSPeerKey` are the package's own, and the edge node is cadre-core's.
 * Each database name maps to one in-memory database for the test, so a close and
 * reopen sees what was written.
 *
 * The edge node's own behaviour (transitions, genesis, joins, the saved start's
 * parsing) is covered by cadre-core's suite; the start, stop and close of this
 * platform's handles are checked by reading, not here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DEFAULT_IDENTITY_KEY_ID, DEFAULT_OWNER_KEY_ID, KeyStoreAccessError } from '@serfab/cadre-core';
import { loadOrCreateNSPeerKey, type OptimysticNSDBHandle } from '@optimystic/db-p2p-storage-ns';
import { createNsEdgeNode, IDENTITY_DB_NAME, nsEdgePlatform } from '../src/ns-edge-platform';

const H = vi.hoisted(() => {
	/** One in-memory database per name, for the life of a test. */
	const databases = new Map<string, DatabaseSync>();

	/**
	 * The two tables of the package's schema that the key store and the node-local
	 * store touch, as `openOptimysticNSDb` creates them.
	 */
	const SCHEMA = [
		'create table if not exists kv (key text primary key, s_val text, b_val blob)',
		'create table if not exists durability_mark (id integer primary key check (id = 1), n integer not null)',
	];


	/** The `@nativescript-community/sqlite` handle surface `wrapNSPluginDb` drives, over `node:sqlite`. Closing it keeps the data. */
	function pluginDb(db: DatabaseSync): unknown {
		const args = (params: ReadonlyArray<unknown> = []): SQLInputValue[] => params as SQLInputValue[];
		return {
			execute: (sql: string, params?: ReadonlyArray<unknown>) => void db.prepare(sql).run(...args(params)),
			get: (sql: string, params?: ReadonlyArray<unknown>) => db.prepare(sql).get(...args(params)),
			select: (sql: string, params?: ReadonlyArray<unknown>) => db.prepare(sql).all(...args(params)),
			close: () => undefined,
		};
	}

	function database(name: string): DatabaseSync {
		let db = databases.get(name);
		if (!db) {
			db = new DatabaseSync(':memory:');
			for (const statement of SCHEMA) db.exec(statement);
			databases.set(name, db);
		}
		return db;
	}

	return { databases, database, pluginDb };
});

vi.mock('@optimystic/db-p2p-storage-ns', async (importOriginal) => {
	const real = await importOriginal<typeof import('@optimystic/db-p2p-storage-ns')>();
	const wrap = real.wrapNSPluginDb as (raw: unknown) => OptimysticNSDBHandle;
	return { ...real, openOptimysticNSDb: async (name: string) => wrap(H.pluginDb(H.database(name))) };
});

// Imported by the platform for `destroyScope` only, which no test here reaches; the
// real module resolves only under the NativeScript bundler.
vi.mock('@nativescript-community/sqlite', () => ({ deleteDatabase: () => false }));

/** The identity database as this app's earlier builds, and the tests, write it. */
async function identityDb(): Promise<OptimysticNSDBHandle> {
	const { openOptimysticNSDb } = await import('@optimystic/db-p2p-storage-ns');
	return openOptimysticNSDb(IDENTITY_DB_NAME);
}

const KEY_BYTES = new Uint8Array([8, 1, 18, 32, 7, 7, 7]);

beforeEach(() => {
	H.databases.clear();
});

describe('a phone upgraded from the build before the edge node', () => {
	it('keeps its peer id: the identity row it saved is the key store identity slot', async () => {
		// `loadOrCreateNSPeerKey` is what wrote every installed phone's identity: protobuf
		// bytes in `b_val` under `peer-private-key`. A different row would mint a new key,
		// and the phone would be a stranger to every cadre it belonged to.
		const saved = await loadOrCreateNSPeerKey(await identityDb());

		const peerId = await createNsEdgeNode().identityPeerId();

		expect(peerId).toBe(saved.publicKey.toString());
	});

	it('keeps its party and its auto-start: the start it saved reads through the edge node', async () => {
		// The record exactly as `start-options.ts` serialized it, under its literal key
		// in `s_val`: no relays, no origin. Read as founded, with no relays.
		const bootstrap = '/ip4/10.0.0.1/tcp/4001/ws/p2p/12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3';
		const record = JSON.stringify({ version: 1, partyId: 'party-x', bootstrapAddrs: [bootstrap], autoStart: true });
		await (await identityDb()).prepare('insert into kv (key, s_val, b_val) values (?, ?, null)').run('start-options', record);

		const start = await createNsEdgeNode().loadSavedStart();

		expect(start).toEqual({ options: { partyId: 'party-x', bootstrapAddrs: [bootstrap], relayAddrs: [] }, autoStart: true });
	});
});

describe('the key store', () => {
	it('refuses a slot whose row holds no key bytes, rather than reading it as empty', async () => {
		// Read as empty, the identity loader would write a fresh key over the row.
		await (await identityDb()).prepare('insert into kv (key, s_val, b_val) values (?, ?, null)').run('peer-private-key', 'text');

		await expect(nsEdgePlatform().keyStore.get(DEFAULT_IDENTITY_KEY_ID)).rejects.toBeInstanceOf(KeyStoreAccessError);
	});

	it('files each slot under its row and lists the slots, none of the node-local records beside them', async () => {
		// The row names are a persistence contract; the listing is how the joined-strand
		// and strand-move records are found again after a relaunch.
		const { keyStore, storage } = nsEdgePlatform();
		await keyStore.set(DEFAULT_IDENTITY_KEY_ID, KEY_BYTES);
		await keyStore.set(DEFAULT_OWNER_KEY_ID, KEY_BYTES);
		await keyStore.set('cadre/joined-strand/strand-1', KEY_BYTES);
		await storage.nodeLocal().set('trusted-owners.party-x', '{}');

		const rows = await (await identityDb()).prepare('select key from kv order by key').all();

		expect(rows.map((row) => row.key)).toEqual([
			'keystore.cadre/joined-strand/strand-1',
			'keystore.cadre/owner',
			'peer-private-key',
			'trusted-owners.party-x',
		]);
		expect((await keyStore.list()).sort()).toEqual(['cadre/identity', 'cadre/joined-strand/strand-1', 'cadre/owner']);
		expect(await keyStore.get(DEFAULT_OWNER_KEY_ID)).toEqual(KEY_BYTES);
	});
});
