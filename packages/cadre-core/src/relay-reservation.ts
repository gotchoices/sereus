/**
 * Relay reservation for nodes that reserve through the SEARCH listen addr — the
 * dial, the explicit reservation request, and the (live) status derivation.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen
 * address, and the two shapes are alternatives, not layers:
 *
 * | listen addr                                       | libp2p behaviour                                                                     | unreachable relay          |
 * | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
 * | `<dial addr>/p2p/<relayPeerId>/p2p-circuit`        | CONFIGURED reservation: dial that exact relay and reserve, or fail                     | `listen()` throws          |
 * | bare `/p2p-circuit`                                | SEARCH mode: register a pending reservation, to be filled by relay discovery           | nothing throws, no reserve |
 *
 * The configured shape is what `relay-addrs.ts` builds out of `network.relayAddrs`.
 * It is **fail-fast by construction**: libp2p's transport manager throws
 * `UnsupportedListenAddressesError` when any configured listen address fails to
 * listen under the default `FATAL_ALL` fault tolerance, so naming a relay that is
 * down means the node does not start. Good for a server; wrong for a browser tab,
 * which must still boot (solo, undialable) when its relay is down.
 *
 * So a browser-shaped node listens on bare `/p2p-circuit` and needs someone to
 * (a) dial the relay and (b) fill the pending reservation that listener created,
 * then report whether one actually landed. That is this module. It is **fail-soft
 * by construction**: nothing here throws.
 *
 * Do NOT "consolidate" the two by also setting `network.relayAddrs` on a node
 * that reserves this way — that re-introduces the fatal configured listener
 * alongside the search listener and the tab stops booting when the relay is down.
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
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p, PeerId } from '@libp2p/interface';

const log = debug('sereus:cadre:relay-reservation');

/**
 * Relay-reservation posture for a node that reserves through the SEARCH listen
 * addr (bare `/p2p-circuit`) rather than a configured `network.relayAddrs` entry.
 *  - `none`     — no relay addrs supplied; the node is undialable by design.
 *  - `dialing`  — a drive is in flight.
 *  - `reserved` — the node currently holds at least one `/p2p-circuit` addr.
 *  - `error`    — the last drive failed, or finished with no reservation, and
 *                 none is held now.
 */
export type RelayReservationStatus = 'none' | 'dialing' | 'reserved' | 'error';

export interface RelayReservationState {
  status: RelayReservationStatus;
  /** The relay multiaddrs this node was asked to reserve through. */
  addrs: string[];
  /** LIVE `/p2p-circuit` multiaddrs, recomputed on every read. */
  circuitAddrs: string[];
  error: string | null;
}

/** How long {@link driveRelayReservation} waits for a reservation to appear. */
export const DEFAULT_RELAY_RESERVE_TIMEOUT_MS = 10_000;
export const DEFAULT_RELAY_RESERVE_POLL_MS = 250;

export interface RelayReserveOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * The slice of `@libp2p/circuit-relay-v2`'s `ReservationStore` this module drives.
 * Declared structurally because the class is internal to that package: naming only
 * the two members we call keeps the coupling small, explicit and greppable, and
 * lets {@link findCircuitRelayTransport} duck-type rather than brand-match.
 */
