/**
 * Node-only file-backed {@link EnrolledMachineStore}: one JSON file per party under
 * a configured directory (the node's state directory — `cadre-cli` passes
 * `ResolvedConfig.nodeStateDir`), holding the node-local, non-replicated count of
 * machines this party had enrolled the last time this node looked.
 *
 * Nothing but the file itself lives here: the envelope, the cold-start-on-anything
 * load policy (deliberately NOT the throw-on-unreadable policy its two sibling
 * records use — see the `enrolled-machine-store.ts` module comment) and the
 * serialised writes are cross-platform in `PersistentEnrolledMachineStore`, and the
 * file is a `FileDurableSlot`. This module exists only so the `node:fs` edge stays
 * out of the package's cross-platform default entry (`./index.js`) — import it from
 * the dedicated subpath instead:
 *
 * ```ts
 * import { FileEnrolledMachineStore } from '@serfab/cadre-core/enrolled-machine-store-file';
 * ```
 *
 * A React Native / browser entry graph never resolves this path, so the `node:fs`
 * edge never reaches a bundler that cannot satisfy it (same isolation pattern as
 * `bootstrap-peer-store-file.ts` / `trusted-owner-store-file.ts` / `key-store-file.ts`).
 */
import { FileDurableSlot } from './file-durable-slot.js';
import { PersistentEnrolledMachineStore } from './enrolled-machine-store.js';
import type { EnrolledMachineStore } from './enrolled-machine-store.js';

/** Base name of the store file: `<dir>/enrolled-machines.<encoded partyId>.json`. */
const SLOT_NAME = 'enrolled-machines';

/**
 * File-backed {@link EnrolledMachineStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it. An absent, corrupt,
 * wrong-party, junk-valued **or unreadable** file is a cold start (`count()` is
 * `undefined`, the node declares no repair yardstick and runs at the base control
 * policy) — `open` never rejects, unlike the sibling stores' file backends. That
 * divergence and its reasoning live on `enrolled-machine-store.ts`.
 */
export const FileEnrolledMachineStore = {
	/** Load (or cold-start) the party's last recorded machine count from a file in `dir`. */
	async open(dir: string, partyId: string): Promise<EnrolledMachineStore> {
		return PersistentEnrolledMachineStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId);
	}
};
