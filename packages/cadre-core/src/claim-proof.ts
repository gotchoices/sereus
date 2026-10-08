/**
 * Claim proof: how the first seed delivered to a brand-new node proves that its sender
 * holds the node's one-time claim secret.
 *
 * A node that belongs to nobody yet (a cadre-host child before its owner scans the QR
 * code) has an empty trusted-owner anchor, so every seed trust policy refuses its first
 * seed. The claim secret is the out-of-band channel that breaks the deadlock: the host
 * mints 32 random bytes, shows them beside the node's addresses, and the owner's phone
 * proves possession by sending, next to the seed, an HMAC keyed by those bytes.
 *
 * The proof is `base64url(HMAC-SHA256(secret, utf8(canonicalJson(payload))))` where
 * `payload` is `{ purpose: 'sereus-node-claim', v: 1, nodePeerId, signerKey, seedDigest }`:
 *
 *  - `nodePeerId` binds the proof to one node, so a captured proof cannot claim another
 *    node minted with the same secret;
 *  - `signerKey` binds it to one owner, so it cannot anchor a different key;
 *  - `seedDigest` (the same digest the seed signature covers, `seedDigest()` in
 *    `seed-bootstrap.ts`) binds it to one seed, so it cannot be reattached to another.
 *
 * A passive observer of one delivery therefore learns a proof that is useless anywhere
 * else, and useless on this node once it is claimed. A keyed MAC is the standard way to
 * prove possession of a secret without revealing it; the crypto plugin's framed
 * `digest([...])` helper is not specified as one, so the secret is never fed to it.
 *
 * Verified by `claimSecretTrustPolicy` (`seed-trust-policy.ts`). Imports only
 * `@noble/hashes`, `uint8arrays` and `canonical-json.ts`: this module loads on React
 * Native and in the browser as well as Node.
 */
import debug from 'debug';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { canonicalJson } from './canonical-json.js';
import type { SeedRefusalCode } from './types.js';

const log = debug('sereus:cadre:claim-proof');

/** Length of a claim secret: 256 bits, so guessing one is infeasible. */
export const CLAIM_SECRET_BYTES = 32;

/**
 * Thrown by `CadreNode.claimNode` when the node answered the claim seed with a refusal.
 * Distinct from `PeerUnreachableError` (no connection to the node formed) and from a
 * failure after the node was reached (thrown by `deliverSeed` as is): here the node was
 * reached and said no. `code` is the node's machine-readable cause
 * when its policy supplied one (`already-claimed`, `claim-proof-invalid`, ...), so a
 * phone can tell "someone else owns it" from "wrong secret" without parsing `reason`.
 */
export class ClaimRefusedError extends Error {
	constructor(
		readonly nodePeerId: string,
		readonly reason: string,
		readonly code?: SeedRefusalCode,
	) {
		super(`Node ${nodePeerId} refused the claim${code ? ` (${code})` : ''}: ${reason}`);
		this.name = 'ClaimRefusedError';
	}
}

/**
 * Decode a claim secret from the base64url text the host shows and the phone scans.
 *
 * Refuses anything that is not base64url of exactly {@link CLAIM_SECRET_BYTES} bytes,
 * naming the problem. The rejected value is never echoed: unlike a public key, a
 * mistyped secret may still be a secret.
 *
 * @returns The 32 secret bytes.
 */
export function parseClaimSecret(text: string): Uint8Array {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new Error('A claim secret is required (received an empty or whitespace-only value)');
	}

	let decoded: Uint8Array;
	try {
		decoded = uint8ArrayFromString(trimmed, 'base64url');
	} catch (error) {
		throw new Error('A claim secret must be base64url text (the value could not be decoded as base64url)', { cause: error });
	}

	if (decoded.length !== CLAIM_SECRET_BYTES) {
		throw new Error(`A claim secret must decode to exactly ${CLAIM_SECRET_BYTES} bytes (the value decoded to ${decoded.length})`);
	}
	return decoded;
}

/** The HMAC tag bytes over the canonical claim payload (see the module doc). */
function claimProofBytes(secret: Uint8Array, nodePeerId: string, signerKey: string, seedDigest: string): Uint8Array {
	const payload = canonicalJson({ purpose: 'sereus-node-claim', v: 1, nodePeerId, signerKey, seedDigest });
	return hmac(sha256, secret, new TextEncoder().encode(payload));
}

/**
 * Compute the claim proof the owner side sends beside its seed.
 *
 * @param secret - The parsed 32-byte claim secret ({@link parseClaimSecret}).
 * @param nodePeerId - The peer id of the node being claimed.
 * @param signerKey - The owner key that signed the seed (base64url).
 * @param seedDigest - The seed's signature digest (`seedDigest()` in `seed-bootstrap.ts`).
 * @returns The proof, base64url.
 */
export function claimProof(secret: Uint8Array, nodePeerId: string, signerKey: string, seedDigest: string): string {
	return uint8ArrayToString(claimProofBytes(secret, nodePeerId, signerKey, seedDigest), 'base64url');
}

/**
 * Check a presented proof against the receiver's own view of the three bound fields.
 *
 * Recomputes the tag and compares in constant time. A proof that does not decode as
 * base64url is simply invalid. `nodePeerId` must be the RECEIVER's own peer id, never
 * one the sender supplied; that is what makes a captured proof useless elsewhere.
 */
export function verifyClaimProof(
	secret: Uint8Array,
	nodePeerId: string,
	signerKey: string,
	seedDigest: string,
	proof: string,
): boolean {
	let presented: Uint8Array;
	try {
		presented = uint8ArrayFromString(proof, 'base64url');
	} catch (error) {
		log('claim proof is not base64url: %o', error);
		return false;
	}
	return constantTimeEqual(presented, claimProofBytes(secret, nodePeerId, signerKey, seedDigest));
}

/**
 * Byte equality whose running time does not depend on WHERE the arrays differ, so a
 * remote cannot learn a valid proof prefix from response timing. The length check
 * short-circuits, which leaks nothing: a valid proof's length is public. A plain loop
 * rather than `node:crypto`'s `timingSafeEqual` because this module must load on React
 * Native and in the browser.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i]! ^ b[i]!;
	}
	return diff === 0;
}
