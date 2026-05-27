import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
import { getPublicKey, digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { authorityKeyFromLibp2p } from '../src/authority-key.js';

describe('authorityKeyFromLibp2p', () => {
  it('derives a base64url keypair whose public key matches getPublicKey(priv)', async () => {
    const libp2pKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(libp2pKey);

    const derivedPub = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
    expect(derivedPub).toBe(publicKeyB64);
  });

  it('produces a keypair that round-trips a sign/verify', async () => {
    const libp2pKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(libp2pKey);

    const msgDigest = digest('hello cadre', 'sha256', 'utf8', 'base64url') as string;
    const signature = sign(msgDigest, privateKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url') as string;

    expect(verify(msgDigest, signature, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(true);
  });

  it('matches the libp2p-reported public key bytes', async () => {
    const libp2pKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = authorityKeyFromLibp2p(libp2pKey);

    // libp2p exposes the 32-byte raw public key; it must equal what we encode.
    expect(publicKeyB64).toBe(u8ToString(libp2pKey.publicKey.raw, 'base64url'));
  });

  it('rejects non-Ed25519 keys', async () => {
    const secpKey = await generateKeyPair('secp256k1');
    expect(() => authorityKeyFromLibp2p(secpKey)).toThrow(/Ed25519/);
  });
});
