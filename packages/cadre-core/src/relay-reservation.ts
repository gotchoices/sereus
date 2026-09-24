/**
 * Relay reservation for nodes that reserve through the SEARCH listen addr — the
 * dial, the explicit reservation request, the retry loop that keeps it, and the
 * (live) status derivation.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen
 * address:
 *
 * | listen addr                                       | libp2p behaviour                                                                     | unreachable relay          |
 * | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
 * | `<dial addr>/p2p/<relayPeerId>/p2p-circuit`        | CONFIGURED reservation: dial that exact relay and reserve, or fail                     | `listen()` throws          |
 * | bare `/p2p-circuit`                                | SEARCH mode: register a pending reservation, to be filled by relay discovery           | nothing throws, no reserve |
 *
 * A search listener needs someone to (a) dial the relay and (b) fill the pending
 * reservation it created, then report whether one actually landed. That is this
 * module. It is **fail-soft by construction**: nothing here throws.
 *
 * EVERY cadre CONTROL node now takes that route — `network.relayAddrs` resolves
 * to the bare search entry (`relay-addrs.ts` → `resolveListenAddrs`) and
 * `CadreNode.start()` drives this module once the control database is up. The
 * configured shape would dial the relay from inside `libp2p.start()`, putting a
 * sibling in this node's cohort before its own control database existed, and a
 * sibling that has not yet replicated this node's `CadrePeer` row correctly
 * refuses its control-DB streams — which killed `start()` outright.
 *
 * So the two shapes are no longer alternative ROUTES, only alternative failure
 * postures on top of the same drive: a node that names `network.relayAddrs` gets
 * a `RelayReservationFailedError` out of `start()` when the first attempt lands
 * nothing (fail-fast, the operator asked for this relay), while a node that calls
 * `CadreNode.reserveRelays()` itself gets a non-`reserved` status and stays up
 * (fail-soft, the browser-tab posture). `network.requireRelay: false` gives a
 * CONFIGURED relay the fail-soft posture too, for a node that must boot with no
 * network at all — same drive, same supervisor, only the throw is dropped.
 * Configuring both is now redundant, not fatal.
 *
 * STRAND nodes take the same route, ONE supervisor PER RELAY
 * (`strand-instance-manager.ts` → `buildStrandRuntime`): each configured relay
 * gets its own bare `/p2p-circuit` listener (`strand-network-config.ts`) and its
 * own {@link superviseRelayReservation} over just that relay's addr, fail-soft
 * like the browser tab. The configured shape they used to take
 * (`<relay>/p2p-circuit`, reserved from inside `libp2p.start()`) is gone from
 * cadre-built nodes entirely, because it loses its address and never recovers in
 * three situations — the relay restarts, either side hangs up the relay
 * connection, and libp2p's OWN reservation refresh (which removes the reservation
 * before re-creating it, and a configured listener republishes only from inside
 * its own `listen()`). The last one needs no network event at all: at the relay
 * default TTL of two hours every configured-shape node went undialable ~1 h 55 min
 * after reserving. A search listener republishes on `relay:created-reservation`
 * for its own pending id, which the refresh re-queues, and the supervisor covers
 * the other two.
 *
 * Because a strand node runs one supervisor per relay, "is the reservation held"
 * is asked PER RELAY ({@link circuitMultiaddrsVia}): relay X's supervisor must not
 * be satisfied by relay Y's circuit addr, or it would never re-drive X.
 *
 * ⚠️ WHY THE RESERVATION IS REQUESTED EXPLICITLY RATHER THAN LEFT TO DISCOVERY.
 * libp2p fills a search listener's pending reservation from `RelayDiscovery`,
 * which nominates a peer only once it can see the relay-hop protocol id in that
 * peer's PEER-STORE protocol list — and that list is written exclusively by the
 * IDENTIFY handshake. `@optimystic/db-p2p` gives every cadre node a
 * network-namespaced identify protocol id (`/optimystic/control-<partyId>/id/1.0.0`)
 * while the relay `ops/docker/libp2p-infra` deploys runs stock identify
 * (`/ipfs/id/1.0.0`), so the two never identify each other, the peer store stays
 * empty of protocols, and discovery never nominates the relay. The TCP/WebSocket
 * connection itself is fine, which is why leaving it to discovery surfaced as a
 * generic timeout.
 *
 * Identify is incidental to relaying, though: the reservation
 * (`/libp2p/circuit/relay/0.2.0/hop`), a third peer's CONNECT through the relay,
 * and the STOP handler on this node all use STOCK, un-namespaced protocol ids the
 * deployed relay already serves. Discovery's only job is to GUESS which connected
 * peer is a relay, and this module does not need to guess — it was handed the
 * relay's address. So it asks the relay for a slot directly, via the
 * circuit-relay transport's own reservation store.
 *
 * Status is derived from the node's LIVE multiaddrs on every read rather than
 * cached at drive time: when a relay restarts or the connection drops, libp2p's
 * listener clears its listening addrs and the circuit multiaddr disappears, so a
 * cached snapshot would keep claiming `reserved` for a node nothing can dial.
 *
 * And because discovery is out of reach, nothing would ever ASK again either —
 * so {@link driveRelayReservation} stays a single-shot primitive and
 * {@link superviseRelayReservation} owns the retry cadence on top of it. That
 * loop is what makes a lost reservation recover without a page reload. Single-shot
 * but not unstoppable: the primitive takes an `AbortSignal` and the loop trips it
 * from `stop()`, because a drive left running against a node being torn down both
 * logs failures that read as real and — through the timers it still holds — keeps
 * the process alive for the rest of its `timeoutMs`.
 *
 * One measured refinement to "out of reach": libp2p 3.1.3's `connection.newStream`
 * records every protocol OUR OWN outbound stream negotiated into the peer store, so
 * the explicit reservation request writes the relay-hop protocol id against the
 * relay itself. From then on, discovery CAN refill a freed slot on its own — but
 * only when the relay answers at that moment (a hangup while the relay stays up;
 * measured at ~25 ms). A relay that is down when the slot frees fails that one
 * discovery attempt, which poisons the store's `relayFilter` against it, and
 * nothing in libp2p tries again: a relay RESTART still needs the supervisor, which
 * un-poisons the filter before every attempt ({@link clearRelayFilterEntry}). Two
 * mechanisms in production, one guarantee; the specs disable discovery's half
 * (`forgetRelayProtocol` in `relay-reservation.spec.ts`) so they prove the
 * supervisor's.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Libp2p, PeerId } from '@libp2p/interface';
import { trailingPeerId } from './peer-record.js';

const log = debug('sereus:cadre:relay-reservation');

/**
 * Relay-reservation posture for a node that reserves through the SEARCH listen
 * addr (bare `/p2p-circuit`) — every cadre control node, whether its relays came
 * from `network.relayAddrs` or from an explicit `CadreNode.reserveRelays()` call.
 *  - `none`     — no relay addrs supplied; the node is undialable by design.
 *  - `dialing`  — a drive is in flight.
 *  - `reserved` — the node currently holds at least one `/p2p-circuit` addr.
 *  - `retrying` — no reservation right now, but a {@link RelayReservationSupervisor}
 *                 has the next attempt scheduled. Recoverable without a caller.
 *  - `error`    — no reservation, and NOBODY IS GOING TO TRY AGAIN: no supervisor
 *                 is running (or there is no node at all).
 */
