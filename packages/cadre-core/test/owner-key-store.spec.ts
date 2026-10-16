import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { InMemoryKeyStore, DEFAULT_OWNER_KEY_ID } from '../src/key-store.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { createOwnerKey, importOwnerKey, loadOwnerSigner, readOwnerPrivateKey, OwnerKeySlotOccupiedError } from '../src/owner-key-store.js';

/** Losing the key in the owner slot loses the user's ownership of every cadre that lists it, so nothing may replace it. */
describe('owner-key slot', () => {
	it('never replaces its key: create refuses, importing the same key changes nothing, importing another refuses', async () => {
		const store = new InMemoryKeyStore();
		await expect(loadOwnerSigner(store)).resolves.toBeUndefined();
		const created = await createOwnerKey(store);
		const stored = await store.get(DEFAULT_OWNER_KEY_ID);

		await expect(createOwnerKey(store)).rejects.toBeInstanceOf(OwnerKeySlotOccupiedError);
		const privateKeyB64 = (await readOwnerPrivateKey(store))!;
		expect((await importOwnerKey(store, privateKeyB64)).publicKey).toBe(created.publicKey);
		const other = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519')).privateKeyB64;
		await expect(importOwnerKey(store, other)).rejects.toBeInstanceOf(OwnerKeySlotOccupiedError);

		expect(await store.get(DEFAULT_OWNER_KEY_ID)).toEqual(stored);
		expect((await loadOwnerSigner(store))!.publicKey).toBe(created.publicKey);

		// The exported seed, imported on another device, is the same owner key.
		const elsewhere = new InMemoryKeyStore();
		await importOwnerKey(elsewhere, privateKeyB64);
		expect((await loadOwnerSigner(elsewhere))!.publicKey).toBe(created.publicKey);
	});
});
