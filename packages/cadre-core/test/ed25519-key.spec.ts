import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
import { getPublicKey, generatePrivateKey, digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

describe('ed25519KeyPairFromLibp2p', () => {
  it('derives a base64url keypair whose public key matches getPublicKey(priv)', async () => {
    const libp2pKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);

    const derivedPub = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
    expect(derivedPub).toBe(publicKeyB64);
  });

  it('produces a keypair that round-trips a sign/verify', async () => {
    const libp2pKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);

    const msgDigest = digest(['hello cadre'], 'sha256', 'base64url') as string;
    const signature = sign(msgDigest, privateKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url') as string;

    expect(verify(msgDigest, signature, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(true);
  });

  it('matches the libp2p-reported public key bytes', async () => {
    const libp2pKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);

    // libp2p exposes the 32-byte raw public key; it must equal what we encode.
    expect(publicKeyB64).toBe(u8ToString(libp2pKey.publicKey.raw, 'base64url'));
  });

  it('rejects non-Ed25519 keys', async () => {
    const secpKey = await generateKeyPair('secp256k1');
    expect(() => ed25519KeyPairFromLibp2p(secpKey)).toThrow(/Ed25519/);
  });
});

describe('ed25519PublicKeyFromPrivate', () => {
  it('derives the same public key as the seed-bootstrap signer (getPublicKey)', () => {
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;

    const expected = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
    expect(ed25519PublicKeyFromPrivate(privateKeyB64)).toBe(expected);
  });

  it('produces a public key that verifies a signature from its private seed', () => {
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    const publicKeyB64 = ed25519PublicKeyFromPrivate(privateKeyB64);

    const msgDigest = digest(['hello drone'], 'sha256', 'base64url') as string;
    const signature = sign(msgDigest, privateKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url') as string;

    expect(verify(msgDigest, signature, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(true);
  });
});

/**
 * Locks the drone-fixture invariant (reference-app-rn e2e): an invite carries
 * `ownerKeys` only after the owner key is enrolled via
 * `ensureOwnerKey`. Without enrollment, `getOwnerKeys()` is empty and
 * `createInvite` serializes `ownerKeys` as `undefined` — pinning nothing.
 *
 * Drives a real CadreNode with its libp2p node + control database stubbed so
 * `initializeSeedBootstrap` / `createInvite` run without a live network
 * (mirrors invite-address-push.spec.ts).
 */
describe('createInvite carries the enrolled drone owner key', () => {
  function makeNode(ownerKeys: Set<string>): CadreNode {
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
      ensureOwnerKey: async (key: string) => { ownerKeys.add(key); return true; },
      getOwnerKeys: async () => ownerKeys,
    } as unknown as ControlDatabase;

    return node;
  }

  it('includes the enrolled key in invite.ownerKeys', async () => {
    const enrolled = new Set<string>();
    const node = makeNode(enrolled);
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(privateKeyB64);

    const publicKeyB64 = ed25519PublicKeyFromPrivate(privateKeyB64);
    await node.getControlDatabase()!.ensureOwnerKey(publicKeyB64);

    const { invite } = await node.createInvite();
    expect(invite.ownerKeys).toContain(publicKeyB64);
  });

  it('leaves ownerKeys undefined when nothing is enrolled', async () => {
    const node = makeNode(new Set<string>());
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(privateKeyB64);

    const { invite } = await node.createInvite();
    expect(invite.ownerKeys).toBeUndefined();
  });
});
