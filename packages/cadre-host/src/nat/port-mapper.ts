import { BlockList } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import debug from 'debug';
import { upnpNat, type Gateway, type UPnPNAT } from '@achingbrain/nat-port-mapper';

import { NatError } from './types.js';

const log = debug('cadre:host:nat-port-mapper');

/**
 * Default lease TTL: 1 hour. `@achingbrain/nat-port-mapper` takes the TTL in
 * milliseconds and floors the lease it asks the router for at 3600 s, so a
 * shorter value here would still lease an hour.
 */
export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;

/** Default renewal cadence: half the TTL, so two renewals per lease. */
export const DEFAULT_REFRESH_MS = 30 * 60 * 1000;

/** How long to listen for a UPnP gateway's SSDP answer before giving up. */
export const GATEWAY_DISCOVERY_TIMEOUT_MS = 10_000;

/** Bound on one SOAP call to the router (map, unmap, external IP). */
export const GATEWAY_OPERATION_TIMEOUT_MS = 10_000;

/** What `discover()` learned about the router. */
export interface GatewayInfo {
  /** This machine's address on the router's subnet — the address mappings point at. */
  lanAddress: string;
  /** The router's own LAN address. */
  routerHost: string;
}

export interface PortMapRequest {
  internalPort: number;
  protocol: 'tcp' | 'udp';
  /** Lease TTL in milliseconds. */
  ttlMs: number;
}

/** Result of a successful map(). */
export interface PortMapResult {
  /** The external port the router granted — may differ from the internal port. */
  externalPort: number;
  leaseExpiresAt: Date;
}

/**
 * Wrapper around the UPnP client. An interface so tests inject a fake instead
 * of a router.
 */
export interface PortMapper {
  /**
   * Find the router. Resolves null when no gateway answered within the
   * discovery timeout; throws `NatError('router_unreachable')` when one did but
   * cannot be used (no local interface shares its subnet).
   */
  discover(): Promise<GatewayInfo | null>;
  /**
   * Ask the router to map `internalPort` to the same external port. The router
   * may grant another; the returned `externalPort` is the one that counts.
   * Throws `NatError('mapping_failed')` on refusal.
   */
  map(req: PortMapRequest): Promise<PortMapResult>;
  /** Remove a mapping installed by this process. Never throws. */
  unmap(internalPort: number, protocol: 'tcp' | 'udp'): Promise<void>;
  /** The WAN address the router reports, or null when it cannot be asked. */
  externalIp(): Promise<string | null>;
  /** Release client resources. Does not unmap. Idempotent. */
  stop(): Promise<void>;
}

/** Signal that aborts after `ms`; the timer is cleared by `done()` so it never holds the process open. */
function deadline(ms: number): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms);
  timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Pick the IPv4 address of the local interface whose subnet contains the router.
 *
 * Not `mapAll`: that maps on every local address and leaves stray mappings for
 * VPN and container interfaces. The address returned is the one a user is told
 * to forward to, so it must be the one on the router's own network.
 */
export function pickLanAddress(
  routerHost: string,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): string | null {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.cidr) continue;
      const prefix = Number(entry.cidr.split('/')[1]);
      if (!Number.isInteger(prefix)) continue;
      const subnet = new BlockList();
      try {
        subnet.addSubnet(entry.address, prefix, 'ipv4');
        if (subnet.check(routerHost, 'ipv4')) return entry.address;
      } catch (err) {
        log('skipping interface entry %s (%s): %s', entry.address, entry.cidr, (err as Error).message);
      }
    }
  }
  return null;
}

/**
 * UPnP port mapper over `@achingbrain/nat-port-mapper` v4: `upnpNat()` hands
 * out a client that discovers gateways; mapping, unmapping and the external IP
 * live on the discovered `Gateway`.
 *
 * The library's auto-refresh stays off: cadre-host renews leases itself so it
 * can report lease expiry and per-mapping failures.
 */
export class UpnpPortMapper implements PortMapper {
  private readonly client: UPnPNAT;
  private gateway: Gateway | null = null;
  private lanAddress: string | null = null;

  constructor(opts: { description?: string } = {}) {
    this.client = upnpNat({
      description: opts.description ?? 'sereus-cadre-host',
      autoRefresh: false,
    });
  }

