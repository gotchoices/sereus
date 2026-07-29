import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import debug from 'debug';
import {
  generatePrivateKey,
  getPublicKey,
  randomBytes,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { MissingHostStrandError, buildAuthorizationMessage } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';
import { canonicalDatetime } from '../src/canonical-datetime.js';
import { expectConstraintFailure } from './control-constraint-helpers.js';

const log = debug('sereus:cadre:test:formation-invite');

/**
 * Exercises the FormationInvite / FormationUsage consent path:
 *
 *  1. An owner-signed `FormationInvite` insert. The schema verifies the
 *     owner signature with `verify(digest(...), Sig, Key, 'ed25519')` over the
 *     row-bound field tuple. Before the Phase-1 curve fix the verify defaulted to
 *     secp256k1 and swallowed the curve-mismatch (returning false), so a real
 *     ed25519 owner signature was ALWAYS rejected — this happy-path insert
 *     therefore FAILS against the pre-fix schema and PASSES after it, pinning the
 *     bug.
 *  2. Redemption: inserting the `Strand` row + its `FormationUsage` row in ONE
 *     transaction so the mutually-circular deferred CHECKs (`Strand.AuthorizedInsert`'s
 *     consent branch ↔ `FormationUsage.StrandExists`) both see both rows at
 *     commit. The strand carries NO owner signature — it is authorised purely
 *     by the FormationUsage branch of `Strand.AuthorizedInsert`.
 *  3. Rejection of redemptions against a non-existent or expired invite.
 *
 * Boots a real CadreNode (empty bootstrap, transaction profile — no network
 * peers), the same harness the genesis / authorization-binding specs use.
 */
describe('control formation invite (consent path: FormationInvite + FormationUsage)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  // ed25519-sign the raw message bytes (no pre-hash), matching insertFormationInvite.
  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function inviteCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationInvite');
    return Number(row?.c ?? 0);
  }
  async function strandCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.Strand');
    return Number(row?.c ?? 0);
  }
  async function usageCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationUsage');
    return Number(row?.c ?? 0);
  }

  /**
   * The bare `FormationUsage` insert `ControlDatabase.execFormationUsageInsert` writes,
   * with `StrandStampId` under the caller's control so a wrong-stamp consent record can be
   * attempted. `Now` goes through the same `canonicalDatetime` transform the writer uses.
   */
  async function rawInsertFormationUsage(
    token: string,
    useNumber: number,
    strandId: string,
    strandStampId: string,
  ): Promise<void> {
    const now = await canonicalDatetime(rawDb, Date.now());
    await rawDb.exec(
      `insert into CadreControl.FormationUsage (Token, UseNumber, Disclosure, StrandId, StrandStampId)
         with context PeerId = ?, PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?
         values (?, ?, ?, ?, ?)`,
      ['peer-raw', null, now, null, null, token, useNumber, '', strandId, strandStampId],
    );
  }

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: {
        partyId: 'formation-invite-' + rand(),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    // Bootstrap founding owner (unsigned branch).
    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('happy path: an owner-signed FormationInvite inserts (pins the curve fix)', async () => {
    const before = await inviteCount();
    const token = 'invite-' + rand();

    await db.insertFormationInvite(token, 'sapp-test', ownerPublicKey, signMessage);

    expect(await inviteCount()).toBe(before + 1);
    const row = await rawDb.get(
      'select Token, sAppId from CadreControl.FormationInvite where Token = ?',
      [token],
    );
    expect(row?.Token).toBe(token);
    expect(row?.sAppId).toBe('sapp-test');
  });

  it('rejects a FormationInvite whose signature is from a non-owner key', async () => {
    const strangerKey = generatePrivateKey('ed25519', 'base64url') as string;
    const strangerPub = getPublicKey(strangerKey, 'ed25519', 'base64url', 'base64url') as string;
    const signStranger = (message: Uint8Array): string =>
      cryptoSign(message, strangerKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    const before = await inviteCount();
    // Signed correctly, but `strangerPub` is not enrolled in OwnerKey, so the
    // `exists (select 1 from OwnerKey ...)` gate fails.
    await expect(
      db.insertFormationInvite('invite-' + rand(), 'sapp-x', strangerPub, signStranger),
    ).rejects.toThrow();
    expect(await inviteCount()).toBe(before);
  });

  it('redeems an invite by inserting Strand + FormationUsage atomically (consent branch, no owner sig)', async () => {
    const token = 'invite-' + rand();
    const strandId = 'strand-' + rand();
    // Far-future expiry so `FI.ExpiresAt > context.Now` holds.
    await db.insertFormationInvite(token, 'sapp-redeem', ownerPublicKey, signMessage, {
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await db.redeemInvitation({ token, strandId, disclosure: 'hello' });

    expect(await strandCount()).toBe(strandsBefore + 1);
    expect(await usageCount()).toBe(usageBefore + 1);

    // The strand exists purely via the FormationUsage branch — no owner sig
    // was supplied on its insert.
    const strand = await rawDb.get('select Id, Type, StampId from CadreControl.Strand where Id = ?', [strandId]);
    expect(strand?.Id).toBe(strandId);
    expect(strand?.Type).toBe('o');

    const usage = await rawDb.get(
      'select Token, UseNumber, StrandId, StrandStampId from CadreControl.FormationUsage where StrandId = ?',
      [strandId],
    );
    expect(usage?.Token).toBe(token);
    expect(usage?.UseNumber).toBe(1);
    expect(usage?.StrandId).toBe(strandId);
    // Consent is bound to the strand ROW, not the strand id: the usage row carries the
    // seated row's one-off stamp, which is what makes a later removal permanent.
    expect(usage?.StrandStampId).toBe(strand?.StampId);
  });

  it('rejects redemption against a non-existent token (nothing lands)', async () => {
    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(
      db.redeemInvitation({ token: 'no-such-' + rand(), strandId: 'strand-' + rand() }),
    ).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  });

  it('rejects redemption against an expired invite (nothing lands)', async () => {
    const token = 'invite-expired-' + rand();
    const strandId = 'strand-' + rand();
    // Expiry far in the past: `FI.ExpiresAt > context.Now` is false.
    await db.insertFormationInvite(token, 'sapp-expired', ownerPublicKey, signMessage, {
      expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(db.redeemInvitation({ token, strandId })).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  });

  it('admits redemption when the invite expires later on the same UTC day (same-day future expiry)', async () => {
    const token = 'invite-sameday-' + rand();
    const strandId = 'strand-sameday-' + rand();
    // base = noon UTC on a fixed date; expiry = one hour later (same calendar day).
    // Guards that a same-UTC-day future expiry is admitted: the deferred CHECK
    // compares `FI.ExpiresAt > context.Now` lexically, and both operands are the
    // engine `datetime()` form via canonicalDatetime, so the time-of-day decides.
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    await db.insertFormationInvite(token, 'sapp-sameday', ownerPublicKey, signMessage, {
      expiresAtMs: base + 3_600_000,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await db.redeemInvitation({ token, strandId, nowMs: base });

    expect(await strandCount()).toBe(strandsBefore + 1);
    expect(await usageCount()).toBe(usageBefore + 1);
  }, 30_000);

  it('rejects redemption when the invite expired earlier on the same UTC day (same-day past expiry)', async () => {
    const token = 'invite-sameday-past-' + rand();
    const strandId = 'strand-sameday-past-' + rand();
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    // ExpiresAt one hour BEFORE nowMs — same calendar day but already past.
    await db.insertFormationInvite(token, 'sapp-sameday-past', ownerPublicKey, signMessage, {
      expiresAtMs: base - 3_600_000,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(db.redeemInvitation({ token, strandId, nowMs: base })).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  }, 30_000);

  it('rejects redemption at the exact expiry instant (> is strict, boundary is exclusive)', async () => {
    const token = 'invite-boundary-' + rand();
    const strandId = 'strand-boundary-' + rand();
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    // nowMs == expiresAtMs: ExpiresAt > Now is false (strict inequality).
    await db.insertFormationInvite(token, 'sapp-boundary', ownerPublicKey, signMessage, {
      expiresAtMs: base,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(db.redeemInvitation({ token, strandId, nowMs: base })).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  }, 30_000);

  it('recordFormationUsage adds usage rows against a pre-existing (owner-signed) strand, monotonically', async () => {
    const token = 'invite-rec-' + rand();
    const strandId = 'strand-authsigned-' + rand();
    await db.insertFormationInvite(token, 'sapp-rec', ownerPublicKey, signMessage);
    // Strand created the normal way (owner signature), NOT via consent.
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);

    expect(await db.recordFormationUsage({ token, strandId })).toBe(1);
    expect(await db.recordFormationUsage({ token, strandId })).toBe(2);

    const row = await rawDb.get(
      'select count(1) as c from CadreControl.FormationUsage where Token = ?',
      [token],
    );
    expect(Number(row?.c)).toBe(2);

    // Both consent records are bound to the HOST strand's live stamp — `recordFormationUsage`
    // reads it off the row rather than leaving the pair to the deferred `StrandExists` CHECK.
    const liveStamp = await db.queryStrandStampId(strandId);
    expect(liveStamp).not.toBeNull();
    for await (const usage of rawDb.eval(
      'select StrandStampId from CadreControl.FormationUsage where Token = ?',
      [token],
    )) {
      expect(usage.StrandStampId).toBe(liveStamp);
    }
  });

  it('rejects a FormationUsage naming a live strand with the WRONG StrandStampId (StrandExists)', async () => {
    const token = 'invite-wrongstamp-' + rand();
    const strandId = 'strand-wrongstamp-' + rand();
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
    await db.insertFormationInvite(token, 'sapp-wrongstamp', ownerPublicKey, signMessage);

    const before = await usageCount();
    // `StrandExists` matches the (id, stamp) PAIR — the same key `Strand.AuthorizedInsert`'s
    // consent branch reads back — so a consent record can never be filed against a stamp of
    // the writer's choosing and held in reserve to re-seat the id after a removal.
    await expectConstraintFailure(
      rawInsertFormationUsage(token, 1, strandId, 'not-the-live-stamp-' + rand()),
      'StrandExists',
    );
    expect(await usageCount()).toBe(before);

    // The identical insert carrying the strand's LIVE stamp lands, so the rejection above
    // is about the stamp and nothing else.
    const liveStamp = await db.queryStrandStampId(strandId);
    expect(liveStamp).not.toBeNull();
    await rawInsertFormationUsage(token, 1, strandId, liveStamp!);
    expect(await usageCount()).toBe(before + 1);
  });

  it('recordFormationUsage throws MissingHostStrandError when the host strand is absent', async () => {
    // The writer must read the live stamp before inserting, so an absent strand is caught
    // here by name rather than silently rolled back by the deferred `StrandExists` CHECK.
    const token = 'invite-nohost-' + rand();
    const strandId = 'strand-nohost-' + rand();
    await db.insertFormationInvite(token, 'sapp-nohost', ownerPublicKey, signMessage);

    const before = await usageCount();
    await expect(db.recordFormationUsage({ token, strandId }))
      .rejects.toThrow(MissingHostStrandError);
    expect(await usageCount()).toBe(before);
  });

  /**
   * The consent branch of `Strand.AuthorizedInsert` is deliberately narrow: an unsigned,
   * redemption-seated strand must be open (`'o'`) and keyless, may only come from an
   * UNBOUND invite (`FormationInvite.StrandId` null), and a given strand id may be
   * consent-seated once, EVER. A bound invite is record-only, and
   * `FormationUsage.Authorized` further pins it to its own host strand. Every rejection
   * here names its constraint via the single-rejector technique
   * (control-constraint-helpers.ts); the removed-id replay half (spare-use re-seat,
   * owner-gated re-join) lives in control-revocation-replay.spec.ts beside the tombstone
   * machinery it leans on.
   */
  describe('consent-branch narrowing (unbound-only, open/keyless, once-ever)', () => {
    const freshStamp = (): string => randomBytes(256, 'base64url') as string;

    /** The unsigned Strand insert a redemption writes, with Type / MemberPrivateKey / StampId under the caller's control. */
    function rawInsertStrandUnsigned(
      id: string,
      type: string,
      memberPrivateKey: string | null,
      stampId: string,
    ): Promise<void> {
      return rawDb.exec(
        `insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
           with context OwnerKey = null, Signature = null
           values (?, ?, ?, ?)`,
        [id, type, memberPrivateKey, stampId],
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

    it('rejects a consent redemption seating a CLOSED strand with a caller-chosen member key (AuthorizedInsert)', async () => {
      const token = 'invite-closed-consent-' + rand();
      await db.insertFormationInvite(token, 'sapp-closed-consent', ownerPublicKey, signMessage);

      const strandId = 'strand-closed-consent-' + rand();
      const stamp = freshStamp();
      const strandsBefore = await strandCount();
      const usageBefore = await usageCount();

      // The exact two-insert transaction redeemInvitation runs, except the strand is
      // closed and carries a caller-chosen MemberPrivateKey — the party's own read-gating
      // secret for that network, which no consent path may pick. The invite is valid and
      // unbound, the (id, stamp) pair matches, and MemberKeyClosedOnly is satisfied
      // ('c' + key), so the consent branch's shape clauses are the only rule that can
      // reject.
      await expectConstraintFailure(
        inTransaction(async () => {
          await rawInsertStrandUnsigned(strandId, 'c', 'ATTACKER-KEY-' + strandId, stamp);
          await rawInsertFormationUsage(token, 1, strandId, stamp);
        }),
        'AuthorizedInsert',
      );
      expect(await strandCount()).toBe(strandsBefore);
      expect(await usageCount()).toBe(usageBefore);

      // The identical transaction in the open/keyless shape lands — the rejection above
      // is about the shape and nothing else. (Use number 1 again: the failed transaction
      // left no usage row behind.)
      const okId = 'strand-open-consent-' + rand();
      const okStamp = freshStamp();
      await inTransaction(async () => {
        await rawInsertStrandUnsigned(okId, 'o', null, okStamp);
        await rawInsertFormationUsage(token, 1, okId, okStamp);
      });
      expect(await strandCount()).toBe(strandsBefore + 1);
      expect(await usageCount()).toBe(usageBefore + 1);
    });

    it('rejects a consent redemption seating a CLOSED but keyless strand (AuthorizedInsert)', async () => {
      // Isolates the Type='o' clause from the MemberPrivateKey clause: a closed strand with a
      // null key satisfies MemberKeyClosedOnly and the previous test's key clause, so only
      // "the seated strand must be open" can reject. Without this the two shape clauses are
      // only ever tested together and dropping either would go unnoticed.
      const token = 'invite-closed-keyless-' + rand();
      await db.insertFormationInvite(token, 'sapp-closed-keyless', ownerPublicKey, signMessage);

      const strandId = 'strand-closed-keyless-' + rand();
      const stamp = freshStamp();
      const strandsBefore = await strandCount();
      const usageBefore = await usageCount();

      await expectConstraintFailure(
        inTransaction(async () => {
          await rawInsertStrandUnsigned(strandId, 'c', null, stamp);
          await rawInsertFormationUsage(token, 1, strandId, stamp);
        }),
        'AuthorizedInsert',
      );
      expect(await strandCount()).toBe(strandsBefore);
      expect(await usageCount()).toBe(usageBefore);
    });

    it('a bound invite cannot redeem against an unrelated strand id (AuthorizedInsert)', async () => {
      const host = 'strand-bound-host-' + rand();
      const hostMemberKey = 'memkey-' + rand();
      await db.insertStrand(host, 'c', ownerPublicKey, signMessage, hostMemberKey);
      const token = 'invite-bound-attack-' + rand();
      await db.insertFormationInvite(token, 'sapp-bound-attack', ownerPublicKey, signMessage, {
        strandId: host,
      });

      const unrelated = 'strand-unrelated-' + rand();
      const strandsBefore = await strandCount();
      const usageBefore = await usageCount();

      // Violates BOTH halves of the narrowing (the usage row names a strand other than
      // the invite's own, and a bound invite may not seat a strand at all); the engine
      // reports the Strand-side AuthorizedInsert.
      await expectConstraintFailure(
        db.redeemInvitation({ token, strandId: unrelated }),
        'AuthorizedInsert',
      );
      expect(await strandCount()).toBe(strandsBefore);
      expect(await usageCount()).toBe(usageBefore);

      // The host row is untouched either way.
      const hostRow = await rawDb.get(
        'select Type, MemberPrivateKey from CadreControl.Strand where Id = ?',
        [host],
      );
      expect(hostRow?.MemberPrivateKey).toBe(hostMemberKey);
    });

    it('a bound invite cannot consent-seat its own named host strand before that strand exists (AuthorizedInsert)', async () => {
      const host = 'strand-unconverged-' + rand();
      const token = 'invite-bound-early-' + rand();
      await db.insertFormationInvite(token, 'sapp-bound-early', ownerPublicKey, signMessage, {
        strandId: host,
      });

      const strandsBefore = await strandCount();
      // The usage row itself is fine (the invite names its own strand), so
      // FormationUsage.Authorized passes and the consent branch's unbound-invite-only
      // clause is the single rejector. Without it, this shape would seat an open,
      // keyless downgrade of the real (possibly closed, key-bearing) host row on a node
      // where it has not converged yet; resolveStrand instead reports 'missing' and the
      // formation manager rejects cleanly.
      await expectConstraintFailure(
        db.redeemInvitation({ token, strandId: host }),
        'AuthorizedInsert',
      );
      expect(await strandCount()).toBe(strandsBefore);
      expect(await rawDb.get('select Id from CadreControl.Strand where Id = ?', [host])).toBeUndefined();
    });

    it('a bound invite cannot record usage against a DIFFERENT existing strand (Authorized)', async () => {
      const host = 'strand-bound-own-' + rand();
      await db.insertStrand(host, 'o', ownerPublicKey, signMessage);
      const other = 'strand-bound-other-' + rand();
      await db.insertStrand(other, 'o', ownerPublicKey, signMessage);
      const token = 'invite-bound-cross-' + rand();
      await db.insertFormationInvite(token, 'sapp-bound-cross', ownerPublicKey, signMessage, {
        strandId: host,
      });

      const usageBefore = await usageCount();
      // Record-only — no Strand insert — against an ALREADY owner-signed strand, so
      // StrandExists and Monotonic are satisfied and FormationUsage.Authorized's
      // own-strand clause is the one rule that can reject. This isolates the
      // FormationUsage half of the narrowing, which any shape carrying a Strand insert
      // masks behind AuthorizedInsert.
      await expectConstraintFailure(
        db.recordFormationUsage({ token, strandId: other }),
        'Authorized',
      );
      expect(await usageCount()).toBe(usageBefore);
    });

    it('an unbound invite still seats one open, keyless strand per use, each with a distinct id', async () => {
      const token = 'invite-multi-use-' + rand();
      await db.insertFormationInvite(token, 'sapp-multi-use', ownerPublicKey, signMessage, {
        totalUses: 2,
      });

      const first = 'strand-use1-' + rand();
      const second = 'strand-use2-' + rand();
      await db.redeemInvitation({ token, strandId: first });
      await db.redeemInvitation({ token, strandId: second });

      for (const id of [first, second]) {
        const row = await rawDb.get(
          'select Type, MemberPrivateKey from CadreControl.Strand where Id = ?',
          [id],
        );
        expect(row?.Type).toBe('o');
        expect(row?.MemberPrivateKey).toBeNull();
      }
      expect(await db.countFormationUsage(token)).toBe(2);
    });

    it('the bound record-only path accepts several invitees against one owner-signed host strand', async () => {
      const host = 'strand-bound-many-' + rand();
      const hostMemberKey = 'memkey-' + rand();
      await db.insertStrand(host, 'c', ownerPublicKey, signMessage, hostMemberKey);
      const token = 'invite-bound-many-' + rand();
      await db.insertFormationInvite(token, 'sapp-bound-many', ownerPublicKey, signMessage, {
        strandId: host,
        totalUses: 3,
      });

      expect(await db.recordFormationUsage({ token, strandId: host, peerId: 'peer-a' })).toBe(1);
      expect(await db.recordFormationUsage({ token, strandId: host, peerId: 'peer-b' })).toBe(2);

      // Still exactly one Strand row for the host — joining by bound invite records
      // consent, it never seats anything.
      const row = await rawDb.get(
        'select count(1) as c from CadreControl.Strand where Id = ?',
        [host],
      );
      expect(Number(row?.c)).toBe(1);
    });
  });

  describe('MemberKeyClosedOnly constraint', () => {
    it('rejects an open strand with a non-null MemberPrivateKey', async () => {
      const before = await strandCount();
      await expect(
        db.insertStrand('strand-' + rand(), 'o', ownerPublicKey, signMessage, 'memkey-' + rand()),
      ).rejects.toThrow();
      expect(await strandCount()).toBe(before);
    });

    it('admits a closed strand with a MemberPrivateKey', async () => {
      const strandId = 'strand-closed-' + rand();
      const before = await strandCount();
      await db.insertStrand(strandId, 'c', ownerPublicKey, signMessage, 'memkey-' + rand());
      expect(await strandCount()).toBe(before + 1);
      const row = await rawDb.get('select Type from CadreControl.Strand where Id = ?', [strandId]);
      expect(row?.Type).toBe('c');
    });

    it('admits an open strand with a null MemberPrivateKey', async () => {
      const strandId = 'strand-open-' + rand();
      const before = await strandCount();
      await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
      expect(await strandCount()).toBe(before + 1);
      const row = await rawDb.get('select Type from CadreControl.Strand where Id = ?', [strandId]);
      expect(row?.Type).toBe('o');
    });
  });

  /**
   * `FormationUsage.Authorized`'s validation branch: an invite carrying a `ValidationUrl` may
   * only be redeemed when the disclosure sign-off comes from a key the party ENROLLED in
   * `ValidationKey`, and the signature is verified against the STORED `VK.Key` — not against
   * `context.ValidationKey`, which is a caller-supplied insert parameter. Before the fix the
   * CHECK verified against that parameter, so a redeemer minted a throwaway keypair, signed its
   * own disclosure, passed both, and satisfied the gate; `ValidationKey` had no consumer at all.
   *
   * Every case records against a PRE-EXISTING owner-signed strand (`recordFormationUsage`, not
   * `redeemInvitation`) so `Authorized` is the only constraint that can reject: `StrandExists` is
   * satisfied by the committed strand and `Monotonic` by the writer's use-number read. That keeps
   * `expectConstraintFailure(..., 'Authorized')` a single-rejector assertion.
   */
  describe('FormationUsage.Authorized validation-key branch', () => {
    let validationPrivateKey: string;
    let validationPublicKey: string;

    /** ed25519 sign-off over the same 'vouch' digest the SQL builds, from an arbitrary key. */
    const vouch = (privateKey: string, token: string, disclosure: string): string =>
      cryptoSign(
        buildAuthorizationMessage('CadreControl.FormationUsage', 'vouch', [token, disclosure]),
        privateKey, 'ed25519', 'bytes', 'base64url', 'base64url',
      ) as string;

    /** A `ValidationUrl` invite plus an owner-signed host strand to record consent against. */
    async function validatingInvite(tag: string): Promise<{ token: string; strandId: string }> {
      const token = `invite-${tag}-` + rand();
      const strandId = `strand-${tag}-` + rand();
      await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(token, 'sapp-' + tag, ownerPublicKey, signMessage, {
        validationUrl: `https://validate.example/${tag}`,
      });
      return { token, strandId };
    }

    beforeAll(async () => {
      // The party enrols ONE approver, so every rejection below is about the key presented
      // rather than about the party having no approver at all.
      validationPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
      validationPublicKey = getPublicKey(validationPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
      await db.insertValidationKey(validationPublicKey, ownerPublicKey, signMessage);
    });

    it('rejects a rogue, unenrolled key that validly signed its own disclosure (pins the bug)', async () => {
      const { token, strandId } = await validatingInvite('rogue');
      const roguePrivate = generatePrivateKey('ed25519', 'base64url') as string;
      const roguePublic = getPublicKey(roguePrivate, 'ed25519', 'base64url', 'base64url') as string;
      const disclosure = 'rogue-disclosure';

      const before = await usageCount();
      // The signature IS valid over the right digest — it is the KEY that is not enrolled.
      // Pre-fix this landed, because the CHECK verified against the key on the insert.
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId, disclosure,
          validationKey: roguePublic,
          validationSignature: vouch(roguePrivate, token, disclosure),
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });

    it('rejects redemption of a ValidationUrl invite with no sign-off supplied at all', async () => {
      const { token, strandId } = await validatingInvite('noapproval');

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({ token, strandId, disclosure: 'no-approval' }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });

    it('admits redemption when an ENROLLED ValidationKey signed the vouch digest', async () => {
      const { token, strandId } = await validatingInvite('enrolled');
      const disclosure = 'enrolled-disclosure';

      const before = await usageCount();
      expect(await db.recordFormationUsage({
        token, strandId, disclosure,
        validationKey: validationPublicKey,
        validationSignature: vouch(validationPrivateKey, token, disclosure),
      })).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });

    it('rejects an enrolled key named alongside a signature from a DIFFERENT key', async () => {
      const { token, strandId } = await validatingInvite('mismatch');
      const otherPrivate = generatePrivateKey('ed25519', 'base64url') as string;
      const disclosure = 'mismatch-disclosure';

      const before = await usageCount();
      // `context.ValidationKey` only SELECTS the enrolled row; the verify runs against the
      // stored `VK.Key`, so an enrolled name cannot launder a foreign signature.
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId, disclosure,
          validationKey: validationPublicKey,
          validationSignature: vouch(otherPrivate, token, disclosure),
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });

    it('rejects an enrolled key\'s signature presented under an unenrolled key name', async () => {
      const { token, strandId } = await validatingInvite('unenrolled-name');
      const roguePublic = getPublicKey(
        generatePrivateKey('ed25519', 'base64url') as string, 'ed25519', 'base64url', 'base64url',
      ) as string;
      const disclosure = 'unenrolled-name-disclosure';

      const before = await usageCount();
      // The mirror of the case above: a genuine approver signature, but the row lookup is on
      // the name presented, and no `ValidationKey` row matches it.
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId, disclosure,
          validationKey: roguePublic,
          validationSignature: vouch(validationPrivateKey, token, disclosure),
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });

    it('leaves an invite with NO ValidationUrl redeemable without any sign-off (unchanged)', async () => {
      const token = 'invite-novalidation-' + rand();
      const strandId = 'strand-novalidation-' + rand();
      await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(token, 'sapp-novalidation', ownerPublicKey, signMessage);

      const before = await usageCount();
      expect(await db.recordFormationUsage({ token, strandId, disclosure: 'open' })).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });

    it('stops approving once the key is removed, without unwinding what it already approved', async () => {
      // A SECOND, self-contained approver so removing it leaves the block's shared key alone.
      const retiredPrivate = generatePrivateKey('ed25519', 'base64url') as string;
      const retiredPublic = getPublicKey(retiredPrivate, 'ed25519', 'base64url', 'base64url') as string;
      await db.insertValidationKey(retiredPublic, ownerPublicKey, signMessage);

      const approved = await validatingInvite('before-removal');
      expect(await db.recordFormationUsage({
        ...approved, disclosure: 'before-removal-disclosure',
        validationKey: retiredPublic,
        validationSignature: vouch(retiredPrivate, approved.token, 'before-removal-disclosure'),
      })).toBe(1);

      await db.deleteValidationKey(retiredPublic, ownerPublicKey, signMessage);

      // Future redemptions: the `exists` finds no row, so the same approver is now powerless.
      const later = await validatingInvite('after-removal');
      const disclosure = 'after-removal-disclosure';
      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          ...later, disclosure,
          validationKey: retiredPublic,
          validationSignature: vouch(retiredPrivate, later.token, disclosure),
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);

      // Past redemptions: CHECKs run on write only, so the already-approved row stands.
      expect(await rawDb.get(
        'select UseNumber from CadreControl.FormationUsage where Token = ?',
        [approved.token],
      )).toBeDefined();
    });
  });

  describe('ControlFormationUsageRecorder (DB-backed)', () => {
    it('isTokenValid: true for a known unexpired token, false for unknown or expired', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      const token = 'invite-rv-' + rand();
      await db.insertFormationInvite(token, 'sapp-rv', ownerPublicKey, signMessage, {
        expiresAtMs: Date.now() + 60_000,
      });
      const ok = await recorder.isTokenValid(token);
      expect(ok.valid).toBe(true);
      expect(ok.invitation?.sAppId).toBe('sapp-rv');

      expect((await recorder.isTokenValid('nope-' + rand())).valid).toBe(false);

      const expired = 'invite-rv-exp-' + rand();
      await db.insertFormationInvite(expired, 'sapp-rv', ownerPublicKey, signMessage, {
        expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
      });
      expect((await recorder.isTokenValid(expired)).valid).toBe(false);
    });

    it('isTokenUsed: respects TotalUses, and recordUsage records consent against a pre-existing strand', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      // provision-then-record: the host strand is minted owner-signed UP FRONT, so
      // recordUsage is record-only (no Strand insert). Single-use invite: not used until
      // its one consent row lands.
      const single = 'invite-single-' + rand();
      const singleStrand = 'strand-su-' + rand();
      await db.insertStrand(singleStrand, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(single, 'sapp-su', ownerPublicKey, signMessage, { totalUses: 1 });
      expect(await recorder.isTokenUsed(single)).toBe(false);
      await recorder.recordUsage(single, 'peer-x', singleStrand);
      expect(await recorder.isTokenUsed(single)).toBe(true);

      // Unlimited invite (null TotalUses): never "used up".
      const unlimited = 'invite-unl-' + rand();
      const unlimitedStrand = 'strand-unl-' + rand();
      await db.insertStrand(unlimitedStrand, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(unlimited, 'sapp-unl', ownerPublicKey, signMessage);
      await recorder.recordUsage(unlimited, 'peer-y', unlimitedStrand);
      expect(await recorder.isTokenUsed(unlimited)).toBe(false);
    });

    it('resolveStrand: classifies bound (present) / unbound / missing host strands', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      // Bound + present closed strand: the invite names the pre-existing host strand →
      // kind 'bound', carrying that strand id + its MemberPrivateKey.
      const hostStrand = 'strand-bound-' + rand();
      const hostMemberKey = 'memkey-' + rand();
      await db.insertStrand(hostStrand, 'c', ownerPublicKey, signMessage, hostMemberKey);
      const bound = 'invite-bound-' + rand();
      await db.insertFormationInvite(bound, 'sapp-bound', ownerPublicKey, signMessage, {
        strandId: hostStrand,
      });
      expect(await recorder.resolveStrand(bound)).toEqual({
        kind: 'bound',
        strandId: hostStrand,
        memberPrivateKey: hostMemberKey,
      });

      // Unbound invite (legacy/open path): no StrandId → kind 'unbound'.
      const unbound = 'invite-unbound-' + rand();
      await db.insertFormationInvite(unbound, 'sapp-unbound', ownerPublicKey, signMessage);
      expect(await recorder.resolveStrand(unbound)).toEqual({ kind: 'unbound' });

      // Unknown token: no binding to act on → unbound.
      expect(await recorder.resolveStrand('nope-' + rand())).toEqual({ kind: 'unbound' });

      // Bound but the named Strand row was NEVER inserted (unconverged host) → kind 'missing'.
      const missingStrand = 'strand-missing-' + rand();
      const boundMissing = 'invite-bound-missing-' + rand();
      await db.insertFormationInvite(boundMissing, 'sapp-bm', ownerPublicKey, signMessage, {
        strandId: missingStrand,
      });
      expect(await recorder.resolveStrand(boundMissing)).toEqual({
        kind: 'missing',
        strandId: missingStrand,
      });
    });

    it('hasOutstandingInvitation: delegates to the DB-wide redeemable scan', async () => {
      const recorder = new ControlFormationUsageRecorder(db);
      // This shared DB has carried unexpired, unlimited-use invites since the
      // first test, so the delegate must report the node as stranger-expecting.
      expect(await recorder.hasOutstandingInvitation()).toBe(true);
    });

    it('provisionAndRecord: mints an open strand + records one usage atomically (single-use)', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      // UNBOUND single-use invite → provisionAndRecord mints a fresh open strand and
      // records its one consent row in a single transaction.
      const token = 'invite-par-' + rand();
      await db.insertFormationInvite(token, 'sapp-par', ownerPublicKey, signMessage, {
        totalUses: 1,
        expiresAtMs: Date.now() + 60_000,
      });

      const out = await recorder.provisionAndRecord(token, 'peer-par', 'sapp-par');
      expect(out.strandId.length).toBeGreaterThan('strand-'.length);
      // An unbound responder-provisioned strand is open → no membership key.
      expect(out.memberPrivateKey).toBeNull();

      // The minted strand exists, is open, and exactly one usage row was recorded → single-use.
      const strand = await rawDb.get('select Id, Type from CadreControl.Strand where Id = ?', [out.strandId]);
      expect(strand?.Id).toBe(out.strandId);
      expect(strand?.Type).toBe('o');
      expect(await db.countFormationUsage(token)).toBe(1);
      expect(await recorder.isTokenUsed(token)).toBe(true);
    });
  });
});

/**
 * `ControlDatabase.hasOutstandingFormationInvite` — the durable half of the
 * control-network connection gate's "does this node expect a stranger?"
 * question. Boots its OWN node because the answer is DB-WIDE: the suite above
 * leaves unexpired unlimited-use invites behind, which would make every
 * negative case unprovable on a shared database.
 */
describe('ControlDatabase.hasOutstandingFormationInvite (DB-wide redeemable scan)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: { partyId: 'formation-outstanding-' + rand(), bootstrapNodes: [] },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  // The predicate is DB-wide, so every invite inserted here stays visible to the
  // later tests. Anchoring every expiry to a FIXED future instant and passing an
  // explicit `nowMs` keeps each case decidable regardless of the real clock (which
  // still has to be before T0 for `recordFormationUsage`'s deferred expiry CHECK).
  const T0 = Date.UTC(2031, 0, 1);
  const MINUTE = 60_000;
  const HOUR = 3600_000;

  it('is false with no invites at all', async () => {
    expect(await db.hasOutstandingFormationInvite(T0)).toBe(false);
  });

  it('is true for an unexpired, unconsumed invite and false from its expiry instant on', async () => {
    const token = 'invite-out-' + rand();
    await db.insertFormationInvite(token, 'sapp-out', ownerPublicKey, signMessage, {
      expiresAtMs: T0 + MINUTE,
    });

    expect(await db.hasOutstandingFormationInvite(T0)).toBe(true);
    // Same `expiresAtMs <= now` boundary the recorder's isTokenValid applies: at
    // the exact expiry instant the invite no longer holds the gate open, so a
    // token the formation handler rejects can never keep the gate disarmed.
    expect(await db.hasOutstandingFormationInvite(T0 + MINUTE)).toBe(false);
    expect(await db.hasOutstandingFormationInvite(T0 + MINUTE + 1)).toBe(false);
  });

  it('is false once a single-use invite has recorded its one usage', async () => {
    const token = 'invite-out-single-' + rand();
    const strandId = 'strand-out-single-' + rand();
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
    await db.insertFormationInvite(token, 'sapp-out-single', ownerPublicKey, signMessage, {
      totalUses: 1,
      expiresAtMs: T0 + HOUR,
    });

    // At T0 + 2min the previous test's invite is expired, so this one decides.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * MINUTE)).toBe(true);
    await db.recordFormationUsage({ token, strandId });
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * MINUTE)).toBe(false);
  });

  it('finds a live invite past the expired and consumed ones in the scan', async () => {
    const stale = 'invite-out-stale-' + rand();
    await db.insertFormationInvite(stale, 'sapp-out-stale', ownerPublicKey, signMessage, {
      expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
    });
    const live = 'invite-out-live-' + rand();
    await db.insertFormationInvite(live, 'sapp-out-live', ownerPublicKey, signMessage, {
      expiresAtMs: T0 + 2 * HOUR,
      totalUses: 2,
    });

    // Live one wins over one expired-long-ago, one expired-recently, one consumed.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * MINUTE)).toBe(true);
    // …and once IT expires too, the whole set is dead again.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * HOUR)).toBe(false);
  });

  it('is true for a never-expiring, unlimited-use invite (null ExpiresAt + null TotalUses)', async () => {
    const token = 'invite-out-forever-' + rand();
    await db.insertFormationInvite(token, 'sapp-out-forever', ownerPublicKey, signMessage);

    // Every other invite in this DB is expired or consumed by T0 + 2h; only the
    // unbounded one is left, and it has no wall clock of its own to lapse against.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * HOUR)).toBe(true);
    expect(await db.hasOutstandingFormationInvite(T0 + 365 * 24 * HOUR)).toBe(true);
  });
});
