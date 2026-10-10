/**
 * LAN or public-IP mode: whether this machine sits behind a router or holds a public IPv4
 * on one of its interfaces. See `NetworkMode` in `types.ts` for what each changes.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

import { isPublicIpv4 } from './address-resolver.js';
import type { NetworkMode, NetworkSetting } from './types.js';

/**
 * The first public IPv4 an interface holds, or null. A VPS's `eth0` holds its public address
 * directly; a machine behind a router holds only private ones (its public address lives on the
 * router). Docker bridges, VPNs and other private interfaces never qualify.
 */
export function publicInterfaceAddress(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): string | null {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPublicIpv4(entry.address)) return entry.address;
    }
  }
  return null;
}

/** The mode in effect: the setting, or for `auto`, public exactly when an interface holds a public IPv4. */
export function effectiveNetworkMode(setting: NetworkSetting, publicInterfaceIp: string | null): NetworkMode {
  if (setting !== 'auto') return setting;
  return publicInterfaceIp !== null ? 'public' : 'lan';
}
