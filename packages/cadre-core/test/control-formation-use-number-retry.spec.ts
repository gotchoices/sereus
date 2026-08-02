import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import {
  FormationAbortedError,
  InvitationExhaustedError,
  isLostUseNumberRace,
} from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { isRetriableControlWriteFailure } from '../src/control-write-retry.js';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';
import { signFormationApproval } from '../src/formation-approval.js';
import type { FormationApprovalRequest, FormationApproval } from '../src/formation-approval.js';
import { canonicalDatetime } from '../src/canonical-datetime.js';
import { expectConstraintFailure, expectUniqueViolation } from './control-constraint-helpers.js';
import { mintConsent } from './formation-consent-helper.js';
import type { JoinerConsent } from './formation-consent-helper.js';

/**
 * `ControlDatabase`'s use-number assignment and its retry.
 *
 * An invitation's `ValidationUrl` hook can be a HUMAN review queue, so an approval that is
 * granted and then thrown away costs a person a second review of a join they already
 * approved. The approver signs over five fields — token, nonce (`UsageStampId`), strand id,
 * joining peer key, disclosure — and deliberately NOT the use number, precisely so a writer
 * that loses a race for a use number can re-present the identical approval under the next
 * one. These cases pin that the database layer now does exactly that, rather than surfacing
 * a conflict the joiner can only answer by starting formation over with a fresh nonce.
 *
 * Two mechanisms are under test and they are independent:
 *
 *  - the use number is read INSIDE the write lock, which alone removes the collision between
 *    two redemptions on the SAME node (the common case — the local write queue serializes
 *    them, so each reads a number the other already committed);
 *  - a bounded retry, for the writers the lock does not reach (another node of the cadre,
 *    another `Database` handle over the same store), which can still take the number between
 *    our read and our commit.
 *
 * Concurrency here means "started in the same tick without awaiting the first", the idiom
 * `control-write-lock.spec.ts` documents.
 *
 * Boots a real `CadreNode` (empty bootstrap, transaction profile) so every constraint,
 * rollback, and engine error message below is the real one — the classifier's whole risk is
 * that it depends on error TEXT, so nothing here may be a string literal standing in for
 * what the engine emits. That real-error material serves BOTH text-reading classifiers: the
 * use-number one this suite is named for, and `isRetriableControlWriteFailure`'s negative
 * half (last describe below).
 */

/** The approval material for one redemption, alongside the fields it is bound to. */
interface Redemption extends JoinerConsent {
  token: string;
  strandId: string;
  disclosure: string;
}

/**
 * Test-only window onto the private members these cases must shadow. The repo precedent is
 * `control-write-lock.spec.ts`'s `selfRegistrationTimerSlot`.
 *
 * Optional so a stub can be removed with `delete`, restoring the prototype's own
 * implementation — assigning the stub creates an OWN property that shadows it, so deleting
 * that property is the restore.
 */
interface ControlDatabaseInternals {
  nextUseNumber?: (token: string) => Promise<number>;
  execFormationUsageInsert?: (opts: { token: string; useNumber: number }) => Promise<void>;
}

function internals(db: ControlDatabase): ControlDatabaseInternals {
  return db as unknown as ControlDatabaseInternals;
}

/** Run `body` with a private method of `db` shadowed, restoring it however `body` settles. */
async function withStubbed<K extends keyof ControlDatabaseInternals>(
  db: ControlDatabase,
  name: K,
  stub: NonNullable<ControlDatabaseInternals[K]>,
  body: () => Promise<void>,
): Promise<void> {
  const slot = internals(db);
  slot[name] = stub;
  try {
    await body();
  } finally {
    delete slot[name];
  }
}

/** The error a rejected promise actually threw, so a case can classify the REAL thing. */
async function captureError(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the write to fail, but it succeeded');
}

