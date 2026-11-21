/**
 * Replace a relayed connection with a direct WebRTC one, in the background, once a peer's
 * addresses are known.
 *
 * Nothing else does this. js-libp2p never upgrades a relayed connection to WebRTC by itself, and
 * DCUtR — its hole-punching service — does not use WebRTC. Since every dial a caller WAITS on
 * goes relayed-first (`docs/network/relay.md` → "Direct connections over WebRTC"), a WebRTC
 * connection no longer opens as a side effect of some dial happening to try the WebRTC address
 * first either, so without this module two machines that reached each other through a relay stay
 * on it for good even when ICE could connect them directly.
 *
 * Direct is worth having when it works. A 1 MB strand write measured 2.4-3.2 s direct against
 * 3.8 s relayed (gotchoices/sereus#61, both on a loopback relay and through `relay.sereus.org`),
 * a phone and a node on one LAN opened directly in about 0.5 s, and the bytes come off the relay.
 *
 * ## The trigger
 *
 * `peer:identify`, not `connection:open`: identify is when the remote's listen addresses are
 * known, and its WebRTC address is the thing being dialed. libp2p dispatches the event for each
 * new connection AND for every identify-push, so a peer that only gains its WebRTC address later
 * (its relay reservation landed after the connection opened) is re-evaluated when it pushes.
 *
 * NOTE: those two are the ONLY re-evaluations — libp2p runs identify per new connection and on a
 * push, never on a timer — so a direct connection that drops while the relayed one beside it
 * survives is not replaced until that peer reconnects or pushes addresses
 * (`docs/network/relay.md` → "Limits and accepted tradeoffs"). Add `connection:close` as a
 * second trigger if peers are seen stuck relayed after a direct connection dropped.
 *
 * It also decides the reach of the whole service, since Optimystic names each node's identify
 * protocol after the network it serves. Two parties' STRAND nodes share one namespace
 * (`/optimystic/strand-<strandId>/id/1.0.0`) and identify each other, which is where this matters
 * most — a strand's peers are other parties' machines, so both sides are often behind NAT. Two
 * parties' CONTROL nodes do not, so on the control network only a party's own machines, and a
 * device redeeming an invitation into the party, are ever candidates.
 *
 * An attempt is made when all of {@link decideWebrtcUpgrade}'s conditions hold. The one that is
 * NOT a condition is worth stating: the relay's own traffic limit. An upgrade over a CAPPED
 * relayed connection — one libp2p marks `limited` — is attempted on the same terms as any other,
 * because there the direct path is the only one Optimystic's database protocols can use at all
 * (`ops/docs/ice-servers.md` → "Why there is no TURN"). The signalling stream `@libp2p/webrtc`
 * opens is declared `runOnLimitedConnection`, so it is allowed on such a connection.
 *
 * ## Which side dials
 *
 * Exactly one, so that two upgrades do not cross: the side with the lower peer id when both
 * advertise a WebRTC address, and otherwise whichever side has a WebRTC address to dial. A
 * dialer needs the WebRTC transport, not a `/webrtc` listener, which is why "this side advertises
 * none" does not stop it.
 *
 * NOTE: the tie-break is judged from each side's CURRENT addresses, so in the window where one
 * side advertises a WebRTC address and the other does not yet, both can decide they are the
 * dialer and two WebRTC connections can open. Harmless — libp2p holds both and new streams take
 * one of them — and it closes as soon as the two sides see the same pair of address sets. If
 * duplicate upgrade connections are ever seen lingering, close the one whose dial this side lost.
 *
 * ## The dial
 *
 * One address per attempt — the first WebRTC address in identify order — through
 * {@link dialAddr}, the queue-free per-address dial, rather than `node.dial`. Three reasons, all
 * of which matter here:
 *
 * - libp2p's dial queue joins any dial to a queued job for the same peer id, whatever address the
 *   new dial names. Through the queue an upgrade dial can therefore be answered by someone else's
 *   relayed dial of the same peer and report a success that upgraded nothing.
 * - {@link dialAddr} does not hand back an open relayed connection for a WebRTC address, which is
 *   the rule libp2p applies too and what lets the attempt replace the link rather than resolve to
 *   it. An open DIRECT connection is handed back, which is the correct short-circuit.
 * - It aborts on the node's own `stop`, so a node torn down mid-attempt leaves nothing dialing.
 *
 * The attempt is bounded by {@link WebrtcUpgradeDeps.dialTimeoutMs}, derived from the host's
 * declared link (`link-budget.ts` → `webrtcUpgradeDialBudgetMs`) and deliberately longer than
 * the WebRTC stack's own give-up time: nothing waits on this dial, so cutting off a working
 * attempt would be the only way to lose by it.
 *
 * ## After a success, the relayed connection is left open
 *
 * Closing it would race the streams already on it, and nothing needs it closed: new streams
 * already prefer the direct connection. libp2p's `findExistingConnection` sorts direct
 * connections first, and Optimystic's stream paths try non-limited connections newest first.
 *
 * NOTE: Optimystic groups connections by limited/unlimited rather than by direct/relayed
 * (`../optimystic/packages/db-p2p/src/network/open-protocol-stream.ts`), so if the relayed
 * connection is later re-opened it becomes the newest unlimited one and wins again, and the
 * strand's traffic goes back over the relay while a direct connection sits open beside it. Not
 * reachable from here — the relayed connection that triggered the upgrade is older than the
 * WebRTC one, and that order only inverts if it drops and is re-dialed. If it shows up, ask
 * Optimystic to rank direct connections ahead of unlimited relayed ones rather than closing the
 * relayed connection here.
 *
 * ## Backoff
 *
 * Per remote peer per node, in memory: the ladder {@link nextWebrtcUpgradeBackoffMs} states,
 * cleared by a success. Two networks that
 * allow no direct path between them fail every single time, and each attempt costs relay
 * signalling plus ICE gathering, which wakes a phone's radio. Nothing is persisted: a restart
 * starting over is one attempt per peer, which is what a restart should try anyway.
 *
 * NOTE: the backoff map holds one entry per peer ever attempted, for the life of the node, and
 * is deliberately not cleared on disconnect — clearing it would re-attempt on every reconnect,
 * which is exactly the cost the backoff exists to bound. A party's machines and a strand's
 * members are tens of peers, so the map is small. If a node ever meets peers by the thousand,
 * evict the entries whose wait has expired.
 */

