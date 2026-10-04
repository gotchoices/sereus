/**
 * `@serfab/cadre-rn/node-local` — the phone's `DurableSlot` backends for cadre-core's
 * **node-local** records: the trusted-owner anchor (`PersistentTrustedOwnerStore`),
 * the cold-start bootstrap-peer store (`PersistentBootstrapPeerStore`), the
 * enrolled-machine count (`PersistentEnrolledMachineStore`) and the strand network
 * state (`PersistentStrandNetworkStateStore`), all from `@serfab/cadre-core` — and the
 * key each record is filed under. The app chooses the databases and opens the
 * stores; `createPhoneNode` (`./phone-node`) does both for an app that uses it.
 *
 * The anchor gets a DIFFERENT backend from the rest, deliberately — it has
 * different security properties and a different size.
 *
 * **Trusted-owner anchor → the platform secure store**, through the same injected
 * {@link SecureStoreApi} seam `./key-store` uses. The anchor is not secret, but it
 * IS trust-bearing: anything that can silently edit it can make this device believe
 * a stranger is one of its party's owners. The secure store is the most
 * tamper-resistant store a phone app has; it is where the identity key already
 * lives, so the anchor and the key it qualifies share one fate — including the iOS
 * Keychain surviving an app reinstall, which is the *desirable* direction (same peer
 * id, same trusted owners, device rejoins); and the payload is tiny — one base64url
 * ed25519 key plus `{source, trustedAt}` is roughly 90 bytes, and a real anchor
 * holds one to three keys.
 *
 * **Bootstrap peers → app-private LevelDB** (a `LevelDBKVStore` over a database of
 * the app's own). These are dial hints; dialing grants no authority — `CadreNode`
 * re-binds every retained address to the peer id it was recorded under — so
 * ordinary app-private storage is adequate. They also do not *fit* in the secure
 * store: multiaddrs run 80–120 characters each, several per peer, and the snapshot
 * grows for the node's whole lifetime, so it would cross Expo's ~2048-byte value
 * limit and fail the write.
 *
 * **Enrolled-machine count → the same app-private LevelDB**, its own key. Also not
 * trust-bearing: it is a block-repair yardstick, recomputed from the party's
 * `CadrePeer` rows the moment the control database is up, and a phone that loses it
 * simply declares nothing on its next launch. Size is not the argument here — one
 * integer would fit the secure store easily — but a record whose worst failure is
 * "declare today's default" has no business behind a keystore that can prompt or
 * deny, so it sits with the other non-trust-bearing record.
 *
 * **Strand network state → the same app-private LevelDB**, its own key. Not
 * trust-bearing (FRET verifies each address record at import), and a routing table
 * would not fit the secure store either.
 *
 * Use a LevelDB database of its own for these records, not a strand's, so clearing
 * it cannot disturb replicated strand data.
 *
 * Everything above the slot — cold start, corrupt JSON, foreign `partyId`,
 * discard-all vs drop-entry, synchronous visibility, failed-persist recovery —
 * belongs to cadre-core and is not restated here: `node-local-snapshot.ts` for the
 * anchor and the dial hints, `enrolled-machine-store.ts` for the count, which
 * deliberately does NOT share that machinery (an unreadable slot cold-starts there
 * rather than throwing, because a lost repair hint must not stop a node starting).
 */

import type { DurableSlot } from '@serfab/cadre-core';
import {
	forwardedSecureStoreOptions,
	secureStoreKeySegment,
	type SecureStoreApi,
	type SecureStoreKeyStoreOptions,
	type SecureStoreOptions,
} from './key-store.js';

/**
 * SecureStore key prefix for the trusted-owner anchor. Deliberately NOT under
 * the `sereus.ks.` prefix `SecureStoreKeyStore` owns — that namespace carries
 * its `__index` bookkeeping, which must never see a foreign entry.
 */
const ANCHOR_KEY_PREFIX = 'sereus.anchor.';

/**
 * SecureStore key for a party's trusted-owner anchor. The party id is
 * base64url-encoded because SecureStore keys permit only `[A-Za-z0-9._-]` and a
 * party id is arbitrary text.
 */
export function anchorSlotKey(partyId: string): string {
	return ANCHOR_KEY_PREFIX + secureStoreKeySegment(partyId);
}