export type RelayReservationStatus = 'none' | 'dialing' | 'reserved' | 'retrying' | 'error';

export interface RelayReservationState {
  status: RelayReservationStatus;
  /** The relay multiaddrs this node was asked to reserve through. */
  addrs: string[];
  /** LIVE `/p2p-circuit` multiaddrs, recomputed on every read. */
  circuitAddrs: string[];
  error: string | null;
  /**
   * Epoch ms of the supervisor's next scheduled tick, or `null` when a drive is
   * in flight, no supervisor is running, or no addrs were supplied. A UI can turn
   * this into "reconnecting, next try in 8s" rather than showing a bare error for
   * a node that is in fact recovering.
   */
  retryAtMs: number | null;
}

/** How long {@link driveRelayReservation} waits for a reservation to appear. */
export const DEFAULT_RELAY_RESERVE_TIMEOUT_MS = 10_000;
export const DEFAULT_RELAY_RESERVE_POLL_MS = 250;

export interface RelayReserveOptions {
  timeoutMs?: number;
  pollMs?: number;
  /**
   * Ends an in-flight drive early. Aborting is not a failure: the drive returns
   * `{ error: null, cancelled: true }` and clears every timer it holds, so the
   * process is free to exit immediately instead of trailing the teardown that
   * cancelled it.
   */
  signal?: AbortSignal;
}

/** What one {@link driveRelayReservation} came back with. */
export interface RelayReserveResult {
  /** Why no reservation landed; `null` when one did — or when the drive was cancelled. */
  error: string | null;
  /**
   * The drive ended because its caller's `signal` tripped, not because of anything
   * the relay did. Separate from `error` because `error: null` means "a reservation
   * landed" and a cancelled drive landed nothing: folded together, a caller would
   * read cancellation as success. `cancelled: true` always implies `error: null`.
   */
  cancelled: boolean;
}

/**
 * The slice of `@libp2p/utils`' `Filter` (a cuckoo filter) that the reservation
 * store uses to remember relays whose reservation request failed. `remove` is
 * OPTIONAL on that interface, so every use here has to cope with its absence —
 * see {@link clearRelayFilterEntry}.
 */
export interface RelayFilterLike {
  has(item: Uint8Array): boolean;
  remove?(item: Uint8Array): boolean;
}

/**
 * The slice of `@libp2p/circuit-relay-v2`'s `ReservationStore` this module drives.
 * Declared structurally because the class is internal to that package: naming only
 * the members we call keeps the coupling small, explicit and greppable, and lets
 * {@link findCircuitRelayTransport} duck-type rather than brand-match.
 *
 * `relayFilter` is optional because it is not required to DRIVE a reservation,
 * only to RE-drive one (see {@link clearRelayFilterEntry}); a libp2p version that
 * renames or drops it must degrade, not break.
 */
export interface RelayReservationStoreLike {
  addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
  hasReservation(peerId: PeerId): boolean;
  relayFilter?: RelayFilterLike;
}

/** The slice of libp2p's circuit-relay transport that owns the reservation store. */
export interface CircuitRelayTransportLike {
  reservationStore: RelayReservationStoreLike;
}

/** `components` is a real field on libp2p's node class but not on the `Libp2p` interface. */
interface Libp2pComponentsLike {
  components?: {
    transportManager?: {
      getTransports?: () => readonly unknown[];
    };
  };
}

