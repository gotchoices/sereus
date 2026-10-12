import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { cadreInviteConsentMessage, cadreInviteRedeemMessage, generateStampId } from '../src/control-database.js';
import { ed25519KeyPairFromLibp2p, peerIdFromEd25519PublicKeyB64 } from '../src/ed25519-key.js';
import { deviceTokenAddDigest } from '../src/peer-authorization.js';
import { signDeviceTokenRecord } from '../src/device-token.js';
import { expectConstraintFailure, freshKeyPair, freshStamp, signAs, signB64, type KeyPair } from './control-constraint-helpers.js';
import { mintContactJoiner, type TestContactJoiner } from './formation-consent-helper.js';

/**
 * `CadreNode.removeMachine` against one real control database: an owner machine admitted
 * through a multi-use owner-granting invitation, holding a push token and having vouched one
 * device, is removed in one transaction with its dependent kept by re-vouch; and a re-vouch
 * naming a row the machine never vouched is refused before anything is written.
 *
 * The node's own identity key is the founding owner (`makeOwnOwner`'s shape), because the
 * owner-gated calls sign with the key behind the node's peer id. The other machines are bare
 * keypairs: their rows are written as the production writers would write them (the
 * redemption through `redeemCadreInvite`; the push token and the vouched row through the
 * schema's own insert rules), with no second node started.
 */
describe('CadreNode.removeMachine', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let owner: KeyPair;

  const signOwner = (message: Uint8Array): string => signAs(owner, message);
  /** A bare machine as the signer the helpers take: its base64url seed and public key. */
  const asSigner = (device: TestContactJoiner): KeyPair => ({ privateKey: device.privateKey, publicKey: device.peerKey });

  beforeAll(async () => {
    const identity = await generateKeyPair('Ed25519');
    const pair = ed25519KeyPairFromLibp2p(identity);
    owner = { privateKey: pair.privateKeyB64, publicKey: pair.publicKeyB64 };
    node = new CadreNode({
      controlNetwork: { partyId: 'remove-machine-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
      profile: 'transaction',
      privateKey: identity,
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

  function rawRow(sql: string, key: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get(sql, [key]);
  }

  it('removes an owner machine completely in one transaction, keeping the device it vouched by re-vouching it', async () => {
    const invite = await issueOwnerInvitation(3);
    const machine = await mintContactJoiner();
    const admitted = await redeem(invite, machine);
    expect(admitted.alreadyMember).toBe(false);
    // The redemption's membership notification ran the anchor sync: the issuer is anchored, so
    // the machine's key is derived from the row the node itself wrote.
    expect(node.getTrustedOwnerStore()!.sources().get(machine.peerKey)).toBe('chain');
    await seatDeviceToken(machine);
    const dependent = await mintContactJoiner();
    const dependentPublishedAt = Date.now() - 1_000;
    const dependentStamp = await vouchDevice(asSigner(machine), dependent, dependentPublishedAt);
    expect((await node.listAuthorizedMembers()).map((row) => row.peerId).sort()).toEqual([dependent.partyId, machine.partyId].sort());

    const plan = await node.planMachineRemoval(machine.partyId);
    expect(plan.refusal).toBeNull();
    expect(plan.machine).toMatchObject({ peerId: machine.partyId, publicKey: machine.peerKey, isSelf: false, isOwner: true, isMember: true, trusted: true, vouchedBy: owner.publicKey });
    expect(plan.removesOwnerKey).toBe(true);
    expect(plan.dependents).toEqual({ owners: [], peers: [dependent.partyId] });
    expect(plan.invitations).toEqual([invite.publicKey]);
    expect(plan.ownDependency).toBe(false);

    const result = await node.removeMachine(machine.partyId, { revouch: { peers: [dependent.partyId] } });
    expect(result).toEqual({
      removedPeer: true,
      removedOwnerKey: true,
      removedDeviceToken: true,
      withdrawnInvitations: [invite.publicKey],
      revouched: { owners: [], peers: [dependent.partyId] },
    });

    // Every row of the machine is gone and its stamp retired; the invitation's row stays, withdrawn.
    expect(await rawRow('select PeerId from CadreControl.CadrePeer where PeerId = ?', machine.partyId)).toBeUndefined();
    expect(await rawRow('select Key from CadreControl.OwnerKey where Key = ?', machine.peerKey)).toBeUndefined();
    expect(await rawRow('select PeerId from CadreControl.DeviceToken where PeerId = ?', machine.partyId)).toBeUndefined();
    const tombstones = await db.queryRevocations();
    expect(tombstones.filter((row) => row.rowKey === machine.partyId).map((row) => row.tableName).sort()).toEqual(['CadrePeer', 'DeviceToken']);
    expect(tombstones.filter((row) => row.rowKey === machine.peerKey).map((row) => row.tableName)).toEqual(['OwnerKey']);
    expect(tombstones.filter((row) => row.rowKey === invite.publicKey).map((row) => row.tableName)).toEqual(['CadreInvite']);
    expect(tombstones.every((row) => row.signerKey === owner.publicKey)).toBe(true);
    expect((await node.listCadreInvitations()).find((status) => status.invite.key === invite.publicKey)).toMatchObject({ withdrawn: true, live: false, usesRecorded: 1 });
    // The machine cannot come back through the invitation it redeemed, seats left or not.
    await expectConstraintFailure(redeem(invite, machine), 'Authorized');

    // The dependent stands on the remover's signature, with its own stamp and freshness untouched.
    expect((await node.listAuthorizedMembers()).map((row) => row.peerId)).toEqual([dependent.partyId]);
    const kept = (await db.queryCadrePeers()).find((row) => row.peerId === dependent.partyId);
    expect(kept).toMatchObject({ vouchOwner: owner.publicKey, vouchUsage: null, stampId: dependentStamp, updatedAt: dependentPublishedAt });
    expect((await node.listMachines()).map((entry) => entry.peerId)).not.toContain(machine.partyId);
  }, 60_000);

  it('refuses a re-vouch naming a row the machine did not vouch, before any write', async () => {
    const other = freshKeyPair();
    expect(await node.addOwner(other.publicKey)).toBe(true);
    const otherPeerId = peerIdFromEd25519PublicKeyB64(other.publicKey)!;
    const bystander = await mintContactJoiner();
    const bystanderStamp = await vouchDevice(owner, bystander, Date.now());
    expect((await node.listMachines()).find((entry) => entry.peerId === otherPeerId)).toMatchObject({ isOwner: true, isMember: false, trusted: false, vouchedBy: owner.publicKey });

    await expect(node.removeMachine(otherPeerId, { revouch: { peers: [bystander.partyId] } }))
      .rejects.toThrow(/re-vouch names rows the removed machine did not vouch/);

    expect((await db.getOwnerKeys()).has(other.publicKey)).toBe(true);
    expect(await db.queryCadrePeerStampId(bystander.partyId)).toBe(bystanderStamp);
    expect((await db.queryRevocations()).some((row) => row.rowKey === other.publicKey)).toBe(false);
  }, 60_000);
});
