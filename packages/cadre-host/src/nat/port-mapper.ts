import debug from 'debug';

import { NatError, type PortForwardMode } from './types.js';

const log = debug('cadre:host:nat-port-mapper');

/** Default lease TTL: 1 hour. The router must keep our mapping at least this long. */
export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;

/** Default refresh cadence: half the TTL, so two refreshes per lease. */
export const DEFAULT_REFRESH_MS = 30 * 60 * 1000;

/** Result of a successful map(). */
export interface PortMappingResult {
  mode: 'auto-upnp' | 'auto-natpmp';
  externalIp: string | null;
  externalPort: number;
  internalPort: number;
  protocol: 'tcp' | 'udp';
  leaseExpiresAt: Date;
}

export interface PortMapOptions {
  externalPort: number;
  internalPort: number;
  protocol?: 'tcp' | 'udp';
  /** Lease TTL in milliseconds. Defaults to DEFAULT_LEASE_TTL_MS. */
  ttlMs?: number;
}

/**
 * Wrapper around the underlying UPnP/NAT-PMP client. Abstract so tests can
 * stub the network behavior without spinning up a real router.
 */
export interface PortMapper {
  /** Attempt to install a port mapping. Throws NatError(mapping_failed) on failure. */
  map(opts: PortMapOptions): Promise<PortMappingResult>;
  /** Re-query the router; returns true if the mapping is still present. */
  verify(externalPort: number, protocol?: 'tcp' | 'udp'): Promise<boolean>;
  /** Query the router's WAN/external IP, if exposed. */
  externalIp(): Promise<string | null>;
  /** Remove a mapping installed by this mapper. */
  unmap(externalPort: number, protocol?: 'tcp' | 'udp'): Promise<void>;
  /** Release client resources (timers, sockets). Idempotent. */
  stop(): Promise<void>;
}

/** Constructor for the default mapper. Loads `@achingbrain/nat-port-mapper` dynamically. */
export type PortMapperFactory = () => Promise<PortMapper>;

