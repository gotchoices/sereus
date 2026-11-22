import { describe, it, expect } from 'vitest';
import { partitionPartyStrandPeers } from '../src/strand-party-peers.js';
import type { CadreMachine, RevocationRow, StrandPeerRow } from '../src/types.js';

/**
 * The projection the membership reconciler binds the party's other machines from: which
 * `StrandPeer` rows name a live sibling, which a removed machine, and which nobody it may act
 * on. Pure; the reconciler's use of the lists is `strand-membership-reconciler.spec.ts`.
 */

function row(peerId: string, strandPeerId: string): StrandPeerRow {
  return { strandId: 'strand', peerId, strandPeerId, role: null, sig: 'sig' };
}

function machine(peerId: string, trusted: boolean): CadreMachine {
  return { peerId, publicKey: null, isSelf: peerId === 'self', trusted, alwaysOn: null, lastPublishedAt: null, vouchedBy: null };
}

function tombstone(tableName: RevocationRow['tableName'], rowKey: string): RevocationRow {
  return { tableName, rowKey, stampId: `stamp-${rowKey}`, reissuedAt: 0, signerKey: 'owner', signerSig: 'sig' };
}

describe('partitionPartyStrandPeers', () => {
  it('sorts rows into live siblings and removed machines, ignores self, untrusted and unknown machines, and never lets a removed row claim a live id', () => {
    const peers = partitionPartyStrandPeers(
      [
        row('self', 'self-strand'),
        row('sibling', 'sibling-strand'),
        row('untrusted', 'untrusted-strand'),
        row('unknown', 'unknown-strand'),
        row('removed', 'removed-strand'),
        // A removed machine stated the sibling's id as its own before its removal.
        row('removed', 'sibling-strand'),
        // A re-added machine: a tombstone AND a live row under a fresh stamp.
        row('re-added', 're-added-strand'),
      ],
      [machine('self', false), machine('sibling', true), machine('untrusted', false), machine('re-added', true)],
      [tombstone('CadrePeer', 'removed'), tombstone('CadrePeer', 're-added'), tombstone('DeviceToken', 'unknown')],
    );

    expect([...peers.live].sort((a, b) => a.strandPeerId.localeCompare(b.strandPeerId))).toEqual([
      { peerId: 're-added', strandPeerId: 're-added-strand' },
      { peerId: 'sibling', strandPeerId: 'sibling-strand' },
    ]);
    expect(peers.removed).toEqual(['removed-strand']);
  });
});
