import debug from 'debug';

import {
  NatError,
  type DdnsProviderInfo,
  type ManualForwardPatch,
  type NatDdnsStatus,
  type NatGatewayStatus,
  type NatHandlers,
  type NatSettingsFile,
  type NatStatusSnapshot,
  type NodeReachability,
  type PortKind,
  type PortRoute,
} from './types.js';
import { NatStore } from './nat-store.js';
import { ExternalIpDetector, type ExternalIpResult } from './external-ip.js';
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_REFRESH_MS,
  GATEWAY_DISCOVERY_TIMEOUT_MS,
  UpnpPortMapper,
  type PortMapper,
} from './port-mapper.js';
import { evaluateHostReachability, evaluateNodeReachability } from './reachability.js';
import { DdnsUpdater } from './ddns/updater.js';
import { getProvider, listProviders } from './ddns/index.js';
import { buildPublicAddresses, isPublicIpv4 } from './address-resolver.js';
import { createSecretsStore, ddnsAccount, type SecretsStore } from './secrets/index.js';
import { AddressWatch, type NodeAddressesStaleListener } from './address-watch.js';
import type { ManagedNodeInfo, NodeStateListener } from '../orchestrator/types.js';

const log = debug('cadre:host:nat-service');

/**
 * How long a node may sit `stopped` before its mappings are released. Longer
 * than the donation supervisor's whole respawn backoff (150 s), so a crash
 * followed by a respawn keeps its mapping.
 */
export const NAT_UNMAP_GRACE_MS = 3 * 60_000;

/** The backstop reconcile cadence; state-change events trigger passes between ticks. */
export const NAT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * How often the external IP is re-detected, and how often gateway discovery is
 * retried while UPnP is on and no router has answered.
 */
export const NAT_IP_REDETECT_INTERVAL_MS = 5 * 60_000;

/**
 * The orchestrator surface the service needs: the node list and cadre-host's
 * own state-change subscription. `HostProcessOrchestrator` satisfies this; the
 * donation supervisor declares the same slice.
 */
export interface NatNodeSource {
  listNodes(): ManagedNodeInfo[];
  onStateChange(listener: NodeStateListener): () => void;
}

/** Listener notified when the status snapshot changed in a way the UI should follow. */
export type NatChangeListener = (snapshot: NatStatusSnapshot) => void;

export interface NatServiceOptions {
  /** Cadre-host root directory (same one the orchestrator + grant store use). */
  rootDir: string;
  /** Where the hosted nodes and their ports come from. */
  nodeSource: NatNodeSource;
  /** Clock override for tests. */
  now?: () => Date;
  /** Fetch override for tests. */
  fetch?: typeof fetch;
  /** Test-only: stub the keytar/file-store. Default: createSecretsStore. */
  secretsStore?: SecretsStore;
  /** Test-only: stub the router. Default: `UpnpPortMapper`. */
  portMapper?: PortMapper;
  /** Test-only: stub the external-IP detector. */
  externalIpDetector?: ExternalIpDetector;
  /** Optional: re-use an existing NatStore (mostly for tests). */
  store?: NatStore;
  /** Lease TTL asked of the router. Default 1 h. */
  leaseTtlMs?: number;
}

/** A node's two mapped ports — `tcp` is `NodePorts.p2p`, `ws` is `NodePorts.ws`. */
interface NodePortPair {
  tcp: number;
  /** Null for a handle persisted by an older build without a WebSocket port. */
  ws: number | null;
}

/** One row of the mapping table. */
interface NodeEntry {
  nodeId: string;
  running: boolean;
  /** When the node was first seen stopped (ms since epoch); null while running. */
  stoppedSince: number | null;
  ports: NodePortPair;
  routes: { tcp: PortRoute; ws: PortRoute | null };
}

const PORT_KINDS: ReadonlyArray<PortKind> = ['tcp', 'ws'];

function noRoute(internalPort: number): PortRoute {
  return { internalPort, externalPort: null, source: null, leaseExpiresAt: null, error: null };
}

function manualRoute(internalPort: number, externalPort: number): PortRoute {
  return { internalPort, externalPort, source: 'manual', leaseExpiresAt: null, error: null };
}

