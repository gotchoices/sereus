/**
 * Relay reservation for nodes that reserve through the SEARCH listen addr — the
 * dial, the wait, and the (live) status derivation.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen
 * address, and the two shapes are alternatives, not layers:
 *
 * | listen addr                                       | libp2p behaviour                                                                     | unreachable relay          |
 * | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
 * | `<dial addr>/p2p/<relayPeerId>/p2p-circuit`        | CONFIGURED reservation: dial that exact relay and reserve, or fail                     | `listen()` throws          |
 * | bare `/p2p-circuit`                                | SEARCH mode: run relay discovery, reserve on any connected peer speaking the hop proto | nothing throws, no reserve |
 *
 * The configured shape is what `relay-addrs.ts` builds out of `network.relayAddrs`.
 * It is **fail-fast by construction**: libp2p's transport manager throws
 * `UnsupportedListenAddressesError` when any configured listen address fails to
 * listen under the default `FATAL_ALL` fault tolerance, so naming a relay that is
 * down means the node does not start. Good for a server; wrong for a browser tab,
 * which must still boot (solo, undialable) when its relay is down.
 *
 * So a browser-shaped node listens on bare `/p2p-circuit` and needs someone to
 * (a) dial the relay so discovery has a candidate to reserve on, and (b) report
 * whether a reservation actually landed. That is this module. It is **fail-soft
 * by construction**: nothing here throws.
 *
 * Do NOT "consolidate" the two by also setting `network.relayAddrs` on a node
 * that reserves this way — that re-introduces the fatal configured listener
 * alongside the search listener and the tab stops booting when the relay is down.
 *
 * ⚠️ SEARCH MODE DOES NOT WORK AGAINST THE RELAY THIS REPO DEPLOYS. Discovery
 * reserves only on a connected peer whose IDENTIFY-learned protocol list carries
 * the relay-hop codec, and `@optimystic/db-p2p` namespaces identify per network
 * (`/optimystic/control-<partyId>/id/1.0.0`) while `ops/docker/libp2p-infra` runs
 * stock identify — so the two never identify each other and no reservation is ever
 * attempted. The dial still succeeds, so this surfaces as a generic timeout.
 * Tracked by `tickets/fix/relay-search-listener-cannot-discover-stock-relay.md`;
 * reproduced in `test/relay-reservation.spec.ts`. Nothing below is wrong — this
 * module drives and reports correctly — but `reserved` is currently unreachable
 * in production.
 *
 * Status is derived from the node's LIVE multiaddrs on every read rather than
 * cached at drive time: when a relay restarts or the connection drops, libp2p's
 * listener clears its listening addrs and the circuit multiaddr disappears, so a
 * cached snapshot would keep claiming `reserved` for a node nothing can dial.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from '@libp2p/interface';

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
 * Dial every relay in `addrs` (putting them in the peer store so the search-mode
 * listener can reserve on one), then wait until a `/p2p-circuit` address appears.
 *
 * Never throws — a dial rejection or a timeout comes back as an `error` string.
 * A dial that throws does NOT cost the rest of the list: one dead relay among two
 * must not cost the reservation on the live one, so every addr is dialed and the
 * first error (in list order) is kept. A reservation that lands wins over any
 * dial error (`error: null`).
 *
 * `timeoutMs` bounds the WHOLE drive — dials and wait share one deadline.
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

  const dialError = await dialRelays(node, addrs, deadline);
  if (await waitForCircuitReservation(node, deadline, pollMs)) {
    return { error: null };
  }
  return { error: dialError ?? `no circuit reservation within ${timeoutMs}ms` };
}

/**
 * Dial every relay CONCURRENTLY under the drive's shared deadline, and report the
 * first failure in LIST order (`null` when every dial connected).
 *
 * Concurrent and deadline-bound because this whole drive is awaited on a browser
 * tab's startup path: dialing serially with libp2p's own (much longer) per-dial
 * timeout meant N unreachable relays cost N dial timeouts before the reservation
 * wait even began, so `timeoutMs` bounded only the tail of the operation.
 *
 * Aborting a dial at the deadline is not a lost reservation — the wait that
 * follows has no time left either, so the drive would report `error` regardless.
 */
async function dialRelays(
  node: Libp2p,
  addrs: readonly string[],
  deadline: number
): Promise<string | null> {
  // An explicit controller, not `AbortSignal.timeout` — the latter is not
  // reliably present on React Native/Hermes, which runs this same module.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  try {
    const results = await Promise.allSettled(
      addrs.map((addr) => node.dial(multiaddr(addr), { signal: controller.signal }))
    );
    return firstDialError(addrs, results);
  } finally {
    clearTimeout(timer);
  }
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
 * Poll until the node advertises a `/p2p-circuit` address, or the deadline passes.
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
