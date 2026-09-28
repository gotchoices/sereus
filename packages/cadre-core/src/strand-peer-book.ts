/**
 * Node-local, NON-replicated **strand peer book**: for each strand this node runs,
 * the strand peers it knows an address for — the other parties' strand transport
 * peers, learned at formation and observed on every connection — with their
 * last-known strand-network addresses and when this node last held a connection
 * to them. Read on every launch, hibernation resume and periodic address refresh,
 * so a machine that restarts dials the peers it was talking to BEFORE it does
 * anything else, instead of coming back up alone.
 *
 * Why it exists (gotchoices/sereus#18): a cross-party strand learned the other
 * party's strand addresses exactly once, at formation, into an in-memory map, and
 * the strand-addr RPC answers own-party siblings only. After a restart neither
 * relay-only party had any address for the other: the FRET ring and the Optimystic
 * cohort each held only self, the strand reported `active`, local writes
 * succeeded, nothing replicated.
 *
 * NOTE: accepted design boundary (maintainer decision, 2026-09-27) — this is a
 * per-machine record in the machine's own storage, NOT a registry inside the
 * strand database. An in-strand registry (`Strand.MemberPeer` rows carrying
 * addresses) would let a member reach peers it has never connected to while they
 * are offline; nothing needs that today, and it is ruled out for now. Revisit only
 * if a case needs addresses to reach members that are offline.
 *
 * Three implementations mirroring `bootstrap-peer-store.ts` (read that first —
 * same "must outlive the process, storage differs per platform" problem, both
 * persistent forms share `node-local-snapshot.ts`):
 *  - {@link MemoryStrandPeerBookStore} (this module, cross-platform) — ephemeral;
 *    the default when no store is injected via `CadreNodeConfig.strandPeers`. A
 *    node using it is exactly the pre-#18 shape after a restart.
 *  - {@link PersistentStrandPeerBookStore} (this module, cross-platform) — durable
 *    over any `DurableSlot` the embedding app supplies.
 *  - `FileStrandPeerBookStore` — the above over a Node file in the node's state
 *    directory; Node-only, behind the subpath
 *    `@serfab/cadre-core/strand-peer-book-file` (same isolation pattern as
 *    `bootstrap-peer-store-file`) so `node:fs` never lands in the RN/browser graph.
 *
 * One store per NODE holding every strand, rather than one slot per strand: the
 * snapshot machinery writes one slot whole, and a node runs a handful of strands
 * with at most {@link MAX_STRAND_PEERS} peers each — a few KB. The embedder
 * therefore wires one slot, like the other node-local stores.
 *
 * **Nothing here is trust-bearing.** An address grants no authority: the dialed
 * peer authenticates by peer id at the handshake, and every address is bound to
 * the peer id it is filed under (see {@link StrandPeerEntry.addrs}), so a dial
 * cannot be redirected to whoever answers. A junk address costs one failed dial per
 * launch until it ages out or the peer's next connection replaces the entry. What a
 * persistent backend's loader DOES owe is dropping structurally junk entries rather
 * than carrying them into the dial loop.
 */
import debug from 'debug';
import { peerIdFromString } from '@libp2p/peer-id';
import { NodeLocalSnapshot, type DurableSlot, type NodeLocalSnapshotSpec } from './node-local-snapshot.js';
import { groupAddrsByPeerId } from './peer-addr-book.js';
import { orderSignalingFirst } from './peer-record.js';
import { MAX_STRAND_ADDRS } from './strand-formation-protocol.js';

const log = debug('sereus:cadre:strand-peer-book');

/**
 * Cap on the peers remembered per strand. When full, the entry with the smallest
 * `max(issuedAt, lastSeenAt)` is evicted. Sixteen is generous for the parties a
 * strand has today (two, occasionally a few), and it bounds the worst case of a
 * launch dialing dead entries: a failed relayed dial costs up to 14 s at the
 * declared link, so the cap — with aging — is what keeps a stale book from
 * stalling bring-up for minutes.
 */
export const MAX_STRAND_PEERS = 16;

/**
 * Default age after which an entry nobody has refreshed is dropped: 14 days from
 * `max(issuedAt, lastSeenAt)`. A live peer refreshes its entry on every connection,
 * so only a peer this node has not reached in two weeks ages out. Overridable per
 * store via {@link StrandPeerBookOptions.maxAgeMs}.
 */
