/**
 * storage-scope.ts — the scope keys `CadreNodeConfig.storage.provider` is called with.
 *
 * A provider is a factory cadre-core invokes once per **scope**: once for the control
 * database and once for each strand. A strand's scope key is its strand id (a uuid);
 * the control database's scope key is what this module mints.
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
 * key inside `[A-Za-z0-9._-]` — the invariant embedders already rely on today, because
 * strand ids happen to be uuids.
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
 * `sereus-control-MTExMTExMTEtMjIyMi00MzMzLTg0NDQtNTU1NTU1NTU1NTU1`:
 * ```js
 * atob(key.slice('control-'.length).replace(/-/g, '+').replace(/_/g, '/'))
 * ```
 */
export function controlStorageScope(partyId: string): string {
	return CONTROL_SCOPE_PREFIX + uint8ArrayToString(uint8ArrayFromString(partyId, 'utf8'), 'base64url');
}

/**
 * Whether a scope key names a control database rather than a strand.
 *
 * A prefix test, and safe as one: the only other scope keys cadre-core mints are
 * strand ids, which are uuids, and a uuid never starts with `control-`.
 */
export function isControlStorageScope(scope: string): boolean {
	return scope.startsWith(CONTROL_SCOPE_PREFIX);
}
