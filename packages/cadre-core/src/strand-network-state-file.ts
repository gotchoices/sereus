/**
 * Node-only file-backed {@link StrandNetworkStateStore}: one JSON file per party
 * under a configured directory (the node's state directory — `cadre-cli` passes
 * `ResolvedConfig.nodeStateDir`), holding the node-local, non-replicated network
 * state of every strand this node runs (each strand node's saved FRET routing
 * table, with its peers' signed address records).
 *
 * Nothing but the file itself lives here: the envelope, load policy, per-entry
 * check and the serialised snapshot writes are cross-platform in
 * `PersistentStrandNetworkStateStore` / `node-local-snapshot.ts`, and the file is a
 * `FileDurableSlot`. This module exists only so the `node:fs` edge stays out of the
 * package's cross-platform default entry (`./index.js`) — import it from the
 * dedicated subpath instead:
 *
 * ```ts
 * import { FileStrandNetworkStateStore } from '@serfab/cadre-core/strand-network-state-file';
 * ```
 *
 * Same isolation pattern as `bootstrap-peer-store-file.ts` / `key-store-file.ts`.
 */
import { FileDurableSlot } from './file-durable-slot.js';
import { PersistentStrandNetworkStateStore } from './strand-network-state.js';
import type { StrandNetworkStateStore } from './strand-network-state.js';

/** Base name of the store file: `<dir>/strand-network.<encoded partyId>.json`. */
const SLOT_NAME = 'strand-network';

/**
 * File-backed {@link StrandNetworkStateStore}. Open via {@link open}, which loads
 * the existing file and returns the cross-platform store over it; an absent,
 * corrupt, or wrong-party file is a cold start (no saved state) while a
 * present-but-unreadable file throws. Those rules and their reasoning live on
 * `NodeLocalSnapshot.open`.
 */
export const FileStrandNetworkStateStore = {
	/** Load (or cold-start) the party's strand network state from a file in `dir`. */
	async open(dir: string, partyId: string): Promise<StrandNetworkStateStore> {
		return PersistentStrandNetworkStateStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId);
	}
};
