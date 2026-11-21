description: When too few machines answer a control write, Sereus used to work out what happened by reading the error's wording. It now checks the error's type instead, so a reworded sentence upstream cannot quietly change which writes get a second try.
architecture: docs/cadre/control-replication.md#control-write-retry
files: packages/cadre-core/src/control-write-retry.ts (`isUnansweredShortfall`, `RETRIABLE_CONTROL_WRITE_MATCHERS`, `matchesRetriableFailure`), packages/cadre-core/src/edge-node/strands.ts (`isTransientWriteFailure`), packages/cadre-core/test/control-write-retry.spec.ts (`shortfall`, `ddlChain`, `nested`, the `*_FACTS` constants), packages/cadre-core/test/edge-node/strands.spec.ts (`superMajority`), packages/cadre-core/src/control-retry.ts (`causeChain`, imported, unchanged), ../optimystic/packages/db-core/src/network/promise-shortfall-error.ts (upstream, read-only)
----
# Match the super-majority shortfall by type

Both places that decided whether to re-present a write when too few cohort members answered now test for Optimystic's `PromiseShortfallError` with `rejections === 0`, instead of matching the sentence `Failed to get super-majority: …`. Upstream's own comment on the class asks consumers to do this. The installed `@optimystic/db-core` 1.29.0 `dist` exports the class from the package root (verified: `dist/src/index.d.ts` → `network/index.js` → `promise-shortfall-error.js`), and the message it composes is byte-identical to the old literals, so every assertion on that sentence elsewhere in the tree still holds.

## What changed

**The control-write classifier** (`control-write-retry.ts`). The regex `SUPER_MAJORITY_SHORTFALL_UNANSWERED` and its text matcher `isUnansweredSuperMajorityShortfall` are gone, replaced by a typed predicate `isUnansweredShortfall(link)` called from `matchesRetriableFailure`'s `links.some(...)` — the same place `isFinalTornWrite` and a policy's `claimsLink` are claimed, so it inherits the two vetoes that already run above them (`reportsPossiblyStoredWrite`, then `reportsIndeterminateCommit`) rather than restating the ordering. `RETRIABLE_CONTROL_WRITE_MATCHERS` now holds `isUncommittedTransactorAggregate` alone. All three write policies — default, schema-init, lost-update — share that body, so all three inherit the claim.

**The edge node's strand-write retry** (`edge-node/strands.ts`). `retryAfterRestart`'s `isTransientWriteFailure` walks the `cause` chain with `causeChain` (imported from `../control-retry.js`) looking for the same typed link. The `describeThrown` import is gone, since nothing else in the file used it.

That is two deliberate behaviour changes at the edge-node site, both intended:

- **It widens.** The old match read `describeThrown(err)` — the top-level `message` only, no `cause` walk — so a shortfall arriving under any wrapper was silently not retried. Every shortfall that reaches an app through SQL is wrapped, and the first writes after a lone restart (the only thing this helper exists for) are exactly those.
- **It narrows.** A shortfall carrying a rejection, and any non-`Error` throw, are no longer retried. The rejection line is the control write's and must not differ between the two policies; a non-`Error` throw can carry no typed link, and this helper sleeps 3 s between five attempts, so claiming one on its text would spend 12 s before the identical failure.

A lone node's own refusal to write by itself is still claimed: `CoordinatorRepo.refuseSoloPend` builds the shortfall with `approvals: 1, rejections: 0` and `soloRefused` naming why, so it has a zero rejection count like any silent-cohort shortfall. `soloRefused` is read by nothing.

## Validation run

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core typecheck` | clean |
| `yarn workspace @serfab/cadre-core test --run test/control-write-retry.spec.ts test/edge-node/strands.spec.ts` | 85 passed |
| `yarn workspace @serfab/cadre-core test` (full) | 2692 passed, 1 skipped, 2 failed — both load, see "Known gaps" |
| `yarn lint` | clean (ESLint + `check-docs`: 66 files OK) |

No integration scenario was run; see "Known gaps".

## Tests, and what each one verifies

New cases in `control-write-retry.spec.ts`:

- **`never retries the shortfall sentence as plain text — the claim is by type`** — the sentence on a plain `Error`, bare and under the DDL wrapper, is not claimed. This is the case that reddens if a text fallback for the shortfall ever creeps back; it mirrors what `control-read-retry.spec.ts` already pins for `BlockUnavailableError`.
- **`retries a shortfall at any depth of the cause chain`** — the typed link is claimed bare (the shape measured live on 2026-10-28, a single-link chain), under Quereus' commit wrap, under the DDL wrapper, and under DDL-over-module-create. Pins the depth reach the text match at the edge-node site never had.
- **`retries a lone node's own refusal to write alone, whatever reason it names`** — the solo-refusal shape (`approvals: 1, rejections: 0`) across all three `soloRefused` reasons, so a future branch on one of them has to change this case.
- **`keeps the pend/commit split over a typed shortfall chained below the aggregate`** — a typed shortfall under the pend-phase aggregate is claimed, and under the commit-phase aggregate stays vetoed, bare and through the DDL chain. This is the seam with the follow-on ticket: today the text veto fires, afterwards the typed one does, and the assertion is the same either way.

Retyped rather than added (same behaviours, real class instead of a message literal): the zero-rejection and rejection cases, both `agrees with the default classifier on every other failure` tables, `never retries a chain that reports a commit-phase batch at ANY level`, `retryControlWrite`'s exhaustion case, and the three `applyControlSchema` harness cases.

