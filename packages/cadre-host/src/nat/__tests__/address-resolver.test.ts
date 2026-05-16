import { describe, expect, it } from 'vitest';

import { buildInviteAddresses } from '../address-resolver.js';

const PEER = '12D3KooWHost';

describe('buildInviteAddresses', () => {
  it('returns dns4 when reachable and a DDNS hostname is configured', () => {
    const addrs = buildInviteAddresses({
      peerId: PEER,
      externalPort: 4001,
      ddnsHostname: 'foo.duckdns.org',
      externalIp: '1.2.3.4',
      reachable: true,
      libp2pAddrs: ['/ip4/192.168.1.10/tcp/4001'],
    });
    expect(addrs).toEqual([`/dns4/foo.duckdns.org/tcp/4001/p2p/${PEER}`]);
  });

  it('falls back to ip4 when reachable but no DDNS hostname', () => {
    const addrs = buildInviteAddresses({
      peerId: PEER,
      externalPort: 4001,
      ddnsHostname: null,
      externalIp: '203.0.113.5',
      reachable: true,
      libp2pAddrs: ['/ip4/192.168.1.10/tcp/4001'],
    });
    expect(addrs).toEqual([`/ip4/203.0.113.5/tcp/4001/p2p/${PEER}`]);
  });

  it('falls back to libp2p addrs when not reachable', () => {
    const addrs = buildInviteAddresses({
      peerId: PEER,
      externalPort: 4001,
      ddnsHostname: 'foo.duckdns.org',
      externalIp: '1.2.3.4',
      reachable: false,
      libp2pAddrs: ['/ip4/192.168.1.10/tcp/4001', '/p2p-circuit'],
    });
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs.some((a) => a.startsWith('/dns4/'))).toBe(false);
    expect(addrs.some((a) => a.startsWith('/ip4/'))).toBe(true);
  });

  it('appends peer suffix to libp2p addrs that lack one', () => {
    const addrs = buildInviteAddresses({
      peerId: PEER,
      externalPort: 4001,
      ddnsHostname: null,
      externalIp: null,
      reachable: false,
      libp2pAddrs: ['/ip4/192.168.1.10/tcp/4001'],
    });
    expect(addrs).toEqual([`/ip4/192.168.1.10/tcp/4001/p2p/${PEER}`]);
  });

  it('preserves libp2p addrs that already have a /p2p/ suffix', () => {
    const existing = `/ip4/192.168.1.10/tcp/4001/p2p/${PEER}`;
    const addrs = buildInviteAddresses({
      peerId: PEER,
      externalPort: 4001,
      ddnsHostname: null,
      externalIp: null,
      reachable: false,
      libp2pAddrs: [existing],
    });
    expect(addrs).toEqual([existing]);
  });

  it('does not emit /ip4/ for IPv6 external IP — falls back instead', () => {
    const addrs = buildInviteAddresses({
      peerId: PEER,
      externalPort: 4001,
      ddnsHostname: null,
      externalIp: '2001:db8::1',
      reachable: true,
      libp2pAddrs: ['/ip4/192.168.1.10/tcp/4001'],
    });
    expect(addrs.some((a) => a.startsWith('/ip4/192.168.1.10'))).toBe(true);
  });
});
