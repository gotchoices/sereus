description: A two-machine test used to demand that a second copy of some data already agreed the instant the first copy caught up, which could fail for reasons of its own making; it now waits for both, and says enough on a failure to tell a slow machine apart from a broken one. The comment that wrongly described this count as the thing enforcing an invitation's seat limit is corrected, and the convention is written down.
architecture: docs/testing.md
files: packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, packages/cadre-core/src/control-database.ts, docs/testing.md
----

# What shipped

Three changes, all from `tickets/implement/formation-usage-count-asserted-without-a-wait`. No production behaviour changed: one test file, one doc comment, one documentation section.

## 1. The count assertions are bounded waits, and they report both machines

`strand-formation-concurrent-redemption.integration.ts` waited up to `CONVERGE_MS` (30 s) for a node's `FormationUsage` **row scan** to hold every approved joiner's row, then in the next statement hard-asserted that the **index-backed** `countFormationUsage` already equalled that row count. The table and the `FormationUsageByToken` index are separate collections in the storage engine with independent cross-machine catch-up, so that compared a value that was waited for against one that was not.

Two new suite-scope helpers:

- **`describeBothViews(token)`** — both nodes' row scans and counts as one line. This is the snapshot the row-scan timeout path already built inline; it is now hoisted so the count path raises the identical evidence. The row-scan timeout message is unchanged in content.
- **`waitForUsageCount(db, label, token, predicate, expectation)`** — reads the count once, returns immediately if it already satisfies the predicate, otherwise polls through the existing `waitUntil` at 250 ms up to `CONVERGE_MS`. No second waiting helper was invented; this wraps `waitUntil` the same way the row-scan path does.
  - **On timeout** it throws with the last observed count, what was expected, how long the count actually stayed short (measured, not the budget restated — the first read precedes the wait's own clock), the budget, and both nodes' scans and counts. The original `waitUntil` timeout is attached as `cause`.
  - **On a pass that had to wait** it logs `[concurrent-redemption] <label> count of <token> reached <expectation> after <n>ms of index catch-up`. A pass whose first read already agreed logs nothing. No assertion on the delay — there is no measured baseline for a threshold.

Applied at both unwaited sites: the final count assertion in `assertRowsMatchApprovals` (`count === rows.length`), and case 2's over-admission arm, which now waits for each node's count to exceed the invite's `totalUses` instead of reading it once.

**Case 3 is untouched**, as the ticket directed.

## 2. `CASE_TIMEOUT_MS` raised 180 s → 300 s (not in the ticket — please check this)

The constant's own doc comment says it exists so a case fails on a convergence wait, which carries the both-nodes diagnostic, rather than on vitest's clock. It was sized at three waits per case. Case 1 now issues five and case 2 seven (publish, each node's scan, each node's count, then the over-admission arm's two counts) — 210 s of waits plus the two 30 s formation sessions, which no longer fits under 180 s. Left alone, a genuinely stuck run would have died holding exactly the evidence this ticket exists to produce. The comment now states the worst case and says to raise the constant alongside any added wait.

The cost: a fully hung case now occupies 5 minutes instead of 3. Output still lands at each case boundary, so the runner's 10-minute idle timer is not at risk.

## 3. `countFormationUsage`'s doc comment

It said "this count IS the seat cap (`enforceFormationUseCap`)". `enforceFormationUseCap` does not exist anywhere in the repository, and the authoritative cap is the deferred `Authorized` CHECK in `schemas/control.qsql` — `FI.TotalUses > (select count(1) from committed.FormationUsage U where U.Token = new.Token)` — evaluated by the validating cohort against the committed snapshot at commit time.

The comment now says that, names every caller as a permissive pre-check and what a short read costs each of them (`assertSeatRemains` loses its named exhaustion error and falls back to the CHECK's generic refusal; `ControlFormationUsageRecorder.isTokenUsed` reports not-used and lets the redemption reach the CHECK; `hasOutstandingFormationInvite` holds the stranger-admission door open slightly longer), and keeps the part that stands: index convergence still gates the cap, at the CHECK, because the CHECK's own count is served by the same index. The standing instruction not to weaken the scenario's assertions is kept, with one sentence added distinguishing a both-views failure (index regression) from a one-view failure (the scenario's own bounded wait timing out, which the new message spells out).

`ControlFormationUsageRecorder.isTokenUsed` and `hasOutstandingFormationInvite` were checked for the same overstatement and are accurate as written, so they were not touched. `control-schema.ts`'s index declaration comment ("the cap count is only ever as correct as this index's convergence across machines") is also correct — the CHECK's count goes through that index — and was left alone.

## 4. `docs/testing.md` — new section "Asserting a quantity that has to travel between machines"

One paragraph, placed before "Topology coverage map". States the convention: an integration assertion about a value that has to reach a second machine goes through a bounded wait, never an immediate read, and its timeout message carries every machine's view. Names the specific trap (waiting for one value then hard-asserting a second that converges independently), names this scenario as the worked example, and says to print the catch-up delay on a slow pass but not to assert on it without a measured baseline.

# Tests

**No test was added.** The change is to existing assertions in one scenario, and the behaviour under test is unchanged — nothing here owes a new test, and a test of the test's own timeout plumbing would be testing wiring.

The failure path was verified by temporary fault injection rather than by a committed test: `CONVERGE_MS` was set to 2 s and the predicate to `count === rows.length + 1`, case 1 was run, and the message came out as intended — observed count, expectation, both nodes' rows and counts, with the `waitUntil` timeout as `cause`. Both edits were reverted and the file verified byte-identical to its pre-injection state before proceeding. **Nothing of that injection is in the diff** — worth confirming: `CONVERGE_MS` must read `30_000` and the predicate `count === rows.length`.

# Validation run

| what | result |
| --- | --- |
| `yarn typecheck` | clean |
| `yarn lint` | clean (exit 0) |
| the scenario, isolated | green, 16–21 s |
| the scenario, 3 rounds × 3-way parallel (9 runs) | 9/9 green |
| `@serfab/cadre-core` formation specs (`control-formation-invite`, `strand-formation-consent`, `validation-key-enrollment`, `control-revocation-replay`) | 110 passed |

Across those 10 scenario runs, case 2 landed on its both-approved branch 5 times and its one-refused branch 5 times, so the new over-admission wait was exercised. **The catch-up log never printed**: every count was already equal on its first read. That matches the 73 runs recorded in the implement ticket and is the expected pass-path shape — but it also means the *logging* branch of `waitForUsageCount` has never run against a real lag, only the timeout branch under fault injection.

`@serfab/cadre-core` was rebuilt (`yarn workspace @serfab/cadre-core build`) because the stale-build guard fires on any `src` edit, comment-only included. No sibling workspace was built or touched. No pre-existing failures were encountered, so `tickets/.pre-existing-known.md` and `.pre-existing-error.md` are untouched.

The full suite was **not** run — 61 integration files sequentially is past the ~10-minute ceiling for work inside a ticket.

# What to look at

- **`CASE_TIMEOUT_MS` at 300 s** is the one change the ticket did not ask for. The arithmetic above is the justification; if a 5-minute worst-case hang is worse than losing the diagnostic, that is a judgement call to make here rather than in a later ticket.
- **Case 3's two `waitUntil` calls now duplicate `waitForUsageCount`.** The ticket said explicitly to leave case 3 alone, so they were left, but a reviewer weighing "stay DRY" may want them routed through the helper — the semantics are identical and the failure message would gain both nodes' views. Case 3's two closing `expect(...countFormationUsage(...)).toBe(...)` reads are immediate, deliberately: they sit behind the wait at the top of the case and a terminal refusal writes no row, so nothing new has to converge between the wait and them. That is a different situation from the one this ticket fixed, but it is the kind of reasoning worth a second pair of eyes.
- **The same shape exists elsewhere and was judged out of scope.** `multi-party-sync.integration.ts:131` and `strand-creation.integration.ts:97` both call `waitForControlSync(..., 'FormationUsage', n)` — which polls `countRows`, a whole-table `count(1)` that does not go through `FormationUsageByToken` — and then immediately assert `countFormationUsage`, which does. Structurally the same pairing. They were left alone because `waitForControlSync` polls the party OWNER's `ControlDatabase`, which is also the node that wrote the rows, so the quantity never crosses a machine there and the new convention (scoped to values that travel between machines) does not reach them. Confirm that reading; if a drone ever gains a `ControlDatabase`, it changes.
- **The original intermittent failure is still unreproduced.** It did not appear in the 73 runs of the implement stage nor the 10 here. This change cannot be shown to fix anything — it changes what a recurrence *reports*. If it recurs, the trace to capture is optimystic's `DEBUG=optimystic:quereus-plugin:module`, comparing the two machines' `rev=` for the index collection against their `main_rev=` on the `index:seek` line.
- **The doc-comment rewrite is a claim about where the cap is enforced.** It is worth re-deriving from `schemas/control.qsql` (the `FormationUsage.Authorized` clause) and the three call sites rather than taking it on trust, since the comment it replaces was itself confidently wrong and had been read by at least one defect report.
