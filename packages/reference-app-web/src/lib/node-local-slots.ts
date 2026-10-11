/**
 * node-local-slots.ts — `DurableSlot` factory over the node-local database's
 * `kv` IndexedDB object store, for the browser's node-local records: the
 * trusted-owner anchor (`@serfab/cadre-core/trusted-owner-store`), the
 * cold-start bootstrap-peer store (`@serfab/cadre-core/bootstrap-peer-store`),
 * the enrolled-machine count (`@serfab/cadre-core/enrolled-machine-store`) and
 * the strand network state, each under its own key, per party.
 *
 * Every record goes in the SAME database as the tab's Ed25519 identity and
 * start record (`strand-storage.ts`'s `NODE_LOCAL_STORE_KEY` database, `kv` store) —
 * not a separate one. The decisive property is shared fate: "Clear site data"
 * must wipe identity, anchor, and dial targets together so the tab cold-starts
 * as a genuinely fresh node, rather than leaving a half-cleared state where a
 * regenerated identity inherits a stale anchor, or a retained identity loses
 * its anchor silently. See `cadre-web.ts` (`startCadre`) for the wiring.
 *
 * That database is NOT cadre-core's control block store, which is keyed by party
 * id (`controlStorageScope`). These records are read BEFORE the party id is known
 * — the party id itself is one of them — so they cannot live behind a name derived
 * from it. Each record is filed under `<key>.<partyId>` ({@link partyKvKey}), as the
 * phone kit files its records, because a tab that joins another cadre switches
 * party and comes back to the one it founded if the join fails: one key per tab
 * would have the first save in the joined party overwrite the founded party's
 * records. Each record also carries its own `partyId` and fails closed on a
 * mismatch, which is what keeps the shared database from re-introducing the
 * cross-party bleed the block-store scoping fixed. Records under the old,
 * party-less keys are orphaned, unread (development builds only; no compatibility).
 */
import type { DurableSlot } from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';

/** `kv` key stem for the persisted trusted-owner anchor snapshot. */
export const TRUSTED_OWNERS_KV_KEY = 'trusted-owners';

/** `kv` key stem for the persisted bootstrap-peer (cold-start dial target) snapshot. */
export const BOOTSTRAP_PEERS_KV_KEY = 'bootstrap-peers';

/**
 * `kv` key stem for the persisted strand network state — per strand, the FRET routing
 * table its strand node saved, re-imported after a reload. Not trust-bearing: FRET
 * verifies each address record at import.
 */
export const STRAND_NETWORK_KV_KEY = 'strand-network';

/**
 * `kv` key stem for the tab's last-known enrolled-machine count — the control
 * network's block-repair yardstick, read back at the next launch because the
 * control node is built before the database holding the membership rows exists.
 */
export const ENROLLED_MACHINES_KV_KEY = 'enrolled-machines';

/** Every per-party record's key stem, so a party's records can be found and removed together. */
export const PARTY_KV_KEYS: readonly string[] = [
	TRUSTED_OWNERS_KV_KEY,
	BOOTSTRAP_PEERS_KV_KEY,
	ENROLLED_MACHINES_KV_KEY,
	STRAND_NETWORK_KV_KEY,
];

/**
 * The `kv` key of one party's record: `<key>.<partyId>`. A party id is arbitrary
 * text, but IndexedDB keys are strings of any content, so it needs no encoding. The
 * tab's own one-per-tab records (the start record, the identity) use dot-free keys,
 * which keeps them clear of every per-party key.
 */
export function partyKvKey(key: string, partyId: string): string {
	return `${key}.${partyId}`;
}

/**
 * A `DurableSlot` over one `kv` key of the node-local database. The `kv` store's
 * value type is `string | Uint8Array`; `DurableSlot` deals in text only, so a
 * non-string value is a corrupt slot and is treated the same as absent (the
 * loader — `node-local-snapshot.ts` for the two snapshot records,
 * `enrolled-machine-store.ts` for the count — then cold-starts empty).
 *
 * NOTE: two same-origin tabs open the same IndexedDB database and each
 * snapshot-writes its own full view on `save`, so the last writer wins and the
 * other tab's newly-recorded entries (a bootstrap peer, a trust anchor) can be
 * dropped. Acceptable — re-seeding refills them — but real; see the ticket
 * `2.1-web-durable-node-local-stores` for the fuller rationale. The same two tabs
 * share the start record too: a join in one switches the other only on its next load.
 */
export function kvSlot(handle: OptimysticWebDBHandle, key: string): DurableSlot {
	return {
		async load() {
			const raw = await handle.get('kv', key);
			return typeof raw === 'string' ? raw : undefined;
		},
		async save(text) {
			await handle.put('kv', text, key);
		},
	};
}
