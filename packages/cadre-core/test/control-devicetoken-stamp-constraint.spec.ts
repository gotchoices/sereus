import { describe, it, expect } from 'vitest';
import debug from 'debug';
import { Database } from '@quereus/quereus';
import { expectConstraintFailure } from './control-constraint-helpers.js';

/**
 * Crypto-free behavioral guard for the `DeviceToken` single-use-stamp predicates added
 * with the `devicetoken-stamp-writers-and-tests` ticket.
 *
 * The real `DeviceToken.NotRevoked` / `RevocationRecorded` predicates carry NO crypto at
 * all, and `AuthorizedUpdate`'s immutability/monotonicity half is pure comparison — so
 * this spec applies a MINIMAL schema carrying only those predicates and walks the truth
 * table directly, exactly as `control-cadrepeer-voucher-constraint.spec.ts` does for the
 * voucher binding and `control-member-key-constraint.spec.ts` does for
 * `MemberKeyClosedOnly`. The real-crypto halves (`AuthorizedInsert` /
 * `AuthorizedDelete`, and the self-signature branch of `AuthorizedUpdate`) are covered by
 * `control-authorization-domain-separation.spec.ts` and `device-token-registry.spec.ts`;
 * `control-schema-drift.spec.ts` separately pins that the predicate text below is what
 * the real table carries.
 *
 * The probe `Revocation` table is deliberately BARE (no constraints of its own): the real
 * one's `RowIsGone` / `Immutable` / `Authorized` are covered in
 * `control-revocation-replay.spec.ts`, and carrying them here would give a rejection two
 * possible sources instead of one.
 *
 * Keep the predicates below textually aligned with `control-schema.ts` /
 * `schemas/control.qsql`.
 */

const log = debug('sereus:cadre:test:devicetoken-stamp');

