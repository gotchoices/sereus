import { describe, it, expect } from 'vitest';
import { privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { InMemoryKeyStore, KeyStoreAccessError, DEFAULT_IDENTITY_KEY_ID, type KeyStore } from '../src/key-store.js';
import { loadOrCreateIdentityKey } from '../src/identity-key.js';

describe('loadOrCreateIdentityKey', () => {
	it('generates and persists an Ed25519 key into an empty store (first run)', async () => {
		const store = new InMemoryKeyStore();
		await expect(store.list()).resolves.toEqual([]);

		const key = await loadOrCreateIdentityKey(store);

		expect(key.type).toBe('Ed25519');
		expect(await store.list()).toEqual([DEFAULT_IDENTITY_KEY_ID]);
		expect([...(await store.get(DEFAULT_IDENTITY_KEY_ID))!]).toEqual([...privateKeyToProtobuf(key)]);
	});

	it('honours an explicit slot id', async () => {
		const store = new InMemoryKeyStore();
		await loadOrCreateIdentityKey(store, 'custom/identity-slot');
		expect(await store.list()).toEqual(['custom/identity-slot']);
	});

	it('returns the stored key on a second call without re-persisting', async () => {
		const setCalls: string[] = [];
		const inner = new InMemoryKeyStore();
		const store: KeyStore = {
			get: (id) => inner.get(id),
			set: (id, m) => { setCalls.push(id); return inner.set(id, m); },
			delete: (id) => inner.delete(id),
			list: () => inner.list(),
		};

		const first = await loadOrCreateIdentityKey(store);
		const second = await loadOrCreateIdentityKey(store);

		expect(peerIdFromPrivateKey(second).toString()).toBe(peerIdFromPrivateKey(first).toString());
		expect(setCalls).toEqual([DEFAULT_IDENTITY_KEY_ID]); // persisted exactly once
	});

	it('a rejecting get() propagates and writes nothing (no silent identity loss)', async () => {
		const setCalls: string[] = [];
		const store: KeyStore = {
			get: async (id) => { throw new KeyStoreAccessError(id, 'access denied (biometric cancelled)'); },
			set: async (id) => { setCalls.push(id); },
			delete: async () => {},
			list: async () => [],
		};

		await expect(loadOrCreateIdentityKey(store)).rejects.toBeInstanceOf(KeyStoreAccessError);
		expect(setCalls).toEqual([]);
	});

	it('corrupt bytes in the slot throw rather than regenerate', async () => {
		const store = new InMemoryKeyStore();
		await store.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

		await expect(loadOrCreateIdentityKey(store)).rejects.toThrow();
		// The unreadable slot is left exactly as it was — not overwritten.
		expect([...(await store.get(DEFAULT_IDENTITY_KEY_ID))!]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});
});
