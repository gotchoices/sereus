description: This closes out the paperwork for a database race-condition fix that a sibling library already made and that a two-machine test already proved fixed — it retires the old warnings and lines up the docs, a test comment, and a pending public-issue reply so they all agree with the current, safe behavior.
files: packages/integration-tests/src/scenarios/control-concurrent-unique-column-race.integration.ts, packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts, docs/schema-guide.md, docs/architecture.md, tickets/blocked/report-schema-guide-concurrency-correction-to-issue-5.md, packages/cadre-core/src/control-write-retry.ts
difficulty: easy
----

# Retired the same-instant secondary-unique-column race warnings

## What this ticket found already done, and what it changed

The upstream fix (Optimystic `e296a802`/`13586033`/`2fdb3b97`, dist rebuilt at `fbf165ee`) and the
permanent regression test (`control-concurrent-unique-column-race.integration.ts`) were **already
in place and green** on entry — a prior `fix`-stage run had landed them (see
`tickets/complete/optimystic-concurrent-same-pk-insert-silent-lww.md` and commit history:
`405cf306`, `6253ffdd`). This ticket was the doc/paperwork retirement pass described in the
implement ticket body. No behavior, test logic, or production code changed. Four files edited,
purely prose/comments:

- **`docs/schema-guide.md`** — replaced the "Caveat — a column that is `unique` but not the
  primary key is not yet a safe concurrency guard" paragraph (was: two rows can land under one
  "unique" value) with a paragraph stating the secondary-unique-column race is fixed the same way
  as the primary-key race, naming the guard scenario, and adding the note that a *concurrent*
  refusal can surface as a plain `Error` rather than `ConstraintError` (cites
  `../optimystic/tickets/backlog/bug-concurrent-unique-refusal-is-not-a-constraint-error.md`) — so
  callers should match on the `UNIQUE constraint failed: <Table>.<Column>` message text, not the
  error's type.
- **`docs/architecture.md`** (~line 588-597) — changed "Two `integration-tests` scenarios guard
  that" to "Three", added `control-concurrent-unique-column-race` alongside
  `control-cross-machine-unique-column` and `control-concurrent-same-pk-insert`, and removed the
  "one narrower arm stays open ... `tickets/blocked/concurrent-unique-value-race-commits-both-rows`"
  sentence.
- **`control-cross-machine-unique-column.integration.ts`** header — reworded the "DELIBERATELY
  SEQUENTIAL" paragraph: it no longer calls the same-tick shape "a still-open defect" (there is no
  defect left), and instead explains the file stays sequential because it tests a different
  property (a decision made against an already-converged view) than its new same-tick sibling.
- **`tickets/blocked/report-schema-guide-concurrency-correction-to-issue-5.md`** — dropped the
  dead `files:` path to this now-deleted implement ticket, and rewrote the draft public-issue
  comment's second half from "one narrower gap remains" to "that gap is fixed too," including the
  plain-`Error`-vs-`ConstraintError` note. Left in `blocked/`: posting to the public tracker (issue
  gotchoices/sereus#5) is still a human's action, per that ticket's own framing — I did not touch
  that framing.

`control-concurrent-unique-column-race.integration.ts`'s header comment was reviewed against the
doc edits above and needed no change — it already describes the current (fixed) behavior
accurately and its historical reference to the ticket slug that measured the fix is a citation of
a completed measurement, not a stale pointer to an open ticket.

`packages/cadre-core/src/control-write-retry.ts` — reviewed, unchanged. Its `PartialCommitError` /
`CoordinatorPartialCommitError` non-retry vetoes are unaffected by this fix (they veto by error
type, not by which race produced the error), confirmed by re-running its spec (below).

## Verification run this pass

All commands run in the foreground from `C:\projects\sereus`:

- `yarn lint` — clean, exit 0.
- `yarn workspace @serfab/integration-tests typecheck` — clean, exit 0.
- `yarn workspace @serfab/integration-tests vitest run src/scenarios/control-concurrent-unique-column-race.integration.ts src/scenarios/control-cross-machine-unique-column.integration.ts src/scenarios/control-concurrent-same-pk-insert.integration.ts --reporter=verbose` —
  **3 files / 8 tests, all passed** (log: `tickets/.logs/concurrent-unique-value-race-commits-both-rows.implement.log`).
  Confirmed non-determinism of the race winner across the 3 rounds of the new scenario in this
  run: round 1 winner B, round 2 winner A, round 3 winner B — matching the "not deterministic"
  claim in both the scenario file and the docs.
- `yarn workspace @serfab/cadre-core vitest run test/control-write-retry.spec.ts` — **55 tests,
  all passed** — confirms the classifier module the ticket flagged as reviewed-but-unchanged is in
  fact unaffected.

No pre-existing failures encountered; nothing written to `.pre-existing-error.md`.

## What a reviewer should sanity-check

- **Grep sweep**: `grep -rl "blocked/concurrent-unique-value-race-commits-both-rows" tickets docs packages`
  now hits only `tickets/complete/*` (three archived tickets that reference the slug as history —
  exempt per the implement ticket's own instruction) and this ticket's own former implement-stage
  file (now deleted as part of this stage transition). No other live reference remains.
- **The public-issue ticket stays in `blocked/`** on purpose — I updated its content (paths and
  draft text) but did not move it or take the posting action itself; that's still gated on a human
  per its own "Why this is a human's call" section.
- **This ticket touched no test assertions and no production code.** The only prior-stage claim I
  did not independently re-derive is the upstream fix's correctness itself (commit hashes
  `e296a802`/`13586033`/`2fdb3b97`, dist `fbf165ee`) — that was established and measured in the
  `fix`/prior `implement` stage that produced the now-green scenario file, not in this pass. What I
  verified fresh is that the suite is still green today and that the docs/comments now match that
  green state.
- The schema-guide wording change is a judgment call on tone/emphasis (turning a "caveat, don't
  rely on this" into a "this is safe, here's the one thing to know about error shape") — worth a
  read-through against the surrounding "Ordering Events" section for flow, since it now argues
  primary-key and secondary-unique safety as one point rather than a rule-plus-exception.
