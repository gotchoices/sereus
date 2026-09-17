description: Closed out a fixed bug about a control-database write that used to fail permanently after a brief network hiccup, added two unit tests so the code that decides "retry this write" cannot silently stop working, and corrected three places that still described the old, faster recovery timing.
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/architecture.md, tickets/.pre-existing-known.md, tickets/blocked/control-write-refused-when-a-rival-write-holds-the-block.md
----

# Close-out of `control-write-retry-does-not-absorb-a-transient-stream-reset`

The defect — a failed control-write attempt's own abort left a `pending` record that attempts 2 and 3 then collided with — was fixed **upstream**, in `../optimystic` (`complete/1-a-failed-attempt-must-discharge-its-own-pend`). This ticket recorded the closing evidence and pinned the two error shapes the upstream fix introduced. No runtime behavior changed in this repo, in either the implement pass or this review.

## What shipped

**Two unit cases in `packages/cadre-core/test/control-write-retry.spec.ts`** (file now 33 tests, all green):

- "never retries the cancel-discharge aggregate, even though it contains `[block:`" — pins `isUncommittedTransactorAggregate`'s doc-comment claim that the discriminator is the `Some peers did not complete:` prefix **and** the `[block:` token together, never the token alone. The literal is a reconstruction from `NetworkTransactor.dischargeCancel`'s real formatter, not a capture.
- `never retries a SyncRetryExhaustedError-shaped pending-conflict message` — a real captured literal from round 4 of the verification series, pinning that a `pending conflict` Optimystic's own collection sync already spent ten retries on is correctly declined here.

**One `NOTE:` tripwire** on `CONTROL_WRITE_RETRY_BUDGET_MS` in `packages/cadre-core/src/control-write-retry.ts`: a failed commit attempt now also pays a cancel discharge (bounded by six rounds and a 5 s `abortOrCancelTimeoutMs`) before its error returns, so two failed attempts could in principle consume the whole 10 s retry budget and cut the three-attempt policy to two. Not observed.

**The fingerprint retired in both places that listed it** — the header-comment table in `control-write-degraded-cohort-member.integration.ts` and the authoritative copy in `tickets/.pre-existing-known.md`, which also gained a Delta recording the five-round series, its in-flight-sibling caveat, and a new, not-yet-owned `resolvePeerAddrs` fingerprint from round 4.

## Review findings

**Verified against primary sources, not taken on faith.** Every checkable claim the implement pass made was re-derived: `MAX_CANCEL_ROUNDS = 6` and `abortOrCancelTimeoutMs: 5_000` are real (`network-transactor.ts:1071`, `collection-factory.ts:288`), so the tripwire's 10 s arithmetic holds; the reconstructed `CANCEL_DISCHARGE_AGGREGATE` literal matches `dischargeCancel`'s template character for character, including the `(in-flight)` status token the implement pass corrected away from the ticket's suggested `(no-response)`; the `SyncRetryExhaustedError` literal matches that class's message template in `db-core/src/collection/struct.ts:67`. The probe logs the ticket assumed were pruned are in fact still in `tickets/.logs/` (`control-write-retry-absorb.probe-r{1,2,3,4}.log`), so the five-round series was checked directly rather than through the ticket's transcription — it holds, and r4 is confirmed as one of the two stale-build-guard refusals.

**Minor — fixed in this pass (four).**

