/**
 * Translate `network.relayAddrs` — the operator-facing "use these relay servers"
 * setting — into the listen entry a node needs before it can hold a circuit-relay
 * slot, and validate the operator's entries while doing it.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen addr:
 *
 * | listen entry                        | libp2p behaviour                                                |
 * | ----------------------------------- | --------------------------------------------------------------- |
 * | `<relayAddr>/p2p-circuit`           | CONFIGURED: dial that relay from inside `listen()` and reserve, or throw |
 * | bare `/p2p-circuit`                 | SEARCH: register a pending reservation; open no connection      |
 *
 * Every cadre-built node takes the SEARCH shape, and something explicit drives the
 * reservation afterwards (`relay-reservation.ts`):
 *
 * - The CONTROL node resolves `relayAddrs` here to ONE bare entry (whichever relay
 *   answers first fills it) and `CadreNode.start()` drives the reservation once the
 *   control database is up. That ordering is the point: a configured circuit
 *   listener dials the relay from inside `libp2p.start()`, so the control database
 *   was being built while a sibling relay was already in this node's cohort — and a
 *   sibling that has not yet replicated this node's `CadrePeer` row correctly refuses
 *   its control-DB streams, which killed `start()` outright. See `cadre-node.ts` →
 *   `start()`.
 * - Each STRAND node resolves the same `relayAddrs` to one bare entry PER relay and
 *   runs one reservation supervisor per relay (`strand-network-config.ts`,
 *   `strand-instance-manager.ts`).
 *
 * The CONFIGURED shape is deliberately not producible from a `NetworkConfig` any
 * more: it loses its address and never recovers when the relay restarts, when either
 * side hangs up, and — with no network event at all — on libp2p's own reservation
 * refresh, which removes the reservation before re-creating it while a configured
 * listener republishes only from inside its own `listen()`. A hand-written
 * `<relay>/p2p-circuit` entry in `network.listenAddrs` is rejected on the control
 * node ({@link resolveListenAddrs}) and folded into the supervised relay set on a
 * strand node.
 *
 * `network.relayAddrs` is FAIL-FAST for the operator: a malformed entry throws here at
 * config resolution, and on the control node a first reservation attempt that does not
 * land throws out of `start()` (`RelayReservationFailedError`). Naming a relay that is
 * down still means the control node does not come up; a strand node is fail-SOFT
 * instead (its supervisor keeps trying while the strand serves).
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
 * direct TCP listener with a circuit-only one. Shared with the strand-node
 * derivation (`strand-network-config.ts`), which applies the same rule.
 *
 * NOTE: mirrors `createLibp2pNode`'s own default listen addr in
 * `../optimystic/packages/db-p2p/src/libp2p-node.ts` (`/ip4/0.0.0.0/tcp/<port>`,
 * and `CadreNode` passes `port: 0`) — that file is the source of truth. If it
 * ever changes its default, this constant has to follow.
 */
export const DEFAULT_DIRECT_LISTEN_ADDR = '/ip4/0.0.0.0/tcp/0';

/**
 * libp2p's relay SEARCH listener: registers one pending reservation and dials
 * nothing. The pending reservation is per-LISTENER, not per-relay: the control
 * node binds one entry for its whole relay list (`relay-reservation.ts` fills it
 * with whichever relay answers first), a strand node binds one entry per relay so
 * each relay's supervisor has a slot of its own to fill.
 */
export const RELAY_SEARCH_LISTEN_ADDR = '/p2p-circuit';

/**
 * The circuit-listen multiaddr for each configured relay: `<relayAddr>/p2p-circuit`.
 * An entry that already carries `/p2p-circuit` is passed through unchanged.
 * Throws on an entry that is unparsable or names no relay peerId — this is
 * operator configuration, so a typo must fail loudly at start rather than
 * silently costing the node its reachability.
 *
 * No node LISTENS on these any more (see the module doc); they are the validated
 * form of `relayAddrs`, read by `CadreNode.circuitRelayTargets` for the delegate
 * announce and by `strand-network-config.ts` for the per-relay supervisor list.
 *
 * Deliberately unlike `extractCircuitRelayTargets` (`delegate-admission.ts`), which
 * SKIPS a bad entry: that one reads addresses discovered at runtime from peers, where
 * one bad entry must not be fatal.
 */
