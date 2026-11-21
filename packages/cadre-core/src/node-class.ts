/**
 * What kind of machine a node runs on, and the stored form of that fact the control network
 * replicates.
 *
 * Two separate vocabularies on purpose. {@link NodeClass} is what an embedder sets and what
 * every reader in this repository reasons about. {@link PublishedProfile} is the older pair of
 * codes the `CadrePeer.Profile` column holds, kept because the control store is the one place
 * backwards compatibility applies (`docs/cadre/control-schema.md` → "Schema versions and
 * migrations"): a column rename cannot be migrated, and a party's machines update one at a
 * time, so an older build's `KnownProfile` check would refuse a value replicated from an
 * updated sibling. This module is the only place the two meet — nothing else writes or
 * compares the stored codes.
 */

/**
 * What kind of machine a node runs on.
 *
 * `'device'` is a phone, laptop or browser running an app: intermittently connected, asleep or
 * closed much of the time. `'server'` is an always-on node — a cadre-host child, a cadre-cli
 * drone, a provider container. Both transact and both store; the class says how reachable the
 * machine is, which is what the defaults derived from it (relay server, hosting unclaimed
 * strands, the FRET profile db-p2p builds the node with) actually turn on.
 *
 * See `docs/cadre/node.md` → "Node classes".
 */
export type NodeClass = 'device' | 'server';

/**
 * The stored form of `CadrePeer.Profile`. Kept as-is for control-store compatibility; it
 * encodes only whether the machine is always on.
 */
export type PublishedProfile = 'transaction' | 'storage';

/** The stored form a machine publishes for whether it is always on. */
export function encodeAlwaysOn(alwaysOn: boolean): PublishedProfile {
	return alwaysOn ? 'storage' : 'transaction';
}

/** Whether the machine that published `stored` is always on; null on a row it has not published. */
export function decodeAlwaysOn(stored: PublishedProfile | null): boolean | null {
	return stored === null ? null : stored === 'storage';
}

/** Whether `value` is a stored `CadrePeer.Profile` the schema's `KnownProfile` check admits. */
export function isPublishedProfile(value: unknown): value is PublishedProfile {
	return value === 'transaction' || value === 'storage';
}
