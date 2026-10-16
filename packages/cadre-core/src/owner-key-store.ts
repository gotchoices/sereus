/**
 * The owner-key slot: an owner key kept in a {@link KeyStore} slot of its own, apart from the
 * node's identity slot (`docs/architecture.md` → Owner Keys).
 *
 * Unlike the identity slot (`identity-key.ts`), an empty owner slot is never filled on read: an
 * owner key exists because the user made or imported one. Nothing here overwrites a slot that
 * holds anything, since the key in it is what the user's cadres list as an owner.
 *
 * The stored form is the identity slot's: the libp2p protobuf bytes of an Ed25519 private key.
 * Dependency-free beyond `@libp2p/crypto`, so this module is safe in every entry graph.
 *
 * NOTE: each write checks the slot and then sets it, which a `KeyStore` cannot do atomically; two
 * concurrent creates or imports into one slot can both pass the check and the later write wins.
 * Callers run one owner-key action at a time; if one ever can race another, serialize them here.
 */
import { generateKeyPair, generateKeyPairFromSeed, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { DEFAULT_OWNER_KEY_ID, type KeyId, type KeyStore } from './key-store.js';
import { ed25519KeyPairFromLibp2p, requireEd25519PrivateKeyB64 } from './ed25519-key.js';
import { softwareOwnerSigner, type OwnerSigner } from './owner-signer.js';

/** A create or import found the owner slot already holding a key (a different one, for an import). Carries no key material. */
export class OwnerKeySlotOccupiedError extends Error {
	readonly keyId: KeyId;

	constructor(keyId: KeyId, message: string) {
		super(message);
		this.name = 'OwnerKeySlotOccupiedError';
		this.keyId = keyId;
	}
}

/**
 * Generate a fresh owner key and keep it in the slot.
 *
 * @throws {OwnerKeySlotOccupiedError} when the slot holds anything, unreadable bytes included.
 */
export async function createOwnerKey(keyStore: KeyStore, keyId: KeyId = DEFAULT_OWNER_KEY_ID): Promise<OwnerSigner> {
	if (await keyStore.get(keyId) !== undefined) {
		throw new OwnerKeySlotOccupiedError(keyId, `The owner-key slot "${keyId}" already holds a key`);
	}
	const generated = await generateKeyPair('Ed25519');
	await keyStore.set(keyId, privateKeyToProtobuf(generated));
	return softwareOwnerSigner(ed25519KeyPairFromLibp2p(generated).privateKeyB64);
}

/**
 * A signer over the key in the slot, or `undefined` when the slot is empty. Never generates one.
 * A rejected `get` (e.g. `KeyStoreAccessError`) propagates, and bytes that are not an Ed25519
 * private key throw: neither means the slot is empty.
 */
export async function loadOwnerSigner(keyStore: KeyStore, keyId: KeyId = DEFAULT_OWNER_KEY_ID): Promise<OwnerSigner | undefined> {
	const privateKeyB64 = await readOwnerPrivateKey(keyStore, keyId);
	return privateKeyB64 === undefined ? undefined : softwareOwnerSigner(privateKeyB64);
}

/**
 * Keep an imported owner key (its 32-byte Ed25519 seed, base64url) in the slot. Importing the key
 * the slot already holds changes nothing.
 *
 * @throws {OwnerKeySlotOccupiedError} when the slot holds a different key.
 */
export async function importOwnerKey(keyStore: KeyStore, privateKeyB64: string, keyId: KeyId = DEFAULT_OWNER_KEY_ID): Promise<OwnerSigner> {
	const imported = requireEd25519PrivateKeyB64(privateKeyB64, 'owner private key');
	const stored = await readOwnerPrivateKey(keyStore, keyId);
	if (stored !== undefined && stored !== imported) {
		throw new OwnerKeySlotOccupiedError(keyId, `The owner-key slot "${keyId}" already holds a different key`);
	}
	if (stored === undefined) {
		const key = await generateKeyPairFromSeed('Ed25519', uint8ArrayFromString(imported, 'base64url'));
		await keyStore.set(keyId, privateKeyToProtobuf(key));
	}
	return softwareOwnerSigner(imported);
}

/**
 * The slot's private key as a base64url Ed25519 seed, or `undefined` when the slot is empty. For
 * exporting the key (`owner-key-export.ts`); everything else signs through {@link loadOwnerSigner}.
 */
export async function readOwnerPrivateKey(keyStore: KeyStore, keyId: KeyId = DEFAULT_OWNER_KEY_ID): Promise<string | undefined> {
	const bytes = await keyStore.get(keyId);
	if (bytes === undefined) return undefined;
	// A format conversion of the owner key's own stored bytes, not a derivation from the node identity.
	return ed25519KeyPairFromLibp2p(privateKeyFromProtobuf(bytes)).privateKeyB64;
}
