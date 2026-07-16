import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  peerAuthorizationDigest,
  verifyPeerAuthorization
} from '../src/peer-authorization.js';

/** Sign a peer authorization the way SeedBootstrapService.authorizePeer does. */
function ownerSign(peerId: string, ownerPrivateKey: string): string {
  return sign(
    peerAuthorizationDigest(peerId),
    ownerPrivateKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
}

describe('peerAuthorizationDigest', () => {
  it('is the canonical single-field sha256/base64url digest of the peer ID', () => {
    const peerId = '12D3KooWTestPeer';
    expect(peerAuthorizationDigest(peerId)).toBe(
      digest([peerId], 'sha256', 'base64url') as string
    );
  });

  it('is deterministic and distinct for distinct peer IDs', () => {
    expect(peerAuthorizationDigest('peer-a')).toBe(peerAuthorizationDigest('peer-a'));
    expect(peerAuthorizationDigest('peer-a')).not.toBe(peerAuthorizationDigest('peer-b'));
  });
});

describe('verifyPeerAuthorization', () => {
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  let peerId: string;

  beforeEach(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const peerKey = await generateKeyPair('Ed25519');
    peerId = peerIdFromPrivateKey(peerKey).toString();
  });

  it('round-trips: a valid owner signature over the peer ID verifies true', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, signature)).toBe(true);
  });

  it('rejects a signature made for a different peer ID', async () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    const otherKey = await generateKeyPair('Ed25519');
    const otherPeerId = peerIdFromPrivateKey(otherKey).toString();
    expect(verifyPeerAuthorization(otherPeerId, ownerPublicKey, signature)).toBe(false);
  });

  it('rejects a signature verified against a different owner key', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    const wrongPrivate = generatePrivateKey('ed25519', 'base64url') as string;
    const wrongPublic = getPublicKey(wrongPrivate, 'ed25519', 'base64url', 'base64url') as string;
    expect(verifyPeerAuthorization(peerId, wrongPublic, signature)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    // Flip the leading character to a different valid base64url char.
    const tampered = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, tampered)).toBe(false);
  });

  it('returns false (does not throw) on a malformed base64url signature', () => {
    expect(() =>
      expect(verifyPeerAuthorization(peerId, ownerPublicKey, 'not valid base64url!!! ***')).toBe(false)
    ).not.toThrow();
  });

  it('returns false (does not throw) on a garbage owner key', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    expect(() =>
      expect(verifyPeerAuthorization(peerId, 'garbage-key-not-32-bytes', signature)).toBe(false)
    ).not.toThrow();
  });

  it('returns false on an empty signature without throwing', () => {
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, '')).toBe(false);
  });

  it('regression: a signature produced via the inline authorizePeer construction still verifies', () => {
    // Reproduce the exact pre-helper construction that SeedBootstrapService used
    // (digest then sign) WITHOUT going through peerAuthorizationDigest. If the
    // shared digest ever drifts from this construction, this fails.
    const inlineDigest = digest([peerId], 'sha256', 'base64url') as string;
    const signature = sign(
      inlineDigest,
      ownerPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, signature)).toBe(true);
  });
});
