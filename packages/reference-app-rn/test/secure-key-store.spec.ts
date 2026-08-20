import { describe, it, expect, vi } from 'vitest';
import { KeyStoreAccessError, DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import { SecureStoreKeyStore, type SecureStoreKeyStoreOptions } from '../src/secure-key-store';
import { FakeSecureStore, INDEX_KEY } from './fake-secure-store';

function makeStore(options?: SecureStoreKeyStoreOptions): { store: SecureStoreKeyStore; fake: FakeSecureStore } {
	const fake = new FakeSecureStore();
	return { store: new SecureStoreKeyStore(fake, options), fake };
}

/** Content-wise byte comparison. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
	return !!a && a.length === b.length && [...a].every((v, i) => v === b[i]);
}

// ── KeyStore contract suite (mirrors cadre-core's parametrized contract) ───────

describe('SecureStoreKeyStore — KeyStore contract', () => {
	it('round-trips set → get with identical bytes', async () => {
		const { store } = makeStore();
		const material = new Uint8Array([1, 2, 3, 250, 0, 128, 255]);
		await store.set(DEFAULT_IDENTITY_KEY_ID, material);
		expect(sameBytes(await store.get(DEFAULT_IDENTITY_KEY_ID), material)).toBe(true);
	});

	it('returns undefined (not a throw) for a missing slot', async () => {
		const { store } = makeStore();
		await expect(store.get('cadre/absent')).resolves.toBeUndefined();
	});

	it('overwrites a slot silently on a second set', async () => {
		const { store } = makeStore();
		await store.set('k', new Uint8Array([1, 1, 1]));
		await store.set('k', new Uint8Array([9, 8, 7, 6]));
		expect(sameBytes(await store.get('k'), new Uint8Array([9, 8, 7, 6]))).toBe(true);
	});

	it('isolates stored bytes from later mutation of the caller buffer', async () => {
		const { store } = makeStore();
		const material = new Uint8Array([5, 6, 7]);
		await store.set('k', material);
		material[0] = 99; // mutate after set
		expect(sameBytes(await store.get('k'), new Uint8Array([5, 6, 7]))).toBe(true);
	});

	it('delete removes a slot and is idempotent on an absent slot', async () => {
		const { store } = makeStore();
		await store.set('k', new Uint8Array([1]));
		await store.delete('k');
		await expect(store.get('k')).resolves.toBeUndefined();
		await expect(store.delete('k')).resolves.toBeUndefined();
		await expect(store.delete('never-existed')).resolves.toBeUndefined();
	});

	it('list reflects exactly the slots written and removed', async () => {
		const { store } = makeStore();
		await expect(store.list()).resolves.toEqual([]);
		await store.set('a', new Uint8Array([1]));
		await store.set('b', new Uint8Array([2]));
		await store.set('c', new Uint8Array([3]));
		expect((await store.list()).sort()).toEqual(['a', 'b', 'c']);
		await store.delete('b');
		expect((await store.list()).sort()).toEqual(['a', 'c']);
	});

	it('round-trips awkward keyIds (slashes, spaces, unicode, reserved chars) without collision', async () => {
		const { store } = makeStore();
		const awkward: Array<[string, Uint8Array]> = [
			['cadre/identity', new Uint8Array([10])],
			['with space and #hash', new Uint8Array([20])],
			['unicode-Ω-✓-é', new Uint8Array([30])],
			['star*colon:lt<gt>pipe|q?', new Uint8Array([40])],
			['a/b/c/nested', new Uint8Array([50])],
		];
		for (const [id, mat] of awkward) await store.set(id, mat);
		for (const [id, mat] of awkward) expect(sameBytes(await store.get(id), mat)).toBe(true);
		expect((await store.list()).sort()).toEqual(awkward.map(([id]) => id).sort());
	});
});

// ── Byte ↔ base64 bridge fidelity ─────────────────────────────────────────────

describe('SecureStoreKeyStore — base64 byte bridge', () => {
	it('round-trips the full 0..255 byte range (protobuf-representative)', async () => {
		const { store } = makeStore();
		const material = Uint8Array.from({ length: 256 }, (_, i) => i);
		await store.set('cadre/identity', material);
		expect(sameBytes(await store.get('cadre/identity'), material)).toBe(true);
	});

	it('stores material as a string distinct from the raw bytes (text backend)', async () => {
		const { store, fake } = makeStore();
		await store.set('cadre/identity', new Uint8Array([0, 255, 16, 32]));
		const [matKey] = fake.materialKeys();
		expect(typeof fake.map.get(matKey)).toBe('string');
		expect(fake.map.get(matKey)).not.toBe('');
	});
});

// ── KeyId → SecureStore-key mapping ───────────────────────────────────────────

describe('SecureStoreKeyStore — keyId mapping', () => {
	const ALLOWED = /^[A-Za-z0-9._-]+$/; // expo-secure-store's permitted key charset

	it('every mapped SecureStore key (and the index key) uses only allowed chars', async () => {
		const { store, fake } = makeStore();
		const ids = ['cadre/identity', 'with space', 'unicode-Ω', 'star*:|?', 'a/b/c'];
		for (const id of ids) await store.set(id, new Uint8Array([1]));
		for (const key of fake.map.keys()) {
			expect(key, `key ${JSON.stringify(key)} must be SecureStore-safe`).toMatch(ALLOWED);
		}
	});

	it('maps distinct keyIds to distinct SecureStore keys (no collision)', async () => {
		const { store, fake } = makeStore();
		const ids = ['cadre/identity', 'cadre.identity', 'cadre_identity', 'a/b', 'a.b'];
		for (const id of ids) await store.set(id, new Uint8Array([1]));
		expect(fake.materialKeys().length).toBe(ids.length);
		expect(new Set(fake.materialKeys()).size).toBe(ids.length);
	});

	it('maps the default identity slot deterministically across instances', async () => {
		const a = makeStore();
		const b = makeStore();
		await a.store.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([1]));
		await b.store.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([1]));
		expect(a.fake.materialKeys()).toEqual(b.fake.materialKeys());
		expect(a.fake.materialKeys()[0]).toMatch(ALLOWED);
	});
});

// ── Access-denied vs absence ──────────────────────────────────────────────────

describe('SecureStoreKeyStore — access vs absence', () => {
	it('a thrown getItemAsync (cancelled biometric) raises KeyStoreAccessError, not undefined', async () => {
		const { store, fake } = makeStore();
		await store.set('cadre/identity', new Uint8Array([1, 2, 3]));
		// Force the material read to throw, simulating a denied/cancelled prompt.
		for (const key of fake.materialKeys()) fake.throwOnGet.add(key);

		const result = store.get('cadre/identity');
		await expect(result).rejects.toBeInstanceOf(KeyStoreAccessError);
		await expect(result).rejects.toMatchObject({ keyId: 'cadre/identity' });
	});

	it('corrupt (non-base64) stored material raises KeyStoreAccessError, not truncated bytes or undefined', async () => {
		const { store, fake } = makeStore();
		await store.set('cadre/identity', new Uint8Array([1, 2, 3]));
		// Overwrite the stored text with a value that is not valid base64. A silent
		// decode would orphan the real key via cadre-core regeneration, so this must
		// surface loudly rather than return undefined/garbage.
		const [matKey] = fake.materialKeys();
		fake.map.set(matKey, '!!! not base64 @@@');

		const result = store.get('cadre/identity');
		await expect(result).rejects.toBeInstanceOf(KeyStoreAccessError);
		await expect(result).rejects.toMatchObject({ keyId: 'cadre/identity' });
	});

	it('forwards construction options to material reads/writes; index never requires auth', async () => {
		const { store, fake } = makeStore({ requireAuthentication: true, keychainAccessible: 7 });
		await store.set('cadre/identity', new Uint8Array([1]));
		const [matKey] = fake.materialKeys();

		expect(fake.setOptionsByKey.get(matKey)).toEqual({ requireAuthentication: true, keychainAccessible: 7 });
		// The index entry holds only keyIds and must read/write without a prompt.
		expect(fake.setOptionsByKey.get(INDEX_KEY)).toEqual({ keychainAccessible: 7 });
		expect(fake.setOptionsByKey.get(INDEX_KEY)).not.toHaveProperty('requireAuthentication');
	});
});

// ── Gated-slot null discriminator (biometric-invalidated vs empty) ─────────────
// For a slot written with requireAuthentication: true, Expo resolves a
// biometric-invalidated entry to `null`, indistinguishable at the entry level from
// a genuinely empty slot. The unauthenticated __index marker disambiguates: keyId
// in the index + material null ⇒ was-present-but-now-unreadable ⇒
// KeyStoreAccessError (fail-closed, no regeneration); keyId absent ⇒ genuinely
// empty / first launch ⇒ undefined. Ungated slots keep null ⇒ undefined verbatim.

describe('SecureStoreKeyStore — gated null discriminator', () => {
	const KEY = 'cadre/identity';

	/**
	 * Gated store with KEY set, then its material entry wiped while the __index
	 * marker is left intact — the on-device shape of a biometric-invalidated gated
	 * slot (Expo reads the entry as null, but the unauthenticated index still
	 * records that the slot was written).
	 */
	async function gatedInvalidated(
		options?: SecureStoreKeyStoreOptions,
	): Promise<{ store: SecureStoreKeyStore; fake: FakeSecureStore }> {
		const { store, fake } = makeStore({ requireAuthentication: true, ...options });
		await store.set(KEY, new Uint8Array([1, 2, 3]));
		for (const k of fake.materialKeys()) fake.map.delete(k); // drop material, keep __index
		return { store, fake };
	}

	it('gated + material null + keyId IN index ⇒ KeyStoreAccessError (no silent regeneration)', async () => {
		const { store, fake } = await gatedInvalidated();
		expect(fake.map.has(INDEX_KEY)).toBe(true); // marker survived the invalidation
		expect(fake.materialKeys()).toEqual([]);    // material is gone

		const result = store.get(KEY);
		await expect(result).rejects.toBeInstanceOf(KeyStoreAccessError);
		await expect(result).rejects.toMatchObject({ keyId: KEY });
	});

	it('gated + material null + keyId NOT in index ⇒ undefined (true first launch)', async () => {
		const { store } = makeStore({ requireAuthentication: true });
		await expect(store.get(KEY)).resolves.toBeUndefined();
	});

	it("ungated + material null ⇒ undefined even with the keyId forced into the index (today's behaviour)", async () => {
		const { store, fake } = makeStore(); // ungated default — shipped path
		fake.map.set(INDEX_KEY, JSON.stringify([KEY])); // index says present, but no material
		await expect(store.get(KEY)).resolves.toBeUndefined();
	});

	it('the guard index probe forwards accessibility but never requireAuthentication (no prompt)', async () => {
		const { store, fake } = await gatedInvalidated({ keychainAccessible: 7 });
		await expect(store.get(KEY)).rejects.toBeInstanceOf(KeyStoreAccessError);
		// The guard read the index via indexOptions(): accessibility is forwarded so
		// background reads work, but requireAuthentication must never reach the index.
		expect(fake.getOptionsByKey.get(INDEX_KEY)).toEqual({ keychainAccessible: 7 });
		expect(fake.getOptionsByKey.get(INDEX_KEY)).not.toHaveProperty('requireAuthentication');
	});

	it('gated + index read fails during the guard ⇒ KeyStoreAccessError (fail-closed)', async () => {
		const { store, fake } = await gatedInvalidated();
		fake.throwOnGet.add(INDEX_KEY); // backend error reading the marker
		await expect(store.get(KEY)).rejects.toBeInstanceOf(KeyStoreAccessError);
	});

	it('gated slot deleted cleanly ⇒ undefined (index pruned, genuinely empty)', async () => {
		const { store } = makeStore({ requireAuthentication: true });
		await store.set(KEY, new Uint8Array([9]));
		await store.delete(KEY);
		await expect(store.get(KEY)).resolves.toBeUndefined();
	});

	it('discriminates per keyId across slots sharing one index (written ⇒ throw, never-written ⇒ undefined)', async () => {
		// Two gated slots backed by the single shared __index: KEY was set (so it is
		// recorded) then invalidated (material wiped); OTHER was never set. The guard
		// keys off index.includes(keyId), so the written-but-now-null slot fails closed
		// while the genuinely-empty one returns undefined — proving slots are
		// independent despite the shared marker.
		const OTHER = 'cadre/other';
		const { store, fake } = makeStore({ requireAuthentication: true });
		await store.set(KEY, new Uint8Array([1, 2, 3]));
		for (const k of fake.materialKeys()) fake.map.delete(k); // invalidate KEY, keep index

		await expect(store.get(KEY)).rejects.toBeInstanceOf(KeyStoreAccessError);
		await expect(store.get(OTHER)).resolves.toBeUndefined();
	});
});