/**
 * The node's `/p2p-circuit` multiaddrs — the addresses a peer can dial it at
 * while it holds a relay reservation. Empty means "not dialable via a relay
 * right now", which is exactly what makes {@link resolveRelayReservationState}
 * live rather than a stale snapshot.
 */
export function circuitMultiaddrs(node: Libp2p): string[] {
  return node
    .getMultiaddrs()
    .map((ma) => ma.toString())
    .filter((addr) => addr.includes('/p2p-circuit'));
}

/**
 * The node's `/p2p-circuit` multiaddrs THROUGH the relays `addrs` name — the ones
 * whose `/p2p/<relayPeerId>/p2p-circuit` component names one of them. This is the
 * "held" question a supervisor over a SUBSET of the node's relays has to ask: a
 * strand node runs one supervisor per relay, and relay X's supervisor must not be
 * satisfied by relay Y's addr, or a lost X is never re-driven.
 *
 * Falls back to EVERY circuit addr when any entry names no relay peer id (no
 * `/p2p/` component, or unparsable): such an addr can still be dialed and reserved
 * through, but the addr it earns cannot be attributed to it, so "any circuit addr"
 * is the only answer that does not mark a live reservation as lost. The control
 * node passes its whole relay list, so its answer is the same either way.
 */
export function circuitMultiaddrsVia(node: Libp2p, addrs: readonly string[]): string[] {
  const held = circuitMultiaddrs(node);
  const relayIds = addrs.map(relayPeerIdOf);
  if (relayIds.some((id) => id === null)) {
    return held;
  }
  return held.filter((circuit) => relayIds.includes(relayPeerIdOf(circuit)));
}

/**
 * The NORMALIZED peer id of the relay `addr` names: the `/p2p/` component just
 * before `/p2p-circuit` when there is one, else the trailing `/p2p/` component
 * (a relay DIAL addr). `null` when there is none, or `addr` does not parse.
 *
 * Normalized through `peerIdFromString(…).toString()` so a relay written in a
 * different encoding than libp2p publishes (a CID form, say) still matches.
 */
function relayPeerIdOf(addr: string): string | null {
  try {
    const components = multiaddr(addr).getComponents();
    const circuitIdx = components.findIndex((c) => c.name === 'p2p-circuit');
    const relayScope = circuitIdx >= 0 ? components.slice(0, circuitIdx) : components;
    const raw = trailingPeerId(multiaddr(relayScope));
    return raw === null ? null : peerIdFromString(raw).toString();
  } catch {
    return null;
  }
}

/**
 * The running node's circuit-relay transport, or `null` when it has none.
 *
 * There is no public libp2p API for "reserve on THIS specific relay", so this
 * reaches through `node.components.transportManager` — libp2p's internal layout.
 * That coupling is deliberate and bounded: every step is optional-chained and the
 * whole thing returns `null` rather than throwing, and a spec pins the seam so a
 * libp2p upgrade that moves it fails loudly instead of silently reverting this
 * module to the discovery wait that never fires.
 */
export function findCircuitRelayTransport(node: Libp2p): CircuitRelayTransportLike | null {
  for (const transport of nodeTransports(node)) {
    const store = (transport as { reservationStore?: unknown }).reservationStore;
    if (isReservationStore(store)) {
      return { reservationStore: store };
    }
  }
  return null;
}

function nodeTransports(node: Libp2p): readonly unknown[] {
  const manager = (node as Libp2p & Libp2pComponentsLike).components?.transportManager;
  if (typeof manager?.getTransports !== 'function') {
    log('No transportManager.getTransports() on this node — libp2p internals moved?');
    return [];
  }
  try {
    return manager.getTransports();
  } catch (err) {
    log('transportManager.getTransports() threw: %o', err);
    return [];
  }
}

function isReservationStore(value: unknown): value is RelayReservationStoreLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const store = value as Partial<RelayReservationStoreLike>;
  return typeof store.addRelay === 'function' && typeof store.hasReservation === 'function';
}

/** Sentinel resolved by the wait arm of {@link requestOneReservation}'s race. */
const WAIT_OVER = Symbol('relay-reservation-wait-over');

/** A relay that answered its dial, paired with the address it was dialed at. */
interface ConnectedRelay {
  addr: string;
  peerId: PeerId;
}

/**
 * Whether `signal` has been aborted.
 *
 * A function rather than an inline `signal?.aborted` because `AbortSignal.aborted`
 * is a readonly boolean: one `if (signal?.aborted)` narrows every LATER read of it
 * to `false`, and TypeScript then rejects the re-check as a comparison that can
 * never hold. Re-checking after each await is exactly what cancellation is, so the
 * narrowing is the thing that is wrong, not the check.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * `setTimeout` as a promise, cut short by `signal`.
 *
 * EVERY wait inside a drive routes through here, because a wait that merely LOSES
 * a `Promise.race` leaves its timer pending — and a pending timer keeps a Node
 * process alive for the rest of its duration, which is exactly the delay a
 * cancelled drive exists to shed. So the timer is cleared on both endings, not
 * only on its own.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (aborted(signal)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Relay `from`'s abort into `to`, and hand back the detach that must run on every
 * exit path.
 *
 * By hand rather than through `AbortSignal.any`, for the same reason this module
 * builds its deadline from an explicit `AbortController` rather than
 * `AbortSignal.timeout`: React Native/Hermes runs this same code, and `any` is
 * newer still — its polyfill also leaks listeners onto inputs that never abort,
 * which is what the returned detach avoids here.
 */
