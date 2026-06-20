import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  bootstrapFounderMembership,
  issueInvite,
  consumeInvite,
  addMemberByAuthority,
  signStrandPayload,
} from '../src/strand-membership-writer.js';
import { canonicalDatetime } from '../src/canonical-datetime.js';
import {
  StrandMemberRegistry,
  StrandMemberVerifier,
  memberRegistrationPayload,
} from '../src/strand-member-registry.js';
import { EnrollmentService } from '../src/enrollment.js';
import type { AuthorityKeyPair } from '../src/authority-key.js';
import type { SAppConfig, MemberRegistration } from '../src/types.js';

/**
 * Component coverage for the per-strand invite -> join handshake (issuance,
 * atomic consumption, authority-admit) and the strand-DB-backed EnrollmentService
 * backing. Every test runs against a REAL closed strand DB in bootstrap mode
 * (libp2p node + MemoryRawStorage + the optimystic local transactor) via
 * `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (so it is already Member #1 + the sole
 * Authority), which forces every admit below past the `count <= 1` bootstrap
 * branch into the genuine signature-verifying branches of `Member.Authorized`.
 */

function makeSAppConfig(overrides: Partial<SAppConfig> = {}): SAppConfig {
  return {
    id: 'sapp-author-pubkey',
    version: '1.2.3',
    schema: 'table Note (Id integer primary key, Body text not null)',
    signature: 'sapp-signature',
    ...overrides,
  };
}

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): AuthorityKeyPair {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKeyB64, publicKeyB64 };
}

async function tableCount(db: Database, table: 'Header' | 'Invite' | 'ConsumedInvite' | 'Member' | 'Authority'): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

interface Strand {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Authority. */
  founder: AuthorityKeyPair;
  shutdown: () => Promise<void>;
}

const opened: Strand[] = [];

/** Open a strand DB in bootstrap mode and run the founder bootstrap for the type. */
async function openStrand(type: 'o' | 'c'): Promise<Strand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const founder = strandMemberKeyPair(await generateStrandMemberKey());
  await bootstrapFounderMembership(db, {
    strandId,
    type,
    sApp: makeSAppConfig(),
    founderKeyPair: type === 'c' ? founder : undefined,
  });
  const strand: Strand = {
    db,
    strandId,
    founder,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  opened.push(strand);
  return strand;
}

afterEach(async () => {
  while (opened.length > 0) {
    const strand = opened.pop()!;
    await strand.shutdown();
  }
});

// ── Phase 1: invite issuance ─────────────────────────────────────────────────

describe('issueInvite', () => {
  it('an authority issues a single Invite row whose Key is the returned invite public key', async () => {
    const { db, founder } = await openStrand('c');

    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });

    expect(await tableCount(db, 'Invite')).toBe(1);
    const row = await db.get('select Key, Expiration from Strand.Invite');
    expect(row?.Key).toBe(inviteKey);
    expect(row?.Expiration).toBeNull();

    // The returned private seed's public key is exactly the stored Invite.Key.
    expect(getPublicKey(invitePrivateKey, 'ed25519', 'base64url', 'base64url')).toBe(inviteKey);
  }, 30_000);

  it('rejects issuance signed by a non-authority key (no matching Authority row)', async () => {
    const { db } = await openStrand('c');
    const notAnAuthority = freshKeyPair();

    await expect(issueInvite(db, { authorityKeyPair: notAnAuthority })).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);

  it('rejects an Invite whose InviteSignature is over a different payload (invite-key proof)', async () => {
    const { db, founder } = await openStrand('c');
    const invite = freshKeyPair();
    const inviteKey = invite.publicKeyB64;

    // Authority signs the real payload, but the invite signature is over junk —
    // so verify(..., new.Key, ...) (the issuer-holds-the-invite-key proof) fails.
    const payload = `${inviteKey}|`;
    const authoritySignature = signStrandPayload(payload, founder.privateKeyB64);
    const badInviteSignature = signStrandPayload('a-different-payload', invite.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.Invite (Key, Expiration)
           with context AuthorityKey = ?, AuthoritySignature = ?, InviteSignature = ?
           values (?, null)`,
        [founder.publicKeyB64, authoritySignature, badInviteSignature, inviteKey],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);

  it('rejects issuance on an open strand (Invite is OnlyClosed)', async () => {
    const { db } = await openStrand('o');

    // Open strands have no founding Authority; the insert is rejected by OnlyClosed
    // (and InviteValid) regardless of the keypair used.
    await expect(issueInvite(db, { authorityKeyPair: freshKeyPair() })).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);

  it('issues a set-expiration invite using the canonical datetime (round-trips through the engine)', async () => {
    const { db, founder } = await openStrand('c');
    const expiration = Date.UTC(2031, 2, 4, 12, 34, 56); // 2031-03-04T12:34:56Z

    const { inviteKey } = await issueInvite(db, { authorityKeyPair: founder, expiration });

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
    const authoritySignature = signStrandPayload(signedPayload, founder.privateKeyB64);
    const inviteSignature = signStrandPayload(signedPayload, invite.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.Invite (Key, Expiration)
           with context AuthorityKey = ?, AuthoritySignature = ?, InviteSignature = ?
           values (?, ?)`,
        [founder.publicKeyB64, authoritySignature, inviteSignature, invite.publicKeyB64, canonical],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Invite')).toBe(0);
  }, 30_000);
});

// ── Phase 2: invite consumption (atomic) + authority admit ───────────────────