export function relayCircuitAddrs(relayAddrs: readonly string[]): string[] {
  return dedupe(relayAddrs.map(circuitListenAddr));
}

/**
 * The listen multiaddrs the CONTROL node binds: configured `listenAddrs` plus ONE
 * bare `/p2p-circuit` search entry when `relayAddrs` names any relay, deduplicated,
 * order-stable (configured entries first). Returns `undefined` when neither field
 * is set, so callers keep omitting `listenAddrs` and inherit db-p2p's default.
 *
 * Every `relayAddrs` entry is validated even though the search entry discards the
 * resolved circuit addrs — an operator typo must fail at config resolution. A
 * hand-written `<relay>/p2p-circuit` entry in `listenAddrs` is rejected outright
 * (see {@link rejectConfiguredCircuitListenAddrs}).
 *
 * Strand nodes derive their own listen set from the same config in
 * `strand-network-config.ts` (`strandNodeAddrs`) — one search entry per relay,
 * fixed direct ports made ephemeral.
 */
export function resolveListenAddrs(network: NetworkConfig | undefined): string[] | undefined {
  const relayEntries = relayCircuitAddrs(network?.relayAddrs ?? []).length > 0
    ? [RELAY_SEARCH_LISTEN_ADDR]
    : [];
  const listenAddrs = network?.listenAddrs;
  rejectConfiguredCircuitListenAddrs(listenAddrs ?? []);
  if (!listenAddrs && relayEntries.length === 0) {
    return undefined;
  }
  // An explicitly empty `listenAddrs` (the React Native "cannot listen" case) stays
  // empty — but a relay named alongside it still gets its listen entry, since
  // acquiring a slot is the whole point of configuring a relay.
  return dedupe([...(listenAddrs ?? [DEFAULT_DIRECT_LISTEN_ADDR]), ...relayEntries]);
}

/**
 * The transport-derived `createLibp2pNode` options a resolved listen set implies —
 * see {@link resolveTransportOptions}.
 */
export interface ListenTransportOptions {
  /**
   * Present when some listen entry names WebSocket. Its VALUE is never bound; it is
   * the switch that makes `@optimystic/db-p2p` add `webSockets()` — see
   * {@link WS_TRANSPORT_SWITCH_PORT}.
   */
  wsPort?: number;
}

/**
 * The `wsPort` value passed purely to turn `@optimystic/db-p2p`'s WebSocket transport
 * ON. It is never bound, so it is deliberately `0` rather than a port scraped from a
 * listen entry.
 *
 * WHY it is a switch and not a port: `createLibp2pNode`
 * (`../optimystic/packages/db-p2p/src/libp2p-node.ts`) feeds `wsPort` into BOTH its
 * default transports and its default listen addrs, and `createLibp2pNodeBase`
 * (`libp2p-node-base.ts:490-491`) falls back to those two defaults INDEPENDENTLY:
 *
 * ```ts
 * const listenAddrs = options.listenAddrs ?? defaults.listenAddrs;
 * const transports  = options.transports  ?? defaults.transports;
 * ```
 *
 * `cadre-core` always supplies explicit `listenAddrs` alongside it, so the synthesized
 * `/ip4/<wsHost>/tcp/<wsPort>/ws` default ADDRESS is discarded while the `webSockets()`
 * transport it added survives. A scraped port would also be a lie whenever a config
 * names several WebSocket addresses on different ports, and the strand path rewrites
 * fixed ports to `0` regardless (`strand-network-config.ts`).
 *
 * NOTE: db-p2p's own doc comment on `wsPort` (`libp2p-node-base.ts:170-172`) says it is
 * "Ignored when `transports`/`listenAddrs` are explicitly provided" — true of the
 * address half, NOT of the transport half, which is the half this depends on. Re-verify
 * empirically rather than trusting that comment: `test/listen-transport-options.spec.ts`
 * boots a real node and asserts a `/ws` multiaddr appears. If db-p2p ever makes the
 * comment true of both halves, it needs an explicit `enableWebSockets` switch and this
 * constant becomes unusable.
 */
