import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import debug from 'debug';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { CONTROL_SCHEMA } from '../src/control-schema.js';
import { cadrePeerVoucherDigest, cadrePeerRemoveDigest, deviceTokenAddDigest } from '../src/peer-authorization.js';
import type { DeviceTokenAuthorizedRow } from '../src/peer-authorization.js';
import {
  expectConstraintFailure,
  freshKeyPair,
  freshStamp,
  signAs,
  signB64,
  revocationMessage,
  type KeyPair,
} from './control-constraint-helpers.js';

/**
 * REAP authorization coverage: a COMMITTED `Revocation` tombstone authorizes deleting the
 * exact row incarnation it retires — the new branch on `CadrePeer` / `DeviceToken` /
 * `ValidationKey` `AuthorizedDelete`, and the `ControlDatabase.reapRevokedRow` method that
 * drives it. See the constraint comment on `CadrePeer.AuthorizedDelete` for the full
 * rationale (why `committed.*`, why the stamp is bound).
 *
 * Two suites, two schemas:
 *
 * - **Negatives run against the REAL schema.** Every refusal below is constructible with
 *   ordinary local writes, so nothing is relaxed.
 * - **Positives need a schema override.** The live-row-plus-tombstone state a reap exists
 *   for is reachable only by replication merge: `Revocation.RowIsGone` refuses a local
 *   tombstone while its row is live, and each guarded table's `NotRevoked` refuses an
 *   insert naming a retired stamp. The positive suite therefore boots its nodes on a copy
 *   of `CONTROL_SCHEMA` with EXACTLY the `RowIsGone` constraint stripped — its only job is
 *   stopping an owner retiring a stamp *early* via a local write, which is precisely the
 *   guard replication merge bypasses. `NotRevoked`, `RevocationRecorded` and
 *   `AuthorizedDelete` — the rules actually under test — stay intact.
 *
 * Every test boots its OWN `CadreNode` (empty bootstrap, transaction profile) seeded with
 * one founding owner, mirroring `control-revocation-replay.spec.ts`.
 */

const log = debug('sereus:cadre:test:revocation-reap');

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

/**
 * `CONTROL_SCHEMA` with EXACTLY the `Revocation.RowIsGone` constraint removed. Throws —
 * rather than silently testing nothing — if the strip no longer matches after a future
 * schema edit, or if it somehow left a second declaration behind.
 */
function stripRowIsGone(schema: string): string {
  // The constraint body's lines are indented deeper than its 8-space `),` closer, so the
  // non-greedy match ends exactly at RowIsGone's own closing parenthesis.
  const stripped = schema.replace(/[ \t]*constraint RowIsGone check on insert \([^]*?\n {8}\),\n/, '');
  if (stripped === schema) {
    throw new Error('RowIsGone strip matched nothing — the schema text changed; fix this fixture before trusting the positive reap tests');
  }
  if (/constraint RowIsGone/.test(stripped)) {
    throw new Error('RowIsGone strip left a declaration behind — fix this fixture');
  }
  return stripped;
}

