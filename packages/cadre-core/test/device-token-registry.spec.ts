import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import { authorityKeyFromLibp2p } from '../src/authority-key.js';
import { signDeviceTokenRecord } from '../src/device-token.js';

/**
 * End-to-end coverage of the device-token registry against a real Quereus control
 * DB. This is the only place that exercises the new `DeviceToken` schema (the
 * authority-signed `AuthorizedInsert` and the self-signed `AuthorizedUpdate` branch
 * verifying `Sig` against the bound `CadrePeer.PublicKey`, with monotonic/immutable
 * checks) — the publish path (`registerDeviceToken`), the resolve path
 * (`resolveDeviceToken`), and the clear path (`clearDeviceToken`) ride on top.
 */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface BootedNode {
  node: CadreNode;
  privateKeyB64: string;
  publicKeyB64: string;
  peerId: string;
}

/** Boot a CadreNode that is its own authority (so it can self-INSERT). */
async function bootAuthorityNode(): Promise<BootedNode> {
  const libp2pKey: PrivateKey = await generateKeyPair('Ed25519');
  const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(libp2pKey);
  const node = new CadreNode({
    controlNetwork: {
      partyId: 'device-token-' + Math.random().toString(36).slice(2),
      bootstrapNodes: [],
    },
    profile: 'transaction',
    privateKey: libp2pKey,
  });
  await node.start();
  const db = node.getControlDatabase();
  expect(db).not.toBeNull();
  await db!.insertAuthorityKey(publicKeyB64);
  node.initializeSeedBootstrap(privateKeyB64);
  // The authority node must have its own CadrePeer row (PublicKey) before any
  // DeviceToken it publishes can be resolved (membership + self-sig binding).
  await node.registerSelf();
  return { node, privateKeyB64, publicKeyB64, peerId: node.peerId!.toString() };
}

/**
 * Boot a started node that can self-sign (has its privateKey) but holds NO authority
 * service — i.e. a phone-shaped peer. It can self-update an existing row but cannot
 * authority-insert its first one.
 */
async function bootNonAuthorityNode(): Promise<CadreNode> {
  const libp2pKey: PrivateKey = await generateKeyPair('Ed25519');
  const node = new CadreNode({
    controlNetwork: {
      partyId: 'device-token-na-' + Math.random().toString(36).slice(2),
      bootstrapNodes: [],
    },
    profile: 'transaction',
    privateKey: libp2pKey,
  });
  await node.start();
  return node;
}