New fixtures: `shortfall({ approvals, peerCount, needed, rejections?, soloRefused? })` builds the real class; `ddlChain(inner, { viaModuleCreate? })` builds the startup wrapper stack as a real `cause` chain. `ddlFailure` stays for the cases genuinely about text (the self-coordination refusal, whose matcher is still textual), so the two spellings say which mechanism each case exercises. `nested` now takes a string or a built error.

New cases in `strands.spec.ts`:

- **`retries a shortfall delivered under a wrapper`** — the widening.
- **`does not retry a shortfall carrying a rejection`** — the narrowing, and that the two policies agree on it.
- **`does not retry a non-Error throw whose text would have matched`** — the other narrowing.

`superMajority()` is now a real `PromiseShortfallError` with an optional rejection count.

## What a reviewer should check

- **The claim's position.** It sits inside `matchesRetriableFailure`'s `links.some(...)`, after both vetoes. A shortfall carried by a `SyncRetryExhaustedError`, a non-final `TornActionError` or either partial-commit error must still be declined, and a shortfall under a commit-phase batch token must still be vetoed. There is no new case for the first of those — it rests on the claim being inside the same predicate the existing `describe.each(WRITE_CLASSIFIERS)` block already drives.
- **`rejections === 0`, not "any shortfall".** Unchanged from the regex it replaces. The class is raised when the round reached no verdict, so a non-zero count is a real member voting no and no backoff changes it.
- **Whether the two sites should share one predicate.** They currently repeat `link instanceof PromiseShortfallError && link.rejections === 0` — once in `control-write-retry.ts`'s `isUnansweredShortfall` (not exported) and once inline in `strands.ts`, each with a comment pointing at the other. Exporting one and importing it would make the "must not drift apart" claim structural instead of documentary. Left as it is because `isUnansweredShortfall`'s comment is written for the write funnel's veto ordering, which does not apply at the edge-node site; worth a second opinion.

## Known gaps

- **This diff was produced by two concurrent agent runs on one ticket.** Two tess runner processes (PIDs 22648 and 32284) each started an implement run for this ticket, 48 s apart. The source and spec edits landed from the sibling session; this session read the whole result, checked it against the ticket, confirmed no stale references to the removed symbols anywhere in `packages/`, `docs/` or the board, and ran the validation above. Nothing is known to be missing, but the diff did not come from a single authoring pass — review it as unreviewed work rather than as work one agent checked as it went.
- **The wrappers' `cause` preservation is established by reading them, not by a test.** `ddlChain` mirrors by hand what the optimystic plugin's `rewrapAsQueryError`, Quereus' module-create wrapper, its DDL wrapper and its failed-apply rewrap build. It pins the classifier against that shape; it does not prove Quereus still builds it. If a wrapper ever stops passing `cause`, these specs stay green and the retry silently stops engaging — fail-closed, and the same exposure the old regex had on a rewording, but worth knowing where the real guard is: `control-write-degraded-cohort-member.integration.ts` asserts this classifier against a shortfall from a real silent member.
- **No integration scenario was run.** A real shortfall needs a multi-node cluster, and those scenarios run past the per-ticket time budget. `control-write-degraded-cohort-member` is the one that produces the failure live and is the first thing to run if anything here is doubted.
- **A second loaded copy of `@optimystic/db-core`** fails `instanceof` and the shortfall is then not claimed. Fail-closed, stated in both source comments, not tested — the repo links one copy through root `resolutions`.
- **Two full-suite failures, resolved as load, not re-reported.** The contended full run (two concurrent `cadre-core` suites, 740 s against 465 s uncontended) failed `control-database-solo-warm-start.spec.ts` on `ensureOwnerKey() (post-addStrand) timed out after 15000ms` and `first.stop() timed out after 30000ms`. `tickets/.pre-existing-known.md` carries that file as a `one-off` whose mechanism is exactly these op-timeout bounds under CPU saturation, with a confirm protocol of "check CPU, then rerun the file alone". Both conditions were checked: two concurrent vitest suites were confirmed running, and the file then passed 6 of 6 alone with the genesis step at 2.2–3.0 s — the record's own "load, needs nothing" range, against its 15 s regression threshold. The record names two other tests in that file rather than these two; the mechanism and the bound are the same, so it was left unedited rather than extended by this ticket.

## Deliberately out of scope

- **The transactor's aggregate stays text-matched.** `TRANSACTOR_AGGREGATE`, the `[block:` / `[blocks:` tokens, `isUncommittedTransactorAggregate` and the commit-phase veto `reportsIndeterminateCommit` are untouched, and `SUPER_MAJORITY_IN_PEND_AGGREGATE` / `SUPER_MAJORITY_IN_COMMIT_AGGREGATE` are still message literals. Retiring that text match is `2-debt-control-retry-matches-the-transactor-aggregate-by-phase`, which also empties `RETRIABLE_CONTROL_WRITE_MATCHERS`.
- **`cadre-node-control-replication.spec.ts`** injects `new Error('Failed to get super-majority')` as an arbitrary failure for a drain test. Nothing classifies it; left alone.
- **Scenario and doc references to the sentence** (`control-write-degraded-cohort-member.integration.ts`, `docs/network/strand-addressing.md`) assert or describe a message upstream keeps unchanged; left alone.
- **`docs/cadre/control-replication.md`** needed no edit: it states the policy without saying how the shortfall is matched. Its one sentence about matching by text is about the commit-phase veto, which the follow-on ticket owns.
