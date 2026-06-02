import { describe, it, expect } from 'vitest';
import { deriveCohortSeed, selectStrandMode, type CohortPeerRow } from '../src/strand-cohort.js';

describe('deriveCohortSeed', () => {
  const self = 'self-peer-id';

  it('returns an empty seed for no peers', () => {
    expect(deriveCohortSeed([], self)).toEqual({ bootstrapNodes: [], hasOtherPeers: false });
  });

  it('excludes self from membership and seed', () => {
    const peers: CohortPeerRow[] = [{ peerId: self, multiaddr: '/ip4/127.0.0.1/tcp/4001' }];
    expect(deriveCohortSeed(peers, self)).toEqual({ bootstrapNodes: [], hasOtherPeers: false });
  });

  it('splits comma-joined multiaddrs for other peers', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'other', multiaddr: '/a,/b' }];
    const seed = deriveCohortSeed(peers, self);
    expect(seed.hasOtherPeers).toBe(true);
    expect(seed.bootstrapNodes).toContain('/a');
    expect(seed.bootstrapNodes).toContain('/b');
    expect(seed.bootstrapNodes).toHaveLength(2);
  });

  it('counts an addr-less other peer toward membership but not the seed', () => {
    for (const ma of ['', null] as const) {
      const peers: CohortPeerRow[] = [{ peerId: 'other', multiaddr: ma }];
      const seed = deriveCohortSeed(peers, self);
      expect(seed.hasOtherPeers).toBe(true);
      expect(seed.bootstrapNodes).toEqual([]);
    }
  });

  it('dedups repeated fragments across peers', () => {
    const peers: CohortPeerRow[] = [
      { peerId: 'a', multiaddr: '/x,/y' },
      { peerId: 'b', multiaddr: '/y,/z' }
    ];
    const seed = deriveCohortSeed(peers, self);
    expect([...seed.bootstrapNodes].sort()).toEqual(['/x', '/y', '/z']);
  });

  it('trims fragments and drops empties from a comma-joined field', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'a', multiaddr: ' /a , , /b ' }];
    const seed = deriveCohortSeed(peers, self);
    expect([...seed.bootstrapNodes].sort()).toEqual(['/a', '/b']);
  });

  it('keeps all peers when selfPeerId is undefined', () => {
    const peers: CohortPeerRow[] = [{ peerId: 'a', multiaddr: '/a' }];
    const seed = deriveCohortSeed(peers, undefined);
    expect(seed.hasOtherPeers).toBe(true);
    expect(seed.bootstrapNodes).toEqual(['/a']);
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