describe('device-token registry (real control DB)', () => {
  let booted: BootedNode;

  beforeEach(async () => {
    booted = await bootAuthorityNode();
  }, 60_000);

  afterEach(async () => {
    await booted.node.stop();
  });

  it('registers a self-signed token (authority insert) and resolves it back', async () => {
    const { node, peerId } = booted;
    await node.registerDeviceToken('fcm', 'fcm-token-1');

    const resolved = await node.resolveDeviceToken(peerId);
    expect(resolved).not.toBeNull();
    expect(resolved!.peerId).toBe(peerId);
    expect(resolved!.platform).toBe('fcm');
    expect(resolved!.token).toBe('fcm-token-1');
    expect(resolved!.updatedAt).toBeGreaterThan(0);
  }, 60_000);

  it('rotates the token via a strictly-increasing self-update; replay of the old record is rejected', async () => {
    const { node, peerId, privateKeyB64 } = booted;
    await node.registerDeviceToken('fcm', 'fcm-token-1');
    const first = await node.getControlDatabase()!.queryDeviceToken(peerId);

    // Rotation: a new token (and a platform switch) is a normal self-update.
    await node.registerDeviceToken('apns', 'apns-token-2');
    const second = await node.getControlDatabase()!.queryDeviceToken(peerId);
    expect(second!.token).toBe('apns-token-2');
    expect(second!.platform).toBe('apns');
    expect(second!.updatedAt).toBeGreaterThan(first!.updatedAt);

    const resolved = await node.resolveDeviceToken(peerId);
    expect(resolved!.token).toBe('apns-token-2');

    // Replay the FIRST record (equal/lower UpdatedAt) → monotonic clause fails,
    // authority branch absent (context AuthorityKey null) → constraint rejects.
    const replay = signDeviceTokenRecord(
      { peerId, platform: 'fcm', token: 'fcm-token-1', updatedAt: first!.updatedAt },
      privateKeyB64
    );
    await expect(node.getControlDatabase()!.updateSelfDeviceToken(replay)).rejects.toThrow();

    // Stored row is unchanged by the rejected replay.
    const after = await node.getControlDatabase()!.queryDeviceToken(peerId);
    expect(after!.token).toBe('apns-token-2');
    expect(after!.updatedAt).toBe(second!.updatedAt);
  }, 60_000);

  it('strictly increases UpdatedAt even on a same-millisecond rotation', async () => {
    const { node, peerId } = booted;
    await node.registerDeviceToken('fcm', 'a');
    const first = await node.getControlDatabase()!.queryDeviceToken(peerId);
    await node.registerDeviceToken('fcm', 'b');
    const second = await node.getControlDatabase()!.queryDeviceToken(peerId);
    expect(second!.updatedAt).toBeGreaterThan(first!.updatedAt);
  }, 60_000);

  it('lets a NON-authority member self-update its own token with its OWN key, then resolves', async () => {
    const { node } = booted;
    // Authority enrolls a drone (CadrePeer row → PublicKey) and seeds its DeviceToken
    // row carrying the drone's own self-sig. The drone then self-updates with its key.
    const drone = await generateKeyPair('Ed25519');
    const { privateKeyB64: dronePriv } = authorityKeyFromLibp2p(drone);
    const dronePeerId = peerIdFromPrivateKey(drone).toString();
    await node.authorizePeer(dronePeerId, []);

    const seed = signDeviceTokenRecord(
      { peerId: dronePeerId, platform: 'fcm', token: 'drone-tok-1', updatedAt: Date.now() },
      dronePriv
    );
    await node.getSeedBootstrapService()!.insertSelfDeviceToken(seed);
    expect((await node.resolveDeviceToken(dronePeerId))!.token).toBe('drone-tok-1');

    // Drone self-updates its OWN row with its own key — no authority context —
    // exercising the AuthorizedUpdate self-branch with a key distinct from the
    // authority key.
    const update = signDeviceTokenRecord(
      { peerId: dronePeerId, platform: 'apns', token: 'drone-tok-2', updatedAt: seed.updatedAt + 1 },
      dronePriv
    );
    await node.getControlDatabase()!.updateSelfDeviceToken(update);

    const resolved = await node.resolveDeviceToken(dronePeerId);
    expect(resolved!.token).toBe('drone-tok-2');
    expect(resolved!.platform).toBe('apns');
  }, 60_000);

  it('rejects a self-update signed by a key other than the bound CadrePeer.PublicKey', async () => {
    const { node } = booted;
    const drone = await generateKeyPair('Ed25519');
    const { privateKeyB64: dronePriv } = authorityKeyFromLibp2p(drone);
    const dronePeerId = peerIdFromPrivateKey(drone).toString();
    await node.authorizePeer(dronePeerId, []);
    const seed = signDeviceTokenRecord(
      { peerId: dronePeerId, platform: 'fcm', token: 'd1', updatedAt: Date.now() },
      dronePriv
    );
    await node.getSeedBootstrapService()!.insertSelfDeviceToken(seed);

    // Monotonic update, but signed with an unrelated key → verify against the bound
    // CadrePeer.PublicKey fails.
    const attacker = await generateKeyPair('Ed25519');
    const { privateKeyB64: attackerPriv } = authorityKeyFromLibp2p(attacker);
    const forged = signDeviceTokenRecord(
      { peerId: dronePeerId, platform: 'fcm', token: 'd2', updatedAt: seed.updatedAt + 1 },
      attackerPriv
    );
    await expect(node.getControlDatabase()!.updateSelfDeviceToken(forged)).rejects.toThrow();
  }, 60_000);

  it('resolves to null for a token whose stored self-sig does not match (tampered/forged Sig)', async () => {
    const { node } = booted;
    const drone = await generateKeyPair('Ed25519');
    const dronePeerId = peerIdFromPrivateKey(drone).toString();
    await node.authorizePeer(dronePeerId, []);

    // Authority CAN insert the row (insert only vouches the PeerId), but the carried
    // Sig is forged by an unrelated key → resolve re-verifies against the bound
    // CadrePeer.PublicKey and rejects it.
    const attacker = await generateKeyPair('Ed25519');
    const { privateKeyB64: attackerPriv } = authorityKeyFromLibp2p(attacker);
    const forged = signDeviceTokenRecord(
      { peerId: dronePeerId, platform: 'fcm', token: 'x', updatedAt: Date.now() },
      attackerPriv
    );
    await node.getSeedBootstrapService()!.insertSelfDeviceToken(forged);
    expect(await node.resolveDeviceToken(dronePeerId)).toBeNull();
  }, 60_000);

  it('resolves to null for a non-member peer', async () => {
    const { node } = booted;
    const stranger = await generateKeyPair('Ed25519');
    const strangerPeerId = peerIdFromPrivateKey(stranger).toString();
    expect(await node.resolveDeviceToken(strangerPeerId)).toBeNull();
  }, 60_000);

  it('resolves to null for a member that has a CadrePeer row but no DeviceToken row', async () => {
    // The booted node is a member (registerSelf ran in boot) but has not published
    // a token yet — the membership/binding gates pass, the missing-row gate trips.
    const { node, peerId } = booted;
    expect(await node.resolveDeviceToken(peerId)).toBeNull();
  }, 60_000);

  it('honors an explicit freshness ceiling (stale → null)', async () => {
    const { node, peerId } = booted;
    await node.registerDeviceToken('fcm', 'fresh');
    // Fresh under the default (no ceiling).
    expect(await node.resolveDeviceToken(peerId)).not.toBeNull();
    // With a zero ceiling, any positive age is stale → null.
    await delay(5);
    expect(await node.resolveDeviceToken(peerId, { maxAgeMs: 0 })).toBeNull();
  }, 60_000);

  it('clears the token (authority delete); subsequent resolve is null', async () => {
    const { node, peerId } = booted;
    await node.registerDeviceToken('fcm', 'to-be-cleared');
    expect(await node.resolveDeviceToken(peerId)).not.toBeNull();

    await node.clearDeviceToken();
    expect(await node.getControlDatabase()!.queryDeviceToken(peerId)).toBeNull();
    expect(await node.resolveDeviceToken(peerId)).toBeNull();

    // Clearing again is a no-op (no row).
    await node.clearDeviceToken();
  }, 60_000);

  it('throws when a non-authority node tries to self-insert its first token (no row, no authority)', async () => {
    // A phone-shaped peer: it can self-sign, but with no pre-existing row and no
    // authority service it cannot satisfy DeviceToken.AuthorizedInsert. The contract
    // is an explicit throw directing an authority to seed the row first.
    const node = await bootNonAuthorityNode();
    try {
      await expect(node.registerDeviceToken('fcm', 'phone-token')).rejects.toThrow(/authority/i);
    } finally {
      await node.stop();
    }
  }, 60_000);
});