function linkAbort(from: AbortSignal | undefined, to: AbortController): () => void {
  if (from === undefined) {
    return () => { /* nothing was attached */ };
  }
  if (from.aborted) {
    to.abort();
    return () => { /* nothing was attached */ };
  }
  const forward = (): void => to.abort();
  from.addEventListener('abort', forward, { once: true });
  return () => from.removeEventListener('abort', forward);
}

/**
 * Dial every relay in `addrs`, ask the first one that answers for a reservation
 * slot, then wait until a `/p2p-circuit` address appears.
 *
 * Never throws — a dial rejection, a rejected reservation, a MALFORMED address,
 * or a timeout all come back as an `error` string. A dial that throws does NOT
 * cost the rest of the list: one dead relay among two must not cost the
 * reservation on the live one, so every addr is dialed and the first error (in
 * list order) is kept. A reservation that lands wins over any earlier error
 * (`error: null`).
 *
 * `timeoutMs` bounds the WHOLE drive — dials, reservation requests and the wait
 * share one deadline. `opts.signal` bounds it from the other side: every phase
 * below returns as soon as it trips, and the drive reports `cancelled` rather than
 * inventing a failure for a relay that was never given a chance to answer.
 */
export async function driveRelayReservation(
  node: Libp2p,
  addrs: readonly string[],
  opts?: RelayReserveOptions
): Promise<RelayReserveResult> {
  if (addrs.length === 0) {
    return { error: null, cancelled: false };
  }
  const signal = opts?.signal;
  if (aborted(signal)) {
    return { error: null, cancelled: true };
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RELAY_RESERVE_TIMEOUT_MS;
  // Clamped: a caller-supplied 0 would spin the poll loop hot until the deadline.
  const pollMs = Math.max(1, opts?.pollMs ?? DEFAULT_RELAY_RESERVE_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  const { connected, error: dialError } = await dialRelays(node, addrs, deadline, signal);
  const attempt = await requestReservation(node, connected, deadline, signal);
  // NOTE: a REJECTED reservation still spends the rest of the deadline polling,
  // because discovery may independently land one (only the no-transport case is
  // `fatal`). So a misconfigured node reports its now-legible reason a full
  // `timeoutMs` late. If startup latency on that path ever matters, shorten the
  // wait once every connected relay has rejected — do not skip it outright.
  if (!attempt.fatal && (await waitForCircuitReservation(node, addrs, deadline, pollMs, signal))) {
    return { error: null, cancelled: false };
  }
  // Checked AFTER the success above, so a reservation that landed in the same turn
  // the signal tripped is still reported as landed. Below it, the reasons the
  // phases assembled describe the cancellation rather than the relay, so they are
  // dropped: a cancelled drive has nothing to say about the relay's health.
  if (aborted(signal)) {
    return { error: null, cancelled: true };
  }
  return {
    error: attempt.error ?? dialError ?? `no circuit reservation within ${timeoutMs}ms`,
    cancelled: false
  };
}

/**
 * Dial every relay CONCURRENTLY under the drive's shared deadline. Reports the
 * relays that answered (in list order, for the reservation step) and the first
 * failure in LIST order (`null` when every dial connected).
 *
 * Concurrent and deadline-bound because this whole drive is awaited on a browser
 * tab's startup path: dialing serially with libp2p's own (much longer) per-dial
 * timeout meant N unreachable relays cost N dial timeouts before the reservation
 * request even began, so `timeoutMs` bounded only the tail of the operation.
 *
 * Aborting a dial at the deadline is not a lost reservation — the steps that
 * follow have no time left either, so the drive would report `error` regardless.
 *
 * The caller's `signal` aborts the same dials, through the same controller: a
 * hanging dial is the longest thing a cancelled drive can be sitting in.
 */
async function dialRelays(
  node: Libp2p,
  addrs: readonly string[],
  deadline: number,
  signal?: AbortSignal
): Promise<{ connected: ConnectedRelay[]; error: string | null }> {
  // An explicit controller, not `AbortSignal.timeout` — the latter is not
  // reliably present on React Native/Hermes, which runs this same module.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  const unlink = linkAbort(signal, controller);
  try {
    const results = await Promise.allSettled(
      addrs.map((addr) => dialOne(node, addr, controller.signal))
    );
    return { connected: connectedRelays(addrs, results), error: firstDialError(addrs, results) };
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/**
 * One dial, with the address PARSED INSIDE the promise.
 *
 * `multiaddr()` throws SYNCHRONOUSLY on a malformed string, and a throw out of
 * the `map` callback escapes `Promise.allSettled` altogether — it would reject
 * the whole drive (breaking the never-throws contract) and discard the dials to
 * the other, perfectly good, addrs. `async` demotes it to a settled rejection,
 * which is already exactly how a dial failure is reported.
 */
async function dialOne(
  node: Libp2p,
  addr: string,
  signal: AbortSignal
): Promise<{ remotePeer: PeerId }> {
  return node.dial(multiaddr(addr), { signal });
}

function connectedRelays(
  addrs: readonly string[],
  results: readonly PromiseSettledResult<{ remotePeer: PeerId }>[]
): ConnectedRelay[] {
  const connected: ConnectedRelay[] = [];
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    connected.push({ addr: addrs[index], peerId: result.value.remotePeer });
  });
  return connected;
}

/** Log every dial rejection; return the first one in list order. */
function firstDialError(
  addrs: readonly string[],
  results: readonly PromiseSettledResult<unknown>[]
): string | null {
  let first: string | null = null;
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    log('Relay dial failed (%s): %s', addrs[index], message);
    first ??= message;
  });
  return first;
}

