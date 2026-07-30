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
import { FileDurableSlot } from './fs-atomic.js';
import { PersistentTrustedOwnerStore } from './trusted-owner-store.js';
import type { TrustedOwnerStore, TrustSource } from './trusted-owner-store.js';

/** Base name of the anchor file: `<dir>/trusted-owners.<encoded partyId>.json`. */
const SLOT_NAME = 'trusted-owners';

/**
 * File-backed {@link TrustedOwnerStore}. Construct via {@link open}, which
 * loads the existing file; an absent, corrupt, or wrong-party file is a cold
 * start (empty anchor), while a present-but-unreadable file throws. Those rules
 * and their reasoning live on `NodeLocalSnapshot.open` — they are properties of
 * every persistent backend, not of this one.
 */
export class FileTrustedOwnerStore implements TrustedOwnerStore {
	private constructor(private readonly inner: PersistentTrustedOwnerStore) {}

	/** Load (or cold-start) the party's anchor from a file in `dir`. */
	static async open(dir: string, partyId: string): Promise<FileTrustedOwnerStore> {
		return new FileTrustedOwnerStore(
			await PersistentTrustedOwnerStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId)
		);
	}

	get partyId(): string {
		return this.inner.partyId;
	}

	has(ownerKey: string): boolean {
		return this.inner.has(ownerKey);
	}

	all(): ReadonlySet<string> {
		return this.inner.all();
	}

	trust(ownerKey: string, source: TrustSource): Promise<void> {
		return this.inner.trust(ownerKey, source);
	}
}
