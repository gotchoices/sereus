import debug from 'debug';

import {
  NatError,
  type DdnsProviderInfo,
  type NatDdnsStatus,
  type NatHandlers,
  type NatSettingsFile,
  type NatStatusSnapshot,
} from './types.js';
import { NatStore } from './nat-store.js';
import { ExternalIpDetector, type ExternalIpResult } from './external-ip.js';
import {
  PortMapperService,
  createDefaultPortMapper,
  type PortMapper,
  type PortMapperState,
} from './port-mapper.js';
import { evaluateReachability } from './reachability.js';
import { DdnsUpdater } from './ddns/updater.js';
import { getProvider, listProviders } from './ddns/index.js';
import {
  buildInviteAddresses,
  type BuildInviteAddressesInput,
} from './address-resolver.js';
import { createSecretsStore, ddnsAccount, type SecretsStore } from './secrets/index.js';

const log = debug('cadre:host:nat-service');

/**
 * Minimal slice of CadreNode that NatService needs — defined as an interface
 * so tests can inject a mock without a real libp2p stack. Mirrors
 * `CadreNodeLike` in `auth/trust-circle.ts`.
 */
export interface CadreNodeLike {
  /** Returns this node's peer ID (libp2p) as a string. */
  getPeerId(): string;
  /** Returns the current observed multiaddrs from libp2p. */
  getMultiaddrs(): string[];
}

export interface NatServiceOptions {
  /** Cadre-host root directory (same one orchestrator + trust-circle use). */
  rootDir: string;
  /** libp2p node — used for peer ID and the libp2p multiaddrs fallback. */
  cadreNode: CadreNodeLike;
  /** Clock override for tests. */
  now?: () => Date;
  /** Fetch override for tests. */
  fetch?: typeof fetch;
  /** Test-only: stub the keytar/file-store. Default: createSecretsStore. */
  secretsStore?: SecretsStore;
  /** Test-only: stub the port mapper. Default: createDefaultPortMapper(). */
  portMapper?: PortMapper;
  /** Test-only: stub the external-IP detector. */
  externalIpDetector?: ExternalIpDetector;
  /** Optional: re-use an existing NatStore (mostly for tests). */
  store?: NatStore;
}

/**
 * NatService — orchestrates port mapping, external-IP detection, DDNS updates,
 * and address resolution for invites.
 *
 * Lifecycle:
 *   - `start()`: load settings, install port mapping (if upnpEnabled), detect
 *     external IP, kick off DDNS loop.
 *   - `stop()`: release port mapping, stop DDNS timer.
 *   - `getStatus()`: build a fresh status snapshot from internal state (cheap).
 *   - `testReachability()`: re-run the IP + verify cycle and the heuristic.
 *   - `getInviteAddresses()`: build the multiaddrs to embed in invites.
 *
 * NatService is library + lifecycle only. The long-running process that owns
 * it is `cadre-host-local-ui` (see docs/cadre-host.md and the ticket header).
 */
export class NatService {
  private readonly cadreNode: CadreNodeLike;
  private readonly store: NatStore;
  private readonly nowFn: () => Date;
  private readonly fetchImpl: typeof fetch;

  // Injected or lazily-created.
  private secretsStore: SecretsStore | null;
  private portMapper: PortMapper | null;
  /** Caller-supplied detector — used as-is when present (skips the auto router-probe stitch). */
  private readonly injectedDetector: ExternalIpDetector | null;

  // Built once start() completes.
  private portService: PortMapperService | null = null;
  private ddnsUpdater: DdnsUpdater | null = null;

  // Runtime state.
  private currentSettings: NatSettingsFile;
  private latestIp: ExternalIpResult | null = null;
  private lastTestedAt: Date | null = null;
  private started = false;

  // For createSecretsStore async init.
  private readonly secretsRootDir: string;

