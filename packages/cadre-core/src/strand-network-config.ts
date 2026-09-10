/**
 * Derive the per-STRAND-node view of the machine's one `NetworkConfig`.
 *
 * A cadre machine runs one **control** libp2p node plus one more libp2p node per
 * strand, and every one of them is built from the SAME operator-written
 * `NetworkConfig` block. Two of its fields describe a single endpoint on the host
 * and therefore cannot be inherited literally by a second node on that host:
 *
 * - **`listenAddrs` with a fixed port.** `cadre-cli`'s example config ships
 *   `/ip4/0.0.0.0/tcp/4001`. The control node binds it first; every strand node
 *   then tries to bind the same port and fails with `EADDRINUSE`, so a machine
 *   configured with a fixed port could not start any strand at all.
 * - **`announceAddrs` / `appendAnnounceAddrs`.** Any concrete announce entry names
 *   a port, and that port is the CONTROL node's. A strand node advertising it
 *   sends peers to the control node — and `announceAddrs` REPLACES the advertised
 *   set (see `announce-addrs.ts`), so that wrong address would be the ONLY thing
 *   the strand node publishes.
 *
 * The reachability model this rests on: **a strand node is not separately dialable
 * at a published fixed address.** It is reached through (a) its ephemeral direct
 * listener plus the addresses peers observe for it, and (b) circuit relay —
 * `network.relayAddrs` resolves to per-relay `<relay>/p2p-circuit` listen entries
 * that strand nodes DO inherit correctly, because the port inside such an entry is
 * the relay's, not a local bind (`relay-addrs.ts`).
 *
 * Everything else in `NetworkConfig` — `relayAddrs`, `transports`,
 * `connectionGater`, `enableRelay` — is inherited unchanged by the caller; this
 * module only owns the two host-endpoint fields above.
 */

import { multiaddr, type Component } from '@multiformats/multiaddr';
import { resolveListenAddrs } from './relay-addrs.js';
import type { NetworkConfig } from './types.js';

/**
 * The address-shaped `createLibp2pNode` options a strand node gets, ready to spread
 * into the rest of its options.
 *
 * There is deliberately no announce field here: a strand node announces NOTHING the
 * operator configured, only what libp2p derives for it (its own listeners, observed
 * addresses, and any `/p2p-circuit` address a relay reservation earns).
 *
 * NOTE: accepted tradeoff — a hosted deployment that wants a strand node reachable
 * at its own published public port has no way to say so; the announce config is
 * dropped for strand nodes wholesale rather than per-strand. Nothing needs that
 * today, and the alternative is a per-strand network-config surface. Revisit if a
 * hosted or reverse-proxy deployment ever needs direct-dialable strand nodes.
 */
export interface StrandNodeAddrs {
  /**
   * Listen entries for this strand node, or `undefined` when the operator
   * configured neither `listenAddrs` nor `relayAddrs` — in which case the caller
   * omits the option and inherits `@optimystic/db-p2p`'s own default.
   */
  listenAddrs?: string[];
}

/**
 * The strand-node view of `network`: the control node's resolved listen entries with
 * every fixed direct port rewritten to an ephemeral one, and no announce fields.
 *
 * Validation is unchanged and still fail-fast — `resolveListenAddrs` throws here on a
 * malformed `relayAddrs` entry exactly as it does for the control node. Announce
 * entries are validated on the CONTROL node's own build (`cadre-node.ts`), which runs
 * first, so a typo there still refuses node start even though strand nodes ignore the
 * field.
 */
export function strandNodeAddrs(network: NetworkConfig | undefined): StrandNodeAddrs {
  const listenAddrs = resolveListenAddrs(network);
  if (!listenAddrs) {
    return {};
  }
  // An explicitly empty `listenAddrs` (the React Native "cannot listen" case) stays
  // empty — rewriting must never resurrect a direct listener that was opted out of.
  return { listenAddrs: dedupe(listenAddrs.map(ephemeralPortListenAddr)) };
}

/**
 * One listen entry with its fixed direct port rewritten to `0`, so the OS assigns a
 * free one per node. Interface and transport choices are preserved — `/ws`, a
 * specific-interface bind, a `/udp/…/quic-v1` stack — since only the port is
 * contended.
 *
 * Passed through UNCHANGED when there is nothing to rewrite, so the operator's exact
 * string survives rather than being round-tripped through the multiaddr normalizer:
 *
 * - a circuit entry (`…/p2p-circuit`), whose embedded port belongs to the RELAY and
 *   is not a local bind at all;
 * - a port that is already `0`, or an entry that names no port;
 * - an unparsable entry — libp2p reports a bad listen addr itself, and this helper
 *   only ever narrows a port.
 */
function ephemeralPortListenAddr(listenAddr: string): string {
  let components: Component[];
  try {
    components = multiaddr(listenAddr).getComponents();
  } catch {
    return listenAddr;
  }
  if (components.some((c) => c.name === 'p2p-circuit')) {
    return listenAddr;
  }
  if (!components.some(isFixedPort)) {
    return listenAddr;
  }
  return multiaddr(components.map(withEphemeralPort)).toString();
}

/** A `tcp`/`udp` component naming a port the OS did not choose. */
function isFixedPort(component: Component): boolean {
  return (component.name === 'tcp' || component.name === 'udp')
    && component.value !== undefined
    && component.value !== '0';
}

/**
 * `component` with its port zeroed, or unchanged when it is not a fixed port.
 *
 * Rebuilt field-by-field rather than spread: a parsed component may carry a `bytes`
 * cache, and `componentsToBytes` PREFERS that cache over `value` — a spread would
 * re-encode the old port.
 */
function withEphemeralPort(component: Component): Component {
  return isFixedPort(component)
    ? { code: component.code, name: component.name, value: '0' }
    : component;
}

/**
 * Exact-string dedupe, first occurrence wins — matching `relay-addrs.ts`. Entries
 * that differed only by port collapse into one after the rewrite, and libp2p would
 * otherwise try to bind the same ephemeral-port entry twice.
 */
function dedupe(addrs: readonly string[]): string[] {
  return [...new Set(addrs)];
}
