description: When two people accept the same invitation at once, the one who loses the race no longer has to get approved a second time — the node quietly re-uses the approval it already has. This was written earlier but never compiled or run; it has now been built, tested, and corrected.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: medium
----

# Re-present a granted approval after a lost formation race — database layer

## The problem this solves

An invitation can be metered: `FormationInvite.TotalUses` says how many peers may join with it,
and each redemption gets a 1-based `UseNumber` computed as `max(UseNumber) + 1` over the rows
already recorded. An invitation can also carry a `ValidationUrl` — an approval hook that may
front a **human review queue**.

Before this change, the use number was read OUTSIDE the write lock. Two redemptions of one
token that overlapped both computed the same number; one committed, the other was refused on
the `(Token, UseNumber)` primary key. The loser's approval was already granted — and it was
thrown away, sending a person back to re-approve a join they had already approved.

The approver deliberately signs over five fields — token, nonce (`UsageStampId`), strand id,
joining peer key, disclosure — and **not** the use number, precisely so the approval survives
being re-presented under a different one. Nothing was using that property. Now it is.

## What shipped

All in `packages/cadre-core/`.

### `src/control-database.ts`

- **`nextUseNumber` moved inside the write lock.** This alone fixes the common case: two
  redemptions of one token on the SAME node are serialized by the existing local write queue,
  so the second reads a number the first already committed and there is no collision at all.
- **`withUseNumberRetry(token, operation, signal, write)`** (private). Up to
  `USE_NUMBER_ATTEMPTS = 3` attempts. Per attempt, under `withWriteLock`: abort check →
  `nextUseNumber` → (attempt > 1 only) `assertSeatRemains` → `write(useNumber)`. Retries only
  when `isLostUseNumberRace`; rethrows the last engine error when attempts run out. `write`
  receives ONLY the use number — every other field is closed over by the caller, so a retry
  re-presents a byte-identical approval by construction, and the approval hook (which lives a
  layer up in `ControlFormationUsageRecorder`) is unreachable from inside the loop.
- **`isLostUseNumberRace(error)`** (exported). Message-based, walking the `cause` chain with
  Quereus' `unwrapError`. Matches the `(Token, UseNumber)` primary-key collision and
  `CHECK constraint failed: Monotonic`. Deliberately NOT `instanceof`-gated: the deferred
  `Monotonic` failure is a bare `QuereusError`, not a `ConstraintError`.
- **`InvitationExhaustedError(token, useNumber, totalUses)`** (exported class). Raised by
  `assertSeatRemains` on a RETRY whose new use number is past `TotalUses`, so an unwinnable
  situation is named instead of surfacing as a generic `Authorized` CHECK failure.
- `redeemInvitation` and `recordFormationUsage` both route their write through
  `withUseNumberRetry`. Each mints/reads its `strandStampId` ONCE, outside the loop.

### `src/control-formation-recorder.ts`

Doc-comment only. `provisionAndRecord`'s paragraph claimed the loser of a concurrent
single-use redemption collides on the `(Token, UseNumber)` primary key. That is no longer how
the loser fails on the same node — it reads a fresh use number under the lock and is refused
by `FormationUsage.Authorized`'s seat clause, or by `InvitationExhaustedError` on a retry.
Corrected.

### `test/control-formation-use-number-retry.spec.ts` (new, 14 cases)

Boots a real `CadreNode` (`profile: 'transaction'`, empty bootstrap). Every engine error the
classifier is asked about is produced by the REAL engine, never a string literal — a reworded
storage-layer message must redden this spec rather than silently disable the retry.

### `test/control-formation-invite.spec.ts`

Comment only: a cross-reference on the pre-existing "lets the loser of a use-number race retry
the SAME approval" case explaining why it is NOT a duplicate of the new spec (it drives the
retry by hand to pin the nonce design; the new spec pins the automatic loop).

## Validation actually run

From `packages/cadre-core`, all confirmed green in this run:

- `yarn typecheck` — exit 0.
- `yarn build` — exit 0.
- `npx eslint` over all four touched files — exit 0. (Note: `cadre-core` has no `lint` script;
  lint lives at the repo root as `eslint .`.)
- `npx vitest run test/control-formation-use-number-retry.spec.ts` — **14/14 pass**.
- `npx vitest run` (whole package) — **83 files, 1309 pass, 1 skipped**. The skip is
  pre-existing and unrelated; no `.pre-existing-error.md` was needed.

Every open question the prior run flagged as unverified is now answered by an executed test:

| Prior unknown | Resolved |
|---|---|
| `unwrapError` shape / does its `ErrorInfo[]` include the outer message | Yes — classifier cases pass on real transaction-wrapped errors |
| Does the `UseNumber: 7` insert really reach `Monotonic` | Yes — asserted on the real message |
| Does `inTransaction`'s rollback really remove the `Strand` row | Yes — both pre-commit and commit-time failures leave nothing; "mint `strandStampId` once" was correct |
| `withStubbed`'s `delete slot[name]` under repo lint/TS | Clean |
| `db.getDatabase().get(...)` / `.eval(...)` helper usage | Works |

