import { describe, it, expect } from 'vitest';
import { getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
  issueInvite,
  consumeInvite,
  cancelInvite,
  listOutstandingInvites,
  addMemberByManager,
  addManager,
  signStrandPayload,
  signStrandApproval,
} from '../src/strand-membership-writer.js';
import { canonicalDatetime } from '../src/canonical-datetime.js';
import {
  StrandMemberRegistry,
  StrandMemberVerifier,
  memberRegistrationPayload,
} from '../src/strand-member-registry.js';
import { EnrollmentService } from '../src/enrollment.js';
import { freshKeyPair, tableCount, openStrand, inTransaction } from './strand-spec-helpers.js';
import type { MemberRegistration } from '../src/types.js';

/**
 * Component coverage for the per-strand invite -> join handshake (issuance,
 * atomic consumption, manager-admit) and the strand-DB-backed EnrollmentService
 * backing. Every test runs against a REAL closed strand DB on the local
 * transactor (libp2p node + MemoryRawStorage, no peers consulted) via
 * `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (so it is already Member #1 + the sole
 * Manager), which forces every admit below past the `count <= 1` bootstrap
 * branch into the genuine signature-verifying branches of `Member.Authorized`.
 */

// ── Phase 1: invite issuance ─────────────────────────────────────────────────

