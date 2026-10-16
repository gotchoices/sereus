import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { cadreInviteConsentMessage, cadreInviteRedeemMessage, generateStampId } from '../src/control-database.js';
import { deviceTokenAddDigest } from '../src/peer-authorization.js';
import { signDeviceTokenRecord } from '../src/device-token.js';
import { expectConstraintFailure, freshKeyPair, freshStamp, signAs, signB64, type KeyPair } from './control-constraint-helpers.js';
import { mintContactJoiner, type TestContactJoiner } from './formation-consent-helper.js';

/**
 * `CadreNode.removeMachine` and `CadreNode.removeOwner` against one real control database.
 *
 * A machine admitted through a multi-use owner-granting invitation, holding a push token and
 * having vouched one device with the owner key the invitation seated, is removed in one
 * transaction: its row, token and invitation go, and its owner key, with the device it vouched,
 * stays. An owner key that vouched a device, another owner key and this node's own row is
 * removed with the device kept by re-vouch and this node's row re-vouched unasked; a re-vouch naming a row the key never vouched, or re-vouching an owner row
 * while the node is alone, is refused before anything is written. The refusals by name run
 * first, while the founding key is the only owner.
 *
 * The node's owner key is a fresh key, not its identity. The other machines are bare keypairs:
 * their rows are written as the production writers would write them (the redemption through
 * `redeemCadreInvite`; the push token and the vouched rows through the schema's own insert
 * rules), with no second node started.
 */
