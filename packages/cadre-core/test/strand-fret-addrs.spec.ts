import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { strandFretPeerAddrs, type FretPeerAddrs } from '../src/strand-fret-addrs.js';
import { fretEntry, fretService, signedRecordEnvelope, type FretEntryFake } from './fret-record-helpers.js';

/**
 * `strandFretPeerAddrs`: which of a strand node's FRET address records become address
 * book writes, and under which peer. The pass that calls it is covered in
 * `cadre-node-strand-addr-refresh.spec.ts`.
 */

const idOf = (key: Awaited<ReturnType<typeof generateKeyPair>>): string => peerIdFromPrivateKey(key).toString();

function read(selfId: string, entries: FretEntryFake[]): Promise<FretPeerAddrs> {
  return strandFretPeerAddrs({ peerId: { toString: () => selfId }, services: fretService(entries) });
}

function addrsByPeer(result: FretPeerAddrs): Record<string, string[]> {
  return Object.fromEntries([...result.peers].map(([peerId, addrs]) => [peerId, addrs.map((addr) => addr.toString())]));
}

describe('strandFretPeerAddrs', () => {
  it('binds each record\'s addresses to its peer, and skips self and entries holding no record', async () => {
    const [self, direct, relayOnly, relay, recordless] = await Promise.all(
      Array.from({ length: 5 }, () => generateKeyPair('Ed25519'))
    );
    const directAddr = '/ip4/203.0.113.7/tcp/4001/ws';
    // A relay-only peer's record ends at the relay hop: the record names its peer once,
    // in its `peerId` field, so no address carries the destination.
    const hop = `/ip4/9.9.9.9/tcp/4001/ws/p2p/${idOf(relay)}/p2p-circuit`;

    const result = await read(idOf(self), [
      await fretEntry(self, ['/ip4/10.0.0.1/tcp/1']),
      await fretEntry(direct, [directAddr]),
      { id: idOf(recordless) },
      await fretEntry(relayOnly, [hop])
    ]);

    expect(addrsByPeer(result)).toEqual({
      [idOf(direct)]: [`${directAddr}/p2p/${idOf(direct)}`],
      [idOf(relayOnly)]: [`${hop}/p2p/${idOf(relayOnly)}`]
    });
    expect(result.rejected).toBe(0);
  });

  it('rejects a record not signed by and about the peer it is filed under, and keeps the rest', async () => {
    const [self, victim, attacker, honest] = await Promise.all(
      Array.from({ length: 4 }, () => generateKeyPair('Ed25519'))
    );
    const attackerAddr = '/ip4/198.51.100.66/tcp/4001/ws';
    const honestAddr = '/ip4/203.0.113.7/tcp/4001/ws';
    const confirmedAt = Date.now();

    const result = await read(idOf(self), [
      // The attacker's key signs a record that claims to describe the victim: the signature
      // verifies, so only the signer check stops it rewriting the victim's addresses.
      { id: idOf(victim), addressRecord: { envelope: await signedRecordEnvelope(attacker, [attackerAddr], victim), confirmedAt } },
      // The attacker's own honest record, filed under the victim's id.
      { id: idOf(victim), addressRecord: { envelope: await signedRecordEnvelope(attacker, [attackerAddr]), confirmedAt } },
      { id: idOf(victim), addressRecord: { envelope: 'not an envelope', confirmedAt } },
      await fretEntry(honest, [honestAddr])
    ]);

    expect(addrsByPeer(result)).toEqual({ [idOf(honest)]: [`${honestAddr}/p2p/${idOf(honest)}`] });
    expect(result.rejected).toBe(3);
  });
});
