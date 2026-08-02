/**
 * Node-only file-backed {@link TrustedOwnerStore}: one JSON file per party under
 * a configured directory (the node's state directory — `cadre-cli` passes
 * `ResolvedConfig.nodeStateDir`), holding the node-local, non-replicated
 * trusted-owner anchor.
 *
 * Nothing but the file itself lives here: the anchor's envelope, load policy,
 * per-entry validation and serialised snapshot writes are cross-platform in
 * `PersistentTrustedOwnerStore` / `node-local-snapshot.ts`, and the file is a
 * `FileDurableSlot`. This module exists only so the `node:fs` edge stays out of
 * the package's cross-platform default entry (`./index.js`) — import it from
 * the dedicated subpath instead:
 *
 * ```ts
 * import { FileTrustedOwnerStore } from '@serfab/cadre-core/trusted-owner-store-file';
 * ```
 *
 * A React Native / browser entry graph never resolves this path, so the
 * `node:fs` edge never reaches a bundler that cannot satisfy it (same
 * isolation pattern as `key-store-file.ts`).
 */
import { FileDurableSlot } from './file-durable-slot.js';
import { PersistentTrustedOwnerStore } from './trusted-owner-store.js';
import type { TrustedOwnerStore } from './trusted-owner-store.js';

/** Base name of the anchor file: `<dir>/trusted-owners.<encoded partyId>.json`. */
const SLOT_NAME = 'trusted-owners';

/**
 * File-backed {@link TrustedOwnerStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it; an absent, corrupt, or wrong-party file is a cold
 * start (empty anchor), while a present-but-unreadable file throws. Those rules
 * and their reasoning live on `NodeLocalSnapshot.open` — they are properties of
 * every persistent backend, not of this one.
 */
export const FileTrustedOwnerStore = {
	/** Load (or cold-start) the party's anchor from a file in `dir`. */
	async open(dir: string, partyId: string): Promise<TrustedOwnerStore> {
		return PersistentTrustedOwnerStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId);
	}
};
