/**
 * The strand peer book's OBSERVATION writer: on one strand libp2p node, every peer
 * whose identify result names this strand's block-transfer protocol — a strand peer,
 * never the circuit relay or a bootstrap node ({@link speaksBlockTransfer}, the
 * same gate `PeerJoinBackfill` schedules on) — is reported with its dialable
 * addresses, so `CadreNode` can merge an unsigned book entry for it
 * (`strand-peer-book.ts`). That is what lets a restarted machine dial the peers it
 * was talking to, instead of only the ones a formation once carried back.
 *
 * Dialable addresses are the peer's announced `listenAddrs` from the identify
 * result, plus the open connection's `remoteAddr` when it is relayed
 * (`/p2p-circuit`) — a relay-only peer announces its circuit listener, but the
 * address this node actually reached it on is the one proven to work. Every
 * address is bound to the peer id (`withTrailingPeerId`), ordered signaling-first
 * and capped like a formation's list, so the book files it under the right peer.
 *
 * Throttled to one report per peer per {@link STRAND_PEER_OBSERVE_THROTTLE_MS}
 * unless the address set changed, so a flapping relayed connection — identify
 * fires on every reconnect, every 16 s at worst — does not rewrite the node-local
 * slot each time. Best-effort throughout: nothing here throws into a libp2p event
 * handler.
 *
 * Lifecycle: one observer per running strand, armed in
 * `StrandInstanceManager.buildStrandRuntime` right after the libp2p node exists
 * (the bootstrap dials that follow `libp2p.start()` are exactly the peers worth
 * observing) and stopped in `releaseRuntime`, so a hibernation wake re-arms it on
 * the rebuilt node. `start` also walks the peers already connected, because
 * identify may have completed for an early peer before this object existed.
 */
import debug from 'debug';
import type { Connection, IdentifyResult, Libp2p, PeerId } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { speaksBlockTransfer } from './peer-join-backfill.js';
import { isSignalingAddr, orderSignalingFirst, withTrailingPeerId } from './peer-record.js';
import { MAX_STRAND_ADDRS } from './strand-formation-protocol.js';

const log = debug('sereus:cadre:strand-peer-observer');

/** Minimum gap between two reports of ONE peer with an unchanged address set. */
export const STRAND_PEER_OBSERVE_THROTTLE_MS = 10 * 60 * 1000;

/** One strand peer seen live: its strand transport peer id and the addresses it is dialable at. */
export interface StrandPeerObservation {
	peerId: string;
	/** Bound to `peerId`, signaling-first, at most `MAX_STRAND_ADDRS`. */
	addrs: string[];
}

export interface StrandPeerObserverDeps {
	/** For logs (the strand id). */
	label: string;
	/** The strand's libp2p node. */
	libp2p: Libp2p;
	/** This strand network's `/optimystic/<networkName>` prefix — the block-transfer gate. */
	protocolPrefix: string;
	/** Called for every (throttled) observation; must not throw. */
	onObserved: (observation: StrandPeerObservation) => void;
}

export interface StrandPeerObserverOptions {
	/** Default {@link STRAND_PEER_OBSERVE_THROTTLE_MS}. */
	throttleMs?: number;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
}

interface LastReport {
	at: number;
	/** The address set reported, canonicalised for comparison. */
	key: string;
}

/**
 * Anything that prints as a multiaddr. libp2p's identify result and peer store hand
 * back its nested `@multiformats/multiaddr` copy, a structurally different type from
 * this package's, so addresses are taken by their string form and re-parsed here.
 */
export interface AddrLike {
	toString(): string;
}

/** One connected peer as the peer store knows it: what identify recorded, plus its open connections. */
export interface ConnectedIdentifiedPeer {
	peerId: PeerId;
	protocols: string[];
	/** The stored addresses: identify-announced, plus whatever else was merged in. */
	addrs: AddrLike[];
	connections: Connection[];
}

/**
 * Every peer `libp2p` holds a connection to AND has already identified (it is in the
 * peer store), grouped per peer. A connected peer whose identify has not finished is
 * left out: its `peer:identify` event is still to come, and every listener that walks
 * this list at start subscribes to that event too. Shared by the peer-book observer
 * and the book swap (`strand-peer-book-swap.ts`), which both arm right after the
 * node exists and may already have missed an early peer's identify.
 */
export async function connectedIdentifiedPeers(libp2p: Libp2p, label: string): Promise<ConnectedIdentifiedPeer[]> {
	const byPeer = new Map<string, { peerId: PeerId; connections: Connection[] }>();
	for (const connection of libp2p.getConnections()) {
		const key = connection.remotePeer.toString();
		const group = byPeer.get(key) ?? { peerId: connection.remotePeer, connections: [] };
		group.connections.push(connection);
		byPeer.set(key, group);
	}
	const identified = await Promise.all([...byPeer.values()].map(async ({ peerId, connections }): Promise<ConnectedIdentifiedPeer | undefined> => {
		try {
			const peer = await libp2p.peerStore.get(peerId);
			return { peerId, protocols: peer.protocols, addrs: peer.addresses.map((a) => a.multiaddr), connections };
		} catch (error) {
			// NotFoundError: identify has not finished; the event handler will see it.
			if ((error as Error).name !== 'NotFoundError') {
				log('[%s] peer store read for %s failed — skipping it: %o', label, peerId.toString(), error);
			}
			return undefined;
		}
	}));
	return identified.filter((peer): peer is ConnectedIdentifiedPeer => peer !== undefined);
}

