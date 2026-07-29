import { expect } from 'vitest';

/**
 * Assert a control-plane write was rejected by one of the NAMED CHECK constraints, not by
 * an incidental SQL, binding, or transaction error.
 *
 * A bare `rejects.toThrow()` goes green on a mistyped statement, which would silently
 * retire the attack the test claims to pin — so every authorization rejection assertion in
 * the `CadreControl` suites routes through here. Shared between
 * `control-revocation-replay.spec.ts` and `control-authorization-binding.spec.ts`: the two
 * halves of the same rule set (delete + tombstone, and insert/update binding) must agree on
 * what "rejected by the schema" looks like.
 */
export function expectConstraintFailure(write: Promise<unknown>, ...constraints: string[]) {
  return expect(write).rejects.toThrow(
    new RegExp(`CHECK constraint failed: (${constraints.join('|')})\\b`),
  );
}
