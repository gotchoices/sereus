import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
import { getPublicKey, generatePrivateKey, digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore } from '../src/trusted-owner-store.js';

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
 * Locks the drone-fixture invariant (reference-app-rn e2e): the `ownerKeys` an
 * invite hands out come from the issuer's node-local trusted-owner anchor —
 * seeded by `initializeSeedBootstrap` (genesis self-trust) — and NEVER from the
 * replicated `OwnerKey` table, which any connecting node can pollute. The
 * invitee anchors whatever arrives, so a table-sourced pin would poison it.
 *
 * Drives a real CadreNode with its libp2p node, control database and anchor
 * stubbed so `initializeSeedBootstrap` / `createInvite` run without a live
 * network (mirrors invite-address-push.spec.ts).
 */
describe('createInvite hands out the anchored owner keys', () => {
  const partyId = 'enroll-test';

  function makeNode(replicatedOwnerKeys: Set<string>, anchor: TrustedOwnerStore | null) {
    const node = new CadreNode({
      controlNetwork: { partyId, bootstrapNodes: [] },
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
      ensureOwnerKey: async (key: string) => { replicatedOwnerKeys.add(key); return true; },
      getOwnerKeys: async () => replicatedOwnerKeys,
    } as unknown as ControlDatabase;
    (node as unknown as { trustedOwnerStore: TrustedOwnerStore | null }).trustedOwnerStore = anchor;

    return node;
  }

  it('carries the key initializeSeedBootstrap genesis-anchored, with an empty replicated table', async () => {
    const node = makeNode(new Set<string>(), new MemoryTrustedOwnerStore(partyId));
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(privateKeyB64);

    const { invite } = await node.createInvite();
    expect(invite.ownerKeys).toEqual([ed25519PublicKeyFromPrivate(privateKeyB64)]);
  });

  it('never hands out a key that only reached the replicated OwnerKey table', async () => {
    // What a stranger's genesis insert looks like once it has replicated in.
    const replicated = new Set<string>(['attacker-genesis-key']);
    const node = makeNode(replicated, new MemoryTrustedOwnerStore(partyId));
    const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(privateKeyB64);
    await node.getControlDatabase()!.ensureOwnerKey(ed25519PublicKeyFromPrivate(privateKeyB64));

    const { invite } = await node.createInvite();
    expect(invite.ownerKeys).toEqual([ed25519PublicKeyFromPrivate(privateKeyB64)]);
  });

  it('leaves ownerKeys undefined when the anchor is empty', async () => {
    // A receive-only node: enableSeedListener builds a service without the
    // genesis self-anchor initializeSeedBootstrap performs.
    const node = makeNode(new Set<string>(['some-replicated-key']), new MemoryTrustedOwnerStore(partyId));
    node.enableSeedListener();

    const { invite } = await node.createInvite();
    expect(invite.ownerKeys).toBeUndefined();
  });
});
