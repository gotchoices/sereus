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
 * what the engine emits.
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
      // Reproduced here by skipping ahead of max+1 on an uncapped invite, so `Authorized`
      // (which would also reject an over-limit use number) cannot be what answers.
      const { token, strandId, strandStampId } = await boundInvite('monotonic');
      const error = await captureError(
        rawInsertFormationUsage({ token, useNumber: 7, strandId, strandStampId }),
      );
      expect(String(error)).toMatch(/CHECK constraint failed: Monotonic\b/);
      expect(isLostUseNumberRace(error)).toBe(true);
    });

    it('REJECTS a real duplicate-nonce violation — replay is not a race', async () => {
      const { token, strandId, strandStampId } = await boundInvite('nonce-dup');
      const consent = mintConsent(token);
      await rawInsertFormationUsage({ token, useNumber: 1, strandId, strandStampId, consent });

      // Use #2 is monotonic and within the (uncapped) invite, so the repeated nonce is the
      // only thing that can refuse this row.
      const error = await captureError(
        rawInsertFormationUsage({ token, useNumber: 2, strandId, strandStampId, consent }),
      );
      expect(String(error)).toMatch(/UNIQUE constraint failed: FormationUsage\.UsageStampId/i);
      expect(isLostUseNumberRace(error)).toBe(false);
    });

    it('rejects a real `Authorized` CHECK failure and non-Error values', async () => {
      // `Authorized` renders with the same `CHECK constraint failed:` prefix as `Monotonic`,
      // so a prefix-only match would retry an expired/exhausted/unapproved invite forever.
      const { token, strandId, strandStampId } = await boundInvite('authorized', { totalUses: 1 });
      await rawInsertFormationUsage({ token, useNumber: 1, strandId, strandStampId });
      const error = await captureError(
        rawInsertFormationUsage({ token, useNumber: 2, strandId, strandStampId }),
      );
      expect(String(error)).toMatch(/CHECK constraint failed: Authorized\b/);
      expect(isLostUseNumberRace(error)).toBe(false);

      expect(isLostUseNumberRace(undefined)).toBe(false);
      expect(isLostUseNumberRace('UNIQUE constraint failed: FormationUsage.Token, FormationUsage.UseNumber')).toBe(false);
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
      // The loser reads use #2 under the lock and is refused by `Authorized`'s seat clause —
      // non-retryable, so the retry cannot manufacture a seat the invite does not have.
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(rejected.reason)).toMatch(/CHECK constraint failed: Authorized\b/);
      expect(await usageCount()).toBe(before + 1);
      expect(await useNumbersFor(token)).toEqual([1]);
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
        await expect(
          db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
        ).rejects.toBeInstanceOf(InvitationExhaustedError);
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