import debug from 'debug';
import type { Connection, IdentifyResult, Libp2p, PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { addrKind, dialAddr, withTrailingPeerId, type AddrKind } from './peer-dial.js';
import { describeThrown } from './describe-thrown.js';

const log = debug('sereus:cadre:webrtc-upgrade');

/**
 * The protocol `@libp2p/webrtc`'s private-to-private transport registers when it starts, and
 * therefore the signal that a node CAN dial a `/p2p-circuit/webrtc` address: the transport
 * handles the signalling the dial needs, and a node whose embedder passed no WebRTC transport
 * never serves this protocol. Also classified by `control-protocol-guard.ts`, which must know
 * what to do with an inbound stream on it.
 */
export const WEBRTC_SIGNALING_PROTOCOL = '/webrtc-signaling/0.0.1';

/** Wait after a peer's first failed upgrade attempt, before any further one. */
export const WEBRTC_UPGRADE_BACKOFF_MS = 60_000;

/** Ceiling the per-peer wait doubles up to. */
export const WEBRTC_UPGRADE_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * The wait one peer's NEXT failure puts in force, given the wait its previous failure applied
 * (absent for a peer with no failure on record): {@link WEBRTC_UPGRADE_BACKOFF_MS}, doubling to
 * {@link WEBRTC_UPGRADE_MAX_BACKOFF_MS} and held there.
 *
 * Pure and separate from the map that holds it, for the same reason {@link decideWebrtcUpgrade}
 * is: the ladder is a rule, and `decideWebrtcUpgrade` only ever sees the deadline it produced.
 */
export function nextWebrtcUpgradeBackoffMs(previousWaitMs?: number): number {
	return previousWaitMs === undefined
		? WEBRTC_UPGRADE_BACKOFF_MS
		: Math.min(previousWaitMs * 2, WEBRTC_UPGRADE_MAX_BACKOFF_MS);
}

/** Why {@link decideWebrtcUpgrade} declined to attempt an upgrade. */
export type WebrtcUpgradeSkipReason =
	/** This node holds no relay-carried connection to the peer, so there is nothing to upgrade. */
	| 'not-relayed'
	/** A direct connection to the peer is already open — a WebRTC one, or any unrelayed transport. */
	| 'already-direct'
	/** The remote published no WebRTC address, so there is none to dial. */
	| 'no-webrtc-addr'
	/** Both sides advertise one and the remote holds the lower peer id, so the remote dials. */
	| 'remote-dials'
	/** This peer's wait after an earlier failed attempt has not expired. */
	| 'in-backoff';

/** Whether to attempt an upgrade, and at which address. */
export type WebrtcUpgradeDecision =
	| { readonly attempt: true; readonly addr: Multiaddr }
	| { readonly attempt: false; readonly reason: WebrtcUpgradeSkipReason };

/** Everything {@link decideWebrtcUpgrade} judges one `peer:identify` from. */
export interface WebrtcUpgradeInputs {
	/** This node's peer id, for the tie-break. */
	readonly localPeerId: string;
	/** The peer that identified. */
	readonly remotePeerId: string;
	/**
	 * The {@link AddrKind} of every OPEN connection this node holds to that peer, which answers
	 * both of the first two conditions: there is something to upgrade only if one of them is
	 * relay-carried, and it is worth upgrading only if none of them is direct. The connection the
	 * identify ran over is one of these, so it needs no field of its own.
	 */
	readonly openConnections: readonly AddrKind[];
	/** The remote's identified listen addresses, in the order it published them. */
	readonly remoteAddrs: readonly Multiaddr[];
	/** Whether this node publishes a WebRTC address of its own (the tie-break's other half). */
	readonly localAdvertisesWebrtc: boolean;
	/** Epoch ms before which this peer must not be attempted again, or absent when it is free. */
	readonly backoffUntilMs?: number;
	readonly nowMs: number;
}

/**
 * Whether to dial a WebRTC upgrade for the peer that just identified, and at which address.
 * Pure, so the rules that carry the judgement — the tie-break and the backoff — are testable
 * without a libp2p node.
 *
 * Conditions are checked in the order the module doc describes them, so the reason reported is
 * the first one that applies. Note what is NOT here: whether the relay caps the connection. A
 * capped relayed connection is upgraded on the same terms as any other (see the module doc).
 */
export function decideWebrtcUpgrade(inputs: WebrtcUpgradeInputs): WebrtcUpgradeDecision {
	if (!inputs.openConnections.includes('relayed')) {
		return { attempt: false, reason: 'not-relayed' };
	}
	if (inputs.openConnections.some((kind) => kind !== 'relayed')) {
		return { attempt: false, reason: 'already-direct' };
	}
	const addr = inputs.remoteAddrs.find((candidate) => addrKind(candidate) === 'webrtc');
	if (addr === undefined) {
		return { attempt: false, reason: 'no-webrtc-addr' };
	}
	if (inputs.localAdvertisesWebrtc && inputs.localPeerId > inputs.remotePeerId) {
		return { attempt: false, reason: 'remote-dials' };
	}
	if (inputs.backoffUntilMs !== undefined && inputs.nowMs < inputs.backoffUntilMs) {
		return { attempt: false, reason: 'in-backoff' };
	}
	return { attempt: true, addr };
}

/**
 * Whether `node` can dial a `/p2p-circuit/webrtc` address at all, judged by the signalling
 * protocol its WebRTC transport registers ({@link WEBRTC_SIGNALING_PROTOCOL}).
 *
 * A node's transport list is fixed when it is built, so this answer cannot change over the
 * node's life and {@link WebrtcUpgradeService.start} reads it once. It must be read after the
 * node has STARTED, which is when the transport registers the protocol — both of cadre-core's
 * install sites run after `createLibp2pNode` has started the node.
 */
function canDialWebrtc(node: Libp2p): boolean {
	// Read structurally, like the node slices in `peer-dial.ts` and `relay-reservation.ts`: a node
	// that reports no protocol list is treated as having no WebRTC transport, which leaves the
	// service inert. That is the fail-safe answer, and it is what lets the unit specs build small
	// libp2p doubles without implementing a method only this probe calls.
	const protocols = (node as Partial<Libp2p>).getProtocols?.();
	return protocols?.includes(WEBRTC_SIGNALING_PROTOCOL) === true;
}

/** What {@link WebrtcUpgradeService} needs from its host. */
export interface WebrtcUpgradeDeps {
	/** Names this node in logs: the control network name, or the strand id. */
	readonly label: string;
	readonly node: Libp2p;
	/**
	 * Deadline for one upgrade dial, from `link-budget.ts`'s `webrtcUpgradeDialBudgetMs` at the
	 * host's declared link. A backstop, not the normal end of an attempt — see that function.
	 */
	readonly dialTimeoutMs: number;
}

/** One peer's current wait after a failed attempt. */
interface Backoff {
	/** The wait that was applied, doubled on the next failure. */
	readonly waitMs: number;
	/** Epoch ms the wait expires at. */
	readonly untilMs: number;
}

/**
 * Subscribes to `peer:identify` on one libp2p node and dials a background WebRTC upgrade
 * whenever {@link decideWebrtcUpgrade} says to. Installed on every node cadre-core builds — the
 * control node and each strand node — and inert on one that cannot dial WebRTC.
 *
 * One attempt per peer at a time, each abandoned when the service stops.
 */
export class WebrtcUpgradeService {
	private listening = false;
	private stopped = false;
	private readonly backoff = new Map<string, Backoff>();
	/** One controller per peer with an attempt in flight; its presence is also the per-peer lock. */
	private readonly inFlight = new Map<string, AbortController>();
	private readonly onIdentify: (evt: CustomEvent<IdentifyResult>) => void;

	constructor(private readonly deps: WebrtcUpgradeDeps) {
		this.onIdentify = (evt) => {
			this.consider(evt.detail.peerId, evt.detail.listenAddrs);
		};
	}

	/**
	 * Subscribe, unless this node cannot dial WebRTC ({@link canDialWebrtc}) — then the service
	 * stays inert and says so once, rather than judging every identify for a dial it could never
	 * make. Then judge the peers that are already connected ({@link considerConnectedPeers}).
	 */
	start(): void {
		if (this.listening || this.stopped) {
			return;
		}
		if (!canDialWebrtc(this.deps.node)) {
			log('[%s] inert: the node serves no %s, so it has no WebRTC transport to dial with',
				this.deps.label, WEBRTC_SIGNALING_PROTOCOL);
			return;
		}
		this.listening = true;
		this.deps.node.addEventListener('peer:identify', this.onIdentify);
		// Logged rather than left to float: nothing awaits this pass, so a throw from the node
		// slices it reads would otherwise surface as an unhandled rejection — the same reason
		// {@link consider} catches its own.
		void this.considerConnectedPeers().then(
			(judged) => log('[%s] started (%d peer(s) already connected)', this.deps.label, judged),
			(err) => log('[%s] started, but judging the peers already connected threw: %s',
				this.deps.label, describeThrown(err))
		);
	}

	/**
	 * Judge every peer this node is ALREADY connected to, from the addresses their identify left
	 * in the peer store, and return how many were considered (for the start log).
	 *
	 * The control node needs this: it is armed at the end of `CadreNode.start()`, and building the
	 * control database before that connects to every sibling it can reach, so those peers have
	 * already identified and the event for them will not come again until one of THEM changes its
	 * addresses. Without this pass, a party's two relay-only machines could sit relayed for as long
	 * as neither reconnected. Same reasoning as `PeerJoinBackfill.scheduleConnectedPeers`, which
	 * reads the same peer-store addresses.
	 */
	private async considerConnectedPeers(): Promise<number> {
		const peers = new Map<string, PeerId>();
		for (const connection of this.deps.node.getConnections()) {
			peers.set(connection.remotePeer.toString(), connection.remotePeer);
		}
		await Promise.all([...peers.values()].map((peerId) => this.considerStored(peerId)));
		return peers.size;
	}

	/** Judge one already-connected peer from its stored addresses; a peer the store does not know yet is left to its event. */
	private async considerStored(peerId: PeerId): Promise<void> {
		try {
			const stored = await this.deps.node.peerStore.get(peerId);
			this.consider(peerId, stored.addresses.map((address) => address.multiaddr));
		} catch (err) {
			// Normally `NotFoundError`: this peer's identify has not finished, so its own
			// `peer:identify` is still to come and will carry the addresses.
			log('[%s] no stored addresses for %s yet: %s', this.deps.label, peerId.toString(), describeThrown(err));
		}
	}

	/** Unsubscribe and abandon every attempt in flight. Idempotent. */
	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		if (this.listening) {
			this.deps.node.removeEventListener('peer:identify', this.onIdentify);
			this.listening = false;
		}
		for (const controller of this.inFlight.values()) {
			controller.abort(new Error(`${this.deps.label}: the WebRTC upgrade service stopped`));
		}
		this.inFlight.clear();
		log('[%s] stopped', this.deps.label);
	}

	/**
	 * Judge one peer's addresses against the connections this node holds to it, and start the
	 * attempt it calls for. Never throws: it runs inside a libp2p event listener, where a rejection
	 * would be an unhandled one, and an upgrade is best-effort.
	 */
	private consider(peerId: PeerId, remoteAddrs: readonly Multiaddr[]): void {
		if (this.stopped) {
			return;
		}
		const remote = peerId.toString();
		try {
			if (this.inFlight.has(remote)) {
				return;
			}
			const decision = decideWebrtcUpgrade({
				localPeerId: this.deps.node.peerId.toString(),
				remotePeerId: remote,
				openConnections: this.deps.node.getConnections(peerId)
					.filter((connection) => connection.status === 'open')
					.map((connection) => addrKind(connection.remoteAddr)),
				remoteAddrs,
				localAdvertisesWebrtc: this.deps.node.getMultiaddrs().some((addr) => addrKind(addr) === 'webrtc'),
				backoffUntilMs: this.backoff.get(remote)?.untilMs,
				nowMs: Date.now(),
			});
			if (!decision.attempt) {
				log('[%s] no upgrade for %s: %s', this.deps.label, remote, decision.reason);
				return;
			}
			void this.attempt(remote, decision.addr);
		} catch (err) {
			log('[%s] judging an upgrade for %s threw: %s', this.deps.label, remote, describeThrown(err));
		}
	}

	/**
	 * Dial `addr` as an upgrade for `remote`, and record what came of it. A dial that resolves to a
	 * relayed connection upgraded nothing — it was served by one, or libp2p's circuit transport
	 * answered with one — and is neither a success nor a failure: the backoff is left as it was, so
	 * the peer's next identify tries again.
	 */
	private async attempt(remote: string, addr: Multiaddr): Promise<void> {
		const bound = withTrailingPeerId(addr, remote);
		if (bound === null) {
			// identify publishes each listen address with the peer id stripped, so this is an address
			// already ending in a DIFFERENT peer id: it does not reach the peer that published it.
			log('[%s] upgrade address %s does not reach %s', this.deps.label, addr.toString(), remote);
			return;
		}
		const controller = new AbortController();
		this.inFlight.set(remote, controller);
		const label = `[${this.deps.label}] WebRTC upgrade of ${remote}`;
		const expiry = setTimeout(
			() => controller.abort(new Error(`${label}: gave up after ${this.deps.dialTimeoutMs} ms`)),
			this.deps.dialTimeoutMs
		);
		try {
			const connection = await dialAddr(this.deps.node, bound, controller.signal, label);
			this.noteOutcome(remote, connection);
		} catch (err) {
			const wait = this.noteFailure(remote);
			log('%s failed (next attempt in %d ms at the earliest): %s', label, wait, describeThrown(err));
		} finally {
			clearTimeout(expiry);
			this.inFlight.delete(remote);
		}
	}

	/**
	 * Clear the peer's backoff on a real upgrade; leave it alone when the dial resolved to a relay,
	 * so the peer's next identify tries again rather than waiting out a failure it did not have.
	 *
	 * The relayed outcome should not happen on the dial path this module uses — {@link dialAddr}
	 * dials the one address it is given and refuses to stand an open relayed connection in for a
	 * WebRTC address. It is checked because the alternative, `node.dial`, CAN produce it by joining
	 * another dial of the same peer (see the module doc), and a false success there would clear a
	 * backoff and report an upgrade that never happened.
	 */
	private noteOutcome(remote: string, connection: Connection): void {
		if (addrKind(connection.remoteAddr) === 'relayed') {
			log('[%s] upgrade dial of %s answered with a relayed connection (%s); nothing upgraded',
				this.deps.label, remote, connection.remoteAddr.toString());
			return;
		}
		this.backoff.delete(remote);
		log('[%s] upgraded %s to %s', this.deps.label, remote, connection.remoteAddr.toString());
	}

	/** Start or double this peer's wait, and return the wait now in force. */
	private noteFailure(remote: string): number {
		const waitMs = nextWebrtcUpgradeBackoffMs(this.backoff.get(remote)?.waitMs);
		this.backoff.set(remote, { waitMs, untilMs: Date.now() + waitMs });
		return waitMs;
	}
}
