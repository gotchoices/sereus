/**
 * Test doubles for the slice of FRET a strand node's address refresh reads: routing-table
 * entries carrying REAL signed libp2p address records, as `exportTable()` serialises them.
 *
 * Not a `*.spec.ts` file, so vitest never runs it as a suite — it is imported by
 * `strand-fret-addrs.spec.ts` and `cadre-node-strand-addr-refresh.spec.ts`.
 */

import { PeerRecord, RecordEnvelope, type PeerRecordInit } from '@libp2p/peer-record';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { toString as uint8ArrayToString } from 'uint8arrays';

/** One exported FRET table entry, reduced to the fields the refresh reads. */
export interface FretEntryFake {
  id: string;
  addressRecord?: { envelope: string; confirmedAt: number };
}

/**
 * The base64url envelope of an address record signed by `signer`, describing `subject`
 * (defaults to the signer's own peer id, which is the only honest record) at `addrs`.
 * Addresses are given as a record states them: no trailing `/p2p/<peerId>`.
 */
export async function signedRecordEnvelope(
  signer: PrivateKey,
  addrs: string[],
  subject: PrivateKey = signer
): Promise<string> {
  const record = new PeerRecord({
    peerId: peerIdFromPrivateKey(subject),
    // `@libp2p/peer-record` carries its own `@multiformats/multiaddr` copy; the record
    // only reads each address's bytes, which both copies expose.
    multiaddrs: addrs.map((addr) => multiaddr(addr)) as unknown as PeerRecordInit['multiaddrs']
  });
  const envelope = await RecordEnvelope.seal(record, signer);
  return uint8ArrayToString(envelope.marshal(), 'base64url');
}

/** The table entry FRET holds for the peer behind `key`, with its own signed record at `addrs`. */
export async function fretEntry(key: PrivateKey, addrs: string[]): Promise<FretEntryFake> {
  return {
    id: peerIdFromPrivateKey(key).toString(),
    addressRecord: { envelope: await signedRecordEnvelope(key, addrs), confirmedAt: Date.now() }
  };
}

/** What db-p2p registers as `services.fret`, reduced to the table export. */
export function fretService(entries: FretEntryFake[]): { fret: { exportTable(): { entries: FretEntryFake[] } } } {
  return { fret: { exportTable: () => ({ entries }) } };
}
