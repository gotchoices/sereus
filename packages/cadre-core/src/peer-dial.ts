/**
 * Dialing one peer from a list of candidate addresses, so that an address that
 * never answers cannot use up the time the others needed.
 *
 * libp2p's own multi-address dial (`libp2p.dial(addrs)`, `DialQueue.dialPeer`)
 * tries the addresses ONE AT A TIME under ONE signal. Its only per-address limit
 * is the connection manager's `addressDialTimeout` (libp2p 3.3+), which cadre
 * sizes for a cold relayed open through two admission decisions
 * (`optimysticDialLimits` in `link-budget.ts`: 39 s at the default declared
 * link). An address whose connection attempt is silently dropped — a firewall, a
 * subnet the dialer cannot route to, a virtual adapter's address a Windows host
 * reports alongside its real ones — holds that dial for that long or until the
 * whole signal expires, and the addresses sorted after it get what is left. It
 * also sorts the list itself (`defaultAddressSorter`), putting loopback addresses
 * last, behind exactly the LAN addresses most likely to be dropped. A phone
 * borrowing a node from a cadre-host whose only reachable address was the
 * forwarded loopback one never connected for this reason.
 *
 * So the addresses are dialed here, each as its own transport-manager dial
 * ({@link dialAddr}) with its own time limit ({@link PeerDialBudget.perAddressMs}),
 * inside a limit for the whole peer ({@link PeerDialBudget.totalMs}). One address
 * per call also means libp2p's sorter has nothing to reorder, so the order is
 * chosen here ({@link directBeforeRelayed}). The dial goes around libp2p's dial
 * queue because the queue joins any dial of a peer to a queued job for that peer
 * id, whatever address the new dial names — see {@link dialAddr}. Every address
 * is bound to the peer the caller expects ({@link withTrailingPeerId}) so the
 * handshake verifies who answered.
 *
 * Dependency-free apart from `control-stream.ts` and `link-budget.ts`, so any
 * module may import it without creating an import cycle. That is why the two
 * address helpers ({@link trailingPeerId}, {@link withTrailingPeerId}) live here
 * and `peer-record.ts`, which pulls in the crypto plugin, re-exports them.
 */

import debug from 'debug';
import type { Connection, ConnectionGater, Libp2pStatus, PeerId } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Component, Multiaddr } from '@multiformats/multiaddr';
import { withDeadline } from './control-stream.js';
import { relayedDialBudgetMs } from './link-budget.js';

const log = debug('sereus:cadre:peer-dial');

/**
 * The peer id a multiaddr terminates in, or `null` when it names none.
 *
 * The LAST `/p2p/` component is the dial target: a circuit address
 * (`…/p2p/<relay>/p2p-circuit/p2p/<target>`) names the relay first and the peer
 * being reached last. Replaces the deprecated `Multiaddr.getPeerId()`, which
 * cannot express that distinction.
 */
export function trailingPeerId(addr: Multiaddr): string | null {
	const p2p = addr.getComponents().filter((c) => c.name === 'p2p');
	return p2p.length > 0 ? (p2p[p2p.length - 1].value ?? null) : null;
}

/**
 * `addr` guaranteed to terminate in `/p2p/<peerId>` — the shape every dial needs,
 * since the upgrader verifies that id during the handshake — or `null` when it
 * cannot, because the address already terminates in a DIFFERENT peer id and
 * therefore does not reach `peerId` at all.
 *
 * Three input shapes, matching what a `CadrePeer` record can legitimately carry:
 *
 * - no `/p2p/` component (`/ip4/1.2.3.4/tcp/4001`) — the suffix is appended;
 * - a relay hop with the destination missing (`…/p2p/<relay>/p2p-circuit`) — the
 *   last component is the circuit, not a peer id, so the suffix is appended and
 *   the address becomes the full `…/p2p/<relay>/p2p-circuit/p2p/<peerId>`;
 * - already terminating in `/p2p/<X>` — returned untouched when `X` is `peerId`,
 *   dropped otherwise.
 *
 * This is deliberately the same rule libp2p applies internally in
 * `calculateMultiaddrs` (append when the LAST component is not `p2p`) followed by
 * its wrong-peer-id filter, so a normalized list matches what libp2p would have
 * built anyway. Normalizing before a list dial is what keeps a list from mixing
 * suffixed and unsuffixed entries, which `getPeerAddress` rejects outright
 * ("Multiaddrs must all have the same peer id or have no peer id") — taking the
 * whole peer down with it, not just the odd address.
 *
 * Throws when `peerId` does not parse as a peer id (the encapsulation validates
 * it). Never use before signature verification: verification runs against the
 * original on-record strings.
 */
