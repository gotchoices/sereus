import type { ConnectionGater, Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
import type { IRawStorage, Libp2pConnectionMonitorInit, Libp2pTransports, NoiseCryptoInterface } from '@optimystic/db-p2p';
import type { IPeerNetwork, IRepo } from '@optimystic/db-core';
import type { PeerJoinBackfillConfig } from './peer-join-backfill.js';
import type { StrandRevocationEnforcementConfig } from './strand-revocation-enforcer.js';
import type { StrandMembershipReconciliationConfig } from './strand-membership-reconciler.js';
import type { StrandFirstSyncConfig } from './strand-first-sync-gate.js';
import type { StrandDatabase } from './strand-database.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import type { KeyStore, KeyId } from './key-store.js';
import type { TrustedOwnerStore, TrustSource } from './trusted-owner-store.js';
import type { BootstrapPeerStore } from './bootstrap-peer-store.js';
import type { EnrolledMachineStore } from './enrolled-machine-store.js';
import type { PushNotifier } from './push-notifier.js';
import type { RevocableTable } from './control-authorization.js';
import type { ControlRetryAbandonment } from './control-retry.js';

/**
 * Extended Libp2p node with the coordinatedRepo attached by db-p2p's
 * createLibp2pNode after node creation (not surfaced on the base Libp2p type).
 */
export interface Libp2pNodeWithRepo extends Libp2p {
  coordinatedRepo: IRepo;
  /**
   * The node's key-addressed peer network, attached by db-p2p's factory alongside
   * `coordinatedRepo` (`libp2p-node-base.ts`). Optional deliberately: the base
   * factory always assigns it, but it is not part of the upstream node type, so
   * declaring it required would be a claim this repo cannot enforce. The strand
   * backfill (`peer-join-backfill.ts`) logs once and stays inert when it is absent.
   */
  keyNetwork?: IPeerNetwork;
}

/**
 * Node profile determines storage participation
 */
export type NodeProfile = 'transaction' | 'storage';

/**
 * Strand filter configuration - determines which strands this node participates in
 */
export type StrandFilter =
  | { mode: 'all' }                           // All strands (default for servers)
  | { mode: 'sAppId'; sAppId: string }        // Only strands for specific sApp
  | { mode: 'strandId'; strandId: string }    // Single specific strand
  | { mode: 'none' };                         // Control network only

/**
 * Latency hint for strand hibernation behavior
 */
export type LatencyHint = 'realtime' | 'interactive' | 'background' | 'archive';

/**
 * Hibernation timeout configuration per latency hint (in milliseconds)
 */
export interface HibernationTimeouts {
  /** Time before transitioning from active to idle */
  idleTimeout: number;
  /** Time before transitioning from idle to hibernating */
  hibernateTimeout: number;
  /**
   * Base interval for the FIRST check-in after hibernating. Successive
   * no-activity check-ins escalate this delay by {@link checkInBackoffFactor}
   * (see {@link HibernationManager}'s self-rescheduling check-in chain).
   */
  checkInInterval: number;
  /**
   * Multiplier applied to the check-in delay after each check-in that finds no
   * pending activity (must be >= 1; 1 disables escalation). Default 2 →
   * doubling: base, base×2, base×4, … until {@link checkInMaxInterval}.
   */
  checkInBackoffFactor: number;
  /**
   * Upper bound on the escalating check-in delay — the concrete realization of
   * the architecture's "minutes → hours → days" ceiling for this hint. Backoff
   * never schedules a delay longer than this.
   */
  checkInMaxInterval: number;
}

/**
 * Default hibernation timeouts per latency hint.
 *
 * `checkInInterval` is the BASE delay; `checkInMaxInterval` is the per-hint
 * ceiling the exponential backoff escalates toward (interactive minutes→~1h,
 * background minutes→~6h, archive ~1h→~3 days).
 */
export const HIBERNATION_TIMEOUTS: Record<LatencyHint, HibernationTimeouts> = {
  realtime: {
    idleTimeout: Infinity,        // Never idle
    hibernateTimeout: Infinity,   // Never hibernate
    checkInInterval: Infinity,    // N/A
    checkInBackoffFactor: 2,
    checkInMaxInterval: Infinity  // N/A
  },
  interactive: {
    idleTimeout: 5 * 60 * 1000,   // 5 minutes
    hibernateTimeout: 15 * 60 * 1000, // 15 minutes after idle
    checkInInterval: 30 * 1000,   // base: 30 seconds
    checkInBackoffFactor: 2,
    checkInMaxInterval: 60 * 60 * 1000 // cap: ~1 hour
  },
  background: {
    idleTimeout: 1 * 60 * 1000,   // 1 minute
    hibernateTimeout: 5 * 60 * 1000,  // 5 minutes after idle
    checkInInterval: 5 * 60 * 1000,   // base: 5 minutes
    checkInBackoffFactor: 2,
    checkInMaxInterval: 6 * 60 * 60 * 1000 // cap: ~6 hours
  },
  archive: {
    idleTimeout: 10 * 1000,       // 10 seconds
    hibernateTimeout: 30 * 1000,  // 30 seconds after idle
    checkInInterval: 60 * 60 * 1000,  // base: 1 hour
    checkInBackoffFactor: 2,
    checkInMaxInterval: 3 * 24 * 60 * 60 * 1000 // cap: ~3 days
  }
};

/**
 * Storage provider - either an `IRawStorage` instance or a factory function.
 * Factory functions are useful for creating per-scope storage instances.
 *
 * **The argument is an opaque scope key.** Use it directly as a file name, directory
 * name or database name: every key stays within `[A-Za-z0-9._-]`, so no escaping is
 * needed and none should be assumed. Do not parse it; `controlStorageScope` /
 * `isControlStorageScope` (`storage-scope.ts`) are the supported way to mint and
 * recognize the control key. The control key holds the charset by base64url encoding;
 * a strand's key — its strand id, which may have replicated in from another node in
 * the party — holds it because `StrandInstanceManager.startStrand` runs
 * `assertStrandScopeKey` on every launch and refuses a strand that fails it.
 *
 * **Called once per scope per runtime lifetime.** The scopes are the control database
 * (once per `CadreNode.start()`) and each strand id (once per `startStrand`).
 * Hibernation — `quiesceStrand` then `resumeStrand` — reuses the store already
 * resolved for that strand and does NOT re-enter this callback.
 *
 * **The control scope is party-specific.** It is `controlStorageScope(partyId)`, not a
 * fixed string, because the control database holds one party's own records — its
 * strands, owner keys, peers, invitations, revocations. Two parties on one device ask
 * for two different keys and MUST get two different stores, or a node started for one
 * party reads the other's rows as its own.
 *
 * It IS re-entered for a scope after that scope's runtime has stopped
 * (`stopStrand`, or a `stop()` then `start()` cycle on one `CadreNode`), so it must
 * be able to hand back a store over the same durable backend a second time. A
 * factory may mint a fresh object per call; it must not *need* to.
 *
 * cadre-core disposes only its own cache wrapper — it never closes the store you
 * returned. Closing the underlying handle stays the embedder's job.
 *
 * **The single-instance form shares data across scopes by construction** — one store
 * for every strand AND for every party's control database. An embedder that can serve
 * more than one party must use the factory form. One instance handed to every scope
 * also shares ONE cache wrapper (`wrapStorageWithCache` memoizes per inner instance),
 * which counts its holders: a scope stopping releases only its own claim, and the
 * wrapper is retired when the last scope releases it. The factory form is the better
 * default for the further reason that it partitions each strand's data, which
 * simplifies cleanup.
 */
export type RawStorageProvider = IRawStorage | ((scope: string) => IRawStorage);

/**
 * Storage configuration for storage profile nodes
 */
export interface StorageConfig {
  /**
   * Storage provider - either an IRawStorage instance or a factory function.
   * See {@link RawStorageProvider} for how often cadre-core calls it, and for why
   * the single-instance form cannot serve more than one party.
   *
   * The `scope` a factory receives is an opaque key already safe as a path or
   * database-name segment (always within `[A-Za-z0-9._-]`), so each example below
   * interpolates it directly.
   *
   * For Node.js environments, use FileRawStorage from @optimystic/db-p2p-storage-fs:
   * ```typescript
   * import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
   * storage: { provider: (scope) => new FileRawStorage(`./data/${scope}`) }
   * ```
   *
   * For React Native, use the appropriate storage from @optimystic/db-p2p-storage-rn:
   * ```typescript
   * import { LevelDBRawStorage } from '@optimystic/db-p2p-storage-rn';
   * // `db` is an open LevelDB handle (see `openOptimysticRNDb` over `rn-leveldb`)
   * storage: { provider: (scope) => new LevelDBRawStorage(openDb(`sereus-${scope}`)) }
   * ```
   *
   * For in-memory storage (testing):
   * ```typescript
   * import { MemoryRawStorage } from '@optimystic/db-p2p';
   * storage: { provider: () => new MemoryRawStorage() }
   * ```
   */
  provider: RawStorageProvider;
  quotaBytes?: number;
}

/**
 * Network configuration for libp2p
 */
export interface NetworkConfig {
  /**
   * Addresses this machine's libp2p nodes bind. Omitted, `@optimystic/db-p2p`'s own
   * default (`/ip4/0.0.0.0/tcp/0`) applies; `[]` means "cannot listen" and is honored
   * as written (React Native hosts rely on that).
   *
   * The machine runs one control node plus one node per strand, so a FIXED port here
   * can only belong to one of them. The control node binds it as configured; each
   * strand node binds the same entry with its port rewritten to `0`, keeping the
   * interface and transport (`/ws`, a specific-interface bind). A
   * `<relay>/p2p-circuit` entry is untouched — the port inside it is the relay's, not
   * a local bind. See `strand-network-config.ts`.
   *
   * **Only TCP, WebSocket (`/ws`, `/wss`) and circuit-relay addresses are bindable**
   * unless {@link transports} supplies the factories for something else. A `/ws` entry
   * switches the WebSocket transport on by itself; anything else — `/quic-v1`,
   * `/webrtc`, `/webtransport` — refuses node start naming the address and the libp2p
   * package it would need, rather than being dropped in silence by libp2p's transport
   * manager. See `relay-addrs.ts` → `resolveTransportOptions`.
   */
  listenAddrs?: string[];
  /**
   * Addresses to advertise to peers **instead of** `listenAddrs` — for a node behind
   * NAT or a reverse proxy that is reachable at a different address than it binds
   * (e.g. `mynode.example.com:4001` in front of a `0.0.0.0:4001` listener). Reaches
   * libp2p's `addresses.announce` via `@optimystic/db-p2p`'s `NodeOptions.announceAddrs`.
   *
   * **Applies to this machine's CONTROL node only.** Strand nodes drop it: any concrete
   * entry names a port, and that port is the control node's, so a strand node
   * advertising it would send peers to the wrong node (`strand-network-config.ts`).
   * Entries are still validated at node start whichever node ends up using them.
   *
   * **A non-empty value REPLACES the advertised set entirely.** Observed addresses,
   * and the `/p2p-circuit` address earned from a {@link relayAddrs} reservation, are
   * all dropped from what peers are told — so a node configured with both this and
   * `relayAddrs` stops being reachable through its relay. `CadreNode.start()` warns
   * when it sees that combination; it does not refuse it, since a node whose relay
   * slot is decorative may legitimately want only the announced address.
   *
   * Reach for {@link appendAnnounceAddrs} instead in the common case — one publicly
   * reachable address ADDED to everything else the node advertises. Or for
   * {@link relayAddrs} alone, when the node has no stable public address to name and
   * a relay reservation is what makes it dialable. (`inviteAddressResolver` is a
   * narrower tool again: it substitutes a reachable address into invite payloads
   * only, and changes nothing about what this node advertises on the wire.)
   *
   * An empty array means "unset" — it is dropped rather than forwarded, so it cannot
   * land as an explicit empty announce set. An empty *entry* is a different thing and
   * is rejected: a list of one blank string is non-empty, so it would replace every
   * advertised address with nothing. Malformed entries are rejected on the same terms,
   * both at node start — libp2p itself would not notice either until its first address
   * lookup (see `announce-addrs.ts`), so this repo checks each entry up front.
   */
  announceAddrs?: string[];
  /**
   * Addresses to advertise **in addition to** `listenAddrs` — the field most
   * deployments actually want, since it makes a node reachable at a public address
   * without discarding the observed and `/p2p-circuit` addresses it would otherwise
   * advertise. Reaches libp2p's `addresses.appendAnnounce` via
   * `@optimystic/db-p2p`'s `NodeOptions.appendAnnounceAddrs`.
   *
   * **Control node only**, on the same terms as {@link announceAddrs}.
   *
   * **Ignored while {@link announceAddrs} is non-empty** — that is libp2p's own
   * precedence, applied upstream; this repo does not merge the two locally. Set one
   * or the other, not both.
   *
   * Empty-array, blank-entry and malformed-entry handling all match {@link announceAddrs}.
   */
  appendAnnounceAddrs?: string[];
  /**
   * Circuit-relay servers this node reserves a slot on, so peers can reach it
   * from behind NAT. Each entry is the relay's DIRECT dial multiaddr ending in
   * its peerId — `/dns4/relay.example.com/tcp/4001/p2p/12D3KooW…` — with no
   * `/p2p-circuit` suffix (one is appended for you; an entry that already has
   * one is passed through unchanged).
   *
   * On the CONTROL node this adds libp2p's bare `/p2p-circuit` SEARCH listener to
   * {@link listenAddrs} (`relay-addrs.ts`) and `CadreNode.start()` drives the
   * reservation itself once the control database is up — the ordering matters,
   * because a listener that dials its relay from inside `libp2p.start()` put a
   * sibling in this node's cohort before its own database existed, and a sibling
   * that had not yet replicated this node's membership row refused the bring-up.
   * STRAND nodes take the same search shape, one bare listener plus one reservation
   * supervisor PER relay, fail-soft (`strand-network-config.ts`,
   * `strand-instance-manager.ts`). A relay named here also becomes a
   * delegate-announce target, so this node's strand nodes may reserve on it too
   * (see `delegate-admission.ts`).
   *
   * Setting this gives the node a listener even when `listenAddrs` is `[]` —
   * that is the point of naming a relay, but note that React Native hosts
   * (`reference-app-rn`'s `cadre-phone.ts`) deliberately do NOT listen, and
   * must not acquire a listener by accident.
   *
   * FAIL-FAST both ways: a malformed entry throws at node start rather than being
   * silently dropped, and — while {@link requireRelay} stays at its default —
   * a first reservation attempt that lands no `/p2p-circuit` address throws
   * `RelayReservationFailedError` out of `start()`. The fail-soft posture over
   * the same machinery is `CadreNode.reserveRelays()`.
   */
  relayAddrs?: string[];
  /**
   * Must a relay named in {@link relayAddrs} have granted a reservation before
   * `start()` is allowed to succeed? Default `true`: an operator who names a
   * relay is telling this machine it has no other reachability, so a relay
   * that will not have us on the first attempt should stop the boot loudly
   * rather than leave a node nobody can reach.
   *
   * Set `false` for a node that must still boot with no network — a phone or a
   * browser tab. The first attempt is still driven at the same point in
   * `start()`; a lost reservation just logs instead of throwing, and the
   * retry supervisor keeps trying in the background exactly as it does after a
   * `CadreNode.reserveRelays()` call. A caller on this posture cannot infer
   * dialability from `start()` resolving — read
   * {@link CadreNode.getRelayReservationState} to find out.
   *
   * It buys a node that BOOTS, not a node that boots fast: `start()` still waits
   * out that first attempt, which costs the drive's whole timeout
   * (`DEFAULT_RELAY_RESERVE_TIMEOUT_MS`, 10 s) against a relay that is unreachable
   * rather than merely refusing (`relay-reservation.ts` polls to the deadline, in
   * case libp2p's own discovery lands a reservation independently).
   *
   * Softens only the RESERVATION half of {@link relayAddrs}'s fail-fast
   * contract. A malformed `relayAddrs` entry still throws at config
   * resolution regardless of this setting — a typo is an operator error
   * whatever the posture — and a hand-written `<relay>/p2p-circuit` entry in
   * {@link listenAddrs} is still rejected on the control node, since that
   * rejection is about the listener shape, not about whether reachability is
   * required.
   *
   * Has no effect on STRAND nodes, which are already fail-soft over
   * `relayAddrs` regardless of this field (`strand-network-config.ts`,
   * `strand-instance-manager.ts`).
   */
  requireRelay?: boolean;
  /**
   * Enable circuit relay server - allows this node to relay connections for other peers.
   * When undefined, defaults to true for storage profile nodes (they typically have
   * better connectivity and uptime), false for transaction profile nodes.
   */
  enableRelay?: boolean;
  /**
   * Cap on concurrent circuit-relay reservations this node's relay server grants to
   * peers it cannot (yet) recognize as authorized members — the boot-ordering window
   * where a genuine member reserves its relay slot before its membership row has
   * replicated here (see `membership-connection-gater.ts` → "The relay-reservation
   * seam"). Authorized members and announced delegate peers are never counted against
   * it. Default `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` (8); 0 refuses every
   * unauthorized reservation. Only meaningful while {@link enableRelay} is on.
   */
  unauthorizedRelayReservationCap?: number;
  /**
   * Custom libp2p transports. When omitted, the default transports from
   * `@optimystic/db-p2p` are used (TCP + circuit relay for Node.js).
   *
   * React Native apps must supply WebSocket-based transports because TCP
   * is not available in the RN runtime:
   * ```typescript
   * import { webSockets } from '@libp2p/websockets';
   * import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
   *
   * network: {
   *   transports: [webSockets(), circuitRelayTransport()],
   *   listenAddrs: []  // RN nodes typically cannot listen
   * }
   * ```
   */
  transports?: Libp2pTransports;
  /**
   * Crypto primitives for the Noise handshake and the encrypted connection that
   * follows, threaded to both the control node and every strand's cohort node — every
   * node pays the handshake, so one setting covers them all. When omitted, libp2p-noise
   * picks its own default.
   *
   * React Native is the reason this exists: Metro resolves `@chainsafe/libp2p-noise`'s
   * browser build, whose default is pure-JS crypto, and on Hermes (no JIT) that
   * dominates connection setup on a slow phone. An app with native crypto supplies it
   * here. It must implement every member of the interface; the usual shape spreads
   * `noisePureJsCrypto` and overrides the hashing and ChaCha20-Poly1305 functions:
   * ```typescript
   * import { noisePureJsCrypto } from '@optimystic/db-p2p';
   *
   * network: {
   *   noiseCrypto: { ...noisePureJsCrypto, hashSHA256: nativeSha256, chaCha20Poly1305Encrypt: …, chaCha20Poly1305Decrypt: … }
   * }
   * ```
   *
   * Only local primitives change — the wire protocol does not, so a node with native
   * crypto interoperates with one without. See `@optimystic/db-p2p`'s
   * `NodeOptions.noiseCrypto`.
   */
  noiseCrypto?: NoiseCryptoInterface;
  /**
   * libp2p's connection monitor — the liveness ping it runs on every connection — for
   * the control node and every strand node, as {@link noiseCrypto} is. When omitted,
   * cadre-core applies {@link DEFAULT_CONNECTION_MONITOR} rather than leaving libp2p's
   * own defaults in place; an explicit value REPLACES that default wholesale, so `{}`
   * is how an app asks for libp2p's stock behaviour back.
   *
   * Typed from `@optimystic/db-p2p`'s re-export of libp2p's `ConnectionMonitorInit`, so
   * an app does not need a direct `libp2p` dependency, and handed to db-p2p's
   * `NodeOptions.connectionMonitor` unchanged.
   *
   * An app that widens the ping deadline itself must raise `pingInterval` above it in
   * the same object, or libp2p aborts the connection on the second overlapping ping —
   * see {@link DEFAULT_CONNECTION_MONITOR} for why.
   */
  connectionMonitor?: Libp2pConnectionMonitorInit;
  /**
   * Optional async resolver returning the multiaddrs to embed in invites
   * (and other owner-address contexts). When unset, `libp2pNode.getMultiaddrs()`
   * is used. Hosts behind NAT supply this to substitute their DDNS hostname
   * and externally-mapped port — see `@serfab/cadre-host`'s NatService.
   *
   * Returned addresses need NOT carry a `/p2p/<peerId>` suffix: `CadreNode`
   * appends its own before publishing or dialing any of them, so a resolver
   * cannot leave a sibling with the mixed suffixed/unsuffixed list that
   * `libp2p.dial` rejects. Returning them already suffixed is equally fine.
   */
  inviteAddressResolver?: () => Promise<string[]>;
  /**
   * Optional libp2p connection gater, threaded to both the control node and every
   * strand's cohort node. libp2p's browser default denies dialing insecure
   * WebSockets and private/loopback addresses; callers that must dial local or
   * unsecured peers (the web reference dialing a `127.0.0.1/.../ws` responder,
   * Playwright e2e, RN simulators) supply a permissive gater here — e.g.
   * `{ denyDialMultiaddr: () => false }`. See `@optimystic/db-p2p`'s
   * `libp2p-node-base` for the underlying option.
   *
   * On the CONTROL node this gater is composed with the built-in membership
   * admission gate (`membership-connection-gater.ts`): every hook supplied here
   * is honored unchanged, and on inbound encrypted connections a deny from
   * either this gater or the membership policy denies.
   *
   * Strand cohort nodes: an OPEN strand's node receives this gater as-is (its
   * peers are legitimately cross-party). A CLOSED strand's node composes
   * revoked-peer denial onto it (`strand-revocation-enforcer.ts`) — every hook
   * supplied here is still honored unchanged, and on the composed hooks
   * (inbound encrypted connection, outbound peer dial, relay reservation) a
   * deny from either this gater or the revocation check denies.
   */
  connectionGater?: ConnectionGater;
  /**
   * Tuning for the proactive control-cohort dial routine
   * ({@link CadreNode.reconcileControlCohort}), which keeps a party's control
   * nodes connected so the `CadreControl` collections form a replicating cohort.
   * Every field is optional; omit for the defaults
   * ({@link DEFAULT_CONTROL_COHORT_TARGET_DEGREE} /
   * {@link DEFAULT_CONTROL_COHORT_RECONCILE_MS} /
   * {@link DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS} /
   * {@link DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS} / `STRAND_PEER_ADDR_REFRESH_MS`).
   */
  controlCohort?: {
    /**
     * Cap on the number of NON-owner siblings dialed per reconcile pass
     * (backbone/owner members are always dialed and do not count). Defaults
     * to {@link DEFAULT_CONTROL_COHORT_TARGET_DEGREE}.
     */
    targetDegree?: number;
    /**
     * Recurring reconcile cadence in ms. Defaults to
     * {@link DEFAULT_CONTROL_COHORT_RECONCILE_MS}.
     */
    reconcileMs?: number;
    /**
     * Limit on dialing ONE peer — all of its candidate addresses together — in
     * ms. Bounds a reconcile pass at (dialed siblings) × this. The same limit
     * applies to the owner dials of `applySeed` and to `dialInvite`. Defaults to
     * {@link DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS}.
     */
    dialTimeoutMs?: number;
    /**
     * Limit on ONE candidate address's dial attempt, in ms, inside
     * {@link dialTimeoutMs}. Each address is dialed on its own under this limit,
     * so an address that never answers cannot use up the time the peer's other
     * addresses needed. Defaults to
     * {@link DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS}.
     */
    perAddressDialTimeoutMs?: number;
    /**
     * How often each running strand re-resolves its siblings' strand-network
     * addresses into its own libp2p address book — a step of the reconcile pass,
     * on its own much longer throttle. Defaults to `STRAND_PEER_ADDR_REFRESH_MS`
     * (10 min); must stay well under the peerStore's one-hour address expiry.
     */
    strandAddrRefreshMs?: number;
  };
}

/**
 * The connection-monitor settings every cadre node runs with when
 * {@link NetworkConfig.connectionMonitor} is unset: a 30 second ping deadline in place
 * of libp2p's 5 second one, and a 35 second gap between pings so a ping is never
 * outstanding when the next one starts.
 *
 * WHY this is a default and not opt-in. libp2p's monitor pings every connection and,
 * with its own `abortConnectionOnPingFailure: true`, aborts the connection on the FIRST
 * timeout. A peer whose event loop is saturated by pure-JS Noise crypto — a slow phone
 * under React Native, see {@link NetworkConfig.noiseCrypto} — misses that deadline while
 * perfectly healthy; the other end aborts, the peer redials, and the new handshake
 * saturates it further. Measured on gotchoices/sereus#13 at a Galaxy S7's crypto cost, a
 * two-party bring-up failed 3 of 3 runs on stock settings, with 30 `aborting connection
 * due to ping failure` entries in the relay's log for one run, and passed 4 of 4 in about
 * 90 seconds once the deadline was widened on every node. The monitor runs on BOTH ends
 * of a connection and either end's abort closes it for both, so a setting the phone alone
 * applies does not cover the peer dropping it. That is what rules out scoping this to
 * React Native.
 *
 * WHY `pingInterval` MOVES WITH THE DEADLINE, and is not left at libp2p's 10 seconds.
 * The monitor opens a ping stream per connection per interval whether or not the previous
 * ping has answered, and `/ipfs/ping/1.0.0` is registered by `@libp2p/ping` with
 * `maxOutboundStreams: 1`. A second concurrent ping stream on one connection therefore
 * fails in `Connection.newStream` with `TooManyOutboundProtocolStreamsError`, which
 * reaches the monitor's own catch and aborts the connection exactly as a timeout does. A
 * widened deadline alone is thus capped by the ping interval: measured against two local
 * libp2p 3.1.3 nodes whose ping handler answered 600ms late, an interval of 300ms with a
 * 900ms deadline aborted the connection, while a 900ms interval with the same deadline
 * kept it (the same pair aborted at a 200ms stall only when the deadline was 300ms). An
 * interval strictly above the deadline is what makes the 30 seconds real.
 *
 * WHAT IT COSTS. A dead peer is reclaimed 30 to 65 seconds after it stops answering — the
 * deadline, plus up to one interval of waiting for the ping that will fail — where
 * libp2p's defaults took about 5 to 15 seconds. `db-p2p` caps a node at 16 connections,
 * so the worst case is those slots held about a minute longer than before; at that scale
 * it is not a starvation risk.
 *
 * WHY THE DEADLINE IS PINNED rather than given room to adapt. `pingTimeout` is an
 * adaptive-timeout init, and equal `minTimeout`/`maxTimeout` clamp it to one value on
 * every libp2p version. Under libp2p 3.1.3, which sereus resolves today, it is already
 * flat at `minTimeout`: `ConnectionMonitor` asks its `AdaptiveTimeout` for a deadline but
 * never calls `cleanUp` to report how long the ping took, so the moving average the
 * deadline derives from stays at zero. libp2p 3.3 does report ping durations back, and a
 * ceiling above `pingInterval` would then let the deadline grow past the interval and put
 * the overlapping-ping abort above straight back. Pinning both ends keeps the interval's
 * margin true on the version bump instead of making it something to remember. It also
 * sidesteps 3.3's other surprise: the monitor keeps one `AdaptiveTimeout` for all of a
 * node's connections, so one slow peer would otherwise lengthen the deadline for every
 * connection on that node.
 */
export const DEFAULT_CONNECTION_MONITOR = Object.freeze({
  // Strictly greater than the deadline below, so the previous ping is always resolved or
  // aborted before the next one opens a stream. `types.spec.ts` holds the two apart.
  pingInterval: 35_000,
  // Frozen at both levels, as `CONTROL_CLUSTER_POLICY` is: one object reaches every
  // libp2p node this process builds, so a mutation anywhere would move the deadline
  // for all of them.
  pingTimeout: Object.freeze({ minTimeout: 30_000, maxTimeout: 30_000 })
} satisfies Libp2pConnectionMonitorInit);

/**
 * Hibernation configuration
 */
export interface HibernationConfig {
  enabled: boolean;
  defaultLatencyHint?: LatencyHint;
  /** Custom timeouts per latency hint (overrides defaults) */
  customTimeouts?: Partial<Record<LatencyHint, Partial<HibernationTimeouts>>>;
  /**
   * How long a hibernating strand stays resumed during a check-in to let its
   * strand network connect to reachable cohort peers (and the app drive
   * pull-on-read activity) before re-hibernating if still idle. Defaults to
   * {@link DEFAULT_CHECKIN_WINDOW_MS}.
   */
  checkInWindowMs?: number;
}

/**
 * Default duration of the resume-and-probe window during a strand check-in.
 * See {@link HibernationConfig.checkInWindowMs}.
 */
export const DEFAULT_CHECKIN_WINDOW_MS = 15 * 1000;

/**
 * Control network configuration
 */
export interface ControlNetworkConfig {
  partyId: string;
  bootstrapNodes: string[];
  /** Optional path to the control schema file (defaults to bundled schema) */
  schemaPath?: string;
}

/**
 * Replication-breadth constants, both networks' cluster policies, and the strand
 * resolver, re-exported so cadre embedders, the SQL plugin and the integration
 * harness share one definition. Defined in `@serfab/quereus-plugin-sereus`
 * because that package also creates libp2p nodes and cannot depend on this one.
 * The control network's breadth is fixed ({@link CONTROL_REPLICATION_BREADTH},
 * not configurable) and so is its consensus policy ({@link CONTROL_CLUSTER_POLICY}
 * — notably the super-majority threshold, which it leaves at Optimystic's default
 * by omission); the strand breadth defaults to
 * {@link CadreNodeConfig.strandClusterSize} while its policy is the fixed
 * {@link STRAND_CLUSTER_POLICY}.
 *
 * The two `*ClusterPolicy` BUILDERS are the same objects with the block-repair
 * corroboration yardstick declared from the machines enrolled in this party
 * ({@link resolveRepairYardstick}); handed no count, each returns its frozen base
 * constant unchanged. A network picks the derived number up when its libp2p node is
 * built, which for a strand is every wake from hibernation.
 */
export {
  MIN_CLUSTER_SIZE,
  CONTROL_REPLICATION_BREADTH,
  CONTROL_CLUSTER_POLICY,
  DEFAULT_STRAND_CLUSTER_SIZE,
  STRAND_CLUSTER_POLICY,
  resolveStrandClusterSize,
  resolveRepairYardstick,
  controlClusterPolicy,
  strandClusterPolicy
} from '@serfab/quereus-plugin-sereus';

/**
 * Main configuration for a CadreNode
 */
export interface CadreNodeConfig {
  /**
   * If provided, use this keypair for the node identity (direct injection).
   * Mutually exclusive with {@link keyStore} — supplying both is a configuration
   * error (fail closed) thrown by `start()` before any network bring-up.
   */
  privateKey?: PrivateKey;

  /**
   * Pluggable secure store for node key material. When set, the node loads its
   * identity from `keyStore` under {@link identityKeyId}, generating + persisting
   * a fresh Ed25519 key on first run (protobuf bytes are the canonical stored
   * form). Mutually exclusive with {@link privateKey}. Absent ⇒ use `privateKey`
   * when set, else libp2p generates an ephemeral key.
   *
   * In the single-key reference model the owner signing key is *derived from*
   * the node identity (see {@link CadreNode.getIdentityOwnerKey}), so
   * protecting the identity in a secure enclave protects the owner key too.
   * A future separate-owner slot (`ownerKeyId`) is anticipated but not
   * built here.
   */
  keyStore?: KeyStore;

  /** Slot id for the node identity in {@link keyStore}. Default: `'cadre/identity'`. */
  identityKeyId?: KeyId;

  /** Control network connection settings */
  controlNetwork: ControlNetworkConfig;

  /** Node profile: transaction-only or storage */
  profile: NodeProfile;

  /** Which strands to participate in */
  strandFilter?: StrandFilter;

  /** Storage configuration (only for storage profile) */
  storage?: StorageConfig;

  /** Network configuration */
  network?: NetworkConfig;

  /**
   * Number of nodes Optimystic is told a **strand** network's replication cluster
   * should have, for every strand this node starts. The control network is not
   * configurable — it always replicates to {@link CONTROL_REPLICATION_BREADTH}
   * nodes, which is above any party's node count, because every member reads the
   * whole control database and a member that misses a write may never learn the
   * fact (see that constant for the full reasoning).
   *
   * Every node on the same strand should use the same value: the number bounds the
   * cohort a member independently derives, and Optimystic's cluster-membership gate
   * can reject a coordinator's smaller declared set as a downsize against a larger
   * derived view.
   *
   * Frozen when the strand's libp2p node is created; a change takes effect on
   * restart, not when cadre membership grows. Defaults to
   * {@link DEFAULT_STRAND_CLUSTER_SIZE} (4 — the smallest breadth whose 0.75
   * super-majority still commits with one holder offline); anything below
   * {@link MIN_CLUSTER_SIZE} is rejected before a node is created. The cost of a
   * small value is replication breadth and reliance on read repair, not commit
   * correctness — but at 2 that read repair cannot converge, because a lone
   * corroborator's stale answer is accepted as the cluster's truth.
   */
  strandClusterSize?: number;

  /**
   * Tuning for the strand peer-join block catch-up (see `peer-join-backfill.ts`):
   * when a strand's libp2p node connects to a peer this runtime has not yet
   * caught up, every block in the strand's own raw store is pushed to that peer,
   * so a machine that joined the strand after blocks were committed still ends
   * up physically holding them. Applies to every strand this node starts.
   * Omit for the defaults (`DEFAULT_PEER_JOIN_BACKFILL`); `{ enabled: false }`
   * restores the no-backfill behaviour. The control network runs its own,
   * separately tuned catch-up — see {@link controlBackfill}.
   */
  strandBackfill?: PeerJoinBackfillConfig;

  /**
   * Tuning for the CONTROL network's peer-join block catch-up (same module,
   * `peer-join-backfill.ts`, wired in `CadreNode.start`): when the control
   * libp2p node connects to an AUTHORIZED party member this runtime has not yet
   * caught up, every block in the control database's own raw store is pushed to
   * it. This is what makes a control block committed while the writer was alone
   * (collection headers written at genesis above all) physically reach members
   * that joined later — without it, such a member that restarts offline reads
   * the affected tables as empty. Pushes are gated on
   * `CadreNode.isAuthorizedMember`, checked at push time, because the control
   * network's inbound gate deliberately admits non-members in several states
   * (seed delivery, enrollment, bootstrap/relay peers). Omit for the defaults
   * (`DEFAULT_PEER_JOIN_BACKFILL`); `{ enabled: false }` disables it.
   */
  controlBackfill?: PeerJoinBackfillConfig;

  /**
   * Tuning for the CLOSED-strand revoked-peer gate
   * (`strand-revocation-enforcer.ts`), applied to every closed strand this node
   * starts: each strand node materializes the peer ids bound to REMOVED members
   * (orphaned `Strand.MemberPeer` rows) and refuses them at the stream and
   * connection layers, so removing a party cuts the network to its machines
   * rather than only deleting its row. Open strands never arm it. Omit for the
   * defaults (`DEFAULT_REVOCATION_POLL_INTERVAL_MS` refresh cadence);
   * `{ enabled: false }` restores the pre-existing behaviour.
   */
  strandRevocationEnforcement?: StrandRevocationEnforcementConfig;

  /**
   * Tuning for the CLOSED-strand membership reconciler
   * (`strand-membership-reconciler.ts`), applied to every closed strand this
   * node launches with a party identity key: at bring-up each machine redeems a
   * pending formation invitation (seating the party's `Strand.Member` row) and
   * writes its own machine→party `Strand.MemberPeer` binding, retrying in the
   * background without blocking bring-up. `pollIntervalMs` is the IDLE cadence
   * (how often a machine nobody has admitted re-checks) and the cap of the
   * unfinished-join retry ladder, NOT the retry cadence itself — an unfinished
   * join retries from 1 s, doubling. Omit for the defaults (it mirrors
   * {@link strandRevocationEnforcement}'s `pollIntervalMs`);
   * `{ enabled: false }` disarms the loop — for test fixtures that hand-drive
   * the membership writers and assert exact row sets.
   */
  strandMembershipReconciliation?: StrandMembershipReconciliationConfig;

  /**
   * Tuning for the JOINING machine's first-sync write gate
   * (`strand-first-sync-gate.ts`), applied to every strand this node launches as a
   * non-founder: the strand's database is withheld from the app (`StrandInstance.database`
   * unset, status `'syncing'`) until the strand's `Strand.Header` has been received from
   * another member and every `App` table has been read once, because a machine that writes
   * to a table it has never fetched creates a private copy of it that never merges.
   * `timeoutMs` bounds how long {@link CadreNode.addStrand} waits before rejecting with
   * `StrandAwaitingFirstSyncError` (retryable — the launch stays up and keeps probing);
   * `pollIntervalMs` is the probe cadence. Omit for the defaults (`DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`,
   * 120 s — sized for a machine joining through a relay on a slow link; that constant's doc
   * comment carries the measurement behind the number and what the budget costs, and is the
   * only copy of it; `DEFAULT_STRAND_FIRST_SYNC_POLL_MS`, 500 ms). There is
   * deliberately no way to disable the gate: a machine that already holds the Header is never
   * gated, so nothing that works today is blocked by it.
   */
  strandFirstSync?: StrandFirstSyncConfig;

  /** Hibernation configuration */
  hibernation?: HibernationConfig;

  /** Polling interval for strand watcher in ms (default: 5000) */
  strandWatchInterval?: number;

  /**
   * Require a valid author signature on every sApp schema before a strand is
   * formed or joined. Defaults to true (fail closed): an unsigned schema is
   * rejected before any libp2p node or schema DDL is brought up. Set false ONLY
   * for dev/test where unsigned demo schemas are used.
   */
  requireSignedSchemas?: boolean;

  /**
   * Node-wide default trust anchor for INBOUND control-network seeds. Forwarded
   * into every SeedBootstrapService this node constructs (owner, receive-only
   * listener, and the temp service used by applySeed when no service exists), and
   * used as the service-level default the libp2p seed-protocol handler relies on
   * (that path has no per-call override seam). Defaults to anchoredTrustPolicy()
   * inside SeedBootstrapService when unset — a node whose node-local trusted-owner
   * anchor was never seeded then rejects every seed. A per-call
   * `applySeed(seed, { trustPolicy })` override still wins over this default for
   * callers that hold out-of-band material (e.g. a pinned key from a CadreInvite).
   */
  seedTrustPolicy?: SeedTrustPolicy;

  /**
   * Node-local trusted-owner anchor (see `trusted-owner-store.ts`): the
   * NON-replicated, per-party record of owner keys established out of band —
   * the anchor membership/seed trust can rest on, since the replicated
   * `OwnerKey` table can be polluted by a stranger's self-genesis. Absent ⇒ an
   * in-memory store is created at start() (ephemeral: anchored trust does not
   * survive the process).
   */
  trustedOwners?: {
    /**
     * Injected store instance — e.g. a `FileTrustedOwnerStore` from the
     * Node-only subpath `@serfab/cadre-core/trusted-owner-store-file`,
     * persisted in the node's state directory (same injection/isolation pattern
     * as {@link keyStore}). Its `partyId` must match `controlNetwork.partyId`;
     * start() fails closed on a mismatch.
     */
    store?: TrustedOwnerStore;
    /**
     * Owner keys (base64url ed25519) established out of band and seeded into
     * the store during start(): operator pins (e.g. cadre-cli
     * `--pin-owner-key` / `CADRE_OWNER_KEYS`) or a `CadreInvite.ownerKeys`
     * already known at config time. Seeding is idempotent across restarts.
     */
    pinnedKeys?: string[];
    /**
     * Provenance recorded for {@link pinnedKeys}. Default: 'operator'.
     * ('genesis' is reserved for the node's own founding key, seeded
     * internally by `initializeSeedBootstrap`.)
     */
    pinnedSource?: Exclude<TrustSource, 'genesis'>;
  };

  /**
   * Node-local cold-start bootstrap-peer store (see `bootstrap-peer-store.ts`):
   * the owner addresses an applied seed nominated, kept so
   * `reconcileControlCohort`'s cold-start branch can keep retrying a node that
   * was seeded but never managed to connect. Sibling of {@link trustedOwners} —
   * same NON-replicated, per-party, injected-backend shape — but nothing here is
   * trust-bearing: these are dial hints only, and every address is re-bound to
   * its peer id before the dial. Absent ⇒ an in-memory store is created at
   * start() (ephemeral: the retry set does not survive the process, and such a
   * node is stranded permanently if it restarts before connecting).
   *
   * The Node CLI, the browser, and React Native all inject a durable backend
   * today; only NativeScript stays ephemeral, tracked by the
   * `ns-durable-node-local-stores` ticket (which covers the same gap for
   * {@link trustedOwners}). A new platform needs no new store class: supply a
   * `DurableSlot` for the platform's storage and inject
   * `PersistentBootstrapPeerStore.open(slot, partyId)` /
   * `PersistentTrustedOwnerStore.open(slot, partyId)`.
   */
  bootstrapPeers?: {
    /**
     * Injected store instance — e.g. a `FileBootstrapPeerStore` from the
     * Node-only subpath `@serfab/cadre-core/bootstrap-peer-store-file`, persisted
     * in the node's state directory (same injection/isolation pattern as
     * {@link keyStore} / {@link trustedOwners}). Its `partyId` must match
     * `controlNetwork.partyId`; start() fails closed on a mismatch.
     */
    store?: BootstrapPeerStore;
  };

  /**
   * Node-local record of how many machines this party had enrolled the last time
   * this node looked (see `enrolled-machine-store.ts`): the block-repair
   * corroboration yardstick the CONTROL node declares when its libp2p node is
   * built. Sibling of {@link trustedOwners} / {@link bootstrapPeers} — same
   * NON-replicated, per-party, injected-backend shape — and, like
   * {@link bootstrapPeers}, nothing here is trust-bearing: it is a repair hint,
   * recomputed from `CadrePeer` rows the moment the control database is up.
   *
   * It exists only because the control node is created BEFORE that database, so
   * the live count is unreadable at the one moment it is needed; remembering it
   * across the restart is what breaks that deadlock. Absent ⇒ an in-memory store
   * is created at start(), which cold-starts on every launch and therefore
   * declares nothing — byte-for-byte the behaviour before this record existed.
   * No embedder is forced to change.
   *
   * A party that grows applies the larger number on each node's NEXT launch,
   * deliberately: Optimystic freezes the policy at node construction and offers
   * no runtime setter, and a node still holding the old value runs at exactly
   * today's behaviour, so there is no forced rebuild.
   *
   * A new platform needs no new store class: supply a `DurableSlot` for the
   * platform's storage and inject `PersistentEnrolledMachineStore.open(slot, partyId)`.
   */
  enrolledMachines?: {
    /**
     * Injected store instance — e.g. a `FileEnrolledMachineStore` from the
     * Node-only subpath `@serfab/cadre-core/enrolled-machine-store-file`,
     * persisted in the node's state directory. Its `partyId` must match
     * `controlNetwork.partyId`; start() fails closed on a mismatch.
     */
    store?: EnrolledMachineStore;
  };

  /**
   * Platform push-delivery for suspended mobile peers. When present, the node's
   * server fan-out can deliver strand-wake data messages over the platform push
   * channel (FCM/APNs). Absent ⇒ no platform push (control-network push-wake only).
   *
   * The `notifier` is **injected**, not constructed here: a Node host builds it
   * from `@serfab/cadre-core/push-node` (`createPushNotifier(credentials)`) and
   * passes the instance, so the FCM/APNs modules (`node:crypto`/`node:http2`)
   * stay out of the cross-platform core graph. Ownership transfers to the node on
   * injection — `CadreNode.stop` closes the notifier (via `PushFanoutService`),
   * releasing its APNs HTTP/2 session; a host must NOT also close an injected
   * notifier itself. `cooldownMs`/`debounceMs` carry the fan-out anti-spam policy.
   */
  push?: {
    /** The Node-constructed push router (see `@serfab/cadre-core/push-node`). */
    notifier: PushNotifier;
    /**
     * Per-`(peer, strand)` minimum gap between push-wakes the fan-out emits.
     * Default {@link DEFAULT_PUSH_COOLDOWN_MS} (5 min).
     */
    cooldownMs?: number;
    /**
     * Per-strand burst-coalescing window: a second trigger within it is dropped.
     * Default {@link DEFAULT_PUSH_DEBOUNCE_MS} (10 s).
     */
    debounceMs?: number;
  };
}

/**
 * Status of a strand instance.
 *
 * `'syncing'` is a JOINING machine whose runtime is up (strand libp2p node, background
 * loops) but whose database is held back from the app until the strand's `Strand.Header`
 * has been received from another member — see `strand-first-sync-gate.ts`. In that state
 * `StrandInstance.database` is unset; the instance goes `'active'` (and `CadreNode` emits
 * `strand:writable`) the moment the Header is readable. A founder, or a machine that has
 * synced this strand before (restart, hibernation resume), never passes through it.
 */
export type StrandStatus =
  | 'starting'
  | 'syncing'
  | 'active'
  | 'idle'
  | 'hibernating'
  | 'stopping'
  | 'stopped'
  | 'error';

/**
 * App information from strand header
 */
export interface SAppInfo {
  id: string;
  version: string;
  schema: string;
  signature?: string;
}

/**
 * Strand instance state
 */
export interface StrandInstance {
  strandId: string;
  status: StrandStatus;
  sAppInfo?: SAppInfo;

  /** The libp2p node for this strand (only when live: syncing/active/idle) */
  libp2pNode?: Libp2p;

  /**
   * The Quereus database for this strand — set only while the strand is live AND
   * this machine may write to it. A joining machine that has not yet received the
   * strand's `Strand.Header` from another member runs with `libp2pNode` set and this
   * unset (status `'syncing'`); it is published when the Header arrives
   * (`strand:writable`). Unset while hibernating.
   */
  database?: StrandDatabase;

  /** Membership info for closed strands */
  memberKey?: string;
  memberPrivateKey?: string;

  /** Activity tracking */
  connectedPeers: number;
  lastActivity: Date;
  nextCheckIn?: Date;

  /** Latency hint from app or override */
  latencyHint: LatencyHint;

  /** Error message if status is 'error' */
  error?: string;
}

/**
 * Outcome of an on-demand {@link CadreNode.serviceWake} — the mobile push-wake
 * cycle (resume → bounded window → re-hibernate-if-idle) run imperatively for a
 * single strand.
 */
export interface ServiceWakeResult {
  /** The strand the wake was requested for. */
  strandId: string;
  /**
   * Whether the wake was actually serviced. `false` when the node is not
   * running, or the strand is unknown to this node (not a member-participated
   * strand) — never a thrown error, so a background task can branch on it.
   */
  serviced: boolean;
  /**
   * Whether activity landed during the wake window. `true` leaves the strand
   * active; `false` re-hibernates it (or the strand was already live, in which
   * case it reflects current liveness). Always `false` when `serviced` is `false`.
   */
  hadActivity: boolean;
}

/**
 * Strand row from control network - basic membership info
 */
export interface StrandRow {
  Id: string;
  MemberPrivateKey: string | null;
  Type: 'o' | 'c';
  /**
   * ed25519 (base64url) owner key of the MACHINE that published this row — the
   * signer of the owner-signed `Strand` insert (`== context.OwnerKey`, pinned by
   * the schema's `AuthorizedInsert`). Identifies the founding machine, so a
   * launch with no explicit `founder` flag derives "am I the founder?" by
   * comparing it to the node's own owner key (see `CadreNode.launchStrand`).
   * `null` on a consent-seated strand (the unsigned `FormationUsage` branch
   * records no trustworthy signer). Provenance, not content —
   * `strandRowMismatches` excludes it from the identical-content comparison.
   */
  FounderOwnerKey: string | null;
}

/**
 * sApp configuration provided by the hosting application when creating a strand.
 * This is what the app developer provides - NOT loaded from the network.
 */
export interface SAppConfig {
  /** Public key of the sApp author */
  id: string;
  /** Version of the sApp */
  version: string;
  /** The declarative schema DDL */
  schema: string;
  /**
   * Author's signature over the schema for verification. Required under the
   * default `requireSignedSchemas` node policy — a config without it is rejected
   * before strand bring-up. Optional in the type because authoring/serialization
   * must represent an as-yet-unsigned config; omitting it is honored only when
   * the node explicitly relaxes the policy (`requireSignedSchemas: false`, dev/test).
   */
  signature?: string;
  /** Latency hint for hibernation behavior (optional, defaults to config) */
  latencyHint?: LatencyHint;
}

/**
 * Full strand configuration when adding a strand via the API
 */
export interface StrandConfig {
  /** Strand row from control network */
  strandRow: StrandRow;
  /** sApp configuration provided by the hosting application */
  sAppConfig: SAppConfig;
  /**
   * Whether THIS node is the strand's founder — the party that provisioned and
   * published the strand (the responder in formation, the creator in host/solo
   * paths; the same party that calls {@link CadreNode.publishStrand}). The founder
   * runs the one-time membership bootstrap at bring-up (writes `Strand.Header`, and
   * for a closed strand the founding `Member`+`Manager`). A joiner leaves this
   * unset and writes nothing — it receives those rows via Optimystic sync.
   *
   * When unset, founder-ness is DERIVED from the row: this node founds iff
   * {@link StrandRow.FounderOwnerKey} equals its own owner key. An explicit
   * `true`/`false` wins over the derivation — the formation/responder flows pass
   * it deliberately, since a consent-seated row carries a null column.
   */
  founder?: boolean;
  /**
   * THIS party's own strand membership private key (base64 protobuf, as
   * `generateStrandMemberKey` mints) for a CLOSED strand — the identity whose public
   * key seats the founding `Member`/`Manager`. The explicit sibling of
   * {@link founder}: normally the launch reads it from the party's control-layer
   * `StrandPartyKey` row (minting one on the founding machine when absent), and an
   * explicit value here WINS over that read — for callers whose row carries no
   * founder provenance to heal against (an explicit `founder: true` over a hand-built
   * row, as the test harness does). Deliberately NOT
   * {@link StrandRow.MemberPrivateKey}, the strand-wide read secret every joining
   * party receives — that key derives nobody's identity.
   */
  partyMemberPrivateKey?: string;
  /**
   * Whether {@link CadreNode.addStrand} waits for a JOINING machine's first sync before it
   * resolves. Default `true`: the returned instance is writable (`database` set, status
   * `'active'`), or the call rejects with `StrandAwaitingFirstSyncError` after
   * `CadreNodeConfig.strandFirstSync.timeoutMs` — retryable, the launch stays up. `false`
   * returns as soon as the runtime is launched, possibly `'syncing'` with no `database`;
   * the caller then wires its own peers (a hand-dialed test fixture) and awaits
   * {@link CadreNode.whenStrandWritable} or the `strand:writable` event. A founder, or a
   * machine that already holds the strand's `Strand.Header`, is never gated either way.
   */
  awaitFirstSync?: boolean;
}

/**
 * What {@link CadreNode.foundStrand} needs to publish a strand's control row AND start it
 * locally as its founder — the resumable one-call form of `publishStrand` + `addStrand`.
 *
 * No `strandRow`: the row is the OUTPUT of founding, either freshly published or read back
 * from an interrupted earlier attempt. `StrandConfig` (the join/attach shape) takes one
 * because there the row already exists and came from the control network.
 */
export interface FoundStrandConfig {
  /** Unique strand identifier. Trimmed; blank is rejected. */
  strandId: string;
  /** `'o'` for open (default) or `'c'` for closed. */
  type?: 'o' | 'c';
  /**
   * Membership key gating a closed strand. Required in practice for `type: 'c'` (the
   * founder bootstrap rejects a null key), and IGNORED when the strand is already
   * published — the stored key wins, so read the resolved key back off the returned
   * instance rather than trusting a freshly minted one.
   */
  memberPrivateKey?: string;
  /** sApp configuration the hosting application provides, as for {@link StrandConfig}. */
  sAppConfig: SAppConfig;
  /**
   * Forwarded to the attach ({@link StrandConfig.awaitFirstSync}). Matters only when the
   * call ATTACHES rather than founds — the stored row was published by a sibling machine
   * that won the founding race — in which case this machine is a joiner whose database
   * is withheld until that sibling's `Strand.Header` reaches it; default `true` waits
   * for that inside the call. A founding launch is never gated.
   */
  awaitFirstSync?: boolean;
}

/**
 * What {@link CadreNode.foundStrand} hands back: the running instance PLUS the `Strand` row
 * the strand actually runs under.
 *
 * The row is returned separately rather than left for the caller to read off the instance
 * because on a resumed founding it is NOT the caller's input — a closed strand adopts the
 * stored `MemberPrivateKey`, discarding a freshly minted one. A caller that must carry the
 * membership key onward (to mint an invitation, say) reads it from HERE.
 */
export interface FoundStrandResult {
  /** The active local instance, as {@link CadreNode.addStrand} would have returned. */
  instance: StrandInstance;
  /** The live control-plane row: freshly published, or the one already there. */
  strandRow: StrandRow;
  /**
   * Whether THIS machine actually founded (ran / will have run the one-time
   * founder bootstrap). `false` when the resolved row was published by a
   * DIFFERENT machine's owner key — e.g. a sibling won a concurrent founding
   * race — in which case the call attached as a joiner instead, which is the
   * correct outcome (two machines bootstrapping one strand on separate replicas
   * is the double-`Header` hazard).
   */
  founded: boolean;
}

/**
 * Result of creating a new cadre peer
 */
export interface CreatePeerResult {
  peerId: PeerId;
  privateKey: Uint8Array;
}

// ============================================================================
// Member Registration API Types (from api.md)
// ============================================================================

/**
 * Registration data for joining a strand as a member.
 * Sent from invited member to any cadre member to accept invitation.
 */
export interface MemberRegistration {
  /** The strand being joined */
  strandId: string;
  /** The member's public key for this strand */
  key: string;
  /** Peer IDs of the member's cadre nodes that will participate */
  peerIds: string[];
}

/**
 * Result of member registration
 */
export interface MemberRegistrationResult {
  success: boolean;
  reason?: string;
}

// ============================================================================
// Strand Solicitation API Types (from api.md)
// ============================================================================

/**
 * Open invitation for strand formation.
 * Shared out-of-band to allow strangers to form strands.
 */
export interface OpenInvitation {
  /** Unique token identifying this invitation */
  token: string;
  /** The sApp that will be used for the strand */
  sAppId: string;
  /** When this invitation expires */
  expiration: Date;
  /** Bootstrap addresses to contact the inviter's cadre */
  bootstrap: string[];
}

/**
 * A single-use strand membership invitation carried on a closed-strand formation
 * result: the `Strand.Invite` keypair the responder (the host strand's founder party)
 * issued for this redemption. The joiner spends it — `consumeInvite` on its own strand
 * replica — to seat a `Strand.Member` row under its OWN party key, so joining no longer
 * hands out the founder's identity. Structurally identical to
 * `strand-membership-writer`'s `IssuedInvite`; declared here so the wire/type layer does
 * not import the writer.
 */
export interface StrandMembershipInvite {
  /** The invite ed25519 PUBLIC key (base64url) — the `Strand.Invite.Key` row. */
  inviteKey: string;
  /**
   * The invite ed25519 PRIVATE seed (base64url). A single-use bearer credential:
   * whoever holds it can `consumeInvite` exactly once. Same sensitivity class and
   * handling as `memberPrivateKey` — delivered only inside the validated,
   * post-approval formation result, never written to either side's control DB.
   */
  invitePrivateKey: string;
}

/**
 * Result of forming a strand via open invitation
 */
export interface FormStrandResult {
  /** The member key assigned to the initiator for this strand */
  memberKey: string;
  /** Private key for the invitation (for signing future messages) */
  invitePrivateKey: string;
  /** The strand that was created */
  strandId: string;
  /**
   * The strand's membership key (closed-strand read-gating secret), delivered through
   * the formation protocol after consent (provision-then-record). Present only for a
   * closed strand the responder returned with its key; undefined otherwise. Distinct
   * from {@link invitePrivateKey} (the initiator's own generated signing key).
   */
  memberPrivateKey?: string;
  /**
   * The joiner's own single-use membership invitation into the (closed, bound) host
   * strand — see {@link StrandMembershipInvite}. Present only when the responder's
   * host strand is closed and its runtime issued one; absent for open strands and the
   * responder-provisions (unbound) path. `CadreNode.formStrand` itself persists the
   * joiner's party key and caches this invitation for the strand bring-up to redeem,
   * so an embedding app normally never touches it.
   */
  membershipInvite?: StrandMembershipInvite;
  /**
   * The responder's live STRAND-network multiaddrs for the formed strand — the only
   * cross-party discovery seed there is, since the strand-addr RPC that resolves a
   * sibling's strand addresses answers own-party callers only.
   *
   * Always an array, frequently EMPTY: the responder discloses none when it holds no
   * live strand node for the strand it just provisioned (the responder-provisions path
   * mints a strand that has not launched yet). `CadreNode.formStrand` records these
   * itself, so an embedding app only needs them to seed a strand it launches OUTSIDE
   * that node.
   *
   * One-shot and in-memory: they are the responder's addresses at the moment of
   * formation and are never re-resolved — see `docs/strands.md`.
   */
  strandAddrs: string[];
}

/**
 * Disclosure object provided during strand formation.
 * Contains identity and context information from the initiator.
 */
export interface StrandFormationDisclosure {
  /** Initiator's party identifier */
  partyId?: string;
  /** Additional identity bundle (app-specific) */
  identityBundle?: unknown;
  /** Human-readable purpose/reason for forming the strand */
  purpose?: string;
  /** Additional app-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Arachnode ring participation stub - will be implemented when arachnode is built
 */
export interface ArachnodeConfig {
  /** Enable Arachnode subsystem (Ring Zulu + storage rings). Storage-profile only. */
  enableRingZulu: boolean;
  /** Storage ring participation (storage profile only) */
  storageRing?: {
    /** Which ring to participate in based on capacity */
    ring: number;
    /** Partition within the ring */
    partition?: number;
  };
}

/**
 * Events emitted by CadreNode
 */
export interface CadreNodeEvents {
  'strand:started': { strandId: string };
  'strand:stopped': { strandId: string };
  'strand:error': { strandId: string; error: Error };
  'strand:idle': { strandId: string };
  'strand:hibernating': { strandId: string };
  'strand:waking': { strandId: string };
  /**
   * Emitted when a strand that came up `'syncing'` — a joining machine whose database was
   * withheld until it received the strand's `Strand.Header` from another member — becomes
   * writable: `StrandInstance.database` is now set and the status is `'active'`. A strand
   * whose `strand:started` already reported `'active'` (a founder, or a machine that had
   * synced before) never emits this. The event form of what {@link CadreNode.addStrand}
   * awaits; an app that attaches without waiting (`awaitFirstSync: false`, or a strand the
   * watcher auto-launched) hangs its "waiting for the other member" screen on the pair.
   */
  'strand:writable': { strandId: string };
  /**
   * Emitted when this node discovers it is no longer a member of a CLOSED
   * strand — its party was removed by a manager, or it left. Detected by the
   * strand's revoked-peer gate (`strand-revocation-enforcer.ts`) seeing this
   * node's own peer id in the revoked set, so it is BEST-EFFORT: it fires only
   * if the removal replicated here before the rest of the strand cut us off,
   * and a node that was already offline may never see it at all.
   *
   * Nothing is stopped or torn down for you. Treat it as "this strand will no
   * longer sync": remaining members refuse this node's streams, dials, and
   * connections, so reads keep working against whatever is stored locally while
   * writes stop propagating. Stopping the strand (`stopStrand`) or deleting its
   * data is the app's decision. Emitted once per removal — re-armed if a manager
   * re-admits this party, so a second removal is reported again — and a
   * hibernation wake rebuilds the gate, which may re-emit for a strand still
   * revoked.
   */
  'strand:revoked': { strandId: string };
  /**
   * Emitted when this node holds a staged membership invitation for a CLOSED strand
   * that its own writes cannot redeem — the shape a REMOVED party hits when a manager
   * hands it a fresh invitation. Redeeming means writing this party's `Strand.Member`
   * row into the strand, and the machines that would carry that write are the ones the
   * remaining members refuse, so the attempt is made and fails. Two triggers, reported
   * at most once per re-arm of the membership loop (a further invitation staged while the
   * loop is still running does not reset the report):
   *
   * - CONFIRMED: the revoked-peer gate already flags this node as removed (the
   *   `strand:revoked` case) and an invitation is staged.
   * - PROBABLE: `UNFINISHED_PASSES_BEFORE_ESCALATION` consecutive attempts left the
   *   invitation staged. This one is a SUSPICION, not a verdict — the invitation's row
   *   may simply not have replicated here yet on a slow strand — and the accompanying
   *   warning names both causes.
   *
   * Nothing is stopped or torn down. A fresh invitation cannot re-admit a removed
   * party by itself: the remedy is a remaining manager admitting this party's member
   * key directly (`addMemberByManager`), after which the membership loop, which keeps
   * retrying, finishes the join on its own.
   */
  'strand:rejoin-blocked': { strandId: string };
  /**
   * Emitted when the control network advertises a strand this node has no
   * registered `sAppConfig` for — i.e. a strand created by another member, or
   * one this node ran in a previous session (sApp configs are in-memory only and
   * do not survive `stop()`). The hosting app decides whether to join it
   * (register a config + `addStrand`, e.g. via a chat `joinChatStrand` helper).
   * Carries the full {@link StrandRow} so the app can join without re-querying
   * the control DB.
   *
   * **Fired once per strand per session, and it can fire before your listener is
   * attached.** The strand watcher's first poll runs inside `CadreNode.start()`
   * (100 ms after the watcher starts), so every strand already stored for this
   * party is normally offered while the embedding app is still inside its own
   * `start()` await. The watcher then records the strand as seen and no later poll
   * re-offers it, so a listener attached a moment late misses those strands for the
   * life of the process.
   *
   * One exception, and it does NOT produce a second event: when an `addStrand` that
   * claims a discovered strand FAILS, the watcher is told to forget the strand so a
   * later poll retries it. That claim left the sApp config registered, so the retry
   * takes the auto-launch branch — what the app sees is `strand:error` per failed
   * retry and `strand:started` when one succeeds.
   *
   * So an app that auto-joins discovered strands must **subscribe first, then
   * drain `CadreNode.getDiscoveredStrands()`** — the map of strands no local
   * config claims. In that order a strand discovered between the two steps is
   * handled twice rather than not at all, which is why the join handler needs to
   * be idempotent (guard on an in-flight set, not only on
   * `getStrands().has(id)` — the strand manager tracks an instance only once
   * `addStrand` has resolved).
   */
  'strand:discovered': { strandId: string; strand: StrandRow };
  'control:connected': void;
  'control:disconnected': void;
  /**
   * Emitted when the control-write retry funnel GAVE UP on a local control write — the
   * classifier declined the failure as non-transient, or every attempt (or the elapsed
   * budget) ran out. One event per abandoned write, carrying the operation label, how far
   * it got, why it stopped and the error.
   *
   * Exists because an abandoned BACKGROUND write is otherwise invisible: the node's own
   * self-address republish, the post-connect drain and the replication drain all fire
   * their writes unawaited with a `debug`-only catch, and that namespace is off unless
   * something enabled it — so the write is lost and nobody is told. A FOREGROUND write's
   * caller sees the rethrown error as well as this event.
   *
   * What an app does with it is its own call; the node itself only escalates ONE case to
   * the operator (a self-address republish that has been failing longer than a peer
   * record stays fresh, at which point other machines are already discarding this node's
   * address). Treat the rest as telemetry — a control write that was lost, not a strand
   * or connection state change.
   */
  'control:write-abandoned': ControlRetryAbandonment;
  /** Emitted when a seed is received via the seed protocol */
  'seed:received': { partyId: string; peerId: string };
  /** Emitted when a seed is successfully applied */
  'seed:applied': { partyId: string; peersAdded: number };
  /** Emitted when seed application fails */
  'seed:error': { partyId: string; error: string };
}

// ============================================================================
// Peer Address Record / Resolution Types
// ============================================================================

/**
 * A peer's self-published, freshness-stamped, self-signed address record.
 *
 * This is the logical shape of a `CadreControl.CadrePeer` row. A node publishes
 * its own record (signing with the ed25519 key behind its PeerId); any node can
 * resolve another member's current signaling/relay multiaddrs from only its
 * PeerId by reading the record, re-verifying the self-signature against
 * `publicKey`, checking freshness, and applying a trust gate.
 *
 * The signature covers `peerId`, the comma-joined `addrs`, and `updatedAt` — see
 * `peerRecordSignedPayload`. `publicKey` is NOT inside the signed payload: it is
 * the key the signature is verified *with*, and its libp2p-identity binding to
 * `peerId` is checked separately at resolve time, so re-signing it would be
 * redundant.
 */
export interface PeerAddressRecord {
  /** libp2p peer ID (base58btc) — the row key. */
  peerId: string;
  /** ed25519 public key (base64url) whose libp2p identity IS `peerId`. */
  publicKey: string;
  /** Current dialable multiaddrs, signaling (`/p2p-circuit`) first. */
  addrs: string[];
  /** epoch ms — freshness; strictly increasing per peer. */
  updatedAt: number;
  /** ed25519 self-signature over the signed payload, base64url. */
  sig: string;
}

/**
 * One `CadreControl.CadrePeer` row as read by `ControlDatabase.queryCadrePeers`:
 * the addressing columns plus the persisted membership voucher.
 *
 * The voucher triple (`stampId`, `vouchOwner`, `vouchSig`) is what
 * {@link CadreNode.listAuthorizedMembers} re-checks against the node-local
 * trusted-owner anchor — it is null on a row written before the voucher columns
 * existed, and all three must be present for the row to be authorizable. Named
 * (rather than restated inline at each read site) so a future column addition
 * cannot reach the query without the predicate seeing it.
 */
export interface CadrePeerRow {
  /** libp2p peer ID (base58btc) — the row key. */
  peerId: string;
  /** Comma-joined dialable multiaddrs as stored, or null when unpublished. */
  multiaddr: string | null;
  /** Single-use anti-replay nonce the voucher signature is bound to. */
  stampId: string | null;
  /** ed25519 public key (base64url) of the owner that vouched this row. */
  vouchOwner: string | null;
  /** That owner's signature over `digest('CadreControl.CadrePeer', 'vouch', peerId, stampId)`, base64url. */
  vouchSig: string | null;
}

/** The voucher-bearing subset of a {@link CadrePeerRow} — what the authorized-membership predicate reads. */
export type CadrePeerVoucherFields = Pick<CadrePeerRow, 'peerId' | 'stampId' | 'vouchOwner' | 'vouchSig'>;

/**
 * One `CadreControl.Revocation` tombstone as read by
 * `ControlDatabase.queryRevocations`: the identity triple plus the `ReissuedAt`
 * counter an owner bumps (`ControlDatabase.reissueRevocations`) to re-write — and
 * therefore re-broadcast — a tombstone that committed while the node was alone.
 * Never the ledger marker: that row names no guarded table, and `queryRevocations`
 * skips it, which is what keeps `tableName` a {@link RevocableTable}.
 */
export interface RevocationRow {
  /** Which guarded table's stamp was retired. */
  tableName: RevocableTable;
  /** Primary key of the removed row (peer id / key / strand id). */
  rowKey: string;
  /** The retired single-use nonce — the tombstone's identity. */
  stampId: string;
  /** Monotonic re-issue counter; carries no semantics (see the schema comment). */
  reissuedAt: number;
}

/**
 * Outcome of `ControlDatabase.openRevocationLedger`: `'opened'` when this call filed the
 * singleton `Revocation` ledger marker, `'already-open'` when it was already filed (seen
 * by the in-lock guard, or filed first by another owner and refused on the primary key).
 * Either way the marker exists afterwards.
 */
export type RevocationLedgerOpenResult = 'opened' | 'already-open';

/**
 * Outcome of {@link CadreNode.registerSelf}, surfaced so callers (e.g. the CLI
 * `--owner` branch) can log what happened:
 * - `inserted` — the first owner-signed INSERT of this node's `CadrePeer` row.
 * - `refreshed` — a self-signed UPDATE of an existing row (heartbeat / addr change).
 *   Also reported when a first publish found its row seated by a concurrent
 *   `authorizePeer` of this node's own id and fell through to the UPDATE — the write
 *   really was an UPDATE, even though the caller's intent was a first publish.
 * - `skipped` — nothing written (no self-signing key, not yet a member with no
 *   owner service to self-insert, or the row was removed mid-publish).
 */
export type SelfRegistrationOutcome = 'inserted' | 'refreshed' | 'skipped';

/**
 * Options for {@link CadreNode.resolvePeerAddrs}.
 */
export interface ResolveOpts {
  /**
   * Freshness ceiling in ms. A record older than this is filtered out (a
   * resolver must never hand back a dead relay reservation). Defaults to
   * {@link DEFAULT_PEER_RECORD_MAX_AGE_MS}.
   */
  maxAgeMs?: number;
  /** Return only `/p2p-circuit` signaling addrs (the WebRTC dial input). */
  signalingOnly?: boolean;
  /**
   * Pluggable trust gate, evaluated after signature + freshness pass. Defaults
   * to {@link currentMemberTrustPolicy} (any existing — therefore
   * owner-vouched — CadrePeer member is trusted). Inject a stricter policy
   * (e.g. from `seed-signerkey-trust-policy`) to reject otherwise-valid records
   * before dialing.
   */
  trustPolicy?: PeerResolveTrustPolicy;
}

/**
 * Context handed to a {@link PeerResolveTrustPolicy} when gating a resolution.
 */
export interface PeerResolveContext {
  /** The peer being resolved. */
  peerId: string;
  /** The record's ed25519 public key (already bound to `peerId` and verified). */
  publicKey: string;
  /** The party whose control network produced the record. */
  partyId: string;
  /** The full verified, fresh record. */
  record: PeerAddressRecord;
}

/**
 * Decides whether a signature-verified, fresh peer-address record should be
 * trusted enough to dial. The seam through which a richer trust model
 * (trust circle, pinned keys) composes with `resolvePeerAddrs`.
 */
export interface PeerResolveTrustPolicy {
  evaluate(ctx: PeerResolveContext): Promise<boolean> | boolean;
}

// ============================================================================
// Device Token Registry Types
// ============================================================================

/** Platform push channel a {@link DeviceTokenRecord} targets. */
export type PushPlatform = 'fcm' | 'apns';

/**
 * A mobile cadre peer's self-published, freshness-stamped, self-signed platform
 * push token.
 *
 * This is the logical shape of a `CadreControl.DeviceToken` row. A phone publishes
 * its own record (signing with the ed25519 key behind its PeerId); a server peer
 * resolves it from the phone's PeerId to deliver a push-wake over FCM/APNs when a
 * control-network dial cannot reach the OS-suspended process. The signature covers
 * `peerId`, `platform`, `token`, and `updatedAt` — see `deviceTokenSignedPayload`.
 *
 * Unlike {@link PeerAddressRecord}, the record carries NO public key: it is verified
 * against the `CadrePeer.PublicKey` bound to the same `peerId`, so a `DeviceToken`
 * with no backing `CadrePeer` row can never be resolved.
 */
export interface DeviceTokenRecord {
  /** libp2p peer ID (base58btc) — the row key and the CadrePeer this token belongs to. */
  peerId: string;
  /** Push channel: `'fcm'` (Android/Firebase) or `'apns'` (Apple). */
  platform: PushPlatform;
  /** Opaque platform device/registration token. */
  token: string;
  /** epoch ms — freshness; strictly increasing per self-update (replay guard). */
  updatedAt: number;
  /** ed25519 self-signature over the signed payload, base64url. */
  sig: string;
}

/**
 * A stored `CadreControl.DeviceToken` row: the self-signed
 * {@link DeviceTokenRecord} plus the row's single-use `StampId` nonce.
 *
 * The stamp is deliberately OUTSIDE `DeviceTokenRecord`: the peer's own `Sig`
 * covers only (peerId, platform, token, updatedAt), while the stamp is bound by
 * the OWNER's insert/delete approvals. Readers need it to drop a row whose stamp
 * has been retired into `CadreControl.Revocation` (a token resurrected by an
 * approval replay on a node that had not yet converged on the tombstone).
 */
export interface DeviceTokenRow extends DeviceTokenRecord {
  /** Single-use authorization nonce; rotates on every (re)insert. */
  stampId: string;
}

/**
 * Options for {@link CadreNode.resolveDeviceToken}.
 */
export interface ResolveDeviceTokenOpts {
  /**
   * Optional freshness ceiling in ms. Defaults to NO ceiling (a record is fresh
   * as long as its `updatedAt` is positive): unlike a relay reservation, a device
   * push token stays valid until it rotates, so a long-suspended phone must remain
   * resolvable for push-wake. Set this to bound staleness explicitly.
   */
  maxAgeMs?: number;
}

// ============================================================================
// Push Credentials (platform push delivery — see push-notifier.ts)
// ============================================================================

/**
 * Platform push-delivery credentials injected into a participating node's config
 * (`CadreNodeConfig.push`). Provisioned per spawned node by `cadre-host` and read
 * by `createPushNotifier` to construct the FCM and/or APNs senders. A platform
 * whose block is absent is simply not deliverable (the router returns a
 * best-effort "no credentials" failure rather than throwing).
 *
 * Secret hygiene: every `privateKey` field is a secret — never logged (treated
 * like the node's startup/seed tokens).
 */
export interface PushCredentials {
  /** FCM (Android / Firebase) service-account credentials. */
  fcm?: FcmCredentials;
  /** APNs (Apple) auth-key credentials. */
  apns?: ApnsCredentials;
  /**
   * Per-`(peer, strand)` minimum gap between push-wakes the server fan-out emits —
   * the anti-spam cooldown a chatty strand needs. Default
   * {@link DEFAULT_PUSH_COOLDOWN_MS} (5 min). In-memory, acceptably lossy across
   * restarts (`serviceWake` is idempotent, so a duplicate wake is harmless).
   */
  cooldownMs?: number;
  /**
   * Per-strand burst-coalescing window for the fan-out: a second activity trigger
   * within this window is dropped (one wake is enough). Default
   * {@link DEFAULT_PUSH_DEBOUNCE_MS} (10 s).
   */
  debounceMs?: number;
}

/** Google service-account fields needed for FCM HTTP v1 OAuth2. */
export interface FcmCredentials {
  /** GCP project id → `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`. */
  projectId: string;
  /** Service-account email (JWT `iss`/`sub`). */
  clientEmail: string;
  /** Service-account RSA private key, PEM. Secret — never logged. */
  privateKey: string;
}

/** Apple APNs auth-key (.p8) fields. */
export interface ApnsCredentials {
  /** APNs key id (JWT header `kid`). */
  keyId: string;
  /** Apple team id (JWT `iss`). */
  teamId: string;
  /** App bundle id → `apns-topic` header. */
  bundleId: string;
  /** `.p8` ES256 private key, PEM. Secret — never logged. */
  privateKey: string;
  /** `true` → `api.push.apple.com`; false/undefined → `api.sandbox.push.apple.com`. */
  production?: boolean;
}

// ============================================================================
// Seed Bootstrap API Types (from architecture.md)
// ============================================================================

/**
 * A peer entry in a control network seed.
 * Contains connection information for a cadre peer.
 */
export interface SeedPeer {
  /** Peer ID (libp2p identity) */
  peerId: string;
  /** Multiaddrs for connecting to this peer */
  multiaddrs: string[];
  /** Whether this peer holds an owner key */
  isOwner: boolean;
  /** ed25519 public key (base64url) — present on owner peers for signerKey verification */
  publicKey?: string;
}

/**
 * Control network seed for bootstrapping new nodes.
 * Pre-populates a new node's cache to solve the cold-start problem:
 * new nodes need control data to validate connections, but can't get
 * data without connecting first.
 */
export interface ControlNetworkSeed {
  /** Party ID this seed belongs to */
  partyId: string;
  /** Known peers in the cadre */
  peers: SeedPeer[];
  /** Signature over the seed by an owner key */
  signature: string;
  /** The owner key that signed this seed */
  signerKey: string;
}

/**
 * Message sent from instigator to new node during seed delivery.
 * Delivered via /sereus/seed/1.0.0 libp2p protocol.
 */
export interface SeedMessage {
  /** Party ID for the cadre */
  partyId: string;
  /** Known peers in the cadre */
  peers: SeedPeer[];
  /** Signature by an owner key */
  signature: string;
  /** The owner key that signed this message */
  signerKey: string;
}

/**
 * Acknowledgment message from new node to instigator.
 */
export interface SeedAckMessage {
  /** Whether the seed was accepted */
  accepted: boolean;
  /** Reason for rejection (if not accepted) */
  reason?: string;
}

// ============================================================================
// Strand Wake (control-network push-wake protocol) — see strand-wake-protocol.ts
// ============================================================================

/**
 * Request sent over the control network's `WAKE_PROTOCOL` from a same-cadre peer
 * to a hibernating peer, asking it to bring a strand online and pull pending
 * activity. The receiver gates this on cadre membership before honoring it.
 */
export interface WakeRequest {
  /** The strand the sender knows has pending activity. */
  strandId: string;
  /** Optional cause hint, e.g. `"activity"` (a server saw new traffic) or `"manual"`. */
  reason?: string;
}

/**
 * Acknowledgment of a {@link WakeRequest}, returned on the same stream.
 */
export interface WakeAck {
  /** Whether the receiver honored the wake (member + participated strand). */
  accepted: boolean;
  /** The strand's status after the wake (present when `accepted`). */
  status?: StrandStatus;
  /** Reason for rejection (non-member, unknown strand, malformed frame). */
  reason?: string;
}

// ============================================================================
// Strand Address (control-network strand-address RPC) — see strand-addr-protocol.ts
// ============================================================================

/**
 * Control-network request from one of a party's own cadre nodes to a sibling,
 * asking "what are your live multiaddrs for this strand's separate network?".
 * Used to seed a strand mesh from co-cadre nodes that already run that strand.
 * The receiver gates this on cadre membership before answering.
 */
export interface StrandAddrRequest {
  /** The strand whose strand-network address the requester wants to seed from. */
  strandId: string;
  /**
   * The derived transport peerId the requester's own strand-`strandId` node
   * runs as (see `strand-transport-key.ts`). Present → the responder records a
   * delegate admission grant for it, so its own connection gate (and thus its
   * circuit-relay server, when it runs one) admits that peerId; absent →
   * today's behavior exactly. See `delegate-admission.ts` for the trust model.
   */
  delegatePeerId?: string;
}

/**
 * Response to a {@link StrandAddrRequest}, carrying the responder's strand-node
 * multiaddrs, returned on the same stream.
 */
export interface StrandAddrResponse {
  /** Echoes the requested strand id (empty on a reject/error reply). */
  strandId: string;
  /**
   * Dialable strand-network multiaddr strings (signaling/`p2p-circuit` first);
   * empty when the responder is a non-member, or does not currently run that
   * strand, or the exchange failed.
   */
  multiaddrs: string[];
}

/**
 * Options for authorizing a new peer in the cadre.
 */
export interface AuthorizePeerOptions {
  /** Peer ID to authorize */
  peerId: string;
  /** Optional multiaddrs for the peer */
  multiaddrs?: string[];
}

/**
 * Result of applying a seed to a node.
 */
export interface ApplySeedResult {
  /** Whether the seed was successfully applied */
  success: boolean;
  /** Number of peers added to the peer store */
  peersAdded: number;
  /** Error message if not successful */
  error?: string;
  /**
   * Owner-flagged seed peers this apply attempted to dial. Zero when the seed
   * carried no owner peer with an address, or when the seed was rejected before
   * the dial loop ran.
   */
  ownerDialsAttempted: number;
  /**
   * How many of those dials threw. `ownerDialsAttempted > 0 && ownerDialsFailed
   * === ownerDialsAttempted` means "seeded but stranded": the seed itself was
   * accepted (`success: true`) but no owner could be reached, so this node has
   * no connection to bootstrap its control database from. The node retries those
   * addresses on every control-cohort reconcile pass (see
   * `CadreNode.dialColdStartBootstrap`), so this is a signal, not a fatal error.
   *
   * Zero failures is NOT proof of a live connection: the receiving node's
   * membership gate denies AFTER the dialer's upgrade completes (see
   * `createMembershipConnectionGater`), so a dial can resolve and then be torn
   * down. Treat a non-zero value as certain failure and zero as "no failure
   * observed".
   */
  ownerDialsFailed: number;
}

// ============================================================================
// Seed Helper Types
// ============================================================================

/**
 * Node network topology type for seed helper scenarios.
 */
export type NodeTopology = 'public' | 'nat';

/**
 * Invite code for phone-to-server enrollment.
 * Used when a server invites a phone to join the cadre.
 */
export interface CadreInvite {
  /** Party ID of the cadre */
  partyId: string;
  /** Multiaddrs to dial the owner */
  ownerAddrs: string[];
  /**
   * Owner ed25519 public keys (base64url) of the cadre, carried out-of-band
   * so a cold-start invitee can pin the trusted owner set before applying
   * any seed (the seed itself cannot vouch for its own signer). Populated by
   * `createInvite` from the issuer's OWN node-local trusted-owner anchor —
   * not its replicated `OwnerKey` table, because the invitee anchors whatever
   * arrives here and a stranger's genesis-inserted key must not ride an
   * otherwise-legitimate invite into a fresh node's anchor.
   */
  ownerKeys?: string[];
  /** Optional invite token for validation */
  token?: string;
  /** Timestamp when invite was created */
  createdAt: number;
  /** Optional expiration timestamp */
  expiresAt?: number;
}

/**
 * Options for adding a drone via provider API.
 */
export interface AddDroneOptions {
  /** Peer ID of the new drone (returned from provider) */
  dronePeerId: string;
  /** Multiaddrs of the drone (returned from provider) */
  droneMultiaddrs: string[];
}

/**
 * Options for adding a phone via invite flow.
 */
export interface AddPhoneOptions {
  /** Peer ID of the phone (sent by phone when it connects) */
  phonePeerId: string;
  /** Invite token for validation (must match issued invite) */
  token?: string;
}

/**
 * Result of preparing a seed for drone initialization.
 */
export interface DroneInitResult {
  /** The seed to send to the provider API */
  seed: ControlNetworkSeed;
  /** Base64url encoded seed for transport */
  encodedSeed: string;
}

/**
 * Result of creating an invite for a phone.
 */
export interface InviteResult {
  /** The invite to share out-of-band */
  invite: CadreInvite;
  /** Base64url encoded invite for QR/link */
  encodedInvite: string;
}

