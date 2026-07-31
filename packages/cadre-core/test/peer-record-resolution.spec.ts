import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { ed25519PublicKeyB64FromPeerId } from '../src/seed-bootstrap.js';
import { signPeerRecord, verifyPeerRecordSignature } from '../src/peer-record.js';
import type { PeerAddressRecord } from '../src/types.js';

/**
 * End-to-end coverage of the peer-record resolution layer against a real Quereus
 * control DB. This is the only place that exercises the rewritten `CadrePeer`
 * schema (PublicKey/UpdatedAt/Sig columns, the self-signed `AuthorizedUpdate`
 * branch with `cast`/`||`/monotonic/immutable checks) — the publish path
 * (`registerSelf`) and the resolve path (`resolvePeerAddrs`) ride on top of it.
 */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const circuitAddr = (self: string) =>
  `/dns4/relay.example.org/tcp/4001/p2p/12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/p2p-circuit/p2p/${self}`;

interface BootedNode {
  node: CadreNode;
  privateKeyB64: string;
  publicKeyB64: string;
  peerId: string;
}

/** Boot a CadreNode that is its own owner (so it can self-INSERT). */
async function bootOwnerNode(): Promise<BootedNode> {
  const libp2pKey: PrivateKey = await generateKeyPair('Ed25519');
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);
  const node = new CadreNode({
    controlNetwork: {
      partyId: 'peer-record-' + Math.random().toString(36).slice(2),
      bootstrapNodes: [],
    },
    profile: 'transaction',
    privateKey: libp2pKey,
  });
  await node.start();
  const db = node.getControlDatabase();
  expect(db).not.toBeNull();
  await db!.insertOwnerKey(publicKeyB64);
  node.initializeSeedBootstrap(privateKeyB64);
  return { node, privateKeyB64, publicKeyB64, peerId: node.peerId!.toString() };
}

/**
 * Mint a self-signed record for a brand-new (different) peer and insert it via
 * the owner node — the owner signs the INSERT, the row carries the
 * other peer's own valid Sig, so it resolves like a peer that self-published.
 */
async function insertForeignMember(
  owner: BootedNode,
  addrs: string[],
  updatedAt: number,
  overrides?: Partial<PeerAddressRecord>
): Promise<{ peerId: string; record: PeerAddressRecord }> {
  const key = await generateKeyPair('Ed25519');
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
  const peerId = peerIdFromPrivateKey(key).toString();
  const signed = signPeerRecord({ peerId, publicKey: publicKeyB64, addrs, updatedAt }, privateKeyB64);
  const record = { ...signed, ...overrides };
  await owner.node.getSeedBootstrapService()!.insertSelfPeerRecord(record);
  return { peerId, record };
}

/**
 * Hook `publishSelfRecord`'s reads of the node's OWN row so a test can wedge a
 * concurrent writer into its read-then-insert window deterministically, instead of
 * hoping for timing luck. `hook(readIndex, read)` returns what that read should hand
 * back, and decides for itself whether its writes land before or after `read()` —
 * the two orderings mean very different things to the publish. `reads()` is there so
 * a test can assert the wedge fired at all; a refactor that stops reading through
 * this method would otherwise make the test pass silently.
 */
function hookSelfReads(
  node: CadreNode,
  peerId: string,
  hook: (readIndex: number, read: () => Promise<PeerAddressRecord | null>) => Promise<PeerAddressRecord | null>
): { reads: () => number; restore: () => void } {
  const db = node.getControlDatabase()!;
  const original = db.queryPeerRecord.bind(db);
  let reads = 0;
  db.queryPeerRecord = (pid: string): Promise<PeerAddressRecord | null> =>
    pid === peerId ? hook(++reads, () => original(pid)) : original(pid);
  return { reads: () => reads, restore: () => { db.queryPeerRecord = original; } };
}