  constructor(opts: NatServiceOptions) {
    this.cadreNode = opts.cadreNode;
    this.store = opts.store ?? new NatStore(opts.rootDir);
    this.nowFn = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch ?? fetch;
    this.secretsStore = opts.secretsStore ?? null;
    this.portMapper = opts.portMapper ?? null;
    this.injectedDetector = opts.externalIpDetector ?? null;
    this.secretsRootDir = opts.rootDir;
    this.currentSettings = this.store.load();
  }

  /** Initial start: port mapping → IP detect → DDNS. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 1. Secrets store (lazy if not injected).
    if (!this.secretsStore) {
      this.secretsStore = await createSecretsStore(this.secretsRootDir);
    }

    // 2. Port mapping.
    await this.startPortService();

    // 3. External IP detection.
    await this.detectIp();

    // 4. DDNS updater.
    this.ddnsUpdater = new DdnsUpdater({
      settings: this.currentSettings.ddns,
      secrets: this.secretsStore,
      getExternalIp: () => this.latestIp?.publicIp ?? this.latestIp?.routerIp ?? null,
      fetch: this.fetchImpl,
      now: this.nowFn,
    });
    await this.ddnsUpdater.start();
  }

  /** Release the port mapping and clear timers. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      this.ddnsUpdater?.stop();
    } catch (err) {
      log('ddns stop failed: %s', (err as Error).message);
    }
    this.ddnsUpdater = null;

    try {
      await this.portService?.stop();
    } catch (err) {
      log('port-service stop failed: %s', (err as Error).message);
    }
    this.portService = null;
  }

  /** Cheap read of the current snapshot. */
  getStatus(): NatStatusSnapshot {
    const portState = this.portService?.getState() ?? this.disabledPortState();
    const externalIp = this.latestIp?.publicIp ?? this.latestIp?.routerIp ?? null;
    const ddns: NatDdnsStatus = this.ddnsUpdater?.getStatus() ?? {
      providerId: this.currentSettings.ddns.providerId,
      hostname: this.currentSettings.ddns.hostname,
      externallyManaged: this.currentSettings.ddns.externallyManaged,
      lastUpdateAt: null,
      lastUpdateOk: null,
      lastError: null,
    };

    return {
      portMode: this.currentSettings.upnpEnabled ? portState.mode : 'disabled',
      externalPort: portState.externalPort,
      internalPort: portState.internalPort,
      routerExternalIp: portState.routerExternalIp,
      mappingLeaseExpiresAt: portState.leaseExpiresAt?.toISOString() ?? null,
      externalIp,
      externalIpDetectedAt: this.latestIp?.detectedAt.toISOString() ?? null,
      cgnatDetected: this.latestIp?.cgnat ?? false,
      directReachability: evaluateReachability({
        portMode: portState.mode,
        cgnatDetected: this.latestIp?.cgnat ?? false,
      }),
      lastTestedAt: this.lastTestedAt?.toISOString() ?? null,
      ddns,
    };
  }

  /** Re-run the IP probe + port-mapper verify, then return a fresh snapshot. */
  async testReachability(): Promise<NatStatusSnapshot> {
    if (this.portService) {
      await this.portService.refresh().catch((err) => log('refresh err: %s', (err as Error).message));
    }
    await this.detectIp();
    this.lastTestedAt = this.nowFn();
    // Best-effort DDNS push when the IP just changed.
    if (this.ddnsUpdater) {
      await this.ddnsUpdater.forceUpdate().catch((err) => log('ddns forceUpdate err: %s', (err as Error).message));
    }
    return this.getStatus();
  }

  /** Build the multiaddrs to embed in invites. */
  async getInviteAddresses(): Promise<string[]> {
    const peerId = this.cadreNode.getPeerId();
    const status = this.getStatus();
    const input: BuildInviteAddressesInput = {
      peerId,
      externalPort: status.externalPort,
      ddnsHostname: status.ddns.hostname,
      externalIp: status.externalIp,
      reachable: status.directReachability === 'reachable',
      libp2pAddrs: this.cadreNode.getMultiaddrs(),
    };
    return buildInviteAddresses(input);
  }

