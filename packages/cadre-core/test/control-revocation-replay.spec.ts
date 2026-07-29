import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import debug from 'debug';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
  randomBytes,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { cadrePeerVoucherDigest, cadrePeerRemoveDigest } from '../src/peer-authorization.js';
import { expectConstraintFailure } from './control-constraint-helpers.js';

/**
 * Remove-then-replay resurrection coverage for `CadreControl.Revocation`, plus the
 * authorization of `ValidationKey` / `Strand` deletes.
 *
 * Before this suite's fix, deleting an `OwnerKey` or `CadrePeer` row freed its one-off
 * `StampId` nonce: `unique` only holds over LIVE rows. The original add-approval signature
 * never expires — and for `CadrePeer` it is even STORED on the replicated row as `VouchSig`
 * — so anyone who kept a copy could re-seat a removed owner or peer verbatim, making every
 * removal undoable.
 *
 * `ValidationKey` and `Strand` joined the guarded set later. Their authorization was a bare
 * `constraint Authorized check (...)`, which in Quereus covers insert and update only — so
 * DELETE on either table was gated by nothing at all and any writer could drop a strand row
 * (destroying the party's `MemberPrivateKey` for that network) or a validation key. They now
 * carry the same `AuthorizedDelete` + `RevocationRecorded` + `NotRevoked` triple as the
 * tables above, and the `Revocation.RowIsGone` branch list was extended to match.
 *
 * The fix is an append-only `CadreControl.Revocation` table that retires
 * `(TableName, StampId)` on removal. Three constraints carry it, each pinned here BY NAME:
 *   - `NotRevoked` (on the guarded tables) refuses an insert naming a retired stamp — the
 *     replay itself;
 *   - `RevocationRecorded` (on the guarded tables) refuses a delete that does not carry
 *     the matching tombstone in the same transaction — a bare delete would free the stamp;
 *   - `RowIsGone` / `Immutable` (on Revocation) keep the tombstone honest: a stamp may
 *     only be retired once its row is gone, and never un-retired.
 *
 * Legitimate re-adds mint a FRESH stamp per insert, so removal is stamp-retirement, not an
 * identity ban — the accept-side tests pin that too.
 *
 * Every test boots its OWN `CadreNode` (empty bootstrap, transaction profile) seeded with
 * one founding owner: these probes mutate the owner set and peer table, so a shared
 * database would leak state between them.
 */

const log = debug('sereus:cadre:test:revocation-replay');

interface KeyPair {
  privateKey: string;
  publicKey: string;
}

function freshKeyPair(): KeyPair {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  return {
    privateKey,
    publicKey: getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string,
  };
}

const freshStamp = (): string => randomBytes(256, 'base64url') as string;