export function withTrailingPeerId(addr: Multiaddr, peerId: string): Multiaddr | null {
	const components = addr.getComponents();
	if (components[components.length - 1]?.name !== 'p2p') {
		return addr.encapsulate(`/p2p/${peerId}`);
	}
	return trailingPeerId(addr) === peerId ? addr : null;
}

/**
 * Default limit on ONE address's dial attempt, in ms, at the DEFAULT declared link round trip:
 * `RELAYED_DIAL_ROUND_TRIPS` (5) x `DECLARED_LINK_ROUND_TRIP_MS` (3500 ms) plus
 * `DIAL_ADMISSION_DECISIONS` (2) x `ADMISSION_DECISION_TIMEOUT_MS` (2000 ms) = 21 500 ms
 * (`relayedDialBudgetMs`). It was a fixed 8000 ms before it was derived.
 *
 * It has to cover the slowest address that should succeed, because an attempt
 * that needs longer fails the same way on every retry. That is a relayed dial on
 * a mobile link: connect to the relay (transport, encryption and multiplexer
 * handshakes, when no relay connection is open yet), open the circuit, then run
 * both handshakes again end to end through the relay. `link-budget.ts` is where that
 * reasoning is now a measured count instead of an estimate — five link round trips, measured at
 * 15 113 ms on a link whose round trip is 3 s — so the value MOVES with a host's
 * `NetworkConfig.linkRoundTripMs` rather than pinning the band this node can reach to whatever
 * number was typed here. A direct dial that works is far quicker — a phone's WebSocket dial to
 * a node forwarded over `adb reverse` measured 1.6 s end to end.
 *
 * Deriving it rather than leaving it fixed is deliberate: at 8000 ms fixed, the per-address
 * limit — not libp2p's own 10 s dial timeout — was the first thing to cut a relayed dial off,
 * from about 1000 ms of one-way link delay upward. Nothing said so, and a reader raising
 * `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` below would not have found it.
 *
 * NOTE: a `/p2p-circuit/webrtc` address also negotiates a WebRTC session after
 * the relay leg. If such dials are ever seen failing at exactly this limit, raise
 * the declared link round trip (or `network.controlCohort.perAddressDialTimeoutMs` on the
 * affected nodes) rather than the per-peer limit, which cannot help an address that is itself
 * cut off.
 *
 * Override per node with `network.controlCohort.perAddressDialTimeoutMs`.
 */
export const DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS = relayedDialBudgetMs();

/**
 * How many whole per-address dial attempts {@link DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS}
 * budgets for: the address that works plus the three dead ones a lent cadre-host node is
 * observed to report ahead of it (loopback and LAN WebSocket addresses, plus virtual adapters).
 */
export const CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS = 4;

