----
description: Reviewed and hardened the change that stops a failed party write from being re-run when nobody can tell whether it already committed, plus the tests that check the decision against errors the real database produces.
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, docs/architecture.md
----

# Complete: narrowed control-write retry classifier + real-error coverage

## What shipped

`isRetriableControlWriteFailure` decides whether a failed control write is re-presented to the
cluster. It classifies by error message text, walking the `cause` chain.

**The transactor aggregate is no longer matched by prefix alone.** Optimystic's network
transactor raises `Some peers did not complete:` from three sites. Two fail before anything
commits (`get`, a block read; `pend`, phase 1) — safe to re-present. The third (`commitBlocks`,
phase 2) is not: the tail commit is one batch to one coordinator running consensus internally,
so a no-response there is indeterminate — the commit may have landed with only the reply lost.
Re-running the write body over a write that landed turns a success into a constraint failure.

The phases are told apart by how each formats its per-batch details:

| site | detail shape | retriable |
|---|---|---|
| `get`, `pend` | `<peerId>[block:<id>](<status>)` | yes |
| `commitBlocks` | `<peerId>[blocks:<count>](<status>)` | no |

`[block:` cannot occur inside `[blocks:`, so the tokens are disjoint. Verified against the
upstream source during review: `db-core/src/transactor/network-transactor.ts:240` (`get`),
`:522` (`pend`), `:715` (`commitBlocks`).

**Real-error coverage for the negative half.** `control-formation-use-number-retry.spec.ts`
boots one `CadreNode`; its real-engine error producers were extracted into four helpers
(`realLostRaceError`, `realMonotonicFailureError`, `realAuthorizedFailureError`,
`realDuplicateNonceError`) and reused by a new describe asserting the classifier returns `false`
for all four REAL errors, and that the two text-reading classifiers stay disjoint on real
objects rather than literals.

## Review findings

### Checked and clean

- **The upstream format strings.** Walked `network-transactor.ts` directly rather than trusting
  the handoff. All three aggregate sites confirmed at the cited lines, with the claimed token
  shapes. `formatBatchStatuses` (`:820`) confirmed to fall back to *all* batches when no batch
  is incomplete, so empty details require zero batches — the empty-details case the classifier
  refuses is real but very narrow, and refusing it is correct either way.
- **The captured message is genuinely captured.** `TRANSACTOR_AGGREGATE` in
  `control-write-retry.spec.ts` matches the transcript in
  `tickets/fix/control-read-over-fresh-edge-stream-resets.md` verbatim, including the peer id
  and block id. It carries `[block:`, so the shipped absorption of the observed production
  failure survives the narrowing.
- **`unwrapError` semantics.** Confirmed (`quereus/src/common/errors.ts:166`) it walks `cause`
  only — not `AggregateError.errors`, which `pend`'s aggregate also sets. Irrelevant here since
  `pend` sets `.errors` to `[rootCause]`, the same object it sets as `cause`.
- **Regex statefulness.** Neither module-level regex carries `g`, so `.test()` has no
  `lastIndex` carry-over across calls. Not a live bug.
- **No other synthetic aggregates in the tree.** Grepped for the message across all source and
  spec files; only the two spec literals the handoff named. The handoff's warning that a future
  synthetic aggregate must carry `[block:` stands, but nothing existing is affected.
- **The dead `control-write-retry-real-error-coverage` slug.** Surviving hits are in
  `packages/cadre-core/dist/` (gitignored build output, regenerates) and in `complete/` tickets
  (historical archive). No source reference survives — the handoff's claim holds.
- **Test-helper reuse is collision-safe.** `boundInvite` suffixes token and strand ids with
  `rand()` per call, so the four extracted helpers being invoked from two describes mints
  distinct invites each time. No hidden ordering dependency between the describes.

### Fixed in this pass

- **Mixed-level `cause` chains, the gap the handoff flagged as unexamined.** The commit-phase
  veto was applied *within* one message, so a chain carrying a read-phase aggregate at one level
  and a commit-phase one at another could classify retriable off the read-phase level. Traced it
  out: essentially unreachable today, because a commit-phase aggregate emits `[blocks:` for every
  batch it formats *and* inlines its cause's message as `root: …`, so both tokens normally land
  in one string. But that is an argument about another repo's error assembly, not a property of
  this code. Lifted the veto to the whole chain (`reportsIndeterminateCommit`), which runs before
  any matcher and disqualifies the read-phase and super-majority arms alike. Strictly more
  conservative — the failure mode is a lost retry, never an unsafe re-run. `isUncommittedTransactorAggregate`
  drops a branch as a result. New case: `never retries a chain that reports a commit-phase batch
  at ANY level`, asserting both orderings against both retriable arms, with a same-test control
  proving each arm still retries on its own.