const WS_TRANSPORT_SWITCH_PORT = 0;

/**
 * The transport-derived libp2p options `listenAddrs` implies, and the gate that stops a
 * listen address the node has no transport for from being SILENTLY dropped.
 *
 * libp2p's transport manager sorts configured listen addresses by which transport claims
 * them, discards the unclaimed ones, and raises `UnsupportedListenAddressesError` only
 * when EVERY address was discarded. Pair a TCP address with a WebSocket one — which is
 * exactly what the shipped configs do — and the TCP address carries the start while the
 * missing WebSocket listener is never reported. Two halves of `NetworkConfig` that have
 * to agree (`listenAddrs`, and the transports the node will actually have) were never
 * checked against each other; this is that check, and it covers both node kinds because
 * both derive their listen set from the same config here ({@link resolveListenAddrs}) or
 * in `strand-network-config.ts`, and both call this on the result.
 *
 * The two transport classes are handled differently, on purpose:
 *
 * - **WebSocket is DERIVED.** It is the one non-TCP transport the shipped configs need
 *   (the React Native reference app's companion drone; `cadre start --ws-port`), and
 *   `@optimystic/db-p2p` already knows how to add it. `cadre-core` grows no dependency
 *   and decides no transport policy — it flips db-p2p's own switch
 *   ({@link WS_TRANSPORT_SWITCH_PORT}).
 * - **Everything else is REFUSED.** Deriving `/quic-v1`, `/webrtc` or `/webtransport`
 *   would mean importing transport packages into every `cadre-core` consumer including
 *   the React Native and browser bundles (against the cross-platform rule in
 *   `AGENTS.md`) and duplicating policy `libp2p-node.ts` owns. So name the address, name
 *   the transport it needs, and refuse to start — matching how `network.relayAddrs` and
 *   `network.announceAddrs` already treat an operator typo.
 *
 * Returns `{}` unconditionally when `network.transports` is set: a programmatic embedder
 * supplying transport factories owns the policy, and the factories are opaque — nothing
 * can be inferred from them. That is what keeps the RN phone, the web app, and the
 * integration-test harness unaffected.
 *
 * NOTE: pairing this with {@link resolveListenAddrs} is a CONVENTION, not a structure —
 * a third libp2p-node build site could resolve listen addrs and forget to call this,
 * putting the original bug back on that path. Both existing sites are covered
 * (`cadre-node.ts` → `buildControlNodeOptions`, `strand-network-config.ts` →
 * `strandNodeAddrs`), and they are the only two `createLibp2pNode` callers in this repo
 * that derive their listen set from a `NetworkConfig` — the other callers
 * (`integration-tests/src/harness/test-party.ts`, `quereus-plugin-sereus`'s `connect.ts`
 * and `connect-browser.ts`) pass no `listenAddrs` at all, or pass their own transports
 * with it. If a third CONFIG-derived site appears, fold the two functions into one that
 * returns listen addrs and transport options together, so forgetting becomes impossible
 * rather than merely unlikely.
 *
 * @param listenAddrs the ALREADY-resolved listen set — the output of
 *   {@link resolveListenAddrs}, or the strand derivation, after any per-node rewriting —
 *   so the check reads what this node will actually bind.
 * @throws {UnbindableListenAddressError} when a listen entry names a transport outside
 *   {tcp, ws/wss, p2p-circuit}.
 */
export function resolveTransportOptions(
  network: NetworkConfig | undefined,
  listenAddrs: readonly string[] | undefined
): ListenTransportOptions {
  if (network?.transports) {
    return {};
  }
  const kinds = (listenAddrs ?? []).map((addr) => [addr, listenTransportKind(addr)] as const);
  const unsupported = kinds.filter(([, kind]) => kind === 'unsupported').map(([addr]) => addr);
  if (unsupported.length > 0) {
    throw new UnbindableListenAddressError(unsupported);
  }
  return kinds.some(([, kind]) => kind === 'websockets') ? { wsPort: WS_TRANSPORT_SWITCH_PORT } : {};
}

