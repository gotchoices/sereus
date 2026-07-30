/**
 * `node-local-slots.ts` — the phone's two `DurableSlot` backends for cadre-core's
 * node-local records (`PersistentTrustedOwnerStore`, `PersistentBootstrapPeerStore`).
 *
 * Scope is deliberately narrow. The node-local *store policy* over an arbitrary
 * slot (cold start, corrupt JSON, foreign partyId, discard-all vs drop-entry,
 * synchronous visibility, failed-persist recovery) is owned and covered by
 * `packages/cadre-core/test/node-local-snapshot.spec.ts` against its own fake
 * slot — re-asserting it here would only duplicate it. What this file covers is
 * what the RN app actually owns: the two slots themselves (`secureStoreSlot`,
 * `kvStoreSlot`), the key-shape helpers, and the composition of each real slot
 * with the two node-local stores.
 */
import { describe, it, expect } from 'vitest';
import { PersistentTrustedOwnerStore, PersistentBootstrapPeerStore, DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import { SecureStoreKeyStore } from '../src/secure-key-store';
import { FakeSecureStore, INDEX_KEY } from './fake-secure-store';
import {
	secureStoreSlot,
	kvStoreSlot,
	anchorSlotKey,
	bootstrapPeersKvKey,
	NODE_LOCAL_DB_NAME,
	NODE_LOCAL_KV_PREFIX,
	type KvStoreApi,
} from '../src/node-local-slots';

/**
 * A real Ed25519 peer id, generated once for this fixture — `@libp2p/crypto` and
 * `@libp2p/peer-id` are only transitive deps of `reference-app-rn`, not direct
 * ones, and the bootstrap-peer store's loader runs `peerIdFromString` on every
 * key on reload, so a fixture that must survive a reload has to actually parse.
 */
const REAL_PEER_ID = '12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3';

// ── Fake LevelDBKVStore ─────────────────────────────────────────────────────────
// The expo-secure-store double is shared with `secure-key-store.spec.ts` — see
// `./fake-secure-store`.

class FakeKvStore implements KvStoreApi {
	readonly map = new Map<string, string>();
	getError: Error | null = null;
	setError: Error | null = null;

	async get(key: string): Promise<string | undefined> {
		if (this.getError) throw this.getError;
		return this.map.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		if (this.setError) throw this.setError;
		this.map.set(key, value);
	}
}

// ── secureStoreSlot ───────────────────────────────────────────────────────────

describe('secureStoreSlot', () => {
	it('round-trips save → load through the fake, statelessly', async () => {
		const backend = new FakeSecureStore();
		await secureStoreSlot(backend, 'k').save('hello world');
		// A fresh slot instance, same backing fake: proves the slot itself holds no
		// state, only the fake does.
		expect(await secureStoreSlot(backend, 'k').load()).toBe('hello world');
	});

	it('loads undefined for a never-written key', async () => {
		const backend = new FakeSecureStore();
		expect(await secureStoreSlot(backend, 'never').load()).toBeUndefined();
	});

	it('rejects on a failed read rather than resolving undefined', async () => {
		const backend = new FakeSecureStore();
		backend.getError = new Error('biometric prompt cancelled');
		await expect(secureStoreSlot(backend, 'k').load()).rejects.toThrow('biometric prompt cancelled');
	});

	it('rejects on a failed write rather than resolving', async () => {
		const backend = new FakeSecureStore();
		backend.setError = new Error('SecureStore write failed');
		await expect(secureStoreSlot(backend, 'k').save('text')).rejects.toThrow('SecureStore write failed');
	});

	it('forwards exactly the given options, on both the read and write path', async () => {
		const backend = new FakeSecureStore();
		const slot = secureStoreSlot(backend, 'k', { keychainAccessible: 7 });
		await slot.save('text');
		await slot.load();

		expect(backend.setOptionsByKey.get('k')).toEqual({ keychainAccessible: 7 });
		expect(backend.setOptionsByKey.get('k')).not.toHaveProperty('requireAuthentication');
		expect(backend.getOptionsByKey.get('k')).toEqual({ keychainAccessible: 7 });
		expect(backend.getOptionsByKey.get('k')).not.toHaveProperty('requireAuthentication');
	});

	it('forwards an empty options object when given none, never an explicit undefined field', async () => {
		const backend = new FakeSecureStore();
		await secureStoreSlot(backend, 'k').save('text');
		await secureStoreSlot(backend, 'k').load();

		// `{}` — not `{ requireAuthentication: undefined, keychainAccessible: undefined }`,
		// which the native layer would read as an explicit choice instead of its default.
		expect(backend.setOptionsByKey.get('k')).toEqual({});
		expect(Object.keys(backend.getOptionsByKey.get('k')!)).toEqual([]);
	});

	it('throws at construction for a gated (requireAuthentication) slot', () => {
		const backend = new FakeSecureStore();
		expect(() => secureStoreSlot(backend, 'k', { requireAuthentication: true })).toThrow(
			/requireAuthentication/,
		);
	});
});

// ── kvStoreSlot ───────────────────────────────────────────────────────────────

describe('kvStoreSlot', () => {
	it('round-trips save → load through the fake, statelessly', async () => {
		const kv = new FakeKvStore();
		await kvStoreSlot(kv, 'k').save('hello world');
		expect(await kvStoreSlot(kv, 'k').load()).toBe('hello world');
	});

	it('loads undefined for a never-written key', async () => {
		const kv = new FakeKvStore();
		expect(await kvStoreSlot(kv, 'never').load()).toBeUndefined();
	});

	it('rejects on a failed read rather than resolving undefined', async () => {
		const kv = new FakeKvStore();
		kv.getError = new Error('LevelDB read failed');
		await expect(kvStoreSlot(kv, 'k').load()).rejects.toThrow('LevelDB read failed');
	});

	it('rejects on a failed write rather than resolving', async () => {
		const kv = new FakeKvStore();
		kv.setError = new Error('LevelDB write failed');
		await expect(kvStoreSlot(kv, 'k').save('text')).rejects.toThrow('LevelDB write failed');
	});
});

// ── Key-shape helpers ─────────────────────────────────────────────────────────
// Persistence contracts: renaming one of these silently orphans every installed
// phone's anchor / dial targets rather than failing.

describe('key-shape helpers', () => {
	it('anchorSlotKey stays under its own prefix, distinct from the key store\'s, and SecureStore-safe', () => {
		const key = anchorSlotKey('party/with+special=chars');
		expect(key.startsWith('sereus.anchor.')).toBe(true);
		expect(key.startsWith('sereus.ks.')).toBe(false);
		expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
	});

	it('gives distinct parties distinct keys', () => {
		expect(anchorSlotKey('party-1')).not.toBe(anchorSlotKey('party-2'));
		expect(bootstrapPeersKvKey('party-1')).not.toBe(bootstrapPeersKvKey('party-2'));
	});

	it('bootstrapPeersKvKey is a plain dotted key', () => {
		expect(bootstrapPeersKvKey('p')).toBe('bootstrap-peers.p');
	});

	it('pins the database name and kv prefix', () => {
		expect(NODE_LOCAL_DB_NAME).toBe('sereus-node-local');
		expect(NODE_LOCAL_KV_PREFIX).toBe('sereus:node-local:');
	});
});

// ── The two node-local stores over a real secureStoreSlot ─────────────────────

describe('PersistentTrustedOwnerStore over secureStoreSlot', () => {
	it('persists a trusted owner key across a fresh open() of the same slot', async () => {
		const backend = new FakeSecureStore();
		const key = anchorSlotKey('party-1');

		const first = await PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1');
		await first.trust('owner-key-b64', 'invite');

		const reopened = await PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1');
		expect(reopened.has('owner-key-b64')).toBe(true);
		expect(reopened.all()).toEqual(new Set(['owner-key-b64']));
	});

	it('records the source in the raw persisted envelope', async () => {
		const backend = new FakeSecureStore();
		const key = anchorSlotKey('party-1');

		const store = await PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1');
		await store.trust('owner-key-b64', 'invite');

		const raw = JSON.parse(backend.map.get(key)!) as { owners: Record<string, { source: string }> };
		expect(raw.owners['owner-key-b64']?.source).toBe('invite');
	});

	it('junk text pre-seeded in the slot ⇒ empty store, no throw', async () => {
		const backend = new FakeSecureStore();
		const key = anchorSlotKey('party-1');
		backend.map.set(key, 'not json at all');

		const store = await PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('an envelope carrying a foreign partyId ⇒ empty store', async () => {
		const backend = new FakeSecureStore();
		const key = anchorSlotKey('party-1');
		backend.map.set(key, JSON.stringify({ version: 1, partyId: 'someone-else', owners: { x: { source: 'invite', trustedAt: 1 } } }));

		const store = await PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('a failed read rejects open() rather than cold-starting, and touches nothing', async () => {
		const backend = new FakeSecureStore();
		const key = anchorSlotKey('party-1');
		backend.getError = new Error('biometric prompt cancelled');

		await expect(PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1')).rejects.toThrow(
			'biometric prompt cancelled',
		);
		expect(backend.map.size).toBe(0);
	});

	it('a failed persist rejects trust() but the in-memory trust still stands', async () => {
		const backend = new FakeSecureStore();
		const key = anchorSlotKey('party-1');
		const store = await PersistentTrustedOwnerStore.open(secureStoreSlot(backend, key), 'party-1');
		backend.setError = new Error('SecureStore write failed');

		await expect(store.trust('owner-key-b64', 'invite')).rejects.toThrow('SecureStore write failed');
		expect(store.has('owner-key-b64')).toBe(true);
	});
});

// ── The anchor slot beside the identity key store, in ONE secure store ─────────
// Both live in the same `expo-secure-store` namespace on a real phone (see the
// `ANCHOR_KEY_PREFIX` comment in `node-local-slots.ts`). Asserting the two prefix
// strings differ is not enough: what matters is that the key store's `__index`
// bookkeeping never picks the anchor up, and that neither write clobbers the other.

describe('the anchor slot beside SecureStoreKeyStore', () => {
	it('keeps the anchor out of the key store\'s index and its keys out of list()', async () => {
		const backend = new FakeSecureStore();
		const keyStore = new SecureStoreKeyStore(backend);
		await keyStore.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([1, 2, 3]));

		const anchors = await PersistentTrustedOwnerStore.open(
			secureStoreSlot(backend, anchorSlotKey('party-1')),
			'party-1',
		);
		await anchors.trust('owner-key-b64', 'genesis');

		expect(await keyStore.list()).toEqual([DEFAULT_IDENTITY_KEY_ID]);
		expect(JSON.parse(backend.map.get(INDEX_KEY)!)).toEqual([DEFAULT_IDENTITY_KEY_ID]);
	});

	it('lets identity material and the anchor survive each other\'s writes', async () => {
		const backend = new FakeSecureStore();
		const keyStore = new SecureStoreKeyStore(backend);
		const anchors = await PersistentTrustedOwnerStore.open(
			secureStoreSlot(backend, anchorSlotKey('party-1')),
			'party-1',
		);

		await anchors.trust('owner-key-b64', 'genesis');
		await keyStore.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([1, 2, 3]));
		await anchors.trust('second-owner-b64', 'invite');

		expect([...(await keyStore.get(DEFAULT_IDENTITY_KEY_ID))!]).toEqual([1, 2, 3]);
		const reopened = await PersistentTrustedOwnerStore.open(
			secureStoreSlot(backend, anchorSlotKey('party-1')),
			'party-1',
		);
		expect(reopened.all()).toEqual(new Set(['owner-key-b64', 'second-owner-b64']));
	});
});

// ── The two node-local stores over a real kvStoreSlot ──────────────────────────

describe('PersistentBootstrapPeerStore over kvStoreSlot', () => {
	it('persists a bootstrap peer across a fresh open() of the same slot', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersKvKey('party-1');

		const first = await PersistentBootstrapPeerStore.open(kvStoreSlot(kv, key), 'party-1');
		await first.record(REAL_PEER_ID, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const reopened = await PersistentBootstrapPeerStore.open(kvStoreSlot(kv, key), 'party-1');
		expect([...reopened.all().keys()]).toEqual([REAL_PEER_ID]);
		expect(reopened.all().get(REAL_PEER_ID)?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	it('junk text pre-seeded in the slot ⇒ empty store, no throw', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersKvKey('party-1');
		kv.map.set(key, 'not json at all');

		const store = await PersistentBootstrapPeerStore.open(kvStoreSlot(kv, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('an envelope carrying a foreign partyId ⇒ empty store', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersKvKey('party-1');
		kv.map.set(
			key,
			JSON.stringify({
				version: 1,
				partyId: 'someone-else',
				peers: { [REAL_PEER_ID]: { addrs: ['/ip4/1.2.3.4/tcp/4001/ws'], recordedAt: 1 } },
			}),
		);

		const store = await PersistentBootstrapPeerStore.open(kvStoreSlot(kv, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('a failed read rejects open() rather than cold-starting, and touches nothing', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersKvKey('party-1');
		kv.getError = new Error('LevelDB read failed');

		await expect(PersistentBootstrapPeerStore.open(kvStoreSlot(kv, key), 'party-1')).rejects.toThrow(
			'LevelDB read failed',
		);
		expect(kv.map.size).toBe(0);
	});

	it('a failed persist rejects record()/all() expectations but the in-memory record still stands', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersKvKey('party-1');
		const store = await PersistentBootstrapPeerStore.open(kvStoreSlot(kv, key), 'party-1');
		kv.setError = new Error('LevelDB write failed');

		await expect(store.record(REAL_PEER_ID, ['/ip4/1.2.3.4/tcp/4001/ws'])).rejects.toThrow('LevelDB write failed');
		expect([...store.all().keys()]).toEqual([REAL_PEER_ID]);
	});
});