describe('consumeInvite', () => {
  it('admits a second Member with a matching ConsumedInvite (both rows commit together)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });
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
    const { inviteKey } = await issueInvite(db, { authorityKeyPair: founder });
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
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder, expiration: base });
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
      authorityKeyPair: founder,
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
      authorityKeyPair: founder,
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
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder, expiration: base });
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
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });
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

  // KNOWN PLATFORM GAP — single-use is NOT yet enforced for ConsumedInvite.
  //
  // The schema makes `ConsumedInvite.InviteKey` the primary key so a given invite
  // can be consumed at most once. But the optimystic local (bootstrap-mode) vtab
  // transactor does not enforce primary-key uniqueness on INSERT — its insert path
  // (`optimystic-module.ts` `case 'insert'`) stages `[insertKey, encodedRow]`,
  // which silently OVERWRITES any existing row at that key instead of rejecting.
  // It is also classified as an 'insert', so the `InsertOnly check on update` guard
  // never fires. Net effect: a second consume of the same invite succeeds, the
  // `ConsumedInvite` row is overwritten (InviteKey -> new MemberKey), and a second
  // Member is admitted — a replay. This is a platform-layer gap (the writer code
  // here issues a correct, ordinary insert), sibling to the now-fixed
  // optimystic-deferred-constraint-rejection bug, filed as
  // `optimystic-insert-pk-uniqueness-not-enforced` (backlog).
  //
  // This test pins the ACTUAL behavior so it (a) still exercises the second
  // consume's write path and (b) fails loudly — prompting these assertions to flip
  // to the intended `rejects.toThrow()` + unchanged-counts — the moment the
  // platform starts enforcing PK uniqueness on insert.
  it('KNOWN GAP: a double consume currently overwrites instead of rejecting (PK uniqueness not enforced)', async () => {
    const { db, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });
    const memberB = freshKeyPair();
    const memberC = freshKeyPair();

    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: memberB.publicKeyB64 });
    expect(await tableCount(db, 'Member')).toBe(2);

    // Intended behavior: this would reject (single-use). Current behavior: it
    // resolves, overwriting the ConsumedInvite row and admitting a second member.
    await expect(
      consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: memberC.publicKeyB64 }),
    ).resolves.toBeUndefined();

    expect(await tableCount(db, 'ConsumedInvite')).toBe(1); // overwritten, not appended
    expect(await tableCount(db, 'Member')).toBe(3); // founder + B + C (replay admitted C)
    const ci = await db.get('select MemberKey from Strand.ConsumedInvite');
    expect(ci?.MemberKey).toBe(memberC.publicKeyB64); // row now points at the replayer
  }, 30_000);
});

describe('addMemberByAuthority', () => {
  it('admits a second member by authority signature (non-bootstrap branch, count > 1)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();

    await addMemberByAuthority(db, { authorityKeyPair: founder, memberKey: member.publicKeyB64 });

    expect(await tableCount(db, 'Member')).toBe(2);
    const exists = await db.get('select Key from Strand.Member where Key = ?', [member.publicKeyB64]);
    expect(exists?.Key).toBe(member.publicKeyB64);
  }, 30_000);

  it('rejects an authority-admit signed by a non-authority key', async () => {
    const { db } = await openStrand('c');
    const notAnAuthority = freshKeyPair();
    const member = freshKeyPair();

    await expect(
      addMemberByAuthority(db, { authorityKeyPair: notAnAuthority, memberKey: member.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);
});

// ── StrandMemberVerifier.isAuthorizedToJoin expiry parity ────────────────────

describe('StrandMemberVerifier.isAuthorizedToJoin expiry filtering', () => {
  it('returns false when the only outstanding invite is already expired', async () => {
    const { db, strandId, founder } = await openStrand('c');
    // An invite whose expiry is far in the past relative to wall-clock now, so the
    // pre-flight "door is open" count must filter it out (matching NotExpired).
    await issueInvite(db, { authorityKeyPair: founder, expiration: Date.UTC(2000, 0, 1) });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(false);
  }, 30_000);

  it('returns true when a future-expiry invite is outstanding', async () => {
    const { db, strandId, founder } = await openStrand('c');
    await issueInvite(db, { authorityKeyPair: founder, expiration: Date.UTC(2999, 0, 1) });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(true);
  }, 30_000);

  it('returns true when a never-expiring (null-expiry) invite is outstanding', async () => {
    const { db, strandId, founder } = await openStrand('c');
    await issueInvite(db, { authorityKeyPair: founder });
    const verifier = new StrandMemberVerifier(db);

    expect(await verifier.isAuthorizedToJoin(strandId, freshKeyPair().publicKeyB64)).toBe(true);
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
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });
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
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });
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
      memberRegistry: new StrandMemberRegistry(db, { mode: 'authority', authorityKeyPair: founder }),
    });

    const result = await service.registerMember(registration, signature);

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/not authorized/i);
    expect(await db.get('select Key from Strand.Member where Key = ?', [memberKey])).toBeUndefined();
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);

  it('rejects re-registering an already-registered member', async () => {
    const { db, strandId, founder } = await openStrand('c');
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { authorityKeyPair: founder });
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

  it('admits a member by authority signature through the registry (authority mode)', async () => {
    const { db, strandId, founder } = await openStrand('c');
    // Issue an invite so isAuthorizedToJoin's "door is open" check passes, but admit
    // via the authority branch (no ConsumedInvite written).
    await issueInvite(db, { authorityKeyPair: founder });
    const { registration, signature, memberKey } = makeRegistration(strandId);

    const service = new EnrollmentService({
      memberVerifier: new StrandMemberVerifier(db),
      memberRegistry: new StrandMemberRegistry(db, { mode: 'authority', authorityKeyPair: founder }),
    });

    const result = await service.registerMember(registration, signature);

    expect(result.success).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0); // authority admit, no invite consumed
    const row = await db.get('select Key from Strand.Member where Key = ?', [memberKey]);
    expect(row?.Key).toBe(memberKey);
  }, 30_000);
});
