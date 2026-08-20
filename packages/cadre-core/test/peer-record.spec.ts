import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { digest, sign } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { ed25519PublicKeyB64FromPeerId } from '../src/seed-bootstrap.js';
import {
  peerRecordSignedPayload,
  signPeerRecord,
  verifyPeerRecordSignature,
  isPeerRecordFresh,
  isSignalingAddr,
  orderSignalingFirst,
  trailingPeerId,
  withTrailingPeerId,
  currentMemberTrustPolicy,
  DEFAULT_PEER_RECORD_MAX_AGE_MS,
  DEFAULT_PEER_RECORD_HEARTBEAT_MS
} from '../src/peer-record.js';
import type { PeerAddressRecord } from '../src/types.js';

/**
 * Build a self-consistent record (peerId, publicKey, sig all from one Ed25519
 * key) for the helper tests.
 */
async function makeRecord(addrs: string[], updatedAt: number): Promise<{
  record: PeerAddressRecord;
  privateKeyB64: string;
  publicKeyB64: string;
  peerId: string;
}> {
  const libp2pKey = await generateKeyPair('Ed25519');
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);
  const peerId = peerIdFromPrivateKey(libp2pKey).toString();
  const record = signPeerRecord({ peerId, publicKey: publicKeyB64, addrs, updatedAt }, privateKeyB64);
  return { record, privateKeyB64, publicKeyB64, peerId };
}

describe('peer-record signed payload', () => {
  it('is the base64url sha256 of the domain-tagged field vector (mirrors the SQL constraint)', () => {
    const peerId = '12D3KooWExamplePeer';
    const multiaddr = '/dns4/relay/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWExamplePeer';
    const updatedAt = 1700000000000;

    const expected = digest(
      ['CadreControl.CadrePeer', 'publish', peerId, multiaddr, String(updatedAt)],
      'sha256',
      'base64url'
    ) as string;
    expect(peerRecordSignedPayload(peerId, multiaddr, updatedAt)).toBe(expected);
  });

  it('is deterministic and order/whitespace independent of any JSON canonicalizer', () => {
    // Pure multi-field sha256 → identical bytes in node/browser/RN. Two calls
    // with the same inputs must yield the same digest.
    const a = peerRecordSignedPayload('peerA', '/a,/b', 5);
    const b = peerRecordSignedPayload('peerA', '/a,/b', 5);
    expect(a).toBe(b);
    // Different field values → different payload.
    expect(peerRecordSignedPayload('peerA', '/a,/b', 6)).not.toBe(a);
    expect(peerRecordSignedPayload('peerA', '/a,/c', 5)).not.toBe(a);
  });

  it('joins addrs with "," exactly as the Multiaddr column stores them', () => {
    const addrs = ['/p2p-circuit/x', '/ip4/1.2.3.4/tcp/4001'];
    const built = peerRecordSignedPayload('p', addrs.join(','), 1);
    const directlyJoined = peerRecordSignedPayload('p', '/p2p-circuit/x,/ip4/1.2.3.4/tcp/4001', 1);
    expect(built).toBe(directlyJoined);
  });
});

describe('signPeerRecord / verifyPeerRecordSignature', () => {
  it('round-trips a self-signed record', async () => {
    const { record } = await makeRecord(['/p2p-circuit/sig', '/ip4/1.2.3.4/tcp/4001'], 1700000000000);
    expect(verifyPeerRecordSignature(record)).toBe(true);
  });

  it('preserves addr order (the order that is signed over)', async () => {
    const addrs = ['/p2p-circuit/sig', '/ip4/1.2.3.4/tcp/4001'];
    const { record } = await makeRecord(addrs, 1);
    expect(record.addrs).toEqual(addrs);
  });

  it('rejects a record whose sig was made by a different key', async () => {
    const { record, peerId, publicKeyB64 } = await makeRecord(['/a'], 10);
    // Re-sign the same payload with an unrelated key, keep the original publicKey.
    const otherKey = await generateKeyPair('Ed25519');
    const { privateKeyB64: otherPriv } = ed25519KeyPairFromLibp2p(otherKey);
    const forgedSig = sign(
      peerRecordSignedPayload(peerId, record.addrs.join(','), record.updatedAt),
      otherPriv, 'ed25519', 'base64url', 'base64url', 'base64url'
    ) as string;
    const tampered: PeerAddressRecord = { ...record, publicKey: publicKeyB64, sig: forgedSig };
    expect(verifyPeerRecordSignature(tampered)).toBe(false);
  });

  it('rejects a record with tampered addrs / updatedAt', async () => {
    const { record } = await makeRecord(['/a', '/b'], 10);
    expect(verifyPeerRecordSignature({ ...record, addrs: ['/a', '/evil'] })).toBe(false);
    expect(verifyPeerRecordSignature({ ...record, updatedAt: record.updatedAt + 1 })).toBe(false);
  });

  it('rejects a record missing key or sig', async () => {
    const { record } = await makeRecord(['/a'], 10);
    expect(verifyPeerRecordSignature({ ...record, publicKey: '' })).toBe(false);
    expect(verifyPeerRecordSignature({ ...record, sig: '' })).toBe(false);
  });

  it("publicKey is the key embedded in the record's peerId", async () => {
    const { record, peerId } = await makeRecord(['/a'], 10);
    expect(ed25519PublicKeyB64FromPeerId(peerId)).toBe(record.publicKey);
  });
});