describe('issueInvite', () => {
  it('a manager issues a single Invite row whose Key is the returned invite public key', async () => {
    const { db, founder } = await openStrand('c');

    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });

    expect(await tableCount(db, 'Invite')).toBe(1);
    const row = await db.get('select Key, Expiration from Strand.Invite');
    expect(row?.Key).toBe(inviteKey);
    expect(row?.Expiration).toBeNull();

    // The returned private seed's public key is exactly the stored Invite.Key.
    expect(getPublicKey(invitePrivateKey, 'ed25519', 'base64url', 'base64url')).toBe(inviteKey);
  }, 30_000);

  it('rejects issuance signed by a non-manager key (no matching Manager row)', async () => {
    const { db } = await openStrand('c');
    const notAManager = freshKeyPair();

    await expect(issueInvite(db, { managerKeyPair: notAManager })).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);

  it('rejects an Invite whose InviteSignature is over a different payload (invite-key proof)', async () => {
    const { db, founder } = await openStrand('c');
    const invite = freshKeyPair();
    const inviteKey = invite.publicKeyB64;

    // Manager signs the real payload, but the invite signature is over junk —
    // so verify(..., new.Key, ...) (the issuer-holds-the-invite-key proof) fails.
    const payload = `${inviteKey}|`;
    const managerSignature = signStrandPayload(payload, founder.privateKeyB64);
    const badInviteSignature = signStrandPayload('a-different-payload', invite.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.Invite (Key, Expiration)
           with context ManagerKey = ?, ManagerSignature = ?, InviteSignature = ?
           values (?, null)`,
        [founder.publicKeyB64, managerSignature, badInviteSignature, inviteKey],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);

  it('rejects issuance on an open strand (Invite is OnlyClosed)', async () => {
    const { db } = await openStrand('o');

    // Open strands have no founding Manager; the insert is rejected by OnlyClosed
    // (and InviteValid) regardless of the keypair used.
    await expect(issueInvite(db, { managerKeyPair: freshKeyPair() })).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);

  it('issues a set-expiration invite using the canonical datetime (round-trips through the engine)', async () => {
    const { db, founder } = await openStrand('c');
    const expiration = Date.UTC(2031, 2, 4, 12, 34, 56); // 2031-03-04T12:34:56Z

    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder, expiration });

    expect(await tableCount(db, 'Invite')).toBe(1);
    const row = await db.get('select Key, Expiration from Strand.Invite');
    expect(row?.Key).toBe(inviteKey);
    // The stored value is the engine-canonical datetime (not null).
    expect(row?.Expiration).toBe(await canonicalDatetime(db, expiration));
  }, 30_000);

  it('rejects a set-expiration invite signed over a hand-rolled ISO string (canonicalization matters)', async () => {
    const { db, founder } = await openStrand('c');
    const expirationMs = Date.UTC(2031, 2, 4, 12, 34, 56);
    const canonical = await canonicalDatetime(db, expirationMs);
    const handRolledIso = new Date(expirationMs).toISOString(); // e.g. 2031-03-04T12:34:56.000Z

    // The test is only meaningful if the two forms differ — they must, since the
    // canonical form has no milliseconds/zone suffix.
    expect(canonical).not.toBe(handRolledIso);

    const invite = freshKeyPair();
    // Sign over the WRONG (hand-rolled) segment, but store the canonical column value,
    // so the CHECK's payload (Key || '|' || <canonical>) will not match the signature.
    const signedPayload = `${invite.publicKeyB64}|${handRolledIso}`;
    const managerSignature = signStrandPayload(signedPayload, founder.privateKeyB64);
    const inviteSignature = signStrandPayload(signedPayload, invite.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.Invite (Key, Expiration)
           with context ManagerKey = ?, ManagerSignature = ?, InviteSignature = ?
           values (?, ?)`,
        [founder.publicKeyB64, managerSignature, inviteSignature, invite.publicKeyB64, canonical],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);
});

// ── Phase 2: invite consumption (atomic) + manager admit ───────────────────

describe('consumeInvite', () => {
  it('admits a second Member with a matching ConsumedInvite (both rows commit together)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const member = freshKeyPair();

    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64 });

    expect(await tableCount(db, 'Member')).toBe(2); // founder + the new member
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    const row = await db.get('select InviteKey, MemberKey from Strand.ConsumedInvite');
    expect(row?.InviteKey).toBe(inviteKey);
    expect(row?.MemberKey).toBe(member.publicKeyB64);
  }, 30_000);

  it('rejects consumption with a wrong invite private key and rolls BOTH rows back (atomic)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });
    const member = freshKeyPair();
    const wrongInvitePrivateKey = freshKeyPair().privateKeyB64;

    await expect(
      consumeInvite(db, { inviteKey, invitePrivateKey: wrongInvitePrivateKey, memberKey: member.publicKeyB64 }),
    ).rejects.toThrow();

    // The deferred ValidUsage rejection at commit rolls back the whole txn — neither
    // the Member nor the ConsumedInvite row survives.
    expect(await tableCount(db, 'Member')).toBe(1); // only the founder
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
  }, 30_000);

  it('rejects consumption when no matching Invite was issued (InviteExists)', async () => {
    const { db } = await openStrand('c');
    const phantom = freshKeyPair(); // a valid keypair, but never inserted as an Invite
    const member = freshKeyPair();

    await expect(
      consumeInvite(db, {
        inviteKey: phantom.publicKeyB64,
        invitePrivateKey: phantom.privateKeyB64,
        memberKey: member.publicKeyB64,
      }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
  }, 30_000);

  // ── Expiry enforcement (NotExpired) ───────────────────────────────────────
  //
  // nowMs pins the comparison instant so the deferred NotExpired gate is exercised
  // deterministically instead of against wall-clock drift. `base` is a fixed UTC
  // instant; one day is 86_400_000 ms.

  it('rejects consuming a past-expiry invite and rolls BOTH rows back (atomic)', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder, expiration: base });
    const member = freshKeyPair();

    // Consume one day AFTER the invite expired.
    await expect(
      consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64, nowMs: base + 86_400_000 }),
    ).rejects.toThrow();

    // The deferred NotExpired rejection at commit rolls back the whole txn — neither
    // the Member nor the ConsumedInvite row survives (mirrors the wrong-key case).
    expect(await tableCount(db, 'Member')).toBe(1); // only the founder
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
  }, 30_000);

  it('admits a member when consuming a future-expiry invite', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    const { inviteKey, invitePrivateKey } = await issueInvite(db, {
      managerKeyPair: founder,
      expiration: base + 86_400_000,
    });
    const member = freshKeyPair();

    // Consume one day BEFORE the invite expires.
    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64, nowMs: base });

    expect(await tableCount(db, 'Member')).toBe(2); // founder + the new member
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
  }, 30_000);

  it('admits a member with a same-UTC-day future expiry (canonical Now, not ISO)', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    // Expiry one HOUR after now, on the SAME calendar day. Both sides are
    // T-separated ISO (e.g. `YYYY-MM-DDTHH:MM:SS`), so the lexical `>` must
    // compare time-of-day, not just the date, to admit this still-valid invite.
    // This pins sub-day (time-of-day) granularity of the `Expiration > Now`
    // comparison, which the day-granular tests above do not exercise. (Note: a
    // one-hour gap diverges at the hour digit in the admit-correct direction, so
    // it does NOT by itself distinguish canonical Now from a raw ISO `Now` —
    // both admit here. The strand layer canonicalises Now regardless; see
    // consumeInvite's doc comment for why the control layer's raw ISO Now is
    // safe in practice.)
    const { inviteKey, invitePrivateKey } = await issueInvite(db, {
      managerKeyPair: founder,
      expiration: base + 3_600_000,
    });
    const member = freshKeyPair();

    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64, nowMs: base });

    expect(await tableCount(db, 'Member')).toBe(2); // founder + the new member
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
  }, 30_000);

  it('rejects consuming at the exact expiry instant (> is strict, expiry is exclusive)', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder, expiration: base });
    const member = freshKeyPair();

    // Now == Expiration: `Expiration > Now` is false, so the boundary is rejected
    // (matches the control layer's strict `FI.ExpiresAt > context.Now`).
    await expect(
      consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64, nowMs: base }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
  }, 30_000);

  it('still admits a null-expiry invite regardless of the Now context (regression)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const member = freshKeyPair();

    // A null Expiration passes NotExpired (I.Expiration is null) for any Now, so
    // adding the Now context never breaks the never-expires path.
    await consumeInvite(db, {
      inviteKey,
      invitePrivateKey,
      memberKey: member.publicKeyB64,
      nowMs: Date.UTC(2031, 2, 4, 12, 0, 0),
    });

    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
  }, 30_000);

  // Single-use is enforced: an invite can be consumed at most once.
  //
  // The schema makes `ConsumedInvite.InviteKey` the primary key so a given invite
  // can be consumed at most once. The optimystic local (bootstrap-mode) vtab
  // transactor now enforces primary-key uniqueness on INSERT, so a second consume of
  // the same invite is rejected (`UNIQUE constraint failed`) rather than silently
  // overwriting the `ConsumedInvite` row and admitting a replay member. This pins the
  // intended single-use behavior; it previously documented the platform gap tracked
  // by `optimystic-insert-pk-uniqueness-not-enforced`, which has since been fixed.
  it('a double consume of the same invite is rejected (single-use enforced)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const memberB = freshKeyPair();
    const memberC = freshKeyPair();

    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: memberB.publicKeyB64 });
    expect(await tableCount(db, 'Member')).toBe(2);

    // The second consume of the already-consumed invite is rejected by PK uniqueness.
    // Matched on the message so the test cannot pass for an unrelated rejection (the
    // Invite row is NOT deleted on consume, so `no matching invite` would be wrong).
    await expect(
      consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: memberC.publicKeyB64 }),
    ).rejects.toThrow(/UNIQUE constraint failed: ConsumedInvite\.InviteKey/i);

    // The first consume stands; the replay admitted no second member.
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(2); // founder + B only
    const ci = await db.get('select MemberKey from Strand.ConsumedInvite');
    expect(ci?.MemberKey).toBe(memberB.publicKeyB64); // row still points at the first consumer
  }, 30_000);
});

