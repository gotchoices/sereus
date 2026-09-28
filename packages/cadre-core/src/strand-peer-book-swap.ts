/**
 * The per-strand driver of the strand peer book SWAP (`strand-peer-book-protocol.ts`
 * has the wire format, the signatures and the reasons): one of these per running
 * strand, armed on the strand's libp2p node right after it exists and released with
 * it, so a hibernation wake re-arms one on the rebuilt node. It owns three things:
 *
 * - **This node's own signed entry.** Built from the node's own bound addresses
 *   (`dialableAddrs`, the binding the observer applies to a remote), stamped with the
 *   local clock, signed with the strand transport key, and filed in the book under
 *   the node's own peer id. Signed at arm time and RE-SIGNED whenever the address set
 *   changes — `self:peer:update`, debounced because a relay reservation landing fires
 *   it more than once — which is what makes a rotation propagate. An unchanged
 *   address set is deliberately not re-signed on a timer: freshness is about change,
 *   and a periodic re-sign would only make every peer rewrite its slot.
 * - **The receiver**, registered through `node.handle` so a closed strand's revocation
 *   gate judges every inbound stream first.
 * - **The exchanges.** One when a strand peer is identified (the same `peer:identify`
 *   + `speaksBlockTransfer` gate the observer and the peer-join catch-up use, plus
 *   "lists the swap protocol", so an older node is skipped rather than dialed),
 *   throttled to one per peer per {@link STRAND_PEER_BOOK_SWAP_THROTTLE_MS}; and one
 *   with EVERY connected strand peer whenever the own entry is re-signed, unthrottled,
 *   so a rotation reaches everyone while connections are up. Both sides do this, so
 *   one connection produces two small exchanges; accepted as simpler than electing an
 *   initiator. A failed exchange is logged, never fatal, and never retried before the
 *   throttle expires.
 *
 * What lands in the book: the sender's own statement is filed as seen now (there is a
 * live connection to it); a forwarded third party's is filed as never seen, so it ages
 * from the signer's `issuedAt` alone. The store's merge rule does the rest — a signed
 * entry displaces an unsigned observation, and between two signed the greater
 * `issuedAt` wins — so a stale forward never displaces a fresher statement already
 * held. The seed and refresh read the book unchanged: a forwarded third party is
 * dialed like any other peer, and a rotated peer's newer addresses displace its old.
 *
 * The own entry the node SENDS is the in-memory one, never re-read from the store, so
 * the store's aging cannot lose it; the stored copy is a record for diagnostics and
 * the seed's self-skip. Nothing here throws into a libp2p event handler.
 */
