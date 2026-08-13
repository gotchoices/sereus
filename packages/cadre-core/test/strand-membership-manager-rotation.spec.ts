import { describe, it, expect } from 'vitest';
import type { Database } from '@quereus/quereus';
import {
  addMemberByManager,
  revokeMember,
  registerMemberPeer,
  removeMemberPeer,
  addManager,
  admitManager,
  removeManager,
  signStrandApproval,
  generateStrandStampId,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import {
  freshKeyPair,
  tableCount,
  openStrand,
  openRawStrand,
  insertHeader,
  rawInsertMember,
  inTransaction,
} from './strand-spec-helpers.js';

/**
 * Component coverage for `Manager` rotation: an existing manager promotes/removes
 * admins, admits-and-promotes a key that is not in the strand yet, or resigns
 * itself. Every test runs against a REAL closed strand DB on the local
 * transactor (libp2p node + MemoryRawStorage, no peers consulted) via
 * `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (Member #1 + the sole founding Manager), so every
 * later rotation runs past `Manager.Authorized`'s bootstrap branch — which is gated to
 * INSERTs in the founding state — and genuinely exercises signature verification.
 */

/** Raw founding `Manager` insert: all-null context, generation 0 — what the bootstrap writer emits. */
async function rawInsertFoundingManager(db: Database, memberKey: string): Promise<void> {
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation, StampId)
       with context ManagerKey = null, Signature = null
       values (?, 0, ?)`,
    [memberKey, generateStrandStampId()],
  );
}

/** The live StampId of one Manager row, via unfiltered scan + JS filter (the writer's scan-not-seek idiom). */
async function managerStamp(db: Database, key: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, StampId from Strand.Manager')) {
    if (row.MemberKey === key) return row.StampId as string;
  }
  throw new Error(`no Manager row for ${key}`);
}

/**
 * File the `Strand.Revocation` tombstone retiring `stampId`, signed by `retiree`.
 * Raw deletes that pin `/Authorized/` pair with one of these in the same
 * transaction — otherwise `RevocationRecorded` fires too and the reported
 * constraint becomes engine evaluation order. A retiree that is not a committed
 * member fails `Revocation.Authorized`, which shares the `Authorized` name, so
 * an attacker-signed tombstone keeps that pin truthful either way.
 */
async function fileTombstone(
  db: Database,
  tableName: 'Member' | 'Manager' | 'MemberPeer',
  stampId: string,
  retiree: Ed25519KeyPair,
): Promise<void> {
  const signature = signStrandApproval(['Strand.Revocation', 'retire', tableName, stampId], retiree.privateKeyB64);
  await db.exec(
    `insert into Strand.Revocation (TableName, StampId)
       with context MemberKey = ?, Signature = ?
       values (?, ?)`,
    [retiree.publicKeyB64, signature, tableName, stampId],
  );
}

/** Add `count` extra managers (signed by the founder) and return their keypairs. */
async function addExtraManagers(db: Database, founder: Ed25519KeyPair, count: number): Promise<Ed25519KeyPair[]> {
  const extras: Ed25519KeyPair[] = [];
  for (let i = 0; i < count; i++) {
    const kp = freshKeyPair();
    // admitManager seats the Member row and the Manager row in ONE transaction — the
    // real flow, since managers ARE members (Manager.MemberExists), and removeManager
    // files a Revocation tombstone signed by the acting manager which
    // Revocation.Authorized verifies against committed.Member.
    await admitManager(db, { byManagerKeyPair: founder, newManagerKey: kp.publicKeyB64 });
    extras.push(kp);
  }
  return extras;
}

/**
 * Seat plain `Member` rows for `keys`, signed by the founder — the prerequisite
 * `Manager.MemberExists` imposes on every promotion. Used where the promotion itself
 * is the subject under test, so the admission stays visibly separate from it (and,
 * in the negative tests, so `Manager.Authorized` remains the constraint that rejects
 * rather than `MemberExists` firing first and hollowing out the pin).
 */
async function seatMembers(db: Database, founder: Ed25519KeyPair, ...keys: Ed25519KeyPair[]): Promise<void> {
  for (const kp of keys) {
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: kp.publicKeyB64 });
  }
}

/**
 * Raw generation-carrying `Manager` insert: `by` signs the add-tagged promotion
 * digest over `(key, generation, freshly-minted StampId)` — generation as a NUMBER,
 * matching the type-tagged digest framing — and binds itself as `context.ManagerKey`.
 * Unlike `addManager` (which derives the generation from its own row), the generation
 * is caller-chosen — exactly what an attacker controls, and what the accepted
 * non-successor case needs.
 */
async function insertManagerRow(db: Database, by: Ed25519KeyPair, key: string, generation: number): Promise<void> {
  const stampId = generateStrandStampId();
  const signature = signStrandApproval(['Strand.Manager', 'add', key, generation, stampId], by.privateKeyB64);
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation, StampId)
       with context ManagerKey = ?, Signature = ?
       values (?, ?, ?)`,
    [by.publicKeyB64, signature, key, generation, stampId],
  );
}