/**
 * Default limit on dialing ONE peer — every candidate address together — in ms.
 *
 * Without it, an offline peer costs (address count × up to
 * {@link DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS}), a number that
 * depends on how many addresses the peer happens to report. Callers dial peers
 * one after another (the control-cohort reconcile pass dials each sibling in
 * turn), so that cost also delays every later peer. With the limit, a reconcile
 * pass costs at most (dialed siblings) × this.
 *
 * Sized to fit a typical list with dead addresses ahead of the one that works:
 * a lent cadre-host node reports two to four addresses a phone can dial
 * (loopback and LAN WebSocket addresses, plus any virtual adapters). So it is
 * {@link CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS} whole per-address budgets — three silently
 * dropped addresses, then the one that works, each getting the FULL per-address limit. A peer
 * whose working address sits behind four or more dropped ones does not fit, and fails each pass
 * the same way; if that shows up, the remedy is ordering (try the address that last connected
 * first), not a larger number here.
 *
 * Counted as whole per-address budgets rather than the flat 30_000 it was before, because the
 * old number left only 6 s after three dropped addresses — enough for the 1.6 s direct dial the
 * phone measured, but NOT for the relayed dial the per-address limit is sized to cover. A peer
 * whose only working address was a relayed one behind two dead ones therefore could not be
 * dialled at all, and the arithmetic in this comment was what said otherwise.
 *
 * Override per node with `network.controlCohort.dialTimeoutMs` — tests that
 * drive dead addresses on purpose set it low so a pass's duration is a chosen
 * number rather than a transitive libp2p default stretched by machine load.
 */
export const DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS =
	CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS * DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS;

/** Time limits for dialing one peer from a list of candidate addresses. */
export interface PeerDialBudget {
	/** Limit on one address's attempt, in ms. */
	perAddressMs: number;
	/** Limit on the whole peer — every address together — in ms. */
	totalMs: number;
}

/** {@link PeerDialBudget} built from the two defaults above. */
export const DEFAULT_PEER_DIAL_BUDGET: Readonly<PeerDialBudget> = {
	perAddressMs: DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS,
	totalMs: DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS,
};

/** What {@link dialAddr} reads of a connection the node holds, to decide whether to hand it back instead of dialing. */
export interface ReusableConnection {
	remotePeer: { toString(): string };
	status?: Connection['status'];
	limits?: Connection['limits'];
	/** Whether the connection is direct rather than relayed; absent counts as direct. */
	direct?: boolean;
}

/** The slice of a libp2p node {@link dialPeerAddrs} uses. */
export interface AddrDialer {
	/** This node's id, to recognise an address that relays through this node ({@link relaysThrough}). */
	readonly peerId: PeerId;
	/** libp2p's lifecycle state: {@link dialAddr} refuses to start an attempt once it is not `started`. */
	readonly status?: Libp2pStatus;
	/**
	 * The connections this node holds to `peerId`. {@link dialAddr} returns an open one without relay
	 * limits rather than opening a second — what libp2p's dial queue did (`findExistingConnection`)
	 * and the transport manager does not. Optional so a double need not provide it, and typed by
	 * what is read of each connection so the strand redial's node slice (bare `remotePeer`s, which
	 * never count as open) satisfies it without a cast.
	 */
	getConnections?(peerId?: PeerId): ReadonlyArray<ReusableConnection>;
	dial(addr: Multiaddr, options: { signal: AbortSignal }): Promise<Connection>;
}

/**
 * The libp2p internals a queue-free dial reaches — real fields on libp2p's node class, absent
 * from the `Libp2p` interface (the seam `relay-reservation.ts` already uses).
 */
interface DialComponentsLike {
	components?: {
		transportManager?: { dial?: (addr: Multiaddr, options: { signal: AbortSignal }) => Promise<Connection> };
		connectionGater?: ConnectionGater;
	};
}

/**
 * libp2p's `stop` event, which ends an attempt the dial queue would otherwise have aborted at
 * shutdown. Structural so an {@link AddrDialer} double need not provide it.
 */
interface StopEventsLike {
	addEventListener?: (type: 'stop', listener: () => void) => void;
	removeEventListener?: (type: 'stop', listener: () => void) => void;
}