describe('peer-record resolution layer (real control DB)', () => {
  let booted: BootedNode;

  beforeEach(async () => {
    booted = await bootOwnerNode();
  }, 60_000);

  afterEach(async () => {
    await booted.node.stop();
  });

  it('publishes a self-signed, freshness-stamped record and resolves it back (signaling-first)', async () => {
    const { node, peerId, publicKeyB64 } = booted;
    const sig = circuitAddr(peerId);
    const direct = '/ip4/1.2.3.4/tcp/4001';
    // Push synthetic addrs so the published set is deterministic (and includes a
    // /p2p-circuit signaling addr without needing a live relay).
    node.setInviteAddresses([direct, sig]);

    await node.registerSelf();

    // The stored row carries the derived PublicKey, a positive UpdatedAt, and a
    // self-signature that verifies.
    const stored = await node.getControlDatabase()!.queryPeerRecord(peerId);
    expect(stored).not.toBeNull();
    expect(stored!.publicKey).toBe(publicKeyB64);
    expect(ed25519PublicKeyB64FromPeerId(peerId)).toBe(stored!.publicKey);
    expect(stored!.updatedAt).toBeGreaterThan(0);
    expect(verifyPeerRecordSignature(stored!)).toBe(true);

    // Resolution returns the addrs signaling-first.
    const resolved = (await node.resolvePeerAddrs(peerId)).map((m) => m.toString());
    expect(resolved).toEqual([sig, direct]);

    // signalingOnly returns only the /p2p-circuit addr.
    const signalingOnly = (await node.resolvePeerAddrs(peerId, { signalingOnly: true })).map((m) => m.toString());
    expect(signalingOnly).toEqual([sig]);
  }, 60_000);

  it('resolves a different member from its PeerId alone', async () => {
    const { node } = booted;
    const memberAddrs = ['/ip4/9.9.9.9/tcp/4001'];
    const memberSig = '/dns4/relay.example.org/tcp/4001/p2p/12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/p2p-circuit/p2p/12D3KooWMember';
    const { peerId } = await insertForeignMember(booted, [...memberAddrs, memberSig], Date.now());

    const resolved = (await node.resolvePeerAddrs(peerId)).map((m) => m.toString());
    // signaling-first
    expect(resolved[0]).toContain('/p2p-circuit');
    expect(new Set(resolved)).toEqual(new Set([memberSig, ...memberAddrs]));
  }, 60_000);

  it('re-publishes with a new addr and strictly greater UpdatedAt on address change', async () => {
    const { node, peerId } = booted;
    node.setInviteAddresses([circuitAddr(peerId), '/ip4/1.1.1.1/tcp/4001']);
    await node.registerSelf();
    const first = await node.getControlDatabase()!.queryPeerRecord(peerId);

    // Simulate a relay-reservation rotation: new addrs, re-publish (this is what
    // the self:peer:update listener / heartbeat invoke).
    node.setInviteAddresses([circuitAddr(peerId), '/ip4/2.2.2.2/tcp/4001']);
    await node.registerSelf();
    const second = await node.getControlDatabase()!.queryPeerRecord(peerId);

    expect(second!.updatedAt).toBeGreaterThan(first!.updatedAt);
    expect(second!.addrs).toContain('/ip4/2.2.2.2/tcp/4001');
    expect(second!.addrs).not.toContain('/ip4/1.1.1.1/tcp/4001');
    expect(verifyPeerRecordSignature(second!)).toBe(true);
  }, 60_000);

  it('carries a valid self-signature when an authorize lands mid-publish', async () => {
    const { node, peerId } = booted;
    node.setInviteAddresses([circuitAddr(peerId), '/ip4/1.2.3.4/tcp/4001']);

    // Wedge the authorize into the exact window: after publishSelfRecord's
    // "does my row exist?" read returned null, before its INSERT. The insert is
    // idempotent, so the authorize's null-Sig row wins the seat and the publish
    // must notice and self-update — otherwise the row never resolves until the
    // next heartbeat.
    const wedge = hookSelfReads(node, peerId, async (index, read) => {
      const result = await read();
      if (index === 1) await node.authorizePeer(peerId, []);
      return result;
    });

    const outcome = await node.registerSelf();
    // Restore before asserting so a later read cannot re-trigger the wedge.
    wedge.restore();
    // The pre-race read plus the fall-through's re-read of the row that landed.
    expect(wedge.reads()).toBe(2);

    const stored = await node.getControlDatabase()!.queryPeerRecord(peerId);
    expect(verifyPeerRecordSignature(stored!)).toBe(true);
    expect((await node.resolvePeerAddrs(peerId)).length).toBeGreaterThan(0);
    // The write that landed was an UPDATE of the authorize's row.
    expect(outcome).toBe('refreshed');
  }, 60_000);

  it('keeps the self-signature when the authorize lands after the publish', async () => {
    const { node, peerId } = booted;
    node.setInviteAddresses([circuitAddr(peerId), '/ip4/1.2.3.4/tcp/4001']);

    // Reverse order: the self-publish seats the row, and the authorize's
    // idempotent insert must leave the signed row alone.
    await node.registerSelf();
    await node.authorizePeer(peerId, []);

    const stored = await node.getControlDatabase()!.queryPeerRecord(peerId);
    expect(verifyPeerRecordSignature(stored!)).toBe(true);
    expect((await node.resolvePeerAddrs(peerId)).length).toBeGreaterThan(0);
  }, 60_000);

  it('skips rather than self-updating a row that was removed mid-publish', async () => {
    const { node, peerId } = booted;
    node.setInviteAddresses([circuitAddr(peerId), '/ip4/1.2.3.4/tcp/4001']);

    // Two writers wedged into one publish: the authorize takes the seat (so the
    // INSERT no-ops and the publish falls through), then the row is removed before
    // the fall-through re-read — so there is nothing left to sign against.
    const wedge = hookSelfReads(node, peerId, async (index, read) => {
      if (index === 1) {
        const result = await read();
        await node.authorizePeer(peerId, []);
        return result;
      }
      if (index === 2) await node.removePeer(peerId);
      return read();
    });

    const outcome = await node.registerSelf();
    wedge.restore();

    expect(wedge.reads()).toBe(2);
    expect(outcome).toBe('skipped');
    // No phantom row: the publish must not have re-inserted or updated anything.
    expect(await node.getControlDatabase()!.queryPeerRecord(peerId)).toBeNull();
  }, 60_000);

  it('rejects a self-update whose UpdatedAt does not strictly increase (replay guard)', async () => {
    const { node, peerId, publicKeyB64, privateKeyB64 } = booted;
    node.setInviteAddresses(['/ip4/3.3.3.3/tcp/4001']);
    await node.registerSelf();
    const current = await node.getControlDatabase()!.queryPeerRecord(peerId);

    // Re-sign with updatedAt EQUAL to the stored one → monotonic clause fails,
    // owner branch absent (context OwnerKey null) → constraint rejects.
    const stale = signPeerRecord(
      { peerId, publicKey: publicKeyB64, addrs: ['/ip4/4.4.4.4/tcp/4001'], updatedAt: current!.updatedAt },
      privateKeyB64
    );
    await expect(node.getControlDatabase()!.updateSelfPeerRecord(stale)).rejects.toThrow();

    // The stored row is unchanged.
    const after = await node.getControlDatabase()!.queryPeerRecord(peerId);
    expect(after!.updatedAt).toBe(current!.updatedAt);
    expect(after!.addrs).not.toContain('/ip4/4.4.4.4/tcp/4001');
  }, 60_000);

  it('rejects a self-update signed by a key other than the row PublicKey', async () => {
    const { node, peerId, publicKeyB64 } = booted;
    node.setInviteAddresses(['/ip4/5.5.5.5/tcp/4001']);
    await node.registerSelf();
    const current = await node.getControlDatabase()!.queryPeerRecord(peerId);

    // Sign a (monotonic) update with an unrelated key, but keep the row's real
    // PublicKey — the constraint verifies Sig against PublicKey → fails.
    const attacker = await generateKeyPair('Ed25519');
    const { privateKeyB64: attackerPriv } = ed25519KeyPairFromLibp2p(attacker);
    const forged = signPeerRecord(
      { peerId, publicKey: publicKeyB64, addrs: ['/ip4/6.6.6.6/tcp/4001'], updatedAt: current!.updatedAt + 1 },
      attackerPriv
    );
    await expect(node.getControlDatabase()!.updateSelfPeerRecord(forged)).rejects.toThrow();
  }, 60_000);

  it('filters out a stale record (freshness ceiling)', async () => {
    const { node, peerId } = booted;
    node.setInviteAddresses([circuitAddr(peerId)]);
    await node.registerSelf();

    // Fresh under the default ceiling.
    expect((await node.resolvePeerAddrs(peerId)).length).toBeGreaterThan(0);

    // With a zero ceiling, any positive age is stale → empty (never a dead relay).
    await delay(5);
    expect(await node.resolvePeerAddrs(peerId, { maxAgeMs: 0 })).toEqual([]);
  }, 60_000);

  it('rejects on a publicKey<->peerId binding mismatch', async () => {
    const { node } = booted;
    // Insert a row whose stored PublicKey is NOT the key embedded in the peerId.
    const { peerId } = await insertForeignMember(booted, ['/ip4/7.7.7.7/tcp/4001'], Date.now(), {
      publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(await node.resolvePeerAddrs(peerId)).toEqual([]);
  }, 60_000);

  it('resolves to empty for an authorized member that has not self-published (no Sig)', async () => {
    const { node } = booted;
    // authorizePeer inserts a row with a derived PublicKey but Sig = null.
    const other = await generateKeyPair('Ed25519');
    const otherPeerId = peerIdFromPrivateKey(other).toString();
    await node.authorizePeer(otherPeerId, ['/ip4/8.8.8.8/tcp/4001']);
    expect(await node.resolvePeerAddrs(otherPeerId)).toEqual([]);
  }, 60_000);

  it('lets a NON-owner member self-update its own row with its OWN key, then resolves', async () => {
    const { node } = booted;
    // Owner inserts a drone with a derived PublicKey but no Sig (Sig = null):
    // it is a member but does not resolve until it self-publishes.
    const drone = await generateKeyPair('Ed25519');
    const { privateKeyB64: dronePriv, publicKeyB64: dronePub } = ed25519KeyPairFromLibp2p(drone);
    const dronePeerId = peerIdFromPrivateKey(drone).toString();
    await node.authorizePeer(dronePeerId, []);
    expect(await node.resolvePeerAddrs(dronePeerId)).toEqual([]);

    // The drone signs an update to its OWN row with its own peer key — no owner
    // context — exercising the AuthorizedUpdate self-branch with a key distinct
    // from the owner key (the owner node's own self-update happens to sign
    // with the owner key, so this is the only coverage of a true drone refresh).
    const current = await node.getControlDatabase()!.queryPeerRecord(dronePeerId);
    const droneSig = circuitAddr(dronePeerId);
    const direct = '/ip4/10.0.0.1/tcp/4001';
    const record = signPeerRecord(
      { peerId: dronePeerId, publicKey: dronePub, addrs: [droneSig, direct], updatedAt: current!.updatedAt + 1 },
      dronePriv
    );
    await node.getControlDatabase()!.updateSelfPeerRecord(record);

    const resolved = (await node.resolvePeerAddrs(dronePeerId)).map((m) => m.toString());
    expect(resolved[0]).toContain('/p2p-circuit');
    expect(new Set(resolved)).toEqual(new Set([droneSig, direct]));
  }, 60_000);

  it('resolves to empty for a non-member', async () => {
    const { node } = booted;
    const stranger = await generateKeyPair('Ed25519');
    const strangerPeerId = peerIdFromPrivateKey(stranger).toString();
    expect(await node.resolvePeerAddrs(strangerPeerId)).toEqual([]);
  }, 60_000);

  it('applies a restrictive injected trust policy before returning addrs', async () => {
    const { node, peerId } = booted;
    node.setInviteAddresses([circuitAddr(peerId)]);
    await node.registerSelf();

    // Default policy resolves it...
    expect((await node.resolvePeerAddrs(peerId)).length).toBeGreaterThan(0);
    // ...a rejecting policy filters it out even though sig + freshness pass.
    const rejected = await node.resolvePeerAddrs(peerId, {
      trustPolicy: { evaluate: () => false },
    });
    expect(rejected).toEqual([]);
  }, 60_000);
});
