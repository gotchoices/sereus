import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { Libp2p, PeerId } from '@libp2p/interface';
import { createLibp2pNode } from '@optimystic/db-p2p';
import type { IRepo } from '@optimystic/db-core';
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
  StrandFormationDisclosure
} from './types.js';
import { StrandWatcher, type StrandQueryable, type SAppIdLookup } from './strand-watcher.js';
import { StrandInstanceManager } from './strand-instance-manager.js';
import { EnrollmentService } from './enrollment.js';
import { HibernationManager, type HibernationCallbacks } from './hibernation-manager.js';
import { ControlDatabase } from './control-database.js';
import { SeedBootstrapService } from './seed-bootstrap.js';
import {
  StrandSolicitationService,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';
import {
  summarizeConnectionPaths,
  type ConnectionPathSummary
} from './diagnostics/connection-path.js';

const log = debug('sereus:cadre:node');
const timing = debug('sereus:cadre:timing');

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
  private controlNode: Libp2p | null = null;
  private controlDatabase: ControlDatabase | null = null;
  private strandWatcher: StrandWatcher | null = null;
  private strandManager: StrandInstanceManager;
  private hibernationManager: HibernationManager;
  private enrollmentService: EnrollmentService;
  private seedBootstrapService: SeedBootstrapService | null = null;
  private strandSolicitationService: StrandSolicitationService | null = null;
  private running = false;
  private eventHandlers: Map<keyof CadreNodeEvents, Set<EventHandler<any>>> = new Map();

  /** Map of strandId -> sAppConfig for sAppId filtering and management */
  private sAppConfigs: Map<string, SAppConfig> = new Map();

  /**
   * Most-recently pushed invite addresses (see {@link setInviteAddresses}).
   * When non-null these take priority over `libp2pNode.getMultiaddrs()` when
   * minting invites — the host pushes NAT-resolved addresses here so the
   * control-network node never needs to dial back to the manager.
   */
  private latestInviteAddresses: string[] | null = null;

  constructor(config: CadreNodeConfig) {
    this.config = config;
    this.strandManager = new StrandInstanceManager();
    this.enrollmentService = new EnrollmentService();

    // Create hibernation manager with callbacks
    const hibernationCallbacks: HibernationCallbacks = {
      onIdle: async (strandId) => this.handleStrandIdle(strandId),
      onHibernate: async (strandId) => this.handleStrandHibernate(strandId),
      onWake: async (strandId) => this.handleStrandWake(strandId)
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
      const coordinatedRepo = (this.controlNode as any).coordinatedRepo as IRepo;
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
      try { handler(data); } catch (e) { log('Event handler error: %o', e); }
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
   * Schedule self-registration in the CadrePeer table.
   * This runs as a background task after the node is started.
   */
  private scheduleSelfRegistration(): void {
    // Run in background - don't block start()
    setTimeout(async () => {
      try {
        await this.registerSelf();
      } catch (error) {
        log('Self-registration failed: %o', error);
        // Don't emit error event - this is a background task
        // The node can still function without self-registration
      }
    }, 1000); // Small delay to ensure node is fully started
  }

  /**
   * Register this peer in the CadrePeer table.
   * This allows other cadre members to discover this node.
   */
  private async registerSelf(): Promise<void> {
    if (!this.controlNode || !this.controlDatabase) {
      log('Cannot register self - node or database not initialized');
      return;
    }

    const peerId = this.controlNode.peerId.toString();
    const multiaddrs = this.controlNode.getMultiaddrs();

    if (multiaddrs.length === 0) {
      log('No multiaddrs available for self-registration');
      return;
    }

    // Use the first available multiaddr (typically the one with the peer ID)
    const multiaddr = multiaddrs[0]!.toString();

    log('Registering self: peerId=%s, multiaddr=%s', peerId, multiaddr);

    // TODO: This requires signing the update to satisfy the AuthorizedUpdate constraint
    // For now, we log what would happen. Full implementation requires:
    // 1. Either an authority key to authorize the insert
    // 2. Or the peer's private key to sign the update
    log('Self-registration requires authorization - skipping for now');
    // const db = this.controlDatabase.getDatabase();
    // await db.exec(
    //   'insert or replace into CadrePeer (PeerId, Multiaddr) values (?, ?)',
    //   [peerId, multiaddr]
    // );
  }

  private async handleStrandAdded(strand: StrandRow): Promise<void> {
    log('Handling strand added from control network: %s', strand.Id);

    // Check if we have sApp config for this strand
    const sAppConfig = this.sAppConfigs.get(strand.Id);
    if (!sAppConfig) {
      log('No sAppConfig registered for strand %s - skipping auto-start', strand.Id);
      // Strand detected in control network but not yet configured via addStrand
      // This is normal - the app will call addStrand with the config
      return;
    }

    try {
      const instance = await this.strandManager.startStrand({
        strandRow: strand,
        sAppConfig,
        storage: this.config.storage,
        network: this.config.network,
        profile: this.config.profile,
        defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? 'interactive',
        privateKey: this.config.privateKey
      });

      // Register with hibernation manager
      this.hibernationManager.trackStrand(instance);

      this.emit('strand:started', { strandId: strand.Id });
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
    // Stop hibernation manager
    this.hibernationManager.stop();

    // Stop seed bootstrap service
    if (this.seedBootstrapService) {
      await this.seedBootstrapService.shutdown();
      this.seedBootstrapService = null;
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

  private async handleStrandHibernate(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = 'hibernating';

      // Optionally disconnect libp2p to save resources
      // For now we keep it connected but could stop it here
      log('Strand %s transitioned to hibernating', strandId);
      this.emit('strand:hibernating', { strandId });
    }
  }

  private async handleStrandWake(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = 'active';
      instance.lastActivity = new Date();
      log('Strand %s woke up', strandId);
      this.emit('strand:waking', { strandId });
    }
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
    log('Registered sAppConfig for strand %s (sApp: %s, mode: %s)', strandRow.Id, sAppConfig.id, mode ?? 'networked');

    const instance = await this.strandManager.startStrand({
      strandRow,
      sAppConfig,
      storage: this.config.storage,
      network: this.config.network,
      profile: this.config.profile,
      defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? 'interactive',
      privateKey: this.config.privateKey,
      mode
    });

    // Register with hibernation manager
    this.hibernationManager.trackStrand(instance);

    this.emit('strand:started', { strandId: strandRow.Id });
    return instance;
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
   * Validates the seed signature before applying.
   */
  async applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
    if (!this.seedBootstrapService) {
      // Create a temporary service for applying seeds (doesn't need authority key)
      const tempService = new SeedBootstrapService({
        partyId: seed.partyId,
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase);
      }
      return await tempService.applySeed(seed);
    }
    return await this.seedBootstrapService.applySeed(seed);
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
      // Create a temporary service for dialing
      const tempService = new SeedBootstrapService({
        partyId: invite.partyId,
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase);
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

