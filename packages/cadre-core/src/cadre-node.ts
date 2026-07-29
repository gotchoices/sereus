import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { Libp2p, PeerId, PrivateKey, Connection } from '@libp2p/interface';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import { createLibp2pNode } from '@optimystic/db-p2p';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
import type {
  CadreNodeConfig,
  StrandInstance,
  StrandRow,
  StrandConfig,
  SAppConfig,
  CadreNodeEvents,
  ControlNetworkSeed,
  ApplySeedResult,
  AddDroneOptions,
  AddPhoneOptions,
  DroneInitResult,
  InviteResult,
  CadreInvite,
  OpenInvitation,
  FormStrandResult,
  StrandFormationDisclosure,
  StrandMode,
  ResolveOpts,
  SelfRegistrationOutcome,
  ServiceWakeResult,
  Libp2pNodeWithRepo,
  PushPlatform,
  DeviceTokenRecord,
  CadrePeerVoucherFields,
  ResolveDeviceTokenOpts
} from './types.js';
import { DEFAULT_CHECKIN_WINDOW_MS, resolveClusterSize } from './types.js';
import { sign } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate, type Ed25519KeyPair } from './ed25519-key.js';
import { DEFAULT_IDENTITY_KEY_ID } from './key-store.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore, type TrustSource } from './trusted-owner-store.js';
import { verifyCadrePeerVoucher } from './peer-authorization.js';
import { ed25519PublicKeyB64FromPeerId } from './seed-bootstrap.js';
import {
  signPeerRecord,
  verifyPeerRecordSignature,
  isPeerRecordFresh,
  orderSignalingFirst,
  isSignalingAddr,
  currentMemberTrustPolicy,
  DEFAULT_PEER_RECORD_MAX_AGE_MS,
  DEFAULT_PEER_RECORD_HEARTBEAT_MS
} from './peer-record.js';
import {
  signDeviceTokenRecord,
  verifyDeviceTokenSignature,
  isPushPlatform
} from './device-token.js';
import { StrandWatcher, type StrandQueryable, type SAppIdLookup } from './strand-watcher.js';
import { StrandInstanceManager } from './strand-instance-manager.js';
import { deriveCohortMembers, selectStrandMode, type CohortSeed } from './strand-cohort.js';
import type { CohortPeerRow } from './strand-cohort.js';
import {
  selectControlCohortDials,
  DEFAULT_CONTROL_COHORT_RECONCILE_MS,
  DEFAULT_CONTROL_COHORT_TARGET_DEGREE
} from './control-cohort.js';
import { EnrollmentService } from './enrollment.js';
import { HibernationManager, type HibernationCallbacks } from './hibernation-manager.js';
import { ControlDatabase } from './control-database.js';
import { SeedBootstrapService } from './seed-bootstrap.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import {
  StrandSolicitationService,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';
import { createMembershipConnectionGater, DEFAULT_ENROLLMENT_WINDOW_MS } from './membership-connection-gater.js';
import { StrandWakeService, dialWake } from './strand-wake-protocol.js';
import { StrandAddrService, collectStrandAddrs } from './strand-addr-protocol.js';
import { PushFanoutService } from './push-fanout.js';
import type { WakeAck, WakeRequest } from './types.js';
import {
  summarizeConnectionPaths,
  classifyTransport,
  type ConnectionPathSummary,
  type ConnectionLike
} from './diagnostics/connection-path.js';
import { TurnRelayTracker } from './diagnostics/webrtc-turn-tracker.js';

const log = debug('sereus:cadre:node');
const timing = debug('sereus:cadre:timing');

/**
 * Window (ms) within which a queued TURN-relay settlement is correlated to a
 * `connection:open`. Generous relative to the tight async gap between an
 * `RTCPeerConnection` reaching `connected` and libp2p surfacing the connection.
 */
const TURN_CONSUME_WINDOW_MS = 1000;

type EventHandler<T> = (data: T) => void;

/**
 * CadreNode is the main entry point for a cadre member.
 * It manages:
 * - Connection to the control network
 * - Watching for strand changes
 * - Starting/stopping strand instances
 * - Strand hibernation lifecycle
 * - Peer enrollment
 */
