/**
 * Translate `network.relayAddrs` — the operator-facing "use these relay servers"
 * setting — into the mechanism this repo already has for reserving a circuit-relay
 * slot: a `…/p2p/<relayPeerId>/p2p-circuit` entry in the node's listen addrs.
 *
 * `@libp2p/circuit-relay-v2`'s transport is always present on the Node path
 * (`../optimystic/packages/db-p2p/src/libp2p-node.ts` pushes `circuitRelayTransport()`
 * unconditionally), and listening on a relay's circuit addr is what makes libp2p dial
 * that relay and hold a reservation. Everything downstream of the listen list —
 * the reservation itself, `CadreNode.circuitRelayTargets()` picking delegate-announce
 * targets, strand nodes inheriting the listen addrs, the `/p2p-circuit`-first address
 * publishing in `registerSelf` — then works unchanged.
 *
 * So `relayAddrs` is a second, friendlier door onto an existing mechanism:
 *
 *   effective listen addrs = listenAddrs ++ relayAddrs.map(a => a + '/p2p-circuit')
 */

import { multiaddr, type Component } from '@multiformats/multiaddr';
import { circuitRelayTargetOrThrow } from './delegate-admission.js';
import type { NetworkConfig } from './types.js';

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
 * circuit-listen addr of every configured relay, deduplicated, order-stable
 * (configured entries first). Returns `undefined` when neither field is set, so
 * callers keep omitting `listenAddrs` and inherit db-p2p's default.
 */
export function resolveListenAddrs(network: NetworkConfig | undefined): string[] | undefined {
  const circuits = relayCircuitAddrs(network?.relayAddrs ?? []);
  const listenAddrs = network?.listenAddrs;
  if (!listenAddrs && circuits.length === 0) {
    return undefined;
  }
  // An explicitly empty `listenAddrs` (the React Native "cannot listen" case) stays
  // empty — but a relay named alongside it still gets its circuit listener, since
  // acquiring one is the whole point of configuring a relay.
  return dedupe([...(listenAddrs ?? [DEFAULT_DIRECT_LISTEN_ADDR]), ...circuits]);
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
