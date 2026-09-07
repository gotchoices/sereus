/**
 * node-local-slots.ts — `DurableSlot` factory over the control database's
 * `kv` IndexedDB object store, for the browser's node-local records: the
 * trusted-owner anchor (`@serfab/cadre-core/trusted-owner-store`), the
 * cold-start bootstrap-peer store (`@serfab/cadre-core/bootstrap-peer-store`)
 * and the enrolled-machine count (`@serfab/cadre-core/enrolled-machine-store`),
 * each under its own key.
 *
 * All three records go in the SAME database as the tab's Ed25519 identity and
 * party id (`strand-storage.ts`'s `CONTROL_STORE_KEY` database, `kv` store) —
 * not a separate one. The decisive property is shared fate: "Clear site data"
 * must wipe identity, anchor, and dial targets together so the tab cold-starts
 * as a genuinely fresh node, rather than leaving a half-cleared state where a
 * regenerated identity inherits a stale anchor, or a retained identity loses
 * its anchor silently. See `cadre-web.ts` (`startCadre`) for the wiring.
 */
import type { DurableSlot } from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';

/** `kv` key for the persisted trusted-owner anchor snapshot. */
export const TRUSTED_OWNERS_KV_KEY = 'trusted-owners';

/** `kv` key for the persisted bootstrap-peer (cold-start dial target) snapshot. */
export const BOOTSTRAP_PEERS_KV_KEY = 'bootstrap-peers';

/**
 * `kv` key for the tab's last-known enrolled-machine count — the control
 * network's block-repair yardstick, read back at the next launch because the
 * control node is built before the database holding the membership rows exists.
 */
export const ENROLLED_MACHINES_KV_KEY = 'enrolled-machines';

/**
 * A `DurableSlot` over one `kv` key of the control database. The `kv` store's
 * value type is `string | Uint8Array`; `DurableSlot` deals in text only, so a
 * non-string value is a corrupt slot and is treated the same as absent (the
 * loader — `node-local-snapshot.ts` for the two snapshot records,
 * `enrolled-machine-store.ts` for the count — then cold-starts empty).
 *
 * NOTE: two same-origin tabs open the same IndexedDB database and each
 * snapshot-writes its own full view on `save`, so the last writer wins and the
 * other tab's newly-recorded entries (a bootstrap peer, a trust anchor) can be
 * dropped. Acceptable — re-seeding refills them — but real; see the ticket
 * `2.1-web-durable-node-local-stores` for the fuller rationale.
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