/**
 * Thrown at config resolution when `network.listenAddrs` names an address none of the
 * default transports can bind. Names each offending address alongside the libp2p
 * transport package it would need — what the operator has without this is a node that
 * starts and silently never listens there.
 */
export class UnbindableListenAddressError extends Error {
  constructor(readonly listenAddrs: readonly string[]) {
    super(
      'network.listenAddrs names an address this node has no transport for: ' +
      `${listenAddrs.map((a) => `${a} — ${unbindableReason(a)}`).join('; ')}. ` +
      'Default transports bind TCP (including /unix/<path>), WebSocket (/ws, /wss) and circuit-relay addresses only. ' +
      'Either drop the address, or supply the transport programmatically via network.transports.'
    );
    this.name = 'UnbindableListenAddressError';
  }
}

/**
 * Which default transport claims `listenAddr`, or `'unsupported'` when none does.
 *
 * Classification is a multiaddr COMPONENT question, not a string question, so this
 * parses and reads the transport stack — the component names left once the addressing
 * and security layers are dropped. That stack is outermost-LAST
 * (`/ip4/…/tcp/443/tls/ws` → `['tcp', 'ws']`), which is why its terminal entry decides.
 *
 * An unparsable entry is `'ignored'` and passes through untouched, following
 * `isConfiguredCircuitListenAddr` below and `ephemeralPortListenAddr`
 * (`strand-network-config.ts`): libp2p reports a bad listen addr itself, and this check
 * must only ever ADD a denial.
 */
function listenTransportKind(listenAddr: string): 'tcp' | 'websockets' | 'circuit' | 'ignored' | 'unsupported' {
  let stack: readonly string[];
  try {
    stack = transportStack(listenAddr);
  } catch {
    return 'ignored';
  }
  const outermost = stack.at(-1);
  if (outermost === undefined) {
    // Nothing but addressing components — a bare `/ip4/1.2.3.4`. No transport claims
    // it, so it is dropped by exactly the same silent path this check exists to close.
    return 'unsupported';
  }
  if (outermost === 'p2p-circuit') {
    return 'circuit';
  }
  if (outermost === 'ws' || outermost === 'wss') {
    return 'websockets';
  }
  // Only a BARE tcp or unix stack is TCP. `@libp2p/tcp` binds both — its `listenFilter`
  // accepts an exact TCP match OR a `/unix/<path>` address (a named pipe on Windows) —
  // and nothing layered on top of either, which is why `/tcp/<port>/<anything else>` is
  // NOT waved through merely because a `tcp` component happens to appear.
  return stack.length === 1 && (outermost === 'tcp' || outermost === 'unix') ? 'tcp' : 'unsupported';
}

/**
 * Component names of `listenAddr` with the addressing and security layers removed, so
 * what remains names transports. Host components (`ip4`, `dns4`, …) and the layers that
 * ride inside a transport without being one (`tls`, `sni`, `certhash`, `p2p`) say
 * nothing about which transport has to be configured.
 */
function transportStack(listenAddr: string): string[] {
  return multiaddr(listenAddr).getComponents()
    .map((component) => component.name)
    .filter((name) => !NON_TRANSPORT_COMPONENTS.has(name));
}

/** Components that address or secure a connection rather than name its transport. */
const NON_TRANSPORT_COMPONENTS = new Set([
  'ip4', 'ip6', 'ip6zone', 'dns', 'dns4', 'dns6', 'dnsaddr',
  'tls', 'sni', 'certhash', 'p2p', 'noise'
]);

/**
 * Why `listenAddr` cannot be bound, phrased for the operator: the libp2p package that
 * would make it bindable where one is known, and otherwise what is wrong with it.
 *
 * Read OUTERMOST-first (`/udp/…/quic-v1/webtransport` needs `@libp2p/webtransport`,
 * not the `@libp2p/quic` it rides on), matching how `listenTransportKind` decides.
 */
