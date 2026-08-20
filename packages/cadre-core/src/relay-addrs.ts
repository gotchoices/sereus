/**
 * Translate `network.relayAddrs` — the operator-facing "use these relay servers"
 * setting — into the listen entry a node needs before it can hold a circuit-relay
 * slot, and validate the operator's entries while doing it.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen addr,
 * and the same `relayAddrs` list resolves to either shape depending on WHO is
 * listening ({@link RelayListenRoute}):
 *
 * | route          | listen entry                                | libp2p behaviour                                          |
 * | -------------- | ------------------------------------------- | --------------------------------------------------------- |
 * | `'configured'` | `<relayAddr>/p2p-circuit`, one per relay      | dial that relay from inside `listen()` and reserve, or throw |
 * | `'search'`     | a single bare `/p2p-circuit`                  | register a pending reservation; open no connection          |
 *
 * The CONTROL node takes the `'search'` route, and `CadreNode.start()` drives the
 * reservation explicitly (`relay-reservation.ts`) once the control database is up.
 * That ordering is the point: a configured circuit listener dials the relay from
 * inside `libp2p.start()`, so the control database was being built while a sibling
 * relay was already in this node's cohort — and a sibling that has not yet
 * replicated this node's `CadrePeer` row correctly refuses its control-DB streams,
 * which killed `start()` outright. See `cadre-node.ts` → `start()`.
 *
 * STRAND nodes keep the `'configured'` route (`strand-instance-manager.ts`): they
 * inherit the control node's `NetworkConfig`, nothing drives an explicit
 * reservation for them, and their relay connection cannot disturb a control-DB
 * bring-up (a strand node's protocol ids are namespaced `/optimystic/strand-<id>/…`,
 * so the relay is never in its cohort).
 *
 * `network.relayAddrs` is FAIL-FAST for the operator on both routes, just from
 * different places: a malformed entry throws here at config resolution, and on the
 * control node a first reservation attempt that does not land throws out of
 * `start()` (`RelayReservationFailedError`). Naming a relay that is down still
 * means the node does not come up.
 *
 * The bare `/p2p-circuit` search listener cannot open a connection on its own:
 * libp2p fills a pending reservation from `RelayDiscovery`, which nominates a peer
 * only once the relay-hop protocol id is in that peer's peer-store protocol list,
 * and that list is written exclusively by IDENTIFY — which `@optimystic/db-p2p`
 * namespaces per network, so a cadre node and a stock relay never identify each
 * other. See `relay-reservation.ts`'s module doc and `docs/architecture.md`.
 */

import { multiaddr, type Component } from '@multiformats/multiaddr';
import { circuitRelayTargetOrThrow } from './delegate-admission.js';
import type { NetworkConfig } from './types.js';
import type { RelayReservationState } from './relay-reservation.js';

/**
 * The direct listener a node keeps when it configures `relayAddrs` but no
 * `listenAddrs`. Without this, naming a relay would silently REPLACE the node's
 * direct TCP listener with a circuit-only one.
 *
 * NOTE: mirrors `createLibp2pNode`'s own default listen addr in
 * `../optimystic/packages/db-p2p/src/libp2p-node.ts` (`/ip4/0.0.0.0/tcp/<port>`,
 * and `CadreNode` passes `port: 0`) — that file is the source of truth. If it
 * ever changes its default, this constant has to follow.
 */
const DEFAULT_DIRECT_LISTEN_ADDR = '/ip4/0.0.0.0/tcp/0';

/**
 * libp2p's relay SEARCH listener: registers one pending reservation and dials
 * nothing. One entry covers every configured relay — the pending reservation is
 * per-listener, not per-relay, and `relay-reservation.ts` fills it with whichever
 * relay answers first.
 */
export const RELAY_SEARCH_LISTEN_ADDR = '/p2p-circuit';

/**
 * Which listener shape `network.relayAddrs` resolves to for this caller — see the
 * table in the module doc. Defaults to `'configured'` everywhere except the
 * control node's own libp2p options.
 */
export type RelayListenRoute = 'configured' | 'search';

/**
 * The circuit-listen multiaddr for each configured relay: `<relayAddr>/p2p-circuit`.
 * An entry that already carries `/p2p-circuit` is passed through unchanged.
 * Throws on an entry that is unparsable or names no relay peerId — this is
 * operator configuration, so a typo must fail loudly at start rather than
 * silently costing the node its reachability.
 *
 * Deliberately unlike `extractCircuitRelayTargets` (`delegate-admission.ts`), which
 * SKIPS a bad entry: that one reads addresses discovered at runtime from peers, where
 * one bad entry must not be fatal.
 */