/**
 * `LevelDBKVStore` key for a party's retained cold-start dial targets. LevelDB
 * keys are bytes, so the party id needs no encoding here. Every record key is
 * `<record>.<partyId>`, so an app's own records in the same database stay clear of
 * them by using a dot-free key.
 */
export function bootstrapPeersKvKey(partyId: string): string {
	return `bootstrap-peers.${partyId}`;
}

/**
 * `LevelDBKVStore` key for a party's last-known enrolled-machine count. Same
 * database and encoding-free shape as {@link bootstrapPeersKvKey}, its own key so
 * neither record's snapshot write can clobber the other.
 */
export function enrolledMachinesKvKey(partyId: string): string {
	return `enrolled-machines.${partyId}`;
}

/**
 * `LevelDBKVStore` key for a party's strand network state — per strand, the FRET
 * routing table its strand node saved, re-imported after a relaunch. Same database
 * and shape as {@link bootstrapPeersKvKey}, its own key; not trust-bearing (FRET
 * verifies each address record at import), and a routing table would not fit secure
 * store either.
 */
export function strandNetworkKvKey(partyId: string): string {
	return `strand-network.${partyId}`;
}

/**
 * The subset of `LevelDBKVStore` (`@optimystic/db-p2p-storage-rn`) a slot needs.
 * Declared locally — mirroring {@link SecureStoreApi} — so tests can pass an
 * in-memory fake and no native module lands in a Node test graph. The real
 * `LevelDBKVStore` is structurally assignable to this.
 */
export interface KvStoreApi {
	/** The key's text, or `undefined` when absent. Throws on a read fault. */
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
}

/**
 * A {@link DurableSlot} over one secure-store entry — the trusted-owner anchor's
 * backend.
 *
 * The slot MUST be ungated: `load` maps a `null` read to "absent", which is only
 * sound without `requireAuthentication` (see the guard below).
 */
export function secureStoreSlot(
	backend: SecureStoreApi,
	key: string,
	options: SecureStoreKeyStoreOptions = {},
): DurableSlot {
	if (options.requireAuthentication === true) {
		// The `null ⇒ absent` mapping in `load` is sound only for an UNGATED slot; a
		// gated one needs the `__index`-marker disambiguation `SecureStoreKeyStore`
		// implements (Expo reports a biometric-invalidated entry as `null` too).
		// Fail at construction rather than silently reporting an invalidated anchor
		// as empty — which the next snapshot write would then make permanent.
		throw new Error(
			'secureStoreSlot: a gated (requireAuthentication) slot cannot treat a null read as absent',
		);
	}
	const forwarded: SecureStoreOptions = forwardedSecureStoreOptions(options);
	return {
		async load() {
			// A throw means access denied / backend failure — NOT an empty slot.
			// Propagate, so the shared loader's "present but unreadable ⇒ throw"
			// policy holds and the next save cannot destroy an intact anchor.
			const raw = await backend.getItemAsync(key, forwarded);
			// `null` ⇒ absent. Safe *because this slot is ungated* — the gated-`null`
			// ambiguity documented on `SecureStoreKeyStore.gatedNullResult` cannot
			// arise here, so do NOT "fix" this by copying the index-marker dance.
			return raw ?? undefined;
		},
		// NOTE: `expo-secure-store` enforces a soft ~2048-byte value limit, so an
		// anchor snapshot approaching it fails this write rather than truncating.
		// One anchored key costs ~90 bytes ⇒ roughly 20 keys of headroom, well above
		// the one-to-three a real party anchors. If a party ever anchors that many
		// owners, move the anchor to its own key in the node-local LevelDB (as the
		// dial hints already are) rather than trimming the record.
		save: (text) => backend.setItemAsync(key, text, forwarded),
	};
}

/**
 * A {@link DurableSlot} over one key of a `LevelDBKVStore` — the backend for every
 * non-trust-bearing record (the bootstrap-peer store, the enrolled-machine count and
 * the strand network state, and any of the app's own), each over its own key.
 *
 * A direct pass-through: the KV store already deals in text and already reports
 * an absent key as `undefined`, and a read fault throws out of `get`, which is
 * exactly the "present but unreadable ⇒ throw" contract {@link DurableSlot} asks
 * for.
 */
export function kvStoreSlot(kv: KvStoreApi, key: string): DurableSlot {
	return {
		load: () => kv.get(key),
		save: (text) => kv.set(key, text),
	};
}