/**
 * Dial ONE address outside libp2p's dial queue. The queue joins any new dial to a queued job
 * for the same peer id, whatever address the new dial names, and a joined job ends only when
 * every caller has aborted — so while another caller dials this peer (FRET's membership probe,
 * an Optimystic cluster client), a per-address attempt through the queue waits on whatever
 * address that job is on instead of its own. The transport manager dials exactly the address
 * given; the two gater hooks the queue would have consulted are run here, and the upgrader
 * still runs `denyOutboundConnection` and verifies the peer id the address carries during the
 * Noise handshake, so the address must carry the id of the peer expected to answer
 * ({@link withTrailingPeerId}). An open connection to that peer without relay limits is handed
 * back instead of dialing ({@link reusableConnection}), as the queue would have. A relayed
 * address still passes through the queue for its relay leg (the circuit transport dials the
 * relay by peer id).
 *
 * The queue would also have aborted the attempt at shutdown; here the node's `status` is
 * checked before dialing and its `stop` event aborts an attempt in flight. Without
 * `transportManager.dial` (libp2p internals moved) the attempt goes through the queue, logged.
 *
 * What else the queue did that this does not: record the outcome in the peer store
 * (`LAST_DIAL_SUCCESS_KEY` / `LAST_DIAL_FAILURE_KEY`, read only by libp2p's own address sorter,
 * which these dials do not use); apply `maxParallelDials` and `maxDialQueueLength`; and refuse
 * a dial of this node's own id before touching the network — the upgrader still throws
 * `Can not dial self` after the handshake, `dialPeerAddrs` drops addresses relaying through this
 * node, `applySeed` skips itself, and the reconcile pass never lists itself.
 */
export async function dialAddr(dialer: AddrDialer, addr: Multiaddr, signal: AbortSignal, label: string): Promise<Connection> {
	if (dialer.status !== undefined && dialer.status !== 'started') {
		throw new Error(`${label}: not dialed, the node is ${dialer.status}`);
	}
	const components = (dialer as AddrDialer & DialComponentsLike).components;
	const manager = components?.transportManager;
	if (typeof manager?.dial !== 'function') {
		log('%s: no transportManager.dial on this node — libp2p internals moved? dialing through the queue', label);
		return dialer.dial(addr, { signal });
	}
	const target = boundPeer(addr, label);
	const open = reusableConnection(dialer, target, addr);
	if (open !== undefined) {
		log('%s: reusing the open connection to %s', label, target);
		return open;
	}
	await assertDialAllowed(components?.connectionGater, target, addr, label);
	const events = dialer as AddrDialer & StopEventsLike;
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(signal.reason);
	const onStop = (): void => controller.abort(new Error(`${label}: the node stopped`));
	signal.addEventListener('abort', onAbort, { once: true });
	events.addEventListener?.('stop', onStop);
	try {
		// NOTE: a relayed address's relay leg still goes through the dial queue (the circuit
		// transport dials the relay by peer id), so another dial of the relay can join it. Fine
		// while a relay connection is normally already open for the reservation; revisit if a
		// relayed attempt is ever seen timing out while a dial of the relay by id is in flight.
		return await manager.dial(addr, { signal: controller.signal });
	} catch (err) {
		// A transport reports an aborted connect as its own failure ("Could not connect to …");
		// why it was aborted — the deadline, or the stop — is the error worth surfacing.
		throw controller.signal.aborted ? controller.signal.reason : err;
	} finally {
		signal.removeEventListener('abort', onAbort);
		events.removeEventListener?.('stop', onStop);
	}
}

/**
 * The peer `addr` is bound to, or `undefined` when it names none. Throws, naming the address,
 * when the id it carries does not parse: the upgrader would reject the same address after
 * connecting, so failing before the network costs nothing and says why.
 */
function boundPeer(addr: Multiaddr, label: string): PeerId | undefined {
	const id = trailingPeerId(addr);
	if (id === null) {
		return undefined;
	}
	try {
		return peerIdFromString(id);
	} catch (err) {
		throw new Error(`${label}: ${addr.toString()} does not end in a peer id that parses`, { cause: err });
	}
}

