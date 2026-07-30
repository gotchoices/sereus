import { expect } from 'vitest';

/**
 * Assert a control-plane write was rejected by one of the NAMED CHECK constraints, not by
 * an incidental SQL, binding, or transaction error.
 *
 * A bare `rejects.toThrow()` goes green on a mistyped statement, which would silently
 * retire the attack the test claims to pin — so every authorization rejection assertion in
 * the `CadreControl` suites routes through here. Shared by every `CadreControl` spec that
 * asserts a rejection (`control-revocation-replay`, `control-authorization-binding`,
 * `control-authorization-domain-separation`, `control-ownerkey-self-authorization`): they
 * are halves of the same rule set and must agree on what "rejected by the schema" looks like.
 *
 * Passing MORE THAN ONE constraint name widens the assertion, so callers should instead
 * arrange the write so exactly one constraint can fail (e.g. a delete-authorization test
 * files its `Revocation` tombstone in the same transaction, satisfying
 * `RevocationRecorded` and leaving only `AuthorizedDelete` able to reject).
 *
 * NOTE: that single-rejector technique leans on Quereus reporting ONE violated deferred
 * constraint per commit. If the engine ever reports a different one of several violated
 * deferred CHECKs, these name assertions become flaky — diagnose it as an engine
 * reporting change, do not widen the accepted-name list to make the suite green.
 */
export function expectConstraintFailure(write: Promise<unknown>, ...constraints: string[]) {
  return expect(write).rejects.toThrow(
    new RegExp(`CHECK constraint failed: (${constraints.join('|')})\\b`),
  );
}

/**
 * Assert a write was refused by a `unique` / primary-key collision on the named columns —
 * the OTHER way the control schema refuses a replay, for the anti-replay stamp columns whose
 * uniqueness is enforced on the insert itself rather than as a named deferred CHECK.
 *
 * Columns are given fully qualified and in the order the schema declares them, e.g.
 * `expectUniqueViolation(write, 'FormationUsage.UsageStampId')` or, for a composite key,
 * `expectUniqueViolation(write, 'FormationUsage.Token', 'FormationUsage.UseNumber')`.
 *
 * NOTE: unlike a named CHECK, this message is not something the schema promises — it is the
 * wording the optimystic vtab renders (`optimystic-module.ts` → `uniqueConstraintMessage`,
 * which qualifies by table name only, no schema prefix). It lives here rather than inline at
 * each call site so a reworded storage-layer error is one edit, and so a spec that greps green
 * cannot quietly be reading a DIFFERENT failure than the collision it means to pin.
 */
export function expectUniqueViolation(write: Promise<unknown>, ...columns: string[]) {
  const escaped = columns.map(column => column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return expect(write).rejects.toThrow(
    new RegExp(`UNIQUE constraint failed: ${escaped.join(', ')}`, 'i'),
  );
}