- *A measurement that two files still reported from 2026-08-12.* `docs/architecture.md` and the scenario file's timing table both said the reset absorption "commits on attempt 2 in ~0.7 s". All three probe logs show `committed on attempt 3/3` at 1550 ms. The implement pass edited that scenario file's header and added an attempt-count-keyed tripwire while leaving the contradicting measurement two dozen lines above it. Both now carry the re-measured figure alongside the dated original.
- *An off-by-one in a site count that the pass propagated into new prose.* The new `CANCEL_DISCHARGE_AGGREGATE` doc comment called `dischargeCancel` "the FOURTH place `[block:` appears"; grepping `../optimystic` finds exactly three (`network-transactor.ts` lines 304, 579, 1156 — the commit site at 942 renders `[blocks:`, which the repo's own reasoning treats as a disjoint token). Corrected in the spec, and the pre-existing `NOTE:` in `control-write-retry.ts` that was the source of the miscount reworded to match.
- *A cross-reference pointing the wrong way.* `tickets/.pre-existing-known.md` said the closed fingerprint is closed "as of the delta immediately below"; the closing delta is at the **top** of the file, above the table. A reader following it landed on the unrelated boot-gate delta. Now names the position instead of the direction.
- *A closed ticket still presented as a live alternative.* The discriminator table in `tickets/blocked/control-write-refused-when-a-rival-write-holds-the-block.md` names `control-write-retry-does-not-absorb-a-transient-stream-reset` as one of two other owners for a shared `pending conflict` text — a slug that is no longer on the board. Annotated as closed; the column is still useful for telling the shapes apart, so it stays.

**Tripwire — recorded at the code site, not filed (one).** The two injected resets no longer both land on attempt 1. The logs show reset 1 failing attempt 1 and reset 2 failing attempt 2, with attempt 3 committing — so the absorption case now rides the last of three attempts with **no spare attempt left**. It is green in all three measured rounds and the retry is still absorbing the class it is asserting, so this is a condition to watch, not work to do; one more attempt-consuming failure turns it red with `failed after 3/3 attempt(s)`. Parked as a `NOTE:` on `TRANSIENT_RESET_COUNT` in the scenario file, naming the two levers (that count, or `CONTROL_WRITE_ATTEMPTS`).

**Major — none.** The one candidate was the implement pass's decision *not* to file the new `resolvePeerAddrs` fingerprint from round 4. That decision is right and stands: it is one occurrence in five rounds with attribution inferred from timing rather than traced (the run had `sereus:cadre:node` debug off), and both candidate owners — `control-write-refused-when-a-rival-write-holds-the-block` and `control-peer-row-refresh-invisible-to-third-node` — are already on the board and already blocked on in-flight upstream work. An unattributed instance of an already-tracked class is evidence, and the ledger is where evidence lives; filing it against either candidate would assert an attribution nobody has established.

**Test coverage — adequate for what this ticket claims, with one honest limit.** Both new cases genuinely pin something: relaxing `isUncommittedTransactorAggregate` to "contains `[block:`" makes the first go red, and the second records *why* declining is correct next to the promise-phase `pending conflict` case that is deliberately retried. The limit is unchanged from what the ticket already stated: one literal is a reconstruction, so it defends a doc-comment claim rather than evidencing anything this repo has seen. Worth knowing, and now checked, is that the live absorption case fails with `cause=Cannot write to a stream that is closed`, not the `The stream has been reset` every spec literal uses — harmless, because the classifier matches the aggregate wrapper and never the cause text, which is exactly the property the wrapper-only discriminator was chosen for.

**Source hygiene — no action.** The touched files grew only comments. `control-write-retry.spec.ts` is 802 lines, which is large for a spec, but it is one classifier's table with the reasoning attached to each literal and splitting it would separate the cases from the rules they pin; not filed.

## Validation

- `yarn workspace @serfab/cadre-core test test/control-write-retry.spec.ts` — 33 passed, 0 failed.
- `yarn lint` — exit 0, no output.
- `yarn typecheck` — exit 0, including the stale-build-guard-wiring and test-coverage checks.
- `yarn workspace @serfab/cadre-core test` (full package, run because the implement pass ran only the single spec) — 2175 passed, 4 failed across three budget specs.

The integration scenario was not re-run: this pass changed only its comments, and the five-round series is the evidence the closure rests on.

**The four failures are pre-existing and unrelated.** All four trip a spec's *lower floor* — the measured cost went down (14 → 7 cohort consults, 2 → 1 per call, 2 → 0 raw-storage ops) — in specs that count Optimystic consults and storage calls, a subsystem no comment-only diff can reach. One of the three files is already tracked in `tickets/.pre-existing-known.md` under `warm-restart-into-declared-schema-diverges-from-declaration`; the other two (`control-founding-consult-budget.spec.ts`, `strand-solo-write-budget.spec.ts`) are not listed anywhere, so they are reported in `tickets/.pre-existing-error.md` with the full assertion text and a note that one upstream root cause plausibly covers all three. Nothing was skipped, disabled or loosened.