/**
 * An open connection to `target` without relay limits, when the node holds one — the rule
 * libp2p's dial queue applied before dialing (`findExistingConnection`): a direct connection is
 * preferred, and a relayed one is not reused for a direct address, so the dial can upgrade the
 * link. `undefined` when the node holds none, or does not expose its connections.
 *
 * Returned as the `Connection` it is on a real node. A double that reports an open connection
 * must supply what its caller uses of one.
 */
function reusableConnection(dialer: AddrDialer, target: PeerId | undefined, addr: Multiaddr): Connection | undefined {
	if (target === undefined || dialer.getConnections === undefined) {
		return undefined;
	}
	const expected = target.toString();
	const open = dialer.getConnections(target)
		.filter((c) => c.status === 'open' && c.limits === undefined && c.remotePeer.toString() === expected);
	const existing = open.find((c) => c.direct !== false) ?? open[0];
	if (existing === undefined || (existing.direct === false && !isRelayed(addr))) {
		return undefined;
	}
	return existing as Connection;
}

async function assertDialAllowed(gater: ConnectionGater | undefined, target: PeerId | undefined, addr: Multiaddr, label: string): Promise<void> {
	if (target !== undefined && await gater?.denyDialPeer?.(target)) {
		throw new Error(`${label}: the connection gater denies dialing ${target.toString()}`);
	}
	if (await gater?.denyDialMultiaddr?.(addr)) {
		throw new Error(`${label}: the connection gater denies dialing ${addr.toString()}`);
	}
}

/**
 * Thrown by {@link dialPeerAddrs} when it was given addresses but every one reaches the peer by
 * relaying through this node, so none was dialed.
 *
 * This is where a relay lands for a peer that holds a reservation on it (a phone, or any node that
 * cannot listen): the address that peer publishes is `/<relay transport>/p2p/<relay>/p2p-circuit/p2p/<peer>`,
 * and dialing it from the relay itself fails with libp2p's `Can not dial self`. Nothing this node
 * does can repair it; once the peer's connection drops, only the peer can reconnect. Callers log it
 * as that rather than as a dial failure.
 */
export class SelfRelayOnlyError extends Error {
	constructor(label: string) {
		super(`${label}: every candidate address relays through this node; only the peer can reconnect`);
		this.name = 'SelfRelayOnlyError';
	}
}

/**
 * No connection to the peer formed, so nothing was sent to it. `cause` is what the dial threw:
 * {@link dialPeerAddrs}'s error naming every address and why it failed, or a
 * {@link SelfRelayOnlyError}.
 *
 * Kept apart from failures after a connection formed so a caller can tell "this device could not
 * reach the peer" from "the peer was reached and then something else failed" without reading
 * libp2p's error text. `SeedBootstrapService.deliverSeed` throws it, and so `CadreNode.claimNode`.
 */
