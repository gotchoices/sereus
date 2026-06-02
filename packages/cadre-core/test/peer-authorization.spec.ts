import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  peerAuthorizationDigest,
  verifyPeerAuthorization
} from '../src/peer-authorization.js';

/** Sign a peer authorization the way SeedBootstrapService.authorizePeer does. */
function authoritySign(peerId: string, authorityPrivateKey: string): string {
  return sign(
    peerAuthorizationDigest(peerId),
    authorityPrivateKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
}

describe('peerAuthorizationDigest', () => {
  it('is the canonical sha256/utf8/base64url digest of the peer ID', () => {
    const peerId = '12D3KooWTestPeer';
    expect(peerAuthorizationDigest(peerId)).toBe(
      digest(peerId, 'sha256', 'utf8', 'base64url') as string
    );
  });

  it('is deterministic and distinct for distinct peer IDs', () => {
    expect(peerAuthorizationDigest('peer-a')).toBe(peerAuthorizationDigest('peer-a'));
    expect(peerAuthorizationDigest('peer-a')).not.toBe(peerAuthorizationDigest('peer-b'));
  });
});

describe('verifyPeerAuthorization', () => {
  let authorityPrivateKey: string;
  let authorityPublicKey: string;
  let peerId: string;

  beforeEach(async () => {
    authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const peerKey = await generateKeyPair('Ed25519');
    peerId = peerIdFromPrivateKey(peerKey).toString();
  });

  it('round-trips: a valid authority signature over the peer ID verifies true', () => {
    const signature = authoritySign(peerId, authorityPrivateKey);
    expect(verifyPeerAuthorization(peerId, authorityPublicKey, signature)).toBe(true);
  });

  it('rejects a signature made for a different peer ID', async () => {
    const signature = authoritySign(peerId, authorityPrivateKey);
    const otherKey = await generateKeyPair('Ed25519');
    const otherPeerId = peerIdFromPrivateKey(otherKey).toString();
    expect(verifyPeerAuthorization(otherPeerId, authorityPublicKey, signature)).toBe(false);
  });

  it('rejects a signature verified against a different authority key', () => {
    const signature = authoritySign(peerId, authorityPrivateKey);
    const wrongPrivate = generatePrivateKey('ed25519', 'base64url') as string;
    const wrongPublic = getPublicKey(wrongPrivate, 'ed25519', 'base64url', 'base64url') as string;
    expect(verifyPeerAuthorization(peerId, wrongPublic, signature)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const signature = authoritySign(peerId, authorityPrivateKey);
    // Flip the leading character to a different valid base64url char.
    const tampered = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(verifyPeerAuthorization(peerId, authorityPublicKey, tampered)).toBe(false);
  });

  it('returns false (does not throw) on a malformed base64url signature', () => {
    expect(() =>
      expect(verifyPeerAuthorization(peerId, authorityPublicKey, 'not valid base64url!!! ***')).toBe(false)
    ).not.toThrow();
  });

  it('returns false (does not throw) on a garbage authority key', () => {
    const signature = authoritySign(peerId, authorityPrivateKey);
    expect(() =>
      expect(verifyPeerAuthorization(peerId, 'garbage-key-not-32-bytes', signature)).toBe(false)
    ).not.toThrow();
  });

  it('returns false on an empty signature without throwing', () => {
    expect(verifyPeerAuthorization(peerId, authorityPublicKey, '')).toBe(false);
  });

  it('regression: a signature produced via the inline authorizePeer construction still verifies', () => {
    // Reproduce the exact pre-helper construction that SeedBootstrapService used
    // (digest then sign) WITHOUT going through peerAuthorizationDigest. If the
    // shared digest ever drifts from this construction, this fails.
    const inlineDigest = digest(peerId, 'sha256', 'utf8', 'base64url') as string;
    const signature = sign(
      inlineDigest,
      authorityPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    expect(verifyPeerAuthorization(peerId, authorityPublicKey, signature)).toBe(true);
  });
});
