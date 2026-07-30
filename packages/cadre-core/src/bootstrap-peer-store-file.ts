/**
 * Node-only file-backed {@link BootstrapPeerStore}: one JSON file per party under
 * a configured directory (typically next to the identity key), holding the
 * node-local, non-replicated cold-start dial targets a seed nominated.
 *
 * This module imports `node:fs/promises`, `node:path`, and `node:crypto`, so it
 * is deliberately kept OUT of the package's cross-platform default entry
 * (`./index.js`). Import it from the dedicated subpath instead:
 *
 * ```ts
 * import { FileBootstrapPeerStore } from '@serfab/cadre-core/bootstrap-peer-store-file';
 * ```
 *
 * A React Native / browser entry graph never resolves this path, so the
 * `node:fs` edge never reaches a bundler that cannot satisfy it (same isolation
 * pattern as `trusted-owner-store-file.ts` / `key-store-file.ts`).
 *
 * The loader validates SHAPE only — never signatures. Nothing persisted here is
 * trust-bearing (see the `bootstrap-peer-store.ts` module comment: only dial
 * targets are retained, the seed was already checked against the trusted-owner
 * anchor, and every address is re-bound to its peer id before the dial). What it
 * does owe is dropping structurally junk entries so they never reach the dial
 * loop: an unparseable peer id, an empty address list, a non-string address.
 */
import debug from 'debug';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { peerIdFromString } from '@libp2p/peer-id';
import type { BootstrapPeerEntry, BootstrapPeerStore } from './bootstrap-peer-store.js';
import { encodeFileSafeComponent, isNotFound, writeFileAtomically } from './fs-atomic.js';

const log = debug('sereus:cadre:bootstrap-peer-store-file');

/** On-disk shape. `version` guards future migrations; unknown shapes load empty. */
interface PersistedBootstrapPeers {
	version: 1;
	partyId: string;
	/** peerId -> entry. */
	peers: Record<string, BootstrapPeerEntry>;
}

/**
 * Validate an unknown parsed JSON value into {@link PersistedBootstrapPeers}.
 * Returns undefined on an envelope mismatch — the caller treats that as a cold
 * start (empty store), never a crash. Individual entries are validated
 * separately by {@link isUsableEntry}, since one junk entry must not discard the
 * rest of a node's only way back into its party.
 */
function parsePersisted(value: unknown): PersistedBootstrapPeers | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const candidate = value as Partial<PersistedBootstrapPeers>;
	if (candidate.version !== 1 || typeof candidate.partyId !== 'string') return undefined;
	if (typeof candidate.peers !== 'object' || candidate.peers === null) return undefined;
	return candidate as PersistedBootstrapPeers;
}

/**
 * Is this key/entry pair structurally dialable? A junk entry is dropped on load
 * rather than carried into the cold-start dial loop, which would otherwise log a
 * parse failure once per reconcile pass forever.
 */
function isUsableEntry(peerId: string, entry: unknown): entry is BootstrapPeerEntry {
	if (typeof entry !== 'object' || entry === null) return false;
	const candidate = entry as Partial<BootstrapPeerEntry>;
	if (!Array.isArray(candidate.addrs) || candidate.addrs.length === 0) return false;
	if (candidate.addrs.some((addr) => typeof addr !== 'string' || addr.length === 0)) return false;
	if (typeof candidate.recordedAt !== 'number') return false;
	try {
		// The dial path binds each address to this id, so an id that cannot parse is
		// not a dial target at all.
		peerIdFromString(peerId);
	} catch {
		return false;
	}
	return true;
}

/**
 * File-backed {@link BootstrapPeerStore}. The targets live at
 * `<dir>/bootstrap-peers.<encoded partyId>.json` (0600, atomically replaced on
 * every {@link record}), so one directory can hold the targets of several parties
 * without cross-party leakage. Construct via {@link open}, which loads the
 * existing file; an absent, corrupt, or wrong-party file is a cold start (empty
 * store), while a present-but-unreadable file throws (see {@link open}).
 *
 * NOTE: writes are serialised in-process only. Two processes opening the SAME
 * directory for the SAME party would each snapshot-write their own view, so the
 * loser's entries are dropped (and on Windows the rename can fail EPERM/EBUSY
 * while the other process holds the destination open). Fine today — every
 * launcher gives a node its own identity/work directory — but if a single
 * directory ever backs two concurrent nodes of one party, this needs a lock file
 * or a merge-on-write, not a snapshot replace.
 */
