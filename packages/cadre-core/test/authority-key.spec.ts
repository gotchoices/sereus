import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
import { getPublicKey, generatePrivateKey, digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { authorityKeyFromLibp2p, authorityPublicKeyFromPrivate } from '../src/authority-key.js';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

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

describe('authorityPublicKeyFromPrivate', () => {
  it('derives the same public key as the seed-bootstrap signer (getPublicKey)', () => {
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;

    const expected = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
    expect(authorityPublicKeyFromPrivate(privateKeyB64)).toBe(expected);
  });

  it('produces a public key that verifies a signature from its private seed', () => {
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    const publicKeyB64 = authorityPublicKeyFromPrivate(privateKeyB64);

    const msgDigest = digest('hello drone', 'sha256', 'utf8', 'base64url') as string;
    const signature = sign(msgDigest, privateKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url') as string;

    expect(verify(msgDigest, signature, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(true);
  });
});

/**
 * Locks the drone-fixture invariant (reference-app-rn e2e): an invite carries
 * `authorityKeys` only after the authority key is enrolled via
 * `ensureAuthorityKey`. Without enrollment, `getAuthorityKeys()` is empty and
 * `createInvite` serializes `authorityKeys` as `undefined` — pinning nothing.
 *
 * Drives a real CadreNode with its libp2p node + control database stubbed so
 * `initializeSeedBootstrap` / `createInvite` run without a live network
 * (mirrors invite-address-push.spec.ts).
 */
describe('createInvite carries the enrolled drone authority key', () => {
  function makeNode(authorityKeys: Set<string>): CadreNode {
    const node = new CadreNode({
      controlNetwork: { partyId: 'enroll-test', bootstrapNodes: [] },
      profile: 'transaction',
    });

    const mockLibp2p = {
      peerId: { toString: () => '12D3KooWEnrollTestPeer' },
      getMultiaddrs: () => [{ toString: () => '/ip4/127.0.0.1/tcp/4001' }],
      handle: async () => {},
      unhandle: async () => {},
    };

    (node as unknown as { controlNode: unknown }).controlNode = mockLibp2p;
    (node as unknown as { controlDatabase: ControlDatabase }).controlDatabase = {
      ensureAuthorityKey: async (key: string) => { authorityKeys.add(key); return true; },
      getAuthorityKeys: async () => authorityKeys,
    } as unknown as ControlDatabase;

    return node;
  }

  it('includes the enrolled key in invite.authorityKeys', async () => {
    const enrolled = new Set<string>();
    const node = makeNode(enrolled);
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(privateKeyB64);

    const publicKeyB64 = authorityPublicKeyFromPrivate(privateKeyB64);
    await node.getControlDatabase()!.ensureAuthorityKey(publicKeyB64);

    const { invite } = await node.createInvite();
    expect(invite.authorityKeys).toContain(publicKeyB64);
  });

  it('leaves authorityKeys undefined when nothing is enrolled', async () => {
    const node = makeNode(new Set<string>());
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(privateKeyB64);

    const { invite } = await node.createInvite();
    expect(invite.authorityKeys).toBeUndefined();
  });
});
