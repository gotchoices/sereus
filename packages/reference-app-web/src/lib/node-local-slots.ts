/**
 * node-local-slots.ts — the edge node's key store and node-local key-value store, both over the
 * `kv` object store of the tab's node-local IndexedDB database (`strand-storage.ts` →
 * `NODE_LOCAL_STORE_KEY`). `web-edge-platform.ts` hands them to `@serfab/cadre-core/edge-node`'s
 * `createEdgeNode` as `EdgeNodePlatform.keyStore` and `EdgeNodeStorage.nodeLocal`.
 *
 * Both take an opener rather than an open handle. The key store answers `identityPeerId()` and an
 * owner-key export with no node running, and the node-local store holds the saved start, which
 * outlives every stop: `EdgeNodeStorage.close` closes the handle, and the next read reopens it.
 *
 * Everything is in ONE database, with the tab's identity. The decisive property is shared fate:
 * "Clear site data" wipes identity, owner key, joined-strand records, trusted-owner anchor and
 * dial targets together, so the tab cold-starts as a genuinely fresh node, rather than leaving a
 * half-cleared state where a regenerated identity inherits a stale anchor. That database is NOT
 * cadre-core's control block store, which is keyed by party id (`controlStorageScope`): the saved
 * start is read BEFORE the party id is known, since the party id is what it holds.
 *
 * **Key store slots → `kv` keys.** The identity slot (`cadre/identity`) is `peer-private-key` and
 * the owner slot (`cadre/owner`) is `owner-private-key`, the keys tabs held before the edge node,
 * so both survive the upgrade; both hold libp2p protobuf bytes, the form `loadOrCreateIdentityKey`
 * reads. Every other slot (joined-strand records, strand-move records) is `keystore.<keyId>`.
 *
 * **Node-local records** are text under the keys cadre-core's `edge-node/node-local.ts` names:
 * `start-options`, `dissolving-party`, and `<record>.<partyId>` for each party's trusted-owner
 * anchor, bootstrap peers, enrolled-machine count and strand network state. Each party's records
 * are filed under its own id because a tab that joins another cadre switches party, and comes
 * back to the one it founded when the join fails; one key per tab would have the joined party's
 * first save overwrite the founded party's records.
 */
import { DEFAULT_IDENTITY_KEY_ID, DEFAULT_OWNER_KEY_ID, KeyStoreAccessError, type KeyId, type KeyStore } from '@serfab/cadre-core';
import type { NodeLocalKv } from '@serfab/cadre-core/edge-node';
import { supportsStrictDurability, transactionDurability, type OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';

/** `kv` key of the tab's identity (`DEFAULT_IDENTITY_KEY_ID`): the libp2p protobuf bytes of an Ed25519 private key. */
export const PEER_KEY_KV_KEY = 'peer-private-key';

/**
 * `kv` key of the tab's owner key (`DEFAULT_OWNER_KEY_ID`), in the identity's stored form. One per
 * tab and dot-free, like the identity, rather than per party: one owner key may own several cadres.
 */
export const OWNER_KEY_KV_KEY = 'owner-private-key';

/** `kv` key prefix of every other key-store slot; the slot id follows verbatim. */
export const KEY_STORE_KV_PREFIX = 'keystore.';

/** Opens the node-local database, or returns it when it is open (`strand-storage.ts` → `openHandle`). */
export type OpenNodeLocal = () => Promise<OptimysticWebDBHandle>;

/** The `kv` key a key-store slot is kept under. A persistence contract: see the module header. */
export function keyStoreKvKey(keyId: KeyId): string {
	if (keyId === DEFAULT_IDENTITY_KEY_ID) return PEER_KEY_KV_KEY;
	if (keyId === DEFAULT_OWNER_KEY_ID) return OWNER_KEY_KV_KEY;
	return KEY_STORE_KV_PREFIX + keyId;
}

/** The inverse of {@link keyStoreKvKey}; `undefined` for a `kv` key that is no slot's. */
function keyIdOfKvKey(key: string): KeyId | undefined {
	if (key === PEER_KEY_KV_KEY) return DEFAULT_IDENTITY_KEY_ID;
	if (key === OWNER_KEY_KV_KEY) return DEFAULT_OWNER_KEY_ID;
	return key.startsWith(KEY_STORE_KV_PREFIX) ? key.slice(KEY_STORE_KV_PREFIX.length) : undefined;
}

/**
 * The tab's key store: a cadre-core `KeyStore` over the node-local database, each slot under the
 * key {@link keyStoreKvKey} names. A value that is not bytes is reported as `KeyStoreAccessError`,
 * never as an empty slot, which the identity loader or owner genesis would fill with a new key.
 *
 * A write is strict where the browser supports it: a key may found a party, and one lost to a
 * power cut after that would leave the party with an owner nobody holds.
 *
 * Exposure is origin-scoped IndexedDB, readable by any script on the origin. Non-extractable
 * WebCrypto Ed25519 keys were weighed and declined, because an exportable key is what a file or
 * QR backup needs.
 */
export function nodeLocalKeyStore(open: OpenNodeLocal): KeyStore {
	const durability = transactionDurability(supportsStrictDurability());
	const write = async (key: string, value: Uint8Array | undefined): Promise<void> => {
		const tx = (await open()).transaction('kv', 'readwrite', { durability });
		await Promise.all([value === undefined ? tx.store.delete(key) : tx.store.put(value, key), tx.done]);
	};
	return {
		async get(keyId) {
			const key = keyStoreKvKey(keyId);
			const stored = await (await open()).get('kv', key);
			if (stored === undefined || stored instanceof Uint8Array) return stored;
			throw new KeyStoreAccessError(keyId, `The node-local kv key ${key} holds text, not key bytes`);
		},
		set: (keyId, keyMaterial) => write(keyStoreKvKey(keyId), keyMaterial),
		delete: (keyId) => write(keyStoreKvKey(keyId), undefined),
		async list() {
			const keys = await (await open()).getAllKeys('kv');
			return keys.map(keyIdOfKvKey).filter((keyId): keyId is KeyId => keyId !== undefined);
		},
	};
}

/**
 * The edge node's node-local store over the same database. Values are text; a non-string value
 * under a key is read as absent, so the loader behind it (`node-local-snapshot.ts` for the
 * snapshot records, `enrolled-machine-store.ts` for the count, `parseSavedStart` for the start)
 * cold-starts rather than failing on a corrupt record. Each `put` is its own transaction,
 * committed when it resolves, so `flush` has nothing to do.
 *
 * NOTE: two same-origin tabs open the same IndexedDB database and each snapshot-writes its own
 * full view on `save`, so the last writer wins and the other tab's newly-recorded entries (a
 * bootstrap peer, a trust anchor) can be dropped. Acceptable — re-seeding refills them — but
 * real; see the ticket `2.1-web-durable-node-local-stores` for the fuller rationale. The same
 * two tabs share the saved start too: a join in one switches the other only on its next load,
 * and a removal of the left party in one stops at that party's database while the other still
 * runs it (`strand-storage.ts` → `deleteStore`).
 */
export function nodeLocalKv(open: OpenNodeLocal): NodeLocalKv {
	return {
		async get(key) {
			const raw = await (await open()).get('kv', key);
			return typeof raw === 'string' ? raw : undefined;
		},
		async set(key, value) {
			await (await open()).put('kv', value, key);
		},
		async delete(key) {
			await (await open()).delete('kv', key);
		},
		flush: () => Promise.resolve(),
	};
}
