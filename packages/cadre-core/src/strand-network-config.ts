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
 * `network.relayAddrs` resolves to ONE bare `/p2p-circuit` SEARCH listen entry PER
 * relay, and the strand runtime (`strand-instance-manager.ts`) runs one
 * reservation supervisor per relay over the dial addrs this module returns beside
 * them ({@link StrandNodeAddrs.relayAddrs}). The same route the control node takes,
 * for the same reason the configured `<relay>/p2p-circuit` shape was retired
 * everywhere (`relay-addrs.ts`): a configured listener loses its address on a relay
 * restart, on either side hanging up, and on libp2p's own reservation refresh, and
 * recovers from none of them. One search entry per relay rather than one for all,
 * because a search listener registers exactly ONE pending reservation and libp2p
 * fills a pending reservation with exactly one relay — so N relays need N listeners,
 * each with a supervisor that owns it.
 *
 * A hand-written `<relay>/p2p-circuit` entry in `listenAddrs` counts as a relay
 * (its dial prefix is supervised like a `relayAddrs` entry) — the control node
 * rejects that entry outright, so in production it never reaches here, but a
 * strand built straight from such a config must not get an unsupervised configured
 * listener either. A hand-written BARE `/p2p-circuit` (the browser shape,
 * `reference-app-web`) passes through unchanged when no relay is named, and is
 * absorbed by the per-relay entries when one is.
 *
 * Everything else in `NetworkConfig` — `transports`, `noiseCrypto`, `connectionMonitor`,
 * `cohortQueryTimeoutMs`, `connectionGater`, `enableRelay` — is inherited by the caller; this
 * module only owns the two host-endpoint fields above and the relay listen shape. One caveat on
 * `connectionGater`: an OPEN strand's node gets it unchanged, while a CLOSED strand's
 * node composes revoked-peer denial onto it in `strand-instance-manager.ts` (every
 * supplied hook still honored — see `strand-revocation-enforcer.ts`).
 *
 * It does carry one non-address option out with them: the WebSocket transport switch
 * a `/ws` listen entry implies (`relay-addrs.ts` → `resolveTransportOptions`). That is
 * DERIVED from the listen entries rather than inherited, so it has to be computed
 * wherever they are, and a strand node whose listen entries reached libp2p without it
 * would bind no WebSocket listener and report nothing.
 */

import { multiaddr, type Component } from '@multiformats/multiaddr';
import {
  DEFAULT_DIRECT_LISTEN_ADDR,
  RELAY_SEARCH_LISTEN_ADDR,
  isConfiguredCircuitListenAddr,
  relayCircuitAddrs,
  resolveTransportOptions
} from './relay-addrs.js';
import { extractCircuitRelayTargets } from './delegate-admission.js';
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
   * omits the option and inherits `@optimystic/db-p2p`'s own default. Carries one
   * bare `/p2p-circuit` entry per entry of {@link relayAddrs}, deliberately NOT
   * deduplicated: each one is its own listener with its own pending reservation.
   */
  listenAddrs?: string[];
  /**
   * The WebSocket transport switch those listen entries imply, present only when one
   * of them names WebSocket (`relay-addrs.ts` → `resolveTransportOptions`). Not an
   * address — it is deliberately `0` and nothing binds it — but it lives here because
   * it is derived from, and must travel with, the listen entries above. Without it a
   * `/ws` strand listen entry binds nothing and libp2p reports nothing.
   */
  wsPort?: number;
  /**
   * The relays this strand node reserves through, as DIRECT dial addrs
   * (`<host>/p2p/<relayPeerId>`, no `/p2p-circuit`), one per relay, in config order,
   * deduplicated by relay peer id — the union of `network.relayAddrs` and any
   * hand-written `<relay>/p2p-circuit` entry in `network.listenAddrs`. Present only
   * when at least one relay is named.
   *
   * NOT a `createLibp2pNode` option: the caller (`strand-instance-manager.ts`)
   * destructures it off before spreading the rest, and starts one
   * `superviseRelayReservation` per entry over the node it built.
   */
  relayAddrs?: string[];
}

