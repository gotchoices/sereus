/**
 * The tab's key store and node-local store (`node-local-slots.ts`), the two things the browser
 * hands `@serfab/cadre-core/edge-node`'s `createEdgeNode` over its node-local IndexedDB database.
 *
 * Scope is deliberately narrow. The edge node's own policy over a key store and a node-local
 * store (the identity load-or-create rule, owner genesis, the saved start, the four persistent
 * stores' cold start and fail-closed reads) is covered in `packages/cadre-core/test` against its
 * own fakes; re-asserting it here would only duplicate it. What this file covers is what the web
 * owns: the `kv` keys each key-store slot is kept under (a persistence contract: renaming one
 * silently orphans every tab's identity or owner key), the two places the key store could quietly
 * disagree with what cadre-core expects (text under a slot's key, a slot it does not map), and the
 * one branch of the node-local store (a non-string value reads as absent).
 */
import { describe, it, expect } from 'vitest';
import {
	createOwnerKey,
	DEFAULT_IDENTITY_KEY_ID,
	DEFAULT_OWNER_KEY_ID,
	loadOrCreateIdentityKey,
	loadOwnerSigner,
} from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import {
	keyStoreKvKey,
	KEY_STORE_KV_PREFIX,
	nodeLocalKeyStore,
	nodeLocalKv,
	OWNER_KEY_KV_KEY,
	PEER_KEY_KV_KEY,
} from '../src/lib/node-local-slots';

// ── Fake IndexedDB handle ─────────────────────────────────────────────────────
// The two stores only ever call `get`, `put`, `delete` and `getAllKeys` on the `kv` store, and the
// key store's writes go through one `transaction('kv', 'readwrite')`, so a map-backed double
// covers them without a real IndexedDB.

class FakeKvHandle {
	readonly store = new Map<string, string | Uint8Array>();

	async get(_storeName: 'kv', key: string): Promise<string | Uint8Array | undefined> {
		return this.store.get(key);
	}

	async put(_storeName: 'kv', value: string | Uint8Array, key: string): Promise<string> {
		this.store.set(key, value);
		return key;
	}

	async delete(_storeName: 'kv', key: string): Promise<void> {
		this.store.delete(key);
	}

	async getAllKeys(_storeName: 'kv'): Promise<string[]> {
		return [...this.store.keys()];
	}

	/** The one-store write transaction the key store opens; its durability option is not modelled. */
	transaction(_storeName: 'kv', _mode: 'readwrite', _options?: unknown) {
		return {
			store: {
				put: (value: string | Uint8Array, key: string) => this.put('kv', value, key),
				delete: (key: string) => this.delete('kv', key),
			},
			done: Promise.resolve(),
		};
	}
}

// NOTE: the cast is unchecked — `IDBPDatabase` has far more surface than this
// double implements, so the compiler cannot hold the two `kv` signatures
// together. They match `OptimysticWebDB['kv']` (`key: string`,
// `value: string | Uint8Array`) as of db-p2p-storage-web 0.17; if that store's
// key or value type changes, this fake keeps compiling while testing the old
// shape. Pin the two methods against the real type if that ever bites.
function fakeHandle(): { fake: FakeKvHandle; open: () => Promise<OptimysticWebDBHandle> } {
	const fake = new FakeKvHandle();
	return { fake, open: async () => fake as unknown as OptimysticWebDBHandle };
}

// ── The key store ─────────────────────────────────────────────────────────────

describe('nodeLocalKeyStore', () => {
	/**
	 * The `kv` keys are a persistence contract: the identity and owner key under the keys tabs
	 * held before the edge node, so both survive the upgrade; every other slot under one prefix.
	 */
	it('pins the kv key each slot is kept under', () => {
		expect(keyStoreKvKey(DEFAULT_IDENTITY_KEY_ID)).toBe('peer-private-key');
		expect(keyStoreKvKey(DEFAULT_OWNER_KEY_ID)).toBe('owner-private-key');
		expect(keyStoreKvKey('cadre/joined-strand/abc')).toBe('keystore.cadre/joined-strand/abc');
		expect(PEER_KEY_KV_KEY).toBe('peer-private-key');
		expect(OWNER_KEY_KV_KEY).toBe('owner-private-key');
		expect(KEY_STORE_KV_PREFIX).toBe('keystore.');
	});

	it('keeps the owner key as bytes under its own kv key, read back by a fresh store over the database', async () => {
		const { fake, open } = fakeHandle();
		const created = await createOwnerKey(nodeLocalKeyStore(open));

		expect(fake.store.get(OWNER_KEY_KV_KEY)).toBeInstanceOf(Uint8Array);
		expect((await loadOwnerSigner(nodeLocalKeyStore(open)))?.publicKey).toBe(created.publicKey);
	});

	it('loads the identity cadre-core generated through it from the peer key tabs already hold', async () => {
		const { fake, open } = fakeHandle();
		const generated = await loadOrCreateIdentityKey(nodeLocalKeyStore(open));

		expect(fake.store.get(PEER_KEY_KV_KEY)).toBeInstanceOf(Uint8Array);
		expect((await loadOrCreateIdentityKey(nodeLocalKeyStore(open))).publicKey.toString()).toBe(generated.publicKey.toString());
	});

	it('reports text under a slot\'s key as a fault, not an empty slot genesis would fill with a new key', async () => {
		const { fake, open } = fakeHandle();
		fake.store.set(OWNER_KEY_KV_KEY, 'not key bytes');

		await expect(createOwnerKey(nodeLocalKeyStore(open))).rejects.toMatchObject({ name: 'KeyStoreAccessError' });
		expect(fake.store.get(OWNER_KEY_KV_KEY)).toBe('not key bytes');
	});

	// `KeyStoreJoinedStrandStore` and the strand-move records find their slots through `list()`;
	// the node-local records beside them in the same object store are not slots.
	it('lists the mapped slots and the prefixed ones, and nothing else in the kv store', async () => {
		const { fake, open } = fakeHandle();
		const keyStore = nodeLocalKeyStore(open);
		await keyStore.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([1]));
		await keyStore.set('cadre/joined-strand/abc', new Uint8Array([2]));
		fake.store.set('start-options', '{}');
		fake.store.set('trusted-owners.party-1', '{}');

		expect((await keyStore.list()).sort()).toEqual(['cadre/identity', 'cadre/joined-strand/abc']);
		await keyStore.delete('cadre/joined-strand/abc');
		expect(await keyStore.list()).toEqual(['cadre/identity']);
	});
});

// ── The node-local store ──────────────────────────────────────────────────────

describe('nodeLocalKv', () => {
	// `kv` values are `string | Uint8Array`; the edge node's records are text, so a non-string
	// under a record's key is a corrupt record its loader cold-starts from, not a read fault.
	it('reads a non-string value as absent, and text as itself', async () => {
		const { fake, open } = fakeHandle();
		const kv = nodeLocalKv(open);
		fake.store.set('bootstrap-peers.party-1', new Uint8Array([1, 2, 3]));
		await kv.set('start-options', '{"v":1}');

		expect(await kv.get('bootstrap-peers.party-1')).toBeUndefined();
		expect(await kv.get('start-options')).toBe('{"v":1}');
		await kv.delete('start-options');
		expect(await kv.get('start-options')).toBeUndefined();
	});
});