// ── Index consistency ─────────────────────────────────────────────────────────

describe('SecureStoreKeyStore — index consistency', () => {
	it('an orphan in the index (material missing) does not break get of other slots', async () => {
		const { store, fake } = makeStore();
		await store.set('real', new Uint8Array([7]));
		// Force an index that references a key whose material was never written.
		fake.map.set(INDEX_KEY, JSON.stringify(['ghost', 'real']));

		await expect(store.get('ghost')).resolves.toBeUndefined(); // no crash
		expect(sameBytes(await store.get('real'), new Uint8Array([7]))).toBe(true);
		expect((await store.list()).sort()).toEqual(['ghost', 'real']);
	});

	it('a corrupt (non-JSON) index reads as empty rather than throwing list()', async () => {
		const { store, fake } = makeStore();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			fake.map.set(INDEX_KEY, '{not json');
			await expect(store.list()).resolves.toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('delete prunes the index', async () => {
		const { store } = makeStore();
		await store.set('a', new Uint8Array([1]));
		await store.set('b', new Uint8Array([2]));
		await store.delete('a');
		expect(await store.list()).toEqual(['b']);
	});

	it('serializes concurrent index writes without losing entries', async () => {
		const { store } = makeStore();
		// Fire without awaiting: a non-serialized read-modify-write would have all
		// three read the empty index and clobber each other (last wins).
		await Promise.all([
			store.set('a', new Uint8Array([1])),
			store.set('b', new Uint8Array([2])),
			store.set('c', new Uint8Array([3])),
		]);
		expect((await store.list()).sort()).toEqual(['a', 'b', 'c']);
	});
});