export const STRAND_PEER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * One strand peer this node knows an address for. `sig` is set only on an entry the
 * peer signed itself and the book swap carried here (`strand-peer-book-protocol.ts`),
 * or on this node's own entry, which the swap files under the node's own strand
 * transport id; a formation-carried or observed entry is unsigned and local-only.
 */
export interface StrandPeerEntry {
	/** The peer's STRAND transport peer id (never a control peer id). */
	peerId: string;
	/**
	 * Multiaddr strings, each bound to `peerId` (trailing `/p2p/<peerId>`, a relay
	 * hop only with that destination behind it), signaling-first, at most
	 * `MAX_STRAND_ADDRS`. Anything that does not attribute to `peerId` is dropped
	 * at merge.
	 */
	addrs: string[];
	/**
	 * Signer's clock, ms: when the peer itself issued these addresses. 0 for an
	 * entry this node observed or was handed unsigned.
	 */
	issuedAt: number;
	/**
	 * base64url Ed25519 signature by the peer's strand transport key over the canonical
	 * JSON of `{ v, strandId, peerId, addrs, issuedAt }` (`signedStrandPeerEntryPayload`);
	 * absent = local-only, never forwarded.
	 */
	sig?: string;
	/**
	 * This node's clock, ms: when it last held a connection to the peer — or, for a
	 * formation-carried entry, when the responder disclosed the addresses live — and 0
	 * for an entry it has never connected to. Local, never on the wire.
	 */
	lastSeenAt: number;
}

export interface StrandPeerBookStore {
	/** Party this store is scoped to. */
	readonly partyId: string;

	/**
	 * Snapshot of one strand's LIVE entries, freshest first
	 * (`max(issuedAt, lastSeenAt)` descending). Empty for an unknown strand. Aged-out
	 * entries are never returned. Every backend copies the entries per call, so the
	 * result is decoupled from later {@link merge} / {@link forget} calls.
	 */
	entries(strandId: string): StrandPeerEntry[];

	/**
	 * Insert or replace by `(strandId, entry.peerId)` under the merge rule
	 * ({@link mergeStrandPeerEntry}): a signed entry never yields to an unsigned
	 * one; between two signed the greater `issuedAt` wins; between two unsigned the
	 * greater `lastSeenAt` wins; `lastSeenAt` is always the max of old and new. Then
	 * the strand's aged-out entries are dropped and, past {@link MAX_STRAND_PEERS},
	 * the stalest evicted.
	 *
	 * Implementations MUST reflect the merge in {@link entries} SYNCHRONOUSLY; the
	 * returned promise tracks durability only. An entry whose peer id does not parse
	 * is logged and dropped rather than thrown — every writer is a best-effort event
	 * handler.
	 */
	merge(strandId: string, entry: StrandPeerEntry): Promise<void>;

	/**
	 * Drop one peer, or the whole strand when `peerId` is omitted — for a strand this
	 * node unpublished or left, whose peers must not stay dial targets. Forgetting
	 * something absent is a no-op. Same contract as {@link merge}: reflected
	 * synchronously, the promise tracks durability.
	 */
	forget(strandId: string, peerId?: string): Promise<void>;
}

/** Tuning shared by every backend. */
export interface StrandPeerBookOptions {
	/** Age after which an unrefreshed entry is dropped. Default {@link STRAND_PEER_MAX_AGE_MS}. */
	maxAgeMs?: number;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
}

/** One strand's peers, keyed by peer id — the unit the persistent envelope stores. */
type StrandPeers = Record<string, StrandPeerEntry>;

interface ResolvedOptions {
	maxAgeMs: number;
	now: () => number;
}

function resolveOptions(options?: StrandPeerBookOptions): ResolvedOptions {
	return { maxAgeMs: options?.maxAgeMs ?? STRAND_PEER_MAX_AGE_MS, now: options?.now ?? Date.now };
}

/** The moment an entry was last vouched for, by whichever clock spoke last. */
export function strandPeerFreshness(entry: StrandPeerEntry): number {
	return Math.max(entry.issuedAt, entry.lastSeenAt);
}

