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
 * `ControlDatabase`'s seat-budget enforcement over the nonce-keyed `FormationUsage` design.
 *
 * Every redemption writes under the joiner's own single-use nonce (`UsageStampId`, the
 * table's PRIMARY KEY), so concurrent redemptions of one token never contend for a shared
 * row key — there is no lost race and no retry machinery. What remains to enforce is the
 * invite's seat budget, and it is enforced by COUNT against committed rows, twice over:
 *
 *  - `assertSeatRemains`, inside the write lock ahead of the write, which raises the NAMED
 *    `InvitationExhaustedError` so a spent invite is never reported as a retryable conflict
 *    (an invitation's `ValidationUrl` hook can be a HUMAN review queue — a joiner told to
 *    retry something that can never succeed burns that queue for nothing);
 *  - the schema's own count-based cap clause in `FormationUsage.Authorized`, asserted here
 *    with raw inserts that bypass the TypeScript guard, so the cap does not rest on it.
 *
 * Concurrency here means "started in the same tick without awaiting the first", the idiom
 * `control-write-lock.spec.ts` documents. On ONE node the local write queue serializes the
 * writers, so the loser reads the winner's committed row and is refused at the cap; the
 * CROSS-node over-admission this design deliberately accepts cannot occur on a single node
 * and is exercised by the `formation-concurrent-redemption` e2e work instead — nothing here
 * stubs a fake race to simulate it.
 *
 * Boots a real `CadreNode` (empty bootstrap, transaction profile) so every constraint,
 * rollback, and engine error message below is the real one. That real-error material also
 * serves `isRetriableControlWriteFailure`'s negative half (last describe below), the one
 * text-reading classifier left on this path.
 */

/** The approval material for one redemption, alongside the fields it is bound to. */
interface Redemption extends JoinerConsent {
  token: string;
  strandId: string;
  disclosure: string;
}

/**
 * Test-only window onto the private member the duplicate-nonce case shadows. The repo
 * precedent is `control-write-lock.spec.ts`'s `selfRegistrationTimerSlot`.
 *
 * Optional so a stub can be removed with `delete`, restoring the prototype's own
 * implementation — assigning the stub creates an OWN property that shadows it, so deleting
 * that property is the restore.
 */
