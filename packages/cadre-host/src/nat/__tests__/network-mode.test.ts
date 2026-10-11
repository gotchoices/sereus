import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

import { effectiveNetworkMode, publicInterfaceAddress } from '../network-mode.js';

/** One IPv4 interface entry, as `os.networkInterfaces()` reports it. */
function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}

describe('publicInterfaceAddress', () => {
  it('finds a VPS\'s public address among private, Docker and loopback interfaces', () => {
    expect(publicInterfaceAddress({
      lo: [v4('127.0.0.1', true)],
      docker0: [v4('172.17.0.1')],
      eth1: [v4('10.10.0.5')],
      eth0: [v4('107.170.255.209')],
    })).toBe('107.170.255.209');
  });

  it('is null behind a router: private, carrier-grade and link-local addresses only', () => {
    expect(publicInterfaceAddress({
      eno1: [v4('192.168.2.27')],
      tailscale0: [v4('100.101.102.103')],
      bk0: [v4('10.9.9.1')],
      wlan0: [v4('169.254.10.10')],
    })).toBeNull();
  });
});

describe('effectiveNetworkMode', () => {
  it('auto follows the interfaces; an explicit setting wins', () => {
    expect(effectiveNetworkMode('auto', '203.0.113.7')).toBe('public');
    expect(effectiveNetworkMode('auto', null)).toBe('lan');
    expect(effectiveNetworkMode('lan', '203.0.113.7')).toBe('lan');
    expect(effectiveNetworkMode('public', null)).toBe('public');
  });
});
