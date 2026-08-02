/**
 * Shared machinery for the node's **node-local** records — the small,
 * NEVER-replicated, per-party sets a node keeps for itself and never sources
 * from shared group state:
 *
 *  - the trusted-owner anchor (`trusted-owner-store.ts`),
 *  - the cold-start bootstrap-peer store (`bootstrap-peer-store.ts`).
 *
 * Both are the same mechanism with a different payload: a
 * `{ version, partyId, <entries> }` envelope, snapshot-written whole on every
 * change, loaded under one fail-safe-but-not-fail-silent policy. The only part
 * that differs per platform is WHERE the bytes are kept — Node writes a file,
 * a browser writes IndexedDB, React Native writes SecureStore or its LevelDB
 * KV, NativeScript writes SQLite. That difference is the whole of
 * {@link DurableSlot}, which the embedding app supplies; everything else lives
 * here.
 *
 * This module is cross-platform (no `node:` imports), so it is safe in the
 * package's default entry — the Node-only `FileDurableSlot`
 * (`file-durable-slot.ts`) is what stays behind the `*-store-file` subpaths.
 */
import debug from 'debug';

const log = debug('sereus:cadre:node-local-snapshot');

/**
 * A single durable text slot, supplied by the embedding app. The only
 * platform-specific part of a persistent node-local store.
 */
export interface DurableSlot {
	/**
	 * The slot's persisted text, or `undefined` when it was never written.
	 *
	 * MUST throw (not return `undefined`) when the slot exists but cannot be
	 * read. That distinction is load-bearing: `undefined` means "cold start,
	 * nothing was ever here", and callers snapshot-write the whole record, so a
	 * failed read reported as `undefined` silently converts a recoverable error
	 * (permissions, a blocked database upgrade, an I/O fault) into destruction
	 * of a still-intact record on the next save.
	 */
	load(): Promise<string | undefined>;
	/**
	 * Durably replace the slot's text. Callers snapshot-write the whole record,
	 * so an implementation never needs to merge.
	 */
	save(text: string): Promise<void>;
}

/** Envelope version. Guards future migrations; an unknown version loads empty. */
const ENVELOPE_VERSION = 1;

/**
 * What one unusable entry means for its siblings — the single intentional
 * difference between the two records:
 *
 *  - `'discard-all'` (the trusted-owner anchor): a record that cannot be read
 *    in full is not an anchor. Trusting a *subset* of the keys a file claims is
 *    a silent, security-relevant downgrade, so the whole record is discarded
 *    and the node trusts no one until re-seeded out of band.
 *  - `'drop-entry'` (the bootstrap-peer store): the record is a best-effort
 *    retry list and nothing in it is trust-bearing, so one junk entry must not
 *    discard a stranded node's only remaining way back into its party.
 */
export type UnusableEntryPolicy = 'discard-all' | 'drop-entry';

/** What a particular node-local record persists, and how it validates it. */
export interface NodeLocalSnapshotSpec<E> {
	/** Human name of the record, used in load errors and logs. */
	readonly label: string;
	/** Envelope property holding the `key -> entry` record (`owners`, `peers`). */
	readonly payloadKey: string;
	/** See {@link UnusableEntryPolicy}. */
	readonly unusableEntry: UnusableEntryPolicy;
	/**
	 * Validate one persisted entry, returning the value to hold in memory
	 * (copied, so later mutation of the parsed JSON cannot reach it) or
	 * `undefined` when the entry is unusable.
	 */
	readonly acceptEntry: (key: string, entry: unknown) => E | undefined;
}

/**
 * A loaded node-local record over a {@link DurableSlot}: an in-memory
 * `key -> entry` map plus a serialised full-snapshot write chain.
 *
 * NOTE: writes are serialised in-process only. Two processes (or two browser
 * tabs) sharing ONE slot for ONE party would each snapshot-write their own
 * view, so the loser's entries are dropped. Fine for every backend today —
 * each node gets its own directory / origin database — but a single slot
 * backing two concurrent nodes of one party needs a lock or a merge-on-write,
 * not a snapshot replace.
 */
export class NodeLocalSnapshot<E> {
	/**
	 * Serialises persists: every {@link put} snapshot-writes the full entry set,
	 * so chaining writes keeps them ordered and the last landed snapshot
	 * complete.
	 */
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(
		private readonly slot: DurableSlot,
		readonly partyId: string,
		private readonly spec: NodeLocalSnapshotSpec<E>,
		private readonly entries: Map<string, E>
	) {}

