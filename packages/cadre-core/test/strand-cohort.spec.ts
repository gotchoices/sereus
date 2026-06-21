import { describe, it, expect } from 'vitest';
import { deriveCohortMembers, selectStrandMode, type CohortPeerRow } from '../src/strand-cohort.js';

describe('deriveCohortMembers', () => {
  const self = 'self-peer-id';

  it('returns no members for an empty cohort', () => {
    expect(deriveCohortMembers([], self)).toEqual({ otherPeerIds: [], hasOtherPeers: false });
  });

  it('excludes self from the membership view', () => {
    const peers: CohortPeerRow[] = [{ peerId: self, multiaddr: '/ip4/127.0.0.1/tcp/4001' }];
    expect(deriveCohortMembers(peers, self)).toEqual({ otherPeerIds: [], hasOtherPeers: false });
  });

  it('lists other peerIds and flags membership presence', () => {
    const peers: CohortPeerRow[] = [
      { peerId: self, multiaddr: null },
      { peerId: 'other', multiaddr: '/a,/b' }
    ];
    const members = deriveCohortMembers(peers, self);
    expect(members.hasOtherPeers).toBe(true);
    expect(members.otherPeerIds).toEqual(['other']);
  });

  it('counts an addr-less other peer toward membership (addrs are irrelevant here)', () => {
    for (const ma of ['', null] as const) {
      const peers: CohortPeerRow[] = [{ peerId: 'other', multiaddr: ma }];
      const members = deriveCohortMembers(peers, self);
      expect(members.hasOtherPeers).toBe(true);
      expect(members.otherPeerIds).toEqual(['other']);
    }
  });

  it('ignores the Multiaddr field entirely — control addrs must not seed the strand', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'other', multiaddr: '/control/addr/1,/control/addr/2' }];
    const members = deriveCohortMembers(peers, self);
    // Only the peerId is surfaced; the control multiaddrs never appear in the result.
    expect(members.otherPeerIds).toEqual(['other']);
  });

  it('dedups repeated peerId rows', () => {
    const peers: CohortPeerRow[] = [
      { peerId: 'a', multiaddr: '/x' },
      { peerId: 'a', multiaddr: '/y' },
      { peerId: 'b', multiaddr: null }
    ];
    const members = deriveCohortMembers(peers, self);
    expect(members.otherPeerIds).toEqual(['a', 'b']);
    expect(members.hasOtherPeers).toBe(true);
  });

  it('keeps all peers when selfPeerId is undefined', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'a', multiaddr: '/a' }];
    const members = deriveCohortMembers(peers, undefined);
    expect(members.hasOtherPeers).toBe(true);
    expect(members.otherPeerIds).toEqual(['a']);
  });
});

describe('selectStrandMode', () => {
  it('honors an explicit mode regardless of membership', () => {
    expect(selectStrandMode('bootstrap', true)).toBe('bootstrap');
    expect(selectStrandMode('networked', false)).toBe('networked');
  });

  it('infers bootstrap for a solo node and networked with peers', () => {
    expect(selectStrandMode(undefined, false)).toBe('bootstrap');
    expect(selectStrandMode(undefined, true)).toBe('networked');
  });
});
