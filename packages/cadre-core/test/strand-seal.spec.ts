import { describe, it, expect } from 'vitest';
import type { Database } from '@quereus/quereus';
import {
  addMemberByManager,
  addManager,
  admitManager,
  cancelInvite,
  consumeInvite,
  issueInvite,
  leaveStrand,
  registerMemberPeer,
  removeMemberPeer,
  revokeMember,
  sealStrand,
  isStrandSealed,
  bootstrapFounderMembership,
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
  makeSAppConfig,
} from './strand-spec-helpers.js';

/**
 * Sealing a closed strand: the SOLE manager deliberately deletes its own
 * `Strand.Manager` row, permanently freezing admission.
 *
 * Every admission path — `issueInvite`, `cancelInvite`, `consumeInvite`,
 * `addMemberByManager`, `addManager`, `admitManager` — requires a live `Manager`
 * row, so an empty `Manager` table admits nobody ever again. That freeze is the
 * privacy guarantee the remaining members are buying: no key holds the power to
 * let in a party who would then read the strand's whole history.
 *
 * The schema distinguishes the seal from an ordinary resignation by the POST-image
 * manager count, and binds each to its own action tag:
 *
 * | Delete of a Manager row | Post-image `count(Manager)` | Signed digest                                  |
 * |-------------------------|-----------------------------|------------------------------------------------|
 * | self-resignation        | `>= 1`                      | `'Strand.Manager','resign',old.MemberKey,old.StampId` |
 * | self-seal               | `= 0`                       | `'Strand.Manager','seal',old.MemberKey,old.StampId`   |
 * | admin removal           | (structurally `>= 1`)       | `'Strand.Manager','remove',old.MemberKey,old.StampId` |
 *
 * Irreversibility is a second gate: `Manager.Authorized`'s founding branch also
 * requires that NO `Manager` stamp has ever been retired into `Strand.Revocation`,
 * and the seal files exactly such a tombstone — so a lone surviving member can
 * never re-seat itself as a generation-0 founder and start admitting again.
 *
 * Every test runs against a REAL closed strand DB on the local transactor (libp2p
 * node + MemoryRawStorage + the optimystic local transactor) via `connectToStrand`
 * — the same path `StrandDatabase` uses — so the real apply/DML/deferred-constraint
 * path is exercised, not a fake.
 *
 * PIN DISCIPLINE, as in the sibling specs: every rejection below carries a comment
 * naming the one constraint that can fire and why the others genuinely pass. Where
 * two constraints could plausibly reject, only `/CHECK constraint failed/` is
 * pinned rather than a name that would be engine evaluation order.
 *
 * NOT re-pinned here: a raw `'resign'`-tagged delete of the SOLE manager, which
 * `strand-membership-manager-rotation.spec.ts` → *rejects the SOLE manager
 * resigning* already covers at BOTH levels in one case (the writer's up-front
 * `sealStrand`-naming guard and then the raw resign-tagged delete + tombstone
 * rejecting `/Authorized/`). Duplicating it would cost another real strand boot
 * for no additional claim.
 */

// ── Live-row readers + raw-write helpers (scan-not-seek, the writer's idiom) ───

/** The live StampId of one Manager row, via unfiltered scan + JS filter. */
async function managerStamp(db: Database, key: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, StampId from Strand.Manager')) {
    if (row.MemberKey === key) return row.StampId as string;
  }
  throw new Error(`no Manager row for ${key}`);
}

/** Whether `Strand.Revocation` holds the tombstone retiring `stampId` from `tableName`. */
async function hasRevocation(
  db: Database,
  tableName: 'Member' | 'Manager' | 'MemberPeer',
  stampId: string,
): Promise<boolean> {
  for await (const row of db.eval('select TableName, StampId from Strand.Revocation')) {
    if (row.TableName === tableName && row.StampId === stampId) return true;
  }
  return false;
}