describe('addMemberByManager', () => {
  it('admits a second member by manager signature (non-bootstrap branch, count > 1)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();

    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });

    expect(await tableCount(db, 'Member')).toBe(2);
    const exists = await db.get('select Key from Strand.Member where Key = ?', [member.publicKeyB64]);
    expect(exists?.Key).toBe(member.publicKeyB64);
  }, 30_000);

  it('rejects a manager-admit signed by a non-manager key', async () => {
    const { db } = await openStrand('c');
    const notAManager = freshKeyPair();
    const member = freshKeyPair();

    await expect(
      addMemberByManager(db, { managerKeyPair: notAManager, memberKey: member.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);
});

// ── Phase 2b: invite cancellation (the manager's kill switch) ────────────────
//
// `Strand.CancelledInvite` is a monotone tombstone: one row per killed invitation,
// permanent (`Immutable`), manager-signed (`Authorized`), and it is what makes
// `ConsumedInvite.NotCancelled` reject the redemption. Every rejection below is
// name-pinned because on a closed strand exactly one constraint can fire —
// `OnlyClosed` passes and `Immutable` only masks update/delete.

describe('cancelInvite', () => {
  it('a manager files one CancelledInvite row keyed by the cancelled invite', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });

    await cancelInvite(db, { managerKeyPair: founder, inviteKey });

    expect(await tableCount(db, 'CancelledInvite')).toBe(1);
    const row = await db.get('select InviteKey from Strand.CancelledInvite');
    expect(row?.InviteKey).toBe(inviteKey);
    // The Invite row itself is untouched — cancellation is a tombstone, not a delete.
    expect(await tableCount(db, 'Invite')).toBe(1);
  }, 30_000);

  it('rejects consuming a cancelled invite and rolls the whole join back (NotCancelled)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const member = freshKeyPair();
    await cancelInvite(db, { managerKeyPair: founder, inviteKey });

    // NotCancelled is the ONLY constraint that can fire on this otherwise-valid
    // consume: InviteExists, ValidUsage, NotExpired (null expiry) and MemberExists
    // all pass, and Member.Authorized's invite branch is satisfied because the
    // ConsumedInvite row IS in the post-image at commit.
    await expect(
      consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64 }),
    ).rejects.toThrow(/NotCancelled/);

    // Deferred rejection at commit rolls the whole txn back — neither the Member nor
    // the ConsumedInvite row survives (mirrors the wrong-key / expired cases above).
    expect(await tableCount(db, 'Member')).toBe(1); // only the founder
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
  }, 30_000);

  it('cancelling one invite leaves a SIBLING invite redeemable', async () => {
    const { db, founder } = await openStrand('c');
    const killed = await issueInvite(db, { managerKeyPair: founder });
    const survivor = await issueInvite(db, { managerKeyPair: founder });
    const member = freshKeyPair();

    await cancelInvite(db, { managerKeyPair: founder, inviteKey: killed.inviteKey });

    // NotCancelled matches on `C.InviteKey = new.InviteKey`, so a tombstone kills exactly
    // the invitation it names. Without this, an UNKEYED `not exists (select 1 from
    // CancelledInvite)` — one dead invitation freezing the whole strand's admissions —
    // would satisfy every other test in this file: the rejection cases each have only one
    // invite, and the sibling positive cases have no tombstone at all.
    await consumeInvite(db, {
      inviteKey: survivor.inviteKey,
      invitePrivateKey: survivor.invitePrivateKey,
      memberKey: member.publicKeyB64,
    });

    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    expect(await tableCount(db, 'CancelledInvite')).toBe(1);
    // Both are spent now, each for a different reason — nothing is left to redeem.
    expect(await listOutstandingInvites(db)).toEqual([]);
  }, 30_000);

  it('rejects a cancellation signed by a non-manager key (Authorized)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });
    const notAManager = freshKeyPair();

    await expect(
      cancelInvite(db, { managerKeyPair: notAManager, inviteKey }),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'CancelledInvite')).toBe(0);
  }, 30_000);

  it('rejects a cancellation authorized by a manager seated in the SAME transaction', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });
    const m2 = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: m2.publicKeyB64 });

    // The Manager insert itself is valid (founder-signed promotion), but M2's row is
    // NOT in the pre-transaction snapshot — CancelledInvite.Authorized reads
    // committed.Manager, so M2 cannot authorize a cancellation in the transaction
    // that seats it. A plain from-Manager read would have accepted this.
    await expect(inTransaction(db, async () => {
      await addManager(db, { byManagerKeyPair: founder, newManagerKey: m2.publicKeyB64 });
      await cancelInvite(db, { managerKeyPair: m2, inviteKey });
    })).rejects.toThrow(/Authorized/);

    // The whole transaction rolled back: no tombstone, and M2 is not a manager.
    expect(await tableCount(db, 'CancelledInvite')).toBe(0);
    expect(await tableCount(db, 'Manager')).toBe(1); // the founder

    // Positive control, because the constraint-violation message carries only the bare
    // name ("CHECK constraint failed: Authorized") and `Manager` has an `Authorized`
    // check of its own: without this, a regression that made the promotion ITSELF
    // illegal would keep the rejection above green for the wrong reason. The promotion
    // alone commits, so the rejection is attributable to CancelledInvite.Authorized.
    await inTransaction(db, async () => {
      await addManager(db, { byManagerKeyPair: founder, newManagerKey: m2.publicKeyB64 });
    });
    expect(await tableCount(db, 'Manager')).toBe(2);
    // And now that M2 is a COMMITTED manager, the same cancellation succeeds.
    await cancelInvite(db, { managerKeyPair: m2, inviteKey });
    expect(await tableCount(db, 'CancelledInvite')).toBe(1);
  }, 30_000);

  it('rejects a cancel approval minted for a DIFFERENT invite key (Authorized)', async () => {
    const { db, founder } = await openStrand('c');
    const inviteA = (await issueInvite(db, { managerKeyPair: founder })).inviteKey;
    const inviteB = (await issueInvite(db, { managerKeyPair: founder })).inviteKey;

    // A genuine founder approval — but minted over invite A, presented on a
    // cancellation of invite B. The digest binds new.InviteKey, so an approval is
    // per-invite: holding one invitation's kill approval never kills another.
    // Hand-rolled because cancelInvite always signs the key it inserts.
    const signature = signStrandApproval(
      ['Strand.CancelledInvite', 'cancel', inviteA],
      founder.privateKeyB64,
    );
    await expect(db.exec(
      `insert into Strand.CancelledInvite (InviteKey)
         with context ManagerKey = ?, ManagerSignature = ?
         values (?)`,
      [founder.publicKeyB64, signature, inviteB],
    )).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'CancelledInvite')).toBe(0);
  }, 30_000);

  it('rejects updating or deleting an existing CancelledInvite row (Immutable)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });
    const other = await issueInvite(db, { managerKeyPair: founder });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey });
    expect(await tableCount(db, 'CancelledInvite')).toBe(1);

    // Cancellation is permanent: un-cancelling would restore the re-entry it closed.
    // Immutable is `check on update, delete (false)` — unconditional, so no context
    // the caller supplies changes the outcome (hence the placeholder signature).
    await expect(
      db.exec(
        `update Strand.CancelledInvite
           with context ManagerKey = ?, ManagerSignature = ?
           set InviteKey = ?
           where InviteKey = ?`,
        [founder.publicKeyB64, 'ignored', other.inviteKey, inviteKey],
      ),
    ).rejects.toThrow(/Immutable/);

    await expect(
      db.exec(
        `delete from Strand.CancelledInvite
           with context ManagerKey = ?, ManagerSignature = ?
           where InviteKey = ?`,
        [founder.publicKeyB64, 'ignored', inviteKey],
      ),
    ).rejects.toThrow(/Immutable/);

    expect(await tableCount(db, 'CancelledInvite')).toBe(1);
  }, 30_000);

  it('a second cancellation of the same invite is a quiet no-op (restart-safe)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });

    await cancelInvite(db, { managerKeyPair: founder, inviteKey });
    // Insert-if-absent: the repeat logs and returns rather than throwing on the PK.
    await cancelInvite(db, { managerKeyPair: founder, inviteKey });

    expect(await tableCount(db, 'CancelledInvite')).toBe(1);
  }, 30_000);
});