describe('isPeerRecordFresh', () => {
  const maxAge = DEFAULT_PEER_RECORD_MAX_AGE_MS;
  it('accepts a record within the window', () => {
    const now = 1_000_000;
    expect(isPeerRecordFresh(now - maxAge + 1, maxAge, now)).toBe(true);
    expect(isPeerRecordFresh(now, maxAge, now)).toBe(true);
  });
  it('rejects a record older than the window', () => {
    const now = 1_000_000;
    expect(isPeerRecordFresh(now - maxAge - 1, maxAge, now)).toBe(false);
  });
  it('rejects a non-positive (never-published) stamp', () => {
    expect(isPeerRecordFresh(0, maxAge, 1_000_000)).toBe(false);
    expect(isPeerRecordFresh(-5, maxAge, 1_000_000)).toBe(false);
  });
  it('heartbeat is half the freshness ceiling', () => {
    expect(DEFAULT_PEER_RECORD_HEARTBEAT_MS).toBe(DEFAULT_PEER_RECORD_MAX_AGE_MS / 2);
  });
});

describe('signaling address ordering', () => {
  it('detects /p2p-circuit addrs', () => {
    expect(isSignalingAddr('/dns4/r/tcp/4001/p2p/X/p2p-circuit/p2p/Y')).toBe(true);
    expect(isSignalingAddr('/ip4/1.2.3.4/tcp/4001')).toBe(false);
  });
  it('puts signaling addrs first, preserving relative order, without mutating input', () => {
    const input = ['/ip4/1.1.1.1/tcp/1', '/p2p-circuit/a', '/ip4/2.2.2.2/tcp/2', '/p2p-circuit/b'];
    const ordered = orderSignalingFirst(input);
    expect(ordered).toEqual(['/p2p-circuit/a', '/p2p-circuit/b', '/ip4/1.1.1.1/tcp/1', '/ip4/2.2.2.2/tcp/2']);
    // input untouched
    expect(input[0]).toBe('/ip4/1.1.1.1/tcp/1');
  });
});

describe('currentMemberTrustPolicy', () => {
  it('trusts any present record (membership = owner-vouched row)', async () => {
    const { record, peerId, publicKeyB64 } = await makeRecord(['/a'], 10);
    const decision = await currentMemberTrustPolicy().evaluate({
      peerId, publicKey: publicKeyB64, partyId: 'p', record,
    });
    expect(decision).toBe(true);
  });
});

describe('withTrailingPeerId', () => {
  const TARGET = '12D3KooWTargetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const RELAY = '12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const OTHER = '12D3KooWOtherAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  /** Normalize a string addr and return the string, or null when it was dropped. */
  const normalize = (addr: string, peerId = TARGET): string | null =>
    withTrailingPeerId(multiaddr(addr), peerId)?.toString() ?? null;

  it('appends the suffix to a direct addr that carries no /p2p/ at all', () => {
    expect(normalize('/ip4/1.2.3.4/tcp/4001')).toBe(`/ip4/1.2.3.4/tcp/4001/p2p/${TARGET}`);
  });

  it('appends the suffix to a ws addr too (the shape the push-wake scenario uses)', () => {
    expect(normalize('/ip4/10.255.0.1/tcp/4001/ws')).toBe(`/ip4/10.255.0.1/tcp/4001/ws/p2p/${TARGET}`);
  });

  it('leaves a circuit addr already ending in /p2p/<target> untouched', () => {
    const addr = `/dns4/r.example.org/tcp/4001/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`;
    expect(normalize(addr)).toBe(addr);
    // Identity, not merely an equal string — no needless re-encapsulation.
    const parsed = multiaddr(addr);
    expect(withTrailingPeerId(parsed, TARGET)).toBe(parsed);
  });

  it('appends the target to a relay hop whose destination is missing', () => {
    // The trailing peer id here is the RELAY's, so the naive "it already has a
    // /p2p/, leave it" rule would file a circuit-to-nowhere under the target.
    const hop = `/dns4/r.example.org/tcp/4001/p2p/${RELAY}/p2p-circuit`;
    expect(trailingPeerId(multiaddr(hop))).toBe(RELAY);
    expect(normalize(hop)).toBe(`${hop}/p2p/${TARGET}`);
  });

  it('drops an addr terminating in a DIFFERENT peer id (it does not reach the target)', () => {
    expect(normalize(`/ip4/1.2.3.4/tcp/4001/p2p/${OTHER}`)).toBeNull();
    expect(normalize(`/dns4/r/tcp/4001/p2p/${RELAY}/p2p-circuit/p2p/${OTHER}`)).toBeNull();
  });

  it('is idempotent — normalizing an already-normalized addr changes nothing', () => {
    const once = normalize('/ip4/1.2.3.4/tcp/4001');
    expect(once).not.toBeNull();
    expect(normalize(once!)).toBe(once);
  });

  it('leaves a normalized list uniform, which is what libp2p.dial requires', () => {
    const mixed = [
      `/dns4/r/tcp/4001/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`,
      '/ip4/10.255.0.1/tcp/4001/ws',
    ];
    const normalized = mixed.map((a) => normalize(a));
    expect(normalized.every((a) => a?.endsWith(`/p2p/${TARGET}`))).toBe(true);
  });
});
