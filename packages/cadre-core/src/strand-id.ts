/**
 * strand-id.ts — the only places cadre-core mints a strand id.
 *
 * A strand id is not just a key in the control database: it is the strand's storage
 * scope key (a directory, a LevelDB filename, an IndexedDB database name — whatever
 * the embedder's provider makes of it) and the strand node's libp2p network name,
 * `strand-<id>`, which becomes the protocol prefix `/optimystic/strand-<id>`. It also
 * replicates to every other node in the party, which will turn it into those same
 * names on their own disks.
 *
 * So a generator that emits a shape `isValidStrandScopeKey` rejects does not fail
 * here — it fails later, on a peer, at launch. Minting in one module and asserting the
 * predicate on the way out is what keeps that impossible: a future edit to either shape
 * fails at its own call site rather than on someone else's machine.
 */

import { randomBytes } from '@optimystic/quereus-plugin-crypto';
import { assertStrandScopeKey } from './storage-scope.js';

/**
 * Mint a fresh, unguessable strand id: `strand-` plus 32 hex characters (128 bits).
 *
 * Uses {@link randomBytes} — the same cross-platform CSPRNG `control-database`'s
 * `generateStampId` uses — NOT `crypto.randomUUID` / `Date.now` / `Math.random`, none
 * of which are uniformly available across node/browser/React Native. Unguessability is
 * the point for a responder-provisioned strand: the id is what an invite redemption
 * hands back, so a predictable one would let a third party name a strand before its
 * founder published it.
 */
export function mintStrandId(): string {
	const strandId = `strand-${randomBytes(128, 'hex') as string}`;
	assertStrandScopeKey(strandId);
	return strandId;
}

/**
 * Mint a structural placeholder strand id: `strand-<ms since epoch>-<6 base36 chars>`.
 *
 * For the no-node / no-recorder fallbacks, where the caller needs a well-shaped id an
 * initiator can validate but no strand is actually provisioned. NOT unguessable —
 * `Math.random` is not a CSPRNG — so never use it where {@link mintStrandId}'s
 * unpredictability is load-bearing.
 */
export function mintPlaceholderStrandId(): string {
	const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	assertStrandScopeKey(strandId);
	return strandId;
}