  /** Current settings (cheap read; for handlers to surface to UI). */
  getSettings(): NatSettingsFile {
    return this.currentSettings;
  }

  /** Replace settings; persists to disk and reconfigures the runtime. */
  async putSettings(patch: Partial<Omit<NatSettingsFile, 'version'>>): Promise<NatStatusSnapshot> {
    const next = this.store.update(patch);
    const upnpChanged = next.upnpEnabled !== this.currentSettings.upnpEnabled;
    const portChanged =
      next.externalPort !== this.currentSettings.externalPort ||
      next.internalPort !== this.currentSettings.internalPort;
    const ddnsChanged =
      next.ddns.providerId !== this.currentSettings.ddns.providerId ||
      next.ddns.hostname !== this.currentSettings.ddns.hostname ||
      next.ddns.externallyManaged !== this.currentSettings.ddns.externallyManaged ||
      next.ddns.intervalMs !== this.currentSettings.ddns.intervalMs;
    this.currentSettings = next;

    if (this.started) {
      if (upnpChanged || portChanged) {
        try { await this.portService?.stop(); } catch { /* ignore */ }
        this.portService = null;
        await this.startPortService();
      }
      if (ddnsChanged && this.ddnsUpdater) {
        await this.ddnsUpdater.updateSettings(next.ddns);
      }
    }
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

    // Persist secrets.
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

    // Update nat.json.
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

  /** List available DDNS providers (UI listing for configuration). */
  listDdnsProviders(): DdnsProviderInfo[] {
    return listProviders().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      configFields: p.configFields,
    }));
  }

  // --- private ---

  private async startPortService(): Promise<void> {
    if (!this.currentSettings.upnpEnabled) {
      log('UPnP disabled by settings; skipping port mapping');
      return;
    }
    let mapper = this.portMapper;
    if (!mapper) {
      try {
        mapper = await createDefaultPortMapper();
        this.portMapper = mapper;
      } catch (err) {
        log('default port mapper unavailable: %s', (err as Error).message);
        return;
      }
    }
    this.portService = new PortMapperService({
      mapper,
      externalPort: this.currentSettings.externalPort,
      internalPort: this.currentSettings.internalPort,
      now: this.nowFn,
    });
    await this.portService.start();
  }

  private async detectIp(): Promise<void> {
    // If the caller injected a detector (typically a test stub), use it as-is —
    // don't second-guess them by stitching in the port mapper's router probe.
    const detector = this.injectedDetector ?? (
      this.portMapper
        ? new ExternalIpDetector({
            fetch: this.fetchImpl,
            now: this.nowFn,
            routerProbe: async () => this.portMapper!.externalIp(),
          })
        : new ExternalIpDetector({
            fetch: this.fetchImpl,
            now: this.nowFn,
          })
    );
    try {
      this.latestIp = await detector.detect();
    } catch (err) {
      log('detectIp failed: %s', (err as Error).message);
    }
  }

  private disabledPortState(): PortMapperState {
    return {
      mode: this.currentSettings.upnpEnabled ? 'failed' : 'disabled',
      externalPort: this.currentSettings.externalPort,
      internalPort: this.currentSettings.internalPort,
      routerExternalIp: null,
      leaseExpiresAt: null,
      lastError: null,
    };
  }
}

/**
 * Wrap a NatService into the typed handler shape consumed by
 * `cadre-host-local-ui`. Mirrors `createTrustCircleHandlers`.
 */
export function createNatHandlers(service: NatService): NatHandlers {
  return {
    async getStatus() { return service.getStatus(); },
    async testReachability() { return await service.testReachability(); },
    async listDdnsProviders() { return service.listDdnsProviders(); },
    async putDdns(body) { return await service.putDdns(body); },
    async putSettings(body) { return await service.putSettings(body); },
  };
}
