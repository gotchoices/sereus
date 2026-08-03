import { describe, it, expect } from 'vitest';
import { generateKeyPair, generateKeyPairFromSeed, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { InMemoryKeyStore, KeyStoreAccessError, DEFAULT_IDENTITY_KEY_ID, type KeyStore } from '../src/key-store.js';
import { loadOrCreateIdentityKey, peerKeySigner } from '../src/identity-key.js';

/**
 * The cross-repo pinned vector. The TURN credential issuer
 * (`ops/docker/turn-credential-issuer/src/self-test.ts`) and both reference-app
 * `ice-config.spec.ts` files pin the identical bytes, so a drift on either side
 * fails a test instead of silently failing to authenticate in production.
 */
const PINNED = {
	seed: new Uint8Array(32).fill(1),
	peerId: '12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5',
	publicKeyB64: 'CAESIIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29c',
	audience: 'https://issuer.example/ice-servers.json',
	issuedAtSec: 1735689600,
	nonce: '00112233445566778899aabbccddeeff',
	signatureB64: '6jvguqhDOhK9ZahdAYb3aYnzz1dJaJBJtVCFcLCWMwCdupTUClWMJzXoS7yujjr7V3XA-htohz-VCl8GQQFcDg',
} as const;

/** The five-line signed message the issuer rebuilds and verifies. */
const PINNED_MESSAGE = [
	'sereus.turn-issuer.v1',
	PINNED.audience,
	PINNED.peerId,
	String(PINNED.issuedAtSec),
	PINNED.nonce,
].join('\n');

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

describe('peerKeySigner', () => {
	it('derives the pinned peer id and public key from the pinned seed', async () => {
		const key = await generateKeyPairFromSeed('Ed25519', PINNED.seed);
		const signer = peerKeySigner(key);

		expect(signer.peerId).toBe(PINNED.peerId);
		expect(signer.publicKeyB64).toBe(PINNED.publicKeyB64);
	});

	it('peerId matches what libp2p itself reports for the key', async () => {
		const key = await generateKeyPair('Ed25519');
		expect(peerKeySigner(key).peerId).toBe(peerIdFromPrivateKey(key).toString());
	});

	it('signs the pinned message to exactly the pinned signature', async () => {
		const key = await generateKeyPairFromSeed('Ed25519', PINNED.seed);
		const signature = await peerKeySigner(key).sign(PINNED_MESSAGE);

		expect(signature).toBe(PINNED.signatureB64);
	});

	it('rejects a non-Ed25519 key (the issuer accepts nothing else)', async () => {
		const key = await generateKeyPair('secp256k1');
		expect(() => peerKeySigner(key)).toThrow(/Ed25519/);
	});
});