export class PeerUnreachableError extends Error {
	constructor(readonly peerId: string, cause: unknown) {
		super(`Could not reach ${peerId}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		this.name = 'PeerUnreachableError';
	}
}

/** One candidate's outcome, kept so the thrown error can name every attempt. */
interface AddrAttemptFailure {
	addr: Multiaddr;
	error: Error;
}

/**
 * Dial `peerId` from `addrs`, one address per {@link dialAddr} call, and return the
 * first connection that forms. Direct addresses are tried before relayed ones
 * ({@link directBeforeRelayed}); otherwise the given order is kept.
 *
 * Every address is first bound to `peerId` ({@link withTrailingPeerId}), so the
 * handshake verifies that the peer expected is the one that answered; an address
 * naming another peer is dropped and logged. When that leaves nothing of a
 * non-empty list — every address names someone else, or `peerId` does not parse —
 * this throws without dialing.
 *
 * Addresses that relay through this node are dropped next ({@link relaysThrough}):
 * dialing one could only fail with `Can not dial self`. When that leaves nothing,
 * this throws {@link SelfRelayOnlyError} without dialing.
 *
 * Addresses naming a transport this node lacks are not filtered out first: the
 * transport manager rejects those at once (`TransportUnavailableError`), so they
 * cost a log line, not time.
 *
 * Otherwise throws when no address connects — see {@link tryAddrsInTurn} for the error.
 *
 * @param peerId The peer every address must reach, as every caller already holds it
 *   (a `CadrePeer` row key, a seed peer's id, a strand member's id).
 * @param label Names the dial in timeout messages and logs, e.g.
 *   `reconcileControlCohort dial of sibling <peerId>`; each attempt reads
 *   `<label> via <addr>`.
 */
export async function dialPeerAddrs(
	dialer: AddrDialer,
	peerId: string,
	addrs: readonly Multiaddr[],
	budget: PeerDialBudget,
	label: string,
): Promise<Connection> {
	const bound = boundTo(peerId, addrs, label);
	if (addrs.length > 0 && bound.length === 0) {
		throw new Error(`${label}: none of the ${addrs.length} candidate addresses binds to ${peerId}`);
	}
	const dialable = withoutSelfRelayed(dialer, bound, label);
	if (bound.length > 0 && dialable.length === 0) {
		throw new SelfRelayOnlyError(label);
	}
	return tryAddrsInTurn(directBeforeRelayed(dialable), budget, label, (addr, signal) => dialAddr(dialer, addr, signal, label));
}

/**
 * `addrs` each bound to `peerId` ({@link withTrailingPeerId}). An address naming another peer
 * is dropped, as is every address when `peerId` cannot be encapsulated (it does not parse);
 * each drop is logged with its reason.
 */
function boundTo(peerId: string, addrs: readonly Multiaddr[], label: string): Multiaddr[] {
	const bound: Multiaddr[] = [];
	for (const addr of addrs) {
		try {
			const withId = withTrailingPeerId(addr, peerId);
			if (withId === null) {
				log('%s: dropping %s — it names a peer other than %s', label, addr.toString(), peerId);
			} else {
				bound.push(withId);
			}
		} catch (err) {
			log('%s: cannot bind %s to %s: %o', label, addr.toString(), peerId, err);
		}
	}
	return bound;
}

/**
 * Run `attempt` against each address in the given order until one succeeds, and
 * return its result.
 *
 * Each attempt is limited to `budget.perAddressMs`, or to whatever remains of
 * `budget.totalMs` when that is less. The attempt's signal is aborted when its
 * limit passes, so a dial in progress is cancelled rather than left running.
 * Addresses the total leaves no time for are reported as not tried.
 *
 * Throws when every address fails. With one address the error is that attempt's
 * own, unchanged. With several it is one error naming each address and why it
 * failed, in order, with the first failure as `cause` — so the report shows the
 * address that mattered, not only whichever happened to be tried last.
 *
 * Between attempts this waits for one macrotask (`setTimeout(0)`). A direct
 * address is dialed outside libp2p's dial queue ({@link dialAddr}), but a relayed
 * address still passes through it for the relay leg, and the queue lets a new
 * dial join any queued job for the same peer id WITHOUT checking whether that
 * job has already finished: an aborted job leaves the queue a few microtasks
 * after its callers are rejected, so a next attempt through the same relay made
 * at once would join the dying job and be rejected with `AbortError` before it
 * touches the network. All of the queue's cleanup runs as microtasks, so it has
 * finished by the time a macrotask runs. Seen against libp2p 3.1.3, and the
 * queue's join is unchanged in 3.3.11; `test/peer-dial.spec.ts` dials real nodes
 * so an upgrade that changes it shows up there.
 */
export async function tryAddrsInTurn<T>(
	addrs: readonly Multiaddr[],
	budget: PeerDialBudget,
	label: string,
	attempt: (addr: Multiaddr, signal: AbortSignal, attemptMs: number) => Promise<T>,
): Promise<T> {
	const deadline = Date.now() + budget.totalMs;
	const failures: AddrAttemptFailure[] = [];
	for (const addr of addrs) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			failures.push({ addr, error: new Error(`not tried — the ${budget.totalMs}ms budget for ${label} was spent on earlier addresses`) });
			continue;
		}
		if (failures.length > 0) {
			await nextMacrotask();
		}
		const attemptMs = Math.min(budget.perAddressMs, remaining);
		try {
			return await withDeadline(attemptMs, `${label} via ${addr.toString()}`, (signal) => attempt(addr, signal, attemptMs));
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			failures.push({ addr, error });
			log('%s via %s failed: %o', label, addr.toString(), error);
		}
	}
	throw allAttemptsFailed(label, failures);
}

/**
 * `addrs` with every circuit-relay address (one containing `/p2p-circuit`) moved
 * after every direct one, each group keeping its given order.
 *
 * The one part of libp2p's own ordering worth keeping: a relayed connection is
 * slower and limited in how much data and time it may carry, so a direct
 * address is always worth trying first. libp2p's other rules are deliberately
 * dropped — it puts loopback addresses last and public ones before private ones,
 * which is how a forwarded loopback address ended up behind addresses that
 * never answer. With a per-address limit, trying a dead address first costs a
 * bounded amount of time, so the caller's order is the better guide.
 */
export function directBeforeRelayed(addrs: readonly Multiaddr[]): Multiaddr[] {
	return [...addrs.filter((addr) => !isRelayed(addr)), ...addrs.filter(isRelayed)];
}

/** Whether `addr` reaches its target through a circuit relay. */
function isRelayed(addr: Multiaddr): boolean {
	return addr.getComponents().some((c) => c.name === 'p2p-circuit');
}

/** `addrs` without those that relay through `dialer` itself, each dropped one logged. */
function withoutSelfRelayed(dialer: AddrDialer, addrs: readonly Multiaddr[], label: string): Multiaddr[] {
	return addrs.filter((addr) => {
		if (!relaysThrough(addr, dialer.peerId)) {
			return true;
		}
		log('%s: skipping %s — it relays through this node', label, addr.toString());
		return false;
	});
}

/**
 * Whether `addr` reaches its target by relaying through `relay` at any hop.
 *
 * A circuit address names its relay in the `p2p` component immediately before
 * the `p2p-circuit` marker (`/<transport>/p2p/<relay>/p2p-circuit/p2p/<target>`),
 * so the components are walked rather than the text searched: the target's id
 * after the marker, a bare `/p2p-circuit` naming no relay, and a multi-hop chain
 * each read correctly that way. Same rule as db-p2p's `routesThroughRelay`, which
 * its package does not export.
 */
function relaysThrough(addr: Multiaddr, relay: PeerId): boolean {
	const components = addr.getComponents();
	return components.some((component, i) => component.name === 'p2p-circuit' && namesPeer(components[i - 1], relay));
}

/**
 * Whether `component` is a `p2p` component naming `peer`. Compared as canonical
 * strings because a multiaddr keeps a peer id in whichever form it was written
 * (base58 or CIDv1). `PeerId.equals` is avoided because test doubles supply the
 * dialer's `peerId` with `toString` only.
 */
function namesPeer(component: Component | undefined, peer: PeerId): boolean {
	if (component?.name !== 'p2p' || component.value === undefined) {
		return false;
	}
	const expected = peer.toString();
	try {
		return peerIdFromString(component.value).toString() === expected;
	} catch (err) {
		log('cannot read %s as a peer id; treating it as not this node: %o', component.value, err);
		return false;
	}
}

function allAttemptsFailed(label: string, failures: AddrAttemptFailure[]): Error {
	if (failures.length === 0) {
		return new Error(`${label}: no candidate addresses`);
	}
	if (failures.length === 1) {
		return failures[0].error;
	}
	const detail = failures.map((f) => `${f.addr.toString()} — ${f.error.message}`).join('; ');
	return new Error(`${label} failed for all ${failures.length} candidate addresses: ${detail}`, { cause: failures[0].error });
}

/**
 * Yield one macrotask: libp2p's dial queue drops an aborted job only on the next turn, so a
 * dialer that moves on to another address after an abort waits this long first. Shared with
 * the cadre invitation dialer (`cadre-invite-protocol.ts`).
 */
export function nextMacrotask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
