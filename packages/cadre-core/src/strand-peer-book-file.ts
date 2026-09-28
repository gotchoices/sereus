/**
 * Node-only file-backed {@link StrandPeerBookStore}: one JSON file per party under
 * a configured directory (the node's state directory — `cadre-cli` passes
 * `ResolvedConfig.nodeStateDir`), holding the node-local, non-replicated strand
 * peer book (the strand peers this node has met, with their last-known addresses).
 *
 * Nothing but the file itself lives here: the envelope, load policy, per-entry
 * validation, the merge rule and the serialised snapshot writes are cross-platform
 * in `PersistentStrandPeerBookStore` / `node-local-snapshot.ts`, and the file is a
 * `FileDurableSlot`. This module exists only so the `node:fs` edge stays out of the
 * package's cross-platform default entry (`./index.js`) — import it from the
 * dedicated subpath instead:
 *
 * ```ts
 * import { FileStrandPeerBookStore } from '@serfab/cadre-core/strand-peer-book-file';
 * ```
 *
 * Same isolation pattern as `bootstrap-peer-store-file.ts` / `key-store-file.ts`.
 */
import { FileDurableSlot } from './file-durable-slot.js';
import { PersistentStrandPeerBookStore } from './strand-peer-book.js';
import type { StrandPeerBookOptions, StrandPeerBookStore } from './strand-peer-book.js';

/** Base name of the store file: `<dir>/strand-peers.<encoded partyId>.json`. */
const SLOT_NAME = 'strand-peers';

/**
 * File-backed {@link StrandPeerBookStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it; an absent, corrupt,
 * or wrong-party file is a cold start (empty book) and structurally junk or
 * aged-out entries are dropped, while a present-but-unreadable file throws. Those
 * rules and their reasoning live on `NodeLocalSnapshot.open`.
 */
export const FileStrandPeerBookStore = {
	/** Load (or cold-start) the party's strand peer book from a file in `dir`. */
	async open(dir: string, partyId: string, options?: StrandPeerBookOptions): Promise<StrandPeerBookStore> {
		return PersistentStrandPeerBookStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId, options);
	}
};