describe('DeviceToken single-use-stamp predicates (crypto-free)', () => {
  async function freshDb(): Promise<Database> {
    const db = new Database();
    await db.exec(`
      declare schema Probe {
        table Revocation (
          TableName text,
          StampId text,
          primary key (TableName, StampId)
        );
        table DeviceToken (
          PeerId text primary key,
          Platform text not null,
          Token text not null,
          UpdatedAt int null,
          StampId text not null unique,
          constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'DeviceToken' and R.StampId = new.StampId)
          ),
          constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'DeviceToken' and R.StampId = old.StampId)
          ),
          -- The non-crypto half of the real AuthorizedUpdate: the self-update branch is the
          -- ONLY branch, and it pins PeerId + StampId and demands a strictly increasing
          -- UpdatedAt. Named separately here because the real constraint's remaining clause
          -- (verify the peer's Sig against the bound CadrePeer.PublicKey) needs crypto.
          constraint Immutable check on update (
            new.PeerId = old.PeerId
            and new.StampId = old.StampId
            and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
          )
        );
      }
      apply schema Probe;
    `);
    return db;
  }

  function insert(
    db: Database,
    peerId: string,
    platform: string,
    token: string,
    updatedAt: number | null,
    stampId: string,
  ): Promise<void> {
    return db.exec(
      `insert into Probe.DeviceToken (PeerId, Platform, Token, UpdatedAt, StampId)
         values (?, ?, ?, ?, ?)`,
      [peerId, platform, token, updatedAt, stampId],
    );
  }

  function deleteRow(db: Database, peerId: string): Promise<void> {
    return db.exec(`delete from Probe.DeviceToken where PeerId = ?`, [peerId]);
  }

  function tombstoneStamp(db: Database, stampId: string): Promise<void> {
    return db.exec(
      `insert into Probe.Revocation (TableName, StampId) values ('DeviceToken', ?)`,
      [stampId],
    );
  }

  /** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
  async function inTransaction(db: Database, statements: () => Promise<void>): Promise<void> {
    await db.beginTransaction();
    try {
      await statements();
      await db.commit();
    } catch (error) {
      // A failed commit() already tore the transaction down, so rollback() throws
      // "no transaction active" — log it rather than masking the real cause.
      try {
        await db.rollback();
      } catch (rollbackError) {
        log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
      }
      throw error;
    }
  }

  /** The legitimate clear shape: the delete and its tombstone commit together. */
  function clearToken(db: Database, peerId: string, stampId: string): Promise<void> {
    return inTransaction(db, async () => {
      await deleteRow(db, peerId);
      await tombstoneStamp(db, stampId);
    });
  }

  async function count(db: Database): Promise<number> {
    const row = await db.get(`select count(1) as c from Probe.DeviceToken`);
    return Number(row?.c ?? 0);
  }

  it('admits a first insert whose stamp has never been retired', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    expect(await count(db)).toBe(1);
  });

  it('rejects a duplicate StampId while the row lives (unique)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    // A second row — even for a different peer — reusing the live stamp is refused by
    // the unique column, before NotRevoked is ever consulted.
    await expect(insert(db, 'p2', 'fcm', 'tok-2', 1000, 'stamp-1')).rejects.toThrow();
    expect(await count(db)).toBe(1);
  });

  it('rejects a delete that does not carry the matching tombstone (RevocationRecorded)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    // A bare delete would free the stamp again, so the row must stay put.
    await expectConstraintFailure(deleteRow(db, 'p1'), 'RevocationRecorded');
    expect(await count(db)).toBe(1);
  });

  it('rejects a delete whose tombstone names a DIFFERENT stamp (RevocationRecorded)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    await expectConstraintFailure(
      inTransaction(db, async () => {
        await deleteRow(db, 'p1');
        await tombstoneStamp(db, 'stamp-unrelated');
      }),
      'RevocationRecorded',
    );
    expect(await count(db)).toBe(1);
  });

  it('admits a delete that files the matching tombstone in the same transaction', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    await clearToken(db, 'p1', 'stamp-1');
    expect(await count(db)).toBe(0);
  });

  it('rejects a re-insert naming the RETIRED stamp (NotRevoked)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    await clearToken(db, 'p1', 'stamp-1');
    // The exact row the owner once approved, replayed after the clear: `unique` no longer
    // blocks it (the row is gone), so retirement is the only thing standing.
    await expectConstraintFailure(
      insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1'),
      'NotRevoked',
    );
    expect(await count(db)).toBe(0);
  });

  it('admits a re-insert carrying a FRESH stamp (a clear is not a ban on the peer)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    await clearToken(db, 'p1', 'stamp-1');
    // The legitimate re-register path: a new stamp per insert, so logout → login works.
    await insert(db, 'p1', 'fcm', 'tok-2', 2000, 'stamp-2');
    expect(await count(db)).toBe(1);
  });

  it('rejects an update that rotates the StampId (Immutable)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    // Rotating the stamp on update would leave the OLD stamp live-free and untombstoned,
    // so the approval that seated the row would verify again. Retirement is delete +
    // tombstone, never an update.
    await expectConstraintFailure(
      db.exec(`update Probe.DeviceToken set StampId = ?, UpdatedAt = ? where PeerId = ?`,
        ['stamp-2', 2000, 'p1']),
      'Immutable',
    );
    const row = await db.get(`select StampId from Probe.DeviceToken where PeerId = 'p1'`);
    expect(row?.StampId).toBe('stamp-1');
  });

  it('rejects an update that rolls UpdatedAt backwards (Immutable)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    await expectConstraintFailure(
      db.exec(`update Probe.DeviceToken set Token = ?, UpdatedAt = ? where PeerId = ?`,
        ['tok-rollback', 999, 'p1']),
      'Immutable',
    );
    const row = await db.get(`select Token, UpdatedAt from Probe.DeviceToken where PeerId = 'p1'`);
    expect(row?.Token).toBe('tok-1');
    expect(Number(row?.UpdatedAt)).toBe(1000);
  });

  it('admits a rotation that keeps the StampId and advances UpdatedAt', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'fcm', 'tok-1', 1000, 'stamp-1');
    // Platform + Token may change on a self-update (platform switch / reinstall).
    await db.exec(`update Probe.DeviceToken set Platform = ?, Token = ?, UpdatedAt = ? where PeerId = ?`,
      ['apns', 'tok-2', 2000, 'p1']);
    const row = await db.get(`select Platform, Token, StampId from Probe.DeviceToken where PeerId = 'p1'`);
    expect(row?.Platform).toBe('apns');
    expect(row?.Token).toBe('tok-2');
    expect(row?.StampId).toBe('stamp-1');
  });
});