describe('ControlDatabase — use-number assignment and lost-race retry', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPublicKey: string;
  let validationPrivateKey: string;
  let validationPublicKey: string;
  let signMessage: (message: Uint8Array) => string;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function usageCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationUsage');
    return Number(row?.c ?? 0);
  }

  /**
   * A bound invite plus its owner-signed host strand — the shape production actually races
   * on, since `cadre-web` / `cadre-phone` publish strand-bound invites and those redeem
   * through the record-only path.
   */
  async function boundInvite(
    tag: string,
    options: { totalUses?: number; validating?: boolean } = {},
  ): Promise<{ token: string; strandId: string; strandStampId: string }> {
    const token = `invite-${tag}-` + rand();
    const strandId = `strand-${tag}-` + rand();
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
    await db.insertFormationInvite(token, 'sapp-' + tag, ownerPublicKey, signMessage, {
      strandId,
      totalUses: options.totalUses,
      ...(options.validating ? { validationUrl: `https://validate.example/${tag}` } : {}),
    });
    const strandStampId = await db.queryStrandStampId(strandId);
    expect(strandStampId).not.toBeNull();
    return { token, strandId, strandStampId: strandStampId! };
  }

  /** A fresh joiner + nonce + consent signature for `token`, as a spreadable redemption. */
  function redemption(token: string, strandId: string, disclosure = ''): Redemption {
    return { token, strandId, disclosure, ...mintConsent(token, disclosure) };
  }

  /**
   * The bare `FormationUsage` insert with every derived field caller-controlled — the cheapest
   * way to plant a colliding row and to capture the engine's REAL rejection messages.
   */
  async function rawInsertFormationUsage(opts: {
    token: string;
    useNumber: number;
    strandId: string;
    strandStampId: string;
    consent?: JoinerConsent;
    disclosure?: string;
  }): Promise<void> {
    const now = await canonicalDatetime(rawDb, Date.now());
    const disclosure = opts.disclosure ?? '';
    const consent = opts.consent ?? mintConsent(opts.token, disclosure);
    await rawDb.exec(
      `insert into CadreControl.FormationUsage (Token, UseNumber, UsageStampId, PeerKey, PeerSig, Disclosure, StrandId, StrandStampId)
         with context Now = ?, ValidationKey = null, ValidationSignature = null
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now, opts.token, opts.useNumber,
        consent.usageStampId, consent.peerKey, consent.peerSignature,
        disclosure, opts.strandId, opts.strandStampId,
      ],
    );
  }

  /** A REAL `(Token, UseNumber)` collision error, produced by the engine on a scratch invite. */
  async function realLostRaceError(): Promise<unknown> {
    const { token, strandId, strandStampId } = await boundInvite('scratch-race');
    await rawInsertFormationUsage({ token, useNumber: 1, strandId, strandStampId });
    return await captureError(rawInsertFormationUsage({ token, useNumber: 1, strandId, strandStampId }));
  }

  /**
   * A REAL DEFERRED `Monotonic` CHECK failure. Skipping ahead of max+1 on an UNCAPPED invite
   * leaves `Monotonic` as the only clause that can refuse the row — `Authorized`'s seat clause
   * has no cap to enforce, and no row sits at #7 to collide with.
   */
  async function realMonotonicFailureError(): Promise<unknown> {
    const { token, strandId, strandStampId } = await boundInvite('monotonic');
    return await captureError(rawInsertFormationUsage({ token, useNumber: 7, strandId, strandStampId }));
  }

  /** A REAL `Authorized` CHECK failure: a second seat on a single-use invite. */
  async function realAuthorizedFailureError(): Promise<unknown> {
    const { token, strandId, strandStampId } = await boundInvite('authorized', { totalUses: 1 });
    await rawInsertFormationUsage({ token, useNumber: 1, strandId, strandStampId });
    return await captureError(rawInsertFormationUsage({ token, useNumber: 2, strandId, strandStampId }));
  }

  /**
   * A REAL `FormationUsage.UsageStampId` uniqueness violation: the same nonce replayed under a
   * fresh use number, on an uncapped invite, so the repeated nonce is the only possible refusal.
   */
  async function realDuplicateNonceError(): Promise<unknown> {
    const { token, strandId, strandStampId } = await boundInvite('nonce-dup');
    const consent = mintConsent(token);
    await rawInsertFormationUsage({ token, useNumber: 1, strandId, strandStampId, consent });
    return await captureError(
      rawInsertFormationUsage({ token, useNumber: 2, strandId, strandStampId, consent }),
    );
  }

  beforeAll(async () => {
    const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    signMessage = (message) =>
      cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: { partyId: 'use-number-retry-' + rand(), bootstrapNodes: [] },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);

    validationPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    validationPublicKey = getPublicKey(validationPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    await db.insertValidationKey(validationPublicKey, ownerPublicKey, signMessage);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  }, 30_000);

  /**
   * `isLostUseNumberRace` is the ONE piece of this change that reads engine error text, so
   * every message it is asked about here comes out of the real engine rather than a literal.
   * A reworded storage-layer error must redden these rather than silently disabling the retry.
   */
  describe('isLostUseNumberRace (classifier)', () => {
    it('accepts a real (Token, UseNumber) primary-key collision', async () => {
      expect(isLostUseNumberRace(await realLostRaceError())).toBe(true);
    });

    it('accepts a real DEFERRED `Monotonic` CHECK failure', async () => {
      // The trap this case exists for: `Monotonic` carries a subquery, so Quereus defers it to
      // commit and throws it as a BARE `QuereusError`, not a `ConstraintError`. A classifier
      // gated on `instanceof ConstraintError` passes the case above and silently drops this
      // one — which is the surface a concurrent row our key probe never saw arrives on.
      const error = await realMonotonicFailureError();
      expect(String(error)).toMatch(/CHECK constraint failed: Monotonic\b/);
      expect(isLostUseNumberRace(error)).toBe(true);
    });

    it('REJECTS a real duplicate-nonce violation — replay is not a race', async () => {
      const error = await realDuplicateNonceError();
      expect(String(error)).toMatch(/UNIQUE constraint failed: FormationUsage\.UsageStampId/i);
      expect(isLostUseNumberRace(error)).toBe(false);
    });

    it('rejects a real `Authorized` CHECK failure and non-Error values', async () => {
      // `Authorized` renders with the same `CHECK constraint failed:` prefix as `Monotonic`,
      // so a prefix-only match would retry an expired/exhausted/unapproved invite forever.
      const error = await realAuthorizedFailureError();
      expect(String(error)).toMatch(/CHECK constraint failed: Authorized\b/);
      expect(isLostUseNumberRace(error)).toBe(false);

      expect(isLostUseNumberRace(undefined)).toBe(false);
      expect(isLostUseNumberRace('UNIQUE constraint failed: FormationUsage.Token, FormationUsage.UseNumber')).toBe(false);
    });
  });

  /**
   * The OTHER classifier that reads error text: `isRetriableControlWriteFailure`, which decides
   * whether a failed control write is re-presented to the cluster. Its unit spec
   * (`control-write-retry.spec.ts`) can only assert against message literals, so the half of its
   * contract that a real engine can produce is pinned here instead — against the same real
   * objects, not transcriptions of them.
   *
   * Only the NEGATIVE half is producible without a network. Every error below MUST classify
   * non-retriable: re-presenting a write the cohort actually REFUSED would re-present a spent
   * signature, and on a capped invite it could manufacture a seat the invite does not have.
   *
   * The two RETRIABLE messages — the network transactor's `Some peers did not complete:`
   * aggregate and the cluster coordinator's super-majority shortfall — cannot be produced here
   * at all. Both need a real multi-node cluster to fail mid-write; this suite boots ONE
   * `CadreNode` with an empty bootstrap list. Faking them as literals here would be a literal
   * dressed as real coverage, which is exactly what this spec exists to avoid.
   * `control-write-retry-scenario-coverage` produces them from a real cluster.
   */
  describe('isRetriableControlWriteFailure (classifier, against real engine errors)', () => {
    it('never retries a real constraint or authorization failure', async () => {
      const failures = [
        await realLostRaceError(),
        await realMonotonicFailureError(),
        await realDuplicateNonceError(),
        await realAuthorizedFailureError(),
      ];
      for (const failure of failures) {
        // Non-vacuity: the classifier returns false for ANY non-`Error`, so without this the
        // case would still pass if the engine ever threw something that is not an Error and
        // the message-matching arm were never exercised at all.
        expect(failure).toBeInstanceOf(Error);
        expect(isRetriableControlWriteFailure(failure)).toBe(false);
      }
    });

    /**
     * The property that keeps the two retry loops from multiplying: no error is claimed by both
     * classifiers, so any failure is retried by exactly one loop (or neither). `control-write-
     * retry.spec.ts` asserts this over literals; here it is asserted over the REAL errors, so a
     * rewording upstream reddens a case rather than silently letting one classifier's claim
     * drift into the other's.
     */
    it('is disjoint from isLostUseNumberRace on the real lost-race surfaces', async () => {
      for (const lostRace of [await realLostRaceError(), await realMonotonicFailureError()]) {
        expect(isLostUseNumberRace(lostRace)).toBe(true);
        expect(isRetriableControlWriteFailure(lostRace)).toBe(false);
      }
    });
  });

  describe('concurrent redemptions on one node', () => {
    it('lands both uses of a two-use invite, asking the approval hook exactly twice', async () => {
      // The primary regression: before the use number was read under the lock, both of these
      // picked #1, one lost, and its GRANTED approval was discarded — a second human review
      // for a join already approved. No retry needs to fire for this to pass now.
      const { token, strandId } = await boundInvite('both-land', { totalUses: 2, validating: true });

      const asked: string[] = [];
      const recorder = new ControlFormationUsageRecorder(db, {
        approver: {
          requestApproval: async (request: FormationApprovalRequest): Promise<FormationApproval> => {
            asked.push(request.usageStampId);
            return signFormationApproval(request, validationPublicKey, validationPrivateKey);
          },
        },
      });

      const [first, second] = [redemption(token, strandId, 'first'), redemption(token, strandId, 'second')];
      await Promise.all([
        recorder.recordUsage({ token, strandId, disclosure: first.disclosure, ...toConsent(first) }),
        recorder.recordUsage({ token, strandId, disclosure: second.disclosure, ...toConsent(second) }),
      ]);

      const used = await useNumbersFor(token);
      expect(used).toEqual([1, 2]);
      // Once per joiner. A third ask would mean an approval was thrown away and re-obtained.
      expect(asked.sort()).toEqual([first.usageStampId, second.usageStampId].sort());
    });

    it('seats exactly one redemption of a SINGLE-use invite and creates no extra seat', async () => {
      const { token, strandId } = await boundInvite('single-seat', { totalUses: 1 });
      const before = await usageCount();

      const results = await Promise.allSettled([
        db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
        db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      // The loser reads use #2 under the lock, on its FIRST attempt — no retry involved — and
      // is refused by name: a same-node race is caught the same way a lost cross-node race is.
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(InvitationExhaustedError);
      const exhausted = rejected.reason as InvitationExhaustedError;
      expect(exhausted.token).toBe(token);
      expect(exhausted.useNumber).toBe(2);
      expect(exhausted.totalUses).toBe(1);
      expect(await usageCount()).toBe(before + 1);
      expect(await useNumbersFor(token)).toEqual([1]);
    });

    /**
     * The two cases below race the RECORDER, which is the production shape: it has already read
     * the invite, so it hands `totalUses` down and no attempt re-reads it. The case above races
     * `ControlDatabase` directly, omitting that parameter and falling back to the read inside
     * `assertSeatRemains` — so without these, a recorder that threaded the wrong budget (or
     * dropped it to `null`) would leave every case green and quietly restore the generic
     * `CHECK constraint failed: Authorized` the joiner is told to retry.
     */
    const refuseApproval = {
      requestApproval: async (): Promise<FormationApproval> => {
        throw new Error('An invite with no ValidationUrl must never reach the approver');
      },
    };

    it('reports the loser of a record-only race as exhausted, on the budget the recorder passed down', async () => {
      const { token, strandId } = await boundInvite('recorder-single-seat', { totalUses: 1 });
      const recorder = new ControlFormationUsageRecorder(db, { approver: refuseApproval });

      const results = await Promise.allSettled([
        recorder.recordUsage({ token, strandId, disclosure: '', ...toConsent(redemption(token, strandId)) }),
        recorder.recordUsage({ token, strandId, disclosure: '', ...toConsent(redemption(token, strandId)) }),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(InvitationExhaustedError);
      expect((rejected.reason as InvitationExhaustedError).totalUses).toBe(1);
      expect(await useNumbersFor(token)).toEqual([1]);
    });

    it('reports the loser of an unbound provision race as exhausted, seating exactly one strand', async () => {
      // The other threaded call site: an UNBOUND invite redeems through `redeemInvitation`,
      // which seats the strand and the usage in ONE transaction — so the loser must leave no
      // orphan strand behind either.
      const token = 'invite-recorder-unbound-' + rand();
      await db.insertFormationInvite(token, 'sapp-recorder-unbound', ownerPublicKey, signMessage, { totalUses: 1 });
      const recorder = new ControlFormationUsageRecorder(db, { approver: refuseApproval });
      const provision = (): Promise<{ strandId: string }> => recorder.provisionAndRecord({
        token, sAppId: 'sapp-recorder-unbound', disclosure: '', ...mintConsent(token),
      });

      const results = await Promise.allSettled([provision(), provision()]);

      const seated = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ strandId: string }>[];
      expect(seated).toHaveLength(1);
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(InvitationExhaustedError);
      expect((rejected.reason as InvitationExhaustedError).useNumber).toBe(2);
      expect(await useNumbersFor(token)).toEqual([1]);
      expect(await db.queryStrand(seated[0]!.value.strandId)).not.toBeNull();
    });
  });

  describe('retrying a lost use number', () => {
    it('re-presents the SAME approval under the next use number, asking the hook once', async () => {
      const { token, strandId } = await boundInvite('retry-same', { totalUses: 3, validating: true });
      let asked = 0;
      const recorder = new ControlFormationUsageRecorder(db, {
        approver: {
          requestApproval: async (request: FormationApprovalRequest): Promise<FormationApproval> => {
            asked++;
            return signFormationApproval(request, validationPublicKey, validationPrivateKey);
          },
        },
      });

      // Use #1 is spent through the normal path, so a stale read of "1" is a real lost race.
      const first = redemption(token, strandId, 'first');
      await recorder.recordUsage({ token, strandId, disclosure: first.disclosure, ...toConsent(first) });
      expect(asked).toBe(1);

      const second = redemption(token, strandId, 'second');
      await withStubbed(db, 'nextUseNumber', staleOnce(db, token, 1), async () => {
        await recorder.recordUsage({ token, strandId, disclosure: second.disclosure, ...toConsent(second) });
      });

      // One ask for the retried redemption, not two: `obtainApproval` lives a layer above the
      // retry loop and is never re-entered.
      expect(asked).toBe(2);

      const row = await rawDb.get(
        'select UseNumber, PeerKey, PeerSig, Disclosure, StrandId from CadreControl.FormationUsage where UsageStampId = ?',
        [second.usageStampId],
      );
      // Every field the approver signed over survived the retry byte-identical; only the use
      // number moved, which is exactly the field the approver deliberately does not sign.
      expect(row?.UseNumber).toBe(2);
      expect(row?.PeerKey).toBe(second.peerKey);
      expect(row?.PeerSig).toBe(second.peerSignature);
      expect(row?.Disclosure).toBe(second.disclosure);
      expect(row?.StrandId).toBe(strandId);
    });

    it('rolls the whole redemption back between attempts on the strand-seating path', async () => {
      // `redeemInvitation` writes Strand + FormationUsage in ONE transaction, so a failed
      // attempt must leave NEITHER behind — otherwise the retry's strand insert would collide
      // on the strand's own primary key and the retry could never land.
      const token = 'invite-redeem-retry-' + rand();
      await db.insertFormationInvite(token, 'sapp-redeem-retry', ownerPublicKey, signMessage, { totalUses: 3 });

      const firstStrand = 'strand-redeem-a-' + rand();
      await db.redeemInvitation({ token, strandId: firstStrand, ...mintConsent(token) });

      const retryStrand = 'strand-redeem-b-' + rand();
      const consent = mintConsent(token);
      await withStubbed(db, 'nextUseNumber', staleOnce(db, token, 1), async () => {
        expect((await db.redeemInvitation({ token, strandId: retryStrand, ...consent })).useNumber).toBe(2);
      });

      expect(await db.queryStrand(retryStrand)).not.toBeNull();
      expect(await useNumbersFor(token)).toEqual([1, 2]);
      // Exactly one strand row per redemption: the rolled-back attempt left nothing.
      const strands = await rawDb.get(
        'select count(1) as c from CadreControl.Strand where Id = ?', [retryStrand],
      );
      expect(Number(strands?.c ?? 0)).toBe(1);
    });

    it('retries a use number lost at COMMIT time, not only one lost on the insert', async () => {
      // The two lost-race surfaces fail at different MOMENTS, and only the primary-key one is
      // covered above. `Monotonic` carries a subquery, so Quereus defers it to `commit()` —
      // the surface a concurrent row the insert's key probe never saw arrives on, i.e. exactly
      // the cross-node race this retry exists for. It matters because the failure lands on the
      // commit rather than on a statement: `inTransaction`'s rollback must still have cleaned
      // the attempt's `Strand` row up, or the retry's strand insert collides and can never land.
      const token = 'invite-deferred-retry-' + rand();
      await db.insertFormationInvite(token, 'sapp-deferred-retry', ownerPublicKey, signMessage, {});

      const strandId = 'strand-deferred-' + rand();
      const consent = mintConsent(token);
      // Skipping ahead of max+1 fails `Monotonic` and nothing else (the invite is uncapped, so
      // `Authorized`'s seat clause cannot be what answers).
      await withStubbed(db, 'nextUseNumber', staleOnce(db, token, 7), async () => {
        expect((await db.redeemInvitation({ token, strandId, ...consent })).useNumber).toBe(1);
      });

      expect(await useNumbersFor(token)).toEqual([1]);
      const strands = await rawDb.get(
        'select count(1) as c from CadreControl.Strand where Id = ?', [strandId],
      );
      expect(Number(strands?.c ?? 0)).toBe(1);
    });

    it('retries a COMMIT-time loss on the bare-insert record path too', async () => {
      // The commit-time surface is covered above only for `redeemInvitation`, which wraps its
      // two inserts in an explicit `begin … commit`. The record-only path issues ONE insert and
      // lets it auto-commit, so the deferred `Monotonic` check fires on the statement's own
      // implicit commit rather than on an explicit one — a different moment, and the path
      // production actually races on (bound invites redeem here). Uncapped invite and no row at
      // #7, so `Monotonic` at commit is the ONLY thing that can refuse attempt 1: neither
      // `Authorized`'s seat clause nor a `(Token, UseNumber)` collision is reachable.
      const { token, strandId } = await boundInvite('deferred-record');
      await withStubbed(db, 'nextUseNumber', staleOnce(db, token, 7), async () => {
        expect((await db.recordFormationUsage({
          token, strandId, ...toConsent(redemption(token, strandId)),
        })).useNumber).toBe(1);
      });

      expect(await useNumbersFor(token)).toEqual([1]);
    });

    it('gives up after a bounded number of attempts instead of spinning', async () => {
      const { token, strandId } = await boundInvite('exhaust-attempts', { totalUses: 5 });
      const lostRace = await realLostRaceError();
      let writes = 0;

      await withStubbed(db, 'execFormationUsageInsert', async () => {
        writes++;
        throw lostRace;
      }, async () => {
        await expect(
          db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
        ).rejects.toBe(lostRace);
      });

      // `USE_NUMBER_ATTEMPTS` in control-database.ts. Bump it there and this number moves with
      // it — deliberately pinned so the bound cannot quietly become unbounded.
      expect(writes).toBe(3);
      expect(await useNumbersFor(token)).toEqual([]);
    });

    it('does NOT retry a duplicate nonce — one write attempt, then the replay refusal', async () => {
      const { token, strandId } = await boundInvite('nonce-no-retry', { totalUses: 3 });
      const consent = toConsent(redemption(token, strandId));
      expect((await db.recordFormationUsage({ token, strandId, ...consent })).useNumber).toBe(1);

      let writes = 0;
      await withStubbed(db, 'execFormationUsageInsert', countingInsert(db, () => { writes++; }), async () => {
        await expectUniqueViolation(
          db.recordFormationUsage({ token, strandId, ...consent }),
          'FormationUsage.UsageStampId',
        );
      });

      // A spent nonce is single-use BY DESIGN; retrying it would be replaying an approval.
      expect(writes).toBe(1);
      expect(await useNumbersFor(token)).toEqual([1]);
    });

    it('reports an exhausted invitation by name rather than as a retryable conflict', async () => {
      const { token, strandId } = await boundInvite('exhausted', { totalUses: 1 });
      expect((await db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) })).useNumber).toBe(1);

      // Attempt 1 takes the stale (already-taken) #1 and loses the race; attempt 2 reads #2,
      // which is past the invite's single seat. Left to the database that would surface as a
      // generic `Authorized` failure, which the manager reports as `Formation conflict, retry`
      // — sending the joiner around a loop that can never close.
      await withStubbed(db, 'nextUseNumber', staleOnce(db, token, 1), async () => {
        const error = await captureError(
          db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
        );
        expect(error).toBeInstanceOf(InvitationExhaustedError);
        // The three fields are the operator signal `provisionAsResponder` will log when it maps
        // this to a rejection (`debt-formation-approval-retry-wiring`), so they are part of the
        // contract, not incidental message text.
        const exhausted = error as InvitationExhaustedError;
        expect(exhausted.token).toBe(token);
        expect(exhausted.useNumber).toBe(2);
        expect(exhausted.totalUses).toBe(1);
      });

      expect(await useNumbersFor(token)).toEqual([1]);
    });

    it('abandons the redemption when the signal fires between attempts', async () => {
      const { token, strandId } = await boundInvite('abort-mid-loop', { totalUses: 3 });
      expect((await db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) })).useNumber).toBe(1);

      const controller = new AbortController();
      const original = internals(db).nextUseNumber!.bind(db);
      let reads = 0;
      const stub = async (t: string): Promise<number> => {
        reads++;
        if (reads === 1 && t === token) {
          // Hand back the number another writer already took, then give up: attempt 1 loses
          // the race and attempt 2 finds the signal aborted before it reads anything.
          controller.abort();
          return 1;
        }
        return await original(t);
      };

      await withStubbed(db, 'nextUseNumber', stub, async () => {
        await expect(
          db.recordFormationUsage({
            token, strandId, signal: controller.signal, ...toConsent(redemption(token, strandId)),
          }),
        ).rejects.toBeInstanceOf(FormationAbortedError);
      });

      // Attempt 2 never got as far as reading a use number, and nothing landed: the invite is
      // unspent past its first use, which is what `FormationAbortedError` promises its caller.
      expect(reads).toBe(1);
      expect(await useNumbersFor(token)).toEqual([1]);
    });

    it('lets an invite that expires mid-loop fail cleanly rather than retrying', async () => {
      // `nowMs` is re-derived per attempt, so an invite whose expiry passes between attempts
      // is refused by `Authorized` — non-retryable, a clean rejection.
      const { token, strandId } = await boundInvite('expiring-scratch');
      const expiring = 'invite-expiring-' + rand();
      await db.insertFormationInvite(expiring, 'sapp-expiring', ownerPublicKey, signMessage, {
        expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
      });
      await expectConstraintFailure(
        db.recordFormationUsage({ token: expiring, strandId, ...mintConsent(expiring) }),
        'Authorized',
      );
      expect(await useNumbersFor(token)).toEqual([]);
    });
  });

  /** Every `UseNumber` recorded for a token, ascending. */
  async function useNumbersFor(token: string): Promise<number[]> {
    const rows: number[] = [];
    for await (const row of rawDb.eval(
      'select UseNumber from CadreControl.FormationUsage where Token = ? order by UseNumber',
      [token],
    )) {
      rows.push(row.UseNumber as number);
    }
    return rows;
  }

  /** Just the joiner's consent triple, for spreading into a write call. */
  function toConsent(r: Redemption): JoinerConsent {
    return { peerKey: r.peerKey, usageStampId: r.usageStampId, peerSignature: r.peerSignature };
  }

  /**
   * A `nextUseNumber` stub that hands back `stale` the FIRST time it is asked about `token`
   * and delegates afterwards — the deterministic stand-in for another writer having committed
   * that number between our read and our write.
   */
  function staleOnce(target: ControlDatabase, token: string, stale: number): (t: string) => Promise<number> {
    const original = internals(target).nextUseNumber!.bind(target);
    let served = false;
    return async (t: string): Promise<number> => {
      if (!served && t === token) {
        served = true;
        return stale;
      }
      return await original(t);
    };
  }

  /** A pass-through `execFormationUsageInsert` that counts how many attempts were issued. */
  function countingInsert(
    target: ControlDatabase,
    onWrite: () => void,
  ): (opts: { token: string; useNumber: number }) => Promise<void> {
    const original = internals(target).execFormationUsageInsert!.bind(target);
    return async (opts): Promise<void> => {
      onWrite();
      return await original(opts);
    };
  }
});