// ── Phase 2c: enumerating what is still redeemable ──────────────────────────
//
// "Outstanding" is not a column on `Strand.Invite` (the table is insert-only and
// stateless) — it is the Invite set minus consumed keys, minus cancelled keys,
// minus expired rows. `nowMs` is pinned throughout so the expiry arithmetic is
// deterministic; `base` is a fixed UTC instant and one day is 86_400_000 ms.

describe('listOutstandingInvites', () => {
  it('omits consumed, cancelled and expired invitations, keeping the live one', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    const live = await issueInvite(db, { managerKeyPair: founder });
    const consumed = await issueInvite(db, { managerKeyPair: founder });
    const cancelled = await issueInvite(db, { managerKeyPair: founder });
    const expired = await issueInvite(db, { managerKeyPair: founder, expiration: base });

    await consumeInvite(db, {
      inviteKey: consumed.inviteKey,
      invitePrivateKey: consumed.invitePrivateKey,
      memberKey: freshKeyPair().publicKeyB64,
    });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey: cancelled.inviteKey });

    // One day after `expired` died; all four Invite rows are still present.
    expect(await tableCount(db, 'Invite')).toBe(4);
    const outstanding = await listOutstandingInvites(db, base + 86_400_000);

    expect(outstanding.map((i) => i.inviteKey)).toEqual([live.inviteKey]);
    // Spelled out so a failure names which exclusion leaked.
    const keys = new Set(outstanding.map((i) => i.inviteKey));
    expect(keys.has(consumed.inviteKey)).toBe(false);
    expect(keys.has(cancelled.inviteKey)).toBe(false);
    expect(keys.has(expired.inviteKey)).toBe(false);
  }, 30_000);

  it('reports a never-expiring invite as null and a timed one as its canonical datetime', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    const never = await issueInvite(db, { managerKeyPair: founder });
    const timed = await issueInvite(db, { managerKeyPair: founder, expiration: base + 86_400_000 });

    const outstanding = await listOutstandingInvites(db, base);

    expect(outstanding).toHaveLength(2);
    const expirationByKey = new Map(outstanding.map((i) => [i.inviteKey, i.expiration]));
    expect(expirationByKey.get(never.inviteKey)).toBeNull();
    // The reported string is the engine-canonical form issueInvite stored, not a
    // hand-rolled ISO string (the two differ — see the issuance test above).
    expect(expirationByKey.get(timed.inviteKey)).toBe(await canonicalDatetime(db, base + 86_400_000));
  }, 30_000);

  it('omits an invite whose expiration equals nowMs (expiry is exclusive)', async () => {
    const { db, founder } = await openStrand('c');
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder, expiration: base });

    // `expiration > now` is strict, matching the on-engine NotExpired gate (and the
    // consume-side boundary test above): the invitation is dead AT its expiry instant.
    expect(await listOutstandingInvites(db, base)).toEqual([]);
    // Positive control one day earlier — the row is otherwise perfectly redeemable.
    expect((await listOutstandingInvites(db, base - 86_400_000)).map((i) => i.inviteKey))
      .toEqual([inviteKey]);
  }, 30_000);
});

