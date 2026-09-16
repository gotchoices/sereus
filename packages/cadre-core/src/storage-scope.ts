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
 * THE STRAND ARM OF THAT CHARSET RULE IS NOT YET ENFORCED. The strand scope key is
 * `StrandRow.Id`, and the ids cadre-core itself mints are `strand-<digits>-<base36>`
 * / `strand-<hex>`, which satisfy the charset. But a strand row replicated into the
 * control database by another node in the party carries whatever id THAT node wrote,
 * and nothing validates its shape before `resolveStrandStorage` hands it to the
 * provider. See `tickets/backlog/bug-strand-scope-key-charset-unenforced`.
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
 * A prefix test. Safe as one against the strand ids cadre-core mints, which are
 * `strand-`-prefixed (`strand-formation-manager.ts`, `strand-solicitation.ts`,
 * `control-formation-recorder.ts`) and so can never collide. It is NOT a security
 * boundary: a strand id replicated in from another node is unvalidated text that
 * could begin `control-`, which is one more reason to close the gap the module
 * comment names.
 */
export function isControlStorageScope(scope: string): boolean {
	return scope.startsWith(CONTROL_SCOPE_PREFIX);
}