/**
 * Outcome of the explicit reservation request.
 *
 * `fatal` means no `/p2p-circuit` address can EVER appear (the node has no
 * circuit-relay transport at all), so the caller must report immediately rather
 * than spend the rest of the deadline polling for something that cannot happen.
 * A rejected request is NOT fatal: discovery may still land a reservation for a
 * relay that does happen to share this node's identify prefix.
 */
interface ReservationAttempt {
  error: string | null;
  fatal: boolean;
}

/**
 * Ask the connected relays, in list order, for a reservation slot; stop at the
 * first success.
 *
 * `'discovered'`, not `'configured'`: the search listener's
 * `relay:created-reservation` handler ignores `configured` reservations outright,
 * so the `/p2p-circuit` listen address would never be published and
 * `getMultiaddrs()` would stay empty even though the reservation succeeded.
 * `'discovered'` consumes the pending-reservation id the bare `/p2p-circuit`
 * listener registered, which is exactly what that handler matches on.
 *
 * Sequential, not concurrent: a bare `/p2p-circuit` listener registers exactly
 * ONE pending reservation, so a second concurrent `addRelay` would be rejected
 * with `HadEnoughRelaysError` — noise, not a failure. Running discovery is not a
 * conflict either; `addRelay` dedupes through its own peer queue, so a relay that
 * genuinely is discoverable still reserves exactly once.
 */
async function requestReservation(
  node: Libp2p,
  connected: readonly ConnectedRelay[],
  deadline: number,
  signal?: AbortSignal
): Promise<ReservationAttempt> {
  if (connected.length === 0) {
    // Nothing answered — the dial error is the whole story.
    return { error: null, fatal: false };
  }
  const transport = findCircuitRelayTransport(node);
  if (transport === null) {
    return {
      error: 'node has no circuit-relay transport — add circuitRelayTransport() to its transports',
      fatal: true
    };
  }
  let firstError: string | null = null;
  for (const relay of connected) {
    if (transport.reservationStore.hasReservation(relay.peerId)) {
      return { error: null, fatal: false };
    }
    // A cancelled drive stops here rather than asking the next relay: the caller is
    // tearing this node down, so another hop request against it can only fail.
    if (Date.now() >= deadline || aborted(signal)) {
      break;
    }
    const failure = await requestOneReservation(
      transport.reservationStore,
      relay,
      deadline,
      signal
    );
    if (failure === null) {
      return { error: null, fatal: false };
    }
    firstError ??= failure;
  }
  return { error: firstError, fatal: false };
}

/**
 * One `addRelay` call, bounded by the drive's deadline and by the caller's signal.
 * Returns `null` on success, or the reason it stopped waiting.
 *
 * Raced rather than passed a signal because `addRelay` accepts none and runs on
 * libp2p's own (much longer) reservation timeout: without the race a drive given
 * 1.5 s would sit on a silent relay for libp2p's timeout instead. The abandoned
 * promise stays handled — `Promise.race` attaches its own handlers — so a later
 * rejection is not unhandled, and is not logged either: a request abandoned at a
 * cancellation must not print a relay failure the caller would read as real.
 *
 * `waitOver` ends the wait on BOTH routes — the caller's abort, relayed in, and the
 * race settling some other way, aborted in the `finally`. Out-racing the deadline
 * timer is not enough: the loser stays pending, and a pending timer is what holds
 * a Node process open past the stop that asked for it.
 */
async function requestOneReservation(
  store: RelayReservationStoreLike,
  relay: ConnectedRelay,
  deadline: number,
  signal?: AbortSignal
): Promise<string | null> {
  const waitOver = new AbortController();
  const unlink = linkAbort(signal, waitOver);
  try {
    const outcome = await Promise.race([
      store.addRelay(relay.peerId, 'discovered'),
      delay(Math.max(0, deadline - Date.now()), waitOver.signal).then(() => WAIT_OVER)
    ]);
    if (outcome !== WAIT_OVER) {
      return null;
    }
    if (aborted(signal)) {
      return `relay reservation request to ${relay.addr} was cancelled`;
    }
    log('Relay reservation request (%s) still pending at the deadline', relay.addr);
    return `relay reservation request to ${relay.addr} did not complete before the deadline`;
  } catch (err) {
    const message = describeReservationFailure(err, relay.addr);
    log('Relay reservation failed (%s): %s', relay.addr, message);
    return message;
  } finally {
    unlink();
    waitOver.abort();
  }
}

/**
 * Turn libp2p's reservation rejection into a reason that names the actual cause.
 *
 * `HadEnoughRelaysError` needs translating rather than passing through: its own
 * message ("we do not need any more relays") says the opposite of what happened.
 * A `'discovered'` reservation is refused when the node holds NO pending
 * reservation id, and a node holds one only while it listens on the bare
 * `/p2p-circuit` search address — so the real cause is a missing listen address.
 */