// ── StrandMemberVerifier.isAuthorizedToJoin outstanding-invite parity ─────────

describe('StrandMemberVerifier.isAuthorizedToJoin outstanding-invite filtering', () => {
  it('returns false when the only outstanding invite is already expired', async () => {
    const { db, strandId, founder } = await openStrand('c');
    // An invite whose expiry is far in the past relative to wall-clock now, so the
    // pre-flight "door is open" count must filter it out (matching NotExpired).
    await issueInvite(db, { managerKeyPair: founder, expiration: Date.UTC(2000, 0, 1) });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(false);
  }, 30_000);

  it('returns true when a future-expiry invite is outstanding', async () => {
    const { db, strandId, founder } = await openStrand('c');
    await issueInvite(db, { managerKeyPair: founder, expiration: Date.UTC(2999, 0, 1) });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(true);
  }, 30_000);

  it('returns true when a never-expiring (null-expiry) invite is outstanding', async () => {
    const { db, strandId, founder } = await openStrand('c');
    await issueInvite(db, { managerKeyPair: founder });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(true);
  }, 30_000);

  it('returns false when the only invite has been cancelled', async () => {
    const { db, strandId, founder } = await openStrand('c');
    // A never-expiring invite, so expiry cannot be what closes the door — the
    // cancellation is. The pre-flight must not report a door NotCancelled will slam.
    const { inviteKey } = await issueInvite(db, { managerKeyPair: founder });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(false);
  }, 30_000);

  it('returns false when the only invite has already been consumed by someone else', async () => {
    const { db, strandId, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const joined = freshKeyPair();
    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: joined.publicKeyB64 });
    const verifier = new StrandMemberVerifier(db);

    // Asked about a DIFFERENT key than the consumer's: a single-use invite already
    // spent leaves nothing to redeem, and ConsumedInvite's primary key would reject
    // a second consume anyway.
    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(false);
    // The consumer itself still answers true off its own ConsumedInvite row — the
    // short-circuit ahead of the outstanding-invite scan (see isAuthorizedToJoin).
    expect(await verifier.isAuthorizedToJoin(strandId, joined.publicKeyB64)).toBe(true);
  }, 30_000);
});