export class FileBootstrapPeerStore implements BootstrapPeerStore {
	/**
	 * Serialises persists: each {@link record} snapshot-writes the full target set,
	 * so chaining writes keeps them ordered and the last landed file complete.
	 */
	private writeChain: Promise<void> = Promise.resolve();

	/** Filename-safe form of {@link partyId}, shared by the store and temp paths. */
	private readonly encodedParty: string;

	private constructor(
		private readonly dir: string,
		readonly partyId: string,
		private readonly peers: Map<string, BootstrapPeerEntry>
	) {
		this.encodedParty = encodeFileSafeComponent(partyId);
	}

	/**
	 * Load (or cold-start) the party's retained dial targets from `dir`. Failure
	 * policy copied from `FileTrustedOwnerStore.open`, because the reasons carry
	 * over. A *decidable* non-store — missing file, unparsable JSON, unknown
	 * shape, partyId mismatch (a directory reused for a different party must not
	 * leak dial targets) — yields an EMPTY store: the node is no worse off than
	 * before this store existed, and re-seeding refills it.
	 *
	 * A file that is *present but unreadable* (EACCES, EISDIR, EIO, …) is NOT
	 * decidable and **throws** instead — mirroring `FileTrustedOwnerStore.open` /
	 * `FileKeyStore.get`. Loading empty there would both hide a real
	 * misconfiguration and let the next {@link record} snapshot-write destroy a
	 * still-intact set of the node's only way back into the party.
	 */
	static async open(dir: string, partyId: string): Promise<FileBootstrapPeerStore> {
		const store = new FileBootstrapPeerStore(dir, partyId, new Map());
		let raw: Buffer;
		try {
			raw = await readFile(store.filePath());
		} catch (error) {
			if (isNotFound(error)) return store;
			throw new Error(
				`FileBootstrapPeerStore: failed to read the bootstrap-peer store for party ${partyId} at ${store.filePath()}`,
				{ cause: error }
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString('utf8'));
		} catch (error) {
			log('FileBootstrapPeerStore: corrupt store file for party %s (cold start): %o', partyId, error);
			return store;
		}
		const persisted = parsePersisted(parsed);
		if (!persisted || persisted.partyId !== partyId) {
			log('FileBootstrapPeerStore: store file for party %s has unknown shape or foreign partyId (cold start)', partyId);
			return store;
		}
		for (const [peerId, entry] of Object.entries(persisted.peers)) {
			if (!isUsableEntry(peerId, entry)) {
				log('FileBootstrapPeerStore: dropping unusable entry for %s (party %s)', peerId, partyId);
				continue;
			}
			store.peers.set(peerId, { addrs: [...entry.addrs], recordedAt: entry.recordedAt });
		}
		log('FileBootstrapPeerStore: loaded %d bootstrap peer(s) for party %s', store.peers.size, partyId);
		return store;
	}

	private filePath(): string {
		return join(this.dir, `bootstrap-peers.${this.encodedParty}.json`);
	}

	/** Sibling temp path for the atomic replace (random component: collide-free). */
	private tempPath(): string {
		const unique = randomBytes(6).toString('hex');
		return join(this.dir, `bootstrap-peers.${this.encodedParty}.${unique}.tmp`);
	}

	all(): ReadonlyMap<string, BootstrapPeerEntry> {
		return new Map(this.peers);
	}

	/**
	 * Retain a peer's dial addresses: the in-memory map updates synchronously (per
	 * the {@link BootstrapPeerStore.record} contract), then the full snapshot is
	 * atomically persisted. A persist failure rejects the returned promise but
	 * leaves the entry retained in memory — this session's retry set stands, and
	 * any later successful {@link record} re-lands the complete set.
	 */
	record(peerId: string, addrs: readonly string[]): Promise<void> {
		this.peers.set(peerId, { addrs: [...addrs], recordedAt: Date.now() });
		log('bootstrap peer retained (party=%s, peer=%s, addrs=%d); persisting', this.partyId, peerId, addrs.length);
		const persist = this.writeChain.then(() => this.persistSnapshot());
		// The chain itself must survive a failed persist (the next record retries the
		// full snapshot); the caller still observes the rejection via `persist`.
		this.writeChain = persist.catch((error) => {
			log('FileBootstrapPeerStore: persist failed for party %s: %o', this.partyId, error);
		});
		return persist;
	}

	private async persistSnapshot(): Promise<void> {
		const snapshot: PersistedBootstrapPeers = {
			version: 1,
			partyId: this.partyId,
			peers: Object.fromEntries(this.peers),
		};
		const data = new TextEncoder().encode(JSON.stringify(snapshot, null, '\t'));
		await writeFileAtomically(this.dir, this.tempPath(), this.filePath(), data);
	}
}