describe('CadreNode.removeMachine and removeOwner', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let owner: KeyPair;

  const signOwner = (message: Uint8Array): string => signAs(owner, message);
  /** A bare machine as the signer the helpers take: its base64url seed and public key. */
  const asSigner = (device: TestContactJoiner): KeyPair => ({ privateKey: device.privateKey, publicKey: device.peerKey });

  beforeAll(async () => {
    owner = freshKeyPair();
    node = new CadreNode({
      controlNetwork: { partyId: 'remove-machine-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
      profile: 'transaction',
      privateKey: await generateKeyPair('Ed25519'),
      trustedOwners: { pinnedKeys: [owner.publicKey] },
    });
    await node.start();
    db = node.getControlDatabase()!;
    rawDb = db.getDatabase();
    await db.insertOwnerKey(owner.publicKey);
    await node.initializeSeedBootstrap(owner.privateKey);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  /** An untargeted, owner-granting invitation the founder signs, with `uses` seats. */
  async function issueOwnerInvitation(uses: number): Promise<KeyPair> {
    const invite = freshKeyPair();
    await db.insertCadreInvite({ key: invite.publicKey, peerId: null, grantsOwner: true, totalUses: uses }, owner.publicKey, signOwner);
    return invite;
  }

  /** `device` redeems `invite` through the production writer, with a fresh nonce and both signatures. */
  function redeem(invite: KeyPair, device: TestContactJoiner) {
    const usageStampId = generateStampId(device.partyId);
    const fields = { inviteKey: invite.publicKey, usageStampId, peerKey: device.peerKey };
    return db.redeemCadreInvite({
      inviteKey: invite.publicKey,
      peerId: device.partyId,
      peerKey: device.peerKey,
      multiaddrs: ['/ip4/127.0.0.1/tcp/4001/ws'],
      usageStampId,
      inviteSig: signAs(invite, cadreInviteRedeemMessage(node.partyId, fields)),
      peerSig: signAs(asSigner(device), cadreInviteConsentMessage(node.partyId, fields)),
    });
  }

  /** The owner-signed `DeviceToken` insert `registerDeviceToken` makes for a machine's own self-signed token. */
  async function seatDeviceToken(device: TestContactJoiner): Promise<void> {
    const record = signDeviceTokenRecord(node.partyId, { peerId: device.partyId, platform: 'fcm', token: `token-${device.partyId.slice(-6)}`, updatedAt: Date.now() }, device.privateKey);
    const stampId = freshStamp();
    const approval = signB64(owner, deviceTokenAddDigest(node.partyId, { ...record, stampId }));
    await rawDb.exec(
      `insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?)`,
      [owner.publicKey, approval, record.peerId, record.platform, record.token, record.updatedAt, record.sig, stampId],
    );
  }

  /** `voucher` (an owner) vouches `device`'s membership row through the production writer, as `authorizePeer` does; returns the row's stamp. */
  async function vouchDevice(voucher: KeyPair, device: TestContactJoiner, updatedAt: number): Promise<string> {
    const row = { peerId: device.partyId, publicKey: device.peerKey, multiaddr: '', updatedAt, sig: null, profile: null };
    expect(await db.insertCadrePeer(row, voucher.publicKey, (message) => signAs(voucher, message))).toBe(true);
    return (await db.queryCadrePeerStampId(device.partyId))!;
  }

  /** `voucher` (an owner) seats `key` as a further owner through the database writer, as `addOwner` does. */
  async function vouchOwner(voucher: KeyPair, key: KeyPair): Promise<void> {
    expect(await db.insertOwnerKeyVouched(key.publicKey, voucher.publicKey, (message) => signAs(voucher, message))).toBe(true);
  }

  function rawRow(sql: string, key: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get(sql, [key]);
  }

  async function tombstonedKeys(): Promise<string[]> {
    return (await db.queryRevocations()).map((row) => row.rowKey);
  }

  it('refuses an owner key removal by name: the only owner key, this node\'s own, and one with no live row', async () => {
    expect((await node.planOwnerKeyRemoval(owner.publicKey)).refusal).toBe('last-owner');
    await expect(node.removeOwner(owner.publicKey)).rejects.toMatchObject({ name: 'OwnerKeyRemovalRefusedError', code: 'last-owner' });

    await vouchOwner(owner, freshKeyPair());
    await expect(node.removeOwner(owner.publicKey)).rejects.toMatchObject({ name: 'OwnerKeyRemovalRefusedError', code: 'self' });
    await expect(node.removeOwner(freshKeyPair().publicKey)).rejects.toMatchObject({ name: 'OwnerKeyRemovalRefusedError', code: 'unknown' });

    expect((await db.getOwnerKeys()).has(owner.publicKey)).toBe(true);
    expect(await tombstonedKeys()).toEqual([]);
  }, 60_000);

  it('removes a machine completely in one transaction, leaving its owner key and the device that key vouched', async () => {
    const invite = await issueOwnerInvitation(3);
    const machine = await mintContactJoiner();
    const admitted = await redeem(invite, machine);
    expect(admitted.alreadyMember).toBe(false);
    // The redemption's membership notification ran the anchor sync: the issuer is anchored, so
    // the seated owner key is derived from the row the node itself wrote.
    expect(node.getTrustedOwnerStore()!.sources().get(machine.peerKey)).toBe('chain');
    await seatDeviceToken(machine);
    const dependent = await mintContactJoiner();
    await vouchDevice(asSigner(machine), dependent, Date.now() - 1_000);

    const plan = await node.planMachineRemoval(machine.partyId);
    expect(plan).toEqual({
      machine: expect.objectContaining({ peerId: machine.partyId, isSelf: false, trusted: true, vouchedBy: owner.publicKey }),
      refusal: null,
      invitations: [invite.publicKey],
    });

    const result = await node.removeMachine(machine.partyId);
    expect(result).toEqual({ removedPeer: true, removedDeviceToken: true, withdrawnInvitations: [invite.publicKey] });

    // The machine's row and token are gone and their stamps retired; the invitation's row stays, withdrawn.
    expect(await rawRow('select PeerId from CadreControl.CadrePeer where PeerId = ?', machine.partyId)).toBeUndefined();
    expect(await rawRow('select PeerId from CadreControl.DeviceToken where PeerId = ?', machine.partyId)).toBeUndefined();
    const tombstones = await db.queryRevocations();
    expect(tombstones.filter((row) => row.rowKey === machine.partyId).map((row) => row.tableName).sort()).toEqual(['CadrePeer', 'DeviceToken']);
    expect(tombstones.filter((row) => row.rowKey === invite.publicKey).map((row) => row.tableName)).toEqual(['CadreInvite']);
    expect(tombstones.every((row) => row.signerKey === owner.publicKey)).toBe(true);
    expect((await node.listCadreInvitations()).find((status) => status.invite.key === invite.publicKey)).toMatchObject({ withdrawn: true, live: false, usesRecorded: 1 });
    // The machine cannot come back through the invitation it redeemed, seats left or not.
    await expectConstraintFailure(redeem(invite, machine), 'Authorized');

    // The owner key the invitation seated is the person's: it stays, trusted, and so does what it vouched.
    expect(tombstones.some((row) => row.rowKey === machine.peerKey)).toBe(false);
    expect((await node.listOwnerKeys()).find((entry) => entry.key === machine.peerKey)).toMatchObject({ trusted: true });
    expect((await node.listAuthorizedMembers()).map((row) => row.peerId)).toEqual([dependent.partyId]);
    expect((await node.listMachines()).map((entry) => entry.peerId)).not.toContain(machine.partyId);
  }, 60_000);

  it('removes an owner key, re-vouching the device it vouched first; an owner re-vouch while alone and a row it did not vouch are refused before any write', async () => {
    const removed = freshKeyPair();
    await vouchOwner(owner, removed);
    const ownerDependent = freshKeyPair();
    await vouchOwner(removed, ownerDependent);
    const device = await mintContactJoiner();
    const devicePublishedAt = Date.now() - 1_000;
    const deviceStamp = await vouchDevice(removed, device, devicePublishedAt);
    const bystander = await mintContactJoiner();
    await vouchDevice(owner, bystander, Date.now());
    // This node's own row stands on the key about to be removed, as a device admitted by the
    // lost phone's invitation does: it is not offered as a dependent, and is re-vouched unasked.
    expect(await node.registerSelf()).not.toBe('skipped');
    const selfPeerId = node.peerId!.toString();
    const ownRow = (await db.queryCadrePeers()).find((row) => row.peerId === selfPeerId)!;
    expect(await db.reauthorizeCadrePeer(selfPeerId, ownRow.updatedAt, removed.publicKey, (message) => signAs(removed, message))).toBe(true);

    const plan = await node.planOwnerKeyRemoval(removed.publicKey);
    expect(plan).toEqual({
      ownerKey: { key: removed.publicKey, label: null, vouchedBy: owner.publicKey, heldHere: false, trusted: true },
      refusal: null,
      dependents: { owners: [ownerDependent.publicKey], peers: [device.partyId] },
      revouchesOwnRow: true,
      ownDependency: false,
    });

    await expect(node.removeOwner(removed.publicKey, { revouch: { peers: [bystander.partyId] } }))
      .rejects.toThrow(/re-vouch names rows the removed owner key did not vouch/);
    // Authorized siblings and no control connection: the re-added owner row would stay on this node.
    expect(node.getControlConnectionCount()).toBe(0);
    await expect(node.removeOwner(removed.publicKey, { revouch: { owners: [ownerDependent.publicKey] } }))
      .rejects.toMatchObject({ name: 'OwnerKeyRemovalRefusedError', code: 'alone' });
    expect((await db.getOwnerKeys()).has(removed.publicKey)).toBe(true);
    expect(await tombstonedKeys()).not.toContain(removed.publicKey);
    expect(await tombstonedKeys()).not.toContain(ownerDependent.publicKey);

    const result = await node.removeOwner(removed.publicKey, { revouch: { peers: [device.partyId] } });
    expect(result).toEqual({ removed: true, revouched: { owners: [], peers: [selfPeerId, device.partyId] } });

    expect(await rawRow('select Key from CadreControl.OwnerKey where Key = ?', removed.publicKey)).toBeUndefined();
    const [tombstone] = (await db.queryRevocations()).filter((row) => row.rowKey === removed.publicKey);
    expect(tombstone).toMatchObject({ tableName: 'OwnerKey', signerKey: owner.publicKey });
    // The device stands on the remover's signature, with its own stamp and freshness untouched.
    const rows = await db.queryCadrePeers();
    expect(rows.find((row) => row.peerId === device.partyId))
      .toMatchObject({ vouchOwner: owner.publicKey, vouchUsage: null, stampId: deviceStamp, updatedAt: devicePublishedAt });
    expect(rows.find((row) => row.peerId === selfPeerId)).toMatchObject({ vouchOwner: owner.publicKey, sig: ownRow.sig, updatedAt: ownRow.updatedAt });
    expect((await node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(device.partyId);
  }, 60_000);
});
