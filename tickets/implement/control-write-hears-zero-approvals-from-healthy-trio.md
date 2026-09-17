----
description: A control write on a healthy three-machine party used to fail now and then with no votes at all from the other machines. The networking library fixed that a month ago and it has not been seen since, but the code comments, the architecture doc and the known-failures list still describe it as a live problem, and one comment about which failures get retried is wrong. Correct the record and finish the confirmation runs.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, docs/architecture.md, tickets/.pre-existing-known.md
repro: verified
difficulty: easy
----

# Retire the "zero approvals from a healthy trio" failure and correct what the code says about it

## Where this stands

The failure this ticket was opened for is a control write on a three-machine party being refused with `Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)` — nobody voted, including the two healthy machines. Its cause was in `@optimystic/db-p2p` (a member that lost a conflict race returned no vote, and an abandoned transaction held the block for 2 s). Upstream fixed it on 2026-08-12 (`member-must-answer-a-lost-conflict-race`, optimystic `c7e3506d`).

**It has not been recorded since.** `tickets/.pre-existing-known.md` and this ticket's history record roughly 39 runs of `control-write-degraded-cohort-member.integration.ts` between 2026-08-21 and 2026-09-17, and none reports a `0/3 approvals` from a healthy trio. Every shortfall in them is `2/3 approvals`, which is the file's deliberately silent-member case behaving as specified. No log retained in `tickets/.logs/` contains the `0/3` text. At the pre-fix rate of about 1 run in 3, that is enough to call it fixed. The count of 39 comes from the written records; two of those runs were made in the session that wrote this ticket.

Between 2026-09-03 and 2026-09-06 this ticket also carried a second, unrelated failure in the same file — one half-applied commit leaving a permanent pending record that failed 5 of the file's 7 tests every run. Upstream fixed that too (`1-torn-commit-must-cancel-the-blocks-it-abandoned`, optimystic `3c941a4a`), and the 5-of-7 cascade has not recurred since 2026-09-06.

## The 2026-09-17 gate: two rounds of five, and why it stopped

Run in isolation from `packages/integration-tests` with `npx vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts`. Both rounds loaded the same `@optimystic/db-p2p` build (built 12:05, from the tree committed as optimystic `e46e7d6f`).

| round | result | note |
| --- | --- | --- |
| 1 | 1 failed / 6 passed | "commits with a member delayed under the response deadline" — a fingerprint this file has not shown before, see below |
| 2 | 7 passed | |
| 3–5 | not run | refused by the stale-build guard |

Neither round showed `0/3 approvals`, a `cancelError`, a failed stream-reset absorption (that test passed both times, committing on attempt 3 of 3), the 5-of-7 cascade, or the boot-gate timeout.

Rounds 3–5 were not forced. `../optimystic`'s ticket runner was live the whole time. A review agent there touched `packages/db-p2p/src/cluster/race-resolution.ts` at 12:17 and then began an uncommitted edit to `packages/db-p2p/src/cluster/cluster-repo.ts`, which is the cluster-member code this scenario exercises. The guard has no override, by design. Rebuilding would have measured another repo's unreviewed, uncommitted work, under that agent's test load. Rounds 1 and 2 also ran while that agent was active, so they carry its machine load, though not its code.

Round 1's failure is **not this ticket's symptom** and has its own ticket: `blocked/control-write-refused-when-a-rival-write-holds-the-block`. Logs: `tickets/.logs/control-write-hears-zero.gate-r1.log` and `-r2.log`.

## What is wrong in this repo today

None of it is behaviour; all of it is the written record.

**The scenario file describes a fixed defect as live.** `control-write-degraded-cohort-member.integration.ts` has a "KNOWN INTERMITTENT" header block (around lines 111–130) that tells a reader a red run on `0/3 approvals` is "that tracked class, not a regression" and points at `tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio`, a path that no longer exists. A `0/3` from a healthy trio today *would* be a regression, and that comment tells the reader to ignore it. The same stale pointer or claim appears in the doc comment on `printRetryDecisions` (around 305–312, which also names a long-gone `control-write-retry-scenario-coverage` arm), the doc comment on the stream-reset injector (around 448–456), the healthy and delayed cases' capture comments (around 671 and 703), and the long NOTE in the silent-member case (around 752–763 and 792). The header's tracing hint is also out of date: `optimystic:db-p2p:*` debug channels have carried a peer-id suffix since 0.28.0, so `DEBUG='optimystic:db-p2p:cluster*'` needs the trailing star to match anything (already recorded in `tickets/.pre-existing-known.md`, 2026-09-05).

One measured detail in that NOTE has also moved. It says the silent-member case reports `2/3` when it fails on its first round (~20 s) and `0/3` when a second round runs (~40 s). Both 2026-09-17 rounds settled at ~40 s (40161 ms and 40110 ms) and both reported `2/3`. Update the comment with that measurement. **Leave the `\d+/3` assertion as it is** — two observations are not grounds to tighten it, and the comment already explains that pinning the literal makes the case flake.

**`docs/architecture.md` says the same thing.** The control-write retry passage (the long paragraphs at lines 97–98) describes the abandoned-pend mechanism as a known limit "until that upstream fix lands", cites the `blocked/` path, and ends with "One thing to watch when the upstream fix lands" about a reject vote. The fix landed; the losing member now signs a separate `conflict` vote that is never counted as a rejection, and the shortfall message was left byte-identical, so the thing to watch did not happen. The measured ~11 s cost of a fast-failing shortfall being re-presented twice is still true and should stay.