function unbindableReason(listenAddr: string): string {
  let stack: readonly string[];
  try {
    stack = transportStack(listenAddr);
  } catch {
    return 'not a parsable multiaddr';
  }
  if (stack.length === 0) {
    return 'it names no transport component';
  }
  const pkg = [...stack].reverse().map((name) => TRANSPORT_PACKAGES[name]).find((p) => p !== undefined);
  return pkg === undefined ? 'needs an unrecognized transport' : `needs ${pkg}`;
}

/**
 * The libp2p package each unbindable transport component comes from. Naming the package
 * is the actionable half of the refusal — the operator either drops the address or wires
 * that package in through `network.transports`.
 */
const TRANSPORT_PACKAGES: Record<string, string> = {
  'quic': '@libp2p/quic',
  'quic-v1': '@libp2p/quic',
  'webtransport': '@libp2p/webtransport',
  'webrtc': '@libp2p/webrtc',
  'webrtc-direct': '@libp2p/webrtc'
};

/**
 * Thrown out of `CadreNode.start()` when the boot-path reservation drive for
 * `network.relayAddrs` produces no `/p2p-circuit` address on its FIRST attempt.
 *
 * This is what keeps `network.relayAddrs` fail-fast now that the control node
 * listens on the bare search entry: libp2p's own `UnsupportedListenAddressesError` used
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
 * A hand-written `<relay>/p2p-circuit` entry in `network.listenAddrs` is the
 * CONFIGURED listener shape, and it is unusable on the control node: libp2p
 * dials that relay from inside `listen()`, the bring-up quiet period
 * (`membership-connection-gater.ts`) denies exactly that dial, `listen()` fails, and
 * the transport manager's default `FATAL_ALL` aborts `libp2p.start()`. The operator
 * would see `UnsupportedListenAddressesError` from deep inside bring-up with nothing
 * naming the cause, so name it here instead.
 *
 * `network.relayAddrs` is the exact replacement — same relay, and the reservation is
 * driven after bring-up, which is the whole point of the search shape. (A strand node
 * built directly from such a config folds the entry into its supervised relay set
 * instead — `strand-network-config.ts` — but the control node's resolution runs first
 * on every machine, so in production the entry never reaches a strand node.)
 */
function rejectConfiguredCircuitListenAddrs(listenAddrs: readonly string[]): void {
  const configured = listenAddrs.filter(isConfiguredCircuitListenAddr);
  if (configured.length > 0) {
    throw new Error(
      'network.listenAddrs names a relay directly ' +
      `(${configured.join(', ')}), which a control node cannot listen on: libp2p would ` +
      'dial that relay during control-database bring-up, when the node accepts no ' +
      'connections. Move the relay to network.relayAddrs, which reserves after bring-up.'
    );
  }
}

/**
 * `<something>/p2p-circuit` — the configured shape, as opposed to the bare search
 * addr. An unparsable entry is `false`: libp2p reports a bad listen addr itself,
 * and this helper only ever ADDS a denial (or, on the strand path, a supervisor).
 */
export function isConfiguredCircuitListenAddr(listenAddr: string): boolean {
  if (listenAddr === RELAY_SEARCH_LISTEN_ADDR) {
    return false;
  }
  try {
    return multiaddr(listenAddr).getComponents().some((c) => c.name === 'p2p-circuit');
  } catch {
    // Not our error to raise: libp2p reports an unparsable listen addr itself, and
    // this helper only ever ADDS a denial.
    return false;
  }
}

/**
 * One entry of {@link relayCircuitAddrs}: this relay's addr in the configured shape.
 *
 * NOTE: an entry carrying components AFTER `/p2p-circuit` — a full relayed DIAL addr,
 * `…/p2p/<relay>/p2p-circuit/p2p/<someone else>` — is passed through as written. It
 * validates (the relay it names is real), and every consumer reads only the relay
 * peer id and the dial prefix before `/p2p-circuit`, so the tail is ignored rather
 * than harmful; if that paste turns out to be common, truncate at the `/p2p-circuit`
 * component here so the resolved list is canonical.
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
