import { describe, it, expect } from 'vitest';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { strandTransportKey } from '../src/strand-transport-key.js';

describe('strandTransportKey', () => {
  it('is stable: same identity key + strandId derive the same key every call', async () => {
    const identity = await generateKeyPair('Ed25519');

    const a = await strandTransportKey(identity, 'strand-1');
    const b = await strandTransportKey(identity, 'strand-1');

    expect(a.raw).toEqual(b.raw);
    expect(peerIdFromPrivateKey(a).toString()).toBe(peerIdFromPrivateKey(b).toString());
  });

  it('is stable across key serialization round-trips (restart shape)', async () => {
    // A restarted node reloads its identity key from the key store as protobuf
    // bytes; the derived strand key must not change across that round-trip.
    const identity = await generateKeyPair('Ed25519');
    const reloaded = privateKeyFromProtobuf(privateKeyToProtobuf(identity));

    const fresh = await strandTransportKey(identity, 'strand-1');
    const afterReload = await strandTransportKey(reloaded, 'strand-1');

    expect(afterReload.raw).toEqual(fresh.raw);
  });

  it('derives distinct keys per strandId', async () => {
    const identity = await generateKeyPair('Ed25519');

    const a = await strandTransportKey(identity, 'strand-1');
    const b = await strandTransportKey(identity, 'strand-2');

    expect(peerIdFromPrivateKey(a).toString()).not.toBe(peerIdFromPrivateKey(b).toString());
  });

  it('derives a key distinct from the identity key (control vs strand peerId)', async () => {
    const identity = await generateKeyPair('Ed25519');

    const derived = await strandTransportKey(identity, 'strand-1');

    expect(peerIdFromPrivateKey(derived).toString())
      .not.toBe(peerIdFromPrivateKey(identity).toString());
  });

  it('derives distinct keys for distinct identity keys with the same strandId', async () => {
    const identityA = await generateKeyPair('Ed25519');
    const identityB = await generateKeyPair('Ed25519');

    const a = await strandTransportKey(identityA, 'strand-1');
    const b = await strandTransportKey(identityB, 'strand-1');

    expect(peerIdFromPrivateKey(a).toString()).not.toBe(peerIdFromPrivateKey(b).toString());
  });

  it('rejects a non-Ed25519 identity key', async () => {
    const secpKey = await generateKeyPair('secp256k1');
    await expect(strandTransportKey(secpKey, 'strand-1')).rejects.toThrow(/Ed25519/);
  });
});
