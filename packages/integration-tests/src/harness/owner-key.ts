/**
 * Test owner keys: generated on their own, never derived from a node's libp2p identity
 * (`docs/architecture.md` → Owner Keys → "Independent of machines").
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import { softwareOwnerSigner } from '@serfab/cadre-core';
import type { OwnerSigner } from '@serfab/cadre-core';

/** An owner key a test holds, as a person would: apart from every machine it runs. */
export interface TestOwnerKey {
	/** base64url Ed25519 public key: the `OwnerKey.Key` value, and what an enrollee pins. */
	publicKey: string;
	/**
	 * The 32-byte Ed25519 seed, base64url. For a scenario that hands the key to another process
	 * or signs a control row by hand ({@link signMessageEd25519}); everything else uses {@link signer}.
	 */
	privateKeyB64: string;
	/** A software signer over the key: what `useOwnerSigner` and a seed service's `ownerSigner` take. */
	signer: OwnerSigner;
}

/** A fresh owner key over random bytes. */
export function createTestOwnerKey(): TestOwnerKey {
	const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
	const signer = softwareOwnerSigner(privateKeyB64);
	return { publicKey: signer.publicKey, privateKeyB64, signer };
}

/**
 * Ed25519-sign the canonical authorization message bytes and return a base64url signature.
 *
 * The control schema's authorization constraints bind the signature to a domain-tagged
 * field vector — ('CadreControl.<Table>', <action>, row fields...) built by
 * `buildAuthorizationMessage` in cadre-core — so an approval verifies only against the
 * one rule it was minted for. The bytes are signed DIRECTLY — no SHA-256 pre-hash and no
 * re-encode, since ed25519 hashes internally and the bytes are already canonical.
 *
 * Synchronous, unlike an {@link OwnerSigner}, so scenarios that insert their own
 * owner-signed control rows (e.g. bespoke `FormationInvite`s) can pass it where a plain
 * `(message) => string` is expected.
 *
 * @param privateKeyB64 - The owner key's 32-byte Ed25519 seed, base64url ({@link TestOwnerKey.privateKeyB64}).
 */
export function signMessageEd25519(message: Uint8Array, privateKeyB64: string): string {
	const signature = ed25519.sign(message, uint8ArrayFromString(privateKeyB64, 'base64url'));
	return uint8ArrayToString(signature, 'base64url');
}