describe('reap authorization: a committed tombstone authorizes deleting the row it retires', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  /** Boot a fresh single-node party; `schemaPath` overrides the control schema (positive suite). */
  async function boot(schemaPath?: string): Promise<void> {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'revocation-reap-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
        schemaPath,
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }

  afterEach(async () => {
    await node?.stop();
  });

  function cadrePeerRow(peerId: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select PeerId from CadreControl.CadrePeer where PeerId = ?', [peerId]);
  }

  function validationKeyRow(key: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select Key from CadreControl.ValidationKey where Key = ?', [key]);
  }

  function strandRow(id: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select Id, StampId from CadreControl.Strand where Id = ?', [id]);
  }

  /** Admit a peer the legitimate way (owner-vouched insert). */
  async function admitPeer(peerId: string): Promise<{ stamp: string }> {
    const stamp = freshStamp();
    const vouchSig = signB64(founder, cadrePeerVoucherDigest(peerId, stamp));
    await rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, vouchSig, peerId, null, '', null, null, stamp, founder.publicKey, vouchSig],
    );
    return { stamp };
  }

  /** Enroll a validation key the legitimate way. */
  async function enrollValidationKey(key: string): Promise<{ stamp: string }> {
    const stamp = freshStamp();
    await rawDb.exec(
      `insert into CadreControl.ValidationKey (Key, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?)`,
      [founder.publicKey, signAs(founder, validationKeyMessage('add', key, stamp)), key, stamp],
    );
    return { stamp };
  }

  /** Seat a closed, key-bearing strand the legitimate (owner-signed) way. */
  async function seatStrand(id: string): Promise<{ stamp: string }> {
    const stamp = freshStamp();
    const memberPrivateKey = 'member-key-' + Math.random().toString(36).slice(2);
    await rawDb.exec(
      `insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?)`,
      [founder.publicKey, signAs(founder, strandAddMessage(id, 'c', memberPrivateKey, stamp)), id, 'c', memberPrivateKey, stamp],
    );
    return { stamp };
  }

  /** Seat a DeviceToken row the legitimate (owner-signed) way. */
  async function seatDeviceToken(peerId: string): Promise<{ stamp: string }> {
    const row: DeviceTokenAuthorizedRow = {
      peerId,
      platform: 'fcm',
      token: 'tok-' + Math.random().toString(36).slice(2),
      updatedAt: null,
      sig: null,
      stampId: freshStamp(),
    };
    await rawDb.exec(
      `insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, signB64(founder, deviceTokenAddDigest(row)), row.peerId, row.platform, row.token, row.updatedAt, row.sig, row.stampId],
    );
    return { stamp: row.stampId };
  }

  /** Owner-signed tombstone append (the shape `Revocation.Authorized` verifies). */
  function tombstoneStamp(tableName: string, rowKey: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, RowKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?)`,
      [founder.publicKey, signAs(founder, revocationMessage(tableName, rowKey, stampId)), tableName, rowKey, stampId],
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

  /** The legitimate CadrePeer removal shape: signed delete + tombstone in ONE transaction. */
  async function removeCadrePeer(peerId: string, stamp: string): Promise<void> {
    await inTransaction(async () => {
      await rawDb.exec(
        `delete from CadreControl.CadrePeer
           with context OwnerKey = ?, Signature = ?
           where PeerId = ?`,
        [founder.publicKey, signB64(founder, cadrePeerRemoveDigest(peerId, stamp)), peerId],
      );
      await tombstoneStamp('CadrePeer', peerId, stamp);
    });
  }

  // ── Negatives: every one constructible with ordinary local writes ──────────

  describe('against the real schema', () => {
    beforeEach(() => boot(), 60_000);

    it('a reap of a live, never-revoked row is refused by the schema — thrown, not silent', async () => {
      const peerId = '12D3KooWReapNoTombstone';
      const { stamp } = await admitPeer(peerId);

      // The bare unsigned delete reapRevokedRow issues violates BOTH AuthorizedDelete (no
      // signature, no committed tombstone) and RevocationRecorded (no tombstone at all) —
      // the engine reports one of the two, and either proves the write was refused rather
      // than silently accepted. The same-transaction test below pins AuthorizedDelete as
      // the single rejector; this one pins the API surface.
      await expectConstraintFailure(
        db.reapRevokedRow('CadrePeer', peerId, stamp),
        'AuthorizedDelete', 'RevocationRecorded',
      );
      expect(await cadrePeerRow(peerId)).toBeDefined();
    }, 60_000);

    it('a stale tombstone must not kill the current incarnation (owner re-seat)', async () => {
      // Seat (stamp S1) -> owner-remove (tombstone S1) -> owner re-seat (fresh stamp S2):
      // the live row now shares its RowKey with a committed tombstone at a DIFFERENT stamp.
      const peerId = '12D3KooWReapReseatTarget';
      const { stamp: s1 } = await admitPeer(peerId);
      await removeCadrePeer(peerId, s1);
      const s2 = freshStamp();
      await rawDb.exec(
        `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
           with context OwnerKey = ?, Signature = ?
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [founder.publicKey, signB64(founder, cadrePeerVoucherDigest(peerId, s2)), peerId, null, '', null, null, s2, founder.publicKey, signB64(founder, cadrePeerVoucherDigest(peerId, s2))],
      );

      // The previous incarnation's stamp: the guard sees the live stamp differs and
      // returns false WITHOUT writing — the owner's brand-new row must survive.
      expect(await db.reapRevokedRow('CadrePeer', peerId, s1)).toBe(false);
      expect(await db.queryCadrePeerStampId(peerId)).toBe(s2);

      // The current stamp: the guard passes (it IS the live stamp) and the schema refuses
      // the delete — no tombstone names S2 (AuthorizedDelete's reap branch and
      // RevocationRecorded both reject; either name proves refusal).
      await expectConstraintFailure(
        db.reapRevokedRow('CadrePeer', peerId, s2),
        'AuthorizedDelete', 'RevocationRecorded',
      );
      expect(await db.queryCadrePeerStampId(peerId)).toBe(s2);
    }, 60_000);

    it('a row absent locally is a no-op returning false — the common case on most nodes', async () => {
      expect(await db.reapRevokedRow('CadrePeer', '12D3KooWNeverHeldHere', freshStamp())).toBe(false);
      expect(await db.reapRevokedRow('DeviceToken', '12D3KooWNeverHeldHere', freshStamp())).toBe(false);
      expect(await db.reapRevokedRow('ValidationKey', 'never-enrolled-key', freshStamp())).toBe(false);
    }, 60_000);

    it('a SAME-TRANSACTION tombstone does not authorize an unsigned delete — committed.* is load-bearing', async () => {
      // The exact shape a plain-Revocation read would wrongly accept: an unsigned delete
      // riding alongside an owner-signed tombstone in ONE transaction. RevocationRecorded
      // is satisfied by the sibling tombstone and RowIsGone by the sibling delete, so
      // AuthorizedDelete is the single rejector — the tombstone did not exist BEFORE the
      // transaction, which is what committed.Revocation states.
      const peerId = '12D3KooWSameTxnTombstone';
      const { stamp } = await admitPeer(peerId);
      await expectConstraintFailure(
        inTransaction(async () => {
          await rawDb.exec(
            `delete from CadreControl.CadrePeer
               with context OwnerKey = null, Signature = null
               where PeerId = ?`,
            [peerId],
          );
          await tombstoneStamp('CadrePeer', peerId, stamp);
        }),
        'AuthorizedDelete',
      );
      expect(await cadrePeerRow(peerId)).toBeDefined();

      const tokenPeerId = '12D3KooWSameTxnTombstoneToken';
      const { stamp: tokenStamp } = await seatDeviceToken(tokenPeerId);
      await expectConstraintFailure(
        inTransaction(async () => {
          await rawDb.exec(
            `delete from CadreControl.DeviceToken
               with context OwnerKey = null, Signature = null
               where PeerId = ?`,
            [tokenPeerId],
          );
          await tombstoneStamp('DeviceToken', tokenPeerId, tokenStamp);
        }),
        'AuthorizedDelete',
      );
      expect(await db.queryDeviceTokenStampId(tokenPeerId)).toBe(tokenStamp);

      const valKey = 'val-same-txn-' + Math.random().toString(36).slice(2);
      const { stamp: valStamp } = await enrollValidationKey(valKey);
      await expectConstraintFailure(
        inTransaction(async () => {
          await rawDb.exec(
            `delete from CadreControl.ValidationKey
               with context OwnerKey = null, Signature = null
               where Key = ?`,
            [valKey],
          );
          await tombstoneStamp('ValidationKey', valKey, valStamp);
        }),
        'AuthorizedDelete',
      );
      expect(await validationKeyRow(valKey)).toBeDefined();
    }, 60_000);
  });

  // ── Positives: the merge-only fixture needs RowIsGone stripped ─────────────

  describe('against a RowIsGone-stripped schema (the replication-merge state)', () => {
    let strippedSchemaPath: string;

    beforeAll(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'reap-schema-'));
      strippedSchemaPath = join(dir, 'control-rowisgone-stripped.qsql');
      await writeFile(strippedSchemaPath, stripRowIsGone(CONTROL_SCHEMA), 'utf-8');
    });

    beforeEach(() => boot(strippedSchemaPath), 60_000);

    it('CadrePeer: a committed tombstone authorizes the reap — no owner signature, and no second tombstone', async () => {
      const peerId = '12D3KooWReapPositiveTarget';
      const { stamp } = await admitPeer(peerId);
      // With RowIsGone stripped, the tombstone commits while the row is live — the state
      // replication merge produces on a node that held the row at revocation time.
      await tombstoneStamp('CadrePeer', peerId, stamp);
      const revocationsBefore = (await db.queryRevocations()).length;

      // This is also the NON-OWNER reap: reapRevokedRow takes no signer and its delete
      // carries null OwnerKey/Signature context — the founder's private key plays no part
      // from here on, exactly as on a drone that merely converged on the tombstone.
      expect(await db.reapRevokedRow('CadrePeer', peerId, stamp)).toBe(true);
      expect(await db.queryCadrePeerStampId(peerId)).toBeNull();
      // A reap writes NOTHING to Revocation.
      expect((await db.queryRevocations()).length).toBe(revocationsBefore);
    }, 60_000);

    it('DeviceToken: a committed tombstone authorizes the reap', async () => {
      const peerId = '12D3KooWReapTokenTarget';
      const { stamp } = await seatDeviceToken(peerId);
      await tombstoneStamp('DeviceToken', peerId, stamp);
      const revocationsBefore = (await db.queryRevocations()).length;

      expect(await db.reapRevokedRow('DeviceToken', peerId, stamp)).toBe(true);
      expect(await db.queryDeviceTokenStampId(peerId)).toBeNull();
      expect((await db.queryRevocations()).length).toBe(revocationsBefore);
    }, 60_000);

    it('ValidationKey: a committed tombstone authorizes the reap', async () => {
      const key = 'val-reap-' + Math.random().toString(36).slice(2);
      const { stamp } = await enrollValidationKey(key);
      await tombstoneStamp('ValidationKey', key, stamp);
      const revocationsBefore = (await db.queryRevocations()).length;

      expect(await db.reapRevokedRow('ValidationKey', key, stamp)).toBe(true);
      expect(await db.queryValidationKeyStampId(key)).toBeNull();
      expect((await db.queryRevocations()).length).toBe(revocationsBefore);
    }, 60_000);

    it('Strand: a reap-shaped delete is refused even with a committed tombstone — the branch is deliberately absent', async () => {
      // The one guarded table with NO reap branch: its row carries MemberPrivateKey, the
      // party's own membership secret for that network, stored nowhere else. The committed
      // tombstone satisfies RevocationRecorded, so AuthorizedDelete is the single rejector
      // — pinning that the asymmetry is enforced, not just documented.
      const id = 'strand-reap-excluded-' + Math.random().toString(36).slice(2);
      const { stamp } = await seatStrand(id);
      await tombstoneStamp('Strand', id, stamp);

      await expectConstraintFailure(
        rawDb.exec(
          `delete from CadreControl.Strand
             with context OwnerKey = null, Signature = null
             where Id = ? and StampId = ?`,
          [id, stamp],
        ),
        'AuthorizedDelete',
      );
      expect(await strandRow(id)).toBeDefined();
    }, 60_000);

    it('a tombstone filed against ANOTHER table does not authorize a reap', async () => {
      // `CadrePeer` and `DeviceToken` share their key column (PeerId), so a tombstone naming
      // one is shaped exactly like a tombstone naming the other — the branch's TableName
      // clause is the only thing separating them. Both AuthorizedDelete's reap branch AND
      // RevocationRecorded bind TableName, so either name proves the pair refused it.
      const peerId = '12D3KooWCrossTableTombstone';
      const { stamp } = await seatDeviceToken(peerId);
      await tombstoneStamp('CadrePeer', peerId, stamp);

      await expectConstraintFailure(
        db.reapRevokedRow('DeviceToken', peerId, stamp),
        'AuthorizedDelete', 'RevocationRecorded',
      );
      expect(await db.queryDeviceTokenStampId(peerId)).toBe(stamp);
    }, 60_000);

    it('a tombstone whose RowKey is wrong for the stamp does not authorize a reap', async () => {
      // Not constructible in production (stamps are 128-bit CSPRNG per incarnation), but
      // the branch binds RowKey anyway. Both AuthorizedDelete's reap branch AND
      // RevocationRecorded reject a misnamed tombstone — either name proves the pair holds;
      // the reap clause is not isolable because both bind the same (RowKey, StampId) pair.
      const peerId = '12D3KooWWrongRowKeyTarget';
      const { stamp } = await admitPeer(peerId);
      await tombstoneStamp('CadrePeer', '12D3KooWSomeOtherPeer', stamp);

      await expectConstraintFailure(
        db.reapRevokedRow('CadrePeer', peerId, stamp),
        'AuthorizedDelete', 'RevocationRecorded',
      );
      expect(await db.queryCadrePeerStampId(peerId)).toBe(stamp);
    }, 60_000);

    // ── The sweep that drives the per-row reap ──────────────────────────────

    describe('reapRevokedRows: enumerate held tombstones and drop the rows they retire', () => {
      const SELF = '12D3KooWSweepSelfNode';

      it('reaps the row a matching committed tombstone retires', async () => {
        const peerId = '12D3KooWSweepTarget';
        const { stamp } = await admitPeer(peerId);
        await tombstoneStamp('CadrePeer', peerId, stamp);

        expect(await db.reapRevokedRows(SELF)).toBe(1);
        expect(await cadrePeerRow(peerId)).toBeUndefined();
      }, 60_000);

      it('skips this node\'s OWN CadrePeer and DeviceToken rows while reaping a sibling\'s', async () => {
        // The deliberate limit: a revoked node keeps its own copy of its own rows, so it
        // never fights registerSelf / retouchSelfDeviceToken over an insert the schema
        // will refuse for a retired stamp.
        const { stamp: selfPeerStamp } = await admitPeer(SELF);
        const { stamp: selfTokenStamp } = await seatDeviceToken(SELF);
        const sibling = '12D3KooWSweepSibling';
        const { stamp: siblingStamp } = await admitPeer(sibling);
        await tombstoneStamp('CadrePeer', SELF, selfPeerStamp);
        await tombstoneStamp('DeviceToken', SELF, selfTokenStamp);
        await tombstoneStamp('CadrePeer', sibling, siblingStamp);

        expect(await db.reapRevokedRows(SELF)).toBe(1);
        expect(await cadrePeerRow(SELF)).toBeDefined();
        expect(await db.queryDeviceTokenStampId(SELF)).toBe(selfTokenStamp);
        expect(await cadrePeerRow(sibling)).toBeUndefined();
      }, 60_000);

      it('skips a Strand tombstone silently and keeps sweeping', async () => {
        // Strand has no reap branch (its row carries MemberPrivateKey), and its tombstones
        // are the COMMON case in a party that has unpublished a strand — so the skip must
        // neither throw nor abort the rest of the pass.
        const strandId = 'strand-sweep-skip-' + Math.random().toString(36).slice(2);
        const { stamp: strandStamp } = await seatStrand(strandId);
        const peerId = '12D3KooWSweepAfterStrand';
        const { stamp: peerStamp } = await admitPeer(peerId);
        await tombstoneStamp('Strand', strandId, strandStamp);
        await tombstoneStamp('CadrePeer', peerId, peerStamp);

        expect(await db.reapRevokedRows(SELF)).toBe(1);
        expect(await strandRow(strandId)).toBeDefined();
        expect(await cadrePeerRow(peerId)).toBeUndefined();
      }, 60_000);

      it('returns 0 without attempting a single reap when Revocation is empty', async () => {
        // The common case on a party that has never revoked anyone: one scan, no lookups.
        const perRow = vi.spyOn(db, 'reapRevokedRow');
        try {
          expect(await db.reapRevokedRows(SELF)).toBe(0);
          expect(perRow).not.toHaveBeenCalled();
        } finally {
          perRow.mockRestore();
        }
      }, 60_000);

      it('returns 0 when every tombstone names a row this node does not hold', async () => {
        // The majority case on most nodes — every pass walks it, and it must write nothing.
        await tombstoneStamp('CadrePeer', '12D3KooWSweepNeverHeld', freshStamp());
        await tombstoneStamp('ValidationKey', 'sweep-never-enrolled', freshStamp());

        expect(await db.reapRevokedRows(SELF)).toBe(0);
      }, 60_000);

      it('leaves a row re-seated at a fresh stamp alone, and does not abort the pass', async () => {
        // Stale tombstone (S1) alongside a live incarnation at S2: the per-row guard is a
        // no-op returning false, NOT a throw — so the sibling tombstone behind it still
        // gets its reap.
        const reseated = '12D3KooWSweepReseated';
        const { stamp: s1 } = await admitPeer(reseated);
        await removeCadrePeer(reseated, s1);
        const s2 = freshStamp();
        await rawDb.exec(
          `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
             with context OwnerKey = ?, Signature = ?
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
          [founder.publicKey, signB64(founder, cadrePeerVoucherDigest(reseated, s2)), reseated, null, '', null, null, s2, founder.publicKey, signB64(founder, cadrePeerVoucherDigest(reseated, s2))],
        );
        const other = '12D3KooWSweepBehindReseated';
        const { stamp: otherStamp } = await admitPeer(other);
        await tombstoneStamp('CadrePeer', other, otherStamp);

        expect(await db.reapRevokedRows(SELF)).toBe(1);
        expect(await db.queryCadrePeerStampId(reseated)).toBe(s2);
        expect(await cadrePeerRow(other)).toBeUndefined();
      }, 60_000);
    });
  });
});