export function relayCircuitAddrs(relayAddrs: readonly string[]): string[] {
  return dedupe(relayAddrs.map(circuitListenAddr));
}

/**
 * The listen multiaddrs a node actually binds: configured `listenAddrs` plus the
 * relay listen entry `route` calls for, deduplicated, order-stable (configured
 * entries first). Returns `undefined` when neither field is set, so callers keep
 * omitting `listenAddrs` and inherit db-p2p's default.
 *
 * Every `relayAddrs` entry is validated on BOTH routes — the `'search'` route
 * discards the resolved circuit addrs, but an operator typo must fail at config
 * resolution either way.
 */
export function resolveListenAddrs(
  network: NetworkConfig | undefined,
  route: RelayListenRoute = 'configured'
): string[] | undefined {
  const configured = relayCircuitAddrs(network?.relayAddrs ?? []);
  const relayEntries = route === 'search'
    ? (configured.length > 0 ? [RELAY_SEARCH_LISTEN_ADDR] : [])
    : configured;
  const listenAddrs = network?.listenAddrs;
  if (!listenAddrs && relayEntries.length === 0) {
    return undefined;
  }
  // An explicitly empty `listenAddrs` (the React Native "cannot listen" case) stays
  // empty — but a relay named alongside it still gets its listen entry, since
  // acquiring a slot is the whole point of configuring a relay.
  return dedupe([...(listenAddrs ?? [DEFAULT_DIRECT_LISTEN_ADDR]), ...relayEntries]);
}

/**
 * Thrown out of `CadreNode.start()` when the boot-path reservation drive for
 * `network.relayAddrs` produces no `/p2p-circuit` address on its FIRST attempt.
 *
 * This is what keeps `network.relayAddrs` fail-fast now that the control node
 * takes the `'search'` route: libp2p's own `UnsupportedListenAddressesError` used
 * to abort start from inside `listen()`, and an operator who names a relay is
 * telling the node it has no other reachability — coming up undialable is worse
 * than not coming up. Names the relays and the reservation's own reason, both of
 * which the libp2p error omitted.
 */
export class RelayReservationFailedError extends Error {
  constructor(
    readonly relayAddrs: readonly string[],
    readonly state: RelayReservationState
  ) {
    super(
      `network.relayAddrs reservation failed (status: ${state.status}): ` +
      `${state.error ?? 'no /p2p-circuit address appeared'} — relays: ${relayAddrs.join(', ')}`
    );
    this.name = 'RelayReservationFailedError';
  }
}

/**
 * One entry of {@link relayCircuitAddrs}: the addr the node listens on for this relay.
 *
 * NOTE: an entry carrying components AFTER `/p2p-circuit` — a full relayed DIAL addr,
 * `…/p2p/<relay>/p2p-circuit/p2p/<someone else>` — is passed through as written and
 * would be listened on verbatim. It validates (the relay it names is real), so only an
 * operator who pastes a peer's relayed address into `relayAddrs` hits it; if that turns
 * out to be a common paste, truncate at the `/p2p-circuit` component here.
 */
function circuitListenAddr(relayAddr: string): string {
  const alreadyCircuit = parseComponents(relayAddr).some((c) => c.name === 'p2p-circuit');
  const listenAddr = alreadyCircuit ? relayAddr : `${relayAddr}/p2p-circuit`;
  try {
    circuitRelayTargetOrThrow(listenAddr); // validates the relay peerId
  } catch (err) {
    throw new Error(
      `network.relayAddrs entry names no relay peerId (expected <dial addr>/p2p/<relayPeerId>): ${relayAddr}`,
      { cause: err }
    );
  }
  return listenAddr;
}

/** Multiaddr components of `relayAddr`, with the config field named on a parse failure. */
function parseComponents(relayAddr: string): Component[] {
  try {
    return multiaddr(relayAddr).getComponents();
  } catch (err) {
    throw new Error(`network.relayAddrs entry is not a valid multiaddr: ${relayAddr}`, { cause: err });
  }
}

/** Exact-string dedupe, first occurrence wins, so the list is stable across restarts. */
function dedupe(addrs: readonly string[]): string[] {
  return [...new Set(addrs)];
}