	/**
	 * Load (or cold-start) the party's record from `slot`. Failure policy, per
	 * the trust model of the anchor this was first written for: only a real,
	 * well-formed, matching-party record yields entries.
	 *
	 * A *decidable* non-record — slot never written, unparsable JSON, unknown
	 * envelope shape, `partyId` mismatch (a slot reused for a different party
	 * must not leak into this one) — yields an EMPTY record, the safe direction:
	 * the node holds nothing until it is re-seeded, rather than acting on stale
	 * or foreign state.
	 *
	 * A slot that is *present but unreadable* ({@link DurableSlot.load} threw)
	 * is NOT decidable and **throws** instead — mirroring `FileKeyStore.get`.
	 * Loading empty there would both hide a real misconfiguration and let the
	 * next {@link put} snapshot-write silently destroy a still-intact record.
	 */
	static async open<E>(
		slot: DurableSlot,
		partyId: string,
		spec: NodeLocalSnapshotSpec<E>
	): Promise<NodeLocalSnapshot<E>> {
		return new NodeLocalSnapshot(slot, partyId, spec, await loadEntries(slot, partyId, spec));
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	/** Fresh copy of the keys — a snapshot decoupled from later {@link put} calls. */
	keySnapshot(): Set<string> {
		return new Set(this.entries.keys());
	}

	/**
	 * Fresh copy of the `key -> entry` map — a snapshot decoupled from later
	 * {@link put} calls. The entries themselves need no copy: {@link put}
	 * REPLACES an entry rather than mutating it in place.
	 */
	entrySnapshot(): Map<string, E> {
		return new Map(this.entries);
	}

	/**
	 * Add or replace an entry: the in-memory map updates SYNCHRONOUSLY (so a
	 * synchronous caller may consult the store the moment this returns), then
	 * the full snapshot is persisted. A persist failure rejects the returned
	 * promise but leaves the entry in memory — this session's decision stands,
	 * and any later successful {@link put} re-lands the complete set.
	 */
	put(key: string, entry: E): Promise<void> {
		this.entries.set(key, entry);
		const persist = this.writeChain.then(() => this.persistSnapshot());
		// The chain itself must survive a failed persist (the next put retries the
		// full snapshot); the caller still observes the rejection via `persist`.
		this.writeChain = persist.catch((error) => {
			log('%s: persist failed for party %s: %o', this.spec.label, this.partyId, error);
		});
		return persist;
	}

	private async persistSnapshot(): Promise<void> {
		const envelope: Record<string, unknown> = {
			version: ENVELOPE_VERSION,
			partyId: this.partyId,
			[this.spec.payloadKey]: Object.fromEntries(this.entries),
		};
		await this.slot.save(JSON.stringify(envelope, null, '\t'));
	}
}

/** Read + validate the slot's text into the initial entry map (see {@link NodeLocalSnapshot.open}). */
async function loadEntries<E>(
	slot: DurableSlot,
	partyId: string,
	spec: NodeLocalSnapshotSpec<E>
): Promise<Map<string, E>> {
	const entries = new Map<string, E>();
	let text: string | undefined;
	try {
		text = await slot.load();
	} catch (error) {
		// Present but unreadable: the one non-decidable case, and the one that must
		// not cold-start empty (see NodeLocalSnapshot.open). The slot's own text is
		// folded into the message, not left only on `cause`: the operator-facing
		// print sites (e.g. `cadre-cli start`) log `error.message` alone, and the
		// slot is what knows the platform detail worth acting on (which file, which
		// database).
		throw new Error(
			`failed to read the ${spec.label} for party ${partyId}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	if (text === undefined) return entries;

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		log('%s: corrupt slot for party %s (cold start): %o', spec.label, partyId, error);
		return entries;
	}

	const payload = envelopePayload(parsed, partyId, spec.payloadKey);
	if (!payload) {
		log('%s: slot for party %s has an unknown shape or a foreign partyId (cold start)', spec.label, partyId);
		return entries;
	}

	for (const [key, raw] of Object.entries(payload)) {
		const entry = spec.acceptEntry(key, raw);
		if (entry === undefined) {
			if (spec.unusableEntry === 'discard-all') {
				log('%s: unusable entry for %s discards the whole record (party %s, cold start)', spec.label, key, partyId);
				return new Map();
			}
			log('%s: dropping unusable entry for %s (party %s)', spec.label, key, partyId);
			continue;
		}
		entries.set(key, entry);
	}
	log('%s: loaded %d entr(ies) for party %s', spec.label, entries.size, partyId);
	return entries;
}

/**
 * The envelope's `key -> entry` record, or undefined on any envelope mismatch —
 * wrong version, wrong (or absent) `partyId`, missing or non-record payload.
 * Individual entries are judged separately by
 * {@link NodeLocalSnapshotSpec.acceptEntry}, because one bad entry does not
 * always mean a bad record.
 */
function envelopePayload(
	value: unknown,
	partyId: string,
	payloadKey: string
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	// A non-string partyId cannot equal the requested one, so this covers both
	// "malformed partyId" and "another party's record".
	if (value.version !== ENVELOPE_VERSION || value.partyId !== partyId) return undefined;
	const payload = value[payloadKey];
	return isRecord(payload) ? payload : undefined;
}

/**
 * A plain JSON object usable as a `key -> value` record. Arrays are excluded
 * explicitly: they are `typeof 'object'`, so an array payload would otherwise
 * reach `acceptEntry` once per numeric index — the entries all get rejected in
 * the end, but by accident rather than by decision, and noisily.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
