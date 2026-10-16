/**
 * The edge node's node-local records: the key each of cadre-core's node-local records is filed
 * under in the platform's node-local key-value store (`EdgeNodeStorage.nodeLocal`), and the
 * `DurableSlot` over one such key, which the persistent stores (`PersistentBootstrapPeerStore`,
 * `PersistentEnrolledMachineStore`, `PersistentStrandNetworkStateStore`, and
 * `PersistentTrustedOwnerStore` on a platform with no anchor slot of its own) read through.
 *
 * Every record key is `<record>.<partyId>`, so a party's records never collide with another's,
 * and an app's own records in the same store stay clear of them by using a dot-free key. The
 * party id needs no encoding: the store deals in text keys.
 *
 * Which records are trust-bearing, and so belong in a more tamper-resistant store where the
 * platform has one, is `EdgeNodeStorage.trustedOwnerSlot`'s concern; the React Native kit's
 * `@serfab/cadre-rn/node-local` carries that reasoning.
 */

import type { DurableSlot } from '../node-local-snapshot.js';

/**
 * The subset of a key-value store a slot needs. Declared here, structurally, so a platform
 * passes its own store (`LevelDBKVStore`, `SqliteKVStore`, an IndexedDB object store) and a
 * test an in-memory fake.
 */
export interface KvStoreApi {
	/** The key's text, or `undefined` when absent. Throws on a read fault. */
	get(key: string): Promise<string | undefined>;
	/** Resolves once `get` on this store reads `value`; durable only after a later {@link flush}. */
	set(key: string, value: string): Promise<void>;
	/** Make every write that resolved before this call durable. */
	flush(): Promise<void>;
}

/** The node-local store the edge node runs over: {@link KvStoreApi} plus deletion, for the records a removal drops. */
export interface NodeLocalKv extends KvStoreApi {
	/** Resolves once `get` reads the key as absent; durable only after a later {@link KvStoreApi.flush}. Idempotent. */
	delete(key: string): Promise<void>;
}

/** Key of a party's retained cold-start dial targets (`PersistentBootstrapPeerStore`). */
export function bootstrapPeersKvKey(partyId: string): string {
	return `bootstrap-peers.${partyId}`;
}

/** Key of a party's last-known enrolled-machine count (`PersistentEnrolledMachineStore`). */
export function enrolledMachinesKvKey(partyId: string): string {
	return `enrolled-machines.${partyId}`;
}

/**
 * Key of a party's strand network state (`PersistentStrandNetworkStateStore`): per strand, the
 * FRET routing table its strand node saved, re-imported after a relaunch.
 */
export function strandNetworkKvKey(partyId: string): string {
	return `strand-network.${partyId}`;
}

/**
 * Key of a party's trusted-owner anchor (`PersistentTrustedOwnerStore`) on a platform that
 * supplies no `EdgeNodeStorage.trustedOwnerSlot`: the browser and NativeScript apps. The anchor
 * is trust-bearing, so a platform with a more tamper-resistant store than its node-local one
 * (the phone's secure store) keeps it there instead.
 */
export function trustedOwnersKvKey(partyId: string): string {
	return `trusted-owners.${partyId}`;
}

/**
 * A {@link DurableSlot} over one key of a key-value store.
 *
 * A pass-through but for the flush: the store already deals in text and already reports an
 * absent key as `undefined`, and a read fault throws out of `get`, which is exactly the
 * "present but unreadable ⇒ throw" contract {@link DurableSlot} asks for. A `set` may resolve
 * into the store's write group, so `save` flushes after it to be durable when it resolves, as
 * {@link DurableSlot.save} requires.
 */
export function kvStoreSlot(kv: KvStoreApi, key: string): DurableSlot {
	return {
		load: () => kv.get(key),
		save: async (text) => {
			await kv.set(key, text);
			await kv.flush();
		},
	};
}