**A comment in the retry classifier is false.** `control-write-retry.ts` says, on `SUPER_MAJORITY_SHORTFALL_UNANSWERED` (lines 119–127), that a decisive rejection (`ValidatorRejectionError`, `Transaction rejected by validators`) is something "this classifier also never matches", and the module header (lines 19–20) says a write somebody actually rejected is never retried. That is not what happens for a rejection raised while collecting promises. Such a rejection reaches this repo wrapped in the transactor's aggregate — `Some peers did not complete: <peer>[block:<id>](in-flight) cause=Transaction rejected by validators …` — and `isUncommittedTransactorAggregate` matches that wrapper on its own, whatever the cause inside it says. `matchesRetriableMessage` asks whether *any* message in the chain matches *any* matcher, so the zero-rejections guard on the shortfall matcher never gets a say.

Evidence that this is real and not only a reading of the code: on 2026-09-05 attempts 2 and 3 of one write were both `Transaction rejected by validators (1/3 rejected)` and attempt 3 still ran (table in `fix/control-write-retry-does-not-absorb-a-transient-stream-reset`); and in round 1 above the same rejection was logged as `failed after 1/3 attempt(s)`, which `control-retry.ts` prints only when the classifier said "retriable" and the elapsed budget then stopped the loop. A refused-as-non-retriable failure prints `failed non-transiently … not retried here` instead. The 2026-09-03 pass on this ticket noticed the same thing and judged it safe, but did not correct the comments.

It is safe — nothing has committed at that phase — and right now it is also useful: the only validator rejection this repo has ever recorded at that phase is `pending conflict`, which means "another write holds this block right now" and is exactly what a retry a moment later gets past. So **do not change the behaviour in this ticket.** Make the comments say what the code does, say why it is kept, and pin it with a spec so it is deliberate rather than accidental. Whether to make "never re-present a real no" true for this phase is a later decision that depends on upstream, and it is written up in `blocked/control-write-refused-when-a-rival-write-holds-the-block`.

`control-write-retry.spec.ts` is where the gap shows: `SUPER_MAJORITY_REJECTED` is asserted non-retriable only as a bare message (lines 225–227 and 359–365). It is never asserted inside a `[block:` aggregate, which is the only shape it arrives in during that phase.

## TODO

### Phase 1 — corrections that depend on no test run

- In `control-write-degraded-cohort-member.integration.ts`, rewrite the "KNOWN INTERMITTENT" header block: the `0/3 approvals` class was fixed upstream on 2026-08-12 and a recurrence is a regression to report, not a known failure. Replace it with a short list of the fingerprints this file can still show and the ticket that owns each — `pending conflict` after a stream reset whose error carries `cancelError` → `control-write-retry-does-not-absorb-a-transient-stream-reset`; `pending conflict` with neither → `control-write-refused-when-a-rival-write-holds-the-block`; "7 skipped" with `Timeout waiting for B resolves C's signed address record` → `control-peer-row-refresh-invisible-to-third-node`. Fix the `DEBUG` hint to use a trailing star.
- Update the other comment sites listed above so none cites the `blocked/` path or describes the `0/3` class as live. Keep the historical lesson in the stream-reset injector's comment (inject at the batch seam, not the cluster promise seam) — it is still the reason for the design — but state it as history.
- Update the silent-member case's NOTE with the 2026-09-17 measurement (`2/3` at ~40 s, twice). Do not touch the `\d+/3` assertion, and do not loosen any other assertion in this file.
- In `control-write-retry.ts`, correct the comment on `SUPER_MAJORITY_SHORTFALL_UNANSWERED` and the module header so they describe the real behaviour: a rejection raised while collecting promises arrives inside a `[block:` aggregate and is re-presented. Add a `NOTE:` at `isUncommittedTransactorAggregate` recording it as an accepted tradeoff — what (promise-phase rejections are retried, up to two extra presentations inside the 10 s budget), why (nothing has committed, and the one rejection seen there is the transient `pending conflict`), and the revisit condition (upstream `a-contended-pend-refusal-is-permanent-on-a-small-cohort`, in `../optimystic/tickets/fix/` as of 2026-09-17, lands, after which `pending conflict` stops arriving as a rejection).
- In `control-write-retry.spec.ts`, add the missing case beside "never retries a super-majority shortfall carrying a rejection": a promise-phase aggregate carrying `Transaction rejected by validators (1/3 rejected): <peer>: pending conflict: block <id> held by unresolved action(s) <id>` classifies as retriable. Use the live message from `tickets/.logs/control-write-hears-zero.gate-r1.log`. Name the test for what it pins, and point its comment at the `NOTE:` above.
- In `docs/architecture.md`, bring the control-write retry passage up to date: the abandoned-pend limit is fixed upstream, the "one thing to watch" did not happen and why, and the retry's actual treatment of promise-phase rejections. Keep the measured ~11 s fast-shortfall cost. Edit in place; do not add a new section.
- Run `yarn lint`, `yarn typecheck`, and the `cadre-core` test suite.

### Phase 2 — finish the confirmation runs, only if conditions allow

- Check first that `../optimystic` is quiet: `git -C ../optimystic status --short` shows no source edits, and no `tess/scripts/run.mjs` process is running there. If it is not quiet, **do not rebuild it and do not force the runs.** Record the count as it stands (2 of 5) in the review handoff and move on; Phase 1 does not depend on this.
- If it is quiet, rebuild as the stale-build guard instructs and run rounds 3–5 in isolation, in the foreground, one round per command, `tee`'d into `tickets/.logs/`. Record each round's result and the optimystic commit it ran against.
- Attribute any red round by fingerprint using the list in the header comment before drawing a conclusion. A `0/3 approvals` with `0 rejections` from the healthy or delayed case is the only result that reopens this ticket's subject; if it appears, stop and file it in `fix/` with the log.
- Replace this scenario's entries in `tickets/.pre-existing-known.md` with the outcome: the `0/3` class closed, the rate measured, and the owning ticket for each remaining fingerprint.
