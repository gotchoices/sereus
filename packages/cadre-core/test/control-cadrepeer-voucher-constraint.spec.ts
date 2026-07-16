import { describe, it, expect } from 'vitest';
import { Database } from '@quereus/quereus';

/**
 * Crypto-free behavioral guard for the `CadrePeer` voucher-binding predicates added
 * with the `membership-cadrepeer-voucher-persist` ticket.
 *
 * The real `CadrePeer.AuthorizedInsert` / `AuthorizedUpdate` constraints ALSO carry a
 * crypto `verify(digest(...))` branch (covered by the real-crypto replication specs), but
 * the voucher-binding portion — "the stored (VouchAuthority, VouchSig) MUST equal the
 * insert context pair" and "the voucher is immutable on self-update" — is pure equality,
 * no crypto. This spec applies a MINIMAL schema carrying only those predicates and
 * exercises the truth table directly, exactly as `control-member-key-constraint.spec.ts`
 * does for `MemberKeyClosedOnly`. The `control-schema-drift` guard separately pins that
 * this predicate text is what the real table carries.
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
          VouchAuthority text null,
          VouchSig text null,
          constraint VoucherBind check on insert (
            new.VouchAuthority = context.AuthorityKey and new.VouchSig = context.Signature
          ),
          constraint Immutable check on update (
            new.StampId = old.StampId and new.VouchAuthority = old.VouchAuthority and new.VouchSig = old.VouchSig
          )
        ) with context (AuthorityKey text null, Signature text null);
      }
      apply schema Probe;
    `);
    return db;
  }

  async function insert(
    db: Database,
    peerId: string,
    stampId: string,
    ctxAuthority: string | null,
    ctxSig: string | null,
    vouchAuthority: string | null,
    vouchSig: string | null,
  ): Promise<void> {
    await db.exec(
      `insert into Probe.CadrePeer (PeerId, StampId, VouchAuthority, VouchSig)
         with context AuthorityKey = ?, Signature = ?
         values (?, ?, ?, ?)`,
      [ctxAuthority, ctxSig, peerId, stampId, vouchAuthority, vouchSig],
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
    const row = await db.get(`select VouchAuthority, VouchSig from Probe.CadrePeer where PeerId = 'p1'`);
    expect(row?.VouchAuthority).toBe('AUTH');
    expect(row?.VouchSig).toBe('SIG');
  });

  it('rejects an insert whose stored VouchAuthority differs from the signing authority', async () => {
    const db = await freshDb();
    // Writer names a DIFFERENT authority than the one whose signature it presents.
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
        `update Probe.CadrePeer with context AuthorityKey = null, Signature = null
           set VouchAuthority = 'HIJACK' where PeerId = 'p1'`,
      ),
    ).rejects.toThrow();
    const row = await db.get(`select VouchAuthority from Probe.CadrePeer where PeerId = 'p1'`);
    expect(row?.VouchAuthority).toBe('AUTH');
  });

  it('rejects a self-update that tries to rotate the StampId', async () => {
    const db = await freshDb();
    await insert(db, 'p1', 'stamp-1', 'AUTH', 'SIG', 'AUTH', 'SIG');
    await expect(
      db.exec(
        `update Probe.CadrePeer with context AuthorityKey = null, Signature = null
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
      `update Probe.CadrePeer with context AuthorityKey = null, Signature = null
         set VouchAuthority = VouchAuthority where PeerId = 'p1'`,
    );
    expect(await count(db)).toBe(1);
  });
});