/** The `Generation` of one manager row, or undefined when the key holds no row. */
async function managerGeneration(db: Database, key: string): Promise<number | undefined> {
  const row = await db.get('select Generation from Strand.Manager where MemberKey = ?', [key]);
  return row == null ? undefined : Number(row.Generation);
}

describe('addManager', () => {
  it('an existing manager promotes a second manager (non-bootstrap signature branch)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();
    // The admission is a separate, visible step: addManager promotes an EXISTING
    // member, and Manager.MemberExists rejects it otherwise.
    await seatMembers(db, founder, second);

    await addManager(db, { byManagerKeyPair: founder, newManagerKey: second.publicKeyB64 });

    // At commit the count is 2, so the `count(Manager) <= 1` bootstrap branch is
    // false — this genuinely passed via the existing-manager signature branch.
    expect(await tableCount(db, 'Manager')).toBe(2);
    const row = await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [second.publicKeyB64]);
    expect(row?.MemberKey).toBe(second.publicKeyB64);
  }, 30_000);

  it('rejects promoting a key that holds no Member row (Manager.MemberExists)', async () => {
    const { db, founder } = await openStrand('c');
    const stranger = freshKeyPair();

    // Deliberately NO seatMembers: the promotion itself is well-formed — the founder is
    // a committed manager at generation 0 signing the add-tagged digest for generation
    // 1 — so Authorized passes and MemberExists is the only constraint that can reject.
    // A manager IS a member: without the Member row this key could hold admin rights it
    // could never exercise (every removal it filed would fail Revocation.Authorized,
    // which verifies the filer against committed.Member).
    await expect(
      addManager(db, { byManagerKeyPair: founder, newManagerKey: stranger.publicKeyB64 }),
    ).rejects.toThrow(/MemberExists/);

    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [stranger.publicKeyB64])).toBeUndefined();
    expect(await tableCount(db, 'Member')).toBe(1); // and no Member row was conjured either
  }, 30_000);

  it('rejects an add whose signer is not a manager (no count<=1 shortcut once founder exists)', async () => {
    const { db, founder } = await openStrand('c');
    const notAManager = freshKeyPair();
    const target = freshKeyPair();
    // target is a real member, so MemberExists is satisfied and Authorized is the only
    // constraint left to reject — the signer simply holds no Manager row.
    await seatMembers(db, founder, target);

    await expect(
      addManager(db, { byManagerKeyPair: notAManager, newManagerKey: target.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
  }, 30_000);

  it('rejects an add whose signature is over the wrong key (signature binding)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    const someOtherKey = freshKeyPair().publicKeyB64;
    // A member, so the rejection below is the signature binding and not MemberExists.
    await seatMembers(db, founder, target);

    // A real manager (founder) signs a correctly-shaped add-tagged promotion digest,
    // but over a DIFFERENT key than the one being inserted, so the verify against
    // digest('Strand.Manager','add', new.MemberKey=target, 1, stamp) fails.
    const stampId = generateStrandStampId();
    const wrongSignature = signStrandApproval(
      ['Strand.Manager', 'add', someOtherKey, 1, stampId],
      founder.privateKeyB64,
    );

    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, wrongSignature, target.publicKeyB64, 1, stampId],
      ),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  // Self-promotion guard: the existing-manager branch of `Manager.Authorized` is a
  // deferred (subquery-bearing) CHECK, so at commit it runs against the POST-insert
  // row set — the row being inserted is already in `Manager` and would otherwise
  // match itself. The branch's `A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)`
  // excludes that row, so a key cannot authorize its own promotion.
  it('rejects a key promoting ITSELF (the row being inserted is not its own authorizer)', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();
    // A real MEMBER attempting self-promotion — the strongest form of this attack, and
    // the one that reaches Authorized (a stranger would be turned away by MemberExists
    // before the `<>` guard is ever consulted).
    await seatMembers(db, founder, attacker);

    // A perfectly-formed self-authorization: the attacker signs its own key and binds
    // itself as context.ManagerKey. Only the `<>` guard stands between this and admin.
    await expect(
      addManager(db, { byManagerKeyPair: attacker, newManagerKey: attacker.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [attacker.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a manager add on an open strand (Manager is OnlyClosed)', async () => {
    const { db } = await openStrand('o');
    const target = freshKeyPair();

    // Open strands have no founding Manager and Manager is OnlyClosed; any add is
    // rejected. MemberExists cannot be satisfied either (an open strand has no Member
    // rows — Member is OnlyClosed too), so the rejection is over-determined and only
    // the fact of it is pinned.
    await expect(
      addManager(db, { byManagerKeyPair: freshKeyPair(), newManagerKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(0);
  }, 30_000);

  // The founding seat is the one Manager insert with no authorizing manager behind it,
  // so it is where a Member-less Manager row would be easiest to slip in. MemberExists
  // runs on EVERY insert, the founding one included.
  it('the founding Manager still needs its Member row first (seeding order survives)', async () => {
    // The real writer path, unchanged: bootstrapFounderMembership seats Header → Member
    // → Manager in sequential auto-commits, so MemberExists sees a COMMITTED Member row
    // by the time the Manager insert is checked.
    const bootstrapped = await openStrand('c');
    expect(await tableCount(bootstrapped.db, 'Member')).toBe(1);
    expect(await tableCount(bootstrapped.db, 'Manager')).toBe(1);

    // The reverse order, hand-seeded on a strand with no bootstrap: Header, then the
    // founding Manager with no Member row yet. Rejection is over-determined BY DESIGN —
    // MemberExists fires, and the bootstrap branch of Manager.Authorized carries its own
    // belt-and-braces Member-exists test — so only the fact of a CHECK rejection is
    // pinned, not a single constraint name.
    const { db } = await openRawStrand();
    await insertHeader(db, 'c');
    const founder = freshKeyPair();

    await expect(rawInsertFoundingManager(db, founder.publicKeyB64)).rejects.toThrow(/CHECK constraint failed/);
    expect(await tableCount(db, 'Manager')).toBe(0);

    // Positive control: the SAME founding insert, only now the Member row precedes it —
    // proving the rejection above was the ordering and nothing else about the seed.
    await rawInsertMember(db, founder.publicKeyB64);
    await rawInsertFoundingManager(db, founder.publicKeyB64);
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);
});

describe('admitManager', () => {
  it('seats Member + Manager in ONE transaction, and the new manager can then act', async () => {
    const { db, founder } = await openStrand('c');
    const admin = freshKeyPair();
    const victim = freshKeyPair();
    const peerHolder = freshKeyPair();
    await seatMembers(db, founder, victim, peerHolder);
    await registerMemberPeer(db, { memberKeyPair: peerHolder, peerId: 'peer-held' });

    // Both halves land at ONE commit: Manager.MemberExists reads the LIVE Member table,
    // so the sibling Member insert satisfies it without anything being waived (that
    // insert is itself authorized by the founder at the same commit).
    await admitManager(db, { byManagerKeyPair: founder, newManagerKey: admin.publicKeyB64 });
    expect(await db.get('select Key from Strand.Member where Key = ?', [admin.publicKeyB64])).toBeTruthy();
    expect(await managerGeneration(db, admin.publicKeyB64)).toBe(1);

    // The payoff, and the reason the invariant exists: in LATER transactions the new
    // manager does the three things a Member-less manager could NOT. Each files a
    // Revocation tombstone, and Revocation.Authorized verifies the filer against
    // committed.Member — the exact read a Manager row with no Member row fails.
    await revokeMember(db, { managerKeyPair: admin, memberKey: victim.publicKeyB64 });
    await removeMemberPeer(db, { managerKeyPair: admin, memberKey: peerHolder.publicKeyB64, peerId: 'peer-held' });
    await removeManager(db, { byManagerKeyPair: admin, targetManagerKey: admin.publicKeyB64 });

    expect(await db.get('select Key from Strand.Member where Key = ?', [victim.publicKeyB64])).toBeUndefined();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
    expect(await tableCount(db, 'Manager')).toBe(1); // the founder alone, after the resignation
    // Resigning dropped only the Manager row — admin is still an ordinary member.
    expect(await db.get('select Key from Strand.Member where Key = ?', [admin.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('a rejected admission leaves NEITHER row (all-or-nothing)', async () => {
    const { db } = await openStrand('c');
    const stranger = freshKeyPair(); // holds no Manager row
    const newcomer = freshKeyPair();

    // BOTH halves are unauthorized, so the rejection is over-determined and the pin does
    // not identify which fired: Member.Authorized has its bootstrap branch off
    // (committed.Member is 1, not 0), no ConsumedInvite for the invite branch, and no
    // committed.Manager for the stranger in the direct-admit branch — while
    // Manager.Authorized finds no Manager row for the stranger either (the promotion half
    // alone is covered by 'rejects an add whose signer is not a manager' above). Both
    // constraints are named `Authorized`, and the engine reports the bare name, so
    // /Authorized/ holds whichever runs first. What this test pins is the ATOMICITY below.
    // MemberExists is NOT among the rejectors — the sibling Member insert is live in the
    // transaction, so it passes.
    await expect(
      admitManager(db, { byManagerKeyPair: stranger, newManagerKey: newcomer.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Member')).toBe(1);  // the founder — no orphan Member row
    expect(await tableCount(db, 'Manager')).toBe(1); // the founder — and no Manager row
    expect(await db.get('select Key from Strand.Member where Key = ?', [newcomer.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [newcomer.publicKeyB64])).toBeUndefined();
  }, 30_000);

  it('is not insert-if-absent: a repeat call for an existing member seats no Manager row', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await seatMembers(db, founder, member);

    // admitManager always inserts the Member row (matching addMemberByManager's unguarded
    // shape), so an already-seated key collides on the Member primary key. The promotion
    // half would have been perfectly legal on its own — the key IS a member — which is
    // what makes the rollback the load-bearing part: a caller reaching for admitManager
    // where addManager was wanted gets an error, never a half-applied promotion.
    await expect(
      admitManager(db, { byManagerKeyPair: founder, newManagerKey: member.publicKeyB64 }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);

    expect(await tableCount(db, 'Member')).toBe(2);  // the founder and the member, unchanged
    expect(await tableCount(db, 'Manager')).toBe(1); // the founder alone — no promotion leaked
    expect(await managerGeneration(db, member.publicKeyB64)).toBeUndefined();

    // And the operation the caller actually wanted still works, on the untouched rows.
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: member.publicKeyB64 });
    expect(await managerGeneration(db, member.publicKeyB64)).toBe(1);
  }, 30_000);

  it('cannot be chained: a manager admitted in THIS transaction cannot admit the next', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();

    // A's Manager row is seated in this very transaction, so it is absent from
    // committed.Manager — which is what Member.Authorized's direct-admit branch reads.
    // A therefore cannot authorize B's ADMISSION. The PROMOTION half would have been
    // fine on its own: a same-transaction promotion chain rooted at a pre-existing
    // manager is accepted (see 'accepts a same-transaction chain rooted at a
    // pre-existing manager' below) — it is the Member half that needs a committed
    // authorizer.
    await expect(inTransaction(db, async () => {
      await admitManager(db, { byManagerKeyPair: founder, newManagerKey: a.publicKeyB64 });
      await admitManager(db, { byManagerKeyPair: a, newManagerKey: b.publicKeyB64 });
    })).rejects.toThrow(/Authorized/);

    // Everything rolled back — not even A, whose own admission was well-formed.
    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);
});

describe('removeManager', () => {
  // NOTE on what these prove: the writer builds a correctly-signed delete (the
  // existing-manager branch for admin removal, the former-manager self branch
  // for self-resignation — see removeManager's doc). The optimystic bootstrap-mode
  // transactor now evaluates deferred (subquery-bearing) CHECK constraints on DELETE
  // — `Manager.Authorized` is one — so these acceptance tests genuinely exercise
  // the signature branches (the founder/self signatures are valid for those
  // branches), and an unauthorized delete is rejected (see the test below). The
  // platform gap they previously documented is tracked by
  // `optimystic-deferred-check-not-enforced-on-delete` (backlog), now fixed.
  it('a manager removes a DIFFERENT manager and leaves the other managers intact', async () => {
    const { db, founder } = await openStrand('c');
    // 3 managers total so removing one leaves 2 (≥ 2 after delete keeps the
    // `count(Manager) <= 1` bootstrap branch false, so this genuinely takes the
    // existing-manager signature branch).
    const [a2, a3] = await addExtraManagers(db, founder, 2);
    expect(await tableCount(db, 'Manager')).toBe(3);

    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: a3.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a3.publicKeyB64])).toBeUndefined();
    // The other managers are untouched (only the targeted row was removed).
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('a manager resigns itself (self-targeted removal removes only its own row)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    expect(await tableCount(db, 'Manager')).toBe(3);

    await removeManager(db, { byManagerKeyPair: a2, targetManagerKey: a2.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // Delete-side constraint enforcement: an unauthorized removal is rejected.
  //
  // `Manager.Authorized` (a deferred, subquery-bearing CHECK) rejects a removal
  // whose signer is neither an existing manager nor the target itself. The
  // optimystic bootstrap-mode vtab transactor now evaluates deferred CHECK
  // constraints on DELETE (not only on INSERT), so a non-manager can no longer
  // remove a Manager row. This pins the intended secure behavior; it previously
  // documented the platform gap tracked by
  // `optimystic-deferred-check-not-enforced-on-delete` (backlog), now fixed.
  it('a non-manager removal is rejected (deferred CHECK enforced on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    const notAManager = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(3);

    // No accepting branch matches (post-delete count 2 keeps the bootstrap branch
    // false), so the deferred Authorized CHECK rejects the delete at commit.
    await expect(
      removeManager(db, { byManagerKeyPair: notAManager, targetManagerKey: a2.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(3); // unchanged — nothing was removed
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a removal whose signature is over the wrong key (signature binding on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    const someOtherKey = freshKeyPair().publicKeyB64;
    expect(await tableCount(db, 'Manager')).toBe(3);

    // A real manager (founder) signs the remove-tagged digest, but over a DIFFERENT
    // key than the row being deleted (the stamp is the row's live one), so the verify
    // against digest('Strand.Manager','remove', old.MemberKey=a2, old.StampId) fails —
    // the delete analog of the addManager signature-binding test. No tombstone rides
    // this delete, so RevocationRecorded also rejects; the pin stays loose.
    const wrongSignature = signStrandApproval(
      ['Strand.Manager', 'remove', someOtherKey, await managerStamp(db, a2.publicKeyB64)],
      founder.privateKeyB64,
    );

    await expect(
      db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, wrongSignature, a2.publicKeyB64],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // ── The min-one-manager floor + the no-bootstrap-bypass pin ─────────────────
  //
  // `Manager.MinOneManager` (`check on delete`, deferred → sees the POST-delete
  // count) keeps a closed strand from ever reaching zero managers: every admit path
  // (Invite, addMemberByManager, addManager) needs a Manager row, so an admin-less
  // strand is frozen forever. And `Manager.Authorized`'s bootstrap branch is gated to
  // INSERTs (`old.MemberKey is null`), so a delete that drops the count toward the
  // floor no longer waives the signature check.

  it('rejects the SOLE manager resigning (min-one-manager floor)', async () => {
    const { db, founder } = await openStrand('c');
    expect(await tableCount(db, 'Manager')).toBe(1);

    // A valid self-resignation signature — rejected purely because it would empty
    // the Manager table.
    // Authorized passes (the self-resignation branch is satisfied), so MinOneManager
    // is the ONLY constraint that can reject — pinning the name proves the floor fired.
    await expect(
      removeManager(db, { byManagerKeyPair: founder, targetManagerKey: founder.publicKeyB64 }),
    ).rejects.toThrow(/MinOneManager/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a stranger removing the last manager (no unsigned drop to zero)', async () => {
    const { db, founder } = await openStrand('c');
    const stranger = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(1);

    // Both MinOneManager (post-delete count 0) and Authorized (stranger signature)
    // reject this; which one reports first is engine evaluation order, so only the
    // fact of a CHECK rejection is pinned.
    await expect(
      removeManager(db, { byManagerKeyPair: stranger, targetManagerKey: founder.publicKeyB64 }),
    ).rejects.toThrow(/CHECK constraint failed/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('still requires a valid signature for the SECOND-TO-LAST removal (bootstrap branch is insert-only)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 1);
    const stranger = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(2);

    // Post-delete count would be 1 — the old, ungated `count(Manager) <= 1` branch
    // accepted exactly this. Now it must fail on the signature.
    // MinOneManager is satisfied (1 would remain), so Authorized is the only rejector.
    await expect(
      removeManager(db, { byManagerKeyPair: stranger, targetManagerKey: a2.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);

    // The same removal, properly authorized by the OTHER manager, succeeds — proving
    // the rejection above was the signature, not the floor (1 manager still remains).
    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: a2.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects any UPDATE of a Manager row (NoUpdate — a resignation signature is not a hand-off)', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();

    // The strongest context an attacker could present: a genuine founder-signed
    // resign-tagged digest over the founder's OWN key and live stamp (i.e. a captured
    // self-resignation proof). The former-manager branch verifies only against the
    // old image, so without NoUpdate this would re-point the sole Manager row at an
    // attacker-chosen key.
    const founderSelfSignature = signStrandApproval(
      ['Strand.Manager', 'resign', founder.publicKeyB64, await managerStamp(db, founder.publicKeyB64)],
      founder.privateKeyB64,
    );

    await expect(
      db.exec(
        `update Strand.Manager
           with context ManagerKey = ?, Signature = ?
           set MemberKey = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, founderSelfSignature, attacker.publicKeyB64, founder.publicKeyB64],
      ),
    ).rejects.toThrow(/NoUpdate/); // not a parse error and not "updates unsupported"

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [attacker.publicKeyB64])).toBeUndefined();
  }, 30_000);

  it('rejects a same-transaction swap of the sole manager (hand-off must be add-then-resign)', async () => {
    const { db, founder } = await openStrand('c');
    // A second Member exists, so the bootstrap branch's `count(Member) <= 1` gate is
    // false — the successor cannot slip in as a "founding" manager.
    const successor = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: successor.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(1);

    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    const resignSignature = signStrandApproval(
      ['Strand.Manager', 'resign', founder.publicKeyB64, founderStamp],
      founder.privateKeyB64,
    );

    // Delete-then-insert in ONE transaction: the deferred checks see the post-image
    // (one manager: the successor), which is exactly the state the old schema's
    // ungated bootstrap branch would have waved through. The founder's tombstone
    // rides the transaction (a valid resignation would carry one), so the delete
    // side is fully satisfied and the successor's INSERT is the one rejector.
    const swap = (): Promise<void> => inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, resignSignature, founder.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', founderStamp, founder);
      // Generation 0 is the successor's best shot — the bootstrap branch demands
      // exactly 0, and no smaller generation can have an authorizer beneath it.
      await db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = null, Signature = null
           values (?, 0, ?)`,
        [successor.publicKeyB64, generateStrandStampId()],
      );
    });

    // The successor's INSERT has no other manager to authorize it (the founder's row
    // is gone in the post-image) and the bootstrap branch is gated off, so Authorized
    // rejects — not MinOneManager, which the successor row satisfies.
    await expect(swap()).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [successor.publicKeyB64])).toBeUndefined();
  }, 30_000);
});

// ── The generation ordering (same-transaction takeover is closed) ────────────
//
// `Manager.Generation` orders every manager strictly after the manager that
// appointed it, and the promotion branch of `Manager.Authorized` accepts only an
// authorizer of STRICTLY SMALLER generation. The deferred check still sees
// same-transaction sibling rows as "existing" managers — but the
// minimum-generation row of any inserted set cannot find an authorizer among its
// siblings, so that authorizer must pre-exist the transaction. These tests replay
// the measured takeover shapes (mutual pair, founder eviction, rings, equal and
// below-founder generations) against the closed schema, and pin that what is
// enforced is the ORDERING — not an exact successor value, and not a privilege.

describe('Manager.Generation ordering', () => {
  it('rejects two keys signing each other\'s promotion in one transaction', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();
    // Both are real members, so Manager.MemberExists is satisfied for both rows and the
    // generation ordering inside Authorized is the only thing that can reject. (Ordinary
    // members colluding is also the realistic shape of this attack.)
    await seatMembers(db, founder, x, y);

    // The exact measured takeover: each key binds the OTHER as its authorizer.
    // Whatever generations the attacker picks, the smaller one has no authorizer
    // beneath it — here Y (gen 3) is "authorized" by X (gen 5), so Y's row fails.
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, 5); // Y vouches for X
      await insertManagerRow(db, x, y.publicKeyB64, 3); // X vouches for Y
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects the full takeover: mutual promotion plus evicting the founder, one transaction', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();

    // The pre-fix schema COMMITTED exactly this: X and Y seat each other, then X
    // (a "manager" in the post-image) deletes the founder. The delete's own branch
    // is even satisfiable here — the rejection comes from the promotion ordering.
    // X files the founder-stamp tombstone itself so RevocationRecorded cannot report
    // first; X and Y are seated as real MEMBERS, so neither Manager.MemberExists nor
    // Revocation.Authorized (which reads committed.Member) can fire — the promotion
    // ordering inside Manager.Authorized is left as the sole rejector.
    await seatMembers(db, founder, x, y);
    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, 5);
      await insertManagerRow(db, x, y.publicKeyB64, 3);
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [
          x.publicKeyB64,
          signStrandApproval(['Strand.Manager', 'remove', founder.publicKeyB64, founderStamp], x.privateKeyB64),
          founder.publicKeyB64,
        ],
      );
      await fileTombstone(db, 'Manager', founderStamp, x);
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [x.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [y.publicKeyB64])).toBeUndefined();
  }, 30_000);

  it('rejects a three-key mutual-vouching ring in one transaction', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();
    const z = freshKeyPair();
    await seatMembers(db, founder, x, y, z); // members, so Authorized is the rejector

    // A ring's minimum-generation row (X at 1) is authorized by Z at 3 — not
    // strictly smaller, so the ring has no root and the transaction fails.
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, z, x.publicKeyB64, 1); // Z vouches for X
      await insertManagerRow(db, x, y.publicKeyB64, 2); // X vouches for Y
      await insertManagerRow(db, y, z.publicKeyB64, 3); // Y vouches for Z
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('rejects a mutual pair at EQUAL generations (the ordering is strict)', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();
    await seatMembers(db, founder, x, y); // members, so Authorized is the rejector

    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, 1);
      await insertManagerRow(db, x, y.publicKeyB64, 1);
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('rejects a mutual pair using generations BELOW the founder\'s 0 (no ducking underneath)', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();
    await seatMembers(db, founder, x, y); // members, so Authorized is the rejector

    // Negative generations do sort below the founder, but the pair still needs
    // each generation strictly below the other's — the minimum (-2) has no
    // authorizer beneath it, so going negative buys the attacker nothing.
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, -1); // Y (-2) < X (-1): satisfiable
      await insertManagerRow(db, x, y.publicKeyB64, -2); // X (-1) < Y (-2): impossible
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('rejects a stranger claiming generation 0 once the strand is bootstrapped', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();
    // A member, so MemberExists passes and Authorized is the rejector.
    await seatMembers(db, founder, attacker);

    // Generation 0 only helps in the FOUNDING state, and the bootstrap branch is now
    // off on BOTH of its count gates: count(Manager) is 2 in the post-image, and
    // count(Member) is 2 as well (the founder plus the attacker's own admission).
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = null, Signature = null
           values (?, 0, ?)`,
        [attacker.publicKeyB64, generateStrandStampId()],
      ),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('enforces the ORDERING, not an exact successor value (+5 accepted, <= rejected)', async () => {
    const { db, founder } = await openStrand('c');
    const skipAhead = freshKeyPair();
    const tooLow = freshKeyPair();
    // Both promotions target real members: the ACCEPT below needs MemberExists satisfied,
    // and the REJECT below must still be reported by Authorized.
    await seatMembers(db, founder, skipAhead, tooLow);

    // The founder (gen 0) seats a manager at gen 5 — a gap, not 0+1 — accepted:
    // only strict "authorizer below new" is enforced, never adjacency.
    await insertManagerRow(db, founder, skipAhead.publicKeyB64, 5);
    expect(await managerGeneration(db, skipAhead.publicKeyB64)).toBe(5);

    // The same founder signing a generation EQUAL to its own (0 < 0 fails; the
    // bootstrap branch is also off — the manager count is already 2).
    await expect(insertManagerRow(db, founder, tooLow.publicKeyB64, 0)).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);
  }, 30_000);

  it('binds the generation into the signed payload (a promotion cannot be replayed at another generation)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    // A member: the replay below must fail on the digest binding (Authorized), and the
    // positive control that follows must be accepted.
    await seatMembers(db, founder, target);

    // A genuine founder signature over the add-tagged digest for generation 1
    // (a NUMBER — the digest is type-tagged) and ONE minted stamp, replayed for an
    // insert at generation 2 carrying the same stamp — the digest mismatch fails
    // verify(), so a captured promotion is pinned to the generation it was issued for.
    const stampId = generateStrandStampId();
    const signatureForGen1 = signStrandApproval(
      ['Strand.Manager', 'add', target.publicKeyB64, 1, stampId],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, signatureForGen1, target.publicKeyB64, 2, stampId],
      ),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(1);

    // The same signature used at ITS OWN generation is accepted — proving the
    // rejection above was the digest binding, not anything else. The stamp is still
    // free (the rejected insert rolled back, retiring nothing), so reusing it here
    // is legitimate first use.
    await db.exec(
      `insert into Strand.Manager (MemberKey, Generation, StampId)
         with context ManagerKey = ?, Signature = ?
         values (?, ?, ?)`,
      [founder.publicKeyB64, signatureForGen1, target.publicKeyB64, 1, stampId],
    );
    expect(await managerGeneration(db, target.publicKeyB64)).toBe(1);
  }, 30_000);

  it('a promoted manager can itself promote: founder→A→B chains generations 0→1→2', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();
    await seatMembers(db, founder, a, b); // promotions need existing Member rows

    // Exercises addManager's generation LOOKUP with a non-founder authorizer:
    // A's own row (gen 1) is read back and B is seated at 2.
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: a.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: a, newManagerKey: b.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await managerGeneration(db, founder.publicKeyB64)).toBe(0);
    expect(await managerGeneration(db, a.publicKeyB64)).toBe(1);
    expect(await managerGeneration(db, b.publicKeyB64)).toBe(2);
  }, 30_000);

  it('accepts a same-transaction chain rooted at a pre-existing manager (no over-rejection)', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();
    // Members seated BEFORE the transaction, so it contains promotions only — the shape
    // under test is the chain, not the admissions.
    await seatMembers(db, founder, a, b);

    // The mirror image of the rejected shapes: batching promotions in ONE
    // transaction is legitimate as long as the batch has a root outside it. The
    // founder (gen 0) seats A at 1 and A seats B at 2, both rows landing at the
    // same commit — the deferred check resolves A as B's authorizer from the
    // post-insert row set, which is exactly what makes the attack shapes
    // tempting and must NOT be broken by the ordering guard.
    await inTransaction(db, async () => {
      await insertManagerRow(db, founder, a.publicKeyB64, 1);
      await insertManagerRow(db, a, b.publicKeyB64, 2);
    });

    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await managerGeneration(db, a.publicKeyB64)).toBe(1);
    expect(await managerGeneration(db, b.publicKeyB64)).toBe(2);
  }, 30_000);

  it('an "add X" signature cannot be replayed as "remove X" (the payloads differ)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    await seatMembers(db, founder, target);
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: target.publicKeyB64 }); // gen 1

    // The promotion approval is 'add'-tagged and carries the generation; the removal
    // approval is 'remove'-tagged over just (key, stamp). So a captured approval to
    // ADD a manager — even one re-minted over the row's LIVE stamp — does not double
    // as an approval to REMOVE it: the action tags differ. A founder tombstone rides
    // the transaction so Authorized is the one rejector.
    const targetStamp = await managerStamp(db, target.publicKeyB64);
    const addSignature = signStrandApproval(
      ['Strand.Manager', 'add', target.publicKeyB64, 1, targetStamp],
      founder.privateKeyB64,
    );
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, addSignature, target.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', targetStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [target.publicKeyB64])).toBeTruthy();

    // And the converse: a removal-shaped ('remove'-tagged, generation-less) signature
    // over a fresh stamp cannot promote the key that insert carries the same stamp.
    const other = freshKeyPair();
    await seatMembers(db, founder, other); // a member, so Authorized is the rejector below
    const freshStamp = generateStrandStampId();
    const removeShapedSignature = signStrandApproval(
      ['Strand.Manager', 'remove', other.publicKeyB64, freshStamp],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, removeShapedSignature, other.publicKeyB64, 1, freshStamp],
      ),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);
  }, 30_000);

  it('a later-generation manager may remove an earlier-generation one (generation is not privilege)', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();
    // Members first: B's removal of A files a tombstone signed by B, and
    // Revocation.Authorized verifies that signer against committed.Member.
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: a.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: b.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: a.publicKeyB64 }); // gen 1
    await addManager(db, { byManagerKeyPair: a, newManagerKey: b.publicKeyB64 });       // gen 2
    expect(await tableCount(db, 'Manager')).toBe(3);

    // B (gen 2) removes A (gen 1): the removal branch carries no generation
    // condition, so seniority grants no protection — only the floor does.
    await removeManager(db, { byManagerKeyPair: b, targetManagerKey: a.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);
});