/**
 * The merge rule, in one place. Returns the entry to hold for `incoming.peerId`
 * given what is already held — always a NEW object, so a held entry is never mutated
 * in place (the persistent backend's snapshot `put` replaces rather than patches).
 * `incoming` is assumed sanitized ({@link sanitizeStrandPeerEntry}).
 *
 * - A signed entry never yields to an unsigned one for the same peer: the peer's own
 *   statement outranks this node's observation of it.
 * - Between two signed entries the greater `issuedAt` wins; between two unsigned
 *   entries the greater `lastSeenAt` wins. A tie goes to `incoming`.
 * - `lastSeenAt` is always the max of old and new whichever entry wins, because it
 *   is this node's own observation and no remote statement can lower it.
 */
export function mergeStrandPeerEntry(
	existing: StrandPeerEntry | undefined,
	incoming: StrandPeerEntry
): StrandPeerEntry {
	const winner = existing === undefined || incomingWins(existing, incoming) ? incoming : existing;
	return {
		...winner,
		addrs: [...winner.addrs],
		lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, incoming.lastSeenAt)
	};
}

function incomingWins(existing: StrandPeerEntry, incoming: StrandPeerEntry): boolean {
	if (existing.sig !== undefined && incoming.sig === undefined) return false;
	if (existing.sig === undefined && incoming.sig !== undefined) return true;
	return existing.sig !== undefined
		? incoming.issuedAt >= existing.issuedAt
		: incoming.lastSeenAt >= existing.lastSeenAt;
}

/**
 * Shape an entry for storage: the peer id must parse (else `undefined` — not a dial
 * target at all), and `addrs` is reduced to the entries that attribute to `peerId`
 * under `groupAddrsByPeerId`'s rule, de-duplicated, capped at `MAX_STRAND_ADDRS`, and
 * — for an UNSIGNED entry only — reordered signaling-first. A signed entry keeps the
 * signer's order: its signature covers the address list as signed, and the swap
 * forwards the stored copy, so any reordering here would make every forwarded entry
 * fail verification at the next peer (every signer already orders signaling-first). An
 * entry may legitimately end up with NO addresses — a signed "not reachable right
 * now" from the swap protocol is truthful and displaces a stale reachable list — so
 * an empty list is kept, not rejected.
 */
export function sanitizeStrandPeerEntry(entry: StrandPeerEntry): StrandPeerEntry | undefined {
	try {
		peerIdFromString(entry.peerId);
	} catch (error) {
		log('dropping entry for unparsable peer id %s: %o', entry.peerId, error);
		return undefined;
	}
	const attributed = (groupAddrsByPeerId([...entry.addrs]).get(entry.peerId) ?? []).map((ma) => ma.toString());
	const addrs = (entry.sig === undefined ? orderSignalingFirst(attributed) : attributed).slice(0, MAX_STRAND_ADDRS);
	if (addrs.length < entry.addrs.length) {
		log('peer %s: kept %d of %d addr(s) — the rest do not attribute to it or exceed the cap',
			entry.peerId, addrs.length, entry.addrs.length);
	}
	return {
		peerId: entry.peerId,
		addrs,
		issuedAt: entry.issuedAt,
		...(entry.sig !== undefined && { sig: entry.sig }),
		lastSeenAt: entry.lastSeenAt
	};
}

/**
 * Apply {@link mergeStrandPeerEntry} to one strand's map and re-bound it: aged-out
 * entries dropped, then the stalest evicted past {@link MAX_STRAND_PEERS}. Returns a
 * NEW map (the persistent backend's snapshot `put` replaces rather than mutates),
 * or `undefined` when the incoming entry was unusable and nothing changed.
 *
 * NOTE: aging is time-based only. The book cannot see dial outcomes (dials happen
 * inside libp2p and Optimystic), so a dead entry is re-dialed on every launch and
 * refresh until it ages out or the peer's next connection replaces it — bounded by
 * the peer cap and the 14-day age. If a case ever shows a dead entry re-dialed every
 * tick for two weeks, the lever is observing `connection:close` / dial failures
 * here, not a shorter age.
 */
function mergeIntoStrand(
	strand: StrandPeers | undefined,
	incoming: StrandPeerEntry,
	options: ResolvedOptions
): StrandPeers | undefined {
	const entry = sanitizeStrandPeerEntry(incoming);
	if (!entry) return undefined;
	const merged = mergeStrandPeerEntry(strand?.[entry.peerId], entry);
	// Pruned AFTER the insert, so an incoming entry that is already past the age
	// (a swap forwarding a months-old statement) never lands at all.
	return evictPastCap(pruneAged({ ...strand, [entry.peerId]: merged }, options));
}