// ── Phase 3: EnrollmentService strand-DB backing ─────────────────────────────

/** Build a member registration + its self-proof signature for the strand. */
function makeRegistration(strandId: string): { registration: MemberRegistration; signature: string; memberKey: string } {
  const member = freshKeyPair();
  const registration: MemberRegistration = { strandId, key: member.publicKeyB64, peerIds: [] };
  const signature = signStrandPayload(memberRegistrationPayload(registration), member.privateKeyB64);
  return { registration, signature, memberKey: member.publicKeyB64 };
}

describe('EnrollmentService backed by a strand DB', () => {
  it('registerMember writes a real Member via a valid invite (happy path)', async () => {
    const { db, strandId, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const { registration, signature, memberKey } = makeRegistration(strandId);

    const service = new EnrollmentService({
      memberVerifier: new StrandMemberVerifier(db),
      memberRegistry: new StrandMemberRegistry(db, { mode: 'invite', inviteKey, invitePrivateKey }),
    });

    const result = await service.registerMember(registration, signature);

    expect(result.success).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    const row = await db.get('select MemberKey from Strand.ConsumedInvite');
    expect(row?.MemberKey).toBe(memberKey);
  }, 30_000);

  it('rejects a registration with an invalid self-proof signature', async () => {
    const { db, strandId, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const { registration } = makeRegistration(strandId);
    const wrongSignature = signStrandPayload('not-the-registration-payload', freshKeyPair().privateKeyB64);

    const service = new EnrollmentService({
      memberVerifier: new StrandMemberVerifier(db),
      memberRegistry: new StrandMemberRegistry(db, { mode: 'invite', inviteKey, invitePrivateKey }),
    });

    const result = await service.registerMember(registration, wrongSignature);

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/signature/i);
    expect(await tableCount(db, 'Member')).toBe(1); // nothing written
  }, 30_000);

  it('rejects a registration when the strand has no invite to authorize joining', async () => {
    // No invite issued: isAuthorizedToJoin is false even though the self-proof is valid.
    const { db, strandId, founder } = await openStrand('c');
    const { registration, signature, memberKey } = makeRegistration(strandId);

    const service = new EnrollmentService({
      memberVerifier: new StrandMemberVerifier(db),
      memberRegistry: new StrandMemberRegistry(db, { mode: 'manager', managerKeyPair: founder }),
    });

    const result = await service.registerMember(registration, signature);

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/not authorized/i);
    expect(await db.get('select Key from Strand.Member where Key = ?', [memberKey])).toBeUndefined();
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);

  it('rejects re-registering an already-registered member', async () => {
    const { db, strandId, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    const { registration, signature } = makeRegistration(strandId);

    const service = new EnrollmentService({
      memberVerifier: new StrandMemberVerifier(db),
      memberRegistry: new StrandMemberRegistry(db, { mode: 'invite', inviteKey, invitePrivateKey }),
    });

    const first = await service.registerMember(registration, signature);
    expect(first.success).toBe(true);

    // Second attempt for the same member short-circuits on isMemberRegistered before
    // touching the (already-consumed) invite.
    const second = await service.registerMember(registration, signature);
    expect(second.success).toBe(false);
    expect(second.reason).toMatch(/already registered/i);
    expect(await tableCount(db, 'Member')).toBe(2);
  }, 30_000);

  it('admits a member by manager signature through the registry (manager mode)', async () => {
    const { db, strandId, founder } = await openStrand('c');
    // Issue an invite so isAuthorizedToJoin's "door is open" check passes, but admit
    // via the manager branch (no ConsumedInvite written).
    await issueInvite(db, { managerKeyPair: founder });
    const { registration, signature, memberKey } = makeRegistration(strandId);

    const service = new EnrollmentService({
      memberVerifier: new StrandMemberVerifier(db),
      memberRegistry: new StrandMemberRegistry(db, { mode: 'manager', managerKeyPair: founder }),
    });

    const result = await service.registerMember(registration, signature);

    expect(result.success).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0); // manager admit, no invite consumed
    const row = await db.get('select Key from Strand.Member where Key = ?', [memberKey]);
    expect(row?.Key).toBe(memberKey);
  }, 30_000);
});
