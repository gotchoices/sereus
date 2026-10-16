/**
 * The owner signer: the one interface a node's owner signatures go through
 * (`docs/architecture.md` → Owner Keys → The owner signer).
 *
 * cadre-core needs owner signatures, never an owner private key, so a backend that keeps the
 * key where the node cannot read it (a hardware key, a vault behind biometrics) fits the same
 * seam as {@link softwareOwnerSigner}.
 *
 * Imports only `@optimystic/quereus-plugin-crypto` and `uint8arrays`, so it loads on React
 * Native and in the browser.
 */
import { toString as uint8ArrayToString } from 'uint8arrays';
import { sign } from '@optimystic/quereus-plugin-crypto';
import { ed25519PublicKeyFromPrivate, requireEd25519PrivateKeyB64 } from './ed25519-key.js';

/** What a backend that asks the user shows them. */
export interface OwnerSigningRequest {
	/** The cadre the signatures are for. Every owner digest already binds it (`party_id()`); a prompting backend shows it. */
	partyId: string;
	/** What the user is approving, in plain words ("Remove the machine 12D3…", "Add owner key ‹label›"). */
	action: string;
}

/** Signs one message (the raw bytes of an owner digest, e.g. `buildAuthorizationMessage` output); resolves to a base64url Ed25519 signature. */
export type OwnerSign = (message: Uint8Array) => Promise<string>;

/**
 * An owner key the node can ask for signatures.
 *
 * One action, one {@link approve} call, however many rows it signs: the control schema verifies
 * one signature per row, and one owner action writes several (a removal signs the delete and its
 * `Revocation` tombstone; a machine removal signs many). A hardware or biometric backend prompts
 * once per call, as PIV touch caching and the platform vaults' authentication-validity windows
 * allow. Handing the signer every digest up front was declined: each writer reads the stamps it
 * signs inside its write lock, so precomputing them would duplicate each writer's digest
 * construction outside it.
 */
export interface OwnerSigner {
	/** base64url Ed25519 public key — the `OwnerKey.Key` this signer signs for. */
	readonly publicKey: string;
	/**
	 * Run one user-approved action. A backend that prompts does so at most once per call and may
	 * keep the user's presence until `body` settles. Rejects with {@link OwnerSigningDeclinedError}
	 * when the user declines, and with whatever `body` rejects with otherwise.
	 */
	approve<T>(request: OwnerSigningRequest, body: (sign: OwnerSign) => Promise<T>): Promise<T>;
}

/**
 * Run `body` inside the caller's open approval when it passes `sign`, else inside one new
 * approval of `signer` for `request`. An owner write that is sometimes a whole action and
 * sometimes one step of a larger one takes an optional `sign` and goes through this, so the
 * larger action still asks once.
 */
export async function withinOwnerApproval<T>(
	signer: OwnerSigner,
	request: OwnerSigningRequest,
	sign: OwnerSign | undefined,
	body: (sign: OwnerSign) => Promise<T>
): Promise<T> {
	return sign ? await body(sign) : await signer.approve(request, body);
}

/** Thrown by a prompting backend when the user declines or the prompt times out. */
export class OwnerSigningDeclinedError extends Error {
	readonly request: OwnerSigningRequest;

	constructor(request: OwnerSigningRequest, options?: { cause?: unknown }) {
		super(`Owner approval was declined or timed out: ${request.action}`, options);
		this.name = 'OwnerSigningDeclinedError';
		this.request = request;
	}
}

/**
 * An {@link OwnerSigner} over a private key held in memory: never prompts, signs whatever its
 * `approve` body asks. Its signed input is the digest bytes, base64url-encoded, so its signatures
 * are byte-for-byte those of any signer that signs the raw bytes with the same key (Ed25519 is
 * deterministic).
 *
 * @param privateKeyB64 - The owner key's 32-byte Ed25519 seed, base64url.
 * @throws If `privateKeyB64` is not a 32-byte seed in base64url.
 */
export function softwareOwnerSigner(privateKeyB64: string): OwnerSigner {
	const privateKey = requireEd25519PrivateKeyB64(privateKeyB64, 'owner private key');
	const signMessage: OwnerSign = async (message) =>
		sign(uint8ArrayToString(message, 'base64url'), privateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
	return {
		publicKey: ed25519PublicKeyFromPrivate(privateKey),
		async approve<T>(_request: OwnerSigningRequest, body: (sign: OwnerSign) => Promise<T>): Promise<T> {
			return await body(signMessage);
		},
	};
}