export class CadreNode implements SAppIdLookup {
  private readonly config: CadreNodeConfig;
  /**
   * The resolved node identity key, set once by {@link resolveIdentityKey}
   * during {@link start} (from `config.keyStore`, else `config.privateKey`).
   * Left undefined when neither is configured — libp2p then generates an
   * ephemeral key internally and there is no exposed owner key. Every
   * identity-dependent path (control node creation, self-record signing, strand
   * launch) reads this resolved field, never `config.privateKey` directly.
   */
  private identityKey: PrivateKey | undefined;
  /**
   * Node-local, NON-replicated trusted-owner anchor (see
   * `trusted-owner-store.ts`). Constructed (or adopted from
   * `config.trustedOwners.store`) by {@link initializeTrustedOwnerStore} during
   * {@link start}; deliberately NOT cleared by {@link cleanup}, so an in-memory
   * anchor survives a stop()→start() cycle of the same node instance. Never
   * sourced from replicated control state.
   */
  private trustedOwnerStore: TrustedOwnerStore | null = null;
  private controlNode: Libp2p | null = null;
  private controlDatabase: ControlDatabase | null = null;
  private strandWatcher: StrandWatcher | null = null;
  private strandManager: StrandInstanceManager;
  private hibernationManager: HibernationManager;
  private enrollmentService: EnrollmentService;
  private seedBootstrapService: SeedBootstrapService | null = null;
  private strandSolicitationService: StrandSolicitationService | null = null;
  private strandWakeService: StrandWakeService | null = null;
  /**
   * Control-network strand-address responder. Answers a co-cadre sibling's
   * on-demand request for this node's live strand-network multiaddrs so the
   * sibling can seed a strand mesh from us — the read side of the seed path that
   * stops conflating control addresses with strand seeding.
   */
  private strandAddrService: StrandAddrService | null = null;
  /**
   * Server-side push-wake fan-out. Constructed by {@link start} only when
   * `config.push` (an injected `PushNotifier` + policy) is present — without it
   * the node behaves exactly as before (no notifier, no fan-out). Owns who/when
   * to wake hibernating mobile peers on strand activity.
   */
  private pushFanoutService: PushFanoutService | null = null;
  /** Backing field for the {@link running} / {@link isRunning} getters. */
  private _running = false;
  /**
   * In-flight {@link serviceWake} operations keyed by strandId. Coalesces
   * concurrent on-demand wakes for the same strand into one runtime build + one
   * window + one re-hibernate decision (a second caller joins the first's
   * promise), complementing {@link HibernationManager}'s wake coalescing.
   */
  private serviceWakePromises: Map<string, Promise<ServiceWakeResult>> = new Map();
  /**
   * Live wake-window waiters (see {@link holdWakeWindow}). Tracked so
   * {@link cleanup} can clear the timer AND resolve the promise on teardown — a
   * window must never fire (or hang an in-flight serviceWake) after stop().
   */
  private windowWaiters: Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }> = new Set();
  private eventHandlers: Map<keyof CadreNodeEvents, Set<EventHandler<never>>> = new Map();

  /** Map of strandId -> sAppConfig for sAppId filtering and management */
  private sAppConfigs: Map<string, SAppConfig> = new Map();

  /**
   * Most-recently pushed invite addresses (see {@link setInviteAddresses}).
   * When non-null these take priority over `libp2pNode.getMultiaddrs()` when
   * minting invites — the host pushes NAT-resolved addresses here so the
   * control-network node never needs to dial back to the manager.
   */
  private latestInviteAddresses: string[] | null = null;

  /**
   * Epoch ms until which the control-network inbound gate admits
   * not-yet-authorized peers (see {@link admitInboundControlConnection} /
   * {@link openEnrollmentWindow}). 0 = no window open. Opened automatically by
   * {@link createInvite}; deliberately NOT reset on stop() — a stop/start cycle
   * inside an outstanding invite's validity must not strand the invitee.
   *
   * NOTE: in-memory only, so a PROCESS restart mid-invite closes the door until
   * the owner re-mints or the invitee is authorized. Fine while invites are
   * short-lived and redeemed promptly; if long-lived invites or restart-prone
   * hosts become normal, persist the window (or derive it from the issued-invite
   * records `SeedBootstrapService` already keeps).
   */
  private enrollmentWindowUntil = 0;

  /**
   * Lazily-parsed PeerIds of `controlNetwork.bootstrapNodes` (see
   * {@link getBootstrapPeerIds}) — infrastructure the inbound gate always admits.
   */
  private bootstrapPeerIds: Set<string> | null = null;

  /**
   * Materialized in-memory snapshot of the AUTHORIZED member peer ids (the
   * {@link listAuthorizedMembers} result), consulted by the per-stream
   * control-DB gate ({@link authorizeInboundControlStream}). That predicate
   * runs on EVERY inbound Optimystic control-DB stream and must never await a
   * control-DB read: those reads pull blocks over the very protocols the
   * predicate gates, which closes a circular wait that ends in mutual denial
   * (the upstream gate is fail-closed on timeout, unlike the fail-open
   * connection gater). So the set is refreshed OUT OF BAND instead — after
   * start, on every {@link reconcileControlCohort} pass (15s cadence), and
   * immediately after every LOCAL membership mutation so a just-vouched peer
   * is admitted without waiting for the timer. A change that arrives by
   * REPLICATION is picked up on the next timed refresh — bounded staleness,
   * acceptable because this gate is defense in depth: rows an unadmitted peer
   * manages to write are still disbelieved at read time by the
   * voucher-anchored predicate.
   */
  private authorizedControlPeers: Set<string> = new Set();

  /** Initial self-registration timer (see {@link scheduleSelfRegistration}). */
  private selfRegistrationTimer: ReturnType<typeof setTimeout> | null = null;
  /** TTL heartbeat that re-publishes the self record before it goes stale. */
  private recordRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Listener that re-publishes the self record when reachable addresses change. */
  private selfPeerUpdateHandler: (() => void) | null = null;
  /**
   * Recurring proactive control-cohort dial cadence (see
   * {@link reconcileControlCohort}). Wired alongside {@link recordRefreshTimer}
   * in {@link startRecordRefresh} and torn down symmetrically in
   * {@link stopRecordRefresh}; `.unref()`'d so it never keeps the loop alive.
   */
  private controlCohortReconcileTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Single-flight guard for {@link reconcileControlCohort}. The eager start pass,
   * the recurring interval, and the `self:peer:update` trigger can fire close
   * together; collapsing concurrent passes into one in-flight run prevents two
   * passes from double-dialing the same siblings (mirrors {@link registerSelfInFlight}).
   */
  private reconcileControlCohortInFlight: Promise<void> | null = null;
  /**
   * Single-flight guard for {@link registerSelf}. Concurrent callers (the explicit
   * CLI `--owner` publish, the 1s startup timer, the TTL heartbeat, and the
   * address-change listener) share one in-flight publish so two of them can never
   * both read "no row yet" and race a duplicate INSERT (a `CadrePeer` PK conflict).
   */
  private registerSelfInFlight: Promise<SelfRegistrationOutcome> | null = null;

  // ── Write-while-alone re-replication (control-write-ensure-replicated) ──────
  /**
   * Re-replication queue for owner control writes that committed while this
   * node was alone — `controlNode.getConnections().length === 0` at write time
   * means the Optimystic commit was local-only (the block's cluster was ≤1) and
   * never broadcast. Maps the affected subject peerId → the write to re-issue once
   * the cohort grows. A later op for the same subject overwrites an earlier one
   * (authorize then remove → remove wins). Drained on the 0→≥1 control-connection
   * transition by {@link drainPendingControlReplication}.
   */
  private pendingPeerWrites: Map<string, 'authorize' | 'remove'> = new Map();
  /** This node's own `CadrePeer` self-write committed local-only (re-touched on growth). */
  private pendingSelfPeerWrite = false;
  /** This node's own `DeviceToken` self-write committed local-only (re-touched on growth). */
  private pendingSelfDeviceWrite = false;
  /**
   * Guards the one-shot, first-cohort-growth reconstruction: an owner re-touches
   * every membership row it may have authored that could be unreplicated (covering
   * writes made before this process started, which the in-memory queue cannot know).
   * Set true after the first drain so later passes only drain the in-memory queue.
   */
  private reconstructedLocalOnlyWrites = false;
  /** Single-flight guard for the re-replication drain (mirrors {@link registerSelfInFlight}). */
  private drainControlReplicationInFlight: Promise<void> | null = null;
  /**
   * Tracks the control-connection presence edge so the drain fires only on the
   * 0→≥1 transition (the earliest point a re-issue can broadcast), not on every
   * subsequent `connection:open`. Re-armed to false once connections return to 0.
   */
  private hasControlConnection = false;
  /** `connection:open` listener driving the growth-triggered drain (teardown in {@link stopRecordRefresh}). */
  private controlConnectionOpenHandler: (() => void) | null = null;
  /** `connection:close` listener re-arming the growth edge (teardown in {@link stopRecordRefresh}). */
  private controlConnectionCloseHandler: (() => void) | null = null;

  // ── WebRTC TURN-relay detection (turn-relayed-path-metrics) ─────────────────
  /**
   * Hooks `globalThis.RTCPeerConnection` to observe whether ICE selected a TURN
   * relay candidate for each WebRTC session. Installed in {@link start}, disposed
   * in {@link cleanup}; inert on Node.js (no `RTCPeerConnection`).
   */
  private readonly turnTracker = new TurnRelayTracker();
  /**
   * Peer IDs whose current WebRTC connection was observed to be TURN-relayed.
   * Populated by {@link handleTurnConnectionOpen} (drains the tracker queue on a
   * `/webrtc` `connection:open`), cleared per-peer on `connection:close`. Read by
   * {@link getConnectionPaths} to promote `webrtc` → `webrtc-turn` (relayed).
   */
  private turnRelayedPeers: Set<string> = new Set();
  /** `connection:open` listener feeding TURN detection (teardown in {@link stopRecordRefresh}). */
  private turnConnectionOpenHandler: ((evt: CustomEvent<Connection>) => void) | null = null;
  /** `connection:close` listener clearing a peer's TURN flag (teardown in {@link stopRecordRefresh}). */
  private turnConnectionCloseHandler: ((evt: CustomEvent<Connection>) => void) | null = null;

  constructor(config: CadreNodeConfig) {
    this.config = config;
    this.strandManager = new StrandInstanceManager();
    this.enrollmentService = new EnrollmentService();

    // Create hibernation manager with callbacks
    const hibernationCallbacks: HibernationCallbacks = {
      onIdle: async (strandId) => this.handleStrandIdle(strandId),
      onHibernate: async (strandId) => this.handleStrandHibernate(strandId),
      onWake: async (strandId) => this.handleStrandWake(strandId),
      onCheckIn: async (strandId) => this.handleStrandCheckIn(strandId)
    };
    this.hibernationManager = new HibernationManager(
      config.hibernation ?? { enabled: false },
      hibernationCallbacks
    );

    log('CadreNode created for party: %s', config.controlNetwork.partyId);
  }

  /**
   * SAppIdLookup implementation - get sAppId for a strand
   */
  getSAppId(strandId: string): string | undefined {
    return this.sAppConfigs.get(strandId)?.id;
  }

  /**
   * Get the peer ID of this node (available after start)
   */
  get peerId(): PeerId | undefined {
    return this.controlNode?.peerId;
  }

  /**
   * The party ID this node serves (control-network identity).
   */
  get partyId(): string {
    return this.config.controlNetwork.partyId;
  }

  /**
   * Get the multiaddrs of this node (available after start)
   */
  getMultiaddrs(): string[] {
    if (!this.controlNode) return [];
    return this.controlNode.getMultiaddrs().map(ma => ma.toString());
  }

  /**
   * Check if the node is running
   */
  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Synchronous lifecycle snapshot for headless callers (a mobile
   * `BackgroundRunner` that boots in a background task and must *query* state
   * rather than subscribe to `control:connected`/`control:disconnected`).
   * Equivalent to {@link isRunning}.
   */
  get running(): boolean {
    return this._running;
  }

  /**
   * Synchronous readiness snapshot: whether the control network is currently
   * connected (the node is running and its control-network libp2p node is up).
   * Tracks the same edge the `control:connected`/`control:disconnected` events
   * announce, but pollable.
   */
  get controlConnected(): boolean {
    return this._running && this.controlNode !== null;
  }

  /**
   * Classify every open control-network connection as relayed
   * (`/p2p-circuit`) vs direct, tag its transport, and summarise counts plus a
   * stuck-on-relay condition. Pure, read-only snapshot over
   * `controlNode.getConnections()`. Returns an empty (all-zero) summary when
   * the node has not been started.
   *
   * @param settleWindowMs - grace period before a relayed connection with no
   *   direct sibling is considered stuck (default 10_000ms)
   */
  getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
    const conns = this.controlNode?.getConnections() ?? [];
    // Annotate each connection with the TURN-relay hint so a WebRTC session whose
    // ICE selected a TURN candidate classifies as relayed/webrtc-turn rather than
    // direct/webrtc (the multiaddr alone cannot reveal it).
    const annotated: ConnectionLike[] = conns.map((c) => ({
      remotePeer: c.remotePeer,
      remoteAddr: c.remoteAddr,
      direction: c.direction,
      timeline: c.timeline,
      turnRelayed: this.turnRelayedPeers.has(c.remotePeer.toString()),
    }));
    return summarizeConnectionPaths(annotated, settleWindowMs);
  }

  /**
   * Get all strand instances
   */
  getStrands(): Map<string, StrandInstance> {
    return this.strandManager.getInstances();
  }

  /**
   * Get a specific strand instance
   */
  getStrand(strandId: string): StrandInstance | undefined {
    return this.strandManager.getInstance(strandId);
  }

  /**
   * Get the enrollment service for adding new peers
   */
  getEnrollmentService(): EnrollmentService {
    return this.enrollmentService;
  }

  /**
   * Start the cadre node
   */
  async start(): Promise<void> {
    if (this._running) {
      log('CadreNode already running');
      return;
    }

    log('Starting CadreNode for party: %s', this.config.controlNetwork.partyId);

    try {
      const tTotal = performance.now();

      // Install the WebRTC TURN-relay tracker BEFORE any libp2p bring-up, so it
      // wraps globalThis.RTCPeerConnection before the control node can create one.
      // Inert on Node.js (no RTCPeerConnection); disposed in cleanup().
      this.turnTracker.install();

      // Resolve the node identity (keyStore | privateKey | ephemeral) BEFORE any
      // libp2p/network bring-up, so a misconfiguration or an access-denied secure
      // store fails closed before a node is created.
      await this.resolveIdentityKey();

      // Bring up the node-local trusted-owner anchor (and seed config pins)
      // before any network bring-up: a mis-scoped injected store fails closed
      // here, and out-of-band pins are anchored before the first seed/peer
      // interaction could consult them.
      await this.initializeTrustedOwnerStore();

      // Create the control network libp2p node
      let t0 = performance.now();
      this.controlNode = await this.createControlNode();
      timing('[start] createControlNode: %dms', Math.round(performance.now() - t0));
      log('Control node started with ID: %s', this.controlNode.peerId.toString());

      // Extract coordinatedRepo from the node (attached by createLibp2pNode)
      const coordinatedRepo = (this.controlNode as Libp2pNodeWithRepo).coordinatedRepo;
      if (!coordinatedRepo) {
        throw new Error('coordinatedRepo not available on control node');
      }

      // Initialize the control database with the libp2p node
      t0 = performance.now();
      this.controlDatabase = new ControlDatabase({
        partyId: this.config.controlNetwork.partyId,
        libp2pNode: this.controlNode,
        coordinatedRepo,
        schemaPath: this.config.controlNetwork.schemaPath,
      });
      await this.controlDatabase.initialize();
      timing('[start] controlDatabase.initialize: %dms', Math.round(performance.now() - t0));
      log('Control database initialized');

      // Create strand queryable using the control database
      const queryable = this.createStrandQueryable();

      // Create and start the strand watcher with sAppId lookup
      this.strandWatcher = new StrandWatcher(
        queryable,
        {
          onStrandAdded: async (strand) => this.handleStrandAdded(strand),
          onStrandRemoved: async (strandId) => this.handleStrandRemoved(strandId)
        },
        this.config.strandFilter ?? { mode: 'all' },
        this.config.strandWatchInterval ?? 5000,
        this // CadreNode implements SAppIdLookup
      );

      t0 = performance.now();
      await this.strandWatcher.start();
      timing('[start] strandWatcher.start: %dms', Math.round(performance.now() - t0));

      // Start hibernation manager
      this.hibernationManager.start();

      // Register the control-network push-wake receiver: a same-cadre peer can
      // signal us to bring a hibernating strand online. Gated on AUTHORIZED
      // membership (not the addressable surface); the wake routes through the same
      // path as a local wake.
      this.strandWakeService = new StrandWakeService({
        isMember: (peerId) => this.isAuthorizedMember(peerId),
        getStrand: (strandId) => this.strandManager.getInstance(strandId),
        wake: (strandId) => this.wakeStrand(strandId),
      });
      this.strandWakeService.initialize(this.controlNode);

      // Register the control-network strand-address responder: a same-cadre peer
      // resolving a strand's bootstrap seed asks us for our live strand-network
      // multiaddrs (its CadrePeer row only knows our *control* address). Gated on
      // AUTHORIZED membership; answers only for strands we are actively meshing.
      this.strandAddrService = new StrandAddrService({
        isMember: (peerId) => this.isAuthorizedMember(peerId),
        getStrandMultiaddrs: (strandId) => this.getStrandMultiaddrs(strandId),
      });
      this.strandAddrService.initialize(this.controlNode);

      // Server-side push-wake fan-out: only when push is configured.
      if (this.config.push) {
        this.pushFanoutService = this.buildPushFanout(this.config.push);
        log('Push-wake fan-out enabled (injected notifier)');
      }

      this._running = true;
      this.emit('control:connected', undefined);
      timing('[start] total: %dms', Math.round(performance.now() - tTotal));
      log('CadreNode started successfully');

      // Wire the control-connection growth listeners immediately (not via the
      // delayed refresh path) so no early `connection:open` is missed — the
      // write-while-alone re-replication drain must fire on the first 0→≥1 edge.
      this.wireControlConnectionListeners();

      // Seed the per-stream gate's materialized authorized set now that the
      // control DB is up (non-blocking; the helper never rejects). Until it
      // lands the snapshot is empty, which the stream gate treats as cold
      // start and admits.
      void this.refreshAuthorizedControlPeers('start');

      // Schedule self-registration in background
      this.scheduleSelfRegistration();

    } catch (error) {
      log('Failed to start CadreNode: %o', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Build the server-side push-wake fan-out over an injected {@link PushNotifier}.
   *
   * The notifier reaches for `node:http2`/`node:crypto`, so the cross-platform
   * core never constructs it — the Node host builds it from
   * `@serfab/cadre-core/push-node` and passes the instance in
   * `CadreNodeConfig.push`. This node owns that instance's lifecycle from here:
   * {@link cleanup} closes the fan-out, which closes the notifier (freeing the
   * APNs HTTP/2 session). Every other primitive the fan-out needs (member
   * enumeration, participation, direct dial, token resolve/expire) is an
   * import-clean closure over this node.
   */
  private buildPushFanout(push: NonNullable<CadreNodeConfig['push']>): PushFanoutService {
    return new PushFanoutService({
      listMembers: () => this.listMembers(),
      getStrand: (strandId) => this.strandManager.getInstance(strandId),
      selfPeerId: () => this.controlNode?.peerId.toString(),
      pushWake: (peerId, strandId, reason) => this.pushWake(peerId, strandId, reason),
      resolveDeviceToken: (peerId) => this.resolveDeviceToken(peerId),
      expireDeviceToken: (peerId) => this.expireDeviceToken(peerId),
      notifier: push.notifier,
      cooldownMs: push.cooldownMs,
      debounceMs: push.debounceMs,
    });
  }

  /**
   * Stop the cadre node
   */
  async stop(): Promise<void> {
    if (!this._running) {
      log('CadreNode not running');
      return;
    }

    log('Stopping CadreNode');
    await this.cleanup();
    this._running = false;
    this.emit('control:disconnected', undefined);
    log('CadreNode stopped');
  }

  /**
   * Subscribe to events
   */
  on<K extends keyof CadreNodeEvents>(
    event: K, 
    handler: EventHandler<CadreNodeEvents[K]>
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from events
   */
  off<K extends keyof CadreNodeEvents>(
    event: K, 
    handler: EventHandler<CadreNodeEvents[K]>
  ): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit<K extends keyof CadreNodeEvents>(
    event: K, 
    data: CadreNodeEvents[K]
  ): void {
    this.eventHandlers.get(event)?.forEach(handler => {
      try {
        (handler as EventHandler<CadreNodeEvents[K]>)(data);
      } catch (e) { log('Event handler error: %o', e); }
    });
  }

  /**
   * Resolve the node identity into {@link identityKey} exactly once, fail-closed,
   * before any network bring-up. Resolution order:
   *
   * 1. Both `keyStore` and `privateKey` set ⇒ configuration error (throws).
   * 2. `keyStore` set ⇒ load protobuf bytes from `identityKeyId` (default
   *    {@link DEFAULT_IDENTITY_KEY_ID}). Found ⇒ deserialize; empty ⇒ generate a
   *    fresh Ed25519 key, persist it, and use it. A rejected `get` (access denied
   *    / backend failure) PROPAGATES — we never generate a new key on a read
   *    error, which would silently orphan the real identity.
   * 3. `privateKey` set ⇒ use it directly.
   * 4. Neither ⇒ leave undefined; libp2p generates an ephemeral key.
   *
   * Idempotent: a second call (or a stop()→start() cycle) reuses the already
   * resolved key rather than regenerating or re-persisting.
   */
  private async resolveIdentityKey(): Promise<void> {
    if (this.identityKey) {
      return;
    }
    const { keyStore, privateKey, identityKeyId } = this.config;

    if (keyStore && privateKey) {
      throw new Error(
        'CadreNodeConfig: `keyStore` and `privateKey` are mutually exclusive — ' +
        'configure at most one source for the node identity'
      );
    }

    if (keyStore) {
      const keyId = identityKeyId ?? DEFAULT_IDENTITY_KEY_ID;
      // A rejection here (e.g. KeyStoreAccessError) must propagate — do NOT fall
      // through to generation, which would orphan an existing but unreadable key.
      const bytes = await keyStore.get(keyId);
      if (bytes) {
        // Corrupt/garbage bytes throw here; surface loudly rather than
        // regenerating (which would orphan the real identity).
        this.identityKey = privateKeyFromProtobuf(bytes);
        log('Identity key loaded from key store (slot present)');
        return;
      }
      const generated = await generateKeyPair('Ed25519');
      await keyStore.set(keyId, privateKeyToProtobuf(generated));
      this.identityKey = generated;
      log('Identity key generated and persisted to key store (first run)');
      return;
    }

    if (privateKey) {
      this.identityKey = privateKey;
      return;
    }
    // Neither configured: libp2p generates an ephemeral key internally.
  }

  /**
   * Construct (or adopt) the node-local trusted-owner anchor and seed the
   * out-of-band pinned keys from `config.trustedOwners`. The store is NEVER
   * sourced from the replicated control DB — its entries come only from
   * genesis self-trust ({@link initializeSeedBootstrap}), config pins (here),
   * or runtime enrollment pins ({@link trustOwnerKeys}).
   *
   * Idempotent across stop()→start(): the store instance is kept, and
   * re-seeding config pins is a no-op ({@link TrustedOwnerStore.trust} is
   * idempotent). An injected store scoped to a different party is a
   * configuration error (fail closed before any network bring-up).
   */
  private async initializeTrustedOwnerStore(): Promise<void> {
    const { trustedOwners } = this.config;
    const partyId = this.config.controlNetwork.partyId;
    if (!this.trustedOwnerStore) {
      const store = trustedOwners?.store ?? new MemoryTrustedOwnerStore(partyId);
      if (store.partyId !== partyId) {
        throw new Error(
          `CadreNodeConfig: trustedOwners.store is scoped to party ${store.partyId}, ` +
          `but this node serves party ${partyId} — refusing to mix trust anchors`
        );
      }
      this.trustedOwnerStore = store;
    }
    for (const key of trustedOwners?.pinnedKeys ?? []) {
      await this.trustedOwnerStore.trust(key, trustedOwners?.pinnedSource ?? 'operator');
    }
  }

  /**
   * The node-local trusted-owner anchor (null before {@link start}). This is
   * the set the authorized-membership predicate and seed-trust anchor consult —
   * never the replicated `OwnerKey` table, which any stranger can pollute.
   */
  getTrustedOwnerStore(): TrustedOwnerStore | null {
    return this.trustedOwnerStore;
  }

  /**
   * Persist out-of-band-established owner keys into the node-local anchor —
   * the runtime enrollment seam: call with `CadreInvite.ownerKeys` when
   * redeeming an invite (BEFORE the first `applySeed`, so the anchor already
   * holds the pins when seed trust consults it), or with an operator-supplied
   * pin. Idempotent. ('genesis' provenance is reserved for the node's own
   * founding key, seeded internally by {@link initializeSeedBootstrap}.)
   */
  async trustOwnerKeys(keys: Iterable<string>, source: Exclude<TrustSource, 'genesis'>): Promise<void> {
    if (!this.trustedOwnerStore) {
      throw new Error('CadreNode must be started before trusting owner keys');
    }
    for (const key of keys) {
      await this.trustedOwnerStore.trust(key, source);
    }
  }

  private async createControlNode(): Promise<Libp2p> {
    const { controlNetwork, network, storage, profile } = this.config;
    const identityKey = this.identityKey;

    // Determine relay mode: if explicitly set in config, use that;
    // otherwise default to true for storage profile nodes (better connectivity/uptime)
    const enableRelay = network?.enableRelay ?? (profile === 'storage');

    // Create storage provider for control network
    // Uses the factory function pattern if provided to create control-network-specific storage
    const controlStorageProvider = storage?.provider
      ? (typeof storage.provider === 'function'
          ? storage.provider('control')
          : storage.provider)
      : undefined;

    const nodeOptions: Parameters<typeof createLibp2pNode>[0] = {
      port: 0,
      bootstrapNodes: controlNetwork.bootstrapNodes,
      networkName: `control-${controlNetwork.partyId}`,
      storage: controlStorageProvider,
      fretProfile: profile === 'storage' ? 'core' : 'edge',
      relay: enableRelay,
      clusterSize: resolveClusterSize(this.config.clusterSize),
      clusterPolicy: { allowDownsize: true, sizeTolerance: 0.5 },
      arachnode: { enableRingZulu: this.config.profile === 'storage' },
      ...(identityKey && { privateKey: identityKey }),
      ...(network?.transports && { transports: network.transports }),
      ...(network?.listenAddrs && { listenAddrs: network.listenAddrs }),
      // The CONTROL node composes the membership admission gate onto any
      // caller-supplied gater (deny from either wins on inbound; all other
      // hooks pass through). Strand cohort nodes keep the raw configured gater
      // (see strand-instance-manager.ts) — their peers are legitimately
      // cross-party, so cadre membership must not gate them.
      connectionGater: createMembershipConnectionGater(
        { admitInbound: (remotePeerId) => this.admitInboundControlConnection(remotePeerId) },
        network?.connectionGater
      ),
      // Fail-closed per-stream authorization for the four Optimystic control-DB
      // protocols — the members-only layer the connection gater's stranger
      // carve-outs cannot express (see authorizeInboundControlStream). Control
      // node only: strand cohort nodes serve cross-party peers.
      authorizeInboundStream: (remotePeerId, protocol) =>
        this.authorizeInboundControlStream(remotePeerId, protocol)
    };

    return await createLibp2pNode(nodeOptions);
  }

  /**
   * Decide whether an inbound CONTROL-network connection from `remotePeerId`
   * should be admitted — the policy behind the connection gater wired in
   * {@link createControlNode}. Deny only on a positive "unauthorized outsider
   * while no stranger path is open" determination; everything ambiguous admits
   * and defers to the fail-closed per-stream gates (see
   * `membership-connection-gater.ts` for the layer's rationale and the
   * stranger-open protocol allowlist).
   *
   * Admits when ANY of:
   *  1. a shared-baseline check admits ({@link admitControlPeerUnconditionally}
   *     — not running / DB torn down, absent-or-empty trusted-owner anchor, or
   *     configured bootstrap/relay infrastructure);
   *  2. an enrollment window is open ({@link openEnrollmentWindow}, opened by
   *     {@link createInvite}) — the invitee dials in before it is authorized;
   *  3. the authorized-member set is empty — cold start: the rows that would
   *     authorize anyone arrive by replication over these very connections;
   *  4. the peer IS an authorized member; or
   *  5. an open invitation is OUTSTANDING — at least one unexpired,
   *     not-fully-consumed invitation this node minted or persisted (see
   *     `StrandSolicitationService.hasOutstandingInvitation`). A formation
   *     initiator is another party's peer by design and its token is only
   *     checkable inside the protocol, so the gate asks the coarser question
   *     "does this node expect a stranger at all?". Merely REGISTERING the
   *     responder ({@link initializeStrandSolicitation}) no longer suspends
   *     stranger denial — eager registration (as `reference-app-rn` does at
   *     bring-up) and `formStrand`'s lazy initialization both leave the gate
   *     armed, because neither mints an invitation.
   *
   * Ordering is semantically free (the checks are OR'd) but decides who pays:
   * checks 1-2 are in-memory, 3/4 share one control-DB read, and only a peer
   * already on the deny path reaches check 5's invitation lookup.
   *
   * Caveats of check 5, both self-healing:
   *  - the in-memory mint registry dies with the process, so after a restart
   *    only invitations persisted as `FormationInvite` rows still hold the
   *    exemption open (re-mint otherwise — same story as the enrollment window);
   *  - a peer holding a token whose `FormationInvite` row has not replicated to
   *    this node yet is denied even though the formation handler would have
   *    accepted it, exactly like the unreplicated-membership-row case below.
   *
   * NOTE: check 3/4 runs a control-DB read per inbound connection
   * (`listAuthorizedMembers`); connections are rare and cadres small, and this
   * layer is fail-open behind `ADMISSION_DECISION_TIMEOUT_MS`, so the live
   * read is safe here — unlike the per-stream gate, which must consult the
   * materialized {@link authorizedControlPeers} snapshot instead.
   * NOTE: a sibling whose membership row has not yet replicated to
   * this node is denied until the row converges (typically via the owner);
   * either side's next outbound reconcile dial (outbound is never gated)
   * re-establishes the link — self-healing, but visible as a transient deny.
   */
  private async admitInboundControlConnection(remotePeerId: string): Promise<boolean> {
    if (this.admitControlPeerUnconditionally(remotePeerId)) {
      return true;
    }
    if (Date.now() < this.enrollmentWindowUntil) {
      return true;
    }
    const authorized = await this.listAuthorizedMembers();
    if (authorized.length === 0) {
      return true;
    }
    if (authorized.some((m) => m.peerId === remotePeerId)) {
      return true;
    }
    try {
      if (await this.strandSolicitationService?.hasOutstandingInvitation()) {
        return true;
      }
    } catch (error) {
      log('admitInboundControlConnection: outstanding-invitation check threw for %s — admitting (fail-open): %o', remotePeerId, error);
      return true;
    }
    log('admitInboundControlConnection: DENYING inbound from %s — not an authorized member and no enrollment path open', remotePeerId);
    return false;
  }

  /**
   * Hold the control-network inbound gate open for not-yet-authorized peers
   * until `untilEpochMs` (extends, never shrinks, an already-open window).
   * {@link createInvite} calls this automatically; a host running an
   * out-of-band enrollment flow (e.g. accepting a phone whose invite this node
   * never minted) can open it explicitly before the stranger dials in.
   */
  openEnrollmentWindow(untilEpochMs: number): void {
    this.enrollmentWindowUntil = Math.max(this.enrollmentWindowUntil, untilEpochMs);
    log('Enrollment window open until %d', this.enrollmentWindowUntil);
  }

  /**
   * The admission checks SHARED by the connection gate
   * ({@link admitInboundControlConnection}) and the per-stream control-DB gate
   * ({@link authorizeInboundControlStream}) — factored so the two layers cannot
   * drift. All in-memory and cheap (the stream gate runs this per inbound
   * stream). Returns true when the peer must be admitted BEFORE any membership
   * source is consulted:
   *  - the node is not fully up (`start()` in progress / DB torn down) — both
   *    gates exist from libp2p bring-up, before the control DB does;
   *  - the trusted-owner anchor is absent or empty — an un-enrolled node has
   *    no basis to judge anyone and MUST accept its enrollment seed;
   *  - the peer is one of the configured control bootstrap/relay nodes —
   *    operator-configured infrastructure, not cadre members.
   * False only means "no unconditional admit": the caller then judges the peer
   * against its own membership source (a live DB read for the fail-open
   * connection gate; the materialized snapshot for the fail-closed stream gate).
   */
  private admitControlPeerUnconditionally(remotePeerId: string): boolean {
    if (!this._running || !this.controlDatabase) {
      return true;
    }
    if (!this.trustedOwnerStore || this.trustedOwnerStore.all().size === 0) {
      return true;
    }
    return this.getBootstrapPeerIds().has(remotePeerId);
  }

  /**
   * Per-stream authorization for the four Optimystic control-DB protocols
   * (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`),
   * wired as `authorizeInboundStream` in {@link createControlNode} — the
   * fail-closed layer behind the fail-open connection gater. Control node
   * ONLY: strand cohort nodes legitimately serve cross-party peers.
   *
   * The STRICT SUBSET of {@link admitInboundControlConnection}: the same
   * "no basis to judge" admissions (shared via
   * {@link admitControlPeerUnconditionally}), minus the two stranger
   * carve-outs (enrollment window, outstanding open invitation). Those exist
   * so a stranger can reach `/sereus/seed/1.0.0` and `/sereus/formation/1.0.0`
   * — neither is gated here, and admitting a stranger to `repo` during an
   * enrollment window is exactly the hole this gate closes.
   *
   * Admits when ANY of:
   *  1. a shared-baseline check admits (not running / no DB, empty anchor,
   *     configured bootstrap infra);
   *  2. the materialized authorized set is empty — cold start, before the
   *     rows that would authorize anyone have replicated in;
   *  3. the peer IS in the materialized authorized set.
   *
   * Deliberately SYNCHRONOUS and pure in-memory — see
   * {@link authorizedControlPeers} for why a control-DB read here would
   * deadlock into mutual denial. With a sync predicate the upstream deadline
   * (`authorizeInboundStreamTimeoutMs`) never trips, so it stays at its
   * default.
   */
  private authorizeInboundControlStream(remotePeerId: string, protocol: string): boolean {
    if (this.admitControlPeerUnconditionally(remotePeerId)) {
      return true;
    }
    if (this.authorizedControlPeers.size === 0) {
      return true;
    }
    if (this.authorizedControlPeers.has(remotePeerId)) {
      return true;
    }
    // Upstream logs its own denial line; this one carries the WHY.
    log('authorizeInboundControlStream: DENYING %s on %s — not in the materialized authorized set (%d member(s))',
      remotePeerId, protocol, this.authorizedControlPeers.size);
    return false;
  }

  /**
   * Refresh {@link authorizedControlPeers} from the control DB, best-effort: a
   * failed read keeps the previous snapshot (never clears it), so a transient
   * DB error can neither flip the stream gate's cold-start carve-out back open
   * nor drop a legitimate member mid-flight. Never rejects.
   */
  private async refreshAuthorizedControlPeers(reason: string): Promise<void> {
    if (!this._running || !this.controlDatabase) {
      return;
    }
    try {
      const members = await this.listAuthorizedMembers();
      this.authorizedControlPeers = new Set(members.map((m) => m.peerId));
      log('refreshAuthorizedControlPeers(%s): %d authorized peer(s)', reason, this.authorizedControlPeers.size);
    } catch (error) {
      log('refreshAuthorizedControlPeers(%s) failed — keeping previous snapshot: %o', reason, error);
    }
  }

  /**
   * PeerIds of the configured control bootstrap nodes (relay/bootstrap
   * infrastructure — always admitted inbound). Parsed once, lazily; an
   * address without a `/p2p/<id>` component contributes nothing.
   */
  private getBootstrapPeerIds(): Set<string> {
    if (!this.bootstrapPeerIds) {
      const ids = new Set<string>();
      for (const addr of this.config.controlNetwork.bootstrapNodes) {
        try {
          // Last `/p2p/<id>` component: on a plain bootstrap addr the node's own
          // id; on a circuit addr the dial target (which is what gets admitted).
          let id: string | undefined;
          for (const component of multiaddr(addr).getComponents()) {
            if (component.name === 'p2p' && component.value) {
              id = component.value;
            }
          }
          if (id) {
            ids.add(id);
          }
        } catch (error) {
          log('getBootstrapPeerIds: skipping unparsable bootstrap addr %s: %o', addr, error);
        }
      }
      this.bootstrapPeerIds = ids;
    }
    return this.bootstrapPeerIds;
  }

  private createStrandQueryable(): StrandQueryable {
    return {
      queryStrands: async (): Promise<StrandRow[]> => {
        if (!this.controlDatabase) {
          log('Control database not initialized, returning empty strands');
          return [];
        }
        log('Querying strands from control database');
        return await this.controlDatabase.queryStrands();
      }
    };
  }

  /**
   * Schedule the node's initial self-record publish + ongoing refresh shortly
   * after start (non-blocking). {@link registerSelf} is idempotent and safely
   * no-ops when it cannot yet sign/insert (e.g. owner key not installed),
   * so the timer is harmless even when registration only becomes possible later.
   */
  private scheduleSelfRegistration(): void {
    this.selfRegistrationTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.registerSelf();
        } catch (error) {
          // Background task — a failed publish must not crash the node.
          log('Self-registration failed: %o', error);
        }
        // Wire the ongoing refresh + control-cohort reconcile cadence, then run
        // an eager reconcile pass once the node has settled (the recurring
        // interval was just armed inside startRecordRefresh).
        this.startRecordRefresh();
        void this.reconcileControlCohort().catch((error) =>
          log('Control-cohort reconcile (start) failed: %o', error));
      })();
    }, 1000); // Small delay to ensure node is fully started
    // Node-only: don't keep the event loop alive solely for this timer.
    (this.selfRegistrationTimer as { unref?: () => void } | null)?.unref?.();
  }

  /**
   * Publish (or refresh) this node's own signed `CadrePeer` address record so
   * other members can resolve its current signaling/relay multiaddrs from its
   * PeerId alone. Public, awaitable, and idempotent.
   *
   * - Builds a `PeerAddressRecord` from the node's current dialable addrs
   *   (signaling/`p2p-circuit` first), signed with the ed25519 key behind its
   *   PeerId (the resolved node identity from `keyStore`/`config.privateKey`).
   * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt`.
   * - If not, and the node is its own owner: an owner-signed INSERT that
   *   also carries the self-signature.
   * - Otherwise: logs and returns (a non-owner node with no row yet must
   *   wait for an owner to insert it; it can then self-refresh).
   *
   * Safe to call repeatedly (heartbeat / address-change driven); each successful
   * publish strictly increases `UpdatedAt`. Concurrent calls are collapsed into a
   * single in-flight publish (see {@link registerSelfInFlight}) so the explicit
   * startup publish and the background timers can never race a duplicate INSERT.
   *
   * @returns what the publish did — `inserted`, `refreshed`, or `skipped`.
   */
  async registerSelf(): Promise<SelfRegistrationOutcome> {
    // Join an in-flight publish rather than starting a second one. Without this,
    // the explicit CLI call and the 1s timer could both observe "no row yet" and
    // both attempt the INSERT — the loser hits a CadrePeer PK conflict.
    if (this.registerSelfInFlight) {
      return this.registerSelfInFlight;
    }
    const op = this.publishSelfRecord();
    this.registerSelfInFlight = op;
    try {
      return await op;
    } finally {
      this.registerSelfInFlight = null;
    }
  }

  /** The body of {@link registerSelf}; serialised by its single-flight guard. */
  private async publishSelfRecord(): Promise<SelfRegistrationOutcome> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      log('Cannot register self - node or database not initialized');
      return 'skipped';
    }

    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      log('registerSelf: no self-signing key available (node identity unavailable or not matching peerId); skipping');
      return 'skipped';
    }

    const peerId = this.controlNode.peerId.toString();
    const addrs = await this.collectSelfAddrs();
    const existing = await this.controlDatabase.queryPeerRecord(peerId);

    // Strictly increase UpdatedAt even on a same-millisecond re-publish.
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const record = signPeerRecord(
      { peerId, publicKey: signingKey.publicKeyB64, addrs, updatedAt },
      signingKey.privateKeyB64
    );

    if (existing) {
      await this.controlDatabase.updateSelfPeerRecord(record);
      if (this.committedAlone()) this.pendingSelfPeerWrite = true;
      log('registerSelf: refreshed own CadrePeer record (updatedAt=%d, %d addrs)', updatedAt, addrs.length);
      return 'refreshed';
    }
    if (this.seedBootstrapService) {
      // First-time row: requires an owner signature (the node is its own
      // owner). insertSelfPeerRecord throws if no owner key is present.
      await this.seedBootstrapService.insertSelfPeerRecord(record);
      if (this.committedAlone()) this.pendingSelfPeerWrite = true;
      await this.refreshAuthorizedControlPeers('self-insert');
      log('registerSelf: inserted own CadrePeer record (owner-signed, updatedAt=%d, %d addrs)', updatedAt, addrs.length);
      return 'inserted';
    }
    log('registerSelf: not yet a CadrePeer member and no owner service to self-insert; skipping (an owner must add this peer first)');
    return 'skipped';
  }

  /**
   * The ed25519 keypair (base64url) the node signs its own record with — the key
   * behind its libp2p PeerId. Sourced from the resolved {@link identityKey}
   * (which a `keyStore` or `config.privateKey` supplies); returns null when
   * absent (ephemeral identity) or (defensively) when it does not match the
   * control node's PeerId, in which case self-publish is skipped rather than
   * producing an unresolvable row.
   */
  private getSelfSigningKey(): { privateKeyB64: string; publicKeyB64: string } | null {
    const peerId = this.controlNode?.peerId.toString();
    if (!peerId || !this.identityKey) {
      return null;
    }
    try {
      const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(this.identityKey);
      if (publicKeyB64 === ed25519PublicKeyB64FromPeerId(peerId)) {
        return { privateKeyB64, publicKeyB64 };
      }
      log('getSelfSigningKey: resolved identity key does not match control node peerId; cannot self-sign');
    } catch (error) {
      // Logs the error shape only; ed25519KeyPairFromLibp2p never embeds key material.
      log('getSelfSigningKey: failed to derive ed25519 key from identity key: %o', error);
    }
    return null;
  }

  /**
   * The owner keypair (base64url Ed25519) derived from this node's resolved
   * identity key. In the single-key reference model the owner signing key is
   * *derived from* the node identity (see {@link ed25519KeyPairFromLibp2p}), so the
   * same key material protected in a secure enclave backs both.
   *
   * Exposed so the hosting app retains control of owner genesis: cadre-core
   * resolves + protects the identity, then the app sources this pair to drive
   * `ensureOwnerKey(pub)` + `initializeSeedBootstrap(priv)` itself — cadre-core
   * never silently runs genesis. A future separate-owner slot would return a
   * distinct key here instead of the identity-derived one.
   *
   * @returns The base64url seed/public-key owner pair.
   * @throws If called before {@link start} has resolved the identity, or when the
   *   node runs on an ephemeral libp2p key (no `keyStore`/`privateKey` configured),
   *   since that key is internal to libp2p and not exposed.
   */
  getIdentityOwnerKey(): Ed25519KeyPair {
    if (!this.identityKey) {
      throw new Error(
        'getIdentityOwnerKey: node identity not resolved — call start() first, and ' +
        'configure `keyStore` or `privateKey` (an ephemeral libp2p identity exposes no owner key)'
      );
    }
    return ed25519KeyPairFromLibp2p(this.identityKey);
  }

  /**
   * Collect this node's current dialable addresses for publication, signaling
   * (`/p2p-circuit`) first. Prefers the best invite/NAT-resolved set and folds
   * in the relay/signaling address (the WebRTC dial input) when not already
   * present.
   */
  private async collectSelfAddrs(): Promise<string[]> {
    const resolved = await this.resolveInviteAddresses();
    const relay = await this.getRelayAddress();
    const merged = relay && !resolved.includes(relay) ? [...resolved, relay] : resolved;
    return orderSignalingFirst([...new Set(merged)]);
  }

  /**
   * Wire the ongoing self-record refresh: re-publish whenever libp2p reports an
   * address change (relay reservation rotation, NAT change) and on a TTL
   * heartbeat at half the freshness ceiling. Idempotent — repeated calls do not
   * stack listeners/timers.
   */
  private startRecordRefresh(): void {
    if (!this.controlNode || this.recordRefreshTimer) {
      return;
    }

    const republish = (reason: string) => {
      void this.registerSelf().catch((error) => log('Record refresh (%s) failed: %o', reason, error));
    };
    const reconcile = (reason: string) => {
      void this.reconcileControlCohort().catch((error) =>
        log('Control-cohort reconcile (%s) failed: %o', reason, error));
    };

    // Address churn re-publishes the self record AND re-checks the control cohort:
    // a relay-reservation rotation / NAT change can drop a sibling connection, so
    // the next pass should re-observe and re-dial it.
    this.selfPeerUpdateHandler = () => {
      republish('self:peer:update');
      reconcile('self:peer:update');
    };
    this.controlNode.addEventListener('self:peer:update', this.selfPeerUpdateHandler);

    this.recordRefreshTimer = setInterval(() => republish('heartbeat'), DEFAULT_PEER_RECORD_HEARTBEAT_MS);
    (this.recordRefreshTimer as { unref?: () => void } | null)?.unref?.();

    const reconcileMs = this.config.network?.controlCohort?.reconcileMs ?? DEFAULT_CONTROL_COHORT_RECONCILE_MS;
    this.controlCohortReconcileTimer = setInterval(() => reconcile('interval'), reconcileMs);
    (this.controlCohortReconcileTimer as { unref?: () => void } | null)?.unref?.();

    log('Record refresh wired (heartbeat=%dms, cohortReconcile=%dms)',
      DEFAULT_PEER_RECORD_HEARTBEAT_MS, reconcileMs);
  }

  /** Tear down the self-record refresh timers + listener (see {@link cleanup}). */
  private stopRecordRefresh(): void {
    if (this.selfRegistrationTimer) {
      clearTimeout(this.selfRegistrationTimer);
      this.selfRegistrationTimer = null;
    }
    if (this.recordRefreshTimer) {
      clearInterval(this.recordRefreshTimer);
      this.recordRefreshTimer = null;
    }
    if (this.controlCohortReconcileTimer) {
      clearInterval(this.controlCohortReconcileTimer);
      this.controlCohortReconcileTimer = null;
    }
    if (this.controlNode) {
      if (this.selfPeerUpdateHandler) {
        this.controlNode.removeEventListener('self:peer:update', this.selfPeerUpdateHandler);
      }
      if (this.controlConnectionOpenHandler) {
        this.controlNode.removeEventListener('connection:open', this.controlConnectionOpenHandler);
      }
      if (this.controlConnectionCloseHandler) {
        this.controlNode.removeEventListener('connection:close', this.controlConnectionCloseHandler);
      }
      if (this.turnConnectionOpenHandler) {
        this.controlNode.removeEventListener('connection:open', this.turnConnectionOpenHandler);
      }
      if (this.turnConnectionCloseHandler) {
        this.controlNode.removeEventListener('connection:close', this.turnConnectionCloseHandler);
      }
    }
    this.selfPeerUpdateHandler = null;
    this.controlConnectionOpenHandler = null;
    this.controlConnectionCloseHandler = null;
    this.turnConnectionOpenHandler = null;
    this.turnConnectionCloseHandler = null;

    // Reset the write-while-alone re-replication state so a stop()→start() cycle
    // re-arms the growth edge and re-runs the first-growth reconstruction. Any
    // queued local-only writes are moot once the node is torn down; owner
    // inserts are re-covered by reconstruction on the next start, and the
    // (already-loudly-logged) delete gap is tracked for follow-up.
    this.hasControlConnection = false;
    this.reconstructedLocalOnlyWrites = false;
    this.pendingPeerWrites.clear();
    this.pendingSelfPeerWrite = false;
    this.pendingSelfDeviceWrite = false;
  }

  /**
   * Resolve a peer's current, signed, trust-checkable multiaddrs from only its
   * PeerId — the transport-agnostic input a NAT-to-NAT WebRTC (or any) dial path
   * consumes, with no copy/paste of a relayed dial string.
   *
   * Reads the peer's `CadrePeer` record and gates it through, in order:
   *   1. record present (else `[]`),
   *   2. `publicKey <-> peerId` binding (the stored key's libp2p identity must be
   *      the requested peerId),
   *   3. self-signature verifies against `publicKey`,
   *   4. freshness — rejected once older than `maxAgeMs` (never a dead relay
   *      reservation),
   *   5. the pluggable trust gate (`opts.trustPolicy`).
   * Survivors are returned signaling (`/p2p-circuit`) first, filtered to
   * signaling-only when requested, as parsed `Multiaddr`s (unparsable addrs
   * dropped). Any gate failure yields an empty array rather than throwing.
   */
  async resolvePeerAddrs(peerId: string, opts: ResolveOpts = {}): Promise<Multiaddr[]> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before resolving peer addrs');
    }

    const record = await this.controlDatabase.queryPeerRecord(peerId);
    if (!record) {
      log('resolvePeerAddrs: no record for %s', peerId);
      return [];
    }

    // publicKey <-> peerId binding: the stored key must be the one embedded in
    // the requested Ed25519 peer id (also rejects a non-Ed25519 / missing key).
    if (!record.publicKey || ed25519PublicKeyB64FromPeerId(peerId) !== record.publicKey) {
      log('resolvePeerAddrs: publicKey does not match peerId for %s', peerId);
      return [];
    }

    // Self-signature over (peerId, addrs, updatedAt).
    if (!verifyPeerRecordSignature(record)) {
      log('resolvePeerAddrs: signature verification failed for %s', peerId);
      return [];
    }

    // Freshness: never hand back a dead relay reservation.
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PEER_RECORD_MAX_AGE_MS;
    if (!isPeerRecordFresh(record.updatedAt, maxAgeMs, Date.now())) {
      log('resolvePeerAddrs: record for %s is stale (updatedAt=%d, maxAgeMs=%d)', peerId, record.updatedAt, maxAgeMs);
      return [];
    }

    // Pluggable trust gate (defaults to current-member).
    const trustPolicy = opts.trustPolicy ?? currentMemberTrustPolicy();
    const trusted = await trustPolicy.evaluate({
      peerId,
      publicKey: record.publicKey,
      partyId: this.partyId,
      record,
    });
    if (!trusted) {
      log('resolvePeerAddrs: trust policy rejected %s', peerId);
      return [];
    }

    // Order signaling-first (the on-record order was what we verified above),
    // optionally restrict to signaling addrs, then parse — dropping any addr
    // that does not parse as a multiaddr.
    let addrs = orderSignalingFirst(record.addrs);
    if (opts.signalingOnly) {
      addrs = addrs.filter(isSignalingAddr);
    }
    return this.parseMultiaddrs(addrs);
  }

  /** Parse multiaddr strings, dropping (and logging) any that fail to parse. */
  private parseMultiaddrs(addrs: string[]): Multiaddr[] {
    const out: Multiaddr[] = [];
    for (const addr of addrs) {
      try {
        out.push(multiaddr(addr));
      } catch (error) {
        log('resolvePeerAddrs: dropping unparsable multiaddr %s: %o', addr, error);
      }
    }
    return out;
  }

  // ============================================================================
  // Proactive control-cohort dial
  //
  // The control collections only replicate once a party's nodes are
  // transport-connected (so FRET seats each peer in the others' keyspace cohort)
  // AND a write happens while that cohort has ≥2 members. There is no production
  // mechanism that makes a party's control nodes actively connect to each other;
  // the convergence test does it by hand with a manual dial(). reconcileControlCohort
  // productionizes that: each node resolves its known siblings' control addresses
  // and proactively dials a bounded, backbone-preferential set, re-observing and
  // re-dialing dropped connections on each pass. See docs/architecture.md (Control
  // Network) and control-cohort.ts for the selection policy.
  // ============================================================================

  /**
   * Run one proactive control-cohort dial pass to keep this node connected to its
   * cadre siblings (so the `CadreControl` collections form a replicating cohort).
   * Public so the cohort-growth-driven re-replication path
   * (`control-write-ensure-replicated`) and tests can trigger a pass on demand;
   * normally driven by the eager start pass, the recurring interval, and
   * `self:peer:update` (all wired in {@link startRecordRefresh}).
   *
   * Concurrent triggers collapse into a single in-flight pass
   * (see {@link reconcileControlCohortInFlight}) so two passes never double-dial.
   * Best-effort throughout: a failure to resolve/dial any one sibling is logged
   * and the pass continues; the whole pass is a no-op when the node is alone.
   */
  async reconcileControlCohort(): Promise<void> {
    if (this.reconcileControlCohortInFlight) {
      return this.reconcileControlCohortInFlight;
    }
    const op = this.runReconcileControlCohort();
    this.reconcileControlCohortInFlight = op;
    try {
      await op;
    } finally {
      this.reconcileControlCohortInFlight = null;
    }
  }

  /** Body of {@link reconcileControlCohort}; serialised by its single-flight guard. */
  private async runReconcileControlCohort(): Promise<void> {
    // Shutdown / not-yet-started guard (mirrors publishSelfRecord). A pass that
    // fires after stop() began must early-return rather than touch a torn-down node.
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    // Ride this pass's cadence to refresh the per-stream gate's materialized
    // authorized set — membership changes that ARRIVED BY REPLICATION (rather
    // than a local write) are picked up here, bounding the snapshot's staleness
    // to the reconcile interval.
    // NOTE: this refresh and the sibling enumeration below each run their own
    // CadrePeer query (two reads per pass); if those reads ever get costly,
    // share one row-set across both.
    await this.refreshAuthorizedControlPeers('reconcile');
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    const selfPeerId = this.controlNode.peerId.toString();

    // 1. Enumerate known siblings. This membership read is itself a pull-on-read
    //    that helps the CadrePeer table converge — a reader-only node converges
    //    purely by these reads.
    const members = await this.listMembers();
    const siblings = members.filter((m) => m.peerId !== selfPeerId);
    if (siblings.length === 0) {
      // Genuinely alone (cold start with no rows, or a solo cadre): nothing to
      // dial. Must not throw or busy-loop.
      return;
    }
    // Re-guard after the await: a stop() may have raced the membership read.
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }

    // 2. Classify backbone (owner) members and select a bounded dial set.
    // NOTE: deliberately the REPLICATED table, not the node-local anchor — this
    // only *prefers* owner peers as dial targets, so pollution costs a wasted
    // dial while anchoring would drop legitimate co-owners this node never
    // pinned. Same call as `SeedPeer.isOwner` in seed-bootstrap.ts. Move it to
    // the anchor if owner status here ever gates something trusted.
    const ownerKeys = await this.controlDatabase.getOwnerKeys();
    if (!this._running || !this.controlNode) {
      return;
    }
    const targetDegree = this.config.network?.controlCohort?.targetDegree
      ?? DEFAULT_CONTROL_COHORT_TARGET_DEGREE;
    const { dials, cappedNonOwner } = selectControlCohortDials(siblings, ownerKeys, targetDegree);
    if (cappedNonOwner > 0) {
      // Don't silently bound coverage — surface what the out-degree cap dropped.
      log('reconcileControlCohort: capped %d non-owner sibling(s) at targetDegree=%d',
        cappedNonOwner, targetDegree);
    }

    // 3. Skip already-connected peers (no re-dial / churn for live connections).
    const connected = new Set(this.controlNode.getConnections().map((c) => c.remotePeer.toString()));

    // 4. Resolve + dial each selected, not-yet-connected sibling, best-effort.
    let dialed = 0;
    for (const sibling of dials) {
      if (!this._running || !this.controlNode) {
        return;
      }
      if (connected.has(sibling.peerId)) {
        continue;
      }
      if (await this.dialControlSibling(sibling)) {
        dialed++;
      }
    }
    log('reconcileControlCohort: pass complete (siblings=%d, selected=%d, dialed=%d)',
      siblings.length, dials.length, dialed);
  }

  /**
   * Resolve one sibling's control-network dial addresses and dial it, best-effort.
   * Returns whether a dial was attempted (false when no address resolves).
   *
   * A per-peer failure (NAT, offline, relay down, connection-gater denial) is
   * logged and swallowed so one unreachable sibling never aborts the pass —
   * exactly like {@link SeedBootstrapService.applySeed}'s owner-dial loop. A
   * failed dial is simply retried on the next pass.
   */
  private async dialControlSibling(sibling: CohortPeerRow): Promise<boolean> {
    const controlNode = this.controlNode;
    if (!controlNode) {
      return false;
    }
    const addrs = await this.resolveControlDialAddrs(sibling.peerId);
    if (addrs.length === 0) {
      log('reconcileControlCohort: no dialable control address for sibling %s; skipping', sibling.peerId);
      return false;
    }
    try {
      log('reconcileControlCohort: dialing sibling %s (%d addr(s))', sibling.peerId, addrs.length);
      await controlNode.dial(addrs);
      return true;
    } catch (error) {
      log('reconcileControlCohort: dial of sibling %s failed (continuing): %o', sibling.peerId, error);
      return false;
    }
  }

  /**
   * Resolve a sibling's control-network dial addresses for the reconcile pass.
   *
   * Primary (steady state): the signed, fresh, trust-gated control addresses from
   * the converged `CadrePeer` record via {@link resolvePeerAddrs}. Fallback (cold
   * start): the libp2p peerStore entries `applySeed` populated, used only while the
   * record is not yet resolvable. Returns `[]` (never throws) when neither yields
   * an address — that sibling is skipped this pass.
   */
  private async resolveControlDialAddrs(peerId: string): Promise<Multiaddr[]> {
    const resolved = await this.resolvePeerAddrs(peerId);
    if (resolved.length > 0) {
      return resolved;
    }
    return this.peerStoreAddrs(peerId);
  }

  /**
   * Cold-start fallback: the libp2p peerStore multiaddrs for `peerId` (seeded by
   * {@link SeedBootstrapService.applySeed}). Returns `[]` on a missing entry or any
   * parse/lookup failure — never throws.
   */
  private async peerStoreAddrs(peerId: string): Promise<Multiaddr[]> {
    if (!this.controlNode) {
      return [];
    }
    try {
      const peer = await this.controlNode.peerStore.get(peerIdFromString(peerId));
      // Re-parse through the top-level multiaddr parser so the returned type matches
      // resolvePeerAddrs (the peerStore bundles its own @multiformats/multiaddr copy).
      return this.parseMultiaddrs(peer.addresses.map((a) => a.multiaddr.toString()));
    } catch (error) {
      log('reconcileControlCohort: peerStore lookup for %s failed: %o', peerId, error);
      return [];
    }
  }

  // ============================================================================
  // Write-while-alone re-replication (control-write-ensure-replicated)
  //
  // Optimystic's coordinator commits a control write WITHOUT broadcasting when the
  // block's cluster has ≤1 member. An owner that authorizes/removes a peer or
  // (re)publishes its own record while no sibling is connected therefore writes a
  // row that exists ONLY in its local control DB — a sibling that connects later
  // never observes it (pull-on-read routes to the block's cluster, which never
  // learned of the write). reconcileControlCohort shrinks the alone window but
  // cannot close it (a write in the instant before any sibling connects is still
  // local-only). The remedy: detect "wrote while alone" (0 connections is a sound
  // lower bound), queue the affected row, and RE-ISSUE the write once the cohort
  // grows (0→≥1 connection), as an idempotent monotonic update that now broadcasts.
  // See docs/architecture.md (Control Network → write-while-alone durability).
  // ============================================================================

  /**
   * Whether a control write happening now would commit local-only. A sound lower
   * bound is "no connected control peers": 0 connections ⇒ the block's cluster is
   * ≤1 ⇒ Optimystic commits without broadcasting. This is the pragmatic proxy for
   * the precise signal (the block's `getClusterSize`); it over-approximates safely
   * — a connected-but-not-in-this-block's-cluster write may still be local-only and
   * is caught by the cohort's periodic pull-on-read instead. Re-issuing an already-
   * replicated row is harmless (an idempotent monotonic bump), so the coarse proxy
   * is acceptable as the agreed first cut.
   */
  private committedAlone(): boolean {
    return (this.controlNode?.getConnections().length ?? 0) === 0;
  }

  /**
   * Record (or clear) a just-committed owner membership write in the
   * write-while-alone re-replication queue. If the control node had no connections
   * at commit, the Optimystic write was local-only and must be re-issued once the
   * cohort grows; otherwise the write replicated and any stale queue entry for this
   * subject is dropped.
   *
   * A `remove` that commits alone is a security-relevant durability gap (a revoked
   * peer may persist as a member elsewhere), so it is logged loudly — and, because
   * a physical delete leaves no local trace to re-issue from, its on-growth
   * re-issue is best-effort only (see {@link drainPendingPeerWrites}).
   */
  private noteControlWrite(peerId: string, kind: 'authorize' | 'remove'): void {
    if (!this.committedAlone()) {
      this.pendingPeerWrites.delete(peerId);
      return;
    }
    this.pendingPeerWrites.set(peerId, kind);
    if (kind === 'remove') {
      log('removePeer(%s) committed while ALONE (0 control connections): the deletion is ' +
        'local-only, so a revoked peer may persist in the cohort until re-replication. The ' +
        'on-growth re-issue is best-effort (a physical delete cannot be replayed without a ' +
        'schema tombstone — see control-delete-while-alone-tombstone).', peerId);
    } else {
      log('authorizePeer(%s) committed while alone (0 control connections); queued for ' +
        're-replication on cohort growth', peerId);
    }
  }

  /**
   * Drain the write-while-alone re-replication queue: re-issue the writes that
   * committed local-only now that the cohort can broadcast them. Public so the
   * 0→≥1 growth trigger ({@link handleControlConnectionChange}) and tests can drive
   * it; concurrent calls collapse into one in-flight drain
   * ({@link drainControlReplicationInFlight}) so two growth signals never
   * double-issue. Best-effort throughout — a per-row failure leaves that entry
   * queued for the next growth rather than aborting the drain.
   */
  async drainPendingControlReplication(reason: string): Promise<void> {
    if (this.drainControlReplicationInFlight) {
      return this.drainControlReplicationInFlight;
    }
    const op = this.runDrainControlReplication(reason);
    this.drainControlReplicationInFlight = op;
    try {
      await op;
    } finally {
      this.drainControlReplicationInFlight = null;
    }
  }

  /** Body of {@link drainPendingControlReplication}; serialised by its single-flight guard. */
  private async runDrainControlReplication(reason: string): Promise<void> {
    // Shutdown / not-yet-started guard (mirrors runReconcileControlCohort).
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    const firstGrowth = !this.reconstructedLocalOnlyWrites;
    log('Draining control re-replication (reason=%s, firstGrowth=%s, pendingPeers=%d, self=%s, deviceToken=%s)',
      reason, firstGrowth, this.pendingPeerWrites.size, this.pendingSelfPeerWrite, this.pendingSelfDeviceWrite);

    // 1. Self rows. On the first growth always re-touch (covers a self row carried
    //    over from a prior process that committed local-only before this start);
    //    afterwards only when a self-write-while-alone was recorded this session.
    //    registerSelf is idempotent + single-flight, so this never races a
    //    duplicate publish with the heartbeat republish.
    if (firstGrowth || this.pendingSelfPeerWrite) {
      await this.registerSelf().catch((error) => log('drain: registerSelf failed: %o', error));
      this.pendingSelfPeerWrite = false;
    }
    if (firstGrowth || this.pendingSelfDeviceWrite) {
      await this.retouchSelfDeviceToken();
      this.pendingSelfDeviceWrite = false;
    }

    // 2. First growth: an owner reconstructs membership rows it may have
    //    authored that never replicated (covers writes from before this process
    //    started). Rows already tracked in the in-memory queue are handled by
    //    step 3 — skipped here to avoid a double re-touch.
    if (firstGrowth) {
      this.reconstructedLocalOnlyWrites = true;
      await this.reconstructAuthoredMembership();
    }

    // 3. In-session pending owner membership writes (authorize / remove).
    await this.drainPendingPeerWrites();
  }

  /**
   * Re-touch this node's own `DeviceToken` row (re-sign + bump `UpdatedAt` via
   * {@link registerDeviceToken}) so a self device-token that committed local-only
   * re-broadcasts on cohort growth. No-op when no row exists (nothing to
   * re-replicate) or the stored platform is unknown. Best-effort — never throws to
   * the drain.
   */
  private async retouchSelfDeviceToken(): Promise<void> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    const peerId = this.controlNode.peerId.toString();
    try {
      const existing = await this.controlDatabase.queryDeviceToken(peerId);
      if (!existing || !isPushPlatform(existing.platform)) {
        return;
      }
      await this.registerDeviceToken(existing.platform, existing.token);
    } catch (error) {
      log('drain: retouch self DeviceToken failed: %o', error);
    }
  }

  /**
   * One-shot, first-cohort-growth reconstruction of the write-while-alone queue for
   * an OWNER node: re-touch every membership row that may be an unreplicated
   * owner insert. A row is a candidate iff it is not self (handled by
   * {@link registerSelf}), is not already tracked in the in-memory queue (handled by
   * {@link drainPendingPeerWrites}), and carries no self-`Sig` yet (an
   * owner-authored row the peer has not self-published — the only kind safe to
   * bump without invalidating a self-signature). O(rows) on the small control
   * tables; safe to over-apply (a monotonic owner bump on an already-replicated
   * row is a no-op-equivalent).
   *
   * A node with no owner private key skips this entirely — it cannot re-sign
   * rows for other peers, and rows it merely holds are not its to re-issue. DELETEs
   * cannot be reconstructed here (a removed row leaves no local trace and the schema
   * carries no tombstone) — see the delete-path note in {@link drainPendingPeerWrites}.
   */
  private async reconstructAuthoredMembership(): Promise<void> {
    if (!this.controlDatabase || !this.controlNode) {
      return;
    }
    if (!this.seedBootstrapService?.canAuthorize()) {
      return;
    }
    const selfPeerId = this.controlNode.peerId.toString();
    const members = await this.controlDatabase.queryCadrePeers();
    let touched = 0;
    for (const member of members) {
      if (!this._running || !this.controlNode || !this.controlDatabase) {
        return;
      }
      if (member.peerId === selfPeerId || this.pendingPeerWrites.has(member.peerId)) {
        continue;
      }
      try {
        const record = await this.controlDatabase.queryPeerRecord(member.peerId);
        // Missing (raced a delete) or peer-owned (self-Sig present) → not ours to bump.
        if (!record || record.sig) {
          continue;
        }
        await this.reissuePeerAuthorize(member.peerId, record.updatedAt);
        touched++;
      } catch (error) {
        log('drain: reconstruction re-touch of %s failed (continuing): %o', member.peerId, error);
      }
    }
    if (touched > 0) {
      log('drain: reconstructed %d owner-authored membership row(s) on first cohort growth', touched);
    }
  }

  /**
   * Drain the in-session write-while-alone queue: re-issue each pending owner
   * membership write now that the cohort can broadcast it. Sequential (no fan-out)
   * to avoid a thundering re-touch; an entry is cleared only on success, so a
   * failure (or a still-alone re-commit) leaves it queued for the next growth.
   *
   * - `authorize`: re-issue as an idempotent monotonic owner UPDATE
   *   ({@link reissuePeerAuthorize}). Skipped (and cleared) if the row vanished
   *   (raced a delete) or now carries a self-`Sig` (the peer self-published and owns
   *   its republish).
   * - `remove` (security-relevant): a removePeer-while-alone physically removed the
   *   row locally, so a re-issued DELETE matches nothing and does NOT propagate —
   *   full delete durability requires a schema tombstone (deferred:
   *   `control-delete-while-alone-tombstone`). We still attempt the re-issue
   *   (harmless, and it propagates in the row-still-present case); the commit-alone
   *   was already logged loudly in {@link noteControlWrite}.
   */
  private async drainPendingPeerWrites(): Promise<void> {
    if (this.pendingPeerWrites.size === 0) {
      return;
    }
    if (!this.seedBootstrapService?.canAuthorize()) {
      // A non-owner node cannot have authored these writes; drop any stray entries.
      this.pendingPeerWrites.clear();
      return;
    }
    for (const [peerId, kind] of [...this.pendingPeerWrites]) {
      if (!this._running || !this.controlNode || !this.controlDatabase) {
        return;
      }
      try {
        if (kind === 'authorize') {
          const record = await this.controlDatabase.queryPeerRecord(peerId);
          if (!record || record.sig) {
            // Removed since, or peer self-published — nothing for the owner to re-issue.
            this.pendingPeerWrites.delete(peerId);
            continue;
          }
          await this.reissuePeerAuthorize(peerId, record.updatedAt);
        } else {
          // Best-effort delete re-issue (see method doc): propagates only if the row
          // is somehow still present locally.
          await this.seedBootstrapService.removePeer(peerId);
        }
        await this.refreshAuthorizedControlPeers('drain-reissue');
        this.pendingPeerWrites.delete(peerId);
      } catch (error) {
        log('drain: re-issue of %s (%s) failed; leaving queued for next growth: %o', peerId, kind, error);
      }
    }
  }

  /**
   * Re-issue an owner membership row as a monotonic owner UPDATE: bump
   * `UpdatedAt` strictly above the stored value (and the wall clock) and re-sign via
   * the owner branch of `CadrePeer.AuthorizedUpdate`. The row already exists
   * locally (it committed there, just local-only), so this is an UPDATE, not the
   * original INSERT.
   */
  private async reissuePeerAuthorize(peerId: string, currentUpdatedAt: number): Promise<void> {
    if (!this.seedBootstrapService) {
      return;
    }
    const updatedAt = Math.max(Date.now(), (currentUpdatedAt ?? 0) + 1);
    await this.seedBootstrapService.reauthorizePeer(peerId, updatedAt);
  }

  /**
   * On a control connection opening, detect the 0→≥1 transition and drain the
   * write-while-alone re-replication queue (single-flight; fires only on the edge,
   * not on every subsequent `connection:open`). Best-effort — a drain failure is
   * logged, not thrown.
   */
  private handleControlConnectionChange(): void {
    if (!this._running || !this.controlNode) {
      return;
    }
    const connected = this.controlNode.getConnections().length > 0;
    if (!connected || this.hasControlConnection) {
      return;
    }
    this.hasControlConnection = true;
    log('Control cohort grew (0 → ≥1 connection); draining write-while-alone re-replication queue');
    void this.drainPendingControlReplication('connection:open')
      .catch((error) => log('Control re-replication drain (connection:open) failed: %o', error));
  }

  /** Re-arm the growth edge once all control connections drop, so a later reconnect re-drains. */
  private handleControlConnectionClose(): void {
    if (!this.controlNode) {
      return;
    }
    if (this.controlNode.getConnections().length === 0) {
      this.hasControlConnection = false;
    }
  }

  /**
   * Wire the control-connection growth listeners that drive write-while-alone
   * re-replication. Wired in {@link start} (not the delayed refresh path) so no
   * early `connection:open` is missed; torn down in {@link stopRecordRefresh}.
   * Idempotent.
   */
  private wireControlConnectionListeners(): void {
    if (!this.controlNode || this.controlConnectionOpenHandler) {
      return;
    }
    this.controlConnectionOpenHandler = () => this.handleControlConnectionChange();
    this.controlConnectionCloseHandler = () => this.handleControlConnectionClose();
    this.controlNode.addEventListener('connection:open', this.controlConnectionOpenHandler);
    this.controlNode.addEventListener('connection:close', this.controlConnectionCloseHandler);

    // TURN-relay detection: tag/untag peers whose WebRTC ICE used a TURN candidate.
    this.turnConnectionOpenHandler = (evt) => this.handleTurnConnectionOpen(evt.detail);
    this.turnConnectionCloseHandler = (evt) => this.handleTurnConnectionClose(evt.detail);
    this.controlNode.addEventListener('connection:open', this.turnConnectionOpenHandler);
    this.controlNode.addEventListener('connection:close', this.turnConnectionCloseHandler);
  }

  /**
   * On a control connection opening: if it is a WebRTC connection, drain the TURN
   * tracker for the just-settled ICE verdict and, when it relayed, mark the peer
   * so {@link getConnectionPaths} classifies it `webrtc-turn` (relayed). The
   * settlement↔open correlation is timing-based and best-effort; an unknown
   * verdict degrades to not-relayed. Never throws to the event loop.
   */
  private handleTurnConnectionOpen(conn: Connection): void {
    try {
      const addr = conn.remoteAddr?.toString() ?? '';
      // Only a genuine `/webrtc` (ICE) session can be TURN-relayed and promoted to
      // webrtc-turn. Use the classifier (which checks `/webrtc-direct` first) rather
      // than a bare substring — `'/webrtc-direct'.includes('/webrtc')` is true, and a
      // webrtc-direct open must not drain a settlement meant for a real webrtc dial.
      if (classifyTransport(addr).transport !== 'webrtc') {
        return;
      }
      if (this.turnTracker.consume(TURN_CONSUME_WINDOW_MS) === true) {
        const peerId = conn.remotePeer.toString();
        this.turnRelayedPeers.add(peerId);
        log('TURN-relayed WebRTC connection detected for peer %s', peerId);
      }
    } catch (error) {
      log('handleTurnConnectionOpen failed: %o', error);
    }
  }

  /** On a control connection closing, drop any TURN-relayed flag for its peer. */
  private handleTurnConnectionClose(conn: Connection): void {
    try {
      this.turnRelayedPeers.delete(conn.remotePeer.toString());
    } catch (error) {
      log('handleTurnConnectionClose failed: %o', error);
    }
  }

  // ============================================================================
  // Device-token registry (control-network push-token publish + resolve)
  //
  // The control network is the only network a hibernating peer keeps connected,
  // so it is where a mobile peer self-publishes its FCM/APNs push token and where
  // a server peer resolves it to deliver a push-wake to a suspended app. The write
  // + gate paths mirror registerSelf / resolvePeerAddrs (see DeviceToken in
  // control-schema.ts and device-token.ts).
  // ============================================================================

  /**
   * Publish (or refresh) this node's own self-signed `DeviceToken` row so a server
   * peer can resolve its FCM/APNs push token from its PeerId alone. Mirrors
   * {@link registerSelf}:
   *
   * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt` (works
   *   for any member — the `AuthorizedUpdate` self-branch verifies the new `Sig`
   *   against the bound `CadrePeer.PublicKey`). Platform/Token may change here
   *   (rotation / platform switch / reinstall are all normal self-updates).
   * - If not, and the node holds an owner service: an owner-signed INSERT
   *   that also carries the self-signature.
   * - Otherwise: throws. Like `CadrePeer`, the first `DeviceToken` row requires an
   *   owner signature; a non-owner peer (e.g. a phone) must have its row
   *   seeded by an owner — typically the server it enrolled with — before it
   *   can self-refresh. (Establishing that phone→server registration handshake is
   *   the downstream "RN registration" ticket; this node only owns the cadre-core
   *   write path.)
   *
   * `UpdatedAt` strictly increases on every publish (even a same-millisecond
   * re-publish), so a replayed older record is rejected by the schema.
   *
   * @param platform - `'fcm'` (Android/Firebase) or `'apns'` (Apple).
   * @param token - the opaque platform device/registration token.
   * @throws if the node is not started, exposes no self-signing key, or has no
   *   existing row and no owner service to self-insert.
   */
  async registerDeviceToken(platform: PushPlatform, token: string): Promise<void> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before registering a device token');
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        'Cannot register device token: no self-signing key available ' +
        '(node identity unavailable or not matching the node PeerId).'
      );
    }

    const peerId = this.controlNode.peerId.toString();
    const existing = await this.controlDatabase.queryDeviceToken(peerId);
    // Strictly increase UpdatedAt even on a same-millisecond re-publish (rotation).
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const record = signDeviceTokenRecord(
      { peerId, platform, token, updatedAt },
      signingKey.privateKeyB64
    );

    if (existing) {
      await this.controlDatabase.updateSelfDeviceToken(record);
      if (this.committedAlone()) this.pendingSelfDeviceWrite = true;
      log('registerDeviceToken: refreshed own DeviceToken (platform=%s, updatedAt=%d)', platform, updatedAt);
      return;
    }
    if (this.seedBootstrapService) {
      await this.seedBootstrapService.insertSelfDeviceToken(record);
      if (this.committedAlone()) this.pendingSelfDeviceWrite = true;
      log('registerDeviceToken: inserted own DeviceToken (owner-signed, platform=%s, updatedAt=%d)', platform, updatedAt);
      return;
    }
    throw new Error(
      `Cannot register device token for ${peerId}: no existing row to self-update and no ` +
      'owner service to self-insert. An owner must seed this peer\'s DeviceToken ' +
      'row first (mirrors CadrePeer enrollment).'
    );
  }

  /**
   * Resolve a cadre peer's FCM/APNs push token from only its PeerId — the input a
   * server's push-wake fan-out consumes to deliver a platform push to a suspended
   * app. Applies the same gating shape as {@link resolvePeerAddrs}, returning
   * `null` (never throwing) on any failure:
   *
   *   1. membership — the peer has a `CadrePeer` row with a `PublicKey`,
   *   2. `publicKey <-> peerId` binding — the stored key's libp2p identity is the
   *      requested peerId,
   *   3. a `DeviceToken` row exists with a known {@link PushPlatform},
   *   4. self-signature verifies against the bound `CadrePeer.PublicKey`,
   *   5. freshness — `updatedAt` is positive and within `opts.maxAgeMs` (default:
   *      no ceiling, since a push token is valid until it rotates).
   *
   * A peer that is not a current member, or whose token has no backing `CadrePeer`
   * record, resolves to `null` — a server must not attempt to push to a non-cadre
   * peer.
   */
  async resolveDeviceToken(peerId: string, opts: ResolveDeviceTokenOpts = {}): Promise<DeviceTokenRecord | null> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before resolving a device token');
    }

    // Membership + publicKey<->peerId binding: read the peer's CadrePeer row and
    // confirm the stored key is the one embedded in the requested Ed25519 peer id.
    const peerRecord = await this.controlDatabase.queryPeerRecord(peerId);
    if (!peerRecord || !peerRecord.publicKey) {
      log('resolveDeviceToken: no CadrePeer/PublicKey for %s', peerId);
      return null;
    }
    if (ed25519PublicKeyB64FromPeerId(peerId) !== peerRecord.publicKey) {
      log('resolveDeviceToken: publicKey does not match peerId for %s', peerId);
      return null;
    }

    const record = await this.controlDatabase.queryDeviceToken(peerId);
    if (!record) {
      log('resolveDeviceToken: no device token for %s', peerId);
      return null;
    }
    if (!isPushPlatform(record.platform)) {
      log('resolveDeviceToken: unknown platform %s for %s', record.platform, peerId);
      return null;
    }

    // Self-signature over (peerId, platform, token, updatedAt), verified against the
    // CadrePeer.PublicKey bound to this peerId.
    if (!verifyDeviceTokenSignature(record, peerRecord.publicKey)) {
      log('resolveDeviceToken: signature verification failed for %s', peerId);
      return null;
    }

    // Freshness: a positive stamp, optionally bounded. No ceiling by default — a
    // suspended phone's token must stay resolvable for push-wake long after publish.
    const maxAgeMs = opts.maxAgeMs ?? Number.POSITIVE_INFINITY;
    if (!isPeerRecordFresh(record.updatedAt, maxAgeMs, Date.now())) {
      log('resolveDeviceToken: record for %s is stale (updatedAt=%d, maxAgeMs=%d)', peerId, record.updatedAt, maxAgeMs);
      return null;
    }

    return record;
  }

  /**
   * Delete this node's own `DeviceToken` row (logout / token invalidation). No-op
   * when no row exists. Like {@link registerDeviceToken}'s first insert, the delete
   * is gated on an owner signature (`DeviceToken.AuthorizedInsert` covers insert
   * AND delete), so it requires this node's owner service; a non-owner peer
   * must route the clear through its owner (downstream RN registration path).
   *
   * @throws if the node is not started, or a row exists but no owner service is
   *   available to sign the delete.
   */
  async clearDeviceToken(): Promise<void> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before clearing a device token');
    }
    const peerId = this.controlNode.peerId.toString();
    const existing = await this.controlDatabase.queryDeviceToken(peerId);
    if (!existing) {
      log('clearDeviceToken: no DeviceToken row for %s; no-op', peerId);
      return;
    }
    if (!this.seedBootstrapService) {
      throw new Error(
        `Cannot clear device token for ${peerId}: delete requires an owner signature ` +
        'and no owner service is initialized.'
      );
    }
    await this.seedBootstrapService.deleteDeviceToken(peerId);
    log('clearDeviceToken: deleted DeviceToken for %s', peerId);
  }

  /**
   * Expire ANOTHER peer's stale `DeviceToken` after a platform reported it
   * unregistered during a push-wake fan-out. Unlike {@link clearDeviceToken}
   * (self-only — it hardcodes the local peerId), this takes an arbitrary peerId.
   *
   * - When this node holds an owner seed service, it deletes the row
   *   (`deleteDeviceToken` is owner-gated and accepts any peerId), so the peer
   *   is not retried until it re-registers.
   * - When this node is NOT an owner it cannot delete the row, so it only logs
   *   that a re-registration is needed. The fan-out's own in-memory dead-token set
   *   is what actually stops re-pushing to the dead token this process — see
   *   {@link PushFanoutService}. That set is acceptably lossy across restarts (a
   *   restart re-learns staleness on the next failed send).
   *
   * Best-effort: never throws to the (best-effort) fan-out caller.
   */
  async expireDeviceToken(peerId: string): Promise<void> {
    if (this.seedBootstrapService) {
      try {
        await this.seedBootstrapService.deleteDeviceToken(peerId);
        log('expireDeviceToken: owner-deleted stale DeviceToken for %s', peerId);
      } catch (error) {
        log('expireDeviceToken: owner delete for %s failed: %o', peerId, error);
      }
      return;
    }
    log('expireDeviceToken: %s token is stale but this node is not an owner; re-registration required', peerId);
  }

  private async handleStrandAdded(strand: StrandRow): Promise<void> {
    log('Handling strand added from control network: %s', strand.Id);

    // Check if we have sApp config for this strand
    const sAppConfig = this.sAppConfigs.get(strand.Id);
    if (!sAppConfig) {
      log('No sAppConfig registered for strand %s - emitting strand:discovered', strand.Id);
      // Strand created by another member and not yet configured locally. Surface
      // it as a discovery event so the hosting app can decide whether to join
      // (register a config + addStrand); the strand-agnostic seam keeps this
      // class free of any app's join policy. A self-configured strand (config
      // already present) keeps auto-starting below, unchanged.
      this.emit('strand:discovered', { strandId: strand.Id, strand });
      return;
    }

    try {
      // Discovery path: no explicit mode — infer from cohort membership.
      await this.launchStrand(strand, sAppConfig);
    } catch (error) {
      log('Error starting strand %s: %o', strand.Id, error);
      this.emit('strand:error', {
        strandId: strand.Id,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  private async handleStrandRemoved(strandId: string): Promise<void> {
    log('Handling strand removed: %s', strandId);

    try {
      // Untrack from hibernation
      this.hibernationManager.untrackStrand(strandId);

      // Remove sApp config
      this.sAppConfigs.delete(strandId);

      await this.strandManager.stopStrand(strandId);
      this.emit('strand:stopped', { strandId });
    } catch (error) {
      log('Error stopping strand %s: %o', strandId, error);
      this.emit('strand:error', {
        strandId,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  private async cleanup(): Promise<void> {
    // Resolve + clear any in-flight wake windows first, so an in-flight check-in
    // or serviceWake unblocks and tears down cleanly rather than firing a stale
    // window timer (or hanging) after the strand manager is stopped below.
    this.clearWindowWaiters();

    // Stop self-record refresh timers + address-change listener (before the
    // control node is torn down, so removeEventListener has a live target).
    this.stopRecordRefresh();

    // Restore the wrapped globalThis.RTCPeerConnection and drop TURN-relay state.
    this.turnTracker.dispose();
    this.turnRelayedPeers.clear();

    // Stop hibernation manager
    this.hibernationManager.stop();

    // Stop seed bootstrap service
    if (this.seedBootstrapService) {
      await this.seedBootstrapService.shutdown();
      this.seedBootstrapService = null;
    }

    // Stop strand wake service (unregister the WAKE_PROTOCOL handler)
    if (this.strandWakeService) {
      await this.strandWakeService.shutdown();
      this.strandWakeService = null;
    }

    // Stop strand-addr service (unregister the STRAND_ADDR_PROTOCOL handler so a
    // restart does not hit DuplicateProtocolHandlerError).
    if (this.strandAddrService) {
      await this.strandAddrService.shutdown();
      this.strandAddrService = null;
    }

    // Tear down the push-wake fan-out (releases the notifier's APNs HTTP/2 session).
    if (this.pushFanoutService) {
      await this.pushFanoutService.close().catch((err) => log('Push fan-out close failed: %o', err));
      this.pushFanoutService = null;
    }

    // Unregister strand solicitation service
    if (this.strandSolicitationService && this.controlNode) {
      this.strandSolicitationService.unregisterResponder(this.controlNode);
      this.strandSolicitationService = null;
    }

    // Stop strand watcher
    if (this.strandWatcher) {
      await this.strandWatcher.stop();
      this.strandWatcher = null;
    }

    // Stop all strand instances
    await this.strandManager.stopAll();

    // Clear sApp configs
    this.sAppConfigs.clear();

    // Close control database (this also shuts down the collection factory)
    if (this.controlDatabase) {
      await this.controlDatabase.close();
      this.controlDatabase = null;
    }

    // Stop control node
    if (this.controlNode) {
      await this.controlNode.stop();
      this.controlNode = null;
    }
  }

  // Hibernation callbacks
  private async handleStrandIdle(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = 'idle';
      log('Strand %s transitioned to idle', strandId);
      this.emit('strand:idle', { strandId });
    }
  }

  /**
   * Hibernate a strand: release its strand-network resources via the strand
   * manager (stop the libp2p node, close the StrandDatabase) and mark it
   * `hibernating`. A quiesced strand holds no open strand-network connections,
   * transports, or DB handles. No-ops if the strand is missing; if already
   * quiesced (defensive), just marks status and emits.
   */
  private async handleStrandHibernate(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('handleStrandHibernate: strand %s not found', strandId);
      return;
    }

    if (!instance.libp2pNode && !instance.database) {
      // Already quiesced — only the status flag needs updating.
      instance.status = 'hibernating';
      log('Strand %s already quiesced; marked hibernating', strandId);
      this.emit('strand:hibernating', { strandId });
      return;
    }

    log('Hibernating strand %s — releasing strand-network resources', strandId);
    await this.strandManager.quiesceStrand(strandId);
    instance.status = 'hibernating';
    this.emit('strand:hibernating', { strandId });
    log('Strand %s hibernating (resources released)', strandId);
  }

  /**
   * Wake a strand. If it was hibernating (quiesced — no libp2p node), re-resolve
   * the cohort discovery seed and mode exactly as `launchStrand` does and rebuild
   * its runtime via the strand manager. If it is still live (e.g. waking an idle
   * strand, which retains its resources), just flip the status. Overlapping wake
   * triggers are coalesced upstream by `HibernationManager`, so this runs once
   * per wake; `resumeStrand` is itself idempotent as a backstop.
   */
  private async handleStrandWake(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('handleStrandWake: strand %s not found', strandId);
      return;
    }

    // Still live (idle wake, or defensive double-wake): no rebuild needed.
    if (instance.libp2pNode || instance.database) {
      instance.status = 'active';
      instance.lastActivity = new Date();
      log('Strand %s woke (already live)', strandId);
      this.emit('strand:waking', { strandId });
      return;
    }

    // Quiesced: re-resolve volatile cohort inputs (the seed may have grown, the
    // mode may have shifted bootstrap → networked) and rebuild the runtime.
    log('Waking strand %s — rebuilding strand-network resources', strandId);
    await this.resumeStrandRuntime(strandId);
    instance.lastActivity = new Date();
    this.emit('strand:waking', { strandId });
    log('Strand %s awake (resources rebuilt)', strandId);
  }

  /**
   * Rebuild a quiesced strand's runtime, re-resolving the volatile cohort inputs
   * first: the discovery seed may have grown and cohort membership may have
   * shifted the mode `bootstrap → networked` since the strand last ran. Shared by
   * the wake (`handleStrandWake`) and check-in (`handleStrandCheckIn`) paths so
   * both apply the same fresh seed/mode resolution. `resumeStrand` is idempotent
   * (returns the live instance unchanged) as a backstop against double-resume.
   */
  private async resumeStrandRuntime(strandId: string): Promise<void> {
    const seed = await this.resolveCohortSeed(strandId);
    const mode = selectStrandMode(undefined, seed.hasOtherPeers);
    await this.strandManager.resumeStrand(strandId, {
      bootstrapNodes: seed.bootstrapNodes,
      mode
    });
  }

  /**
   * Real cohort check-in for a hibernating strand (the `onCheckIn` callback).
   *
   * Optimystic syncs pull-on-read, not on connect, and exposes no cheap
   * repo-level "pull pending" hook (`IRepo` is get/pend/commit/cancel only —
   * see the review handoff). So "query the cohort for pending activity" is
   * realized as a resume → bounded window → re-hibernate-if-idle cycle that
   * reuses the existing quiesce/resume primitives rather than a bespoke probe:
   *
   *   1. Resume the strand (rebuild node + db, re-resolve cohort seed/mode) so
   *      its strand network can reach cohort peers — exactly as a wake does.
   *   2. Hold it resumed for a bounded window, during which the app may drive
   *      reads (pull-on-read) and record activity.
   *   3. If activity was recorded during the window, leave the strand `active`
   *      (the idle/hibernate timers + backoff reset take over). Otherwise
   *      quiesce again and leave it `hibernating`, so `HibernationManager`
   *      schedules the next, longer-delayed check-in.
   *
   * No-ops unless the strand is currently `hibernating` — a concurrent wake may
   * have already resumed it.
   */
  private async handleStrandCheckIn(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('handleStrandCheckIn: strand %s not found', strandId);
      return;
    }
    if (instance.status !== 'hibernating') {
      log('handleStrandCheckIn: strand %s not hibernating (status=%s); skipping', strandId, instance.status);
      return;
    }

    try {
      // 1. Resume exactly as a wake does: re-resolve the (possibly grown) cohort
      //    seed + mode, then rebuild the runtime.
      log('Check-in: resuming strand %s to probe the cohort for pending activity', strandId);
      await this.resumeStrandRuntime(strandId);

      // 2-3. Bounded window for the strand network to connect + the app to act,
      //      then re-hibernate-if-idle. Shared with the on-demand serviceWake.
      const windowMs = this.config.hibernation?.checkInWindowMs ?? DEFAULT_CHECKIN_WINDOW_MS;
      await this.runWakeWindow(instance, windowMs);
    } catch (err) {
      // A check-in that throws part-way — resume failing on a flaky network (the
      // very scenario hibernation targets), the window rejecting, or quiesce
      // throwing — must leave the strand HIBERNATING, not in the `error` status
      // that `resumeStrand` sets on failure. `HibernationManager.runCheckIn`
      // decides wake-vs-escalate purely from `instance.status` after this
      // resolves: an `error` status reads as "woke", which STOPS the check-in
      // chain and strands the strand with no runtime and no future check-in.
      // Forcing it back to `hibernating` (after a best-effort quiesce to release
      // any partially-rebuilt runtime) makes the manager escalate the backoff and
      // retry on the next tick.
      log('Check-in failed for strand %s; re-hibernating to retry on backoff: %o', strandId, err);
      await this.strandManager.quiesceStrand(strandId).catch((cleanupErr) => {
        log('Check-in cleanup quiesce for strand %s failed: %o', strandId, cleanupErr);
      });
      instance.status = 'hibernating';
    }
  }

  /**
   * Window-then-decide for a just-resumed strand, shared by the check-in timer
   * path ({@link handleStrandCheckIn}) and the on-demand {@link serviceWake}:
   *
   *   1. Capture the post-resume activity marker. `recordActivity` assigns a
   *      FRESH `Date`, so a changed reference after the window means real
   *      activity landed during it — not millisecond-resolution noise.
   *   2. Hold the strand live for `windowMs` so its strand network reaches the
   *      cohort and the app can drive pull-on-read activity.
   *   3. If activity landed, leave the strand `active` (return `true`); otherwise
   *      quiesce and mark it `hibernating` again (return `false`).
   *
   * @returns whether activity was observed during the window (strand left active).
   */
  private async runWakeWindow(instance: StrandInstance, windowMs: number): Promise<boolean> {
    const strandId = instance.strandId;
    const activityMark = instance.lastActivity;

    await this.holdWakeWindow(instance, windowMs);

    const sawActivity = instance.lastActivity !== activityMark;
    if (sawActivity) {
      instance.status = 'active';
      this.emit('strand:waking', { strandId });
      log('Wake window: strand %s saw activity during the window; staying active', strandId);
      return true;
    }

    log('Wake window: no activity for strand %s; re-hibernating', strandId);
    await this.strandManager.quiesceStrand(strandId);
    instance.status = 'hibernating';
    return false;
  }

  /**
   * Hold a just-resumed strand live for `windowMs` (default
   * {@link DEFAULT_CHECKIN_WINDOW_MS} is applied by callers). A non-positive
   * window resolves immediately. The pending timer is tracked in
   * {@link windowWaiters} so {@link cleanup} can both clear it and resolve the
   * promise on teardown — a `stop()` during an in-flight window must neither fire
   * the timer afterward nor hang the awaiting check-in/serviceWake. Extracted as
   * its own method so tests can stub the wait (and inject activity during it).
   */
  private async holdWakeWindow(_instance: StrandInstance, windowMs: number): Promise<void> {
    if (windowMs <= 0) return;
    await new Promise<void>((resolve) => {
      const waiter = { timer: undefined as unknown as ReturnType<typeof setTimeout>, resolve };
      waiter.timer = setTimeout(() => {
        this.windowWaiters.delete(waiter);
        resolve();
      }, windowMs);
      this.windowWaiters.add(waiter);
    });
  }

  /**
   * Clear every in-flight wake window: cancel its timer and resolve its promise
   * so any awaiting check-in/serviceWake completes promptly rather than hanging
   * past teardown. Called from {@link cleanup}.
   */
  private clearWindowWaiters(): void {
    for (const waiter of this.windowWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.windowWaiters.clear();
  }

  /**
   * Add a strand with its sApp configuration.
   * The hosting application must provide the sApp schema when creating a strand.
   */
  async addStrand(config: StrandConfig): Promise<StrandInstance> {
    if (!this._running) {
      throw new Error('CadreNode not running');
    }

    const { strandRow, sAppConfig, mode, founder } = config;

    // Store sApp config for this strand
    this.sAppConfigs.set(strandRow.Id, sAppConfig);
    log('Registered sAppConfig for strand %s (sApp: %s, mode: %s, founder: %s)',
      strandRow.Id, sAppConfig.id, mode ?? 'inferred', founder ?? false);

    // Pass `mode` (possibly undefined) through: an explicit mode wins, while a
    // caller that omits it gets the same cohort-inferred mode as the discovery path.
    // `founder` only flows from the explicit addStrand path — the control-discovered
    // join path never founds, so its rows arrive via sync (see handleStrandAdded).
    return await this.launchStrand(strandRow, sAppConfig, mode, founder);
  }

  /**
   * Publish a strand row to the shared control database under this node's own
   * owner identity, so other cadre members discover it via control-network
   * sync (their {@link StrandWatcher} fires `strand:discovered`).
   *
   * This is the owner-signed `Strand` INSERT that {@link addStrand}
   * deliberately omits: `addStrand` only starts the LOCAL strand instance,
   * whereas publishing makes the strand visible cadre-wide. A typical creator
   * does both (start locally + publish); a discovering peer only does
   * `addStrand` (the row already exists).
   *
   * The insert is signed with the ed25519 key behind this node's PeerId — which
   * {@link ed25519KeyPairFromLibp2p} also exposes as the node's owner keypair,
   * so peer identity and owner key are one and the same. That key must be
   * enrolled in `OwnerKey` (e.g. via {@link ControlDatabase.ensureOwnerKey}
   * at genesis) or the schema's `Strand.Authorized` constraint rejects the write.
   * Failing loudly here is intentional: a silently-unpublished strand would run
   * as a local-only island that no peer could ever discover or join.
   *
   * @param strandId - Unique strand identifier (typically the same id passed to
   *   {@link addStrand}).
   * @param type - `'o'` for open (default) or `'c'` for closed.
   * @param memberPrivateKey - Optional membership key for a closed strand.
   * @throws if the node is not started, exposes no owner signing key, or the
   *   control DB rejects the (unauthorized) insert.
   */
  async publishStrand(strandId: string, type: 'o' | 'c' = 'o', memberPrivateKey?: string): Promise<void> {
    if (!this._running || !this.controlDatabase) {
      throw new Error('CadreNode must be started before publishing a strand');
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        `Cannot publish strand ${strandId}: no owner signing key available ` +
        '(node identity is unavailable or does not match the node PeerId). Run owner ' +
        'genesis (ensureOwnerKey + initializeSeedBootstrap) before publishing.'
      );
    }
    // insertStrand hands this callback the canonical row-bound message BYTES (see
    // buildAuthorizationMessage); ed25519-sign them directly (no pre-hash) with
    // the owner private key, returning a base64url signature.
    const signMessage = (message: Uint8Array): string =>
      sign(message, signingKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
    await this.controlDatabase.insertStrand(strandId, type, signingKey.publicKeyB64, signMessage, memberPrivateKey);
    log('Published strand %s (type %s) to control DB under owner %s', strandId, type, signingKey.publicKeyB64);
  }

  /**
   * Publish an owner-signed `FormationInvite` (open-invitation token) to the
   * shared control database, so a later {@link formStrand} redemption can be
   * validated against it (the consent branch of `Strand.Authorized`).
   *
   * Counterpart to {@link createOpenInvitation}, which only mints the
   * out-of-band {@link OpenInvitation} envelope: persisting the matching
   * `FormationInvite` row is what makes the token *redeemable* — the host's
   * {@link ControlFormationUsageRecorder} answers `isTokenValid`/`isTokenUsed`
   * from this row. A host minting a closed-strand invite does both (mint +
   * publish), exactly as the integration harness's `createInvitation` does.
   *
   * Signs with the same self-owner key as {@link publishStrand} (the ed25519
   * key behind this node's PeerId, which must be an enrolled `OwnerKey`).
   * Throws loudly if the node isn't started or exposes no signing key.
   *
   * @param token - Invitation token (the `FormationInvite` primary key); use the
   *   `token` of the {@link OpenInvitation} from {@link createOpenInvitation}.
   * @param sAppId - The sApp a redeemed strand will use.
   * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
   *   `strandId` (bind a closed/pre-existing host strand for provision-then-record).
   */
  async publishFormationInvite(
    token: string,
    sAppId: string,
    options: { expiresAtMs?: number; totalUses?: number; validationUrl?: string; strandId?: string } = {}
  ): Promise<void> {
    if (!this._running || !this.controlDatabase) {
      throw new Error('CadreNode must be started before publishing a formation invite');
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        `Cannot publish formation invite ${token}: no owner signing key available ` +
        '(node identity is unavailable or does not match the node PeerId). Run owner ' +
        'genesis (ensureOwnerKey + initializeSeedBootstrap) before publishing.'
      );
    }
    const signMessage = (message: Uint8Array): string =>
      sign(message, signingKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
    await this.controlDatabase.insertFormationInvite(token, sAppId, signingKey.publicKeyB64, signMessage, options);
    // A host may publish an invite whose token was minted elsewhere; registering
    // it locally opens the connection gate's formation exemption immediately
    // rather than waiting for the durable row to become readable.
    this.strandSolicitationService?.registerMintedInvitation(
      token,
      options.expiresAtMs ?? Number.POSITIVE_INFINITY
    );
    log('Published formation invite %s (sApp %s) under owner %s', token, sAppId, signingKey.publicKeyB64);
  }

  /**
   * Shared strand launch path for both the explicit (`addStrand`) and the
   * control-discovered (`handleStrandAdded`) entry points. Resolves the cohort
   * seed, selects the mode, starts the strand, and registers it with the
   * hibernation manager before emitting `strand:started`.
   */
  private async launchStrand(
    strand: StrandRow,
    sAppConfig: SAppConfig,
    explicitMode?: StrandMode,
    founder?: boolean
  ): Promise<StrandInstance> {
    const seed = await this.resolveCohortSeed(strand.Id);
    const mode = selectStrandMode(explicitMode, seed.hasOtherPeers);

    const instance = await this.strandManager.startStrand({
      strandRow: strand,
      sAppConfig,
      storage: this.config.storage,
      network: this.config.network,
      profile: this.config.profile,
      defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? 'interactive',
      privateKey: this.identityKey,
      bootstrapNodes: seed.bootstrapNodes,
      mode,
      requireSignedSchemas: this.config.requireSignedSchemas,
      clusterSize: this.config.clusterSize,
      founder
    });

    this.hibernationManager.trackStrand(instance);
    this.emit('strand:started', { strandId: strand.Id });
    return instance;
  }

  /**
   * Resolve a strand's discovery seed. Membership (and thus mode) comes from the
   * control network's CadrePeer rows; the **strand-network** bootstrap addresses
   * are resolved on demand over the control mesh via the strand-addr RPC —
   * deliberately NOT from `CadrePeer.Multiaddr`, which carries *control*
   * addresses that must not seed the strand mesh.
   *
   * Only siblings we already hold an open control connection to are RPC'd: they
   * are the ones that can answer right now, and dialing them by peerId reuses the
   * live connection. When no connected sibling yet runs the strand the seed is
   * empty (`[]`) — mode still follows membership, and the empty seed self-heals
   * on the next resume / check-in pass. Returns an empty seed when the control DB
   * or node is absent (not yet started / torn down).
   */
  private async resolveCohortSeed(strandId: string): Promise<CohortSeed> {
    if (!this.controlDatabase || !this.controlNode) {
      return { bootstrapNodes: [], hasOtherPeers: false };
    }
    const peers = await this.controlDatabase.queryCadrePeers();
    const { otherPeerIds, hasOtherPeers } =
      deriveCohortMembers(peers, this.controlNode.peerId.toString());

    // RPC only siblings we already have a control connection to — they can answer
    // now, and `dialProtocol` by peerId reuses the open connection.
    const connected = new Set(this.controlNode.getConnections().map((c) => c.remotePeer.toString()));
    const targets = otherPeerIds.filter((id) => connected.has(id));
    const bootstrapNodes = targets.length
      ? await collectStrandAddrs(this.controlNode, targets.map((peerId) => ({ peerId })), strandId)
      : [];
    return { bootstrapNodes, hasOtherPeers };
  }

  /**
   * The local strand instance's dialable strand-network multiaddrs for the
   * strand-addr RPC, ordered signaling-first (reusing the control node's
   * {@link orderSignalingFirst}). Returns `[]` when the strand is not running
   * locally or has no live libp2p node (hibernating / quiescing / never
   * participated) — a node only answers for a strand it is actively meshing,
   * regardless of the strand's mode. A `bootstrap`-mode first node still has a
   * live node, so it answers and a later sibling can dial in.
   */
  private getStrandMultiaddrs(strandId: string): string[] {
    const node = this.strandManager.getInstance(strandId)?.libp2pNode;
    if (!node) {
      return [];
    }
    return orderSignalingFirst(node.getMultiaddrs().map((ma) => ma.toString()));
  }

  /**
   * Remove a strand
   */
  async removeStrand(strandId: string): Promise<void> {
    if (!this._running) {
      throw new Error('CadreNode not running');
    }

    // Untrack from hibernation
    this.hibernationManager.untrackStrand(strandId);

    // Remove sApp config
    this.sAppConfigs.delete(strandId);

    await this.strandManager.stopStrand(strandId);
    this.emit('strand:stopped', { strandId });
  }

  /**
   * Record activity on a strand (resets hibernation timer).
   *
   * Also drives the server push-wake fan-out: whatever already drives activity on
   * this node's strand (its relay/app layer doing pull-on-read) additionally wakes
   * hibernating mobile peers — the same imperative seam local-wake uses, with no
   * new contract. No-op for the fan-out when push is not configured.
   */
  recordStrandActivity(strandId: string): void {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      this.hibernationManager.recordActivity(instance);
    }
    this.notifyStrandActivity(strandId);
  }

  /**
   * Explicit fan-out trigger: an always-on host/relay/sApp calls this when it
   * observes activity for a strand this node participates in, to wake hibernating
   * mobile members over a direct control-network dial (falling back to FCM/APNs
   * for suspended phones). This is the supported, honest v1 trigger — Optimystic
   * exposes no passive repo-level "new transaction" hook to drive it automatically
   * (see the deferred passive-detector follow-up). No-op when push is not
   * configured; best-effort (never throws — the check-in wake is the backstop).
   *
   * @param strandId - the strand that saw activity.
   * @param reason - free-form cause hint carried in the wake (default `activity`).
   */
  notifyStrandActivity(strandId: string, reason?: string): void {
    void this.pushFanoutService?.notify(strandId, reason);
  }

  /**
   * Force wake a hibernating strand
   */
  async wakeStrand(strandId: string): Promise<void> {
    await this.hibernationManager.wakeStrand(strandId);
  }

  // ============================================================================
  // Mobile background lifecycle primitives
  //
  // Imperative control a mobile BackgroundRunner drives from OS app-state and
  // push events, rather than from the internal idle/hibernate/check-in timers.
  // ============================================================================

  /**
   * Force a single strand to hibernate immediately, bypassing the idle/hibernate
   * timers — the background-entry path. No-op if the strand is realtime
   * (never-hibernate latency hint), already hibernating, or unknown.
   *
   * Routes through {@link HibernationManager.forceHibernate}, which cancels the
   * strand's pending idle/hibernate (and check-in) timers — so a stale timer
   * can't re-fire on or resurrect the strand — then runs the same `onHibernate`
   * path as the timer (`quiesceStrand` + `status='hibernating'` +
   * `strand:hibernating`). Unlike the timer path it does NOT re-arm check-ins:
   * the strand stays down until the caller drives a wake (e.g. {@link serviceWake}).
   */
  async hibernateStrand(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('hibernateStrand: strand %s unknown; no-op', strandId);
      return;
    }
    if (!this.hibernationManager.hibernates(instance)) {
      log('hibernateStrand: strand %s is realtime; no-op', strandId);
      return;
    }
    if (instance.status === 'hibernating') {
      log('hibernateStrand: strand %s already hibernating; no-op', strandId);
      return;
    }
    await this.hibernationManager.forceHibernate(instance);
  }

  /**
   * Force-hibernate every tracked strand whose latency hint is not realtime,
   * tolerating per-strand failure (one strand failing to quiesce never aborts
   * the others). Realtime strands are left running — the caller keeps the control
   * connection and realtime strands alive for as long as the OS permits.
   *
   * @returns the strandIds actually hibernated (now in `hibernating` status);
   *   realtime strands are excluded.
   */
  async hibernateAll(): Promise<string[]> {
    const hibernated: string[] = [];
    for (const [strandId, instance] of this.strandManager.getInstances()) {
      if (!this.hibernationManager.hibernates(instance)) {
        log('hibernateAll: skipping realtime strand %s', strandId);
        continue;
      }
      try {
        await this.hibernateStrand(strandId);
        if (instance.status === 'hibernating') {
          hibernated.push(strandId);
        }
      } catch (error) {
        // Collect-and-continue: a single strand's quiesce failure must not strand
        // the rest of the background-entry sweep.
        log('hibernateAll: strand %s failed to hibernate (continuing): %o', strandId, error);
      }
    }
    log('hibernateAll: hibernated %d strand(s)', hibernated.length);
    return hibernated;
  }

  /**
   * On-demand equivalent of a check-in cycle, for a push-delivered wake on
   * mobile: resume the strand, hold it live for `windowMs` so its strand network
   * reaches the cohort and the app can pull pending activity, then re-hibernate
   * if no activity was recorded (else leave it active).
   *
   * Idempotent / coalesced two ways: concurrent `serviceWake`s for the same
   * strand share one in-flight operation ({@link serviceWakePromises}), and the
   * underlying resume coalesces with a racing push-wake via
   * {@link HibernationManager}'s wake coalescing — one runtime build, one window,
   * one re-hibernate decision. Returns `{ serviced: false }` (never throws) when
   * the node is not running or the strand is unknown, and surfaces a resume
   * failure as `{ serviced: true, hadActivity: false }` after re-hibernating.
   *
   * @param strandId - the strand a push said has pending activity.
   * @param opts.windowMs - override the live-window duration (defaults to the
   *   configured `checkInWindowMs` / {@link DEFAULT_CHECKIN_WINDOW_MS}).
   */
  async serviceWake(strandId: string, opts?: { windowMs?: number }): Promise<ServiceWakeResult> {
    const existing = this.serviceWakePromises.get(strandId);
    if (existing) {
      log('serviceWake: joining in-flight wake for strand %s', strandId);
      return existing;
    }
    const op = this.runServiceWake(strandId, opts);
    this.serviceWakePromises.set(strandId, op);
    try {
      return await op;
    } finally {
      this.serviceWakePromises.delete(strandId);
    }
  }

  /** Body of {@link serviceWake}; serialised per-strand by its coalescing guard. */
  private async runServiceWake(strandId: string, opts?: { windowMs?: number }): Promise<ServiceWakeResult> {
    // Not-running / control-absent guard (mirrors pushWake): a background task
    // must get a branchable result, never a throw.
    if (!this._running || !this.controlNode) {
      log('serviceWake: node not running; not serviced (strand %s)', strandId);
      return { strandId, serviced: false, hadActivity: false };
    }

    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('serviceWake: strand %s unknown to this node; not serviced', strandId);
      return { strandId, serviced: false, hadActivity: false };
    }

    // Already live (active or idle — both retain their runtime): servicing is a
    // no-op success. Do NOT run a window that would re-hibernate a strand the app
    // may be actively using, and do NOT rebuild a second runtime.
    if (instance.libp2pNode || instance.database) {
      log('serviceWake: strand %s already live; no-op success', strandId);
      return { strandId, serviced: true, hadActivity: true };
    }

    try {
      // Coalesced resume: routes through wakeStrand → HibernationManager.beginWake
      // so a racing push-wake shares this single runtime build.
      await this.wakeStrand(strandId);
      const windowMs = opts?.windowMs ?? this.config.hibernation?.checkInWindowMs ?? DEFAULT_CHECKIN_WINDOW_MS;
      const hadActivity = await this.runWakeWindow(instance, windowMs);
      return { strandId, serviced: true, hadActivity };
    } catch (error) {
      // Resume failing mid-window (network unreachable inside a Doze grant, etc.)
      // must not throw out of a background task: re-hibernate and report no
      // activity, mirroring handleStrandCheckIn's re-hibernate-on-error.
      log('serviceWake: strand %s failed during wake window; re-hibernating: %o', strandId, error);
      await this.strandManager.quiesceStrand(strandId).catch((cleanupErr) => {
        log('serviceWake cleanup quiesce for strand %s failed: %o', strandId, cleanupErr);
      });
      instance.status = 'hibernating';
      return { strandId, serviced: true, hadActivity: false };
    }
  }

  /**
   * Get the control network node (for advanced use)
   */
  getControlNode(): Libp2p | null {
    return this.controlNode;
  }

  /**
   * Get the control database (for advanced queries)
   */
  getControlDatabase(): ControlDatabase | null {
    return this.controlDatabase;
  }

  /**
   * Force a poll of the strand watcher (for testing)
   */
  async forceStrandPoll(): Promise<void> {
    await this.strandWatcher?.forcePoll();
  }

  /**
   * Get the sApp configuration for a strand
   */
  getSAppConfig(strandId: string): SAppConfig | undefined {
    return this.sAppConfigs.get(strandId);
  }

  // ============================================================================
  // Seed Bootstrap API
  // ============================================================================

  /**
   * Initialize the seed bootstrap service with an owner key.
   * Must be called before using seed-related methods that require signing.
   *
   * @param ownerPrivateKey - The owner's private key (base64url encoded)
   */
  initializeSeedBootstrap(ownerPrivateKey: string): void {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before initializing seed bootstrap');
    }

    // A node wiring seed-bootstrap with an owner PRIVATE key is declaring that
    // key an authority of its own party (founder genesis / self-signing owner)
    // — anchor it in the node-local store. The in-memory set updates
    // synchronously (see TrustedOwnerStore.trust); only the file persist is
    // fire-and-forget, logged on failure.
    // NOTE: non-founder members that also wire seed-bootstrap with their own
    // derived key (e.g. the phone joiner path in runOwnerGenesis, which needs
    // it to self-publish its CadrePeer row) self-anchor a key that is not a
    // party authority. Harmless while such a node never mints an invite: the
    // store does not replicate, so a node trusting itself grants nothing to
    // others. But `createInvite` now hands out the anchor's contents as the
    // invitee's pins, so the moment a non-founder member mints an invite it
    // exports its own non-authority key as a cadre owner key. If that becomes
    // reachable (today only cadre-cli/cadre-host owners mint invites), gate this
    // self-anchor on the actual OwnerKey genesis insert instead.
    if (this.trustedOwnerStore) {
      void this.trustedOwnerStore
        .trust(ed25519PublicKeyFromPrivate(ownerPrivateKey), 'genesis')
        .catch((error) => log('Trusted-owner genesis anchor persist failed: %o', error));
    }

    this.seedBootstrapService = new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      ownerPrivateKey,
      inviteAddressResolver: () => this.resolveInviteAddresses(),
      trustPolicy: this.config.seedTrustPolicy,
      // Seed trust anchors on the node-local store (seeded just above with this
      // node's own genesis key), never on the replicated OwnerKey table.
      ...(this.trustedOwnerStore ? { trustedOwners: this.trustedOwnerStore } : {}),
    });

    this.seedBootstrapService.setEventCallbacks({
      onSeedReceived: (partyId, peerId) => this.emit('seed:received', { partyId, peerId }),
      onSeedApplied: (partyId, peersAdded) => this.emit('seed:applied', { partyId, peersAdded }),
      onSeedError: (partyId, error) => this.emit('seed:error', { partyId, error }),
    });

    this.seedBootstrapService.initialize(this.controlNode, this.controlDatabase);
    log('Seed bootstrap service initialized');
  }

  /**
   * Push the multiaddrs that future invites should advertise. Pass `null` to
   * revert to the libp2p-reported addresses (the default). The host calls this
   * at spawn and on every NAT change.
   */
  setInviteAddresses(addresses: string[] | null): void {
    this.latestInviteAddresses = addresses;
    log('Invite addresses updated: %s', addresses ? `${addresses.length} pushed` : 'cleared (libp2p fallback)');
  }

  /**
   * Resolve the addresses to embed in invites. Prefers pushed addresses, then
   * any config-supplied resolver, then the libp2p-observed multiaddrs.
   */
  private async resolveInviteAddresses(): Promise<string[]> {
    if (this.latestInviteAddresses !== null) {
      return this.latestInviteAddresses;
    }
    if (this.config.network?.inviteAddressResolver) {
      return this.config.network.inviteAddressResolver();
    }
    return this.getMultiaddrs();
  }

  /**
   * Enumerate the cadre's `CadrePeer` membership.
   */
  async listMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before listing members');
    }
    return this.controlDatabase.queryCadrePeers();
  }

  /**
   * Probe whether a given peer is a `CadrePeer` member.
   *
   * This is the ADDRESSABLE surface ("do I have a dialable address record for this
   * peer") — it includes this node's own self-published row. Address resolution and
   * push fan-out use this. The trust-facing gate is {@link isAuthorizedMember}.
   */
  async isMember(peerId: string): Promise<boolean> {
    const members = await this.listMembers();
    return members.some(m => m.peerId === peerId);
  }

  /**
   * Enumerate the party's AUTHORIZED members — the trust-facing set, distinct from
   * the addressable set ({@link listMembers}). A peer is authorized iff ALL hold:
   *
   *  1. it is not this node itself — a node publishes its own `CadrePeer` address
   *     row so its dialable address rides in seeds, but "self" is not a peer this
   *     node authorized;
   *  2. its `CadrePeer` row carries a complete voucher (`StampId`, `VouchOwner`,
   *     `VouchSig` all non-null);
   *  3. `VouchOwner` is in the NODE-LOCAL trusted-owner anchor
   *     ({@link getTrustedOwnerStore}) — never the replicated `OwnerKey` table,
   *     which any stranger can genesis-pollute; and
   *  4. `VouchSig` verifies as that owner's signature over the row's voucher
   *     digest ({@link verifyCadrePeerVoucher}), so the anchored owner really
   *     vouched THIS peer id under THIS row's nonce; and
   *  5. the row's `StampId` is NOT retired in `CadreControl.Revocation` — a removed
   *     peer's stamp is tombstoned there permanently, so a row resurrected by
   *     replaying the captured admission approval on a node that had not yet
   *     converged on the tombstone (the write-time `NotRevoked` CHECK only sees
   *     local rows) is still inert to every reader that has the tombstone.
   *
   * Fail-closed at every step: a missing anchor (pre-start), an empty anchor (a
   * not-yet-enrolled node authorizes no one), a null/partial voucher, an
   * unanchored `VouchOwner`, or a bad signature all yield "not authorized" —
   * having an address row is NOT membership. The control-network wake and
   * strand-address gates consult this set, NOT the addressable one.
   *
   * NOTE (rotation): if a party owner rotates keys and only the NEW key is pinned
   * in the anchor, rows the OLD key vouched fail check 3 until re-vouched — a
   * legit member goes un-authorized on readers that only pin the new key. Full
   * rotation handling (re-vouch on rotate) is the
   * `flip-strand-membership-rotation-known-gap` work, not this predicate's.
   */
  async listAuthorizedMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before listing members');
    }
    const selfPeerId = this.peerId?.toString();
    const rows = await this.controlDatabase.queryCadrePeers();
    const revokedStamps = await this.controlDatabase.queryRevokedStamps('CadrePeer');
    const authorized = rows
      .filter(row => row.peerId !== selfPeerId
        && (row.stampId === null || !revokedStamps.has(row.stampId))
        && this.hasAnchoredVoucher(row))
      .map(({ peerId, multiaddr }) => ({ peerId, multiaddr }));
    // A node whose anchor was never seeded (no invite pin, no operator pin, not a
    // founder) refuses every wake and strand-addr request, which from the outside
    // looks like an unexplained "non-member" rejection. Say so once per call rather
    // than leaving the operator to infer it from silence.
    if (authorized.length === 0 && rows.length > 0 && (this.trustedOwnerStore?.all().size ?? 0) === 0) {
      log('listAuthorizedMembers: %d CadrePeer row(s) but the node-local trusted-owner anchor is EMPTY — authorizing no one (this node has no invite/operator owner-key pin)', rows.length);
    }
    return authorized;
  }

  /**
   * Checks 2–4 of the authorized-membership predicate (see
   * {@link listAuthorizedMembers}) for one `CadrePeer` row: complete voucher,
   * `VouchOwner` in the node-local anchor, signature valid over the row's
   * (PeerId, StampId) voucher digest.
   *
   * NOTE: verifies the ed25519 signature on every call (no memo of already-
   * verified (peerId, stampId, vouchSig) triples). Cadres are a handful of
   * devices and the gates run per inbound request, so this is cheap today; if
   * membership or gate traffic ever grows, cache verified triples keyed on the
   * row's `StampId` (which rotates with every re-vouch).
   */
  private hasAnchoredVoucher(row: CadrePeerVoucherFields): boolean {
    if (row.stampId === null || row.vouchOwner === null || row.vouchSig === null) {
      return false;
    }
    if (!this.trustedOwnerStore?.has(row.vouchOwner)) {
      return false;
    }
    return verifyCadrePeerVoucher(row.peerId, row.stampId, row.vouchOwner, row.vouchSig);
  }

  /**
   * Probe whether a given peer is an AUTHORIZED party member (see
   * {@link listAuthorizedMembers}) — the gate the control-network wake and
   * strand-address responders consult, NOT {@link isMember} (the addressable
   * surface). Deliberately scans the full membership (one `CadrePeer` query)
   * rather than adding a single-row read path: cadres are small, and one code
   * path keeps the predicate impossible to drift from the list.
   */
  async isAuthorizedMember(peerId: string): Promise<boolean> {
    const members = await this.listAuthorizedMembers();
    return members.some(m => m.peerId === peerId);
  }

  /**
   * Push-wake a hibernating cadre peer over the control network.
   *
   * Resolves the target's signed control-network address from its `CadrePeer`
   * record (via {@link resolvePeerAddrs}, signaling/relay first — so a NAT'd peer
   * is reachable through its circuit-relay address), dials `WAKE_PROTOCOL`, sends
   * the {@link WakeRequest}, and returns the peer's {@link WakeAck}. The receiver
   * gates the request on cadre membership and only resumes a strand it already
   * participates in.
   *
   * @param targetPeerId - The hibernating cadre peer to wake.
   * @param strandId - The strand the caller knows has pending activity.
   * @param reason - Optional cause hint, e.g. `"activity"` or `"manual"`.
   * @throws if the node is not started or the target has no dialable address.
   */
  async pushWake(targetPeerId: string, strandId: string, reason?: string): Promise<WakeAck> {
    if (!this.controlNode) {
      throw new Error('CadreNode must be started before pushing wakes');
    }
    const addrs = await this.resolvePeerAddrs(targetPeerId);
    if (addrs.length === 0) {
      throw new Error(`No dialable control-network address for peer ${targetPeerId}`);
    }
    const request: WakeRequest = { strandId, reason };
    return await dialWake(this.controlNode, addrs, request);
  }

  /**
   * Enable the seed listener for receiving seeds via the /sereus/seed/1.0.0 protocol.
   * This is for drone nodes that need to receive seeds without being an owner.
   * Does not require an owner key.
   */
  enableSeedListener(): void {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before enabling seed listener');
    }

    // Don't re-initialize if already has a service
    if (this.seedBootstrapService) {
      log('Seed bootstrap service already initialized');
      return;
    }

    this.seedBootstrapService = new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      // No owner key - this node only receives seeds
      inviteAddressResolver: () => this.resolveInviteAddresses(),
      trustPolicy: this.config.seedTrustPolicy,
      // A listener-only node accepts a wire-delivered seed solely against this
      // anchor (there is no per-call override on the inbound handler): with no
      // genesis/invite/operator pin it authorizes nobody, which is the point.
      ...(this.trustedOwnerStore ? { trustedOwners: this.trustedOwnerStore } : {}),
    });

    this.seedBootstrapService.setEventCallbacks({
      onSeedReceived: (partyId, peerId) => this.emit('seed:received', { partyId, peerId }),
      onSeedApplied: (partyId, peersAdded) => this.emit('seed:applied', { partyId, peersAdded }),
      onSeedError: (partyId, error) => this.emit('seed:error', { partyId, error }),
    });

    this.seedBootstrapService.initialize(this.controlNode, this.controlDatabase);
    log('Seed listener enabled');
  }

  /**
   * Get the seed bootstrap service (for advanced use)
   */
  getSeedBootstrapService(): SeedBootstrapService | null {
    return this.seedBootstrapService;
  }

  /**
   * Authorize a new peer to join the cadre.
   * Signs the peer ID with the owner key and inserts into CadrePeer table.
   *
   * @param peerId - The peer ID to authorize
   * @param multiaddrs - Optional multiaddrs for the peer
   */
  async authorizePeer(peerId: string, multiaddrs?: string[]): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    await this.seedBootstrapService.authorizePeer({ peerId, multiaddrs });
    // Queue for re-replication if this committed local-only (no connected cohort).
    this.noteControlWrite(peerId, 'authorize');
    // The per-stream gate must admit the just-vouched peer immediately, not on
    // the next timed refresh.
    await this.refreshAuthorizedControlPeers('authorizePeer');
  }

  /**
   * Remove a previously-authorized peer from the cadre.
   * Signs the peer ID with the owner key and deletes the CadrePeer row.
   *
   * @param peerId - The peer ID to remove
   */
  async removePeer(peerId: string): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    await this.seedBootstrapService.removePeer(peerId);
    // Track + loudly flag a delete that committed local-only (security-relevant).
    this.noteControlWrite(peerId, 'remove');
    // Drop the removed peer from the per-stream gate right away.
    await this.refreshAuthorizedControlPeers('removePeer');
  }

  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an owner.
   */
  async createSeed(): Promise<ControlNetworkSeed> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.createSeed();
  }

  /**
   * Apply a seed to populate the peer cache and enable connections.
   *
   * Validates the seed signature, then evaluates a trust anchor for the signer
   * key (see `SeedTrustPolicy`). An enrollment caller can pass a per-seed
   * `trustPolicy` override — e.g. a `pinnedKeyTrustPolicy` built from a
   * `CadreInvite.ownerKeys` — so a cold-start node can accept its first
   * seed without reconfiguring the service.
   */
  async applySeed(
    seed: ControlNetworkSeed,
    options?: { trustPolicy?: SeedTrustPolicy }
  ): Promise<ApplySeedResult> {
    if (!this.seedBootstrapService) {
      // Create a temporary service for applying seeds (doesn't need owner key).
      // partyId is the attacker-influenced seed.partyId — it only labels logs; the
      // trust decision rests solely on signerKey vs the anchor set (configured
      // default below, or the per-call options.trustPolicy override).
      //
      // This temp service is discarded after the call, so it must NOT own the shared
      // node's inbound seed handler: pass { registerHandler: false }. That keeps
      // repeated service-less applySeed/dialInvite idempotent (no handler leak, no
      // DuplicateProtocolHandlerError). The temp service still applies this seed; a
      // node that wants to RECEIVE inbound seeds needs a persistent service
      // (enableSeedListener / initializeSeedBootstrap) to own the handler.
      const tempService = new SeedBootstrapService({
        partyId: seed.partyId,
        trustPolicy: this.config.seedTrustPolicy,
        // The anchor is node-scoped, not service-scoped: a throwaway service
        // must consult (and persist an accepted signer into) the SAME store the
        // persistent one would, or a cold-start enrollment via this path would
        // anchor nothing and re-prompt for the pin on every later seed.
        ...(this.trustedOwnerStore ? { trustedOwners: this.trustedOwnerStore } : {}),
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase, { registerHandler: false });
      }
      const tempResult = await tempService.applySeed(seed, options);
      await this.refreshAuthorizedControlPeers('applySeed');
      return tempResult;
    }
    const result = await this.seedBootstrapService.applySeed(seed, options);
    await this.refreshAuthorizedControlPeers('applySeed');
    return result;
  }

  /**
   * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
   */
  async deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.deliverSeed(targetMultiaddr, seed);
  }

  /**
   * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
   */
  encodeSeed(seed: ControlNetworkSeed): string {
    // Static method - doesn't need service initialization
    const json = JSON.stringify(seed);
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode a seed from base64url encoding.
   */
  decodeSeed(encoded: string): ControlNetworkSeed {
    // Static method - doesn't need service initialization
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as ControlNetworkSeed;
  }

  /**
   * Get this node's circuit relay address for inclusion in seeds.
   * Returns null if no relay address is available.
   */
  async getRelayAddress(): Promise<string | null> {
    if (!this.controlNode) {
      return null;
    }

    const addrs = this.controlNode.getMultiaddrs();
    const relayAddr = addrs.find(addr => addr.toString().includes('/p2p-circuit/'));
    return relayAddr?.toString() ?? null;
  }

  // ============================================================================
  // Seed Bootstrap Helper Methods
  // ============================================================================

  /**
   * Add a drone to the cadre (for phone/server adding provider-hosted node).
   * Creates authorization and seed for drone initialization.
   */
  async addDrone(options: AddDroneOptions): Promise<DroneInitResult> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    const result = await this.seedBootstrapService.addDrone(options);
    await this.refreshAuthorizedControlPeers('addDrone');
    return result;
  }

  /**
   * Create an invite for a phone to join the cadre.
   * Use when a server wants to invite a NAT'd phone.
   */
  async createInvite(token?: string, expiresIn?: number): Promise<InviteResult> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    const result = await this.seedBootstrapService.createInvite(token, expiresIn);
    // The invitee dials this node BEFORE it is authorized (dialInvite →
    // acceptPhone), so hold the inbound connection gate open for strangers for
    // the invite's validity (or a bounded default when it never expires).
    this.openEnrollmentWindow(result.invite.expiresAt ?? Date.now() + DEFAULT_ENROLLMENT_WINDOW_MS);
    return result;
  }

  /**
   * Accept a phone connection using an invite.
   * Call this when a phone dials in with an invite token.
   */
  async acceptPhone(options: AddPhoneOptions, issuedInvite?: CadreInvite): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    await this.seedBootstrapService.acceptPhone(options, issuedInvite);
    // The just-accepted phone opens control-DB streams next; admit it now.
    await this.refreshAuthorizedControlPeers('acceptPhone');
  }

  /**
   * Add a phone to the cadre with relay support.
   * Use when both nodes are NAT'd (phone-to-phone).
   */
  async addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.addPhoneWithRelay(phonePeerId);
  }

  /**
   * Encode an invite for out-of-band delivery (QR, link, etc.).
   */
  encodeInvite(invite: CadreInvite): string {
    const json = JSON.stringify(invite);
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode an invite from base64url encoding.
   */
  decodeInvite(encoded: string): CadreInvite {
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as CadreInvite;
  }

  /**
   * Dial an owner from an invite (for phone joining via invite).
   */
  async dialInvite(invite: CadreInvite): Promise<void> {
    if (!this.seedBootstrapService) {
      // Create a temporary service that only dials the invite. It is discarded after
      // the call, so it does NOT own the shared node's inbound seed handler:
      // initialize with { registerHandler: false }. This temp dialInvite never
      // applies a seed itself — a node that wants to RECEIVE an inbound seed back
      // must have a persistent service (enableSeedListener / initializeSeedBootstrap)
      // own the /sereus/seed/1.0.0 handler. trustPolicy is therefore effectively dead
      // on this dial-only path; it is kept for symmetry with the applySeed temp site.
      const tempService = new SeedBootstrapService({
        partyId: invite.partyId,
        trustPolicy: this.config.seedTrustPolicy,
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase, { registerHandler: false });
      }
      await tempService.dialInvite(invite);
      return;
    }
    await this.seedBootstrapService.dialInvite(invite);
  }

  // ============================================================================
  // Strand Solicitation API (native cadre-core formation transport)
  // ============================================================================

  /**
   * Initialize the strand solicitation service.
   * This enables forming strands with other parties via open invitations.
   *
   * @param options - Configuration for the solicitation service
   */
  initializeStrandSolicitation(options?: StrandSolicitationServiceOptions): void {
    if (!this.controlNode) {
      throw new Error('CadreNode must be started before initializing strand solicitation');
    }

    this.strandSolicitationService = new StrandSolicitationService({
      ...options,
      partyId: this.config.controlNetwork.partyId,
      cadrePeerAddrs: this.getMultiaddrs()
    });

    // Register as responder on the control node
    this.strandSolicitationService.registerResponder(this.controlNode);
    log('Strand solicitation service initialized');
  }

  /**
   * Get the strand solicitation service (for advanced use)
   */
  getStrandSolicitationService(): StrandSolicitationService | null {
    return this.strandSolicitationService;
  }

  /**
   * Create an open invitation for others to form strands with this party.
   *
   * @param sAppId - The sApp to use for formed strands
   * @param expirationMs - How long the invitation is valid (ms from now)
   * @returns The open invitation to share out-of-band
   */
  async createOpenInvitation(
    sAppId: string,
    expirationMs: number = 24 * 60 * 60 * 1000 // 24 hours default
  ): Promise<OpenInvitation> {
    if (!this.strandSolicitationService) {
      // Create a temporary service for creating invitations
      this.initializeStrandSolicitation();
    }

    const bootstrap = this.getMultiaddrs();
    if (bootstrap.length === 0) {
      throw new Error('No multiaddrs available for invitation');
    }

    return await this.strandSolicitationService!.createOpenInvitation(
      sAppId,
      expirationMs,
      bootstrap
    );
  }

  /**
   * Form a strand with a responder via an open invitation.
   *
   * @param invitation - The open invitation received out-of-band
   * @param disclosure - Identity/context information to share with the responder
   * @returns The member key and strand info if successful
   */
  async formStrand(
    invitation: OpenInvitation,
    disclosure: StrandFormationDisclosure = {}
  ): Promise<FormStrandResult> {
    if (!this.controlNode) {
      throw new Error('CadreNode must be started before forming strands');
    }

    if (!this.strandSolicitationService) {
      this.initializeStrandSolicitation();
    }

    return await this.strandSolicitationService!.formStrand(
      invitation,
      disclosure,
      this.controlNode
    );
  }

  /**
   * Encode an open invitation for out-of-band delivery (QR, link, etc.).
   */
  encodeInvitation(invitation: OpenInvitation): string {
    const json = JSON.stringify({
      ...invitation,
      expiration: invitation.expiration.toISOString()
    });
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode an open invitation from base64url encoding.
   */
  decodeInvitation(encoded: string): OpenInvitation {
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return {
      ...parsed,
      expiration: new Date(parsed.expiration)
    };
  }
}

