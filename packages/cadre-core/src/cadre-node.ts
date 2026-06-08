import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { Libp2p, PeerId } from '@libp2p/interface';
import { createLibp2pNode } from '@optimystic/db-p2p';
import type { IRepo } from '@optimystic/db-core';
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
  SelfRegistrationOutcome
} from './types.js';
import { DEFAULT_CHECKIN_WINDOW_MS } from './types.js';
import { sign } from '@optimystic/quereus-plugin-crypto';
import { authorityKeyFromLibp2p } from './authority-key.js';
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
import { StrandWatcher, type StrandQueryable, type SAppIdLookup } from './strand-watcher.js';
import { StrandInstanceManager } from './strand-instance-manager.js';
import { deriveCohortSeed, selectStrandMode, type CohortSeed } from './strand-cohort.js';
import { EnrollmentService } from './enrollment.js';
import { HibernationManager, type HibernationCallbacks } from './hibernation-manager.js';
import { ControlDatabase } from './control-database.js';
import { SeedBootstrapService } from './seed-bootstrap.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import {
  StrandSolicitationService,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';
import { StrandWakeService, dialWake } from './strand-wake-protocol.js';
import type { WakeAck, WakeRequest } from './types.js';
import {
  summarizeConnectionPaths,
  type ConnectionPathSummary
} from './diagnostics/connection-path.js';

const log = debug('sereus:cadre:node');
const timing = debug('sereus:cadre:timing');

type EventHandler<T> = (data: T) => void;