/** ed25519-sign the raw canonical message bytes (no pre-hash), as the schema's verify expects. */
function signAs(kp: KeyPair, message: Uint8Array): string {
  return cryptoSign(message, kp.privateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/** ed25519-sign a base64url digest STRING (the peer-authorization helper encoding). */
function signB64(kp: KeyPair, digestB64url: string): string {
  return cryptoSign(digestB64url, kp.privateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
}

/** The enrollment message the insert branch binds: digest('CadreControl.OwnerKey', 'add', new.Key, new.StampId). */
const enrollMessage = (key: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [key, stampId]);

/** The removal message the delete branch binds: digest('CadreControl.OwnerKey', 'remove', old.Key, old.StampId). */
const removeMessage = (key: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage('CadreControl.OwnerKey', 'remove', [key, stampId]);

/** `ValidationKey` binds (Key, StampId) under both action tags. */
const validationKeyMessage = (action: 'add' | 'remove', key: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage('CadreControl.ValidationKey', action, [key, stampId]);

/** `Strand`'s add branch binds the whole row; MemberPrivateKey signs as '' when null. */
const strandAddMessage = (
  id: string,
  type: string,
  memberPrivateKey: string | null,
  stampId: string,
): Uint8Array =>
  buildAuthorizationMessage('CadreControl.Strand', 'add', [id, type, memberPrivateKey ?? '', stampId]);

/** `Strand`'s delete branch binds only the stored (Id, StampId) — a distinct, narrower digest. */
const strandRemoveMessage = (id: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage('CadreControl.Strand', 'remove', [id, stampId]);

describe('Revocation: remove-then-replay resurrection is closed', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  async function ownerKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const row of rawDb.eval('select Key from CadreControl.OwnerKey')) {
      keys.push(String(row.Key));
    }
    return keys.sort();
  }

  async function stampIdOf(key: string): Promise<string> {
    const row = await rawDb.get('select StampId from CadreControl.OwnerKey where Key = ?', [key]);
    return String(row?.StampId);
  }

  function cadrePeerRow(peerId: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select PeerId from CadreControl.CadrePeer where PeerId = ?', [peerId]);
  }

  function validationKeyRow(key: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select Key from CadreControl.ValidationKey where Key = ?', [key]);
  }

  function strandRow(id: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select Id, StampId from CadreControl.Strand where Id = ?', [id]);
  }

  function rawInsertOwnerKey(
    contextOwner: string | null,
    signature: string | null,
    key: string,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.OwnerKey (Key, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?)`,
      [contextOwner, signature, key, stampId],
    );
  }

  function rawDeleteOwnerKey(
    contextOwner: string | null,
    signature: string | null,
    key: string,
  ): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.OwnerKey
         with context OwnerKey = ?, Signature = ?
         where Key = ?`,
      [contextOwner, signature, key],
    );
  }

  /** The full 8-column insert `AuthorizedInsert` demands: `VouchOwner`/`VouchSig` MUST equal the context pair. */
  function rawInsertCadrePeer(
    contextOwner: string,
    vouchSig: string,
    peerId: string,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [contextOwner, vouchSig, peerId, null, '', null, null, stampId, contextOwner, vouchSig],
    );
  }

  /**
   * The owner re-vouch branch of `AuthorizedUpdate` (the shape
   * `SeedBootstrapService.reauthorizePeer` writes). `newStampId` null keeps the row's
   * stamp — the only shape the branch allows; passing a value exercises the rotation
   * attempt the branch must refuse.
   */
  function rawRevouchCadrePeer(
    contextOwner: string,
    signature: string,
    peerId: string,
    newStampId: string | null,
  ): Promise<void> {
    const stampAssignment = newStampId === null ? '' : 'StampId = ?, ';
    const stampParam = newStampId === null ? [] : [newStampId];
    return rawDb.exec(
      `update CadreControl.CadrePeer
         with context OwnerKey = ?, Signature = ?
         set ${stampAssignment}VouchOwner = ?, VouchSig = ?
         where PeerId = ?`,
      [contextOwner, signature, ...stampParam, contextOwner, signature, peerId],
    );
  }

  function rawDeleteCadrePeer(
    contextOwner: string,
    signature: string,
    peerId: string,
  ): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.CadrePeer
         with context OwnerKey = ?, Signature = ?
         where PeerId = ?`,
      [contextOwner, signature, peerId],
    );
  }

  function rawInsertValidationKey(
    contextOwner: string | null,
    signature: string | null,
    key: string,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.ValidationKey (Key, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?)`,
      [contextOwner, signature, key, stampId],
    );
  }

  function rawDeleteValidationKey(
    contextOwner: string | null,
    signature: string | null,
    key: string,
  ): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.ValidationKey
         with context OwnerKey = ?, Signature = ?
         where Key = ?`,
      [contextOwner, signature, key],
    );
  }

  function rawInsertStrand(
    contextOwner: string | null,
    signature: string | null,
    id: string,
    type: string,
    memberPrivateKey: string | null,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?)`,
      [contextOwner, signature, id, type, memberPrivateKey, stampId],
    );
  }

  function rawDeleteStrand(
    contextOwner: string | null,
    signature: string | null,
    id: string,
  ): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.Strand
         with context OwnerKey = ?, Signature = ?
         where Id = ?`,
      [contextOwner, signature, id],
    );
  }

  /** Retire a stamp into the append-only tombstone table (no context clause — the table declares none). */
  function tombstoneStamp(tableName: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, StampId)
         values (?, ?)`,
      [tableName, stampId],
    );
  }

  /** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
  async function inTransaction(statements: () => Promise<void>): Promise<void> {
    await rawDb.beginTransaction();
    try {
      await statements();
      await rawDb.commit();
    } catch (error) {
      // A failed commit() already tore the transaction down, so rollback() throws
      // "no transaction active" — log it rather than masking the real cause.
      try {
        await rawDb.rollback();
      } catch (rollbackError) {
        log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
      }
      throw error;
    }
  }

  /** Seat a second owner the legitimate way, handing back what a replay attacker captures. */
  async function enrollByFounder(newOwner: KeyPair): Promise<{ stamp: string; enrollSig: string }> {
    const stamp = freshStamp();
    const enrollSig = signAs(founder, enrollMessage(newOwner.publicKey, stamp));
    await rawInsertOwnerKey(founder.publicKey, enrollSig, newOwner.publicKey, stamp);
    return { stamp, enrollSig };
  }

  /** Admit a peer the legitimate way, handing back what a replay attacker captures (VouchSig is even STORED on the row). */
  async function admitPeer(peerId: string): Promise<{ stamp: string; vouchSig: string }> {
    const stamp = freshStamp();
    const vouchSig = signB64(founder, cadrePeerVoucherDigest(peerId, stamp));
    await rawInsertCadrePeer(founder.publicKey, vouchSig, peerId, stamp);
    return { stamp, vouchSig };
  }

  /** The legitimate removal shape: signed delete + tombstone in ONE transaction. */
  async function removeOwnerKey(target: KeyPair, stamp: string): Promise<void> {
    await inTransaction(async () => {
      await rawDeleteOwnerKey(
        founder.publicKey,
        signAs(founder, removeMessage(target.publicKey, stamp)),
        target.publicKey,
      );
      await tombstoneStamp('OwnerKey', stamp);
    });
  }

  async function removeCadrePeer(peerId: string, stamp: string): Promise<void> {
    await inTransaction(async () => {
      await rawDeleteCadrePeer(
        founder.publicKey,
        signB64(founder, cadrePeerRemoveDigest(peerId, stamp)),
        peerId,
      );
      await tombstoneStamp('CadrePeer', stamp);
    });
  }

  /** Enroll a validation key the legitimate way, handing back what a replay attacker captures. */
  async function enrollValidationKey(key: string): Promise<{ stamp: string; addSig: string }> {
    const stamp = freshStamp();
    const addSig = signAs(founder, validationKeyMessage('add', key, stamp));
    await rawInsertValidationKey(founder.publicKey, addSig, key, stamp);
    return { stamp, addSig };
  }

  /** Seat a strand the legitimate (owner-signed) way — the non-consent branch of AuthorizedInsert. */
  async function seatStrand(
    id: string,
    type: 'o' | 'c' = 'c',
    memberPrivateKey: string | null = 'member-key-' + Math.random().toString(36).slice(2),
  ): Promise<{ stamp: string; addSig: string }> {
    const stamp = freshStamp();
    const addSig = signAs(founder, strandAddMessage(id, type, memberPrivateKey, stamp));
    await rawInsertStrand(founder.publicKey, addSig, id, type, memberPrivateKey, stamp);
    return { stamp, addSig };
  }

  /** The legitimate ValidationKey removal shape: signed delete + tombstone in ONE transaction. */
  async function removeValidationKey(key: string, stamp: string): Promise<void> {
    await inTransaction(async () => {
      await rawDeleteValidationKey(
        founder.publicKey,
        signAs(founder, validationKeyMessage('remove', key, stamp)),
        key,
      );
      await tombstoneStamp('ValidationKey', stamp);
    });
  }

  /** The legitimate Strand removal shape: signed delete + tombstone in ONE transaction. */
  async function removeStrand(id: string, stamp: string): Promise<void> {
    await inTransaction(async () => {
      await rawDeleteStrand(
        founder.publicKey,
        signAs(founder, strandRemoveMessage(id, stamp)),
        id,
      );
      await tombstoneStamp('Strand', stamp);
    });
  }

  beforeEach(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'revocation-replay-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }, 60_000);

  afterEach(async () => {
    await node?.stop();
  });

  // ── The replay itself: a captured add approval is dead after removal ───────

  it('OwnerKey: a captured enrollment approval cannot re-seat a removed owner', async () => {
    const removed = freshKeyPair();
    const { stamp, enrollSig } = await enrollByFounder(removed);

    await removeOwnerKey(removed, stamp);
    expect(await ownerKeys()).toEqual([founder.publicKey]);

    // Replay the captured enrollment VERBATIM. The signature still verifies and the
    // founder is still an owner, so `Authorized` passes — ONLY `NotRevoked` stands
    // between the party and the resurrection, making the constraint name unambiguous.
    await expectConstraintFailure(
      rawInsertOwnerKey(founder.publicKey, enrollSig, removed.publicKey, stamp),
      'NotRevoked',
    );
    expect(await ownerKeys()).toEqual([founder.publicKey]);
  }, 60_000);

  it('CadrePeer: a captured admission approval cannot re-seat a removed peer', async () => {
    const peerId = '12D3KooWRevocationReplayTarget';
    const { stamp, vouchSig } = await admitPeer(peerId);

    await removeCadrePeer(peerId, stamp);
    expect(await cadrePeerRow(peerId)).toBeUndefined();

    // Replay exactly what the removed peer still holds (its VouchSig rode on the
    // replicated row). Signature valid, founder still an owner — only NotRevoked stands.
    await expectConstraintFailure(
      rawInsertCadrePeer(founder.publicKey, vouchSig, peerId, stamp),
      'NotRevoked',
    );
    expect(await cadrePeerRow(peerId)).toBeUndefined();
  }, 60_000);

  // ── Retirement is mandatory: a bare delete would free the stamp again ──────

  it('OwnerKey: a SIGNED delete with no tombstone is refused (RevocationRecorded)', async () => {
    const target = freshKeyPair();
    const { stamp } = await enrollByFounder(target);
    const before = await ownerKeys();

    // Fully authorized (founder signs the remove digest, two owners exist) — the ONLY
    // missing piece is the tombstone, so the constraint name is unambiguous.
    await expectConstraintFailure(
      rawDeleteOwnerKey(
        founder.publicKey,
        signAs(founder, removeMessage(target.publicKey, stamp)),
        target.publicKey,
      ),
      'RevocationRecorded',
    );
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  it('CadrePeer: a SIGNED delete with no tombstone is refused (RevocationRecorded)', async () => {
    const peerId = '12D3KooWBareDeleteTarget';
    const { stamp } = await admitPeer(peerId);

    await expectConstraintFailure(
      rawDeleteCadrePeer(
        founder.publicKey,
        signB64(founder, cadrePeerRemoveDigest(peerId, stamp)),
        peerId,
      ),
      'RevocationRecorded',
    );
    expect(await cadrePeerRow(peerId)).toBeDefined();
  }, 60_000);

  it('CadrePeer: a tombstone filed under the WRONG TableName does not satisfy RevocationRecorded', async () => {
    const peerId = '12D3KooWWrongTableTombstone';
    const { stamp } = await admitPeer(peerId);

    // `RowIsGone` accepts ('OwnerKey', stamp) — no OwnerKey row carries a CadrePeer's
    // stamp — so the tombstone itself is fine; what must fail is the DELETE, whose
    // RevocationRecorded subquery is scoped to TableName = 'CadrePeer'. Without that
    // scoping a stamp retired under any table name would unlock every guarded delete.
    await expectConstraintFailure(
      inTransaction(async () => {
        await rawDeleteCadrePeer(
          founder.publicKey,
          signB64(founder, cadrePeerRemoveDigest(peerId, stamp)),
          peerId,
        );
        await tombstoneStamp('OwnerKey', stamp);
      }),
      'RevocationRecorded',
    );
    expect(await cadrePeerRow(peerId)).toBeDefined();
  }, 60_000);

  // ── The stamp cannot be rotated out from under the tombstone ───────────────

  it('CadrePeer: an owner re-vouch may re-bind the voucher but NOT rotate the StampId', async () => {
    const peerId = '12D3KooWStampRotationTarget';
    const { stamp } = await admitPeer(peerId);

    // A rotation would strand the OLD stamp: never tombstoned (a delete only retires
    // the stamp it carries), no longer on a live row, so the original admission
    // approval — replicated to everyone as VouchSig — would resurrect the peer after
    // the next removal. The delete+tombstone transaction is the only retirement path.
    const rotated = freshStamp();
    await expectConstraintFailure(
      rawRevouchCadrePeer(
        founder.publicKey,
        signB64(founder, cadrePeerVoucherDigest(peerId, rotated)),
        peerId,
        rotated,
      ),
      'AuthorizedUpdate',
    );
    expect(await db.queryCadrePeerStampId(peerId)).toBe(stamp);

    // The legitimate re-touch (reauthorizePeer's shape) still passes: same stamp,
    // freshly signed voucher.
    await rawRevouchCadrePeer(
      founder.publicKey,
      signB64(founder, cadrePeerVoucherDigest(peerId, stamp)),
      peerId,
      null,
    );
    expect(await db.queryCadrePeerStampId(peerId)).toBe(stamp);
  }, 60_000);

  // ── Removal is stamp-retirement, not an identity ban ───────────────────────

  it('OwnerKey: after removal, a re-add with a FRESH stamp and fresh signature succeeds', async () => {
    const rotated = freshKeyPair();
    const { stamp } = await enrollByFounder(rotated);
    await removeOwnerKey(rotated, stamp);
    expect(await ownerKeys()).toEqual([founder.publicKey]);

    const freshStampId = freshStamp();
    await rawInsertOwnerKey(
      founder.publicKey,
      signAs(founder, enrollMessage(rotated.publicKey, freshStampId)),
      rotated.publicKey,
      freshStampId,
    );
    expect(await ownerKeys()).toEqual([founder.publicKey, rotated.publicKey].sort());
    expect(await stampIdOf(rotated.publicKey)).toBe(freshStampId);
  }, 60_000);

  it('CadrePeer: after removal, a re-add with a FRESH stamp and fresh signature succeeds', async () => {
    const peerId = '12D3KooWReAdmitTarget';
    const { stamp } = await admitPeer(peerId);
    await removeCadrePeer(peerId, stamp);
    expect(await cadrePeerRow(peerId)).toBeUndefined();

    const freshStampId = freshStamp();
    await rawInsertCadrePeer(
      founder.publicKey,
      signB64(founder, cadrePeerVoucherDigest(peerId, freshStampId)),
      peerId,
      freshStampId,
    );
    expect(await cadrePeerRow(peerId)).toBeDefined();
  }, 60_000);

  // ── ValidationKey / Strand: delete used to be gated by NOTHING ─────────────
  //
  // Each attack below rides in a transaction alongside its tombstone so
  // `RevocationRecorded` is satisfied and the ONLY failing constraint is the authorization
  // one — the same technique control-ownerkey-self-authorization.spec.ts uses to keep a
  // rejection pinned to the constraint it is actually about.

  it('ValidationKey: a delete is refused unless an owner signs the remove digest (AuthorizedDelete)', async () => {
    const key = 'val-del-' + Math.random().toString(36).slice(2);
    const { stamp, addSig } = await enrollValidationKey(key);
    const decoy = 'val-decoy-' + Math.random().toString(36).slice(2);
    const { stamp: decoyStamp } = await enrollValidationKey(decoy);

    const attack = (contextOwner: string | null, signature: string | null) =>
      inTransaction(async () => {
        await rawDeleteValidationKey(contextOwner, signature, key);
        await tombstoneStamp('ValidationKey', stamp);
      });

    // Before the fix `Authorized` was a bare `check`, which in Quereus covers insert and
    // update only — so this unsigned delete was ACCEPTED and the row simply vanished.
    await expectConstraintFailure(attack(null, null), 'AuthorizedDelete');

    // The enrollment approval covers the same (Key, StampId) fields, but under the 'add'
    // action tag, so it can never be replayed as a removal.
    await expectConstraintFailure(attack(founder.publicKey, addSig), 'AuthorizedDelete');

    // A genuine 'remove' signature minted for ANOTHER row does not transplant onto this one.
    await expectConstraintFailure(
      attack(founder.publicKey, signAs(founder, validationKeyMessage('remove', decoy, decoyStamp))),
      'AuthorizedDelete',
    );

    expect(await validationKeyRow(key)).toBeDefined();
  }, 60_000);

  it('Strand: a delete is refused unless an owner signs the remove digest (AuthorizedDelete)', async () => {
    // A closed strand's row carries MemberPrivateKey — the party's own membership key for
    // that network — so an ungated delete was live data destruction, not just a registry edit.
    const id = 'strand-del-' + Math.random().toString(36).slice(2);
    const { stamp, addSig } = await seatStrand(id);
    const decoy = 'strand-decoy-' + Math.random().toString(36).slice(2);
    const { stamp: decoyStamp } = await seatStrand(decoy);

    const attack = (contextOwner: string | null, signature: string | null) =>
      inTransaction(async () => {
        await rawDeleteStrand(contextOwner, signature, id);
        await tombstoneStamp('Strand', stamp);
      });

    await expectConstraintFailure(attack(null, null), 'AuthorizedDelete');
    await expectConstraintFailure(attack(founder.publicKey, addSig), 'AuthorizedDelete');
    await expectConstraintFailure(
      attack(founder.publicKey, signAs(founder, strandRemoveMessage(decoy, decoyStamp))),
      'AuthorizedDelete',
    );

    expect(await strandRow(id)).toBeDefined();
  }, 60_000);

  it('Strand: a formation invitation authorizes forming a strand, never destroying one', async () => {
    // `AuthorizedInsert`'s consent branch is signature-free (the existence of a
    // FormationUsage row IS the authorization). Mirroring it onto delete would let any
    // invited peer drop the host strand, so `AuthorizedDelete` deliberately omits it.
    const token = 'fi-consent-del-' + Math.random().toString(36).slice(2);
    const id = 'strand-consent-del-' + Math.random().toString(36).slice(2);
    await db.insertFormationInvite(token, 'sapp-consent-del', founder.publicKey,
      message => signAs(founder, message), { totalUses: 1 });
    await db.redeemInvitation({ token, strandId: id, type: 'c', memberPrivateKey: 'member-key-' + id });

    const stamp = String((await strandRow(id))?.StampId);
    await expectConstraintFailure(
      inTransaction(async () => {
        await rawDeleteStrand(null, null, id);
        await tombstoneStamp('Strand', stamp);
      }),
      'AuthorizedDelete',
    );
    expect(await strandRow(id)).toBeDefined();

    // The owner branch does not care HOW the row was seated: the same signed-delete +
    // tombstone shape removes a consent-formed strand as cleanly as an owner-seated one.
    await removeStrand(id, stamp);
    expect(await strandRow(id)).toBeUndefined();
  }, 60_000);

  it('ValidationKey: a signed delete must carry a tombstone under the matching TableName (RevocationRecorded)', async () => {
    const key = 'val-tomb-' + Math.random().toString(36).slice(2);
    const { stamp } = await enrollValidationKey(key);
    const removeSig = (): string => signAs(founder, validationKeyMessage('remove', key, stamp));

    // Fully authorized — the ONLY missing piece is the tombstone.
    await expectConstraintFailure(
      rawDeleteValidationKey(founder.publicKey, removeSig(), key),
      'RevocationRecorded',
    );
    expect(await validationKeyRow(key)).toBeDefined();

    // A tombstone filed under another table's name does not satisfy the scoped subquery.
    await expectConstraintFailure(
      inTransaction(async () => {
        await rawDeleteValidationKey(founder.publicKey, removeSig(), key);
        await tombstoneStamp('OwnerKey', stamp);
      }),
      'RevocationRecorded',
    );
    expect(await validationKeyRow(key)).toBeDefined();

    // The legitimate shape: signed delete + matching tombstone in ONE transaction.
    await removeValidationKey(key, stamp);
    expect(await validationKeyRow(key)).toBeUndefined();
  }, 60_000);

  it('Strand: a signed delete must carry a tombstone under the matching TableName (RevocationRecorded)', async () => {
    const id = 'strand-tomb-' + Math.random().toString(36).slice(2);
    const { stamp } = await seatStrand(id);
    const removeSig = (): string => signAs(founder, strandRemoveMessage(id, stamp));

    await expectConstraintFailure(
      rawDeleteStrand(founder.publicKey, removeSig(), id),
      'RevocationRecorded',
    );
    expect(await strandRow(id)).toBeDefined();

    await expectConstraintFailure(
      inTransaction(async () => {
        await rawDeleteStrand(founder.publicKey, removeSig(), id);
        await tombstoneStamp('CadrePeer', stamp);
      }),
      'RevocationRecorded',
    );
    expect(await strandRow(id)).toBeDefined();

    await removeStrand(id, stamp);
    expect(await strandRow(id)).toBeUndefined();
  }, 60_000);

  it('ValidationKey: a captured enrollment approval cannot re-seat a removed key, but a fresh stamp can', async () => {
    const key = 'val-replay-' + Math.random().toString(36).slice(2);
    const { stamp, addSig } = await enrollValidationKey(key);
    await removeValidationKey(key, stamp);
    expect(await validationKeyRow(key)).toBeUndefined();

    // Replay the captured enrollment VERBATIM: the signature still verifies and the founder
    // is still an owner, so `AuthorizedInsert` passes — only `NotRevoked` stands.
    await expectConstraintFailure(
      rawInsertValidationKey(founder.publicKey, addSig, key, stamp),
      'NotRevoked',
    );
    expect(await validationKeyRow(key)).toBeUndefined();

    // Removal retires the STAMP, not the identity: a fresh stamp + fresh signature re-enrolls.
    const freshStampId = freshStamp();
    await rawInsertValidationKey(
      founder.publicKey,
      signAs(founder, validationKeyMessage('add', key, freshStampId)),
      key,
      freshStampId,
    );
    expect(await validationKeyRow(key)).toBeDefined();
  }, 60_000);

  it('Strand: a captured add approval cannot re-seat a removed strand, but a fresh stamp can', async () => {
    const id = 'strand-replay-' + Math.random().toString(36).slice(2);
    const memberPrivateKey = 'member-key-' + Math.random().toString(36).slice(2);
    const { stamp, addSig } = await seatStrand(id, 'c', memberPrivateKey);
    await removeStrand(id, stamp);
    expect(await strandRow(id)).toBeUndefined();

    await expectConstraintFailure(
      rawInsertStrand(founder.publicKey, addSig, id, 'c', memberPrivateKey, stamp),
      'NotRevoked',
    );
    expect(await strandRow(id)).toBeUndefined();

    const freshStampId = freshStamp();
    await rawInsertStrand(
      founder.publicKey,
      signAs(founder, strandAddMessage(id, 'c', memberPrivateKey, freshStampId)),
      id,
      'c',
      memberPrivateKey,
      freshStampId,
    );
    expect(await strandRow(id)).toBeDefined();
  }, 60_000);

  // ── The tombstone table keeps itself honest ────────────────────────────────

  it('Revocation: tombstoning a LIVE row\'s stamp is refused on every TableName branch (RowIsGone)', async () => {
    // No accompanying delete: retiring a live stamp would let the NEXT delete of that row
    // ride a pre-planted tombstone, decoupling retirement from the removal transaction.
    const founderStamp = await stampIdOf(founder.publicKey);
    await expectConstraintFailure(tombstoneStamp('OwnerKey', founderStamp), 'RowIsGone');

    const peerId = '12D3KooWLiveStampTarget';
    const { stamp } = await admitPeer(peerId);
    await expectConstraintFailure(tombstoneStamp('CadrePeer', stamp), 'RowIsGone');

    const valKey = 'val-live-stamp-' + Math.random().toString(36).slice(2);
    const { stamp: valStamp } = await enrollValidationKey(valKey);
    await expectConstraintFailure(tombstoneStamp('ValidationKey', valStamp), 'RowIsGone');

    const strandId = 'strand-live-stamp-' + Math.random().toString(36).slice(2);
    const { stamp: strandStamp } = await seatStrand(strandId);
    await expectConstraintFailure(tombstoneStamp('Strand', strandStamp), 'RowIsGone');
  }, 60_000);

  it('Revocation: a TableName outside the guarded set is refused (both RowIsGone branches false)', async () => {
    await expectConstraintFailure(tombstoneStamp('DeviceToken', freshStamp()), 'RowIsGone');
  }, 60_000);

  it('Revocation: a tombstone is permanent — delete and update are both refused (Immutable)', async () => {
    // Retiring a never-existing stamp is allowed and harmless: a stamp carries 128 bits of
    // CSPRNG output, so a future legitimate stamp cannot collide with a pre-planted tombstone.
    const orphan = freshStamp();
    await tombstoneStamp('CadrePeer', orphan);

    await expectConstraintFailure(
      rawDb.exec(
        'delete from CadreControl.Revocation where TableName = ? and StampId = ?',
        ['CadrePeer', orphan],
      ),
      'Immutable',
    );
    await expectConstraintFailure(
      rawDb.exec(
        'update CadreControl.Revocation set StampId = ? where TableName = ? and StampId = ?',
        [freshStamp(), 'CadrePeer', orphan],
      ),
      'Immutable',
    );
    const still = await rawDb.get(
      'select StampId from CadreControl.Revocation where TableName = ? and StampId = ?',
      ['CadrePeer', orphan],
    );
    expect(still).toBeDefined();
  }, 60_000);
});
