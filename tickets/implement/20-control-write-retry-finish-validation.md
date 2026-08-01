----
description: The retry-on-transient-failure change for shared-settings writes is fully built and documented; one test assertion was just corrected and the test suite needs one confirming re-run before the work is handed to review.
prereq:
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, docs/architecture.md, docs/cadre-consistency.md, packages/quereus-plugin-sereus/src/cluster-size.ts
difficulty: easy
----

# Finish validation of the bounded control-write retry, then hand off to review

Continuation of `control-write-transient-failure-retry` (original ticket deleted — this
replaces it). The implementation is COMPLETE; the prior run hit its token budget right
after fixing a test-authoring bug, so the only unverified step is one spec re-run.

## What is already done (do not redo — verify by reading the files)

**Product code — complete, builds clean, lints clean:**

- `packages/cadre-core/src/control-write-retry.ts` — classifier
  (`isRetriableControlWriteFailure`, message-based via Quereus `unwrapError`, matches the
  transactor aggregate `Some peers did not complete:` and the zero-rejection
  super-majority shortfall only) + loop (`retryControlWrite`: 3 attempts, 10 s elapsed
  budget checked after a failed attempt before sleeping, backoff 250 ms/1 s jittered ±50%
  capped at 1 s, last error rethrown by identity, injectable `sleep`/`now`/`delaysMs`
  seams, logs at `sereus:cadre:control-db`).
- `packages/cadre-core/src/control-database.ts` — private `lockedWithRetry` wraps
  `retryControlWrite(() => this.withWriteLock(fn), this.controlWriteRetryPacing)`; ALL six
  former `withWriteLock` call sites repointed (`execWrite`, `mutateCadrePeer`, the three
  `deleteGuardedRow` wrappers, `withUseNumberRetry`'s inner lock); `withWriteLock` left as
  the bare public primitive; private `controlWriteRetryPacing` field is the spec pacing
  seam; doc comments on `withWriteLock`/`mutateCadrePeer`/`execWrite` extended with the
  atomic-and-re-runnable body contract and the retry-outside-the-lock reasoning; a code
  comment at `withUseNumberRetry`'s inner lock states classifier disjointness.
- `packages/cadre-core/src/index.ts` — exports `CONTROL_WRITE_ATTEMPTS`,
  `CONTROL_WRITE_RETRY_BUDGET_MS`, `isRetriableControlWriteFailure`, `retryControlWrite`,
  `type ControlWriteRetryOptions`.

**Docs — complete:**

- `docs/architecture.md` → "Replication cluster size": new bullet with the full
  no-viable-threshold arithmetic (`T ≤ 2/3` vs partition-safety `T > 2/3` at admission
  fraction 0.75; `membershipAdmissionFraction` not embedder-settable so the escape hatch
  is an upstream Optimystic change; lowering buys nothing at four machines, impossible at
  two) and the retry policy/budget rationale.
- `packages/quereus-plugin-sereus/src/cluster-size.ts` — `CONTROL_CLUSTER_POLICY` doc
  comment: absent `superMajorityThreshold` is a researched decision, pointer to the
  architecture section.
- `docs/cadre-consistency.md` — "What it costs" paragraph gained the one clause naming
  the retry, pointing at the architecture section.

**Tests — written; 46/47 passed on the last full run:**

- `packages/cadre-core/test/control-write-retry.spec.ts` (new, pure unit): classifier
  table through three-level nested `cause` chains (both retriable messages, non-zero-
  rejection shortfall, constraint failures, non-`Error` throws), classifier disjointness
  with `isLostUseNumberRace` from both directions, loop success-on-attempt-2, exhaustion
  identity-rethrow, budget-consumed-in-one-attempt (degraded-member case, zero sleeps),
  non-retriable-once, jitter floor/cap bounds via recorded sleep, and a composed
  use-number-outer-loop simulation pinning total attempts at 3 (never 9).
- `packages/cadre-core/test/control-write-lock.spec.ts` (two additions): head-of-line —
  a write queued while the first sleeps out its backoff commits during the backoff
  (deterministic via injected manually-released sleep on the `controlWriteRetryPacing`
  slot); notification count — exactly one membership notification across a retried
  `mutateCadrePeer`, zero on exhaustion, exhaustion error surfaces by identity.

**The one failure and its fix:** the exhaustion test originally asserted
`.rejects.toBe(errors[errors.length - 1])` — the argument was evaluated before the loop
finished, so it compared against the FIRST error (the loop behaviour itself was correct;
same-message errors "serialize to the same string"). Already rewritten to catch into a
variable and assert identity + `errors` length after settle. This fix is UNVERIFIED — it
is the whole reason this ticket exists.

## TODO

- From `packages/cadre-core`, re-run
  `yarn vitest run test/control-write-retry.spec.ts test/control-write-lock.spec.ts test/control-database-solo.spec.ts test/control-database-offline-peers.spec.ts test/control-formation-use-number-retry.spec.ts 2>&1 | tee /tmp/cadre-core-retry.log`
  and confirm all green (build and lint already pass at repo root; re-run only if you
  change code). Do NOT run the integration package — that is the follow-up ticket
  `control-write-retry-real-error-coverage`.
- On green, write the review/ handoff for the whole
  `control-write-transient-failure-retry` change (summary of the above, emphasizing:
  the zero-vs-non-zero-rejection classifier line as the most load-bearing behavior;
  the literal-string dependency on engine error text, with real-engine coverage
  deferred to follow-up ticket `control-write-retry-real-error-coverage`; solo/offline
  specs pass unedited; integration scenarios intentionally not run) and delete this
  ticket.
- If anything fails, fix within scope of the retry change before handing off.
