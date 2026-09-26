----
description: A two-machine test used to demand that a second copy of some data had already agreed the instant the first copy caught up; it now waits for both and says enough on a failure to tell a slow machine apart from a broken one. Three documents that wrongly described which piece of code enforces an invitation's seat limit were corrected, and one that still warned users about a bug fixed last week was brought up to date.
architecture: docs/testing.md
files: packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, packages/integration-tests/src/harness/test-network.ts, packages/cadre-core/src/control-database.ts, docs/testing.md, docs/architecture.md, docs/api.md
----

# What is true now

No production behaviour changed. The work is one integration scenario, one harness comment, one library doc comment, and three documentation files. Implement commit `fc67263c`; review fixes in the commit carrying this ticket.

## The scenario's count assertions

`strand-formation-concurrent-redemption.integration.ts` no longer asserts an index-backed `countFormationUsage` value immediately after waiting for a separately-converging row scan. Two suite-scope helpers carry that:

- **`describeBothViews(token)`** — both nodes' row scans and counts on one line, hoisted out of the row-scan timeout path so every convergence failure in the file raises the same evidence.
- **`waitForUsageCount(db, label, token, predicate, expectation)`** — reads the count once, returns if it already agrees, otherwise polls the existing `waitUntil` at 250 ms up to `CONVERGE_MS` (30 s). Its timeout message carries the last observed count, what was expected, the **measured** time the count stayed short, the budget, and both nodes' views, with the original timeout as `cause`. A pass that had to wait logs the catch-up delay; a pass that agreed on its first read logs nothing. No assertion on the delay — there is no measured baseline for a threshold.

Three sites read the count immediately, each deliberately and each saying so at its site: case 2's over-admission arm and case 3's two closing reads. All three sit behind a wait for the same quantity on the same node, earlier in the same case, and the count is append-only.

`CASE_TIMEOUT_MS` is 240 s (was 180 s). Five waits is the worst case a case can issue — publishing the invite, then each node's row scan and its separately-converging count — so 150 s of waits plus the two 30 s formation sessions, which no longer fits under 180 s. Its comment states the arithmetic and says to raise the constant alongside any added wait.

## `countFormationUsage`'s doc comment

It claimed to *be* the seat cap, naming a function (`enforceFormationUseCap`) that does not exist in the repository. The authoritative cap is the deferred `Authorized` CHECK in `schemas/control.qsql` — `FI.TotalUses > (select count(1) from committed.FormationUsage U where U.Token = new.Token)` — evaluated by the validating cohort against the committed snapshot at commit time. The comment now says that, names each caller as a permissive pre-check and what a short read costs it, and keeps the part that stands: index convergence still gates the cap, at the CHECK, whose own count goes through the same `FormationUsageByToken` index.

## Documentation

`docs/testing.md` gains **"Asserting a quantity that has to travel between machines"**: an integration assertion about a value that has to reach a second machine goes through a bounded wait whose timeout message carries every machine's view; the trap is waiting for one value and then hard-asserting a second that converges independently; and the converse — a later read of a quantity already waited for on that node needs no second wait and should say why at the site.

`docs/architecture.md` and `docs/api.md` carried the same wrong cap attribution and a stale user-facing limitation; both corrected (see findings 7 and 8).

# Review findings

## Checked

The implement diff was read first, before the handoff summary. Beyond that:

- **Fault-injection residue.** The implement stage verified the new failure path by temporarily lowering `CONVERGE_MS` and inverting a predicate. Confirmed clean: `CONVERGE_MS` reads `30_000` and the predicate reads `count === rows.length`. Nothing of the injection is in the tree.
- **The doc-comment rewrite re-derived from source rather than trusted.** `enforceFormationUseCap` appears nowhere outside the tickets describing its absence. The `Authorized` CHECK at `schemas/control.qsql:678` is as quoted. All three callers behave as the comment claims: `assertSeatRemains` loses only its named `InvitationExhaustedError` and falls back to the CHECK; `ControlFormationUsageRecorder.isTokenUsed` reports not-used and lets the redemption reach the CHECK; `hasOutstandingFormationInvite` returns true and holds the stranger-admission door open longer. The claim that the CHECK's own count is served by the same index is corroborated independently by the index declaration's comment in `control-schema.ts`, which names "the cap count in Authorized above" among the reads that index serves.
- **The two sibling sites the handoff asked about.** `multi-party-sync.integration.ts:131` and `strand-creation.integration.ts:97` pair `waitForControlSync(..., 'FormationUsage', n)` with an immediate `countFormationUsage`. The handoff's reading holds: `waitForControlSync` (`test-network.ts:242`) polls the party owner's `ControlDatabase`, and the harness builds exactly one `ControlDatabase` per party, on the owner node — the same node that wrote the rows — so no quantity crosses machines there. A different weakness at those sites was found and parked; see the tripwire below.
- **Happy path, both branches, error path, interactions.** Five isolated runs of the scenario; case 2 landed on its both-approved branch three times and its one-refused branch twice, so both new immediate-read arms and the case-3 wait were exercised. `@serfab/cadre-core` formation specs (`control-formation-invite`, `strand-formation-consent`, `validation-key-enrollment`, `control-revocation-replay`): 110 passed. `yarn typecheck` and `yarn lint` clean. `@serfab/cadre-core` was rebuilt because the stale-build guard fires on any `src` edit; no sibling workspace was built or touched.

## Fixed in this pass

