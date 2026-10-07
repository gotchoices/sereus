import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import debug from 'debug';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import {
  buildAuthorizationMessage,
  cadreInviteAddMessage,
  cadreInviteConsentMessage,
  cadreInviteRedeemMessage,
  generateStampId,
  CadreInviteIssuerUnknownError,
  InvitationExhaustedError,
} from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { canonicalDatetime } from '../src/canonical-datetime.js';
import {
  cadreInviteAddDigest,
  cadreInviteConsentDigest,
  cadreInviteRedeemDigest,
  verifyInvitationAdmission,
} from '../src/peer-authorization.js';
import type { CadreInviteRow, CadreInviteUsageRow, CadrePeerVoucherFields } from '../src/types.js';
import {
  expectConstraintFailure,
  freshKeyPair,
  freshStamp,
  revocationMessage,
  signAs,
  signB64,
} from './control-constraint-helpers.js';
import type { KeyPair } from './control-constraint-helpers.js';
import { mintContactJoiner } from './formation-consent-helper.js';
import type { TestContactJoiner } from './formation-consent-helper.js';

/**
 * The cadre invitation tables (`CadreInvite`, `CadreInviteUsage`) and the consent branches
 * they authorize on `CadrePeer` and `OwnerKey`, driven through `ControlDatabase` against a
 * real control database — so every constraint name below is the engine's own.
 *
 * An invitation is an ed25519 keypair whose public half is the row key: the holder redeems
 * by signing with the private half, the admitted device signs its consent with its own key,
 * and a member machine writes both into a usage row that then seats the device's `CadrePeer`
 * row (and `OwnerKey` row, when granted) with NO owner signature. Withdrawal is a tombstone
 * over a row that stays, because the admitted rows prove their membership through it.
 *
 * `expectConstraintFailure` names exactly one constraint per case; where two constraints
 * refuse at once they carry the same name (`Authorized`), which the case says.
 */

const log = debug('sereus:cadre:test:cadre-invite');

/** The redeeming device as a signer: its base64url seed and public key, in the helpers' shape. */
const asSigner = (device: TestContactJoiner): KeyPair => ({ privateKey: device.privateKey, publicKey: device.peerKey });

/** The two signatures a redemption carries, over the exact fields the usage row will store. */
function redemptionSignatures(invite: KeyPair, device: TestContactJoiner, usageStampId: string): { inviteSig: string; peerSig: string } {
  const fields = { inviteKey: invite.publicKey, usageStampId, peerKey: device.peerKey };
  return {
    inviteSig: signAs(invite, cadreInviteRedeemMessage(fields)),
    peerSig: signAs(asSigner(device), cadreInviteConsentMessage(fields)),
  };
}

/**
 * An owner-signed `CadreInvite` row built by hand, as `insertCadreInvite` would store it, so a
 * case can present the holder's signed copy to a node that never seated it.
 */
function mintInviteRow(issuer: KeyPair, invite: KeyPair, overrides: Partial<CadreInviteRow> = {}): CadreInviteRow {
  const signed = {
    key: invite.publicKey,
    peerId: null,
    grantsOwner: false,
    expiresAt: null,
    totalUses: null,
    stampId: freshStamp(),
    ...overrides,
  };
  return { ...signed, issuerKey: issuer.publicKey, issuerSig: signAs(issuer, cadreInviteAddMessage(signed)) };
}