function describeReservationFailure(err: unknown, addr: string): string {
  // NOTE: libp2p adds a peer to the reservation store's `relayFilter` when a
  // request fails with `DialError` or `UnsupportedProtocolError`, and the failure
  // path does not reset that filter (it only resets when a reservation is actually
  // removed). So a SECOND drive against the same relay in the same process reports
  // `ListenError: The relay was previously invalid` even if the relay has since
  // recovered. `RelayReservationLoop` clears the entry before every attempt (see
  // {@link clearRelayFilterEntry}); a caller that re-drives WITHOUT the supervisor
  // still has to deal with the filter itself.
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'HadEnoughRelaysError':
      return `relay reservation on ${addr} was not requested: this node holds no pending circuit reservation — it is not listening on the bare /p2p-circuit address`;
    case 'UnsupportedProtocolError':
      return `peer at ${addr} does not speak the circuit-relay hop protocol — it is not a relay`;
    default:
      return `relay reservation on ${addr} failed: ${message}`;
  }
}

/**
 * Poll until the node advertises a `/p2p-circuit` address through one of `addrs`'
 * relays ({@link circuitMultiaddrsVia}), the deadline passes, or the drive is
 * cancelled. This is the phase a cancellation has to reach: whatever the dial and
 * the reservation request shed, an abandoned drive used to spend here instead,
 * polling a node whose transports were already being torn down.
 *
 * Still a poll even though the reservation is now requested explicitly: `addRelay`
 * resolving means the RELAY accepted, while the listen address is published a tick
 * later by the listener's `relay:created-reservation` handler, and a reservation
 * that discovery lands independently has no return value to await at all.
 *
 * NOTE: polls rather than subscribing to libp2p's `self:peer:update` — it keeps
 * this free of libp2p event-name coupling. If 250 ms of reservation latency ever
 * matters, switch to the event and keep the poll as a fallback.
 */
