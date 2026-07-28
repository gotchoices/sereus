/**
 * Node-only file-backed {@link TrustedOwnerStore}: one JSON file per party under
 * a configured directory (typically next to the identity key), holding the
 * node-local, non-replicated trusted-owner anchor.
 *
 * This module imports `node:fs/promises`, `node:path`, and `node:crypto`, so it
 * is deliberately kept OUT of the package's cross-platform default entry
 * (`./index.js`). Import it from the dedicated subpath instead:
 *
 * ```ts
 * import { FileTrustedOwnerStore } from '@serfab/cadre-core/trusted-owner-store-file';
 * ```
 *
 * A React Native / browser entry graph never resolves this path, so the
 * `node:fs` edge never reaches a bundler that cannot satisfy it (same
 * isolation pattern as `key-store-file.ts`).
 */
import debug from 'debug';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TrustedOwnerStore, TrustSource } from './trusted-owner-store.js';
import { encodeFileSafeComponent, isNotFound, writeFileAtomically } from './fs-atomic.js';

const log = debug('sereus:cadre:trusted-owner-store-file');

/** On-disk shape. `version` guards future migrations; unknown shapes load empty. */
interface PersistedTrustedOwners {
	version: 1;
	partyId: string;
	/** ownerKey (base64url) -> provenance + wall-clock trust time (ms). */
	owners: Record<string, { source: TrustSource; trustedAt: number }>;
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set(['genesis', 'invite', 'operator']);

/**
 * Validate an unknown parsed JSON value into {@link PersistedTrustedOwners}.
 * Returns undefined on any shape mismatch — the caller treats that as a cold
 * start (empty anchor), never a crash.
 */
function parsePersisted(value: unknown): PersistedTrustedOwners | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const candidate = value as Partial<PersistedTrustedOwners>;
	if (candidate.version !== 1 || typeof candidate.partyId !== 'string') return undefined;
	if (typeof candidate.owners !== 'object' || candidate.owners === null) return undefined;
	for (const entry of Object.values(candidate.owners)) {
		if (typeof entry !== 'object' || entry === null) return undefined;
		if (!KNOWN_SOURCES.has(entry.source) || typeof entry.trustedAt !== 'number') return undefined;
	}
	return candidate as PersistedTrustedOwners;
}

/**
 * File-backed {@link TrustedOwnerStore}. The anchor lives at
 * `<dir>/trusted-owners.<encoded partyId>.json` (0600, atomically replaced on
 * every {@link trust}), so one directory can hold anchors for several parties
 * without cross-party leakage. Construct via {@link open}, which loads the
 * existing file; an absent, unreadable, corrupt, or wrong-party file is a cold
 * start (empty anchor) — logged loudly, never a crash.
 */
export class FileTrustedOwnerStore implements TrustedOwnerStore {
	/**
	 * Serialises persists: each {@link trust} snapshot-writes the full owner set,
	 * so chaining writes keeps them ordered and the last landed file complete.
	 */
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(
		private readonly dir: string,
		readonly partyId: string,
		private readonly owners: Map<string, { source: TrustSource; trustedAt: number }>
	) {}

	/**
	 * Load (or cold-start) the party's anchor from `dir`. Failure policy per the
	 * trust model: only a real, well-formed, matching-party file yields keys;
	 * anything else — missing file, unparsable JSON, unknown shape, partyId
	 * mismatch (a directory reused for a different party must not leak trust) —
	 * yields an EMPTY anchor. Empty is the safe direction: it makes the node
	 * trust no one until re-seeded out of band, rather than trusting stale or
	 * foreign keys.
	 */
	static async open(dir: string, partyId: string): Promise<FileTrustedOwnerStore> {
		const store = new FileTrustedOwnerStore(dir, partyId, new Map());
		let raw: Buffer;
		try {
			raw = await readFile(store.filePath());
		} catch (error) {
			if (!isNotFound(error)) {
				log('FileTrustedOwnerStore: read failed for party %s (cold start): %o', partyId, error);
			}
			return store;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString('utf8'));
		} catch (error) {
			log('FileTrustedOwnerStore: corrupt anchor file for party %s (cold start): %o', partyId, error);
			return store;
		}
		const persisted = parsePersisted(parsed);
		if (!persisted || persisted.partyId !== partyId) {
			log('FileTrustedOwnerStore: anchor file for party %s has unknown shape or foreign partyId (cold start)', partyId);
			return store;
		}
		for (const [key, entry] of Object.entries(persisted.owners)) {
			store.owners.set(key, entry);
		}
		log('FileTrustedOwnerStore: loaded %d trusted owner key(s) for party %s', store.owners.size, partyId);
		return store;
	}

	private filePath(): string {
		return join(this.dir, `trusted-owners.${encodeFileSafeComponent(this.partyId)}.json`);
	}

	/** Sibling temp path for the atomic replace (random component: collide-free). */
	private tempPath(): string {
		const unique = randomBytes(6).toString('hex');
		return join(this.dir, `trusted-owners.${encodeFileSafeComponent(this.partyId)}.${unique}.tmp`);
	}

	has(ownerKey: string): boolean {
		return this.owners.has(ownerKey);
	}

	all(): ReadonlySet<string> {
		return new Set(this.owners.keys());
	}

	/**
	 * Anchor a key: the in-memory set updates synchronously (per the
	 * {@link TrustedOwnerStore.trust} contract), then the full snapshot is
	 * atomically persisted. A persist failure rejects the returned promise but
	 * leaves the key trusted in memory — this session's trust decision stands,
	 * and any later successful {@link trust} re-lands the complete set.
	 */
	trust(ownerKey: string, source: TrustSource): Promise<void> {
		if (this.owners.has(ownerKey)) {
			// Idempotent: re-enrollment / restart re-seeding keeps the original
			// provenance and skips the disk write entirely.
			return Promise.resolve();
		}
		this.owners.set(ownerKey, { source, trustedAt: Date.now() });
		log('trusted owner key anchored (party=%s, source=%s); persisting', this.partyId, source);
		const persist = this.writeChain.then(() => this.persistSnapshot());
		// The chain itself must survive a failed persist (next trust retries the
		// full snapshot); the caller still observes the rejection via `persist`.
		this.writeChain = persist.catch((error) => {
			log('FileTrustedOwnerStore: persist failed for party %s: %o', this.partyId, error);
		});
		return persist;
	}

	private async persistSnapshot(): Promise<void> {
		const snapshot: PersistedTrustedOwners = {
			version: 1,
			partyId: this.partyId,
			owners: Object.fromEntries(this.owners),
		};
		const data = new TextEncoder().encode(JSON.stringify(snapshot, null, '\t'));
		await writeFileAtomically(this.dir, this.tempPath(), this.filePath(), data);
	}
}
