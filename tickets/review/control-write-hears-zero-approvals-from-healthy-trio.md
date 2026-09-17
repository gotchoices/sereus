description: A control write on a healthy three-machine party used to fail now and then with no votes at all from the other machines. The networking library fixed that a month ago and it has not recurred since, so this pass corrects the code comments, the architecture doc, the known-failures list, and one comment that described the retry as declining a case it actually retries.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, docs/architecture.md
difficulty: easy
----

# Retire the "zero approvals from a healthy trio" failure and correct what the code says about it

## What this closes

`Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)` from a healthy or delayed cohort member — nobody voting at all, including the two healthy machines — was fixed upstream on 2026-08-12 (`member-must-answer-a-lost-conflict-race`, optimystic `c7e3506d`) and has not recurred in any of the ~39 runs recorded in `tickets/.pre-existing-known.md` between 2026-08-21 and 2026-09-17. Everything changed here is documentation/comments; no runtime behavior changes.

## Changes made

**`control-write-degraded-cohort-member.integration.ts`** — six comment sites corrected:
- The "KNOWN INTERMITTENT" header block (was lines ~111–130) now says the class is fixed and historical, lists the fingerprints the file can still show (with owning tickets), and fixes the `DEBUG` tracing hint's trailing star.
- `printRetryDecisions`'s doc comment no longer cites the defunct `control-write-retry-scenario-coverage` ticket.
- The stream-reset injector's doc comment keeps the historical lesson (inject at the batch seam, not the cluster promise seam) but states it as history and drops the dead `blocked/` path.
- The healthy and delayed cases' capture comments no longer cite the (now fixed) `0/3 approvals` arm.
- The silent-member case's long NOTE is updated with a 2026-09-17 measurement: both isolated rounds that day settled at ~40 s (40161 ms, 40110 ms) and both reported `2/3`, not `0/3` — so a second pend round no longer implies the old fingerprint. **The `\d+/3` assertion itself was left untouched**, per the ticket's instruction (two observations aren't enough to tighten it, and the comment already explains why pinning the literal would flake).
- The retry-budget-rationale comment's reference to "the intermittent `0/3 approvals` class" is now labelled "(since-fixed)".

**`control-write-retry.ts`** — corrected two comments that were flatly wrong about current behavior, and pinned the real behavior as a deliberate, documented accepted tradeoff rather than an accident:
- The module header and the `SUPER_MAJORITY_SHORTFALL_UNANSWERED` doc comment both claimed a decisive rejection (`ValidatorRejectionError`, `Transaction rejected by validators`) is "never" retried by this classifier. That's false for a rejection raised while the cohort is still collecting *promises*: it reaches this repo wrapped in the transactor's `Some peers did not complete: …[block:…]` aggregate, and `isUncommittedTransactorAggregate` matches that wrapper on its own, regardless of what the cause inside it says. Both comments now say so.
- Added a `NOTE:` at `isUncommittedTransactorAggregate` recording this as an accepted tradeoff: what (promise-phase rejections are retried, up to two extra presentations inside the 10 s budget), why (nothing has committed yet, and the only rejection ever seen at that phase is the transient `pending conflict`), and the revisit condition (upstream `a-contended-pend-refusal-is-permanent-on-a-small-cohort`, `../optimystic/tickets/fix/` as of 2026-09-17).
- **No behavior change** — this is exactly what the code already did; it was undocumented (and mis-documented) before.

**`control-write-retry.spec.ts`** — added the missing case beside "never retries a super-majority shortfall carrying a rejection": `PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE`, the *live* message captured in `tickets/.logs/control-write-hears-zero.gate-r1.log` (2026-09-17, the `[peer-insert]` write A ran that was refused by C's unresolved pending action), asserted to classify as retriable. This pins the accepted tradeoff above as an explicit, testable claim rather than an implicit consequence of matcher composition.

**`docs/architecture.md`** — the control-write retry passage (the two long bullet paragraphs, in place, no new section) now says: the abandoned-pend limit is fixed upstream and closed (with the fix commit and the "no recurrence in 39 runs" evidence); the "one thing to watch when the upstream fix lands" note did **not** happen as anticipated — the losing member gained a `conflict` vote kind, not a `reject` vote, so the classifier's zero-rejections guard needed no change; and a *different*, narrower limit took its place (the `pending conflict` / zero-rejection-tolerance case), with a pointer to `control-write-refused-when-a-rival-write-holds-the-block`. The measured ~11 s fast-shortfall-re-presented-twice cost is kept as-is (still true, unaffected by this fix).

## What was verified

- `yarn lint` — clean (0 output, exit 0).
- `yarn typecheck` — clean, including the repo's stale-build-guard-wiring and vitest-coverage checks.
- **`cadre-core`'s vitest suite could not be run.** The package's `global-setup.ts` asserts build freshness for every `@optimystic/*` package it depends on before any test executes, and `@optimystic/db-p2p`'s `dist` was stale relative to its `src` for the whole session — `../optimystic` had an active ticket runner the entire time (confirmed via two live `tess/scripts/run.mjs` processes, and by watching an untracked file in `../optimystic` appear then disappear between two `git status` checks a few minutes apart, followed by a fresh commit landing). Per this ticket's own Phase 2 instruction ("if not quiet, do not rebuild it, do not force the runs"), I did not rebuild `@optimystic/db-p2p` to force the suite through — rebuilding mid-edit would have baked another repo's unreviewed, uncommitted work into what the suite measures, exactly the failure mode that guard exists to prevent.
- **In place of the blocked suite run**, I verified the changed/added classifier logic directly via `npx tsx` against the real `control-write-retry.ts` source (bypassing only the global-setup freshness gate, not the logic under test): all of the `isRetriableControlWriteFailure` / `isRetriableSchemaInitFailure` cases from the existing spec file (read/pend aggregate, commit-phase aggregate, unanswered shortfall, bare rejected shortfall, missing block, self-coordination under both policies, constraint failure) plus the new `PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE` case all returned the expected verdict. This is not a substitute for running the real spec file — **please run `npx vitest run test/control-write-retry.spec.ts` from `packages/cadre-core` once `../optimystic` is quiet and its packages are rebuilt**, to get the new test executing under the real harness (with coverage, watch mode compatibility, etc.) rather than my throwaway script.
- Grepped the whole `packages/` and `docs/` trees for `control-write-hears-zero-approvals-from-healthy-trio` and `scenario-coverage` — no stale references remain outside `tickets/`.

## Known gaps / what's left

- **Phase 2 (the confirmation runs) did not proceed.** `../optimystic` was not quiet for the whole session (see above), so per the ticket's own instruction I did not force rounds 3–5 of the isolated-run series. The count stands at **2 of 5** (from the prior session: round 1 = 1 failed/6 passed on an unrelated fingerprint now owned by `blocked/control-write-refused-when-a-rival-write-holds-the-block`; round 2 = 7/7 passed). Neither round showed the `0/3 approvals` fingerprint this ticket is about.
- **`tickets/.pre-existing-known.md` was not touched.** Its entries already contain the delta write-up from the prior session (the "Delta 2026-09-17" block at the top of the "Open" section) recording the closed class and the two-of-five count; replacing that with a final "outcome" summary was explicitly gated on completing the five-round series in this ticket's Phase 2, which didn't happen.
- If a future run of `control-write-degraded-cohort-member.integration.ts` ever reproduces `Failed to get super-majority: \d+/3 approvals (needed 3, 0 rejections)` from the healthy or delayed case (not the deliberately-silent-member case), that is a **regression**, not this ticket's closed class — it should be reported/filed fresh, not attributed back here.

## How to validate this ticket's changes

1. Read-only sanity: the four touched files' diffs are comments/docs/one test — `git diff` against `master` should show no production logic changes outside the accepted-tradeoff `NOTE:` additions (which are also comments) and the one new spec constant + `it` block.
2. Once `../optimystic` is quiet: `cd packages/cadre-core && npx vitest run test/control-write-retry.spec.ts` should pass, including the new "retries a promise-phase rejection carried inside a `[block:` aggregate" case.
3. Skim `docs/architecture.md`'s "No approval threshold can relax unanimity..." bullet (in "Replication cluster size") for internal consistency — it was edited as one long paragraph in place; check no `- ` bullet list got accidentally split (I caught and fixed one such split during this pass — worth a second look).
4. If/when `../optimystic` goes quiet and there's appetite to finish Phase 2: run `control-write-degraded-cohort-member.integration.ts` in isolation 3 more times per this ticket's original Phase 2 instructions, attribute any red run by the fingerprint table now in the scenario file's header comment, and only then update `tickets/.pre-existing-known.md`'s entries for this scenario.
