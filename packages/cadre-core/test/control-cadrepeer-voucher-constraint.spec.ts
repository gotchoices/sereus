import { describe, it, expect } from 'vitest';
import { Database } from '@quereus/quereus';

/**
 * Crypto-free behavioral guard for the `CadrePeer` voucher-binding predicates added
 * with the `membership-cadrepeer-voucher-persist` ticket, and the null-safety the
 * `cadre-invite-schema-and-chain` ticket added when `VouchSig` gained a legitimate null.
 *
 * The real `CadrePeer.AuthorizedInsert` / `AuthorizedUpdate` constraints ALSO carry a
 * crypto `verify(digest(...))` branch (covered by the real-crypto replication specs), but
 * the voucher-binding portion — "the stored (VouchOwner, VouchSig) MUST equal the
 * insert context pair" and "the proof columns are immutable on self-update" — is pure
 * equality, no crypto. This spec applies a MINIMAL schema carrying only those predicates and
 * exercises the truth table directly, exactly as `control-member-key-constraint.spec.ts`
 * does for `MemberKeyClosedOnly`. The `control-schema-drift` guard separately pins that
 * this predicate text is what the real table carries.
 *
 * Null matters here because a CHECK that evaluates to null PASSES: a bare
 * `new.VouchSig = old.VouchSig` over a null column would let a self-update fill the column
 * in, and `new.VouchOwner = context.OwnerKey` with nothing stored would pin nothing. The
 * consent shape (`VouchSig` null, `VouchUsage` set) stands in for the real consent branch
 * so an invitation-admitted row can be seated and its self-update rules exercised.
 *
 * Keep the predicates below textually aligned with `control-schema.ts` / `schemas/control.qsql`.
 */
describe('CadrePeer voucher-binding predicates (crypto-free)', () => {
  async function freshDb(): Promise<Database> {
    const db = new Database();
    await db.exec(`
      declare schema Probe {
        table CadrePeer (
          PeerId text primary key,
          StampId text not null unique,
          VouchOwner text null,
          VouchSig text null,
          VouchUsage text null,
          constraint VoucherBind check on insert (
            (
              coalesce(new.VouchOwner, '') = context.OwnerKey
              and coalesce(new.VouchSig, '') = context.Signature
              and new.VouchUsage is null
            )
              or (new.VouchSig is null and new.VouchOwner is not null and new.VouchUsage is not null)
          ),
          constraint Immutable check on update (
            new.StampId = old.StampId
            and new.VouchOwner = old.VouchOwner
            and coalesce(new.VouchSig, '') = coalesce(old.VouchSig, '')
            and coalesce(new.VouchUsage, '') = coalesce(old.VouchUsage, '')
          )
        ) with context (OwnerKey text null, Signature text null);
      }
      apply schema Probe;
    `);
    return db;
  }

  async function insert(
    db: Database,
    peerId: string,
    stampId: string,
    ctxOwner: string | null,
    ctxSig: string | null,
    vouchOwner: string | null,
    vouchSig: string | null,
    vouchUsage: string | null = null,
  ): Promise<void> {
    await db.exec(
      `insert into Probe.CadrePeer (PeerId, StampId, VouchOwner, VouchSig, VouchUsage)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?)`,
      [ctxOwner, ctxSig, peerId, stampId, vouchOwner, vouchSig, vouchUsage],
    );
  }

  async function count(db: Database): Promise<number> {
    const row = await db.get(`select count(1) as c from Probe.CadrePeer`);
    return Number(row?.c ?? 0);
  }

  it('stores the voucher when it equals the insert context pair', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'SIG');
    expect(await count(db)).toBe(1);
    const row = await db.get(`select VouchOwner, VouchSig from Probe.CadrePeer where PeerId = 'p1'`);
    expect(row?.VouchOwner).toBe('AUTH');
    expect(row?.VouchSig).toBe('SIG');
  });

  it('rejects an insert whose stored VouchOwner differs from the signing owner', async () => {
    const db = await freshDb();
    // Writer names a DIFFERENT owner than the one whose signature it presents.
    await expect(insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'OTHER', 'SIG')).rejects.toThrow();
    expect(await count(db)).toBe(0);
  });

  it('rejects an insert whose stored VouchSig differs from the context signature', async () => {
    const db = await freshDb();
    await expect(insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'FORGED')).rejects.toThrow();
    expect(await count(db)).toBe(0);
  });

  it('rejects a duplicate StampId (single-use anti-replay)', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'SIG');
    // A second row (even a different peer) reusing the same StampId is rejected by the
    // unique constraint — a captured signed insert cannot be replayed.
    await expect(insert(db, 'p2', 'stamp-1', 'AUTH', 'SIG2', 'AUTH', 'SIG2')).rejects.toThrow();
    expect(await count(db)).toBe(1);
  });

  it('rejects a self-update that tries to rewrite the voucher', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'SIG');
    await expect(
      db.exec(
        `update Probe.CadrePeer with context OwnerKey = null, Signature = null
           set VouchOwner = 'HIJACK' where PeerId = 'p1'`,
      ),
    ).rejects.toThrow();
    const row = await db.get(`select VouchOwner from Probe.CadrePeer where PeerId = 'p1'`);
    expect(row?.VouchOwner).toBe('AUTH');
  });

  it('rejects a self-update that tries to rotate the StampId', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'SIG');
    await expect(
      db.exec(
        `update Probe.CadrePeer with context OwnerKey = null, Signature = null
           set StampId = 'stamp-2' where PeerId = 'p1'`,
      ),
    ).rejects.toThrow();
    const row = await db.get(`select StampId from Probe.CadrePeer where PeerId = 'p1'`);
    expect(row?.StampId).toBe('stamp-1');
  });

  it('admits a self-update that leaves the voucher and StampId untouched', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'SIG');
    await db.exec(
      `update Probe.CadrePeer with context OwnerKey = null, Signature = null
         set VouchOwner = VouchOwner where PeerId = 'p1'`,
    );
    expect(await count(db)).toBe(1);
  });

  it('rejects an owner-signed insert that stores a null voucher (the pin is null-safe)', async () => {
    const db = await freshDb();
    // A bare `new.VouchOwner = context.OwnerKey` is null here, and a null CHECK passes.
    await expect(insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', null, null)).rejects.toThrow();
    expect(await count(db)).toBe(0);
  });

  it('admits a self-update of an invitation-admitted row that leaves its null VouchSig null', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', null, null, 'ISSUER', null, 'usage-1');
    // The null-safe compare is what lets such a row self-publish at all: `null = null` is
    // null, and with the consent branch absent on update that null would be the whole check.
    await db.exec(
      `update Probe.CadrePeer with context OwnerKey = null, Signature = null
         set VouchOwner = VouchOwner where PeerId = 'p1'`,
    );
    expect(await count(db)).toBe(1);
  });

  it('rejects a self-update that fills in a null VouchSig or clears VouchUsage', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', null, null, 'ISSUER', null, 'usage-1');
    await expect(
      db.exec(
        `update Probe.CadrePeer with context OwnerKey = null, Signature = null
           set VouchSig = 'FORGED' where PeerId = 'p1'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `update Probe.CadrePeer with context OwnerKey = null, Signature = null
           set VouchUsage = null where PeerId = 'p1'`,
      ),
    ).rejects.toThrow();
    const row = await db.get(`select VouchSig, VouchUsage from Probe.CadrePeer where PeerId = 'p1'`);
    expect(row?.VouchSig).toBeNull();
    expect(row?.VouchUsage).toBe('usage-1');
  });
});
