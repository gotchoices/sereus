/**
 * storage-scope.ts — the scope keys `CadreNodeConfig.storage.provider` is called with.
 *
 * A provider is a factory cadre-core invokes once per **scope**: once for the control
 * database and once for each strand. A strand's scope key is its strand id; the control
 * database's scope key is what this module mints.
 *
 * WHY THE CONTROL SCOPE CARRIES THE PARTY ID. The control database holds the party's
 * own records — its strands, owner keys, peers, invitations, revocations. Two parties
 * on one device must therefore not share one control store, or a node started for
 * party B reads party A's rows as if party A had written them for B. Every other
 * party-scoped store in this codebase already knows this: `PersistentTrustedOwnerStore`,
 * `PersistentBootstrapPeerStore` and `PersistentEnrolledMachineStore` each take a
 * `partyId` and fail closed on a mismatch. Putting the party id in the key here means
 * no embedder has to know it belongs there, and none can get it wrong.
 *
 * WHY IT IS ENCODED. A party id is arbitrary text — nothing in cadre-core validates
 * its shape, and the React Native reference app lets a user type one into Settings.
 * Scope keys reach real namespaces unescaped: cadre-cli builds `${config.path}/${scope}`,
 * React Native a LevelDB filename, the browser an IndexedDB database name. A party id
 * containing `/` or `..` would escape the CLI's storage directory. Base64url keeps every
 * key inside `[A-Za-z0-9._-]` — the charset embedders already rely on, and the same
 * encoding the React Native app's `secureStoreKeySegment` uses on a party id for the
 * same reason.
 *
 * THE STRAND ARM OF THAT CHARSET RULE IS ENFORCED HERE. A strand's scope key is
 * `StrandRow.Id`, and a strand row replicated into the control database by another
 * node in the party carries whatever id THAT node wrote. `assertStrandScopeKey`
 * (below) is the check that makes the charset true of strand keys too; it runs
 * unconditionally at the top of `StrandInstanceManager.startStrand`, so no strand id
 * reaches an embedder's provider — or a libp2p protocol prefix — unvalidated. Ids
 * cadre-core mints come from `strand-id.ts`, which is built on the same predicate.
 */

import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

/**
 * Prefix marking a scope key as a control database rather than a strand.
 *
 * Not exported: `controlStorageScope` mints these keys and `isControlStorageScope`
 * recognizes them, which is the whole surface a caller needs.
 */
const CONTROL_SCOPE_PREFIX = 'control-';

/**
 * The storage scope key for a party's control database.
 *
 * Returns `control-` followed by the base64url encoding of `partyId`'s UTF-8 bytes,
 * so the whole key stays within `[A-Za-z0-9._-]` and is safe to use directly as a
 * file name, directory name or database name. See the module comment for why the
 * encoding is load-bearing rather than decorative.
 *
 * To read a party id back off a device — from, say, a LevelDB file named
 * `sereus-control-MTExMTExMTEtMjIyMi00MzMzLTg0NDQtNTU1NTU1NTU1NTU1` — in a browser or
 * Node console, with no dependency on this package:
 * ```js
 * const b64 = key.slice('control-'.length).replace(/-/g, '+').replace(/_/g, '/');
 * new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
 * ```
 * The `TextDecoder` step is not optional: `atob` alone yields one character per BYTE,
 * so a party id with any non-ASCII character in it decodes to mojibake.
 */
export function controlStorageScope(partyId: string): string {
	return CONTROL_SCOPE_PREFIX + uint8ArrayToString(uint8ArrayFromString(partyId, 'utf8'), 'base64url');
}

/**
 * Whether a scope key names a control database rather than a strand.
 *
 * A prefix test, and a sound one: a strand scope key can never begin `control-`,
 * because {@link isValidStrandScopeKey} rejects that prefix and
 * {@link assertStrandScopeKey} runs on every strand launch.
 */
export function isControlStorageScope(scope: string): boolean {
	return scope.startsWith(CONTROL_SCOPE_PREFIX);
}