async function waitForCircuitReservation(
  node: Libp2p,
  addrs: readonly string[],
  deadline: number,
  pollMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  for (;;) {
    if (circuitMultiaddrsVia(node, addrs).length > 0) {
      return true;
    }
    if (Date.now() >= deadline || aborted(signal)) {
      return false;
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/** Gap between liveness checks while a reservation is held. */
export const DEFAULT_RELAY_CHECK_MS = 5_000;
/** Backoff before the first re-drive after a failed attempt. */
export const DEFAULT_RELAY_MIN_BACKOFF_MS = 2_000;
/** Ceiling the backoff doubles up to. */
export const DEFAULT_RELAY_MAX_BACKOFF_MS = 60_000;

/**
 * Everything one drive takes, minus its `signal`, plus the loop's own cadence.
 *
 * `signal` is omitted rather than inherited because these options are handed
 * straight to every drive: a caller-supplied one would cancel each attempt without
 * the loop knowing, leaving it to reschedule drives that return immediately and
 * forever. The way to cancel a supervisor is
 * {@link RelayReservationSupervisor.stop}, which owns the signal it passes down.
 */
export interface RelayReservationSupervisorOptions extends Omit<RelayReserveOptions, 'signal'> {
  /** Gap between liveness checks while a reservation is held. Default 5_000. */
  checkMs?: number;
  /** Backoff before the first re-drive after a failure. Default 2_000. */
  minBackoffMs?: number;
  /** Backoff ceiling. Default 60_000. */
  maxBackoffMs?: number;
  /**
   * Awaited before every drive AFTER the first — never before the first attempt,
   * which the caller has typically prepared for already. A hook that throws or
   * rejects is logged and the drive still runs: the hook is preparation, and a
   * failed preparation must not cost the attempt itself.
   *
   * What a strand node uses it for: re-announcing its delegate peer id to the relay
   * about to be re-dialed. A party control node running the relay server admits a
   * strand node on an in-memory delegate grant, and a relay restart drops every
   * grant it held — so a re-drive that did not re-announce first would be denied
   * at the relay's connection gate.
   */
  beforeRedrive?: () => Promise<void> | void;
}

/**
 * A running retry loop for one node + relay list. Obtained from
 * {@link superviseRelayReservation}; its only imperative is {@link stop}.
 */
export interface RelayReservationSupervisor {
  /**
   * Resolves once the FIRST attempt has settled — so a caller can await startup
   * exactly as it awaited a single {@link driveRelayReservation}, and the retries
   * carry on in the background afterwards. Also resolves on {@link stop}, so an
   * awaiting caller is never left hanging.
   */
  readonly firstAttempt: Promise<void>;
  /** True while a drive is in flight. */
  readonly driving: boolean;
  /** Epoch ms of the next scheduled tick; `null` while a drive is running. */
  readonly retryAtMs: number | null;
  /** Reason the last drive produced no reservation; `null` once one is held. */
  readonly lastError: string | null;
  /**
   * Idempotent. Clears the timer so no further drive is scheduled, and CANCELS the
   * drive already in flight: it stops dialing or polling, clears every timer it
   * holds and reports `cancelled`, so a teardown does not trail an attempt against
   * the node it is dismantling. That result is discarded — a cancelled drive is
   * not a failure — and nothing follows it.
   */
  stop(): void;
}

/**
 * Keep asking for a relay reservation until one is held, then keep watching that
 * it still is — the thing that makes a lost reservation recover on its own.
 *
 * Needed because nothing else re-drives: libp2p re-fills a search listener's
 * freed slot from relay DISCOVERY, and a cadre node's namespaced identify puts
 * discovery permanently out of reach (see the module header). Without this loop a
 * relay restart left a browser tab undialable until the user reloaded the page.
 *
 * Per tick:
 *  - a reservation is held → reset the backoff, clear the error, re-check in
 *    `checkMs`. No drive: a healthy node must not re-request every few seconds.
 *  - otherwise → un-poison the reservation store's relay filter (see
 *    {@link clearRelayFilterEntry}) and run ONE {@link driveRelayReservation}.
 *    If that lands a reservation, rejoin the healthy path above; if not, sleep
 *    the current backoff and double it up to `maxBackoffMs`.
 *
 * "Held" is judged PER RELAY — a circuit addr through one of `addrs`' relays
 * ({@link circuitMultiaddrsVia}) — so several loops over one node, one relay each
 * (a strand node), each re-drive exactly the relay they own. Every drive after the
 * first is preceded by the optional `beforeRedrive` hook
 * ({@link RelayReservationSupervisorOptions}).
 *
 * Starts immediately; the first tick runs before this returns.
 */
export function superviseRelayReservation(
  node: Libp2p,
  addrs: readonly string[],
  opts?: RelayReservationSupervisorOptions
): RelayReservationSupervisor {
  return new RelayReservationLoop(node, [...addrs], opts ?? {});
}

/**
 * Forget that `addr`'s peer ever failed a reservation request, so the next
 * attempt is actually made rather than refused out of hand.
 *
 * `ReservationStore` records a peer in `relayFilter` when its reservation request
 * fails with `DialError` or `UnsupportedProtocolError`, and NOTHING on that path
 * ever clears it: the reset lives in `#checkReservationCount`, which only runs
 * when a reservation is genuinely removed, and `#removeReservation` early-returns
 * when there was never one. So a relay that was briefly not-a-relay (or died
 * between our dial and the hop request) stays permanently rejected with
 * `The relay was previously invalid` — measured, not inferred.
 *
 * Fails soft in every direction: no `relayFilter`, no `remove`, an addr with no
 * peer id, a malformed addr — all mean "no un-poisoning", never a throw. The
 * retry loop still recovers the common case without this, because a relay that is
 * simply DOWN fails our own dial first and never reaches the filter.
 *
 * Returns whether an entry was actually removed (for specs; callers ignore it).
 */
export function clearRelayFilterEntry(store: RelayReservationStoreLike, addr: string): boolean {
  const filter = store.relayFilter;
  if (typeof filter?.remove !== 'function') {
    log('Reservation store has no removable relayFilter — cannot un-poison %s', addr);
    return false;
  }
  try {
    // The peer id is in the multiaddr, so this costs no dial and can run before one.
    const peerId = trailingPeerId(multiaddr(addr));
    if (peerId === null) {
      // NOTE: an addr with no `/p2p/` component can still be dialed and reserved
      // through (the peer id comes off the connection), but it can never be
      // un-poisoned — so for THAT addr a poisoned filter is permanent again. No
      // caller supplies such an addr today; if one ever does, resolve the peer id
      // from the live connection instead of the multiaddr.
      return false;
    }
    return filter.remove(peerIdFromString(peerId).toMultihash().bytes);
  } catch (err) {
    log('Could not clear the relayFilter entry for %s: %o', addr, err);
    return false;
  }
}

/** The self-rescheduling loop behind {@link superviseRelayReservation}. */
class RelayReservationLoop implements RelayReservationSupervisor {
  readonly firstAttempt: Promise<void>;

  private readonly checkMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private backoffMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Tripped by {@link stop}; the only thing that cancels a drive of this loop's. */
  private readonly cancel = new AbortController();
  private stopped = false;
  private inFlight = false;
  /** Drives started so far — the `beforeRedrive` hook runs from the second one on. */
  private drives = 0;
  private nextTickAtMs: number | null = null;
  private failure: string | null = null;
  private settleFirstAttempt: () => void = () => {};
  private firstAttemptSettled = false;

  constructor(
    private readonly node: Libp2p,
    private readonly addrs: readonly string[],
    private readonly opts: RelayReservationSupervisorOptions
  ) {
    // Clamped away from 0: a caller-supplied 0 would spin the loop hot.
    this.checkMs = Math.max(1, opts.checkMs ?? DEFAULT_RELAY_CHECK_MS);
    this.minBackoffMs = Math.max(1, opts.minBackoffMs ?? DEFAULT_RELAY_MIN_BACKOFF_MS);
    this.maxBackoffMs = Math.max(
      this.minBackoffMs,
      opts.maxBackoffMs ?? DEFAULT_RELAY_MAX_BACKOFF_MS
    );
    this.backoffMs = this.minBackoffMs;
    this.firstAttempt = new Promise((resolve) => {
      this.settleFirstAttempt = resolve;
    });
    void this.tick();
  }

  get driving(): boolean {
    return this.inFlight;
  }

  get retryAtMs(): number | null {
    return this.nextTickAtMs;
  }

  get lastError(): string | null {
    return this.failure;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    // The scheduled attempt and the running one are two different things to end:
    // the timer covers the first, the signal the second.
    this.cancel.abort();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextTickAtMs = null;
    this.settleFirst();
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.nextTickAtMs = null;
    if (this.reservationHeld()) {
      this.onReservationHeld();
      return;
    }
    await this.driveOnce();
    if (this.stopped) {
      return;
    }
    this.settleFirst();
    // A drive that LANDED a reservation resumes the healthy cadence immediately.
    // Backing off here instead would leave the first liveness check after a long
    // outage a fully grown backoff away (up to `maxBackoffMs`), so a reservation
    // lost again right after recovery would go unnoticed for that whole window.
    if (this.reservationHeld()) {
      this.onReservationHeld();
      return;
    }
    this.scheduleBackoff();
  }

  /** Per relay: only a circuit addr THROUGH one of this loop's relays counts. */
  private reservationHeld(): boolean {
    return circuitMultiaddrsVia(this.node, this.addrs).length > 0;
  }

  /** Healthy tick: nothing to request, so only reset and re-check later. */
  private onReservationHeld(): void {
    this.backoffMs = this.minBackoffMs;
    this.failure = null;
    this.settleFirst();
    this.schedule(this.checkMs);
  }

  private async driveOnce(): Promise<void> {
    this.inFlight = true;
    try {
      if (this.drives > 0) {
        await this.runBeforeRedrive();
        // A stop that arrived while the hook ran: nothing follows it, so do not dial
        // a node that is being torn down.
        if (this.stopped) {
          return;
        }
      }
      this.drives += 1;
      this.unpoisonRelayFilter();
      const { error, cancelled } = await driveRelayReservation(this.node, this.addrs, {
        ...this.opts,
        signal: this.cancel.signal
      });
      // A cancelled drive landed nothing AND failed at nothing, so it has no status
      // to report: recording it would surface a teardown artifact through
      // `getRelayReservationState()` as if the relay had refused.
      if (!this.stopped && !cancelled) {
        this.failure = error;
      }
    } catch (err) {
      // `driveRelayReservation` is fail-soft by contract, so reaching here means
      // that contract broke. The loop must survive it anyway: an escaping
      // rejection would leave `firstAttempt` pending FOREVER (hanging every
      // caller that awaits a reservation at startup) and schedule no further
      // attempt, which is the failure this whole supervisor exists to prevent.
      const message = err instanceof Error ? err.message : String(err);
      log('Relay reservation drive threw, which it should not: %s', message);
      if (!this.stopped) {
        this.failure = message;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleBackoff(): void {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.schedule(wait);
  }

  /** The caller's `beforeRedrive` hook, contained: a throw or rejection is logged, never propagated. */
  private async runBeforeRedrive(): Promise<void> {
    const hook = this.opts.beforeRedrive;
    if (hook === undefined) {
      return;
    }
    try {
      await hook();
    } catch (err) {
      log('beforeRedrive hook failed (%o); driving the reservation anyway: %o', this.addrs, err);
    }
  }

  private unpoisonRelayFilter(): void {
    const transport = findCircuitRelayTransport(this.node);
    if (transport === null) {
      return;
    }
    for (const addr of this.addrs) {
      clearRelayFilterEntry(transport.reservationStore, addr);
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) {
      return;
    }
    this.nextTickAtMs = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    // Node keeps the process alive while a timer is pending, so an un-unref'd
    // supervisor would hang every CLI run and vitest worker that ever reserved.
    // Cast + optional-chain: browsers and React Native have no `unref`.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private settleFirst(): void {
    if (this.firstAttemptSettled) {
      return;
    }
    this.firstAttemptSettled = true;
    this.settleFirstAttempt();
  }
}

/**
 * Derive the reservation posture, reading the node's circuit addrs LIVE. Pure
 * apart from that read, so the precedence is testable on its own:
 *
 * | condition                | status                                          |
 * | ------------------------ | ----------------------------------------------- |
 * | no addrs supplied        | `none`                                          |
 * | live circuit addrs held  | `reserved` (`error: null`)                      |
 * | a drive is in flight     | `dialing`                                       |
 * | a retry is scheduled     | `retrying`                                      |
 * | otherwise                | `error`                                         |
 *
 * `reserved` is checked BEFORE `error` on purpose: the circuit addrs are read
 * live, so a reservation that lands by ANY route supersedes a stale error string
 * without a second drive.
 *
 * `retrying` sits between the two so that `error` carries a sharper meaning:
 * NOBODY IS GOING TO TRY AGAIN. A lost reservation does come back on its own now,
 * as long as a {@link RelayReservationSupervisor} is running — that loop is the
 * only thing that re-drives, since libp2p re-fills a search listener's freed slot
 * from relay DISCOVERY, which a cadre node's namespaced identify puts permanently
 * out of reach (see the module header). So `error` means the supervisor was
 * stopped, was never started, or there is no node at all.
 *
 * `retryAtMs` is the supervisor's next scheduled tick (`null` while a drive runs
 * or when there is no supervisor); it both selects `retrying` and is passed
 * through so a UI can count down to the next attempt.
 */
export function resolveRelayReservationState(
  node: Libp2p | null,
  addrs: readonly string[],
  lastError: string | null,
  driving: boolean,
  retryAtMs: number | null
): RelayReservationState {
  if (addrs.length === 0) {
    return { status: 'none', addrs: [], circuitAddrs: [], error: null, retryAtMs: null };
  }
  const supplied = [...addrs];
  const circuitAddrs = node ? circuitMultiaddrs(node) : [];
  if (circuitAddrs.length > 0) {
    return { status: 'reserved', addrs: supplied, circuitAddrs, error: null, retryAtMs };
  }
  if (driving) {
    return {
      status: 'dialing',
      addrs: supplied,
      circuitAddrs: [],
      error: lastError,
      retryAtMs: null
    };
  }
  // `driveRelayReservation` always reports a reason when it finishes without a
  // reservation, so `lastError` is normally set below. The fallback only covers
  // addrs recorded without a completed drive.
  const error = lastError ?? 'no circuit reservation held';
  if (retryAtMs !== null) {
    return { status: 'retrying', addrs: supplied, circuitAddrs: [], error, retryAtMs };
  }
  return { status: 'error', addrs: supplied, circuitAddrs: [], error, retryAtMs: null };
}