import debug from 'debug';
import type { Connection, IdentifyResult, Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
import { circuitRequestBudgetMs } from './link-budget.js';
import { speaksBlockTransfer } from './peer-join-backfill.js';
import { MAX_STRAND_PEERS, type StrandPeerBookStore } from './strand-peer-book.js';
import {
	STRAND_PEER_BOOK_PROTOCOL,
	StrandPeerBookService,
	exchangeStrandPeerBook,
	signStrandPeerEntry,
	type SignedStrandPeerEntry,
	type StrandPeerBookFrame
} from './strand-peer-book-protocol.js';
import { connectedIdentifiedPeers, dialableAddrs } from './strand-peer-observer.js';

const log = debug('sereus:cadre:strand-peer-book-swap');

/** Minimum gap between two exchanges with ONE peer, unless this node's own entry was re-signed. */
export const STRAND_PEER_BOOK_SWAP_THROTTLE_MS = 10 * 60 * 1000;

/** How long after the last `self:peer:update` the own entry is rebuilt — the event fires in bursts. */
export const OWN_ENTRY_RESIGN_DEBOUNCE_MS = 1000;

/**
 * Bytes allowance on top of the link round trips in the exchange deadline. A frame is
 * at most 64 KiB, so this is a token, not the 1 MiB push allowance.
 */
const SWAP_TRANSFER_ALLOWANCE_MS = 1000;

export interface StrandPeerBookSwapDeps {
	strandId: string;
	/** The strand's libp2p node. */
	libp2p: Libp2p;
	/** This strand network's `/optimystic/<networkName>` prefix — the block-transfer gate. */
	protocolPrefix: string;
	/** The node-local book this strand's entries live in. */
	store: StrandPeerBookStore;
	/**
	 * The strand transport key the node runs under. Absent — or not the node's own
	 * key — means no own entry is signed; the node still receives and forwards.
	 */
	privateKey?: PrivateKey;
	/** The host's declared link round trip, for the exchange deadline (`link-budget.ts`). */
	linkRoundTripMs?: number;
}

export interface StrandPeerBookSwapOptions {
	/** Default {@link STRAND_PEER_BOOK_SWAP_THROTTLE_MS}. */
	throttleMs?: number;
	/** Default {@link OWN_ENTRY_RESIGN_DEBOUNCE_MS}. */
	debounceMs?: number;
	/** Whole-exchange deadline; default derived from `linkRoundTripMs`. */
	timeoutMs?: number;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
}

export class StrandPeerBookSwap {
	private readonly service: StrandPeerBookService;
	private readonly selfPeerId: string;
	private readonly signingKey: PrivateKey | undefined;
	private readonly throttleMs: number;
	private readonly debounceMs: number;
	private readonly timeoutMs: number;
	private readonly now: () => number;
	/** Last exchange per peer id, for the throttle. */
	private readonly exchangedAt = new Map<string, number>();
	/** Peers with an exchange in flight, so identify and a walk cannot double up. */
	private readonly inFlight = new Set<string>();
	private own: SignedStrandPeerEntry | undefined;
	/** The address set the own entry was signed over, canonicalised for comparison. */
	private ownAddrKey: string | undefined;
	/** Serialises own-entry refreshes: a burst of triggers signs at most once per change. */
	private selfChain: Promise<void> = Promise.resolve();
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onPeerIdentify: (evt: CustomEvent<IdentifyResult>) => void;
	private readonly onSelfUpdate: () => void;
	private started = false;
	private stopped = false;

	constructor(private readonly deps: StrandPeerBookSwapDeps, options?: StrandPeerBookSwapOptions) {
		this.selfPeerId = deps.libp2p.peerId.toString();
		this.signingKey = usableSigningKey(deps.privateKey, this.selfPeerId, deps.strandId);
		this.throttleMs = options?.throttleMs ?? STRAND_PEER_BOOK_SWAP_THROTTLE_MS;
		this.debounceMs = options?.debounceMs ?? OWN_ENTRY_RESIGN_DEBOUNCE_MS;
		this.timeoutMs = options?.timeoutMs ?? circuitRequestBudgetMs(deps.linkRoundTripMs, SWAP_TRANSFER_ALLOWANCE_MS);
		this.now = options?.now ?? Date.now;
		this.service = new StrandPeerBookService({
			strandId: deps.strandId,
			selfPeerId: this.selfPeerId,
			localEntries: (forPeerId) => this.frameFor(forPeerId).entries,
			onEntries: (entries, fromPeerId) => this.accept(entries, fromPeerId),
			readTimeoutMs: this.timeoutMs,
			now: this.now
		});
		this.onPeerIdentify = (evt) => {
			const { peerId, protocols, connection } = evt.detail;
			if (this.isSwapPeer(peerId, protocols)) {
				void this.exchangeWith(peerId, connection, false, 'identify');
			}
		};
		this.onSelfUpdate = () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = undefined;
				this.queueSelfRefresh('self:peer:update');
			}, this.debounceMs);
		};
	}

	/** This node's current signed entry, or `undefined` before the first signing or without a key. */
	get ownEntry(): SignedStrandPeerEntry | undefined {
		return this.own;
	}

	/**
	 * Register the receiver, subscribe, sign the own entry, and exchange with the strand
	 * peers already connected — identify for an early peer may have fired before this
	 * object existed.
	 */
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.deps.libp2p.addEventListener('peer:identify', this.onPeerIdentify);
		this.deps.libp2p.addEventListener('self:peer:update', this.onSelfUpdate);
		void this.service.initialize(this.deps.libp2p).catch((error: unknown) => {
			log('[%s] registering the swap handler failed — this node answers no swaps: %o', this.deps.strandId, error);
		});
		this.queueSelfRefresh('start');
	}

	/** Unsubscribe and unregister; an exchange in flight finishes on its own. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		if (this.started) {
			this.deps.libp2p.removeEventListener('peer:identify', this.onPeerIdentify);
			this.deps.libp2p.removeEventListener('self:peer:update', this.onSelfUpdate);
		}
		try {
			await this.service.shutdown();
		} catch (error) {
			log('[%s] unregistering the swap handler failed (ignored): %o', this.deps.strandId, error);
		}
		this.exchangedAt.clear();
		log('[%s] stopped', this.deps.strandId);
	}

	/** A strand peer that also speaks the swap; never self. */
	private isSwapPeer(peerId: PeerId, protocols: string[]): boolean {
		if (peerId.toString() === this.selfPeerId || !speaksBlockTransfer(protocols, this.deps.protocolPrefix)) {
			return false;
		}
		if (!protocols.includes(STRAND_PEER_BOOK_PROTOCOL)) {
			log('[%s] strand peer %s does not speak the swap (older node) — not dialing it', this.deps.strandId, peerId.toString());
			return false;
		}
		return true;
	}

	private queueSelfRefresh(reason: string): void {
		this.selfChain = this.selfChain
			.then(() => this.refreshSelf(reason))
			.catch((error: unknown) => log('[%s] own-entry refresh (%s) failed: %o', this.deps.strandId, reason, error));
	}

	/** Re-sign the own entry if the address set changed, then exchange — unthrottled after a re-sign. */
	private async refreshSelf(reason: string): Promise<void> {
		if (this.stopped) return;
		const resigned = await this.refreshOwnEntry(reason);
		await this.exchangeWithConnected(resigned, reason);
	}

	/** Returns whether a new own entry was signed. */
	private async refreshOwnEntry(reason: string): Promise<boolean> {
		if (!this.signingKey) return false;
		const addrs = dialableAddrs(this.selfPeerId, this.deps.libp2p.getMultiaddrs(), []);
		const addrKey = [...addrs].sort().join('\n');
		if (addrKey === this.ownAddrKey) return false;
		// Strictly increasing even when two changes land in one clock tick, so the
		// receiver's "greater issuedAt wins" always prefers the later statement.
		const issuedAt = Math.max(this.now(), (this.own?.issuedAt ?? 0) + 1);
		const entry = await signStrandPeerEntry(this.signingKey, this.deps.strandId, addrs, issuedAt);
		if (this.stopped) return false;
		this.own = entry;
		this.ownAddrKey = addrKey;
		this.remember(entry, this.now());
		log('[%s] own entry signed (%s): %d addr(s), issuedAt=%d', this.deps.strandId, reason, addrs.length, issuedAt);
		return true;
	}

	/** Exchange with every connected, identified strand peer that speaks the swap. */
	private async exchangeWithConnected(bypassThrottle: boolean, reason: string): Promise<void> {
		const peers = await connectedIdentifiedPeers(this.deps.libp2p, this.deps.strandId);
		await Promise.all(peers
			.filter(({ peerId, protocols }) => this.isSwapPeer(peerId, protocols))
			.map(({ peerId, connections }) => this.exchangeWith(peerId, connections[0], bypassThrottle, reason)));
	}

	/** One exchange with one peer over `connection`, throttled unless told otherwise. Never throws. */
	private async exchangeWith(peerId: PeerId, connection: Connection, bypassThrottle: boolean, reason: string): Promise<void> {
		if (this.stopped) return;
		const id = peerId.toString();
		if (this.inFlight.has(id)) return;
		const now = this.now();
		const last = this.exchangedAt.get(id);
		if (!bypassThrottle && last !== undefined && now - last < this.throttleMs) return;
		this.exchangedAt.set(id, now);
		this.inFlight.add(id);
		try {
			const request = this.frameFor(id);
			const received = await exchangeStrandPeerBook(connection, request, {
				selfPeerId: this.selfPeerId,
				timeoutMs: this.timeoutMs,
				now: this.now
			});
			this.accept(received, id);
			log('[%s] swapped with %s (%s): sent %d, received %d', this.deps.strandId, id, reason, request.entries.length, received.length);
		} catch (error) {
			log('[%s] swap with %s (%s) failed — next try after the throttle: %o', this.deps.strandId, id, reason, error);
		} finally {
			this.inFlight.delete(id);
		}
	}

	/**
	 * What this node sends `remotePeerId`: its own entry first, then every signed entry
	 * held for anyone else, freshest first, minus the recipient's own — capped at the
	 * frame's entry limit (the own entry can push the store's cap over by one).
	 */
	private frameFor(remotePeerId: string): StrandPeerBookFrame {
		const entries: SignedStrandPeerEntry[] = this.own ? [this.own] : [];
		for (const held of this.deps.store.entries(this.deps.strandId)) {
			if (entries.length >= MAX_STRAND_PEERS) break;
			if (held.sig === undefined || held.peerId === this.selfPeerId || held.peerId === remotePeerId) continue;
			entries.push({ peerId: held.peerId, addrs: held.addrs, issuedAt: held.issuedAt, sig: held.sig });
		}
		return { strandId: this.deps.strandId, entries };
	}

	/** File verified entries: the sender's own as seen now, a forwarded third party's as never seen. */
	private accept(entries: SignedStrandPeerEntry[], fromPeerId: string): void {
		const now = this.now();
		for (const entry of entries) {
			this.remember(entry, entry.peerId === fromPeerId ? now : 0);
		}
	}

	/** Fire-and-log, like every book write: visible synchronously, the promise tracks durability. */
	private remember(entry: SignedStrandPeerEntry, lastSeenAt: number): void {
		void this.deps.store.merge(this.deps.strandId, { ...entry, lastSeenAt }).catch((error: unknown) => {
			log('[%s] persisting entry for %s failed (continuing): %o', this.deps.strandId, entry.peerId, error);
		});
	}
}

/** The key, if it is Ed25519 and actually the node's own; else `undefined`, logged. */
function usableSigningKey(privateKey: PrivateKey | undefined, selfPeerId: string, strandId: string): PrivateKey | undefined {
	if (!privateKey) {
		log('[%s] no strand transport key — no own entry will be signed', strandId);
		return undefined;
	}
	if (privateKey.type !== 'Ed25519' || privateKey.publicKey.toString() !== selfPeerId) {
		log('[%s] the supplied key is not this node\'s Ed25519 transport key — no own entry will be signed', strandId);
		return undefined;
	}
	return privateKey;
}
