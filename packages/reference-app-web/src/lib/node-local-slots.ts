/**
 * node-local-slots.ts — `DurableSlot` factory over the node-local database's
 * `kv` IndexedDB object store, for the browser's node-local records: the
 * trusted-owner anchor (`@serfab/cadre-core/trusted-owner-store`), the
 * cold-start bootstrap-peer store (`@serfab/cadre-core/bootstrap-peer-store`),
 * the enrolled-machine count (`@serfab/cadre-core/enrolled-machine-store`) and
 * the strand network state, each under its own key, per party. And the tab's
 * owner key, one per tab, as a cadre-core `KeyStore` ({@link ownerKeyStore}).
 *
 * Every record goes in the SAME database as the tab's Ed25519 identity and
 * start record (`strand-storage.ts`'s `NODE_LOCAL_STORE_KEY` database, `kv` store) —
 * not a separate one. The decisive property is shared fate: "Clear site data"
 * must wipe identity, owner key, anchor, and dial targets together so the tab
 * cold-starts as a genuinely fresh node, rather than leaving a half-cleared state
 * where a regenerated identity inherits a stale anchor, or a retained identity
 * loses its anchor silently. See `cadre-web.ts` (`startCadre`) for the wiring.
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
import { DEFAULT_OWNER_KEY_ID, KeyStoreAccessError, type DurableSlot, type KeyId, type KeyStore } from '@serfab/cadre-core';
import { supportsStrictDurability, transactionDurability, type OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';

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

/**
 * `kv` key of the tab's owner key: the libp2p protobuf bytes of an Ed25519 private key, the
 * stored form of the peer key beside it (`peer-private-key`). One per tab and dot-free, like the
 * peer key, rather than per party: one owner key may own several cadres.
 */
export const OWNER_KEY_KV_KEY = 'owner-private-key';

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
 * share the start record too: a join in one switches the other only on its next load,
 * and a removal of the left party in one stops at that party's database while the other
 * still runs it (`strand-storage.ts` → `deleteStore`).
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

/**
 * The tab's owner-key slot as a cadre-core `KeyStore`, holding `DEFAULT_OWNER_KEY_ID` alone, so
 * cadre-core's owner-key slot functions and flows (`createOwnerKey`, `importOwnerKeyInto`, ...)
 * run over it unchanged; any other slot id is refused. A value that is not bytes is reported as
 * `KeyStoreAccessError`, never as an empty slot, which genesis would fill with a new key.
 *
 * A write is strict where the browser supports it, as the peer key's first write is
 * (`loadOrCreateBrowserPeerKey`): the key may found a party, and one lost to a power cut after
 * that would leave the party with an owner nobody holds.
 *
 * Exposure is the peer key's: origin-scoped IndexedDB, readable by any script on the origin.
 * Non-extractable WebCrypto Ed25519 keys were weighed and declined, because an exportable key is
 * what a file or QR backup needs.
 */
export function ownerKeyStore(handle: OptimysticWebDBHandle): KeyStore {
	const durability = transactionDurability(supportsStrictDurability());
	const write = async (value: Uint8Array | undefined): Promise<void> => {
		const tx = handle.transaction('kv', 'readwrite', { durability });
		await Promise.all([value === undefined ? tx.store.delete(OWNER_KEY_KV_KEY) : tx.store.put(value, OWNER_KEY_KV_KEY), tx.done]);
	};
	return {
		async get(keyId) {
			requireOwnerSlot(keyId);
			const stored = await handle.get('kv', OWNER_KEY_KV_KEY);
			if (stored === undefined || stored instanceof Uint8Array) return stored;
			throw new KeyStoreAccessError(keyId, 'The tab\'s owner-key slot holds text, not key bytes');
		},
		async set(keyId, keyMaterial) {
			requireOwnerSlot(keyId);
			await write(keyMaterial);
		},
		async delete(keyId) {
			requireOwnerSlot(keyId);
			await write(undefined);
		},
		async list() {
			return (await handle.get('kv', OWNER_KEY_KV_KEY)) === undefined ? [] : [DEFAULT_OWNER_KEY_ID];
		},
	};
}

function requireOwnerSlot(keyId: KeyId): void {
	if (keyId !== DEFAULT_OWNER_KEY_ID) {
		throw new Error(`The tab's owner-key store holds only ${DEFAULT_OWNER_KEY_ID}, not ${keyId}`);
	}
}