/**
 * File the `Strand.Revocation` tombstone retiring `stampId`, signed by `retiree`.
 * Raw deletes that pin `/Authorized/` pair with one of these in the same
 * transaction — otherwise `RevocationRecorded` fires too and the reported
 * constraint becomes engine evaluation order. (Duplicated per spec file today;
 * consolidating the four copies is `debt-hoist-strand-tombstone-helpers`.)
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

/**
 * Raw self-signed delete of `self`'s own Manager row under the given action tag —
 * the shape `sealStrand` and a self-resignation both emit, with the tag as the
 * caller's choice so a test can present the WRONG one. Does NOT open a
 * transaction: callers pair it with {@link fileTombstone} inside one.
 */
async function rawSelfDeleteManager(
  db: Database,
  self: Ed25519KeyPair,
  tag: 'seal' | 'resign',
  stampId: string,
): Promise<void> {
  const signature = signStrandApproval(['Strand.Manager', tag, self.publicKeyB64, stampId], self.privateKeyB64);
  await db.exec(
    `delete from Strand.Manager
       with context ManagerKey = ?, Signature = ?
       where MemberKey = ?`,
    [self.publicKeyB64, signature, self.publicKeyB64],
  );
}

/** Seat a fresh member (admitted by `founder`) and return its keypair. */
async function seatMember(db: Database, founder: Ed25519KeyPair): Promise<Ed25519KeyPair> {
  const member = freshKeyPair();
  await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
  return member;
}

// ── sealStrand: the happy path and every guard around it ──────────────────────