## Cases the new spec pins

Classifier (all from real engine errors):
- real `(Token, UseNumber)` primary-key collision → `true`
- real DEFERRED `Monotonic` CHECK failure → `true`
- real duplicate `UsageStampId` → `false` (replay is not a race)
- real `Authorized` CHECK failure, and non-`Error` values → `false`

Behaviour:
- two concurrent `recordUsage` calls on a two-use bound invite land `[1, 2]`, with a counting
  fake approver asked **exactly twice** — the primary regression
- two concurrent redemptions of a SINGLE-use invite: exactly one lands, loser refused by
  `Authorized`, one row
- a stale use number is retried and lands at #2 with the hook asked ONCE; the stored row's
  `PeerKey` / `PeerSig` / `Disclosure` / `StrandId` are byte-identical to what was passed
- `redeemInvitation` retry rolls the `Strand` insert back too (pre-commit failure)
- **a use number lost at COMMIT time** (deferred `Monotonic`) is retried and the rolled-back
  attempt's `Strand` row is gone — added in this run; previously only the pre-commit surface
  was covered
- attempts are bounded: stubbed always-lost-race insert → exactly 3 writes
- a duplicate nonce is written once and NOT retried
- exhausted invite on a retry → `InvitationExhaustedError`
- signal firing between attempts → `FormationAbortedError`, use number never re-read
- expired invite → clean `Authorized` rejection, no retry

## Known gaps — please treat these as the floor, not the ceiling

**Every "lost race" in the spec is simulated on one node.** The retry exists for writers the
write lock cannot reach (another cadre node, another `Database` handle over the same store),
and no case drives two real handles concurrently. Losses are staged either by stubbing the
private `nextUseNumber` to hand back a stale number, or by stubbing
`execFormationUsageInsert` to throw a previously-captured real error. So the retry LOOP is
exercised with real engine errors, but the concurrency that produces them in production is
not. A genuine two-node case belongs in `integration-tests`, which was not run here (real
network, out of this ticket's scope).

**`InvitationExhaustedError` still reaches the joiner as `Formation conflict, retry`.**
`strand-formation-manager.ts:354`'s catch-all maps every unrecognised error to that string, so
the joiner-visible benefit of naming exhaustion is not there yet. That is exactly what
`debt-formation-approval-retry-wiring` (already in `implement/`, prereq'd on this slug) is for
— not a defect in this ticket, but do not read the new error class as user-visible today.

**`InvitationExhaustedError` and `isLostUseNumberRace` are exported from
`control-database.ts` but NOT from `src/index.ts`.** Consistent with `FormationAbortedError`,
which is also package-internal. Fine for the manager (same package); the wiring ticket may
need to widen `index.ts` if anything outside `cadre-core` must `instanceof` them.

**The retry has no backoff and no jitter.** Three attempts fire back-to-back, each taking and
releasing the write lock. Under sustained cross-node contention on one hot token, all three can
burn against the same competitor and the caller gets the engine's error. Deliberate — the
alternative is holding the write lock hostage — and the bound is pinned by a test, but it is a
policy choice a reviewer should agree with rather than inherit.

**`assertSeatRemains` runs only on retries.** A first attempt is left to
`FormationUsage.Authorized`'s own seat clause, on the argument that
`StrandFormationManager.validateToken` already gated it and re-reading the invite would cost
every redemption a read for nothing. If that upstream gate is ever removed, the first attempt's
exhaustion silently reverts to a generic `Authorized` failure.

**No tripwires were parked in code this run** — nothing surfaced that was fine-now-but-
conditional and lacked an existing NOTE. The two performance NOTEs already in
`control-database.ts` (`queryRevokedStamps` re-reads the retired set; `hasOutstandingFormationInvite`
scans every invite row) are pre-existing and untouched.

## Suggested review focus

- Is message-matching on engine error text acceptable here, and are the two patterns tight
  enough? `Authorized` shares the `CHECK constraint failed:` prefix with `Monotonic`, so the
  constraint name is anchored with `\b`. A third lost-race surface appearing in a future
  Quereus version would be silently unclassified (→ no retry, and the joiner is told to start
  over) rather than misclassified — the safe direction, but worth confirming.
- Is `USE_NUMBER_ATTEMPTS = 3` the right bound?
- Does re-using one `strandStampId` across `redeemInvitation` attempts hold under every failure
  mode, or only the two now tested (statement-time and commit-time)?
- The stubbing of private methods (`ControlDatabaseInternals` cast + `withStubbed`) follows
  `control-write-lock.spec.ts`'s precedent, but it does mean the specs bind to private shape.
