import type { ConnectionGater, Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
import type { IRawStorage, Libp2pTransports } from '@optimystic/db-p2p';
import type { IRepo } from '@optimystic/db-core';
import type { StrandDatabase } from './strand-database.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import type { KeyStore, KeyId } from './key-store.js';
import type { TrustedOwnerStore, TrustSource } from './trusted-owner-store.js';
import type { PushNotifier } from './push-notifier.js';

/**
 * Extended Libp2p node with the coordinatedRepo attached by db-p2p's
 * createLibp2pNode after node creation (not surfaced on the base Libp2p type).
 */
export interface Libp2pNodeWithRepo extends Libp2p {
  coordinatedRepo: IRepo;
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
 * Storage provider type - either an IRawStorage instance or a factory function.
 * Factory functions are useful for creating strand-specific storage instances.
 */
export type RawStorageProvider = IRawStorage | ((strandId: string) => IRawStorage);

/**
 * Storage configuration for storage profile nodes
 */
export interface StorageConfig {
  /**
   * Storage provider - either an IRawStorage instance or a factory function.
   *
   * For Node.js environments, use FileRawStorage from @optimystic/db-p2p-storage-fs:
   * ```typescript
   * import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
   * storage: { provider: (strandId) => new FileRawStorage(`./data/${strandId}`) }
   * ```
   *
   * For React Native, use the appropriate storage from @optimystic/db-p2p-storage-rn:
   * ```typescript
   * import { RNRawStorage } from '@optimystic/db-p2p-storage-rn';
   * storage: { provider: (strandId) => new RNRawStorage(strandId) }
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
  listenAddrs?: string[];
  announceAddrs?: string[];
  relayAddrs?: string[];
  /**
   * Enable circuit relay server - allows this node to relay connections for other peers.
   * When undefined, defaults to true for storage profile nodes (they typically have
   * better connectivity and uptime), false for transaction profile nodes.
   */
  enableRelay?: boolean;
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
   * Optional async resolver returning the multiaddrs to embed in invites
   * (and other owner-address contexts). When unset, `libp2pNode.getMultiaddrs()`
   * is used. Hosts behind NAT supply this to substitute their DDNS hostname
   * and externally-mapped port — see `@serfab/cadre-host`'s NatService.
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
   * either this gater or the membership policy denies. Strand cohort nodes
   * receive this gater as-is (their peers are legitimately cross-party).
   */
  connectionGater?: ConnectionGater;
  /**
   * Tuning for the proactive control-cohort dial routine
   * ({@link CadreNode.reconcileControlCohort}), which keeps a party's control
   * nodes connected so the `CadreControl` collections form a replicating cohort.
   * Both fields are optional; omit for the defaults
   * ({@link DEFAULT_CONTROL_COHORT_TARGET_DEGREE} /
   * {@link DEFAULT_CONTROL_COHORT_RECONCILE_MS}).
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
  };
}

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
 * Replication-breadth constants and the strand resolver, re-exported so cadre
 * embedders and the SQL plugin share one definition. Defined in
 * `@serfab/quereus-plugin-sereus` because that package also creates libp2p nodes
 * and cannot depend on this one. The control network's breadth is fixed
 * ({@link CONTROL_REPLICATION_BREADTH}, not configurable); the strand default is
 * {@link CadreNodeConfig.strandClusterSize}.
 */
export {
  MIN_CLUSTER_SIZE,
  CONTROL_REPLICATION_BREADTH,
  DEFAULT_STRAND_CLUSTER_SIZE,
  resolveStrandClusterSize
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
   * form). Mutually exclusive with {@link privateKey}. Absent ⇒ legacy behavior
   * (use `privateKey`, else libp2p generates an ephemeral key).
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
   * {@link DEFAULT_STRAND_CLUSTER_SIZE} (2); anything below
   * {@link MIN_CLUSTER_SIZE} is rejected before a node is created. The cost of a
   * small value is replication breadth and reliance on read repair, not commit
   * correctness.
   */
  strandClusterSize?: number;

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
     * persisted next to the identity key (same injection/isolation pattern as
     * {@link keyStore}). Its `partyId` must match `controlNetwork.partyId`;
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
 * Status of a strand instance
 */
export type StrandStatus = 
  | 'starting' 
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

  /** The libp2p node for this strand (only when active/idle) */
  libp2pNode?: Libp2p;

  /** The Quereus database for this strand (only when active/idle) */
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
 * Lifecycle mode for a strand.
 *
 * - `bootstrap`: newly created locally; no remote peers exist for this strand yet.
 *   Schema apply and data operations route through a local (non-network) transactor
 *   so a solo node can fully initialize without any peer round trips.
 * - `networked`: strand has (or is expected to have) remote peers. Operations route
 *   through the network transactor.
 *
 * Transition `bootstrap -> networked` happens at first remote-peer enrollment for
 * the strand; because the transactor is fixed at plugin registration time, the
 * transition requires stopping and restarting the strand.
 */
export type StrandMode = 'bootstrap' | 'networked';

/**
 * Full strand configuration when adding a strand via the API
 */
export interface StrandConfig {
  /** Strand row from control network */
  strandRow: StrandRow;
  /** sApp configuration provided by the hosting application */
  sAppConfig: SAppConfig;
  /**
   * Lifecycle mode for this strand instance. When omitted, CadreNode infers the
   * mode from cohort membership (`bootstrap` for a solo/first node with no other
   * `CadrePeer` rows, `networked` once the cohort has other members). An explicit
   * value always wins.
   */
  mode?: StrandMode;
  /**
   * Whether THIS node is the strand's founder — the party that provisioned and
   * published the strand (the responder in formation, the creator in host/solo
   * paths; the same party that calls {@link CadreNode.publishStrand}). The founder
   * runs the one-time membership bootstrap at bring-up (writes `Strand.Header`, and
   * for a closed strand the founding `Member`+`Manager`). A joiner leaves this
   * `false`/unset and writes nothing — it receives those rows via Optimystic sync.
   * Defaults to `false`.
   */
  founder?: boolean;
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
}

/**
 * Result of validating a strand formation request
 */
export interface ValidateFormationResult {
  /** Public key for validating this formation */
  validationKey: string;
  /** Signature over the formation approval */
  validationSignature: string;
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
   * Emitted when the control network advertises a strand this node has no
   * registered `sAppConfig` for — i.e. a strand created by another member. The
   * hosting app decides whether to join it (register a config + `addStrand`,
   * e.g. via a chat `joinChatStrand` helper). Carries the full {@link StrandRow}
   * so the app can join without re-querying the control DB.
   */
  'strand:discovered': { strandId: string; strand: StrandRow };
  'control:connected': void;
  'control:disconnected': void;
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
 * Outcome of {@link CadreNode.registerSelf}, surfaced so callers (e.g. the CLI
 * `--owner` branch) can log what happened:
 * - `inserted` — the first owner-signed INSERT of this node's `CadrePeer` row.
 * - `refreshed` — a self-signed UPDATE of an existing row (heartbeat / addr change).
 * - `skipped` — nothing written (no self-signing key, or not yet a member with no
 *   owner service to self-insert).
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