describe('sealStrand', () => {
  it('the sole manager seals: the Manager table empties, its stamp is retired, its Member row survives', async () => {
    const { db, founder } = await openStrand('c');
    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    expect(await tableCount(db, 'Manager')).toBe(1);

    await sealStrand(db, { managerKeyPair: founder });

    expect(await tableCount(db, 'Manager')).toBe(0);
    // The tombstone is what makes the seal permanent (the founding branch of
    // Manager.Authorized refuses to re-seat once a manager stamp is retired), so
    // its presence — not merely the empty table — is the assertion that matters.
    expect(await hasRevocation(db, 'Manager', founderStamp)).toBe(true);
    // Frozen, not bricked: the ex-manager is still a member holding the strand's data.
    expect(await db.get('select Key from Strand.Member where Key = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);

  it('throws on a closed strand that is NOT FOUNDED yet (still foundable, not frozen)', async () => {
    // Header + Member but no Manager: exactly the window bootstrapFounderMembership
    // passes through, since it commits Header, Member and Manager as three
    // sequential auto-commit statements. Built directly rather than by racing the
    // bootstrap writer, which would be timing-dependent.
    const { db } = await openRawStrand();
    await insertHeader(db, 'c');
    const founder = freshKeyPair();
    await rawInsertMember(db, founder.publicKeyB64);
    expect(await tableCount(db, 'Manager')).toBe(0);

    // Zero managers alone is NOT a seal. Returning quietly here would report a
    // freeze that never happened — and the strand really is still foundable. The
    // message pins that the two zero-manager branches are genuinely distinguished,
    // rather than one no-op covering both.
    await expect(sealStrand(db, { managerKeyPair: founder })).rejects.toThrow(/not founded/);
  }, 30_000);

  it('is a quiet no-op on an ALREADY-SEALED strand (restart safety)', async () => {
    const { db, founder } = await openStrand('c');
    await sealStrand(db, { managerKeyPair: founder });
    expect(await tableCount(db, 'Manager')).toBe(0);

    // Same zero-manager count as the case above; the retired Manager stamp is the
    // only thing separating them, and here it makes the call a no-op rather than
    // a throw.
    await expect(sealStrand(db, { managerKeyPair: founder })).resolves.toBeUndefined();
    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);

  it('throws when the caller is not the manager, leaving the Manager row alone', async () => {
    const { db, founder } = await openStrand('c');
    const stranger = freshKeyPair();

    // A writer-level identity guard: one manager exists but it is not this key, so
    // no signature this caller can produce would satisfy the seal branch anyway
    // (it requires old.MemberKey = context.ManagerKey).
    await expect(
      sealStrand(db, { managerKeyPair: stranger }),
    ).rejects.toThrow(/does not hold the sole Manager row/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('refuses while a SECOND manager exists — and so does a raw seal-tagged delete (Authorized)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();
    await admitManager(db, { byManagerKeyPair: founder, newManagerKey: second.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(2);

    // The writer's count guard, naming the operation the caller actually wants.
    await expect(
      sealStrand(db, { managerKeyPair: founder }),
    ).rejects.toThrow(/removeManager/);
    expect(await tableCount(db, 'Manager')).toBe(2);

    // And the schema is the real boundary: a hand-rolled seal-tagged delete of the
    // founder's own row leaves the second manager standing, so the POST-image count
    // is 1 and the 'seal' branch (which demands 0) cannot accept. No other branch
    // can either — 'resign' hashes a different tag, and the admin-removal branch
    // requires A.MemberKey <> old.MemberKey. The tombstone rides the transaction so
    // RevocationRecorded stays satisfied and Authorized is the sole rejector.
    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    await expect(inTransaction(db, async () => {
      await rawSelfDeleteManager(db, founder, 'seal', founderStamp);
      await fileTombstone(db, 'Manager', founderStamp, founder);
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(2);
  }, 30_000);

  it('a founder restart of a SEALED strand is a quiet no-op, while a fresh closed strand still founds', async () => {
    const { db, strandId, founder } = await openStrand('c');
    await sealStrand(db, { managerKeyPair: founder });

    // insertFounderManagerIfAbsent mirrors the schema's own Revocation gate rather
    // than driving an insert the founding branch is guaranteed to reject, so a
    // founder that simply restarts its node does not get a loud failure.
    await expect(bootstrapFounderMembership(db, {
      strandId,
      type: 'c',
      sApp: makeSAppConfig(),
      founderKeyPair: founder,
    })).resolves.toBeUndefined();
    expect(await tableCount(db, 'Manager')).toBe(0);

    // Paired with the positive case so the two together pin that the gate
    // DISCRIMINATES — a blanket skip of the founding insert would pass the
    // assertion above and fail this one.
    const fresh = await openStrand('c');
    expect(await tableCount(fresh.db, 'Manager')).toBe(1);
  }, 30_000);
});

// ── isStrandSealed: three conjuncts, each load-bearing ────────────────────────

describe('isStrandSealed', () => {
  it('is false before the seal and true after', async () => {
    const { db, founder } = await openStrand('c');
    expect(await isStrandSealed(db)).toBe(false);

    await sealStrand(db, { managerKeyPair: founder });

    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);

  it('is false on an OPEN strand, which never holds Manager rows at all', async () => {
    // Manager.OnlyClosed means an open strand's Manager table is permanently
    // empty, so a bare manager-count test would report every open strand as
    // sealed. The Header.Type conjunct is what stops that.
    const { db } = await openStrand('o');
    expect(await tableCount(db, 'Manager')).toBe(0);

    expect(await isStrandSealed(db)).toBe(false);
  }, 30_000);

  it('is false on a closed strand that is NOT FOUNDED yet', async () => {
    // The reason the predicate is three conjuncts and not two: closed + zero
    // managers is ALSO the state of a strand mid-bootstrap (Header committed,
    // Manager not) and of a replicating node that has the Header but not yet the
    // Manager rows. The retired Manager stamp is what separates "frozen forever"
    // from "still foundable".
    const { db } = await openRawStrand();
    await insertHeader(db, 'c');
    await rawInsertMember(db, freshKeyPair().publicKeyB64);
    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await tableCount(db, 'Revocation')).toBe(0);

    expect(await isStrandSealed(db)).toBe(false);
  }, 30_000);
});

// ── The schema-level seal branch, driven by raw SQL ───────────────────────────

describe('Manager.Authorized seal branch', () => {
  it('accepts TWO managers each sealing their own row in ONE transaction (joint seal)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();
    await admitManager(db, { byManagerKeyPair: founder, newManagerKey: second.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(2);

    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    const secondStamp = await managerStamp(db, second.publicKeyB64);

    // Both deletes are self-signed over the 'seal' tag and both see the SAME
    // post-image count of 0, so each satisfies the seal branch on its own terms.
    // This is a joint seal by mutual consent — deliberately allowed at the schema
    // level, and unreachable through sealStrand (whose count guard refuses to act
    // while a second manager exists). Neither manager can seal the OTHER out: the
    // seal branch requires old.MemberKey = context.ManagerKey.
    await inTransaction(db, async () => {
      await rawSelfDeleteManager(db, founder, 'seal', founderStamp);
      await fileTombstone(db, 'Manager', founderStamp, founder);
      await rawSelfDeleteManager(db, second, 'seal', secondStamp);
      await fileTombstone(db, 'Manager', secondStamp, second);
    });

    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);

  it('refuses to re-found a SEALED strand even with one member left (Authorized)', async () => {
    // openStrand('c') seats exactly one Member (the founder), so after the seal the
    // strand is already reduced to the single-member state the founding branch
    // demands — count(Member) <= 1 passes, and the ONLY unsatisfied conjunct is the
    // new "no Manager stamp has ever been retired" gate. Without that reduction the
    // member count would reject first and the test would prove nothing.
    const { db, founder } = await openStrand('c');
    await sealStrand(db, { managerKeyPair: founder });
    expect(await tableCount(db, 'Member')).toBe(1);

    // The best shot a lone survivor has: the exact founding shape — generation 0,
    // null context (no signer), its own member key, a FRESH stamp so NotRevoked
    // passes. MemberExists and OnlyClosed pass too. Authorized is the sole rejector.
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = null, Signature = null
           values (?, 0, ?)`,
        [founder.publicKeyB64, generateStrandStampId()],
      ),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);

  it('refuses a SIGNED re-founding attempt at generation 0, not just a null-context one (Authorized)', async () => {
    const { db, founder } = await openStrand('c');
    await sealStrand(db, { managerKeyPair: founder });
    expect(await tableCount(db, 'Member')).toBe(1);

    // Same founding shape as the null-context case above, but with a REAL signature
    // over the 'add' digest instead of a null context — so this rejection cannot be
    // blamed on a malformed or missing signature. The founding branch never checks a
    // signature at all (it is gated purely on old.MemberKey is null, with no verify()
    // call), so supplying one changes nothing about whether that branch matches; the
    // only other branch an old.MemberKey-null insert could satisfy is promotion,
    // which needs an EXISTING Manager row to sign as, and the table is empty. Both
    // paths dead-end on the same gate the null-context case proves: the retired
    // Manager stamp.
    const stampId = generateStrandStampId();
    const signature = signStrandApproval(
      ['Strand.Manager', 'add', founder.publicKeyB64, 0, stampId],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, 0, ?)`,
        [founder.publicKeyB64, signature, founder.publicKeyB64, stampId],
      ),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);

  it('refuses a non-zero-generation re-founding insert on a sealed strand (Authorized, promotion branch)', async () => {
    const { db, founder } = await openStrand('c');
    await sealStrand(db, { managerKeyPair: founder });
    expect(await tableCount(db, 'Member')).toBe(1);

    // Generation 1 takes the founding branch out of contention on its own terms —
    // it requires new.Generation = 0 — regardless of the seal, so this pins the
    // OTHER branch a re-founding attempt could try: promotion. Promotion needs an
    // EXISTING Manager row, signed by its own holder, naming a strictly lower
    // generation than the new row — and the table is empty, so no such row can ever
    // exist on a sealed strand. A real signature is supplied anyway so the rejection
    // cannot be blamed on a missing one; it is the exists() subquery over an empty
    // Manager table that fails. Pinning this means a future change that let the
    // founding branch answer for a non-zero generation would surface here as an
    // unexpected ACCEPT, not silently pass.
    const stampId = generateStrandStampId();
    const signature = signStrandApproval(
      ['Strand.Manager', 'add', founder.publicKeyB64, 1, stampId],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, 1, ?)`,
        [founder.publicKeyB64, signature, founder.publicKeyB64, stampId],
      ),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);
});

// ── What a sealed strand can and cannot still do ──────────────────────────────

describe('a sealed strand', () => {
  it('rejects every admission path', async () => {
    const { db, founder } = await openStrand('c');
    // Seated BEFORE the seal so the addManager attempt below has a real member to
    // promote — otherwise Manager.MemberExists would reject first and the pin
    // would say nothing about the missing manager.
    const member = await seatMember(db, founder);
    await sealStrand(db, { managerKeyPair: founder });
    expect(await tableCount(db, 'Member')).toBe(2);

    // addManager: MemberExists, NotRevoked (fresh stamp) and OnlyClosed all pass.
    // Authorized cannot: the promotion branch finds no Manager row for the signer,
    // and the founding branch is off three ways over (generation 1, two members,
    // and the retired Manager stamp).
    await expect(
      addManager(db, { byManagerKeyPair: founder, newManagerKey: member.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    // admitManager writes a Member row AND a Manager row in one transaction, so
    // Member.Authorized and Manager.Authorized can each reject and which one is
    // reported is engine evaluation order — pin only the fact of a CHECK rejection.
    await expect(
      admitManager(db, { byManagerKeyPair: founder, newManagerKey: freshKeyPair().publicKeyB64 }),
    ).rejects.toThrow(/CHECK constraint failed/);

    // addMemberByManager: a single Member insert with a fresh stamp, so NotRevoked
    // and OnlyClosed pass and Member.Authorized is the only gate left — its
    // direct-manager branch reads committed.Manager (empty), its invite branch
    // needs a same-transaction ConsumedInvite row (none), and its bootstrap branch
    // needs an empty committed member set (there are two).
    await expect(
      addMemberByManager(db, { managerKeyPair: founder, memberKey: freshKeyPair().publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    // issueInvite: Invite.InviteValid requires a Manager row matching the signer.
    // OnlyClosed passes (the strand is still closed), so InviteValid is the sole
    // rejector — there is no way to mint a new invitation after the seal.
    await expect(
      issueInvite(db, { managerKeyPair: founder }),
    ).rejects.toThrow(/InviteValid/);

    // cancelInvite: CancelledInvite.Authorized reads committed.Manager, so the
    // ex-manager can no longer even CANCEL. That is the reason
    // ConsumedInvite.NotSealed has to exist — see the next test.
    await expect(
      cancelInvite(db, { managerKeyPair: founder, inviteKey: freshKeyPair().publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    // revokeMember: MinOneMember passes (two members, one survives) and NotAManager
    // passes (no Manager rows at all), and the tombstone's own Revocation.Authorized
    // passes (the founder is still a committed Member), so Member.Authorized on the
    // DELETE is the sole rejector — nobody can be pushed out by an ex-manager either.
    await expect(
      revokeMember(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await tableCount(db, 'Member')).toBe(2);
  }, 30_000);

  it('still lets a member manage its OWN device records and leave, but nobody clears another\'s', async () => {
    const { db, founder } = await openStrand('c');
    const other = await seatMember(db, founder);
    await registerMemberPeer(db, { memberKeyPair: other, peerId: 'other-device' });
    await sealStrand(db, { managerKeyPair: founder });

    // The docs' "what remains possible" claim, pinned rather than argued.
    // MemberPeer.Authorized's self branch verifies against the row's OWN MemberKey and
    // never reads Manager, so the seal takes nothing away from a member's control of its
    // own devices; MemberExists passes because the ex-manager is still a member.
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'founder-device' });
    expect(await tableCount(db, 'MemberPeer')).toBe(2);
    await removeMemberPeer(db, { memberKeyPair: founder, peerId: 'founder-device' });
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    // The MANAGER arm of the same writer reads committed.Manager, now empty, so the
    // post-revocation cleanup loop is gone for good — the consequence the sealing
    // paragraph of docs/strands.md now states. Nothing else can reject: the row is there
    // (so the writer reaches the DELETE) and the founder's tombstone satisfies
    // Revocation.Authorized (it is still a committed Member).
    await expect(removeMemberPeer(db, {
      managerKeyPair: founder,
      memberKey: other.publicKeyB64,
      peerId: 'other-device',
    })).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    // And a plain member may still walk out on its own: leaving is self-signed, so no
    // manager approves it, MinOneMember sees the founder surviving, and NotAManager is
    // vacuous on a strand with no Manager rows.
    await leaveStrand(db, { memberKeyPair: other });
    expect(await tableCount(db, 'Member')).toBe(1);
    // Its device record outlives it as an orphan nobody is left to clear.
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('kills a pre-seal invitation: consuming it rolls the whole join back (NotSealed)', async () => {
    const { db, founder } = await openStrand('c');
    // Never expires, never cancelled — the only thing wrong with it is the seal.
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    await sealStrand(db, { managerKeyPair: founder });
    expect(await tableCount(db, 'Member')).toBe(1);

    // Every other ConsumedInvite gate passes: InviteExists (the row is there),
    // ValidUsage (the holder signs with the real invite secret), NotExpired (null
    // expiry), NotCancelled (nobody cancelled it — nobody could), and MemberExists
    // (the sibling Member insert in the same transaction). NotSealed is the one
    // that fires.
    const joiner = freshKeyPair();
    await expect(consumeInvite(db, {
      inviteKey,
      invitePrivateKey,
      memberKey: joiner.publicKeyB64,
    })).rejects.toThrow(/NotSealed/);

    // The point of NotSealed is that blocking the ConsumedInvite insert rolls back
    // the Member insert riding with it — no orphan member row that would hold the
    // strand's read gate.
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await db.get('select Key from Strand.Member where Key = ?', [joiner.publicKeyB64])).toBeUndefined();
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
  }, 30_000);

  it('lets the sealing manager seal and leave in ONE transaction when another member remains', async () => {
    const { db, founder } = await openStrand('c');
    const other = await seatMember(db, founder);

    // Both writers join a caller-owned transaction (inStrandTransaction defers to an
    // open one), so the deferred checks fire once at the caller's commit. That is
    // what makes this legal: Member.NotAManager reads the POST-image, where the
    // Manager row is already gone, and Member.MinOneMember sees `other` surviving.
    await inTransaction(db, async () => {
      await sealStrand(db, { managerKeyPair: founder });
      await leaveStrand(db, { memberKeyPair: founder });
    });

    expect(await tableCount(db, 'Manager')).toBe(0);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await db.get('select Key from Strand.Member where Key = ?', [other.publicKeyB64])).toBeTruthy();
    expect(await isStrandSealed(db)).toBe(true);
  }, 30_000);

  it('refuses seal + leave by the sole manager who is also the sole member (MinOneMember)', async () => {
    const { db, founder } = await openStrand('c');
    expect(await tableCount(db, 'Member')).toBe(1);

    // Every authorization leg is valid — the seal is self-signed over the right tag
    // and count, the departure is self-signed over 'leave', both tombstones are
    // filed by a committed member, and NotAManager passes on the post-image. The
    // member floor is the sole rejector: a strand must always keep a member holding
    // its data, so the last one out cannot turn off the lights.
    await expect(inTransaction(db, async () => {
      await sealStrand(db, { managerKeyPair: founder });
      await leaveStrand(db, { memberKeyPair: founder });
    })).rejects.toThrow(/MinOneMember/);

    // The whole transaction rolled back, so the strand is not even sealed.
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await isStrandSealed(db)).toBe(false);
  }, 30_000);
});