/**
 * The strand-node view of `network`: the operator's direct listen entries with every
 * fixed port rewritten to an ephemeral one, one bare `/p2p-circuit` search entry per
 * relay, the relay dial addrs those entries are supervised against, and no announce
 * fields.
 *
 * Validation is fail-fast exactly as it is for the control node — `relayCircuitAddrs`
 * throws here on a malformed `relayAddrs` entry.
 *
 * NOTE: announce entries are no longer validated on this path at all; the CONTROL
 * node's own build (`cadre-node.ts`) is the only thing that parses them, and it runs
 * before any strand starts, so a typo still refuses node start today. That is an
 * ORDERING guarantee, not a structural one. Revisit if a strand node is ever built
 * before the control node's libp2p options are resolved — a malformed announce entry
 * would then go unreported until the control node's own build.
 */
export function strandNodeAddrs(network: NetworkConfig | undefined): StrandNodeAddrs {
  const relayAddrs = strandRelayAddrs(network);
  const configured = network?.listenAddrs;
  if (!configured && relayAddrs.length === 0) {
    return {};
  }
  // An explicitly empty `listenAddrs` (the React Native "cannot listen" case) stays
  // empty — rewriting must never resurrect a direct listener that was opted out of.
  // Naming a relay with no `listenAddrs` keeps the direct listener the control node
  // keeps in that case (`relay-addrs.ts`), so a relay ADDS reachability rather than
  // replacing it.
  const direct = configured ?? [DEFAULT_DIRECT_LISTEN_ADDR];
  // Every circuit entry — the configured shape (now a relay in `relayAddrs`) and a
  // hand-written bare search entry alike — is replaced by the per-relay search entries
  // once a relay is named; with none, the operator's entries pass through as written.
  const kept = relayAddrs.length > 0 ? direct.filter((addr) => !isCircuitListenAddr(addr)) : direct;
  // The search entries are appended AFTER the dedupe on purpose: they are identical
  // strings, and each one must survive as its own listener (see the module doc).
  //
  // NOTE: every bare entry also makes libp2p start its own relay discovery whenever
  // that listener's slot is empty (launch, and every loss). Measured on a node with
  // no peer router: one peer-store scan plus a random walk that fails at once
  // (`NoPeerRoutersError`) per loss event — no dial churn. If strand nodes ever get
  // a peer router (a DHT), that walk turns into real dials on every relay loss;
  // cap or disable `circuitRelayTransport`'s discovery then.
  const listenAddrs = [
    ...dedupe(kept.map(ephemeralPortListenAddr)),
    ...relayAddrs.map(() => RELAY_SEARCH_LISTEN_ADDR)
  ];
  // Classified AFTER the ephemeral rewrite, so the check reads what this strand node
  // will actually bind. Zeroing a port cannot change an entry's transport — only the
  // `tcp`/`udp` component's value moves — so `/ip4/0.0.0.0/tcp/4002/ws` still resolves
  // to WebSocket as `/ip4/0.0.0.0/tcp/0/ws`; a bare `/p2p-circuit` is `'circuit'`.
  return {
    listenAddrs,
    ...resolveTransportOptions(network, listenAddrs),
    ...(relayAddrs.length > 0 && { relayAddrs })
  };
}

/**
 * The relays a strand node built from `network` reserves through, as direct dial
 * addrs: every `relayAddrs` entry (validated — a malformed one throws, naming the
 * field) plus the relay named by any hand-written `<relay>/p2p-circuit` listen entry,
 * deduplicated by relay PEER ID with the first spelling winning — two spellings of one
 * relay would otherwise get two supervisors fighting over one reservation slot.
 */
function strandRelayAddrs(network: NetworkConfig | undefined): string[] {
  const configured = relayCircuitAddrs(network?.relayAddrs ?? []);
  const handWritten = (network?.listenAddrs ?? []).filter(isConfiguredCircuitListenAddr);
  return extractCircuitRelayTargets([...configured, ...handWritten]).map((relay) => relay.relayAddr);
}

/** Any `/p2p-circuit` listen entry — bare or configured; an unparsable entry is not one. */
function isCircuitListenAddr(listenAddr: string): boolean {
  return listenAddr === RELAY_SEARCH_LISTEN_ADDR || isConfiguredCircuitListenAddr(listenAddr);
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
 *
 * NOTE: an operator who writes two fixed ports on the same interface and transport
 * (`/ip4/0.0.0.0/tcp/4001` and `…/tcp/4002`) gets ONE strand listener, not two, since
 * the two entries are identical once zeroed. Intended — the ports were the only thing
 * distinguishing them and neither survives. Revisit if a deployment ever needs a
 * strand node to hold a fixed count of direct listeners.
 */
function dedupe(addrs: readonly string[]): string[] {
  return [...new Set(addrs)];
}