/**
 * The strand's map without the entries older than `maxAgeMs` (a new object only when
 * something dropped).
 *
 * Nothing is exempt, the node's OWN entry included: the book swap
 * (`strand-peer-book-swap.ts`) keeps the entry it SENDS in memory and re-signs it on
 * every address change and every launch, so the stored copy is a record for
 * diagnostics and the seed's self-skip, and losing it to age costs nothing. That is
 * why the store need not tell self from a peer.
 */
function pruneAged(strand: StrandPeers, options: ResolvedOptions): StrandPeers {
	const cutoff = options.now() - options.maxAgeMs;
	const live = Object.values(strand).filter((entry) => strandPeerFreshness(entry) >= cutoff);
	return live.length === Object.keys(strand).length ? strand : Object.fromEntries(live.map((e) => [e.peerId, e]));
}

/**
 * Drop the stalest entries until the strand holds at most {@link MAX_STRAND_PEERS}.
 *
 * NOTE: freshness ranks a forwarded statement (signer's `issuedAt`, up to five minutes
 * ahead of this clock) above a peer this node has itself connected to, so one swap
 * frame of sixteen fresh self-signed entries evicts every met peer — see
 * `backlog/debt-strand-peer-book-remote-write-bounds`.
 */
function evictPastCap(strand: StrandPeers): StrandPeers {
	const entries = Object.values(strand);
	if (entries.length <= MAX_STRAND_PEERS) return strand;
	const kept = sortFreshestFirst(entries).slice(0, MAX_STRAND_PEERS);
	log('evicting %d stalest peer(s) past the %d-peer cap', entries.length - kept.length, MAX_STRAND_PEERS);
	return Object.fromEntries(kept.map((e) => [e.peerId, e]));
}

function sortFreshestFirst(entries: StrandPeerEntry[]): StrandPeerEntry[] {
	return [...entries].sort((a, b) => strandPeerFreshness(b) - strandPeerFreshness(a));
}

/** The live entries of one strand, freshest first, copied. */
function liveEntries(strand: StrandPeers | undefined, options: ResolvedOptions): StrandPeerEntry[] {
	if (!strand) return [];
	return sortFreshestFirst(Object.values(pruneAged(strand, options)))
		.map((entry) => ({ ...entry, addrs: [...entry.addrs] }));
}

/** The strand's map without `peerId`, or `undefined` when that leaves nothing (or nothing was there). */
function withoutPeer(strand: StrandPeers | undefined, peerId: string): StrandPeers | undefined {
	if (!strand || !(peerId in strand)) return strand;
	const { [peerId]: _dropped, ...rest } = strand;
	return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * Ephemeral in-memory book for nodes without durable storage (tests, and the
 * default when nothing is injected). Same contract, no disk: a node using this
 * forgets every strand peer on restart — the #18 shape.
 */
export class MemoryStrandPeerBookStore implements StrandPeerBookStore {
	private readonly strands = new Map<string, StrandPeers>();
	private readonly options: ResolvedOptions;

	constructor(readonly partyId: string, options?: StrandPeerBookOptions) {
		this.options = resolveOptions(options);
	}

	entries(strandId: string): StrandPeerEntry[] {
		return liveEntries(this.strands.get(strandId), this.options);
	}

	async merge(strandId: string, entry: StrandPeerEntry): Promise<void> {
		const next = mergeIntoStrand(this.strands.get(strandId), entry, this.options);
		if (next) {
			this.strands.set(strandId, next);
			log('strand %s: peer %s merged (party=%s, addrs=%d)', strandId, entry.peerId, this.partyId, entry.addrs.length);
		}
	}

	async forget(strandId: string, peerId?: string): Promise<void> {
		if (peerId === undefined) {
			if (this.strands.delete(strandId)) {
				log('strand %s: book forgotten (party=%s)', strandId, this.partyId);
			}
			return;
		}
		const next = withoutPeer(this.strands.get(strandId), peerId);
		if (next === undefined) {
			this.strands.delete(strandId);
		} else {
			this.strands.set(strandId, next);
		}
	}
}

/**
 * What the store persists: `strands` maps strandId -> (peerId -> {@link StrandPeerEntry}).
 *
 * A structurally junk PEER entry is dropped and its siblings retained; a strand
 * whose value is not a record, or that holds no usable peer, is dropped as a whole
 * (`drop-entry`) — nothing here is trust-bearing (see the module comment) and the
 * book is a restarted node's only way back to the other parties, so discarding the
 * whole set over one bad entry would be strictly worse. What "junk" means: a peer id
 * that does not parse, a non-array or non-string address list, a non-number
 * `issuedAt` / `lastSeenAt`, or a non-string `sig`. Aged-out entries are dropped at
 * load too, so a slot last written months ago yields nothing to dial.
 */
function strandPeerBookSnapshotSpec(options: ResolvedOptions): NodeLocalSnapshotSpec<StrandPeers> {
	return {
		label: 'strand peer book',
		payloadKey: 'strands',
		unusableEntry: 'drop-entry',
		acceptEntry: (strandId, raw) => {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
			let strand: StrandPeers = {};
			for (const [peerId, value] of Object.entries(raw as Record<string, unknown>)) {
				const entry = acceptPeerEntry(peerId, value);
				if (!entry) {
					log('strand %s: dropping unusable persisted entry for %s', strandId, peerId);
					continue;
				}
				strand[peerId] = entry;
			}
			strand = pruneAged(strand, options);
			return Object.keys(strand).length === 0 ? undefined : strand;
		}
	};
}

function acceptPeerEntry(peerId: string, value: unknown): StrandPeerEntry | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { addrs, issuedAt, sig, lastSeenAt } = value as Record<string, unknown>;
	if (!Array.isArray(addrs) || addrs.some((addr) => typeof addr !== 'string' || addr.length === 0)) return undefined;
	if (typeof issuedAt !== 'number' || typeof lastSeenAt !== 'number') return undefined;
	if (sig !== undefined && typeof sig !== 'string') return undefined;
	return sanitizeStrandPeerEntry({
		peerId,
		addrs: addrs as string[],
		issuedAt,
		...(sig !== undefined && { sig }),
		lastSeenAt
	});
}

