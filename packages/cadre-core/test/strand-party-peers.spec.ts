import { describe, it, expect } from 'vitest';
import { partitionPartyStrandPeers } from '../src/strand-party-peers.js';
import type { CadreMachine, RevocationRow, StrandPeerRow } from '../src/types.js';

/**
 * The projection the membership reconciler binds the party's other machines from: which
 * `StrandPeer` rows name a live sibling, which a removed machine, which nobody it may act on,
 * and which of the live siblings store the strand. Pure; the reconciler's use of the lists is
 * `strand-membership-reconciler.spec.ts`, and the one reader that drops a client is
 * `strand-party-machines.spec.ts`.
 */

function row(peerId: string, strandPeerId: string, role: StrandPeerRow['role'] = null): StrandPeerRow {
  return { strandId: 'strand', peerId, strandPeerId, role, sig: 'sig' };
}

function machine(peerId: string, trusted: boolean): CadreMachine {
  return { peerId, publicKey: null, isSelf: peerId === 'self', trusted, alwaysOn: null, lastPublishedAt: null, vouchedBy: null };
}

function tombstone(tableName: RevocationRow['tableName'], rowKey: string): RevocationRow {
  return { tableName, rowKey, stampId: `stamp-${rowKey}`, reissuedAt: 0, signerKey: 'owner', signerSig: 'sig' };
}

describe('partitionPartyStrandPeers', () => {
  it('sorts rows into live siblings and removed machines, keeps a client as a live sibling that serves nothing, ignores self, untrusted and unknown machines, and never lets a removed row claim a live id', () => {
    const peers = partitionPartyStrandPeers(
      [
        row('self', 'self-strand'),
        row('sibling', 'sibling-strand'),
        // A client of the strand: a live sibling like any other, marked as storing nothing.
        row('client', 'client-strand', 'client'),
        row('untrusted', 'untrusted-strand'),
        row('unknown', 'unknown-strand'),
        row('removed', 'removed-strand'),
        // A removed client: its id belongs in `removed` as a removed server's does.
        row('removed-client', 'removed-client-strand', 'client'),
        // A removed machine stated the sibling's id as its own before its removal.
        row('removed', 'sibling-strand'),
        // A re-added machine: a tombstone AND a live row under a fresh stamp.
        row('re-added', 're-added-strand'),
      ],
      [machine('self', false), machine('sibling', true), machine('client', true), machine('untrusted', false), machine('re-added', true)],
      [
        tombstone('CadrePeer', 'removed'), tombstone('CadrePeer', 'removed-client'),
        tombstone('CadrePeer', 're-added'), tombstone('DeviceToken', 'unknown'),
      ],
    );

    expect([...peers.live].sort((a, b) => a.strandPeerId.localeCompare(b.strandPeerId))).toEqual([
      { peerId: 'client', strandPeerId: 'client-strand', serves: false },
      { peerId: 're-added', strandPeerId: 're-added-strand', serves: true },
      { peerId: 'sibling', strandPeerId: 'sibling-strand', serves: true },
    ]);
    expect([...peers.removed].sort()).toEqual(['removed-client-strand', 'removed-strand']);
  });
});
