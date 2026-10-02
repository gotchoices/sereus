import { describe, it, expect } from 'vitest';
import { RELAY_STUN_PORT, relayStunUrl, resolveStunServers } from '../src/relay-stun.js';

/**
 * Each Sereus relay also answers STUN, so an embedder's WebRTC transport gets its STUN
 * servers from the relays it already uses, unless the embedder overrides them.
 */

const PEER = '12D3KooWMD7E7UH4rkCqiFE69n7FNqrKo1Xx3yDUU8JvwtaH39bD';

describe('relayStunUrl', () => {
  it('uses the relay host on the STUN port, whatever transport and port the relay is dialed on', () => {
    expect(relayStunUrl(`/dns4/relay.example.org/tcp/4011/ws/p2p/${PEER}`)).toBe(`stun:relay.example.org:${RELAY_STUN_PORT}`);
    expect(relayStunUrl(`/dns4/relay.example.org/tcp/443/tls/ws/p2p/${PEER}`)).toBe('stun:relay.example.org:3478');
    expect(relayStunUrl(`/dns/relay.example.org/tcp/4001/p2p/${PEER}`)).toBe('stun:relay.example.org:3478');
  });

  it('uses the name a DNSADDR relay is published under', () => {
    expect(relayStunUrl(`/dnsaddr/relay.example.org/p2p/${PEER}`)).toBe('stun:relay.example.org:3478');
  });

  it('carries IP literals, bracketing IPv6', () => {
    expect(relayStunUrl(`/ip4/203.0.113.7/tcp/4011/ws/p2p/${PEER}`)).toBe('stun:203.0.113.7:3478');
    expect(relayStunUrl(`/ip6/2001:db8::7/tcp/4011/ws/p2p/${PEER}`)).toBe('stun:[2001:db8::7]:3478');
  });

  it('returns undefined for an address that names no host, or does not parse', () => {
    expect(relayStunUrl(`/p2p/${PEER}`)).toBeUndefined();
    expect(relayStunUrl('not-a-multiaddr')).toBeUndefined();
  });
});

describe('resolveStunServers', () => {
  const relayA = `/dns4/a.example.org/tcp/4011/ws/p2p/${PEER}`;

  it('derives one STUN server per distinct relay host', () => {
    const relays = [relayA, `/dns4/a.example.org/tcp/4001/p2p/${PEER}`, `/dns4/b.example.org/tcp/4011/ws/p2p/${PEER}`];
    expect(resolveStunServers(relays)).toEqual([
      { urls: 'stun:a.example.org:3478' },
      { urls: 'stun:b.example.org:3478' }
    ]);
  });

  it('is empty with no relays and no override', () => {
    expect(resolveStunServers([])).toEqual([]);
  });

  it('uses the override URLs instead of the relays when it names any', () => {
    expect(resolveStunServers([relayA], ' stun:stun.example.net:3479 , stun:b.example.net:3478,')).toEqual([
      { urls: 'stun:stun.example.net:3479' },
      { urls: 'stun:b.example.net:3478' }
    ]);
  });

  it('falls back to the relays when the override is empty', () => {
    expect(resolveStunServers([relayA], ' , ')).toEqual([{ urls: 'stun:a.example.org:3478' }]);
  });

  it('skips relays it cannot derive a host from', () => {
    expect(resolveStunServers(['not-a-multiaddr', relayA])).toEqual([{ urls: 'stun:a.example.org:3478' }]);
  });
});
