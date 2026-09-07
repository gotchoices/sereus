/**
 * node-local-slots.ts — `DurableSlot` factory over the `sereus-peer-identity`
 * SQLite database's `kv` table (`SqliteKVStore` from
 * `@optimystic/db-p2p-storage-ns`), for cadre-core's three **node-local**
 * records: the trusted-owner anchor (`PersistentTrustedOwnerStore`), the
 * cold-start bootstrap-peer store (`PersistentBootstrapPeerStore`) and the
 * enrolled-machine count (`PersistentEnrolledMachineStore`), all from
 * `@serfab/cadre-core`. Wired in `cadre-phone.ts` (`startPhoneNode`).
 *
 * All three records go in the SAME database as the phone's Ed25519 identity (see
 * `cadre-phone.ts`'s `loadOrCreatePhoneKey` / `PEER_IDENTITY_DB_NAME`) — the
 * fate-sharing rationale is on that module's `startPhoneNode` doc comment.
 *
 * Everything above the slot — cold start, corrupt JSON, foreign `partyId`,
 * discard-all vs drop-entry, synchronous visibility, failed-persist recovery —
 * belongs to cadre-core and is not restated here: `node-local-snapshot.ts` for
 * the anchor and the dial hints, `enrolled-machine-store.ts` for the count,
 * which deliberately does NOT share that machinery (an unreadable slot
 * cold-starts there rather than throwing, because a lost repair hint must not
 * stop a node starting).
 */
import type { DurableSlot } from '@serfab/cadre-core';

/** `SqliteKVStore` key for a party's persisted trusted-owner anchor. */
export function anchorSlotKey(partyId: string): string {
	return `trusted-owners.${partyId}`;
}

/** `SqliteKVStore` key for a party's retained cold-start dial targets. */
export function bootstrapPeersSlotKey(partyId: string): string {
	return `bootstrap-peers.${partyId}`;
}

/**
 * `SqliteKVStore` key for a party's last-known enrolled-machine count — the
 * control network's block-repair yardstick, read back at the next launch. Its
 * own key, so no record's snapshot write can clobber another's.
 */
export function enrolledMachinesSlotKey(partyId: string): string {
	return `enrolled-machines.${partyId}`;
}

/**
 * The subset of `SqliteKVStore` (`@optimystic/db-p2p-storage-ns`) a slot
 * needs. Declared locally — mirroring `KvStoreApi` in
 * reference-app-rn/src/node-local-slots.ts — so tests can pass an in-memory
 * fake with no SQLite dependency. The real `SqliteKVStore` is structurally
 * assignable to this.
 */
export interface KvStoreApi {
	/** The key's text, or `undefined` when absent. Throws on a read fault. */
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
}

/**
 * A `DurableSlot` over one key of a `SqliteKVStore` — the shared backend for
 * all three node-local records, each over its own key. A direct pass-through: the KV store already deals
 * in text and already reports an absent key as `undefined`, and a read fault
 * throws out of `get`, which is exactly the "present but unreadable ⇒ throw"
 * contract `DurableSlot` asks for.
 */
export function kvSlot(kv: KvStoreApi, key: string): DurableSlot {
	return {
		load: () => kv.get(key),
		save: (text) => kv.set(key, text),
	};
}