/**
 * The longest strand scope key accepted.
 *
 * The longest id cadre-core mints is 39 characters (`strand-` plus the 32 hex
 * characters of `randomBytes(128, 'hex')` — 128 BITS, so 16 bytes), so this leaves
 * ample room while keeping a key clear of the 255-BYTE limit every mainstream
 * filesystem puts on one path component. The charset is ASCII, so characters and
 * bytes are the same count here.
 */
const MAX_STRAND_SCOPE_KEY_LENGTH = 128;

/** The charset every scope key stays within — see the module comment. */
const SCOPE_KEY_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a strand id is usable as a storage scope key and as a libp2p network name.
 *
 * A strand id is not minted locally in the general case — a strand row replicates in
 * from another node in the party carrying whatever id THAT node wrote — and both
 * places it lands turn it straight into a name: the embedder's storage provider
 * (a directory under cadre-cli's storage path, a LevelDB filename, an IndexedDB
 * database name) and the strand node's protocol prefix `/optimystic/strand-<id>`.
 *
 * Valid means all of:
 * - non-empty, and at most {@link MAX_STRAND_SCOPE_KEY_LENGTH} characters;
 * - within `[A-Za-z0-9._-]`, so no separator, drive letter, NUL or non-ASCII text;
 * - not `.` or `..`, which the charset admits but every filesystem reads as a
 *   directory rather than a name;
 * - not `control-`-prefixed, which would let a strand's store masquerade as a
 *   party's control database (see {@link isControlStorageScope}).
 */
export function isValidStrandScopeKey(strandId: string): boolean {
	return strandId.length > 0
		&& strandId.length <= MAX_STRAND_SCOPE_KEY_LENGTH
		&& SCOPE_KEY_CHARSET.test(strandId)
		&& strandId !== '.'
		&& strandId !== '..'
		&& !isControlStorageScope(strandId);
}

/**
 * Thrown when a strand id cannot be used as a storage scope key or network name.
 *
 * NOT retryable: the id is a property of the strand row, so every later attempt on
 * the same row fails identically. Callers that poll — `CadreNode.handleStrandAdded`
 * via `StrandWatcher` — suppress the strand rather than scheduling a retry.
 */
export class InvalidStrandIdError extends Error {
	readonly strandId: string;

	constructor(strandId: string) {
		super(
			`Strand id ${JSON.stringify(strandId)} cannot be used as a storage scope key: ` +
			`a strand id must be 1-${MAX_STRAND_SCOPE_KEY_LENGTH} characters within [A-Za-z0-9._-], ` +
			"must not be '.' or '..', and must not begin 'control-'. " +
			'This strand was created by a node that does not mint conforming ids; it cannot be ' +
			'started here, because the id becomes a file, directory or database name.'
		);
		this.name = 'InvalidStrandIdError';
		this.strandId = strandId;
	}
}

/** {@link isValidStrandScopeKey} as an assertion, throwing {@link InvalidStrandIdError}. */
export function assertStrandScopeKey(strandId: string): void {
	if (!isValidStrandScopeKey(strandId)) {
		throw new InvalidStrandIdError(strandId);
	}
}

/**
 * The charset half of the rule on its own, for the CONTROL key.
 *
 * {@link assertStrandScopeKey} cannot serve here: it rejects the `control-` prefix by
 * design. Asserted at the seam that calls the provider (`CadreNode.resolveControlStorage`)
 * rather than inside {@link controlStorageScope}, so the guarantee belongs to the call
 * that hands a key out and not to one particular way of minting one.
 */
export function assertScopeKeyCharset(scope: string): void {
	if (!SCOPE_KEY_CHARSET.test(scope)) {
		throw new Error(
			`Storage scope key ${JSON.stringify(scope)} leaves the [A-Za-z0-9._-] charset ` +
			'embedders rely on to use it directly as a file, directory or database name.'
		);
	}
}
