import { describe, expect, it } from 'vitest';

import { buildPublicAddresses, isPublicIpv4, type PublicAddressInput } from '../address-resolver.js';
import type { PortRoute } from '../types.js';

function upnp(internalPort: number, externalPort = internalPort): PortRoute {
  return { internalPort, externalPort, source: 'upnp', leaseExpiresAt: null, error: null };
}
function manual(internalPort: number, externalPort: number): PortRoute {
  return { internalPort, externalPort, source: 'manual', leaseExpiresAt: null, error: null };
}
function none(internalPort: number): PortRoute {
  return { internalPort, externalPort: null, source: null, leaseExpiresAt: null, error: 'refused' };
}

const BASE: PublicAddressInput = {
  ddnsHostname: null,
  externalIp: '203.0.113.5',
  cgnatDetected: false,
  tcp: upnp(10003),
  ws: upnp(10004),
};

describe('buildPublicAddresses', () => {
  const cases: Array<{ name: string; input: Partial<PublicAddressInput>; expected: string[] }> = [
    {
      name: 'DDNS hostname wins over the external IP',
      input: { ddnsHostname: 'foo.duckdns.org' },
      expected: ['/dns4/foo.duckdns.org/tcp/10003', '/dns4/foo.duckdns.org/tcp/10004/ws'],
    },
    {
      name: 'a hostname that is not a DNS name is skipped, so no entry can stop a node starting',
      input: { ddnsHostname: 'https://foo.duckdns.org,bar' },
      expected: ['/ip4/203.0.113.5/tcp/10003', '/ip4/203.0.113.5/tcp/10004/ws'],
    },
    {
      name: 'public IPv4 without DDNS',
      input: {},
      expected: ['/ip4/203.0.113.5/tcp/10003', '/ip4/203.0.113.5/tcp/10004/ws'],
    },
    {
      name: 'a private external IP is no host part',
      input: { externalIp: '192.168.1.1' },
      expected: [],
    },
    {
      name: 'an IPv6 external IP is no host part',
      input: { externalIp: '2001:db8::1' },
      expected: [],
    },
    {
      name: 'no hostname and no IP',
      input: { externalIp: null },
      expected: [],
    },
    {
      name: 'the assigned external port is the one announced',
      input: { tcp: upnp(10003, 10103), ws: upnp(10004, 10104) },
      expected: ['/ip4/203.0.113.5/tcp/10103', '/ip4/203.0.113.5/tcp/10104/ws'],
    },
    {
      name: 'a port with no route is left out',
      input: { ws: none(10004) },
      expected: ['/ip4/203.0.113.5/tcp/10003'],
    },
    {
      name: 'no WebSocket port at all',
      input: { ws: null },
      expected: ['/ip4/203.0.113.5/tcp/10003'],
    },
    {
      name: 'CGNAT: upnp routes produce nothing',
      input: { cgnatDetected: true },
      expected: [],
    },
    {
      name: 'CGNAT: a manual route still produces an address',
      input: { cgnatDetected: true, tcp: manual(10003, 40000) },
      expected: ['/ip4/203.0.113.5/tcp/40000'],
    },
    {
      name: 'CGNAT with DDNS: manual only',
      input: { cgnatDetected: true, ddnsHostname: 'foo.duckdns.org', ws: manual(10004, 40004) },
      expected: ['/dns4/foo.duckdns.org/tcp/40004/ws'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(buildPublicAddresses({ ...BASE, ...c.input })).toEqual(c.expected);
    });
  }
});

describe('isPublicIpv4', () => {
  it('accepts a public address and rejects private, carrier, loopback and link-local ranges', () => {
    expect(isPublicIpv4('203.0.113.5')).toBe(true);
    expect(isPublicIpv4('8.8.8.8')).toBe(true);
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.5', '100.127.255.255', '127.0.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
      expect(isPublicIpv4(ip), ip).toBe(false);
    }
    expect(isPublicIpv4('172.32.0.1')).toBe(true);
    expect(isPublicIpv4('100.128.0.1')).toBe(true);
    expect(isPublicIpv4('2001:db8::1')).toBe(false);
    expect(isPublicIpv4('not an ip')).toBe(false);
  });
});