/** Libp2p node with the coordinatedRepo attached by createLibp2pNode. */
interface Libp2pNodeWithRepo extends Libp2p {
  coordinatedRepo: IRepo;
}

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
  private controlNode: Libp2p | null = null;
  private controlDatabase: ControlDatabase | null = null;
  private strandWatcher: StrandWatcher | null = null;
  private strandManager: StrandInstanceManager;
  private hibernationManager: HibernationManager;
  private enrollmentService: EnrollmentService;
  private seedBootstrapService: SeedBootstrapService | null = null;
  private strandSolicitationService: StrandSolicitationService | null = null;
  private strandWakeService: StrandWakeService | null = null;
  private running = false;
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

  /** Initial self-registration timer (see {@link scheduleSelfRegistration}). */
  private selfRegistrationTimer: ReturnType<typeof setTimeout> | null = null;
  /** TTL heartbeat that re-publishes the self record before it goes stale. */
  private recordRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Listener that re-publishes the self record when reachable addresses change. */
  private selfPeerUpdateHandler: (() => void) | null = null;
  /**
   * Single-flight guard for {@link registerSelf}. Concurrent callers (the explicit
   * CLI `--authority` publish, the 1s startup timer, the TTL heartbeat, and the
   * address-change listener) share one in-flight publish so two of them can never
   * both read "no row yet" and race a duplicate INSERT (a `CadrePeer` PK conflict).
   */
  private registerSelfInFlight: Promise<SelfRegistrationOutcome> | null = null;

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
    return this.running;
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
    return summarizeConnectionPaths(conns, settleWindowMs);
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
    if (this.running) {
      log('CadreNode already running');
      return;
    }

    log('Starting CadreNode for party: %s', this.config.controlNetwork.partyId);

    try {
      const tTotal = performance.now();

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
      // signal us to bring a hibernating strand online. Gated on CadrePeer
      // membership; the wake routes through the same path as a local wake.
      this.strandWakeService = new StrandWakeService({
        isMember: (peerId) => this.isMember(peerId),
        getStrand: (strandId) => this.strandManager.getInstance(strandId),
        wake: (strandId) => this.wakeStrand(strandId),
      });
      this.strandWakeService.initialize(this.controlNode);

      this.running = true;
      this.emit('control:connected', undefined);
      timing('[start] total: %dms', Math.round(performance.now() - tTotal));
      log('CadreNode started successfully');

      // Schedule self-registration in background
      this.scheduleSelfRegistration();

    } catch (error) {
      log('Failed to start CadreNode: %o', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Stop the cadre node
   */
  async stop(): Promise<void> {
    if (!this.running) {
      log('CadreNode not running');
      return;
    }

    log('Stopping CadreNode');
    await this.cleanup();
    this.running = false;
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

  private async createControlNode(): Promise<Libp2p> {
    const { controlNetwork, network, storage, profile, privateKey } = this.config;

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
      clusterSize: 3,
      clusterPolicy: { allowDownsize: true, sizeTolerance: 0.5 },
      arachnode: { enableRingZulu: this.config.profile === 'storage' },
      ...(privateKey && { privateKey }),
      ...(network?.transports && { transports: network.transports }),
      ...(network?.listenAddrs && { listenAddrs: network.listenAddrs })
    };

    return await createLibp2pNode(nodeOptions);
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
   * no-ops when it cannot yet sign/insert (e.g. authority key not installed),
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
        this.startRecordRefresh();
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
   *   PeerId (sourced from `config.privateKey`).
   * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt`.
   * - If not, and the node is its own authority: an authority-signed INSERT that
   *   also carries the self-signature.
   * - Otherwise: logs and returns (a non-authority node with no row yet must
   *   wait for an authority to insert it; it can then self-refresh).
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
    if (!this.running || !this.controlNode || !this.controlDatabase) {
      log('Cannot register self - node or database not initialized');
      return 'skipped';
    }

    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      log('registerSelf: no self-signing key available (config.privateKey unset or not matching peerId); skipping');
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
      log('registerSelf: refreshed own CadrePeer record (updatedAt=%d, %d addrs)', updatedAt, addrs.length);
      return 'refreshed';
    }
    if (this.seedBootstrapService) {
      // First-time row: requires an authority signature (the node is its own
      // authority). insertSelfPeerRecord throws if no authority key is present.
      await this.seedBootstrapService.insertSelfPeerRecord(record);
      log('registerSelf: inserted own CadrePeer record (authority-signed, updatedAt=%d, %d addrs)', updatedAt, addrs.length);
      return 'inserted';
    }
    log('registerSelf: not yet a CadrePeer member and no authority service to self-insert; skipping (an authority must add this peer first)');
    return 'skipped';
  }

  /**
   * The ed25519 keypair (base64url) the node signs its own record with — the key
   * behind its libp2p PeerId. Sourced from `config.privateKey`; returns null when
   * absent or (defensively) when it does not match the control node's PeerId, in
   * which case self-publish is skipped rather than producing an unresolvable row.
   */
  private getSelfSigningKey(): { privateKeyB64: string; publicKeyB64: string } | null {
    const peerId = this.controlNode?.peerId.toString();
    if (!peerId || !this.config.privateKey) {
      return null;
    }
    try {
      const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(this.config.privateKey);
      if (publicKeyB64 === ed25519PublicKeyB64FromPeerId(peerId)) {
        return { privateKeyB64, publicKeyB64 };
      }
      log('getSelfSigningKey: config.privateKey does not match control node peerId; cannot self-sign');
    } catch (error) {
      log('getSelfSigningKey: failed to derive ed25519 key from config.privateKey: %o', error);
    }
    return null;
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

    this.selfPeerUpdateHandler = () => republish('self:peer:update');
    this.controlNode.addEventListener('self:peer:update', this.selfPeerUpdateHandler);

    this.recordRefreshTimer = setInterval(() => republish('heartbeat'), DEFAULT_PEER_RECORD_HEARTBEAT_MS);
    (this.recordRefreshTimer as { unref?: () => void } | null)?.unref?.();
    log('Record refresh wired (heartbeat=%dms)', DEFAULT_PEER_RECORD_HEARTBEAT_MS);
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
    if (this.controlNode && this.selfPeerUpdateHandler) {
      this.controlNode.removeEventListener('self:peer:update', this.selfPeerUpdateHandler);
    }
    this.selfPeerUpdateHandler = null;
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
    // Stop self-record refresh timers + address-change listener (before the
    // control node is torn down, so removeEventListener has a live target).
    this.stopRecordRefresh();

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
    const seed = await this.resolveCohortSeed();
    const mode = selectStrandMode(undefined, seed.hasOtherPeers);
    await this.strandManager.resumeStrand(strandId, {
      bootstrapNodes: seed.bootstrapNodes,
      mode
    });
    instance.lastActivity = new Date();
    this.emit('strand:waking', { strandId });
    log('Strand %s awake (resources rebuilt, mode=%s)', strandId, mode);
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
      const seed = await this.resolveCohortSeed();
      const mode = selectStrandMode(undefined, seed.hasOtherPeers);
      await this.strandManager.resumeStrand(strandId, {
        bootstrapNodes: seed.bootstrapNodes,
        mode
      });

      // Capture the post-resume activity marker. recordActivity assigns a FRESH
      // Date object, so a changed reference after the window means real activity
      // was recorded during it — not millisecond-resolution noise.
      const activityMark = instance.lastActivity;

      // 2. Bounded window for the strand network to connect + the app to act.
      await this.runCheckInWindow(instance);

      // 3. Decide based on whether activity landed during the window.
      const sawActivity = instance.lastActivity !== activityMark;
      if (sawActivity) {
        instance.status = 'active';
        this.emit('strand:waking', { strandId });
        log('Check-in: strand %s saw activity during the window; staying active', strandId);
        return;
      }

      log('Check-in: no activity for strand %s; re-hibernating', strandId);
      await this.strandManager.quiesceStrand(strandId);
      instance.status = 'hibernating';
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
   * Hold a just-resumed strand live for the check-in window so its strand
   * network can connect to reachable cohort peers and the app can drive
   * pull-on-read activity. Resolves after
   * {@link HibernationConfig.checkInWindowMs} (default
   * {@link DEFAULT_CHECKIN_WINDOW_MS}); a non-positive window resolves
   * immediately. Extracted as its own method so tests can stub the wait.
   */
  private async runCheckInWindow(_instance: StrandInstance): Promise<void> {
    const windowMs = this.config.hibernation?.checkInWindowMs ?? DEFAULT_CHECKIN_WINDOW_MS;
    if (windowMs <= 0) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, windowMs); });
  }

  /**
   * Add a strand with its sApp configuration.
   * The hosting application must provide the sApp schema when creating a strand.
   */
  async addStrand(config: StrandConfig): Promise<StrandInstance> {
    if (!this.running) {
      throw new Error('CadreNode not running');
    }

    const { strandRow, sAppConfig, mode } = config;

    // Store sApp config for this strand
    this.sAppConfigs.set(strandRow.Id, sAppConfig);
    log('Registered sAppConfig for strand %s (sApp: %s, mode: %s)', strandRow.Id, sAppConfig.id, mode ?? 'inferred');

    // Pass `mode` (possibly undefined) through: an explicit mode wins, while a
    // caller that omits it gets the same cohort-inferred mode as the discovery path.
    return await this.launchStrand(strandRow, sAppConfig, mode);
  }

  /**
   * Publish a strand row to the shared control database under this node's own
   * authority identity, so other cadre members discover it via control-network
   * sync (their {@link StrandWatcher} fires `strand:discovered`).
   *
   * This is the authority-signed `Strand` INSERT that {@link addStrand}
   * deliberately omits: `addStrand` only starts the LOCAL strand instance,
   * whereas publishing makes the strand visible cadre-wide. A typical creator
   * does both (start locally + publish); a discovering peer only does
   * `addStrand` (the row already exists).
   *
   * The insert is signed with the ed25519 key behind this node's PeerId — which
   * {@link authorityKeyFromLibp2p} also exposes as the node's authority keypair,
   * so peer identity and authority key are one and the same. That key must be
   * enrolled in `AuthorityKey` (e.g. via {@link ControlDatabase.ensureAuthorityKey}
   * at genesis) or the schema's `Strand.Authorized` constraint rejects the write.
   * Failing loudly here is intentional: a silently-unpublished strand would run
   * as a local-only island that no peer could ever discover or join.
   *
   * @param strandId - Unique strand identifier (typically the same id passed to
   *   {@link addStrand}).
   * @param type - `'o'` for open (default) or `'c'` for closed.
   * @param memberPrivateKey - Optional membership key for a closed strand.
   * @throws if the node is not started, exposes no authority signing key, or the
   *   control DB rejects the (unauthorized) insert.
   */
  async publishStrand(strandId: string, type: 'o' | 'c' = 'o', memberPrivateKey?: string): Promise<void> {
    if (!this.running || !this.controlDatabase) {
      throw new Error('CadreNode must be started before publishing a strand');
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        `Cannot publish strand ${strandId}: no authority signing key available ` +
        '(config.privateKey is unset or does not match the node PeerId). Run authority ' +
        'genesis (ensureAuthorityKey + initializeSeedBootstrap) before publishing.'
      );
    }
    // insertStrand hands this callback the canonical row-bound message BYTES (see
    // buildAuthorizationMessage); ed25519-sign them directly (no pre-hash) with
    // the authority private key, returning a base64url signature.
    const signMessage = (message: Uint8Array): string =>
      sign(message, signingKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
    await this.controlDatabase.insertStrand(strandId, type, signingKey.publicKeyB64, signMessage, memberPrivateKey);
    log('Published strand %s (type %s) to control DB under authority %s', strandId, type, signingKey.publicKeyB64);
  }

  /**
   * Publish an authority-signed `FormationInvite` (open-invitation token) to the
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
   * Signs with the same self-authority key as {@link publishStrand} (the ed25519
   * key behind this node's PeerId, which must be an enrolled `AuthorityKey`).
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
    if (!this.running || !this.controlDatabase) {
      throw new Error('CadreNode must be started before publishing a formation invite');
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        `Cannot publish formation invite ${token}: no authority signing key available ` +
        '(config.privateKey is unset or does not match the node PeerId). Run authority ' +
        'genesis (ensureAuthorityKey + initializeSeedBootstrap) before publishing.'
      );
    }
    const signMessage = (message: Uint8Array): string =>
      sign(message, signingKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
    await this.controlDatabase.insertFormationInvite(token, sAppId, signingKey.publicKeyB64, signMessage, options);
    log('Published formation invite %s (sApp %s) under authority %s', token, sAppId, signingKey.publicKeyB64);
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
    explicitMode?: StrandMode
  ): Promise<StrandInstance> {
    const seed = await this.resolveCohortSeed();
    const mode = selectStrandMode(explicitMode, seed.hasOtherPeers);

    const instance = await this.strandManager.startStrand({
      strandRow: strand,
      sAppConfig,
      storage: this.config.storage,
      network: this.config.network,
      profile: this.config.profile,
      defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? 'interactive',
      privateKey: this.config.privateKey,
      bootstrapNodes: seed.bootstrapNodes,
      mode,
      requireSignedSchemas: this.config.requireSignedSchemas
    });

    this.hibernationManager.trackStrand(instance);
    this.emit('strand:started', { strandId: strand.Id });
    return instance;
  }

  /**
   * Derive the cohort discovery seed from the control network's CadrePeer rows,
   * excluding this node. Returns an empty seed when no control database exists.
   */
  private async resolveCohortSeed(): Promise<CohortSeed> {
    if (!this.controlDatabase) {
      return { bootstrapNodes: [], hasOtherPeers: false };
    }
    const peers = await this.controlDatabase.queryCadrePeers();
    return deriveCohortSeed(peers, this.controlNode?.peerId.toString());
  }

  /**
   * Remove a strand
   */
  async removeStrand(strandId: string): Promise<void> {
    if (!this.running) {
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
   * Record activity on a strand (resets hibernation timer)
   */
  recordStrandActivity(strandId: string): void {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      this.hibernationManager.recordActivity(instance);
    }
  }

  /**
   * Force wake a hibernating strand
   */
  async wakeStrand(strandId: string): Promise<void> {
    await this.hibernationManager.wakeStrand(strandId);
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
   * Initialize the seed bootstrap service with an authority key.
   * Must be called before using seed-related methods that require signing.
   *
   * @param authorityPrivateKey - The authority's private key (base64url encoded)
   */
  initializeSeedBootstrap(authorityPrivateKey: string): void {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before initializing seed bootstrap');
    }

    this.seedBootstrapService = new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      authorityPrivateKey,
      inviteAddressResolver: () => this.resolveInviteAddresses(),
      trustPolicy: this.config.seedTrustPolicy,
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
   */
  async isMember(peerId: string): Promise<boolean> {
    const members = await this.listMembers();
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
   * This is for drone nodes that need to receive seeds without being an authority.
   * Does not require an authority key.
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
      // No authority key - this node only receives seeds
      inviteAddressResolver: () => this.resolveInviteAddresses(),
      trustPolicy: this.config.seedTrustPolicy,
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
   * Signs the peer ID with the authority key and inserts into CadrePeer table.
   *
   * @param peerId - The peer ID to authorize
   * @param multiaddrs - Optional multiaddrs for the peer
   */
  async authorizePeer(peerId: string, multiaddrs?: string[]): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    await this.seedBootstrapService.authorizePeer({ peerId, multiaddrs });
  }

  /**
   * Remove a previously-authorized peer from the cadre.
   * Signs the peer ID with the authority key and deletes the CadrePeer row.
   *
   * @param peerId - The peer ID to remove
   */
  async removePeer(peerId: string): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    await this.seedBootstrapService.removePeer(peerId);
  }

  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an authority.
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
   * `CadreInvite.authorityKeys` — so a cold-start node can accept its first
   * seed without reconfiguring the service.
   */
  async applySeed(
    seed: ControlNetworkSeed,
    options?: { trustPolicy?: SeedTrustPolicy }
  ): Promise<ApplySeedResult> {
    if (!this.seedBootstrapService) {
      // Create a temporary service for applying seeds (doesn't need authority key).
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
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase, { registerHandler: false });
      }
      return await tempService.applySeed(seed, options);
    }
    return await this.seedBootstrapService.applySeed(seed, options);
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
    return await this.seedBootstrapService.addDrone(options);
  }

  /**
   * Create an invite for a phone to join the cadre.
   * Use when a server wants to invite a NAT'd phone.
   */
  async createInvite(token?: string, expiresIn?: number): Promise<InviteResult> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.createInvite(token, expiresIn);
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
   * Dial an authority from an invite (for phone joining via invite).
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