export class StrandPeerObserver {
	private readonly throttleMs: number;
	private readonly now: () => number;
	private readonly lastReports = new Map<string, LastReport>();
	private readonly onPeerIdentify: (evt: CustomEvent<IdentifyResult>) => void;
	private started = false;
	private stopped = false;

	constructor(private readonly deps: StrandPeerObserverDeps, options?: StrandPeerObserverOptions) {
		this.throttleMs = options?.throttleMs ?? STRAND_PEER_OBSERVE_THROTTLE_MS;
		this.now = options?.now ?? Date.now;
		this.onPeerIdentify = (evt) => {
			const { peerId, protocols, listenAddrs, connection } = evt.detail;
			if (speaksBlockTransfer(protocols, this.deps.protocolPrefix)) {
				this.observe(peerId, listenAddrs, [connection]);
			}
		};
	}

	/** Subscribe to `peer:identify` and report the peers already connected and identified. */
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.deps.libp2p.addEventListener('peer:identify', this.onPeerIdentify);
		void this.observeConnectedPeers().then((seen) => {
			log('[%s] started (%d peer(s) already connected)', this.deps.label, seen);
		});
	}

	/** Unsubscribe; later identify results are ignored. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.started) {
			this.deps.libp2p.removeEventListener('peer:identify', this.onPeerIdentify);
		}
		this.lastReports.clear();
		log('[%s] stopped', this.deps.label);
	}

	/**
	 * Report every connected peer the peer store already knows speaks this strand's
	 * protocol, with its stored addresses. A peer not yet in the store (identify has
	 * not finished) is left to the `peer:identify` handler. Returns the number of
	 * identified peers considered.
	 *
	 * NOTE: the stored addresses include what `CadreNode.mergeStrandPeerAddrs` merged
	 * INTO the peer store from the book, so this walk can re-vouch a dead address the
	 * book already held, until the peer's next `peer:identify` replaces the set with
	 * what it announces now. Bounded by the address cap; if a dead address ever shows
	 * up surviving across resumes, read only the peer store's identify-sourced
	 * addresses here rather than shortening the age.
	 */
	private async observeConnectedPeers(): Promise<number> {
		const peers = await connectedIdentifiedPeers(this.deps.libp2p, this.deps.label);
		for (const { peerId, protocols, addrs, connections } of peers) {
			if (!this.stopped && speaksBlockTransfer(protocols, this.deps.protocolPrefix)) {
				this.observe(peerId, addrs, connections);
			}
		}
		return peers.length;
	}

	/** Shape, throttle and report one peer. Never throws. */
	private observe(peerId: PeerId, listenAddrs: AddrLike[], connections: Connection[]): void {
		if (this.stopped) return;
		const id = peerId.toString();
		// Identify is about remotes, so self never arrives here; belt and braces, since
		// a node must never file its own addresses as a peer to dial.
		if (id === this.deps.libp2p.peerId.toString()) return;
		try {
			const addrs = dialableAddrs(id, listenAddrs, connections);
			if (!this.shouldReport(id, addrs)) return;
			log('[%s] observed strand peer %s at %d addr(s)', this.deps.label, id, addrs.length);
			this.deps.onObserved({ peerId: id, addrs });
		} catch (error) {
			log('[%s] observing %s failed (ignored): %o', this.deps.label, id, error);
		}
	}

	/** One report per peer per throttle window, unless the address set changed. */
	private shouldReport(peerId: string, addrs: string[]): boolean {
		const now = this.now();
		const key = [...addrs].sort().join('\n');
		const last = this.lastReports.get(peerId);
		if (last && last.key === key && now - last.at < this.throttleMs) {
			return false;
		}
		this.lastReports.set(peerId, { at: now, key });
		return true;
	}
}

/**
 * The addresses to file for `peerId`: its announced listen addrs plus every relayed
 * connection addr, each bound to `peerId`, de-duplicated, signaling-first, capped.
 * Re-parsed through this package's own `multiaddr` (see {@link AddrLike}).
 */
export function dialableAddrs(peerId: string, listenAddrs: AddrLike[], connections: Connection[]): string[] {
	const candidates = [
		...listenAddrs.map((ma) => ma.toString()),
		...connections.map((c) => c.remoteAddr.toString()).filter(isSignalingAddr)
	];
	const bound = new Set<string>();
	for (const candidate of candidates) {
		const addr = withTrailingPeerId(multiaddr(candidate), peerId);
		if (addr === null) {
			log('dropping addr %s — it names a peer other than %s', candidate, peerId);
			continue;
		}
		bound.add(addr.toString());
	}
	return orderSignalingFirst([...bound]).slice(0, MAX_STRAND_ADDRS);
}