function portsOf(ports: { p2p: number; ws?: number }): NodePortPair {
  // A handle read back from an older `state.json` lacks `ws` whatever the type says.
  const ws = typeof ports.ws === 'number' ? ports.ws : null;
  return { tcp: ports.p2p, ws };
}

function samePorts(a: NodePortPair, b: NodePortPair): boolean {
  return a.tcp === b.tcp && a.ws === b.ws;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * NatService — one mapping table for every node the host runs, keyed by node
 * id, with a route per port (TCP and WebSocket); external-IP detection; DDNS;
 * and the public addresses a node announces.
 *
 * Lifecycle:
 *   - `start()`: load settings, discover the router (bounded), detect the
 *     external IP, start DDNS, then map the running nodes in the background.
 *   - `stop()`: clear timers only — mappings outlive the host process.
 *   - `getStatus()`: snapshot from cached state (cheap).
 *   - `publicAddressesFor(nodeId, ports)`: a node's public multiaddrs, also
 *     from cached state, predicting the identity mapping for a port that has
 *     no route yet.
 *   - `onNodeAddressesStale(listener)`: asked to restart a running node whose
 *     announced addresses no longer match `publicAddressesFor`, checked after
 *     every pass and every settings write (see `AddressWatch`).
 *
 * One reconcile pass against the node source behind three triggers (start,
 * node state change, a 1-minute timer), plus one renewal pass for every lease
 * every `DEFAULT_REFRESH_MS`. Passes are serialized on one promise tail, so a
 * state change during a timer pass can neither map a port twice nor unmap a
 * port the other pass is mapping.
 *
 * NOTE: this file holds the settings/DDNS glue, the mapping table and the status
 * assembly together (about 890 lines; the stale-address check lives in
 * `address-watch.ts` for that reason); when the next capability lands here, move
 * the mapping table (`NodeEntry` through `releaseUpnpRoutes`) into its own module.
 */
export class NatService {
  private readonly nodeSource: NatNodeSource;
  private readonly store: NatStore;
  private readonly nowFn: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly portMapper: PortMapper;
  private readonly leaseTtlMs: number;
  private readonly secretsRootDir: string;

  private secretsStore: SecretsStore | null;
  /** Caller-supplied detector — used as-is when present (skips the router-probe stitch). */
  private readonly injectedDetector: ExternalIpDetector | null;
  private detector: ExternalIpDetector | null = null;
  private ddnsUpdater: DdnsUpdater | null = null;

  private currentSettings: NatSettingsFile;
  private gateway: NatGatewayStatus = { found: false, lanAddress: null, routerExternalIp: null, lastError: null };
  private latestIp: ExternalIpResult | null = null;
  private lastTestedAt: Date | null = null;
  private readonly table = new Map<string, NodeEntry>();

  private started = false;
  private tail: Promise<void> = Promise.resolve();
  /** True while an event-triggered pass is queued and not yet started (crash storms coalesce into it). */
  private eventPassQueued = false;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;

  private readonly changeListeners = new Set<NatChangeListener>();
  private lastSignature: string | null = null;
  private readonly addressWatch: AddressWatch;

  constructor(opts: NatServiceOptions) {
    this.nodeSource = opts.nodeSource;
    this.store = opts.store ?? new NatStore(opts.rootDir);
    this.nowFn = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch ?? fetch;
    this.portMapper = opts.portMapper ?? new UpnpPortMapper();
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.secretsStore = opts.secretsStore ?? null;
    this.injectedDetector = opts.externalIpDetector ?? null;
    this.secretsRootDir = opts.rootDir;
    this.currentSettings = this.store.load();
    this.addressWatch = new AddressWatch(() => this.nowFn().getTime());
  }

  // --- lifecycle ---

  /**
   * Discover the router and detect the external IP (both awaited, both
   * bounded), start DDNS, then map re-attached running nodes in the background
   * so the management API comes up promptly. Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.secretsStore) {
      this.secretsStore = await createSecretsStore(this.secretsRootDir);
    }
    if (this.currentSettings.upnpEnabled) await this.discoverGateway();
    await this.detectIp();

    this.ddnsUpdater = new DdnsUpdater({
      settings: this.currentSettings.ddns,
      secrets: this.secretsStore,
      getExternalIp: () => this.detectedIp(),
      fetch: this.fetchImpl,
      now: this.nowFn,
    });
    await this.ddnsUpdater.start();

    // Subscribe before the first pass so a spawn during it is not missed.
    this.unsubscribe = this.nodeSource.onStateChange(() => { this.queueEventPass(); });
    this.timers = [
      setInterval(() => { this.sweep('reconcile', () => this.reconcile()); }, NAT_RECONCILE_INTERVAL_MS),
      setInterval(() => { this.sweep('renewal', () => this.renewMappings()); }, DEFAULT_REFRESH_MS),
      setInterval(() => { this.sweep('probe', () => this.redetect()); }, NAT_IP_REDETECT_INTERVAL_MS),
    ];
    for (const t of this.timers) t.unref();

    this.sweep('startup', () => this.reconcile());
  }

  /**
   * Clear timers and release client resources. Idempotent.
   *
   * NOTE: deliberately unmaps nothing. Hosted children are detached and keep
   * running across a host restart (an update restart included), so their
   * mappings must outlive this process; they expire on their own within the
   * lease TTL if the host stays down, and the next `start()` re-maps the
   * re-attached nodes (re-mapping the same internal port is idempotent on the
   * router).
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.ddnsUpdater?.stop();
    } catch (err) {
      log('ddns stop failed: %s', errorMessage(err));
    }
    this.ddnsUpdater = null;
    try {
      await this.portMapper.stop();
    } catch (err) {
      log('port mapper stop failed: %s', errorMessage(err));
    }
  }

  // --- reads ---

  /** Cheap read of the current snapshot. */
  getStatus(): NatStatusSnapshot {
    const cgnatDetected = this.latestIp?.cgnat ?? false;
    const nodes = [...this.table.values()]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map((entry) => this.describeNode(entry, cgnatDetected));
    return {
      upnpEnabled: this.currentSettings.upnpEnabled,
      gateway: { ...this.gateway, routerExternalIp: this.latestIp?.routerIp ?? null },
      externalIp: this.detectedIp(),
      externalIpDetectedAt: this.latestIp?.detectedAt.toISOString() ?? null,
      cgnatDetected,
      directReachability: evaluateHostReachability(nodes, cgnatDetected),
      lastTestedAt: this.lastTestedAt?.toISOString() ?? null,
      ddns: this.ddnsStatus(),
      nodes,
    };
  }

  /** Current settings (cheap read; for handlers to surface to UI). */
  getSettings(): NatSettingsFile {
    return this.currentSettings;
  }

  /**
   * The public multiaddrs for a node, from cached state. A port with no route
   * yet is predicted to land on the identity mapping when UPnP is enabled and
   * a gateway was discovered — callers ask at spawn time, before the mapping
   * for a brand-new node exists. A port whose mapping attempt failed is not
   * predicted.
   */
  publicAddressesFor(nodeId: string, ports: { p2p: number; ws?: number }): string[] {
    const pair = portsOf(ports);
    const entry = this.table.get(nodeId);
    const tcp = this.routeOrPrediction(nodeId, 'tcp', pair.tcp, entry);
    const ws = pair.ws === null ? null : this.routeOrPrediction(nodeId, 'ws', pair.ws, entry);
    return this.addressesFor(tcp, ws);
  }

  /**
   * Register a listener fired whenever a node's routes, the gateway, the
   * external IP, the CGNAT flag, the UPnP toggle or the DDNS settings change.
   * Returns an unsubscribe fn.
   */
  onChange(listener: NatChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  /**
   * Register a listener asked to restart a running node whose announced addresses
   * (`ManagedNodeInfo.announcedAddrs`) differ from `publicAddressesFor` — at most
   * once per node per `NAT_ADDRESS_RESTART_MIN_INTERVAL_MS`. Returns an unsubscribe fn.
   */
  onNodeAddressesStale(listener: NodeAddressesStaleListener): () => void {
    return this.addressWatch.subscribe(listener);
  }

  /** List available DDNS providers (UI listing for configuration). */
  listDdnsProviders(): DdnsProviderInfo[] {
    return listProviders().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      configFields: p.configFields,
    }));
  }

  // --- passes (public so tests and `testReachability` can drive them) ---

  /**
   * One reconcile pass against the node source: map running nodes, release
   * nodes stopped past the grace, forget terminated ones. Serialized against
   * every other pass, so a caller may get a queued pass rather than an
   * immediate one.
   */
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileOnce({ mapMissing: true }));
  }

  /**
   * One renewal pass: re-request every UPnP-eligible mapping of every running
   * node, failed ones included. Each renewal is isolated; one failure does not
   * stop the pass. A router that answers with another external port updates
   * the route.
   */
  renewMappings(): Promise<void> {
    return this.enqueue(() => this.renewOnce());
  }

  /**
   * The 5-minute probe pass: while UPnP is on and no router has answered,
   * search again and map the running nodes as soon as one does — a host that
   * boots before its network, or a router that comes up later, is found here
   * rather than at the next restart; then re-detect the external IP.
   */
  async redetect(): Promise<void> {
    if (this.currentSettings.upnpEnabled && !this.gateway.found) {
      await this.enqueue(async () => {
        await this.discoverGateway();
        if (this.gateway.found) await this.reconcileOnce({ mapMissing: true });
      });
    }
    await this.detectIp();
    this.publish();
  }

  // --- writes ---

  /** Re-discover the router if needed, re-map everything, re-detect the IP, then return a fresh snapshot. */
  async testReachability(): Promise<NatStatusSnapshot> {
    await this.enqueue(async () => {
      if (this.currentSettings.upnpEnabled && !this.gateway.found) await this.discoverGateway();
      await this.reconcileOnce({ mapMissing: false });
      await this.renewOnce();
    });
    await this.detectIp();
    this.lastTestedAt = this.nowFn();
    if (this.ddnsUpdater) {
      await this.ddnsUpdater.forceUpdate().catch((err) => log('ddns forceUpdate err: %s', errorMessage(err)));
    }
    this.publish();
    return this.getStatus();
  }

  /** Replace settings; persists to disk and reconfigures the runtime. */
  async putSettings(patch: Partial<Omit<NatSettingsFile, 'version' | 'forwards'>>): Promise<NatStatusSnapshot> {
    const next = this.store.update(patch);
    const upnpChanged = next.upnpEnabled !== this.currentSettings.upnpEnabled;
    const ddnsChanged =
      next.ddns.providerId !== this.currentSettings.ddns.providerId ||
      next.ddns.hostname !== this.currentSettings.ddns.hostname ||
      next.ddns.externallyManaged !== this.currentSettings.ddns.externallyManaged ||
      next.ddns.intervalMs !== this.currentSettings.ddns.intervalMs;
    this.currentSettings = next;

    if (this.started) {
      if (ddnsChanged && this.ddnsUpdater) {
        await this.ddnsUpdater.updateSettings(next.ddns);
      }
      if (upnpChanged) {
        // Turning UPnP on with no gateway known yet: look for one before the
        // pass, so the pass can map. Turning it off: the pass releases every
        // `upnp` route and keeps the manual ones.
        await this.enqueue(async () => {
          if (next.upnpEnabled && !this.gateway.found) await this.discoverGateway();
          await this.reconcileOnce({ mapMissing: true });
        });
      }
    }
    this.publish();
    return this.getStatus();
  }

  /**
   * Set DDNS configuration and persist secret values into the SecretsStore.
   * Throws if the provider is unknown or required secrets are missing.
   */
  async putDdns(body: {
    providerId: string;
    hostname: string;
    config: Record<string, string>;
    externallyManaged?: boolean;
  }): Promise<NatStatusSnapshot> {
    if (!body || typeof body.providerId !== 'string' || typeof body.hostname !== 'string') {
      throw new NatError('invalid_config', 'providerId and hostname are required');
    }
    const provider = getProvider(body.providerId);
    if (!this.secretsStore) {
      throw new NatError('secrets_unavailable', 'secrets store not initialised; call start() first');
    }

    for (const field of provider.configFields) {
      if (!field.secret) continue;
      const value = body.config[field.key];
      if (typeof value !== 'string' || value.length === 0) {
        throw new NatError(
          'ddns_credentials_missing',
          `Missing value for required secret field "${field.key}" of provider "${provider.id}"`,
        );
      }
      await this.secretsStore.set(ddnsAccount(provider.id, field.key), value);
    }

    const externallyManaged = body.externallyManaged ?? false;
    return await this.putSettings({
      ddns: {
        providerId: provider.id,
        hostname: body.hostname,
        externallyManaged,
        intervalMs: this.currentSettings.ddns.intervalMs,
      },
    });
  }

  /**
   * Record the external ports the user forwarded by hand for one node (`null`
   * clears a port). A port that became manual releases its UPnP mapping; a
   * port whose entry was cleared is re-requested over UPnP.
   */
  async putForward(nodeId: string, patch: ManualForwardPatch): Promise<NatStatusSnapshot> {
    validateForwardPatch(patch);
    if (!this.nodeSource.listNodes().some((n) => n.id === nodeId)) {
      throw new NatError('unknown_node', `no hosted node with id "${nodeId}"`);
    }
    this.currentSettings = this.store.setForward(nodeId, patch);
    if (this.started) await this.reconcile();
    this.publish();
    return this.getStatus();
  }

  // --- reconcile internals ---

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // The stored tail swallows outcomes — a failed pass must not reject the
    // next caller's wait, only sequence after it.
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Fire-and-forget pass for the timer / event / startup triggers. */
  private sweep(trigger: string, run: () => Promise<void>): void {
    void run().catch((err) => { log('%s pass failed: %s', trigger, errorMessage(err)); });
  }

  /**
   * One pass per burst of events: an event while a pass is queued joins it,
   * and an event during a running pass queues exactly one more, so a node that
   * spawned after the running pass listed the nodes is mapped by the next pass
   * rather than by the timer.
   */
  private queueEventPass(): void {
    if (this.eventPassQueued) return;
    this.eventPassQueued = true;
    void this.enqueue(() => {
      this.eventPassQueued = false;
      return this.reconcileOnce({ mapMissing: true });
    }).catch((err) => { log('event pass failed: %s', errorMessage(err)); });
  }

  private async reconcileOnce(opts: { mapMissing: boolean }): Promise<void> {
    if (!this.started) return;
    const listed = new Map(this.nodeSource.listNodes().map((n) => [n.id, n]));
    await this.forgetMissingNodes(listed);
    for (const node of listed.values()) {
      if (!this.started) break;
      try {
        await this.reconcileNode(node, opts.mapMissing);
      } catch (err) {
        // One bad node must never end the pass — the others still need their routes.
        log('reconcile of node %s failed: %s', node.id, errorMessage(err));
      }
    }
    this.publish();
  }

  /**
   * A node no longer listed was terminated (`removeContainer`): release its
   * mappings at once and drop its manual forward. A forward left behind for a
   * node that vanished while the host was down goes the same way.
   */
  private async forgetMissingNodes(listed: Map<string, ManagedNodeInfo>): Promise<void> {
    for (const [nodeId, entry] of this.table) {
      if (listed.has(nodeId)) continue;
      await this.releaseUpnpRoutes(entry);
      this.table.delete(nodeId);
    }
    for (const nodeId of Object.keys(this.currentSettings.forwards)) {
      if (listed.has(nodeId)) continue;
      this.currentSettings = this.store.deleteForward(nodeId);
    }
  }

  private async reconcileNode(node: ManagedNodeInfo, mapMissing: boolean): Promise<void> {
    const ports = portsOf(node.ports);
    let entry = this.table.get(node.id);
    if (entry && !samePorts(entry.ports, ports)) {
      // Ports changed across a respawn: the old mappings point at ports nothing binds.
      await this.releaseUpnpRoutes(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        nodeId: node.id,
        running: false,
        stoppedSince: null,
        ports,
        routes: { tcp: noRoute(ports.tcp), ws: ports.ws === null ? null : noRoute(ports.ws) },
      };
      this.table.set(node.id, entry);
    }
    if (node.status === 'running') {
      entry.running = true;
      entry.stoppedSince = null;
      await this.reconcileRoutes(entry, mapMissing);
      return;
    }
    entry.running = false;
    entry.stoppedSince ??= this.nowFn().getTime();
    if (this.nowFn().getTime() - entry.stoppedSince >= NAT_UNMAP_GRACE_MS) {
      await this.releaseUpnpRoutes(entry);
    }
    // Manual forwards still follow the settings while the node is down; no router call is needed.
    await this.reconcileRoutes(entry, false);
  }

  /**
   * Bring one node's routes in line with the settings: manual wins over UPnP;
   * UPnP off releases every `upnp` route; with `mapMissing`, a port with no
   * route and no recorded failure (or an expired lease) is requested.
   */
  private async reconcileRoutes(entry: NodeEntry, mapMissing: boolean): Promise<void> {
    for (const kind of this.kindsOf(entry)) {
      const route = entry.routes[kind]!;
      const forward = this.currentSettings.forwards[entry.nodeId]?.[kind];
      if (forward !== undefined) {
        if (route.source === 'upnp') await this.unmapRoute(entry, kind);
        entry.routes[kind] = manualRoute(route.internalPort, forward);
        continue;
      }
      if (route.source === 'manual') {
        entry.routes[kind] = noRoute(route.internalPort);
      }
      if (!this.currentSettings.upnpEnabled) {
        if (entry.routes[kind]!.source === 'upnp') await this.unmapRoute(entry, kind);
        entry.routes[kind] = noRoute(route.internalPort);
        continue;
      }
      if (!mapMissing || !this.gateway.found) continue;
      const current = entry.routes[kind]!;
      const untried = current.source === null && current.error === null;
      if (untried || this.leaseExpired(current)) {
        await this.mapRoute(entry, kind);
      }
    }
  }

  private async renewOnce(): Promise<void> {
    if (!this.started) return;
    if (!this.currentSettings.upnpEnabled || !this.gateway.found) return;
    for (const entry of this.table.values()) {
      if (!this.started) break;
      if (!entry.running) continue;
      for (const kind of this.kindsOf(entry)) {
        if (entry.routes[kind]!.source === 'manual') continue;
        await this.mapRoute(entry, kind);
      }
    }
    this.publish();
  }

  /**
   * Ask the router for one port. A refusal records `error` on that port only.
   *
   * NOTE: a router that stops answering costs each attempt its 10 s timeout, so a
   * pass over N mapped ports can take 10 s × N; passes are serialized, so they queue
   * rather than overlap. If that ever shows, skip ports whose last failure was a
   * timeout until the next renewal pass.
   */
  private async mapRoute(entry: NodeEntry, kind: PortKind): Promise<void> {
    const previous = entry.routes[kind]!;
    const internalPort = previous.internalPort;
    try {
      const result = await this.portMapper.map({ internalPort, protocol: 'tcp', ttlMs: this.leaseTtlMs });
      entry.routes[kind] = {
        internalPort,
        externalPort: result.externalPort,
        source: 'upnp',
        leaseExpiresAt: result.leaseExpiresAt.toISOString(),
        error: null,
      };
      log('mapped %s %s port %d → external %d', entry.nodeId, kind, internalPort, result.externalPort);
    } catch (err) {
      const message = errorMessage(err);
      // A failed renewal of a live mapping keeps the route: the router still
      // holds it until the lease expires, and `leaseExpired` drops it then.
      const live = previous.source === 'upnp' && !this.leaseExpired(previous);
      entry.routes[kind] = live ? { ...previous, error: message } : { ...noRoute(internalPort), error: message };
      log('mapping %s %s port %d failed: %s', entry.nodeId, kind, internalPort, message);
    }
  }

  private async unmapRoute(entry: NodeEntry, kind: PortKind): Promise<void> {
    const route = entry.routes[kind]!;
    await this.portMapper.unmap(route.internalPort, 'tcp');
    entry.routes[kind] = noRoute(route.internalPort);
    log('unmapped %s %s port %d', entry.nodeId, kind, route.internalPort);
  }

  private async releaseUpnpRoutes(entry: NodeEntry): Promise<void> {
    for (const kind of this.kindsOf(entry)) {
      if (entry.routes[kind]!.source === 'upnp') await this.unmapRoute(entry, kind);
    }
  }

  private kindsOf(entry: NodeEntry): PortKind[] {
    return PORT_KINDS.filter((kind) => entry.routes[kind] !== null);
  }

  private leaseExpired(route: PortRoute): boolean {
    if (route.source !== 'upnp' || !route.leaseExpiresAt) return false;
    return Date.parse(route.leaseExpiresAt) <= this.nowFn().getTime();
  }

  /** A UPnP route whose lease ran out reads as no route, keeping any recorded failure. */
  private effectiveRoute(route: PortRoute): PortRoute {
    if (!this.leaseExpired(route)) return route;
    return { ...noRoute(route.internalPort), error: route.error };
  }

  // --- gateway / external IP ---

  private async discoverGateway(): Promise<void> {
    try {
      const info = await this.portMapper.discover();
      this.gateway = info
        ? { found: true, lanAddress: info.lanAddress, routerExternalIp: null, lastError: null }
        : {
            found: false,
            lanAddress: null,
            routerExternalIp: null,
            lastError: `no UPnP gateway answered within ${GATEWAY_DISCOVERY_TIMEOUT_MS / 1000} s`,
          };
    } catch (err) {
      this.gateway = { found: false, lanAddress: null, routerExternalIp: null, lastError: errorMessage(err) };
    }
    if (!this.gateway.found) log('gateway discovery: %s', this.gateway.lastError);
  }

  /**
   * Detect the external IP. A detection that finds nothing (or throws), or that
   * lost the public echo the previous one had, keeps the previous result: one
   * failed probe must not drop every node's public address, and a router-only
   * answer must not flip the CGNAT flag the two probes had agreed on.
   */
  private async detectIp(): Promise<void> {
    try {
      const result = await this.ipDetector().detect();
      if (this.knowsLessThanPrevious(result)) {
        log('external IP detection found less than before; keeping the previous result');
        return;
      }
      this.latestIp = result;
    } catch (err) {
      log('detectIp failed: %s', errorMessage(err));
    }
  }

  private knowsLessThanPrevious(result: ExternalIpResult): boolean {
    if (result.publicIp === null && result.routerIp === null) return true;
    return result.publicIp === null && this.latestIp?.publicIp != null;
  }

  private ipDetector(): ExternalIpDetector {
    if (this.injectedDetector) return this.injectedDetector;
    this.detector ??= new ExternalIpDetector({
      fetch: this.fetchImpl,
      now: this.nowFn,
      routerProbe: async () => (this.gateway.found ? await this.portMapper.externalIp() : null),
    });
    return this.detector;
  }

  /** The detected external IP for display and DDNS: the public probe's, else the router's. */
  private detectedIp(): string | null {
    return this.latestIp?.publicIp ?? this.latestIp?.routerIp ?? null;
  }

  /** The IP used in `/ip4/` addresses: only a public IPv4 counts. */
  private publicIpv4(): string | null {
    const ip = this.detectedIp();
    return ip && isPublicIpv4(ip) ? ip : null;
  }

  // --- status assembly ---

  private describeNode(entry: NodeEntry, cgnatDetected: boolean): NodeReachability {
    const tcp = this.effectiveRoute(entry.routes.tcp);
    const ws = entry.routes.ws ? this.effectiveRoute(entry.routes.ws) : null;
    const { verdict, reason } = evaluateNodeReachability({
      tcp,
      ws,
      hostKnown: this.hostKnown(),
      cgnatDetected,
      upnpEnabled: this.currentSettings.upnpEnabled,
      gatewayFound: this.gateway.found,
      lanAddress: this.gateway.lanAddress,
    });
    return {
      nodeId: entry.nodeId,
      running: entry.running,
      verdict,
      reason,
      tcp,
      ws,
      publicAddrs: this.addressesFor(tcp, ws),
    };
  }

  private hostKnown(): boolean {
    return this.currentSettings.ddns.hostname !== null || this.publicIpv4() !== null;
  }

  private addressesFor(tcp: PortRoute, ws: PortRoute | null): string[] {
    return buildPublicAddresses({
      ddnsHostname: this.currentSettings.ddns.hostname,
      externalIp: this.publicIpv4(),
      cgnatDetected: this.latestIp?.cgnat ?? false,
      tcp,
      ws,
    });
  }

  private routeOrPrediction(nodeId: string, kind: PortKind, internalPort: number, entry: NodeEntry | undefined): PortRoute {
    const forward = this.currentSettings.forwards[nodeId]?.[kind];
    if (forward !== undefined) return manualRoute(internalPort, forward);
    const existing = entry?.routes[kind];
    if (existing && existing.internalPort === internalPort) {
      const route = this.effectiveRoute(existing);
      if (route.source !== null || route.error !== null) return route;
    }
    if (this.currentSettings.upnpEnabled && this.gateway.found) {
      return { internalPort, externalPort: internalPort, source: 'upnp', leaseExpiresAt: null, error: null };
    }
    return noRoute(internalPort);
  }

  private ddnsStatus(): NatDdnsStatus {
    return this.ddnsUpdater?.getStatus() ?? {
      providerId: this.currentSettings.ddns.providerId,
      hostname: this.currentSettings.ddns.hostname,
      externallyManaged: this.currentSettings.ddns.externallyManaged,
      lastUpdateAt: null,
      lastUpdateOk: null,
      lastError: null,
    };
  }

  // --- change notification ---

  /**
   * The end of every pass and every settings write: tell the change listeners
   * when the snapshot moved, then ask for a restart of every running node whose
   * announced addresses went stale. Running the check here rather than only on a
   * change is what lets a difference deferred by the restart rate limit fire on the
   * first timer pass after the limit ends.
   */
  private publish(): void {
    this.notifyIfChanged();
    if (!this.started) return;
    this.addressWatch.check(this.nodeSource.listNodes(), (node) => this.publicAddressesFor(node.id, node.ports));
  }

  /** Fire the change listeners when the snapshot differs (timestamps aside) from the last one they saw. */
  private notifyIfChanged(): void {
    const snapshot = this.getStatus();
    const signature = signatureOf(snapshot);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.changeListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        log('change listener threw: %s', errorMessage(err));
      }
    }
  }
}