1. **Case 2's over-admission arm did not need a wait, and adding one is what forced the timeout raise.** `assertRowsMatchApprovals` had *already waited* for `count === 2` on both nodes, on the same `ControlDatabase` handles, immediately before. On an append-only table `count > 1` is then established, so the new `waitForUsageCount` there could only ever return on its first read — while still reserving two 30 s slots of the per-case budget. That site was never one of the unwaited-and-racy sites the ticket was about. Reverted to immediate reads with the reason at the site.
2. **`CASE_TIMEOUT_MS` 300 s → 240 s**, with the arithmetic corrected to the five waits that remain. The handoff flagged the 300 s raise for scrutiny; with finding 1 applied, the worst case is 150 s of waits plus 60 s of sessions, and 240 s keeps the same 30 s margin the original 180 s had. A fully hung case now occupies 4 minutes rather than 5, still well inside the runner's 10-minute idle timer since output lands at each case boundary.
3. **Case 3's two top-of-case `waitUntil` calls routed through `waitForUsageCount`.** The implement ticket said to leave case 3 alone; the semantics are identical, the duplication is gone, and the failure message now carries both nodes' views. Its two closing immediate reads were kept — they are sound for a reason the file did not state, so it now states it: each node's count is behind the wait at the top of the case, and a row a refusal must not have written would have been written by the node that *served* that refusal, locally, on the view being read.
4. **`waitForUsageCount`'s doc claimed "every assertion on the count is therefore a bounded wait."** Three reads in the file are deliberately immediate, so the claim was false as written and invited a future reader to "fix" those reads. Narrowed to the first assertion on a node's count, with the later-read case stated.
5. **`countFormationUsage`'s new NOTE was wrong in the same way the comment it replaced was wrong.** It said a failure on ONE view "only is that scenario's own bounded wait timing out." The 2026-08 defect *presents* as a one-view failure whenever only the sibling node wrote the rows — precisely the single-writer case — so that sentence would have a future reader dismiss a real regression as flakiness. Replaced with the actual distinguisher, which is what the both-views message shows: a sibling holding rows the failing view is missing is a convergence problem, not a slow run.
6. **`docs/testing.md` read as "wait before every read."** Taken literally that is the instruction that produced finding 1. The converse is now stated: a later read of a quantity already waited for on that node needs no second wait, adding one cannot change the outcome and still reserves its whole budget, and the site should say why the bare read is sound.
7. **`docs/architecture.md` carried the same wrong cap attribution the code comment was fixed for.** It said the index put "`countFormationUsage`, and through it the cap" onto an index descent. The cap does not read through that method; it is the CHECK's own `count(1)`, which the sentence now names directly. Same finding as the code comment, second site — fixed rather than filed.
8. **`docs/api.md` still told users about a defect fixed nine days earlier.** A "Current limitation (2026-08-12)" callout stated that on a multi-node party the over-admission is unbounded and a spent invitation still reads as outstanding to the membership connection gate. That was fixed upstream and re-measured here on 2026-09-17 (`complete/restore-formation-usage-token-index`), which missed this file. Rewritten as a dated resolved note, keeping the history a reader of the paragraph above may want.

## Tripwire parked

- **`waitForControlSync` counts the whole table, and two callers follow it with a per-key assertion.** `NOTE:` at the method in `packages/integration-tests/src/harness/test-network.ts`. Sound today because each of those scenarios gives its party exactly one invite, so every row in the table belongs to the token under test. The moment a scenario records usages for two tokens in one party, the wait becomes satisfiable by the wrong rows and stops gating the assertion behind it; the note says to add a per-key variant then rather than raise the expected count. Genuinely conditional, so a note and not a ticket.

## Considered and not acted on

- **`describeBothViews` runs four database reads inside a catch block.** If one throws it replaces the informative error and drops the `cause`. Pre-existing in the row-scan path the implement stage hoisted it out of, the test fails loudly either way, and guarding it would put a try/catch around a diagnostic. Not worth the code.
- **`control-database.ts` is 3,128 lines** (`wc -l`). Pre-existing, cohesive (one class over one database), and this change adds seven comment lines to it. `debt-cadre-node-single-file-size` covers a different file for a different reason (a catch-all entry point) and this is not an arm of it. No size ticket filed.
- **The catch-up log has still never printed.** Across the five runs here and the 73 recorded in the implement stage, every count agreed on its first read, so the *logging* branch of `waitForUsageCount` has only ever been exercised under deliberate fault injection. That is not a reason to drop the waits — the 2026-08 convergence defect is exactly what they exist to report — but it does mean the waits are, in a healthy engine, pure insurance.
- **The original intermittent failure is still unreproduced.** It did not appear in the implement stage's 73 runs nor the five here. This work cannot be shown to fix anything; it changes what a recurrence *reports*. If it recurs, capture optimystic's `DEBUG=optimystic:quereus-plugin:module` and compare the two machines' `rev=` for the index collection against their `main_rev=` on the `index:seek` line.

## Tests

**No test added, and none cut.** Nothing in the diff is the reproduction of a defect found here, and nothing leaves a contract unverified: the assertions changed are in one scenario whose behaviour under test is unchanged, and a test of the helper's own timeout plumbing would be testing wiring. The failure path was verified by reverted fault injection during implement rather than by a committed test.

## Tickets filed

**None.** Everything found was fixable in this pass, and the one conditional concern became a `NOTE:` at its site. Nothing reached the filing bar — no finding named a class-level invariant that would need its own change, and no latent defect was left behind.

## Pre-existing failures

None encountered. `tickets/.pre-existing-known.md` and `tickets/.pre-existing-error.md` untouched.

## Not run

The full integration suite — 61 scenario files sequentially is past the roughly ten-minute ceiling for work inside a ticket.