  async discover(): Promise<GatewayInfo | null> {
    const gateway = await this.findIpv4Gateway();
    if (!gateway) return null;
    const lanAddress = pickLanAddress(gateway.host);
    if (!lanAddress) {
      throw new NatError(
        'router_unreachable',
        `found a UPnP router at ${gateway.host} but no local IPv4 interface shares its subnet`,
      );
    }
    this.gateway = gateway;
    this.lanAddress = lanAddress;
    log('discovered gateway %s (%s), mapping from %s', gateway.id, gateway.host, lanAddress);
    return { lanAddress, routerHost: gateway.host };
  }

  async map(req: PortMapRequest): Promise<PortMapResult> {
    const { gateway, lanAddress } = this.requireGateway();
    const op = deadline(GATEWAY_OPERATION_TIMEOUT_MS);
    try {
      const mapping = await gateway.map(req.internalPort, lanAddress, {
        externalPort: req.internalPort,
        protocol: req.protocol,
        ttl: req.ttlMs,
        autoRefresh: false,
        signal: op.signal,
      });
      return { externalPort: mapping.externalPort, leaseExpiresAt: new Date(Date.now() + req.ttlMs) };
    } catch (err) {
      throw new NatError(
        'mapping_failed',
        `router refused the mapping for port ${req.internalPort}: ${(err as Error).message}`,
      );
    } finally {
      op.done();
    }
  }

  // NOTE: the library tracks the mappings this process made and `unmap` only sends a
  // delete for those, so after a host restart a port mapped by the previous process is
  // left to expire with its lease rather than deleted. It also names the INTERNAL port
  // as the external one in that delete, so a mapping the router granted on another
  // external port is not deleted either; it, too, expires with its lease (1 h). And it
  // appends one tracked entry per successful `map` of a port, so after N renewals an
  // unmap sends N deletes (the first is the one that counts); they all run under the
  // one 10 s bound, which caps the cost of a process that has renewed for days.
  async unmap(internalPort: number, _protocol: 'tcp' | 'udp'): Promise<void> {
    if (!this.gateway) return;
    const op = deadline(GATEWAY_OPERATION_TIMEOUT_MS);
    try {
      await this.gateway.unmap(internalPort, { signal: op.signal });
    } catch (err) {
      log('unmap(%d) failed: %s', internalPort, (err as Error).message);
    } finally {
      op.done();
    }
  }

  async externalIp(): Promise<string | null> {
    if (!this.gateway) return null;
    const op = deadline(GATEWAY_OPERATION_TIMEOUT_MS);
    try {
      return await this.gateway.externalIp({ signal: op.signal });
    } catch (err) {
      log('externalIp() failed: %s', (err as Error).message);
      return null;
    } finally {
      op.done();
    }
  }

  /**
   * Forget the gateway. Deliberately not `gateway.stop()`: that deletes every
   * mapping this process made, and hosted children keep running across a host
   * restart, so their mappings must outlive this process.
   */
  async stop(): Promise<void> {
    this.gateway = null;
    this.lanAddress = null;
  }

  private requireGateway(): { gateway: Gateway; lanAddress: string } {
    if (!this.gateway || !this.lanAddress) {
      throw new NatError('router_unreachable', 'no UPnP gateway discovered');
    }
    return { gateway: this.gateway, lanAddress: this.lanAddress };
  }

  /**
   * First IPv4 gateway to answer the SSDP search, or null when none did within
   * the timeout.
   *
   * NOTE: the library searches for `InternetGatewayDevice:2` only (its
   * `upnp/discovery.js`), and a router that implements only version 1 does not
   * answer a version-2 search, so such a router reads as "not found". There is
   * no library option for it; if it shows up on real hosts, the fix is a fork or
   * another library.
   */
  private async findIpv4Gateway(): Promise<Gateway | null> {
    const search = deadline(GATEWAY_DISCOVERY_TIMEOUT_MS);
    try {
      for await (const gateway of this.client.findGateways({ signal: search.signal })) {
        if (gateway.family === 'IPv4') return gateway;
      }
      return null;
    } catch (err) {
      if (search.signal.aborted) return null;
      throw new NatError('router_unreachable', `UPnP discovery failed: ${(err as Error).message}`);
    } finally {
      search.done();
    }
  }
}