interface NatPortMapperClient {
  externalIp(): Promise<string>;
  map(opts: Record<string, unknown>): Promise<unknown>;
  unmap(opts: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

interface NatPortMapperModule {
  upnpNat(opts?: Record<string, unknown>): Promise<NatPortMapperClient>;
}

/**
 * Default factory: loads @achingbrain/nat-port-mapper. Wrapped in dynamic
 * import so a missing dep at install time doesn't crash the package.
 */
export async function createDefaultPortMapper(opts: {
  description?: string;
  ttlMs?: number;
} = {}): Promise<PortMapper> {
  let mod: NatPortMapperModule;
  try {
    mod = (await import('@achingbrain/nat-port-mapper' as string)) as NatPortMapperModule;
  } catch (err) {
    throw new NatError(
      'mapping_failed',
      `@achingbrain/nat-port-mapper is not installed: ${(err as Error).message}`,
    );
  }

  let client: NatPortMapperClient;
  try {
    client = await mod.upnpNat({
      description: opts.description ?? 'sereus-cadre-host',
      ttl: Math.round((opts.ttlMs ?? DEFAULT_LEASE_TTL_MS) / 1000),
    });
  } catch (err) {
    throw new NatError(
      'mapping_failed',
      `upnpNat() failed: ${(err as Error).message}`,
    );
  }

  return new NatPortMapperAdapter(client, opts.ttlMs ?? DEFAULT_LEASE_TTL_MS);
}

class NatPortMapperAdapter implements PortMapper {
  constructor(
    private readonly client: NatPortMapperClient,
    private readonly defaultTtlMs: number,
  ) {}

  async map(opts: PortMapOptions): Promise<PortMappingResult> {
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs;
    const protocol = opts.protocol ?? 'tcp';
    let externalIp: string | null = null;
    try {
      externalIp = await this.client.externalIp();
    } catch (err) {
      log('externalIp() failed: %s', (err as Error).message);
    }
    try {
      await this.client.map({
        localPort: opts.internalPort,
        externalPort: opts.externalPort,
        protocol,
        ttl: Math.round(ttlMs / 1000),
      });
    } catch (err) {
      throw new NatError(
        'mapping_failed',
        `router refused mapping for port ${opts.externalPort}: ${(err as Error).message}`,
      );
    }
    return {
      mode: 'auto-upnp',
      externalIp,
      externalPort: opts.externalPort,
      internalPort: opts.internalPort,
      protocol,
      leaseExpiresAt: new Date(Date.now() + ttlMs),
    };
  }

  async verify(externalPort: number, protocol: 'tcp' | 'udp' = 'tcp'): Promise<boolean> {
    void externalPort;
    void protocol;
    // The current library doesn't expose an introspection API. Treat a
    // working externalIp() as a proxy for "router still reachable" — refresh
    // failures will surface via re-running map().
    try {
      await this.client.externalIp();
      return true;
    } catch (err) {
      log('verify() failed: %s', (err as Error).message);
      return false;
    }
  }

  async externalIp(): Promise<string | null> {
    try {
      return await this.client.externalIp();
    } catch (err) {
      log('externalIp() failed: %s', (err as Error).message);
      return null;
    }
  }

  async unmap(externalPort: number, protocol: 'tcp' | 'udp' = 'tcp'): Promise<void> {
    try {
      await this.client.unmap({ externalPort, protocol });
    } catch (err) {
      log('unmap(%d) failed: %s', externalPort, (err as Error).message);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.client.stop();
    } catch (err) {
      log('stop() failed: %s', (err as Error).message);
    }
  }
}

/** Public-facing port-mapper service: wraps a PortMapper with refresh + state. */
export interface PortMapperServiceOptions {
  mapper: PortMapper;
  externalPort: number;
  internalPort: number;
  protocol?: 'tcp' | 'udp';
  ttlMs?: number;
  refreshMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
  /** Timer overrides for tests (must return a handle usable by `clear`). */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (h: NodeJS.Timeout) => void;
}

/** State snapshot returned by `PortMapperService.getStatus()`. */
export interface PortMapperState {
  mode: PortForwardMode;
  externalPort: number;
  internalPort: number;
  routerExternalIp: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
}

/**
 * Long-running orchestrator over a PortMapper. Owns the refresh timer and
 * surfaces the latest state for the NatService snapshot.
 */
export class PortMapperService {
  private readonly mapper: PortMapper;
  private readonly externalPort: number;
  private readonly internalPort: number;
  private readonly protocol: 'tcp' | 'udp';
  private readonly ttlMs: number;
  private readonly refreshMs: number;
  private readonly nowFn: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (h: NodeJS.Timeout) => void;

  private state: PortMapperState;
  private refreshHandle: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts: PortMapperServiceOptions) {
    this.mapper = opts.mapper;
    this.externalPort = opts.externalPort;
    this.internalPort = opts.internalPort;
    this.protocol = opts.protocol ?? 'tcp';
    this.ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    this.nowFn = opts.now ?? (() => new Date());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

    this.state = {
      mode: 'disabled',
      externalPort: this.externalPort,
      internalPort: this.internalPort,
      routerExternalIp: null,
      leaseExpiresAt: null,
      lastError: null,
    };
  }

  getState(): PortMapperState {
    return { ...this.state };
  }

  /** Install the mapping and schedule periodic refresh. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.installMapping();
    this.scheduleRefresh();
  }

  /** Release the mapping and clear timers. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.refreshHandle) {
      this.clearTimer(this.refreshHandle);
      this.refreshHandle = null;
    }
    try {
      await this.mapper.unmap(this.externalPort, this.protocol);
    } catch (err) {
      log('unmap during stop failed: %s', (err as Error).message);
    }
    try {
      await this.mapper.stop();
    } catch (err) {
      log('mapper.stop() failed: %s', (err as Error).message);
    }
    this.state = {
      ...this.state,
      mode: 'disabled',
      routerExternalIp: null,
      leaseExpiresAt: null,
    };
  }

  /** Force an immediate verify+refresh cycle (used by testReachability). */
  async refresh(): Promise<PortMapperState> {
    if (!this.started) return this.getState();
    const ok = await this.mapper.verify(this.externalPort, this.protocol).catch(() => false);
    if (!ok) {
      log('verify() returned false; re-mapping');
      await this.installMapping();
      return this.getState();
    }
    // Refresh: re-issue the mapping to extend the lease.
    await this.installMapping();
    return this.getState();
  }

  private scheduleRefresh(): void {
    if (this.refreshHandle) this.clearTimer(this.refreshHandle);
    this.refreshHandle = this.setTimer(() => {
      void this.refresh().catch((err) => log('refresh timer error: %s', (err as Error).message));
      // Re-arm after the call to avoid drift.
      this.scheduleRefresh();
    }, this.refreshMs);
  }

  private async installMapping(): Promise<void> {
    try {
      const r = await this.mapper.map({
        externalPort: this.externalPort,
        internalPort: this.internalPort,
        protocol: this.protocol,
        ttlMs: this.ttlMs,
      });
      this.state = {
        mode: r.mode,
        externalPort: r.externalPort,
        internalPort: r.internalPort,
        routerExternalIp: r.externalIp,
        leaseExpiresAt: r.leaseExpiresAt,
        lastError: null,
      };
      log('mapped port %d (mode=%s, externalIp=%s)', r.externalPort, r.mode, r.externalIp ?? '?');
    } catch (err) {
      const message = (err as Error).message;
      this.state = {
        ...this.state,
        mode: 'failed',
        leaseExpiresAt: null,
        lastError: message,
      };
      log('mapping failed: %s', message);
    }
  }
}
