import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

import { pickLanAddress } from '../port-mapper.js';

function v4(address: string, cidr: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr };
}

/**
 * The address a mapping points at (and a user is told to forward to) must be
 * the one on the router's own subnet — not a VPN or container interface that
 * happens to come first.
 */
describe('pickLanAddress', () => {
  it('picks the interface whose subnet contains the router, skipping loopback and other subnets', () => {
    const interfaces = {
      lo: [{ address: '127.0.0.1', netmask: '', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' } as NetworkInterfaceInfo],
      docker0: [v4('172.17.0.1', '172.17.0.1/16')],
      tun0: [v4('10.8.0.2', '10.8.0.2/24')],
      eth0: [v4('192.168.1.20', '192.168.1.20/24')],
    };
    expect(pickLanAddress('192.168.1.1', interfaces)).toBe('192.168.1.20');
    expect(pickLanAddress('10.8.0.1', interfaces)).toBe('10.8.0.2');
  });

  it('returns null when no interface shares the router subnet', () => {
    expect(pickLanAddress('192.168.1.1', { eth0: [v4('10.0.0.5', '10.0.0.5/24')] })).toBeNull();
  });
});