- **Vacuously-passing real-error assertion.** `never retries a real constraint or authorization
  failure` asserted only `isRetriableControlWriteFailure(x) === false`, which the classifier
  returns for *any* non-`Error` value — so the case would have passed without ever exercising the
  message-matching arm if the engine ever threw a non-Error. Added an `toBeInstanceOf(Error)`
  guard per failure.
- **`docs/architecture.md` was out of date.** Its control-write-retry paragraph (line 76)
  described only the rejected-write exclusion and predated the commit-phase narrowing entirely.
  Added the indeterminate-commit rule, the token discriminator, the chain-wide veto, and the
  fail-closed direction. No other doc touches this classifier.
- **Matcher-table asymmetry.** One entry was a named predicate, the other an inline arrow around
  a regex. Named the second (`isUnansweredSuperMajorityShortfall`).

### Considered, deliberately not changed

- **`control-write-retry.ts` is comment-heavy** (274 lines, roughly half prose, for four
  functions). Weighed trimming it against the module's whole risk being *why* each message is or
  is not matched — the commit-phase reachability trace in particular took real work to settle and
  is exactly what a future reader will want when an upstream reformat reddens something. Kept.
  Redundancy between the module header and the function comments was trimmed where the chain-veto
  edit touched it.
- **`control-formation-use-number-retry.spec.ts` (639 lines) now hosts coverage for a classifier
  its filename does not mention.** The reuse is justified — it is the only spec in the package
  that boots a `CadreNode`, and splitting would mean booting a second one — and its header
  comment already says so explicitly. Not worth a split at this size.
- **`unwrapError` has no cycle guard** — a self-referential `cause` would spin forever. Upstream
  Quereus behavior, unchanged by this diff, and nothing in this repo builds cyclic causes. Noted
  here rather than filed; it is not this ticket's site.

### Tripwires

- **Existing tripwire kept** — the `NOTE:` on `isUncommittedTransactorAggregate` in
  `control-write-retry.ts`: the `[block:` / `[blocks:` discriminator is a formatting detail of
  another repo, an upstream reformat fails closed, and the guard is
  `control-write-retry-scenario-coverage`, not this code. Re-read and still accurate after the
  chain-veto edit.
- No new tripwires. The one candidate (mixed-level chains) turned out to be cheap enough to close
  structurally rather than park.

### Tickets filed

None. Every finding was resolvable inline; nothing required a new site to change.

## Known gaps carried forward (unchanged by review)

- **The RETRIABLE half is still literal-only in the unit spec.** Both retriable messages need a
  real multi-node cluster to fail mid-write; this package boots one node with an empty bootstrap
  list. `control-write-retry-scenario-coverage` produces them for real and already carries a task
  to verify the live pend-phase aggregate against the narrowed pattern. The spec headers say so
  and do not present the literals as captured output — except `TRANSACTOR_AGGREGATE`, which is
  captured and is labelled as such.
- **The commit-phase case is a static trace, never observed.** No test produces a real
  `commitBlocks` aggregate. Review re-verified the *format strings* and the token disjointness
  against upstream source, but did not re-derive the reachability argument (that the aggregate
  escapes `commit()`, `TransactorSource`'s cancel-and-rethrow, and `Collection.syncInternal` to
  reach this funnel) — that trace is recorded in the implement ticket's "The commit-phase question
  — SETTLED" section and remains a static argument.

## Validation

From `packages/cadre-core`:

```
yarn vitest run test/control-write-retry.spec.ts test/control-formation-use-number-retry.spec.ts test/control-write-lock.spec.ts
```

3 files, 40 tests, green (was 39 before review; the chain-veto case is the addition). Full
`yarn vitest run` in the package: 84 files, 1357 passed, 1 skipped — the skip is pre-existing and
not introduced here. Root `yarn lint` and package `yarn typecheck` both exit 0.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