/** The snapshot minus the fields that move on their own (timestamps, lease expiry). */
function signatureOf(s: NatStatusSnapshot): string {
  return JSON.stringify({
    upnpEnabled: s.upnpEnabled,
    gateway: s.gateway,
    externalIp: s.externalIp,
    cgnatDetected: s.cgnatDetected,
    directReachability: s.directReachability,
    ddns: { providerId: s.ddns.providerId, hostname: s.ddns.hostname, externallyManaged: s.ddns.externallyManaged },
    nodes: s.nodes.map((n) => ({
      nodeId: n.nodeId,
      running: n.running,
      verdict: n.verdict,
      tcp: routeSignature(n.tcp),
      ws: n.ws ? routeSignature(n.ws) : null,
      publicAddrs: n.publicAddrs,
    })),
  });
}

function routeSignature(r: PortRoute): Omit<PortRoute, 'leaseExpiresAt'> {
  return { internalPort: r.internalPort, externalPort: r.externalPort, source: r.source, error: r.error };
}

function validateForwardPatch(patch: ManualForwardPatch): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new NatError('invalid_config', 'a forward patch must be an object with tcp and/or ws');
  }
  for (const kind of PORT_KINDS) {
    const value = patch[kind];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new NatError('invalid_config', `${kind} must be an integer 1-65535 or null, got ${String(value)}`);
    }
  }
}

/**
 * Wrap a NatService into the typed handler shape consumed by the local UI
 * server. Same shape as `createStrandHandlers`.
 */
export function createNatHandlers(service: NatService): NatHandlers {
  return {
    async getStatus() { return service.getStatus(); },
    async testReachability() { return await service.testReachability(); },
    async listDdnsProviders() { return service.listDdnsProviders(); },
    async putDdns(body) { return await service.putDdns(body); },
    async putSettings(body) { return await service.putSettings(body); },
    async putForward(nodeId, patch) { return await service.putForward(nodeId, patch); },
  };
}