interface ControlDatabaseInternals {
  execFormationUsageInsert?: (opts: { token: string }) => Promise<void>;
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

describe('ControlDatabase — seat budget over nonce-keyed redemptions', () => {
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

  async function strandCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.Strand');
    return Number(row?.c ?? 0);
  }

  /**
   * A bound invite plus its owner-signed host strand — the shape production actually runs,
   * since `cadre-web` / `cadre-phone` publish strand-bound invites and those redeem
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
   * way to bypass `assertSeatRemains` and to capture the engine's REAL rejection messages.
   */
  async function rawInsertFormationUsage(opts: {
    /** `null` is reachable only from the null-Token case below; every other caller passes one. */
    token: string | null;
    strandId: string;
    strandStampId: string;
    consent?: JoinerConsent;
    disclosure?: string;
  }): Promise<void> {
    const now = await canonicalDatetime(rawDb, Date.now());
    const disclosure = opts.disclosure ?? '';
    const consent = opts.consent ?? mintConsent(opts.token ?? '', disclosure);
    await rawDb.exec(
      `insert into CadreControl.FormationUsage (Token, UsageStampId, PeerKey, PeerSig, Disclosure, StrandId, StrandStampId)
         with context Now = ?, ValidationKey = null, ValidationSignature = null
         values (?, ?, ?, ?, ?, ?, ?)`,
      [
        now, opts.token,
        consent.usageStampId, consent.peerKey, consent.peerSignature,
        disclosure, opts.strandId, opts.strandStampId,
      ],
    );
  }

  /**
   * A REAL `FormationUsage.UsageStampId` primary-key collision: the same nonce replayed
   * verbatim on an uncapped invite, so the repeated nonce is the only possible refusal.
   */
  async function realDuplicateNonceError(): Promise<unknown> {
    const { token, strandId, strandStampId } = await boundInvite('nonce-dup');
    const consent = mintConsent(token);
    await rawInsertFormationUsage({ token, strandId, strandStampId, consent });
    return await captureError(
      rawInsertFormationUsage({ token, strandId, strandStampId, consent }),
    );
  }

  /** A REAL `Authorized` CHECK failure: a second seat on a single-use invite, raw. */
  async function realAuthorizedFailureError(): Promise<unknown> {
    const { token, strandId, strandStampId } = await boundInvite('authorized', { totalUses: 1 });
    await rawInsertFormationUsage({ token, strandId, strandStampId });
    return await captureError(rawInsertFormationUsage({ token, strandId, strandStampId }));
  }

  beforeAll(async () => {
    const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    signMessage = (message) =>
      cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: { partyId: 'seat-budget-' + rand(), bootstrapNodes: [] },
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

  describe('concurrent redemptions on one node', () => {
    it('lands both uses of a two-use invite, asking the approval hook exactly twice', async () => {
      // The regression the nonce-keyed design guards against: two same-tick redemptions must
      // BOTH land — under distinct row keys — with neither erasing the other and no granted
      // approval discarded for a second human review.
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

      expect(await usageStampsFor(token)).toEqual([first.usageStampId, second.usageStampId].sort());
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
      // The local write queue serializes the two writes, so the loser's seat check counts the
      // winner's committed row against the cap and refuses BY NAME: a same-node race is caught
      // the same way a sequential latecomer is.
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(InvitationExhaustedError);
      const exhausted = rejected.reason as InvitationExhaustedError;
      expect(exhausted.token).toBe(token);
      expect(exhausted.usesRecorded).toBe(1);
      expect(exhausted.totalUses).toBe(1);
      expect(await usageCount()).toBe(before + 1);
      expect(await usageStampsFor(token)).toHaveLength(1);
    });

    /**
     * The two cases below race the RECORDER, which is the production shape: it has already read
     * the invite, so it hands `totalUses` down and the seat check re-reads nothing. The case
     * above races `ControlDatabase` directly, omitting that parameter and falling back to the
     * read inside `assertSeatRemains` — so without these, a recorder that threaded the wrong
     * budget (or dropped it to `null`) would leave every case green and quietly restore the
     * generic `CHECK constraint failed: Authorized` the joiner is told to retry.
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
      expect(await usageStampsFor(token)).toHaveLength(1);
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

      const strandsBefore = await strandCount();
      const results = await Promise.allSettled([provision(), provision()]);

      const seated = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ strandId: string }>[];
      expect(seated).toHaveLength(1);
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(InvitationExhaustedError);
      expect((rejected.reason as InvitationExhaustedError).usesRecorded).toBe(1);
      expect(await usageStampsFor(token)).toHaveLength(1);
      expect(await db.queryStrand(seated[0]!.value.strandId)).not.toBeNull();
      // Exactly ONE new Strand row: the loser is refused by the seat check AHEAD of
      // `redeemInvitation`'s transaction, so it never seats a strand it then has to roll back.
      // Counted rather than read by id — the loser's id is minted inside the recorder and is
      // unreachable from here, so a count is the only way to see an orphan at all.
      expect(await strandCount()).toBe(strandsBefore + 1);
    });
  });

  describe('the seat cap is counted, not sequenced', () => {
    it('reports a sequentially exhausted invitation by name rather than as a retryable conflict', async () => {
      // Two redemptions in a row on one converged node: the second reads count 1 against the
      // single seat and is refused AHEAD of the write. Left to the database that would surface
      // as a generic `Authorized` failure, which the manager reports as `Formation conflict,
      // retry` — sending the joiner around a loop that can never close.
      const { token, strandId } = await boundInvite('exhausted', { totalUses: 1 });
      const winner = redemption(token, strandId);
      expect((await db.recordFormationUsage({ token, strandId, ...toConsent(winner) })).usageStampId)
        .toBe(winner.usageStampId);

      const error = await captureError(
        db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
      );
      expect(error).toBeInstanceOf(InvitationExhaustedError);
      // The three fields are the operator signal `provisionAsResponder` logs when it maps
      // this to a rejection, so they are part of the contract, not incidental message text.
      const exhausted = error as InvitationExhaustedError;
      expect(exhausted.token).toBe(token);
      expect(exhausted.usesRecorded).toBe(1);
      expect(exhausted.totalUses).toBe(1);

      expect(await usageStampsFor(token)).toEqual([winner.usageStampId]);
    });

    it('the schema\'s own count-based cap refuses an over-cap raw insert (Authorized)', async () => {
      // The named error above comes from a TypeScript guard ahead of the write; the cap must
      // not REST on that guard. A raw insert bypasses it, so the count-based clause inside
      // `FormationUsage.Authorized` — reading committed.* at commit — is the only refusal left.
      const { token, strandId, strandStampId } = await boundInvite('raw-cap', { totalUses: 1 });
      await rawInsertFormationUsage({ token, strandId, strandStampId });

      await expectConstraintFailure(
        rawInsertFormationUsage({ token, strandId, strandStampId }),
        'Authorized',
      );
      expect(await usageStampsFor(token)).toHaveLength(1);
    });

    it('refuses a null Token outright, rather than leaving it to Authorized', async () => {
      // `Token` left the primary key in this design and so lost the key's implicit non-nullity;
      // the column carries `not null` explicitly to keep the invariant stated where it belongs.
      // `Authorized` would refuse a null anyway (its FormationInvite exists-clause cannot match
      // `null = null`), so this case exists to prove the column constraint is REAL — without it
      // the comment on the column would be describing a guard the engine never applies.
      const { strandId, strandStampId } = await boundInvite('null-token');
      const before = await usageCount();

      const error = await captureError(
        rawInsertFormationUsage({ token: null, strandId, strandStampId }),
      );
      expect(String(error)).toMatch(/not null|NOT NULL/i);
      expect(String(error)).not.toMatch(/Authorized/);
      expect(await usageCount()).toBe(before);
    });

    it('admits exactly TotalUses rows under unrelated nonces and refuses the next', async () => {
      // The cap is a COUNT over committed rows — no ordering, no sequence numbers. The two
      // admitted rows carry nonces that are unrelated by construction, and no assertion here
      // depends on any ordering between them.
      const { token, strandId } = await boundInvite('two-seats', { totalUses: 2 });
      const first = redemption(token, strandId, 'first');
      const second = redemption(token, strandId, 'second');

      expect((await db.recordFormationUsage({ token, strandId, disclosure: first.disclosure, ...toConsent(first) })).usageStampId)
        .toBe(first.usageStampId);
      expect((await db.recordFormationUsage({ token, strandId, disclosure: second.disclosure, ...toConsent(second) })).usageStampId)
        .toBe(second.usageStampId);

      const error = await captureError(
        db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) }),
      );
      expect(error).toBeInstanceOf(InvitationExhaustedError);
      expect((error as InvitationExhaustedError).usesRecorded).toBe(2);
      expect((error as InvitationExhaustedError).totalUses).toBe(2);

      expect(await usageStampsFor(token)).toEqual([first.usageStampId, second.usageStampId].sort());
    });

    it('does NOT retry a duplicate nonce — one write attempt, then the replay refusal', async () => {
      const { token, strandId } = await boundInvite('nonce-no-retry', { totalUses: 3 });
      const consent = toConsent(redemption(token, strandId));
      expect((await db.recordFormationUsage({ token, strandId, ...consent })).usageStampId)
        .toBe(consent.usageStampId);

      let writes = 0;
      await withStubbed(db, 'execFormationUsageInsert', countingInsert(db, () => { writes++; }), async () => {
        await expectUniqueViolation(
          db.recordFormationUsage({ token, strandId, ...consent }),
          'FormationUsage.UsageStampId',
        );
      });

      // A spent nonce is single-use BY DESIGN; retrying it would be replaying an approval.
      expect(writes).toBe(1);
      expect(await usageStampsFor(token)).toEqual([consent.usageStampId]);
    });

    it('abandons the redemption when the signal has fired, leaving the seat unspent', async () => {
      const { token, strandId } = await boundInvite('abort-before-write', { totalUses: 1 });

      const controller = new AbortController();
      controller.abort();
      await expect(
        db.recordFormationUsage({
          token, strandId, signal: controller.signal, ...toConsent(redemption(token, strandId)),
        }),
      ).rejects.toBeInstanceOf(FormationAbortedError);

      // Nothing landed, which is what `FormationAbortedError` promises its caller: the single
      // seat is still free for the joiner's retry.
      expect(await usageStampsFor(token)).toHaveLength(0);
      await db.recordFormationUsage({ token, strandId, ...toConsent(redemption(token, strandId)) });
      expect(await usageStampsFor(token)).toHaveLength(1);
    });

    it('lets an expired invite fail cleanly rather than as exhaustion', async () => {
      // `nowMs` is derived at write time, so an expired invite is refused by `Authorized` —
      // non-retryable, a clean rejection, and never misreported as a spent seat budget.
      const { strandId } = await boundInvite('expiring-scratch');
      const expiring = 'invite-expiring-' + rand();
      await db.insertFormationInvite(expiring, 'sapp-expiring', ownerPublicKey, signMessage, {
        expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
      });
      await expectConstraintFailure(
        db.recordFormationUsage({ token: expiring, strandId, ...mintConsent(expiring) }),
        'Authorized',
      );
      expect(await usageStampsFor(expiring)).toHaveLength(0);
    });
  });

  /**
   * The one classifier that reads error text on this path: `isRetriableControlWriteFailure`,
   * which decides whether a failed control write is re-presented to the cluster. Its unit spec
   * (`control-write-retry.spec.ts`) can only assert against message literals, so the half of its
   * contract that a real engine can produce is pinned here instead — against the same real
   * objects, not transcriptions of them.
   *
   * Only the NEGATIVE half is producible without a network. Every error below MUST classify
   * non-retriable: re-presenting a write the cohort actually REFUSED would re-present a spent
   * signature, and on a capped invite it could manufacture a seat the invite does not have.
   * This is the surviving half of the disjointness property the deleted use-number retry loop
   * carried — a constraint failure must never be retried as transient.
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
      const duplicateNonce = await realDuplicateNonceError();
      // Pin the primary-key collision's wording alongside the classification: this is the
      // surface a verbatim replay arrives on, and `expectUniqueViolation` call sites across
      // the formation suites assume this exact rendering.
      expect(String(duplicateNonce)).toMatch(/UNIQUE constraint failed: FormationUsage\.UsageStampId/i);

      const authorized = await realAuthorizedFailureError();
      expect(String(authorized)).toMatch(/CHECK constraint failed: Authorized\b/);

      for (const failure of [duplicateNonce, authorized]) {
        // Non-vacuity: the classifier returns false for ANY non-`Error`, so without this the
        // case would still pass if the engine ever threw something that is not an Error and
        // the message-matching arm were never exercised at all.
        expect(failure).toBeInstanceOf(Error);
        expect(isRetriableControlWriteFailure(failure)).toBe(false);
      }
    });
  });

  /** Every `UsageStampId` recorded for a token, sorted (the rows carry no ordering). */
  async function usageStampsFor(token: string): Promise<string[]> {
    const stamps: string[] = [];
    for await (const row of rawDb.eval(
      'select UsageStampId from CadreControl.FormationUsage where Token = ?',
      [token],
    )) {
      stamps.push(row.UsageStampId as string);
    }
    return stamps.sort();
  }

  /** Just the joiner's consent triple, for spreading into a write call. */
  function toConsent(r: Redemption): JoinerConsent {
    return { peerKey: r.peerKey, usageStampId: r.usageStampId, peerSignature: r.peerSignature };
  }

  /** A pass-through `execFormationUsageInsert` that counts how many attempts were issued. */
  function countingInsert(
    target: ControlDatabase,
    onWrite: () => void,
  ): (opts: { token: string }) => Promise<void> {
    const original = internals(target).execFormationUsageInsert!.bind(target);
    return async (opts): Promise<void> => {
      onWrite();
      return await original(opts);
    };
  }
});
