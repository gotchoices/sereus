import { describe, it, expect } from 'vitest';
import { deriveCohortMembers, type CohortPeerRow } from '../src/strand-cohort.js';

describe('deriveCohortMembers', () => {
  const self = 'self-peer-id';

  it('returns no members for an empty cohort', () => {
    expect(deriveCohortMembers([], self)).toEqual([]);
  });

  it('excludes self from the membership view', () => {
    const peers: CohortPeerRow[] = [{ peerId: self, multiaddr: '/ip4/127.0.0.1/tcp/4001' }];
    expect(deriveCohortMembers(peers, self)).toEqual([]);
  });

  it('lists other peerIds', () => {
    const peers: CohortPeerRow[] = [
      { peerId: self, multiaddr: null },
      { peerId: 'other', multiaddr: '/a,/b' }
    ];
    expect(deriveCohortMembers(peers, self)).toEqual(['other']);
  });

  it('counts an addr-less other peer as a member (addrs are irrelevant here)', () => {
    for (const ma of ['', null] as const) {
      const peers: CohortPeerRow[] = [{ peerId: 'other', multiaddr: ma }];
      expect(deriveCohortMembers(peers, self)).toEqual(['other']);
    }
  });

  it('ignores the Multiaddr field entirely — control addrs must not seed the strand', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'other', multiaddr: '/control/addr/1,/control/addr/2' }];
    // Only the peerId is surfaced; the control multiaddrs never appear in the result.
    expect(deriveCohortMembers(peers, self)).toEqual(['other']);
  });

  it('dedups repeated peerId rows', () => {
    const peers: CohortPeerRow[] = [
      { peerId: 'a', multiaddr: '/x' },
      { peerId: 'a', multiaddr: '/y' },
      { peerId: 'b', multiaddr: null }
    ];
    expect(deriveCohortMembers(peers, self)).toEqual(['a', 'b']);
  });

  it('keeps all peers when selfPeerId is undefined', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'a', multiaddr: '/a' }];
    expect(deriveCohortMembers(peers, undefined)).toEqual(['a']);
  });
});
