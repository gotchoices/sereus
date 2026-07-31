description: When two people accept the same invitation at once, the one who loses the race no longer has to get approved a second time — the node quietly re-uses the approval it already has. Built, tested, and reviewed.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/test/control-formation-invite.spec.ts
----

# Re-present a granted approval after a lost formation race — database layer

## What the problem was

An invitation can allow several peers to join, and each redemption is stamped with a 1-based
`UseNumber` computed as `max(UseNumber) + 1` over the rows already recorded. An invitation can
also carry a `ValidationUrl` — an approval hook that may front a **human review queue**.

The use number used to be read OUTSIDE the write lock. Two redemptions of one token that
overlapped both computed the same number; one committed, the other was refused on the
`(Token, UseNumber)` primary key. The loser's approval was already granted, and it was thrown
away — sending a person back to re-approve a join they had already approved.

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

### `test/control-formation-use-number-retry.spec.ts` (new, 15 cases)

Boots a real `CadreNode` (`profile: 'transaction'`, empty bootstrap). Every engine error the
classifier is asked about is produced by the REAL engine, never a string literal — a reworded
storage-layer message must redden this spec rather than silently disable the retry.

### `test/control-formation-invite.spec.ts`

Comment only: a cross-reference on the pre-existing "lets the loser of a use-number race retry
the SAME approval" case explaining why it is NOT a duplicate of the new spec.

## Review findings

Reviewed the whole implement-stage diff (`f93718c..6d7ddee`, three commits) before reading the
handoff, then re-read `control-database.ts`, `control-formation-recorder.ts`,
`strand-formation-manager.ts`, `schemas/control.qsql`'s `FormationUsage` block, the new spec,
and every `docs/` file that mentions formation invites.

### Fixed in this pass (minor)

- **Orphaned doc block.** The JSDoc describing `LOST_USE_NUMBER_PATTERNS` sat immediately
  above the JSDoc for `USE_NUMBER_ATTEMPTS`, so it attached to the wrong declaration and the
  patterns array shipped undocumented. Moved it onto the array it describes.
- **Stale parameter doc.** `recordFormationUsage`'s `signal` said the abort is checked
  "immediately before that attempt's insert is issued". After the refactor there is a use-number
  read (and, on a retry, a seat read) between the check and the insert. Reworded to "at the top
  of the attempt".
- **Untested commit-time loss on the record-only path.** The deferred-`Monotonic` retry was
  covered only for `redeemInvitation`, which wraps its writes in an explicit transaction. The
  record-only path issues one auto-committing insert, so the deferred check fires at a
  different moment — and that is the path bound invites (the production-hot ones) take. Added
  a case; it fails without the retry (the stubbed stale number 7 would otherwise land as 7).
- **`InvitationExhaustedError`'s fields unasserted.** The exhaustion case only checked
  `toBeInstanceOf`. Its `token` / `useNumber` / `totalUses` are the operator signal the wiring
  ticket will log, so they are contract. Now asserted.

### Filed as a new ticket (major)

- **No real concurrent-writer coverage.** Every "lost race" in the spec is staged on one node,
  by stubbing either `nextUseNumber` or `execFormationUsageInsert`. That proves the retry LOOP
  handles a collision correctly, using real engine error text — but not that a genuine
  two-writer race surfaces as one of the two errors the classifier recognises. If it surfaces
  as a third error, nothing retries, the joiner is told to start over, and every existing test
  stays green. The implementer flagged this honestly as a known gap; it needs real network
  concurrency and so belongs in `packages/integration-tests`, out of this ticket's scope.
  → `backlog/debt-formation-use-number-race-real-concurrency`.

### Recorded as tripwires, not tickets

- **`Monotonic` is an unqualified constraint name.** A CHECK failure names only the constraint,
  never its table. `Monotonic` is unique across `schemas/control.qsql` today, so the pattern
  cannot mis-fire — but a second table declaring one would have ITS failures read as lost
  use-number races and pointlessly retried. `NOTE:` on `LOST_USE_NUMBER_PATTERNS`.
- **No backoff or jitter between attempts.** Three attempts fire back-to-back. Deliberate (the
  alternative holds the write lock), fine at a handful of competing writers, but a hot
  broadcast invite under bulk onboarding could burn all three against the same competitor.
  `NOTE:` on `USE_NUMBER_ATTEMPTS`, naming randomised delay — not a bigger budget — as the fix.
- **`assertSeatRemains`'s invite read is a full-primary-key point lookup**
  (`FormationInvite where Token = ?`), the read shape whose reliability on a networked strand
  is still open (`backlog/debt-composite-pk-point-lookup-unreliable-untracked`). The failure
  mode is safe — a spurious empty result costs the retry its named exhaustion error and reverts
  it to today's generic `Authorized` refusal, never a seat the invite does not have. `NOTE:` at
  the read, so a future reader meets the reasoning instead of re-deriving it. No new ticket: the
  underlying read-shape question is already tracked.

### Checked and found nothing

- **Correctness of the retry loop.** Walked each failure mode: `FormationAbortedError` and
  `InvitationExhaustedError` are not classified as races so they propagate on the first throw;
  a rolled-back attempt reuses its `strandStampId` legitimately because rollback frees the
  `Strand.StampId` unique (both the pre-commit and commit-time rollbacks are now covered by
  tests); a `Strand` primary-key collision from another local writer between attempts is not a
  use-number race and correctly escapes the loop; `nowMs` is re-derived per attempt, so an
  invite expiring mid-loop fails cleanly. No defect found.
