/**
 * Node-only file-backed {@link BootstrapPeerStore}: one JSON file per party under
 * a configured directory (the node's state directory — `cadre-cli` passes
 * `ResolvedConfig.nodeStateDir`), holding the node-local, non-replicated
 * cold-start dial targets a seed nominated.
 *
 * Nothing but the file itself lives here: the envelope, load policy, per-entry
 * validation (shape only — never signatures; see the `bootstrap-peer-store.ts`
 * module comment for why nothing persisted here is trust-bearing) and the
 * serialised snapshot writes are cross-platform in
 * `PersistentBootstrapPeerStore` / `node-local-snapshot.ts`, and the file is a
 * `FileDurableSlot`. This module exists only so the `node:fs` edge stays out of
 * the package's cross-platform default entry (`./index.js`) — import it from the
 * dedicated subpath instead:
 *
 * ```ts
 * import { FileBootstrapPeerStore } from '@serfab/cadre-core/bootstrap-peer-store-file';
 * ```
 *
 * A React Native / browser entry graph never resolves this path, so the
 * `node:fs` edge never reaches a bundler that cannot satisfy it (same isolation
 * pattern as `trusted-owner-store-file.ts` / `key-store-file.ts`).
 */
import { FileDurableSlot } from './file-durable-slot.js';
import { PersistentBootstrapPeerStore } from './bootstrap-peer-store.js';
import type { BootstrapPeerStore } from './bootstrap-peer-store.js';

/** Base name of the store file: `<dir>/bootstrap-peers.<encoded partyId>.json`. */
const SLOT_NAME = 'bootstrap-peers';

/**
 * File-backed {@link BootstrapPeerStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it; an absent, corrupt, or wrong-party file is a cold
 * start (empty store) and structurally junk entries are dropped, while a
 * present-but-unreadable file throws. Those rules and their reasoning live on
 * `NodeLocalSnapshot.open` — including the in-process-only write serialisation,
 * which two nodes sharing one directory for one party would defeat.
 */
export const FileBootstrapPeerStore = {
	/** Load (or cold-start) the party's retained dial targets from a file in `dir`. */
	async open(dir: string, partyId: string): Promise<BootstrapPeerStore> {
		return PersistentBootstrapPeerStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId);
	}
};
