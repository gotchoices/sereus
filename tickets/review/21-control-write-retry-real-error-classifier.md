----
description: Review the change that stops a failed party write from being re-run when nobody can tell whether it already committed, plus the new tests that check the decision against errors the real database produces.
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts
difficulty: medium
----

# Review: narrowed control-write retry classifier + real-error coverage

## What changed

`isRetriableControlWriteFailure` decides whether a failed control write is re-presented to
the cluster. It classifies by error message text. Two changes:

**1. The transactor aggregate is no longer matched by prefix alone.**

Optimystic's network transactor raises `Some peers did not complete:` from three sites. Two
fail before anything commits (`get`, a block read; `pend`, phase 1) — safe to re-present.
The third (`commitBlocks`, phase 2) can reach this funnel and is NOT safe: the tail commit is
one batch to one coordinator running consensus internally, so a no-response there is
indeterminate — the commit may have landed with only the reply lost. Re-running the write
body over a write that landed turns a success into a constraint failure.

The phases are told apart by how each formats its per-batch details:

| site | detail shape | retriable |
|---|---|---|
| `get`, `pend` | `<peerId>[block:<id>](<status>)` | yes |
| `commitBlocks` | `<peerId>[blocks:<count>](<status>)` | no |

`[block:` cannot occur inside `[blocks:`, so the tokens are disjoint. `RETRIABLE_CONTROL_WRITE_PATTERNS`
(two regexes) became `RETRIABLE_CONTROL_WRITE_MATCHERS` (a predicate + a regex), with the
aggregate arm in `isUncommittedTransactorAggregate`. Both edges are conservative: ANY
`[blocks:` occurrence disqualifies the message (the trailing `root: <cause>` is free text),
and an aggregate whose details came out empty carries neither token and is not retried.

The commit-phase analysis was settled by static trace in the implement ticket and is now
written into the function's doc comment rather than left as an open NOTE.

**2. Real-error coverage for the negative half.**

`control-formation-use-number-retry.spec.ts` already boots one `CadreNode` and captures real
engine errors for `isLostUseNumberRace`. Those producers are now extracted into four helpers
(`realLostRaceError`, `realMonotonicFailureError`, `realAuthorizedFailureError`,
`realDuplicateNonceError`) and reused by a new describe that asserts `isRetriableControlWriteFailure`
returns `false` for all four REAL errors, and that the two classifiers stay disjoint on real
objects rather than on literals.

## How to validate

From `packages/cadre-core`:

```
yarn vitest run test/control-write-retry.spec.ts test/control-formation-use-number-retry.spec.ts test/control-write-lock.spec.ts
```

Ran green: 3 files, 39 tests. Full `yarn vitest run` in the package: 84 files, 1356 passed,
1 skipped (the skip is pre-existing, not introduced here). Root `yarn lint` and package
`yarn typecheck` both exit 0.

**The narrowing demonstrably bites.** Two literals in the tree carried no `[block:` token and
went non-retriable the moment the predicate landed:

- `control-write-retry.spec.ts`'s `TRANSACTOR_AGGREGATE` — replaced with the real captured
  message recorded in `tickets/fix/control-read-over-fresh-edge-stream-resets.md`;
- `control-write-lock.spec.ts`'s `transientClusterFailure()` stand-in (line ~60), which feeds
  two lock-interaction cases that assert a retry HAPPENS. Those would have gone red. Worth a
  reviewer's attention: anyone constructing a synthetic transactor aggregate anywhere else
  must now include the token, and nothing enforces that beyond the test failing.

**The observed production failure still retries.** The real captured aggregate (a
`registerSelf()` racing a connection still forming) carries
`…[block:PaWaynQ…](in-flight) cause=The stream has been reset`, so the shipped absorption is
preserved, not lost to the narrowing.

## Known gaps — read before treating this as finished

- **The RETRIABLE half is still literal-only in the unit spec, by necessity.** Both retriable
  messages (the transactor aggregate, the cluster coordinator's super-majority shortfall) need
  a real multi-node cluster to fail mid-write; this package boots one node with an empty
  bootstrap list. `control-write-retry-scenario-coverage` produces them for real and already
  carries a task to verify the live pend-phase aggregate against this narrowed pattern. The
  spec headers say so explicitly and do not present the literals as captured output — except
  `TRANSACTOR_AGGREGATE`, which IS captured output and is labelled as such.
- **The commit-phase case is a static trace, never observed.** No test produces a real
  `commitBlocks` aggregate; `TRANSACTOR_AGGREGATE_COMMIT_PHASE` is transcribed from the
  transactor's format string at `db-core/src/transactor/network-transactor.ts:715`. If a
  reviewer wants to disbelieve the reachability argument, the trace to re-walk is in the
  implement ticket's "The commit-phase question — SETTLED" section (it was not re-derived
  during implementation; the ticket instructed not to redo it, and I did not).
- **Mixed-level cause chains are unhandled.** The classifier walks the `cause` chain and
  matches per level, so an error chain carrying a get-phase aggregate at one level and a
  commit-phase aggregate at another would classify retriable off the get-phase level. The
  conservative both-tokens rule only applies WITHIN one message. Not a shape anything is known
  to produce (one transactor call raises one aggregate), and I did not construct one — flagging
  it as unexamined rather than ruled out.
- **Tripwire parked at `control-write-retry.ts`** (`NOTE:` on `isUncommittedTransactorAggregate`):
  the discriminator is a formatting detail of another repo. An upstream reformat fails CLOSED —
  writes silently stop being retried rather than doing anything unsafe — and the guard is the
  scenario ticket, not this code.
- Doc comments referencing the now-split `control-write-retry-real-error-coverage` slug were
  re-aimed at `control-write-retry-scenario-coverage`. Grep for the dead slug if you want to
  confirm none survive in source.