- **Classifier tightness.** `Authorized` shares the `CHECK constraint failed:` prefix with
  `Monotonic`; the constraint name is `\b`-anchored, and the spec pins a real `Authorized`
  failure as NOT a race. A duplicate nonce is correctly excluded — replaying a spent approval
  is not a race. The two patterns' case-sensitivity differs (`/i` on the first only), which is
  harmless: neither message has a plausible alternate casing. Left alone.
- **Docs.** Read every `docs/` file mentioning `FormationUsage` / `FormationInvite` /
  `redeemInvitation` (`api.md`, `architecture.md`, `cadre-consistency.md`, `STATUS.md`) plus
  `schemas/control.qsql`. `cadre-consistency.md` has no formation-race content at all.
  `architecture.md`, `STATUS.md`, and the `Monotonic` schema comment are stale in ways
  `implement/13.5-debt-formation-approval-retry-wiring` already enumerates — left to that
  ticket rather than duplicated here.
- **`strand-formation-manager.ts:345-352`'s NOTE** ("this path does not retry", pointing at a
  ticket path that no longer exists) is now false, but is item one of that same wiring ticket's
  TODO. Not touched, to avoid a conflicting edit.
- **Source hygiene.** New functions are short and single-purpose (`withUseNumberRetry` 25
  lines, `assertSeatRemains` 8, `isLostUseNumberRace` 6); naming carries the meaning; the spec's
  helpers (`staleOnce`, `countingInsert`, `withStubbed`, `captureError`) are named rather than
  inlined. `control-database.ts` is now 1858 lines, which is large, but that is a pre-existing
  trend the diff did not create and splitting it is not this ticket's business.
- **Test-only private-method stubbing** (`ControlDatabaseInternals` cast + `withStubbed`)
  binds the spec to private shape. Follows `control-write-lock.spec.ts`'s existing precedent
  and is the only way to stage a deterministic loss; accepted, not re-litigated.

### Adjusted in the downstream ticket

`implement/13.5-debt-formation-approval-retry-wiring` still listed "reword
`provisionAndRecord`'s doc comment" as work — the implement pass already did it. Marked as
done so the next agent does not redo it. Added `docs/api.md` to its scope: the approval-hook
section is written for outside hook authors, a human review queue is the whole reason this
retry exists, and it never states the resulting guarantee (a hook is asked at most once per
redemption, not once per write attempt).

## Validation run

From `packages/cadre-core`, all green on the reviewed tree:

- `yarn typecheck` — exit 0.
- `yarn build` — exit 0.
- `npx eslint` over every touched file — exit 0. (`cadre-core` has no `lint` script; lint lives
  at the repo root as `eslint .`.)
- `npx vitest run test/control-formation-use-number-retry.spec.ts` — **15/15 pass**.
- `npx vitest run` (whole package) — **83 files, 1311 pass, 1 skipped**. The skip is
  `key-store.spec.ts`'s `it.skipIf(process.platform === 'win32')` POSIX-file-mode case:
  pre-existing, platform-conditional, unrelated. No `.pre-existing-error.md` was needed.

`packages/integration-tests` was not run (real network, out of scope) — that is exactly what
the new backlog ticket exists to close.

## Cases the spec pins

Classifier (all from real engine errors): the `(Token, UseNumber)` primary-key collision → true;
the DEFERRED `Monotonic` CHECK failure → true; a duplicate `UsageStampId` → false (replay is not
a race); an `Authorized` CHECK failure and non-`Error` values → false.

Behaviour: two concurrent `recordUsage` calls on a two-use bound invite land `[1, 2]` with a
counting approver asked exactly twice (the primary regression); two concurrent redemptions of a
single-use invite seat exactly one, the loser refused by `Authorized`; a stale use number is
retried and lands at #2 with the hook asked once, and the stored row's `PeerKey` / `PeerSig` /
`Disclosure` / `StrandId` are byte-identical to what was passed; `redeemInvitation`'s retry
rolls its `Strand` insert back on a pre-commit failure and on a commit-time (`Monotonic`) one;
a commit-time loss on the auto-committing record-only path is retried too; attempts are bounded
at exactly 3 writes; a duplicate nonce is written once and NOT retried; an exhausted invite on a
retry raises `InvitationExhaustedError` carrying token, use number, and limit; a signal firing
between attempts raises `FormationAbortedError` with the use number never re-read; an expired
invite is refused cleanly by `Authorized` with no retry.

## Carried forward

- **`InvitationExhaustedError` still reaches the joiner as `Formation conflict, retry`** —
  `strand-formation-manager.ts`'s catch-all maps every unrecognised error to that string, so
  the joiner-visible benefit of naming exhaustion is not there yet. That is what
  `implement/13.5-debt-formation-approval-retry-wiring` is for.
- **`InvitationExhaustedError` and `isLostUseNumberRace` are exported from
  `control-database.ts` but NOT from `src/index.ts`** — consistent with `FormationAbortedError`,
  which is also package-internal. Fine for the manager (same package); the wiring ticket may
  need to widen `index.ts` if anything outside `cadre-core` must `instanceof` them.
- **`assertSeatRemains` runs only on retries.** A first attempt is left to
  `FormationUsage.Authorized`'s own seat clause, since `StrandFormationManager.validateToken`
  already gated it. If that upstream gate is ever removed, a first attempt's exhaustion
  silently reverts to a generic `Authorized` failure.