/**
 * Durable {@link StrandPeerBookStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileStrandPeerBookStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent, corrupt,
 * foreign-party or unreadable slot does (the last one THROWS, as
 * `PersistentBootstrapPeerStore.open` does), and what a failed persist does — is
 * documented once on `NodeLocalSnapshot`; this class only supplies the payload shape
 * and the drop-the-bad-entry policy above. Writes are serialised in-process by the
 * snapshot's write chain, so several strands' identify handlers merging at once
 * cannot interleave partial snapshots.
 */
export class PersistentStrandPeerBookStore implements StrandPeerBookStore {
	private constructor(
		private readonly snapshot: NodeLocalSnapshot<StrandPeers>,
		private readonly options: ResolvedOptions
	) {}

	/** Load (or cold-start) the party's book from `slot`. */
	static async open(
		slot: DurableSlot,
		partyId: string,
		options?: StrandPeerBookOptions
	): Promise<PersistentStrandPeerBookStore> {
		const resolved = resolveOptions(options);
		return new PersistentStrandPeerBookStore(
			await NodeLocalSnapshot.open(slot, partyId, strandPeerBookSnapshotSpec(resolved)),
			resolved
		);
	}

	get partyId(): string {
		return this.snapshot.partyId;
	}

	entries(strandId: string): StrandPeerEntry[] {
		return liveEntries(this.snapshot.entrySnapshot().get(strandId), this.options);
	}

	/** Merge, visible via {@link entries} synchronously, then the full snapshot is persisted. */
	merge(strandId: string, entry: StrandPeerEntry): Promise<void> {
		const next = mergeIntoStrand(this.snapshot.entrySnapshot().get(strandId), entry, this.options);
		if (!next) return Promise.resolve();
		log('strand %s: peer %s merged (party=%s, addrs=%d); persisting',
			strandId, entry.peerId, this.partyId, entry.addrs.length);
		return this.snapshot.put(strandId, next);
	}

	/** Forget, gone from {@link entries} synchronously, then persisted — unless nothing was there. */
	forget(strandId: string, peerId?: string): Promise<void> {
		if (peerId === undefined) {
			if (this.snapshot.has(strandId)) {
				log('strand %s: book forgotten (party=%s); persisting', strandId, this.partyId);
			}
			return this.snapshot.remove(strandId);
		}
		const current = this.snapshot.entrySnapshot().get(strandId);
		const next = withoutPeer(current, peerId);
		if (next === current) return Promise.resolve();
		return next === undefined ? this.snapshot.remove(strandId) : this.snapshot.put(strandId, next);
	}
}
