import { describe, it, expect } from 'vitest';
import { Database } from '@quereus/quereus';

/**
 * Crypto-free behavioral guard for the Strand `MemberKeyClosedOnly` CHECK.
 *
 * The full behavioral coverage lives in `control-formation-invite.spec.ts`
 * (reject open+key / admit closed+key / admit open+null via `db.insertStrand`),
 * but those cases boot a real CadreNode and therefore exercise the crypto plugin —
 * which is currently regressed (`Unsupported output encoding: utf8`, tracked by
 * `cadre-core-digest-variadic-api-migration`), so they are skipped at runtime.
 *
 * The `MemberKeyClosedOnly` predicate itself uses NO crypto, so this spec applies a
 * MINIMAL schema carrying only that predicate (the real Strand row also gates on the
 * `AuthorizedInsert` `verify(digest(...))` branch, which cannot be satisfied without the
 * crypto plugin) and exercises the truth table directly in the Quereus engine. The
 * `control-schema-drift` guard separately pins that this predicate text is byte-for-byte
 * what the real `CadreControl.Strand` table carries, so the two specs together cover
 * "the real schema has this predicate" + "this predicate behaves correctly" without crypto.
 *
 * Keep the predicate below textually identical to the one in `control-schema.ts` /
 * `schemas/control.qsql`.
 */
describe('Strand MemberKeyClosedOnly predicate (crypto-free)', () => {
  async function freshDb(): Promise<Database> {
    const db = new Database();
    await db.exec(`
      declare schema Probe {
        table Strand (
          Id text primary key,
          MemberPrivateKey text null unique,
          Type text,
          constraint MemberKeyClosedOnly check (
            new.MemberPrivateKey is null or new.Type = 'c'
          )
        );
      }
      apply schema Probe;
    `);
    return db;
  }

  async function insert(db: Database, id: string, type: string | null, key: string | null): Promise<void> {
    await db.exec(
      `insert into Probe.Strand (Id, Type, MemberPrivateKey) values (?, ?, ?)`,
      [id, type, key],
    );
  }

  async function count(db: Database): Promise<number> {
    const row = await db.get(`select count(1) as c from Probe.Strand`);
    return Number(row?.c ?? 0);
  }

  it('rejects an open strand carrying a member key', async () => {
    const db = await freshDb();
    await expect(insert(db, 'a', 'o', 'memkey')).rejects.toThrow();
    expect(await count(db)).toBe(0);
  });

  it('admits a closed strand carrying a member key', async () => {
    const db = await freshDb();
    await insert(db, 'a', 'c', 'memkey');
    expect(await count(db)).toBe(1);
  });

  it('admits an open strand with no member key', async () => {
    const db = await freshDb();
    await insert(db, 'a', 'o', null);
    expect(await count(db)).toBe(1);
  });

  it('admits a closed strand with no member key (only open strands are gated)', async () => {
    const db = await freshDb();
    await insert(db, 'a', 'c', null);
    expect(await count(db)).toBe(1);
  });

  // A null Type makes `new.Type = 'c'` evaluate to NULL, so the whole predicate is
  // `false or null` = NULL. Quereus treats a NULL CHECK result as a violation (stricter
  // than the SQL-standard "pass on unknown"), so a key on a typeless strand is rejected.
  // Pin that behavior: a member key always requires an explicit closed strand.
  it('rejects a member key on a strand with a null Type', async () => {
    const db = await freshDb();
    await expect(insert(db, 'a', null, 'memkey')).rejects.toThrow();
    expect(await count(db)).toBe(0);
  });
});