describe('cadre invitations: schema and ControlDatabase', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  const signFounder = (message: Uint8Array): string => signAs(founder, message);

  beforeAll(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'cadre-invite-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
      // The reader judges an invitation-admitted row against THIS anchor, never the OwnerKey table.
      trustedOwners: { pinnedKeys: [founder.publicKey] },
    });
    await node.start();
    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  /** Issue an invitation the production way: a fresh keypair, the founder signing the row. */
  async function issue(opts: { peerId?: string | null; grantsOwner?: boolean; expiresAtMs?: number; totalUses?: number } = {}): Promise<{ invite: KeyPair; row: CadreInviteRow }> {
    const invite = freshKeyPair();
    const row = await db.insertCadreInvite({
      key: invite.publicKey,
      peerId: opts.peerId ?? null,
      grantsOwner: opts.grantsOwner ?? false,
      expiresAtMs: opts.expiresAtMs,
      totalUses: opts.totalUses,
    }, founder.publicKey, signFounder);
    return { invite, row };
  }

  /** Redeem `invite` for `device` through the production writer, with a fresh nonce unless given. */
  function redeem(invite: KeyPair, device: TestContactJoiner, opts: { nowMs?: number; usageStampId?: string; inviteSig?: string; peerSig?: string } = {}) {
    const usageStampId = opts.usageStampId ?? generateStampId(device.partyId);
    const signatures = redemptionSignatures(invite, device, usageStampId);
    return db.redeemCadreInvite({
      inviteKey: invite.publicKey,
      peerId: device.partyId,
      peerKey: device.peerKey,
      multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
      usageStampId,
      inviteSig: opts.inviteSig ?? signatures.inviteSig,
      peerSig: opts.peerSig ?? signatures.peerSig,
      nowMs: opts.nowMs,
    });
  }

  function peerRow(peerId: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select PublicKey, StampId, VouchOwner, VouchSig, VouchUsage from CadreControl.CadrePeer where PeerId = ?', [peerId]);
  }

  function ownerRow(key: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select StampId, VouchOwner, VouchSig, VouchUsage from CadreControl.OwnerKey where Key = ?', [key]);
  }

  /**
   * The bare `CadreInviteUsage` insert `redeemCadreInvite` issues, with every writer-derived
   * field under the case's control, and valid signatures over whatever it carries.
   */
  async function rawInsertUsage(invite: KeyPair, device: TestContactJoiner, fields: { peerStampId: string; ownerStampId?: string | null; usageStampId?: string }): Promise<string> {
    const usageStampId = fields.usageStampId ?? generateStampId(device.partyId);
    const { inviteSig, peerSig } = redemptionSignatures(invite, device, usageStampId);
    await rawDb.exec(
      `insert into CadreControl.CadreInviteUsage (UsageStampId, InviteKey, PeerId, PeerKey, PeerStampId, OwnerStampId, InviteSig, PeerSig)
         with context Now = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [await canonicalDatetime(rawDb, Date.now()), usageStampId, invite.publicKey, device.partyId, device.peerKey, fields.peerStampId, fields.ownerStampId ?? null, inviteSig, peerSig],
    );
    return usageStampId;
  }

  /** The bare consent-branch `OwnerKey` insert `redeemCadreInvite` issues for an owner-granting invitation. */
  function rawInsertOwnerByConsent(device: TestContactJoiner, ownerStampId: string, usageStampId: string, issuerKey: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.OwnerKey (Key, StampId, VouchOwner, VouchSig, VouchUsage)
         with context OwnerKey = null, Signature = null
         values (?, ?, ?, null, ?)`,
      [device.peerKey, ownerStampId, issuerKey, usageStampId],
    );
  }

  /** The bare `CadreInvite` insert, so a case can seat a row inside a larger transaction. */
  function rawInsertInvite(row: CadreInviteRow): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.CadreInvite (Key, PeerId, GrantsOwner, ExpiresAt, TotalUses, IssuerKey, IssuerSig, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.issuerKey, row.issuerSig, row.key, row.peerId, row.grantsOwner ? 1 : 0, row.expiresAt, row.totalUses, row.issuerKey, row.issuerSig, row.stampId],
    );
  }

  /** A founder-signed `'CadreInvite'` tombstone filed directly, as a node that never held the row would receive it. */
  function tombstoneInvite(key: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, RowKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values ('CadreInvite', ?, ?)`,
      [founder.publicKey, signFounder(revocationMessage('CadreInvite', key, stampId)), key, stampId],
    );
  }

  /** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
  async function inTransaction(statements: () => Promise<void>): Promise<void> {
    await rawDb.beginTransaction();
    try {
      await statements();
      await rawDb.commit();
    } catch (error) {
      try {
        await rawDb.rollback();
      } catch (rollbackError) {
        log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
      }
      throw error;
    }
  }

  /** Admit `device` through a fresh untargeted, non-owner invitation; returns its live stamp. */
  async function admit(device: TestContactJoiner): Promise<string> {
    const { invite } = await issue();
    const result = await redeem(invite, device);
    expect(result.alreadyMember).toBe(false);
    return result.peerStampId;
  }

  // ── Redemption ────────────────────────────────────────────────────────────

  it('redeems: seats the CadrePeer row by consent with no owner context; a retry is alreadyMember and writes nothing', async () => {
    const { invite, row } = await issue();
    expect(row.issuerKey).toBe(founder.publicKey);
    expect(await db.queryCadreInvite(invite.publicKey)).toEqual(row);
    const device = await mintContactJoiner();

    const first = await redeem(invite, device);
    expect(first.alreadyMember).toBe(false);
    expect(first.ownerStampId).toBeNull();

    const peer = await peerRow(device.partyId);
    expect(peer?.PublicKey).toBe(device.peerKey);
    expect(peer?.StampId).toBe(first.peerStampId);
    expect(peer?.VouchOwner).toBe(founder.publicKey);
    expect(peer?.VouchSig).toBeNull();
    expect(typeof peer?.VouchUsage).toBe('string');
    const usages = (await db.queryCadreInviteUsages()).filter(usage => usage.inviteKey === invite.publicKey);
    expect(usages).toHaveLength(1);
    expect(usages[0].usageStampId).toBe(peer?.VouchUsage);
    expect(usages[0].peerStampId).toBe(first.peerStampId);
    expect(usages[0].ownerStampId).toBeNull();
    expect((await db.queryCadrePeers()).find(member => member.peerId === device.partyId)?.vouchUsage).toBe(peer?.VouchUsage);

    // The reader walks the chain row -> usage -> invitation -> anchored issuer.
    expect((await node.listAuthorizedMembers()).map(member => member.peerId)).toContain(device.partyId);

    const retry = await redeem(invite, device);
    expect(retry).toEqual({ alreadyMember: true, peerStampId: first.peerStampId, ownerStampId: null });
    expect(await db.countCadreInviteUsage(invite.publicKey)).toBe(1);
  });

  it('redeems: an owner-granting invitation also seats the OwnerKey row by consent', async () => {
    const { invite } = await issue({ grantsOwner: true });
    const device = await mintContactJoiner();

    const result = await redeem(invite, device);
    expect(result.alreadyMember).toBe(false);
    const owner = await ownerRow(device.peerKey);
    expect(owner?.StampId).toBe(result.ownerStampId);
    expect(owner?.VouchOwner).toBe(founder.publicKey);
    expect(owner?.VouchSig).toBeNull();
    expect(owner?.VouchUsage).toBe((await peerRow(device.partyId))?.VouchUsage);
    expect(await db.getOwnerKeys()).toContain(device.peerKey);

    const retry = await redeem(invite, device);
    expect(retry).toEqual({ alreadyMember: true, peerStampId: result.peerStampId, ownerStampId: result.ownerStampId });
  });

  it('redeems: an owner-granting invitation completes an already-admitted device with its OwnerKey row only', async () => {
    const device = await mintContactJoiner();
    const peerStampId = await admit(device);
    const { invite } = await issue({ grantsOwner: true });

    const result = await redeem(invite, device);
    expect(result.alreadyMember).toBe(false);
    expect(result.peerStampId).toBe(peerStampId);
    expect((await ownerRow(device.peerKey))?.StampId).toBe(result.ownerStampId);
    // The usage names the EXISTING peer incarnation; the peer row itself was not rewritten.
    expect((await peerRow(device.partyId))?.StampId).toBe(peerStampId);
    const usage = (await db.queryCadreInviteUsages()).find(row => row.inviteKey === invite.publicKey);
    expect(usage?.peerStampId).toBe(peerStampId);
    expect(usage?.ownerStampId).toBe(result.ownerStampId);
  });

  it('re-vouch: an owner re-touching an invitation-admitted row moves it onto the signature and clears VouchUsage', async () => {
    const device = await mintContactJoiner();
    await admit(device);

    expect(await db.reauthorizeCadrePeer(device.partyId, Date.now(), founder.publicKey, signFounder)).toBe(true);
    const peer = await peerRow(device.partyId);
    expect(peer?.VouchOwner).toBe(founder.publicKey);
    expect(typeof peer?.VouchSig).toBe('string');
    expect(peer?.VouchUsage).toBeNull();
    // Still a member, now judged by the voucher: the invitation is no longer consulted for it.
    expect((await node.listAuthorizedMembers()).map(member => member.peerId)).toContain(device.partyId);
  });

  // ── Liveness conditions at redemption (CadreInviteUsage.Authorized) ───────

  it('refuses: a targeted invitation redeemed by another device (Authorized)', async () => {
    const intended = await mintContactJoiner();
    const other = await mintContactJoiner();
    const { invite } = await issue({ peerId: intended.partyId });

    await expectConstraintFailure(redeem(invite, other), 'Authorized');
    expect(await peerRow(other.partyId)).toBeUndefined();
    expect((await redeem(invite, intended)).alreadyMember).toBe(false);
  });

  it('refuses: an expired invitation (Authorized)', async () => {
    const now = Date.now();
    const { invite } = await issue({ expiresAtMs: now - 60_000 });
    const device = await mintContactJoiner();

    await expectConstraintFailure(redeem(invite, device, { nowMs: now }), 'Authorized');
    expect(await peerRow(device.partyId)).toBeUndefined();
  });

  it('refuses: a withdrawn invitation (Authorized); the tombstone is accepted with the row present and the row stays', async () => {
    const { invite, row } = await issue();
    expect(await db.withdrawCadreInvite(invite.publicKey, founder.publicKey, signFounder)).toBe(true);
    expect(await db.queryCadreInvite(invite.publicKey)).toEqual(row);
    expect(await db.queryRevokedStamps('CadreInvite')).toContain(row.stampId);
    // Withdrawing twice is a no-op, not a primary-key collision.
    expect(await db.withdrawCadreInvite(invite.publicKey, founder.publicKey, signFounder)).toBe(false);

    const device = await mintContactJoiner();
    await expectConstraintFailure(redeem(invite, device), 'Authorized');
    expect(await peerRow(device.partyId)).toBeUndefined();
  });

  it('refuses: an exhausted invitation by name, before any write (InvitationExhaustedError)', async () => {
    const { invite } = await issue({ totalUses: 1 });
    const first = await mintContactJoiner();
    const second = await mintContactJoiner();
    expect((await redeem(invite, first)).alreadyMember).toBe(false);

    await expect(redeem(invite, second)).rejects.toThrow(InvitationExhaustedError);
    expect(await peerRow(second.partyId)).toBeUndefined();
    // The seat budget never refuses a device that is already in: the retry stays idempotent.
    expect((await redeem(invite, first)).alreadyMember).toBe(true);
  });

  // ── Possession and consent ────────────────────────────────────────────────

  it('refuses: an InviteSig by a key other than the invitation key (InvitePossessed)', async () => {
    const { invite } = await issue();
    const device = await mintContactJoiner();
    const usageStampId = generateStampId(device.partyId);
    const forged = redemptionSignatures(freshKeyPair(), device, usageStampId).inviteSig;

    await expectConstraintFailure(redeem(invite, device, { usageStampId, inviteSig: forged }), 'InvitePossessed');
    expect(await peerRow(device.partyId)).toBeUndefined();
  });

  it('refuses: a PeerSig by a key other than the device key (PeerConsented)', async () => {
    const { invite } = await issue();
    const device = await mintContactJoiner();
    const impostor = await mintContactJoiner();
    const usageStampId = generateStampId(device.partyId);
    const fields = { inviteKey: invite.publicKey, usageStampId, peerKey: device.peerKey };
    const forged = signAs(asSigner(impostor), cadreInviteConsentMessage(fields));

    await expectConstraintFailure(redeem(invite, device, { usageStampId, peerSig: forged }), 'PeerConsented');
    expect(await peerRow(device.partyId)).toBeUndefined();
  });

  // ── The rows a usage seats ────────────────────────────────────────────────

  it('refuses: a usage row with no peer row in its transaction (PeerExists)', async () => {
    const { invite } = await issue();
    const device = await mintContactJoiner();

    await expectConstraintFailure(rawInsertUsage(invite, device, { peerStampId: freshStamp() }), 'PeerExists');
    expect(await db.countCadreInviteUsage(invite.publicKey)).toBe(0);
  });

  it('refuses: an OwnerKey row seated under an invitation that does not grant ownership (OwnerKey.Authorized)', async () => {
    const device = await mintContactJoiner();
    const peerStampId = await admit(device);
    const { invite, row } = await issue({ grantsOwner: false });
    const ownerStampId = freshStamp();

    // The usage row itself is valid (its invitation is live and OwnerExists sees the owner
    // row in the transaction); only the OwnerKey consent branch refuses, on GrantsOwner.
    await expectConstraintFailure(
      inTransaction(async () => {
        const usageStampId = await rawInsertUsage(invite, device, { peerStampId, ownerStampId });
        await rawInsertOwnerByConsent(device, ownerStampId, usageStampId, row.issuerKey);
      }),
      'Authorized',
    );
    expect(await ownerRow(device.peerKey)).toBeUndefined();
    expect(await db.countCadreInviteUsage(invite.publicKey)).toBe(0);
  });

  it('refuses: an invitation seated and redeemed in one transaction (Authorized, from the committed reads)', async () => {
    const device = await mintContactJoiner();
    const peerStampId = await admit(device);
    const holder = freshKeyPair();
    const signedRow = mintInviteRow(founder, holder, { grantsOwner: true });
    const ownerStampId = freshStamp();

    // Both the usage row and the owner row read committed.CadreInvite, and both refusals carry
    // the name Authorized; the engine reports one of them.
    await expectConstraintFailure(
      inTransaction(async () => {
        await rawInsertInvite(signedRow);
        const usageStampId = await rawInsertUsage(holder, device, { peerStampId, ownerStampId });
        await rawInsertOwnerByConsent(device, ownerStampId, usageStampId, signedRow.issuerKey);
      }),
      'Authorized',
    );
    expect(await db.queryCadreInvite(holder.publicKey)).toBeNull();
    expect(await ownerRow(device.peerKey)).toBeUndefined();
  });

  // ── Seating a row from its bundle ─────────────────────────────────────────

  it('seatCadreInvite: refuses a row whose issuer is not an owner here by name; seating twice is a no-op', async () => {
    const stranger = freshKeyPair();
    const foreign = mintInviteRow(stranger, freshKeyPair());
    await expect(db.seatCadreInvite(foreign)).rejects.toThrow(CadreInviteIssuerUnknownError);
    expect(await db.queryCadreInvite(foreign.key)).toBeNull();

    const carried = mintInviteRow(founder, freshKeyPair(), { totalUses: 2 });
    expect(await db.seatCadreInvite(carried)).toBe(true);
    expect(await db.seatCadreInvite(carried)).toBe(false);
    expect(await db.queryCadreInvite(carried.key)).toEqual(carried);
  });

  it('seatCadreInvite: refuses the holder\'s signed copy of a withdrawn invitation (NotRevoked)', async () => {
    // A node that received the withdrawal but never the row: the tombstone names the stamp
    // the holder's copy carries, so the copy cannot be seated here.
    const withdrawn = mintInviteRow(founder, freshKeyPair());
    await tombstoneInvite(withdrawn.key, withdrawn.stampId);

    await expectConstraintFailure(db.seatCadreInvite(withdrawn), 'NotRevoked');
    expect(await db.queryCadreInvite(withdrawn.key)).toBeNull();
  });
});

describe('cadre invitations: liveness (hasLiveCadreInvite)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  const signFounder = (message: Uint8Array): string => signAs(founder, message);

  beforeAll(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'cadre-invite-live-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();
    db = node.getControlDatabase()!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  async function issueBy(issuer: KeyPair, opts: { expiresAtMs?: number; totalUses?: number } = {}): Promise<KeyPair> {
    const invite = freshKeyPair();
    await db.insertCadreInvite({ key: invite.publicKey, grantsOwner: false, ...opts }, issuer.publicKey, message => signAs(issuer, message));
    return invite;
  }

  async function redeemBy(invite: KeyPair, device: TestContactJoiner, nowMs: number) {
    const usageStampId = generateStampId(device.partyId);
    return db.redeemCadreInvite({
      inviteKey: invite.publicKey, peerId: device.partyId, peerKey: device.peerKey, usageStampId, nowMs,
      ...redemptionSignatures(invite, device, usageStampId),
    });
  }

  it('is false with none, true for a metered unexpired one, and false again once exhausted, withdrawn or expired', async () => {
    const now = Date.now();
    expect(await db.hasLiveCadreInvite(now)).toBe(false);

    const single = await issueBy(founder, { totalUses: 1, expiresAtMs: now + 60 * 60_000 });
    expect(await db.hasLiveCadreInvite(now)).toBe(true);
    expect((await redeemBy(single, await mintContactJoiner(), now)).alreadyMember).toBe(false);
    expect(await db.hasLiveCadreInvite(now)).toBe(false);

    const withdrawn = await issueBy(founder, { totalUses: 1 });
    expect(await db.hasLiveCadreInvite(now)).toBe(true);
    expect(await db.withdrawCadreInvite(withdrawn.publicKey, founder.publicKey, signFounder)).toBe(true);
    expect(await db.hasLiveCadreInvite(now)).toBe(false);

    await issueBy(founder, { expiresAtMs: now - 1 });
    expect(await db.hasLiveCadreInvite(now)).toBe(false);
  });

  it('an issuer removed since issuing takes its outstanding invitations with it', async () => {
    const second = freshKeyPair();
    const enrollStamp = freshStamp();
    await rawDb.exec(
      `insert into CadreControl.OwnerKey (Key, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?)`,
      [founder.publicKey, signFounder(buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [second.publicKey, enrollStamp])), second.publicKey, enrollStamp, founder.publicKey, signFounder(buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [second.publicKey, enrollStamp]))],
    );
    const now = Date.now();
    const bySecond = await issueBy(second);
    expect(await db.hasLiveCadreInvite(now)).toBe(true);

    // The founder removes the second owner: the delete and its tombstone in one transaction.
    await rawDb.beginTransaction();
    try {
      await rawDb.exec(
        `delete from CadreControl.OwnerKey with context OwnerKey = ?, Signature = ? where Key = ?`,
        [founder.publicKey, signFounder(buildAuthorizationMessage('CadreControl.OwnerKey', 'remove', [second.publicKey, enrollStamp])), second.publicKey],
      );
      await rawDb.exec(
        `insert into CadreControl.Revocation (TableName, RowKey, StampId) with context OwnerKey = ?, Signature = ? values ('OwnerKey', ?, ?)`,
        [founder.publicKey, signFounder(revocationMessage('OwnerKey', second.publicKey, enrollStamp)), second.publicKey, enrollStamp],
      );
      await rawDb.commit();
    } catch (error) {
      await rawDb.rollback();
      throw error;
    }

    expect(await db.hasLiveCadreInvite(now)).toBe(false);
    await expectConstraintFailure(redeemBy(bySecond, await mintContactJoiner(), now), 'Authorized');
  });
});

describe('verifyInvitationAdmission (no database)', () => {
  interface Chain {
    row: CadrePeerVoucherFields;
    usage: CadreInviteUsageRow;
    invite: CadreInviteRow;
    issuer: KeyPair;
    inviteKeys: KeyPair;
  }

  /** A fully consistent chain for one device, every signature valid, in the base64url digest forms the verifier uses. */
  async function chainFor(device: TestContactJoiner, inviteOverrides: Partial<CadreInviteRow> = {}): Promise<Chain> {
    const issuer = freshKeyPair();
    const inviteKeys = freshKeyPair();
    const signed = { key: inviteKeys.publicKey, peerId: null, grantsOwner: false, expiresAt: null, totalUses: null, stampId: freshStamp(), ...inviteOverrides };
    const invite: CadreInviteRow = { ...signed, issuerKey: issuer.publicKey, issuerSig: signB64(issuer, cadreInviteAddDigest(signed)) };
    const usageStampId = freshStamp();
    const peerStampId = freshStamp();
    const usage: CadreInviteUsageRow = {
      usageStampId,
      inviteKey: invite.key,
      peerId: device.partyId,
      peerKey: device.peerKey,
      peerStampId,
      ownerStampId: null,
      inviteSig: signB64(inviteKeys, cadreInviteRedeemDigest(invite.key, usageStampId, device.peerKey)),
      peerSig: signB64(asSigner(device), cadreInviteConsentDigest(invite.key, usageStampId, device.peerKey)),
    };
    const row: CadrePeerVoucherFields = { peerId: device.partyId, stampId: peerStampId, vouchOwner: issuer.publicKey, vouchSig: null, vouchUsage: usageStampId };
    return { row, usage, invite, issuer, inviteKeys };
  }

  it('passes when the issuer is anchored and every link verifies', async () => {
    const chain = await chainFor(await mintContactJoiner());
    expect(verifyInvitationAdmission(chain.row, chain.usage, chain.invite, key => key === chain.issuer.publicKey)).toBe(true);
  });

  it('fails when the issuer is not anchored, whatever the replicated OwnerKey table says', async () => {
    const chain = await chainFor(await mintContactJoiner());
    expect(verifyInvitationAdmission(chain.row, chain.usage, chain.invite, () => false)).toBe(false);
  });

  it('fails when the stored PeerKey does not derive to the row\'s PeerId, with every signature valid over it', async () => {
    const device = await mintContactJoiner();
    const other = await mintContactJoiner();
    const chain = await chainFor(device);
    // The writer asserted the (PeerId, PeerKey) pair and the schema cannot check it. Keep the
    // row's and the usage's PeerId, swap in the other device's key, and re-sign both
    // redemption signatures over it, so the derivation check is the only link that can refuse.
    const { usageStampId } = chain.usage;
    const swapped: CadreInviteUsageRow = {
      ...chain.usage,
      peerKey: other.peerKey,
      inviteSig: signB64(chain.inviteKeys, cadreInviteRedeemDigest(chain.invite.key, usageStampId, other.peerKey)),
      peerSig: signB64(asSigner(other), cadreInviteConsentDigest(chain.invite.key, usageStampId, other.peerKey)),
    };
    expect(verifyInvitationAdmission(chain.row, swapped, chain.invite, () => true)).toBe(false);
  });

  it('fails when the invitation names another device', async () => {
    const device = await mintContactJoiner();
    const other = await mintContactJoiner();
    const chain = await chainFor(device, { peerId: other.partyId });
    expect(verifyInvitationAdmission(chain.row, chain.usage, chain.invite, () => true)).toBe(false);
  });
});
