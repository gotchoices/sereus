import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  DelegateAdmissionStore,
  extractCircuitRelayTargets,
  dueRelayAnnounces,
  pruneStoppedStrandAnnounces,
  peerStrandKey,
  DELEGATE_GRANT_TTL_MS,
  MAX_DELEGATE_GRANTS_PER_MEMBER,
  MAX_DELEGATE_GRANTS,
  type CircuitRelayTarget
} from '../src/delegate-admission.js';

/**
 * Unit coverage for the delegate-admission module: the in-memory grant store a
 * relay-running control node consults from its connection gate
 * (`CadreNode.admitInboundControlConnection`), and the multiaddr helper that
 * names the circuit relays a strand launch must announce its delegate peerId
 * to. The gate-side divergence (a grant admits the CONNECTION, never the
 * STREAM) lives beside its siblings in `control-stream-authorization.spec.ts`;
 * the wire-level policy is proven in `control-stream-authz.integration.ts`.
 */

const T0 = 1_000_000; // arbitrary epoch base; the store only compares `now` values

describe('DelegateAdmissionStore', () => {
  it('admits a granted delegate and nobody else', () => {
    const store = new DelegateAdmissionStore();
    store.grant('member-A', 'strand-1', 'delegate-X', T0);

    expect(store.has('delegate-X', T0)).toBe(true);
    expect(store.has('delegate-Y', T0)).toBe(false);
    expect(store.has('member-A', T0)).toBe(false);
  });

  it('expires a grant after the TTL and prunes it from the store', () => {
    const store = new DelegateAdmissionStore();
    store.grant('member-A', 'strand-1', 'delegate-X', T0);

    expect(store.has('delegate-X', T0 + DELEGATE_GRANT_TTL_MS - 1)).toBe(true);
    expect(store.has('delegate-X', T0 + DELEGATE_GRANT_TTL_MS)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('a re-announce REFRESHES the expiry rather than keeping the original', () => {
    const store = new DelegateAdmissionStore();
    store.grant('member-A', 'strand-1', 'delegate-X', T0);
    const half = T0 + DELEGATE_GRANT_TTL_MS / 2;
    store.grant('member-A', 'strand-1', 'delegate-X', half);

    // Past the original expiry, inside the refreshed one.
    expect(store.has('delegate-X', T0 + DELEGATE_GRANT_TTL_MS + 1)).toBe(true);
    expect(store.has('delegate-X', half + DELEGATE_GRANT_TTL_MS)).toBe(false);
  });

  it('replaces per (announcer, strand) — a restarted strand cannot accumulate grants', () => {
    const store = new DelegateAdmissionStore();
    store.grant('member-A', 'strand-1', 'delegate-old', T0);
    store.grant('member-A', 'strand-1', 'delegate-new', T0);

    expect(store.size).toBe(1);
    expect(store.has('delegate-old', T0)).toBe(false);
    expect(store.has('delegate-new', T0)).toBe(true);
  });

  it('keeps separate grants per strand and per announcer', () => {
    const store = new DelegateAdmissionStore();
    store.grant('member-A', 'strand-1', 'delegate-A1', T0);
    store.grant('member-A', 'strand-2', 'delegate-A2', T0);
    store.grant('member-B', 'strand-1', 'delegate-B1', T0);

    expect(store.size).toBe(3);
    for (const d of ['delegate-A1', 'delegate-A2', 'delegate-B1']) {
      expect(store.has(d, T0)).toBe(true);
    }
  });

  it('caps grants per member, evicting the soonest-expiry grant of THAT member', () => {
    const store = new DelegateAdmissionStore();
    // Staggered expirations: strand-0's grant expires soonest.
    for (let i = 0; i < MAX_DELEGATE_GRANTS_PER_MEMBER; i++) {
      store.grant('member-A', `strand-${i}`, `delegate-${i}`, T0 + i);
    }
    store.grant('member-B', 'strand-x', 'delegate-B', T0);
    store.grant('member-A', 'strand-overflow', 'delegate-overflow', T0 + 1000);

    expect(store.has('delegate-0', T0 + 1000)).toBe(false); // member-A's soonest evicted
    expect(store.has('delegate-1', T0 + 1000)).toBe(true);
    expect(store.has('delegate-overflow', T0 + 1000)).toBe(true);
    expect(store.has('delegate-B', T0 + 1000)).toBe(true); // other member untouched
  });

  it('a replace never evicts — at the per-member cap, re-announcing an existing strand succeeds in place', () => {
    const store = new DelegateAdmissionStore();
    for (let i = 0; i < MAX_DELEGATE_GRANTS_PER_MEMBER; i++) {
      store.grant('member-A', `strand-${i}`, `delegate-${i}`, T0 + i);
    }
    store.grant('member-A', 'strand-3', 'delegate-3-v2', T0 + 1000);

    expect(store.size).toBe(MAX_DELEGATE_GRANTS_PER_MEMBER);
    expect(store.has('delegate-0', T0 + 1000)).toBe(true); // soonest-expiry survived
    expect(store.has('delegate-3', T0 + 1000)).toBe(false);
    expect(store.has('delegate-3-v2', T0 + 1000)).toBe(true);
  });

  it('clear() drops every grant — a stopped node admits nobody on restart', () => {
    const store = new DelegateAdmissionStore();
    store.grant('member-A', 'strand-1', 'delegate-X', T0);
    store.grant('member-B', 'strand-2', 'delegate-Y', T0);

    store.clear();

    expect(store.size).toBe(0);
    expect(store.has('delegate-X', T0)).toBe(false);
    expect(store.has('delegate-Y', T0)).toBe(false);
  });

  it('caps grants globally across members, evicting the soonest-expiry grant overall', () => {
    const store = new DelegateAdmissionStore();
    // Spread across many members so the per-member cap never triggers; the
    // first-inserted grant (member-0) expires soonest.
    for (let i = 0; i < MAX_DELEGATE_GRANTS; i++) {
      store.grant(`member-${i % 64}`, `strand-${i}`, `delegate-${i}`, T0 + i);
    }
    expect(store.size).toBe(MAX_DELEGATE_GRANTS);

    store.grant('member-new', 'strand-new', 'delegate-new', T0 + 1000);

    expect(store.size).toBe(MAX_DELEGATE_GRANTS);
    expect(store.has('delegate-0', T0 + 1000)).toBe(false);
    expect(store.has('delegate-new', T0 + 1000)).toBe(true);
  });
});

describe('dueRelayAnnounces', () => {
  const RELAY_A: CircuitRelayTarget = { relayPeerId: 'relay-A', relayAddr: '/ip4/1.2.3.4/tcp/4001/p2p/relay-A' };
  const RELAY_B: CircuitRelayTarget = { relayPeerId: 'relay-B', relayAddr: '/ip4/5.6.7.8/tcp/4001/p2p/relay-B' };
  const RELAYS = [RELAY_A, RELAY_B];
  const HALF_TTL = DELEGATE_GRANT_TTL_MS / 2;

  it('a never-announced relay is due', () => {
    expect(dueRelayAnnounces(new Map(), RELAYS, 'strand-1', T0)).toEqual(RELAYS);
  });

  it('becomes due at exactly half the TTL, not a tick before', () => {
    const announceAt = new Map([[peerStrandKey('relay-A', 'strand-1'), T0]]);

    expect(dueRelayAnnounces(announceAt, [RELAY_A], 'strand-1', T0 + HALF_TTL - 1)).toEqual([]);
    expect(dueRelayAnnounces(announceAt, [RELAY_A], 'strand-1', T0 + HALF_TTL)).toEqual([RELAY_A]);
  });

  it('throttles per (relay, strand) — a fresh relay does not suppress a stale sibling relay', () => {
    const announceAt = new Map([
      [peerStrandKey('relay-A', 'strand-1'), T0],
      [peerStrandKey('relay-B', 'strand-1'), T0 - HALF_TTL]
    ]);

    expect(dueRelayAnnounces(announceAt, RELAYS, 'strand-1', T0)).toEqual([RELAY_B]);
  });

  it('another strand\'s announce to the same relay does not count as this strand\'s', () => {
    const announceAt = new Map([[peerStrandKey('relay-A', 'strand-other'), T0]]);

    expect(dueRelayAnnounces(announceAt, [RELAY_A], 'strand-1', T0)).toEqual([RELAY_A]);
  });
});

describe('pruneStoppedStrandAnnounces', () => {
  it('drops entries whose strand is no longer running, keeps the rest', () => {
    const announceAt = new Map([
      [peerStrandKey('relay-A', 'strand-live'), T0],
      [peerStrandKey('relay-B', 'strand-live'), T0],
      [peerStrandKey('relay-A', 'strand-stopped'), T0]
    ]);

    pruneStoppedStrandAnnounces(announceAt, new Set(['strand-live']));

    expect([...announceAt.keys()]).toEqual([
      peerStrandKey('relay-A', 'strand-live'),
      peerStrandKey('relay-B', 'strand-live')
    ]);
  });

  it('empties the map when nothing is running', () => {
    const announceAt = new Map([[peerStrandKey('relay-A', 'strand-1'), T0]]);

    pruneStoppedStrandAnnounces(announceAt, new Set());

    expect(announceAt.size).toBe(0);
  });
});

describe('extractCircuitRelayTargets', () => {
  async function freshPeerIdStr(): Promise<string> {
    return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
  }

  it('extracts the relay peerId and direct dial prefix from a circuit listen addr', async () => {
    const relay = await freshPeerIdStr();
    const targets = extractCircuitRelayTargets([`/ip4/127.0.0.1/tcp/4111/ws/p2p/${relay}/p2p-circuit`]);

    expect(targets).toEqual([{
      relayPeerId: relay,
      relayAddr: `/ip4/127.0.0.1/tcp/4111/ws/p2p/${relay}`
    }]);
  });

  it('a trailing /p2p/<dst> names the DESTINATION, never the relay', async () => {
    const relay = await freshPeerIdStr();
    const dst = await freshPeerIdStr();
    const targets = extractCircuitRelayTargets([`/ip4/127.0.0.1/tcp/4111/ws/p2p/${relay}/p2p-circuit/p2p/${dst}`]);

    expect(targets.map((t) => t.relayPeerId)).toEqual([relay]);
  });

  it('skips a bare /p2p-circuit (no relay named), non-circuit addrs, and garbage', async () => {
    const relay = await freshPeerIdStr();
    const targets = extractCircuitRelayTargets([
      '/p2p-circuit',
      '/ip4/127.0.0.1/tcp/4111/ws',
      'not-a-multiaddr',
      `/ip4/127.0.0.1/tcp/4111/ws/p2p/${relay}/p2p-circuit`
    ]);

    expect(targets.map((t) => t.relayPeerId)).toEqual([relay]);
  });

  it('deduplicates by relay peerId, first addr wins', async () => {
    const relay = await freshPeerIdStr();
    const targets = extractCircuitRelayTargets([
      `/ip4/127.0.0.1/tcp/4111/ws/p2p/${relay}/p2p-circuit`,
      `/ip4/10.0.0.1/tcp/4222/ws/p2p/${relay}/p2p-circuit`
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0].relayAddr).toContain('/ip4/127.0.0.1/');
  });
});