export interface RelayReservationStoreLike {
  addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
  hasReservation(peerId: PeerId): boolean;
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

/** Sentinel resolved by the deadline race in {@link requestOneReservation}. */
const DEADLINE_PASSED = Symbol('relay-reservation-deadline-passed');

/** A relay that answered its dial, paired with the address it was dialed at. */
interface ConnectedRelay {
  addr: string;
  peerId: PeerId;
}

/**
 * Dial every relay in `addrs`, ask the first one that answers for a reservation
 * slot, then wait until a `/p2p-circuit` address appears.
 *
 * Never throws — a dial rejection, a rejected reservation, or a timeout comes
 * back as an `error` string. A dial that throws does NOT cost the rest of the
 * list: one dead relay among two must not cost the reservation on the live one,
 * so every addr is dialed and the first error (in list order) is kept. A
 * reservation that lands wins over any earlier error (`error: null`).
 *
 * `timeoutMs` bounds the WHOLE drive — dials, reservation requests and the wait
 * share one deadline.
 */
export async function driveRelayReservation(
  node: Libp2p,
  addrs: readonly string[],
  opts?: RelayReserveOptions
): Promise<{ error: string | null }> {
  if (addrs.length === 0) {
    return { error: null };
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RELAY_RESERVE_TIMEOUT_MS;
  // Clamped: a caller-supplied 0 would spin the poll loop hot until the deadline.
  const pollMs = Math.max(1, opts?.pollMs ?? DEFAULT_RELAY_RESERVE_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  const { connected, error: dialError } = await dialRelays(node, addrs, deadline);
  const attempt = await requestReservation(node, connected, deadline);
  // NOTE: a REJECTED reservation still spends the rest of the deadline polling,
  // because discovery may independently land one (only the no-transport case is
  // `fatal`). So a misconfigured node reports its now-legible reason a full
  // `timeoutMs` late. If startup latency on that path ever matters, shorten the
  // wait once every connected relay has rejected — do not skip it outright.
  if (!attempt.fatal && (await waitForCircuitReservation(node, deadline, pollMs))) {
    return { error: null };
  }
  return {
    error: attempt.error ?? dialError ?? `no circuit reservation within ${timeoutMs}ms`
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
 */
async function dialRelays(
  node: Libp2p,
  addrs: readonly string[],
  deadline: number
): Promise<{ connected: ConnectedRelay[]; error: string | null }> {
  // An explicit controller, not `AbortSignal.timeout` — the latter is not
  // reliably present on React Native/Hermes, which runs this same module.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  try {
    const results = await Promise.allSettled(
      addrs.map((addr) => node.dial(multiaddr(addr), { signal: controller.signal }))
    );
    return { connected: connectedRelays(addrs, results), error: firstDialError(addrs, results) };
  } finally {
    clearTimeout(timer);
  }
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
  deadline: number
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
    if (Date.now() >= deadline) {
      break;
    }
    const failure = await requestOneReservation(transport.reservationStore, relay, deadline);
    if (failure === null) {
      return { error: null, fatal: false };
    }
    firstError ??= failure;
  }
  return { error: firstError, fatal: false };
}

/**
 * One `addRelay` call, bounded by the drive's deadline. Returns `null` on
 * success, or the reason it failed.
 *
 * Deadline-raced because `addRelay` runs on libp2p's own (much longer) reservation
 * timeout and takes no signal: without the race a drive given 1.5 s would sit on a
 * silent relay for libp2p's timeout instead. The abandoned promise stays handled —
 * `Promise.race` attaches its own handlers — so a later rejection is not unhandled.
 */
async function requestOneReservation(
  store: RelayReservationStoreLike,
  relay: ConnectedRelay,
  deadline: number
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), Math.max(0, deadline - Date.now()));
  });
  try {
    const outcome = await Promise.race([store.addRelay(relay.peerId, 'discovered'), expired]);
    if (outcome === DEADLINE_PASSED) {
      log('Relay reservation request (%s) still pending at the deadline', relay.addr);
      return `relay reservation request to ${relay.addr} did not complete before the deadline`;
    }
    return null;
  } catch (err) {
    const message = describeReservationFailure(err, relay.addr);
    log('Relay reservation failed (%s): %s', relay.addr, message);
    return message;
  } finally {
    clearTimeout(timer);
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
 * Poll until the node advertises a `/p2p-circuit` address, or the deadline passes.
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
  deadline: number,
  pollMs: number
): Promise<boolean> {
  for (;;) {
    if (circuitMultiaddrs(node).length > 0) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * | otherwise                | `error`                                         |
 *
 * `reserved` is checked BEFORE `error` on purpose: a relay that comes back after
 * a failed drive self-heals to `reserved` with no second drive, because the
 * circuit addrs are read live and a live reservation supersedes a stale error.
 */
export function resolveRelayReservationState(
  node: Libp2p | null,
  addrs: readonly string[],
  lastError: string | null,
  driving: boolean
): RelayReservationState {
  if (addrs.length === 0) {
    return { status: 'none', addrs: [], circuitAddrs: [], error: null };
  }
  const supplied = [...addrs];
  const circuitAddrs = node ? circuitMultiaddrs(node) : [];
  if (circuitAddrs.length > 0) {
    return { status: 'reserved', addrs: supplied, circuitAddrs, error: null };
  }
  if (driving) {
    return { status: 'dialing', addrs: supplied, circuitAddrs: [], error: lastError };
  }
  // `driveRelayReservation` always reports a reason when it finishes without a
  // reservation, so `lastError` is normally set here. The fallback only covers
  // addrs recorded without a completed drive.
  return {
    status: 'error',
    addrs: supplied,
    circuitAddrs: [],
    error: lastError ?? 'no circuit reservation held'
  };
}
