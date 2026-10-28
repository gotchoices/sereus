description: Sereus moved onto Optimystic 1.20.0 and Quereus 4.21.0. The control-write retry was checked against Optimystic's new typed errors on a live degraded cohort, the GitHub issue 44 ticket was closed on the release build, the release notes were written, and the full release gate is green.
prereq: control-write-retries-an-unanswered-read-again, strand-offline-mode
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: .release-notes.pending.md, packages/cadre-core/src/control-write-retry.ts (comments), packages/cadre-core/src/edge-node/strands.ts (NOTE on `SUPER_MAJORITY_FAILURE`), packages/cadre-core/test/control-write-retry.spec.ts (comments), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (sixth arm assertion), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (one reference), docs/cadre-consistency.md, docs/strands.md, tickets/complete/optimystic-write-made-alone-owes-no-one.md, tickets/backlog/debt-control-write-retry-matches-the-shortfall-by-type.md, tickets/.garden-report.md
----
# Adopt Optimystic 1.20.0 and Quereus 4.21.0

No runtime behaviour changed in this pass. The floors (`^1.20.0`, `^4.21.0`) landed with the ticket; the retry fix landed in the prereq. This pass changed comments, one scenario assertion, two doc sentences, a doc stamp, the release notes and the board.

## What was done

- **Upstream read** (`v1.19.0..v1.20.0`, all offline-sync): `1-offline-sync-typed-promise-shortfall`, `1.02-signed-validity-marker-on-reject-votes`, `1.04-offline-sync-typed-validity-rejection`, `1.06-offline-sync-commit-failure-classifier`, `6.2-offline-sync-solo-refusal`, `6.3-network-get-names-unreachable-blocks`, `6.4-offline-sync-cohort-reachability`, plus source at both tags where the notes make a claim. db-p2p 1.20.0 still declares `p2p-fret` ^1.2.1; FRET has no release after 1.2.1. Sereus registers the upstream plugin's modules and implements no module interface itself, so Quereus 4.21.0's module hook does not reach it (typecheck passes).
- **Shortfall matcher: kept the regex, filed `backlog/debt-control-write-retry-matches-the-shortfall-by-type`.** Live, on 1.20.0, the stalled write failed with the bare `PromiseShortfallError` object (`failed after 1/3 attempt(s): PromiseShortfallError: Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`, one-link chain) and the classifier answered retriable, so the matcher still fires. A typed check would work on that path, but switching rewrites about a dozen spec fixtures (including the text-built `ddlFailure` wrapper for schema init), and the schema-init path's live failure has never been captured, so whether every wrapper there keeps `cause` is known only from reading Quereus. Upstream pins the sentence as a downstream contract in its own tests, so the regex is stable meanwhile. The comment on the regex now names the class and the debt ticket.
- **`classifyCommitFailure` not adopted.** It would retire one of the four text matchers (the shortfall); it sorts the `[block:` aggregate, the `[blocks:` veto and the self-coordination refusal as `unknown`, and does not separate zero rejections. Not worth a ticket of its own; said in the debt ticket.
- **Comments corrected** in `control-write-retry.ts` and its spec: on 1.20.0 the injected stream reset fails the write's *read* as a typed unanswered block (claimed by the prereq's type check), and a pend's shortfall arrives on its own, so the degraded-cohort scenario no longer produces the `[block:` aggregate in any case. The NOTE on `isUncommittedTransactorAggregate` now says its live guard can pass without seeing that form, and how to make it appear again.
- **Deadlines Below Cadre** re-stamped at 1.20.0 (`59679072`). Diffed every file the table cites between the tags (`rpc-deadline.ts`, `cluster-policy.ts`, `cluster-coordinator.ts`, `cluster/structs.ts`, `collection-factory.ts`, `collection-watch.ts`, `reactivity/config.ts`, `storage-repo.ts`, `batch-coordinator.ts`, `network-transactor.ts`, `silent-consult-holds.ts`, `libp2p-node-base.ts`, `coordinator-repo.ts`, cohort-topic, `inbound-authorization.ts`): no value moved. `network/cohort-reachability.ts` adds only `DEFAULT_WAKE_DEBOUNCE_MS` (500 ms), which runs only with offline mode on, so no row was added.
- **Release notes** (`.release-notes.pending.md`): Upgrading (Sereus 1.19.0 fresh install resolves 1.20.0; mixed versions; stores), New (strand offline mode), Fixes (unanswered-read retry, stated as an embedder on cadre-core 1.19.0 + Optimystic 1.20.0 sees it), Dependencies (typed shortfall, validity rejection, unreachable read, plugin offline mode, Quereus 4.21.0).

## Mixed versions and stores (for the reviewer to check against upstream)

- **1.19.x node and a 1.20.0 validity-marked reject vote:** not accepted. The 1.19 verifier builds the old preimage and reports `InvalidSignature` against an honest member (upstream `1.02`, "Known gaps"). Only a member running a transaction validator marks rejects; `grep` finds no `validator` in `packages/*/src`, so Sereus parties produce none.
- **1.19.x writer and a 1.20.0 coordinator's typed refusal:** read at `v1.19.0`. A single-collection write (`Collection.syncAttempts`) treats a reason-only non-conflict refusal as retryable until `maxAttempts` (10) and throws `SyncRetryExhaustedError`; a multi-collection write (`TransactionCoordinator`, `PendRejectedError` with `conflict: false`) fails at once with the sentence in its message. The notes do not give a duration: each attempt meets the silent member again, so the total was not derived.
- **Offline mode with a 1.19.x coordinator:** 1.19 has no `refuseSolo`, so the notes say to turn offline mode on only once every machine runs 1.20.0.
- **Stores:** the source diff between the tags touches no stored block, log or key shape; `node-kv-namespaces.ts` adds `optimystic-offline/`, and tree actions gain new guard kinds that offline writes carry (additive). Upstream's upgrade-check has **no 1.19.0 fixture** (it has 1.18.0 and the new 1.20.0 one), and I did not run it (sibling is read-only), so "1.20.0 opens 1.19.0 stores" rests on reading, as the notes say.
- **Two module copies:** `smoke-published-install` installed one hoisted copy of every `@optimystic/*` package and of `@quereus/quereus`, no nested copies, which is what the `instanceof` checks need. Its scenario is solo, so it does not drive those checks.

## Blocked tickets

- `optimystic-write-made-alone-owes-no-one` → **complete.** Sixth arm on the release build: `local (1/2, unconfirmed [<joiner strand peer>], …)`, followed, 4 of 4 runs. The arm printed no joiner id before, so I made it print the id and assert `unconfirmed` equals exactly `[<joiner strand peer>]` (three arm-alone runs with the assertion, `tickets/.logs/adopt-optimystic-1-20-0.made-alone.r{1..3}.log`). Fourth and fifth arms again name the hibernated founder. **Not done: the reply on gotchoices/sereus#44** — that posts to GitHub, so it is left for a human. `docs/strands.md` (two sentences), the phone-link scenario comment and the FRET ticket's "If nothing is done" referenced it as open and were updated.
- `forked-control-collection-sync-livelocks` → stays blocked; dated line (neither upstream backlog ticket landed; the solo refusal is offline-queue-only, so control writes made alone still commit alone).
- `fret-maintenance-deadlines-below-the-declared-link` → stays blocked; dated section (FRET unchanged, Optimystic still passes no link round trip; with offline mode the reachability gate now also depends on FRET's verdict, and whether a FRET-`dead` but connected member counts as absent was not checked).
- `decide-link-deadlines-from-measured-response-time` → stays blocked; phone-arm series not run (about an hour per run); dated section on what 1.20.0 bears on.

## Gate

Linked upstream for every run: `../optimystic` at `1db4ff9a` (release commit `59679072` + upgrade-check fixture), 1 dirty package file (`quereus-plugin-optimystic/test/write-description.spec.ts`, not in any build); `../quereus` at `9545940b`, clean. It did not move during the gate.

| run | result |
|---|---|
| `yarn build`, `yarn lint`, `yarn typecheck`, `yarn check:dep-ranges` | pass (lint and typecheck re-run after the last `.ts` edits; cadre-core rebuilt after its comment edits) |
| cadre-core | 188 files, 2550 passed, 1 skipped |
| cadre-cli / cadre-host / cadre-provider / cadre-rn | 295 (1 skipped) / 444 (4 skipped) / 234 / 173 |
| quereus-plugin-sereus / reference-app-ns / -rn / -web | 159 (1 todo) / 71 / 180 / 11 (`config-check` has no test script) |
| root `test:*` suites (12) | all exit 0 |
| integration, 78 files (`tickets/.logs/adopt-optimystic-1-20-0.it-{b0..b10}.log`, each ending in an `upstream:` line) | **all green**; opt-in measurement files skipped as designed; the frame-cap arm is still an expected fail |
| `node scripts/smoke-published-install.mjs --skip-build` | **PASSED** 5/5 against published Optimystic 1.20.0 and Quereus 4.21.0 |

Two files ran longer than one 10-minute command at 1.19.0 (615 s and 827 s), so they were split by `-t`:
- `control-write-degraded-cohort-member`: b4a = healthy, delayed, stalled, stalled-read (kept together, since the stalled-read case once failed only after the stall case; it passed at 105.3 s), b4b = the other four. 8 of 8. Stall 84.3 s; silent-after-pend failed 210.4 s after the silence (bound 210 s derivation, 231 s ceiling), declined as commit-phase (`[blocks:1]`); the transient-reset case committed on attempt 2/3 after a typed `peers-unreachable` read failure — **the prereq's change, verified live for the first time**.
- `joiner-first-commit-over-slow-relay`: b5a = arms 1–3 and 6, b5b = arm 4, b5c = arm 5. All pass. **Not a whole-file run**, so cross-case interactions in these two files were not exercised in one process this time.

**Pinned budgets** (`--reporter=verbose`) all equal their pins; nothing re-pinned: solo write launch 366/39, insert 78/2, select 0; consult cold 41/33/1, genesis 24/23/33, foundStrand 1/1/1 and 29/15/14, reconcile 0; storage cold 60/35, warm 13/3.

## Tests

- **Changed:** `joiner-first-commit-over-slow-relay` sixth arm now asserts the commit made alone is owed to exactly the stopped joiner's strand node. This is the GitHub #44 behaviour the arm exists to reproduce; before, the arm printed the list and a human compared it. Ran 3 of 3 with the assertion.
- None added.

## For the reviewer

- The comment-only edits in `control-write-retry.ts` rest on one live run each (b4a, b4b). In particular, "no case produces the `[block:` aggregate on 1.20.0" is from this one run of the file.
- The release notes' "New" section summarises `docs/strands.md` → "Offline mode"; check it against that section rather than the code.
- No `.pre-existing-error.md` written: nothing failed.

## Review findings

Read the diff of `ticket(implement): adopt-optimystic-1-20-0` first, then checked its claims against the gate logs in `tickets/.logs/adopt-optimystic-1-20-0.*` and against `../optimystic` (read only).

### Checked, no change needed

- **Live claims behind the comment edits in `control-write-retry.ts`.** `it-b4a`/`it-b4b`: the pend shortfall arrives as a bare `PromiseShortfallError` (4 occurrences), the commit-phase shortfall arrives inside `[blocks:1]` and is declined non-transiently, the transient reset fails the read as `Block … is unavailable (peers-unreachable)` and is retried, and no `[block:` aggregate appears in either log. The comments say exactly this. The `[block:` guard being vacuous on 1.20.0 is already a `NOTE:` tripwire at `isUncommittedTransactorAggregate` with the way to make it live again; left as is.
- **Sixth arm assertion.** `bStrandPeer` is the joiner's strand peer captured before the stop; the three `made-alone.r*` logs show `unconfirmed [<that id>]` and the assertion passing. One behaviour, one assertion; kept.
- **Release notes "New" vs `docs/strands.md` → "Offline mode".** Consistent: promise list, journal locations, where it is not offered, `Strand` tables network-acknowledged, membership writers refusing, leave refusal, deferred app schema.
- **`docs/strands.md` "names the members it knows but could not reach".** Matches upstream `soloCohortOf`/`absentCohortMembers` ("every member the key network knows belongs in this cohort but could not place in it").
- **Backlog `debt-control-write-retry-matches-the-shortfall-by-type`.** Passes the filing bar (rung 1: a typed match retires the text-coupling class), carries `tradeoffs:` and names the live evidence; its second arm covers the edge-node retry.
- **Blocked re-checks** (`forked-control-collection-sync-livelocks`, `fret-maintenance-deadlines-below-the-declared-link`, `decide-link-deadlines-from-measured-response-time`): dated, state what was and was not checked; no change.
- **Tests.** No test added or cut: the only test change is the sixth arm's assertion, which pins the #44 behaviour the arm exists for.
- **Lint and typecheck** pass after the review edits; cadre-core rebuilt (one comment changed in `edge-node/strands.ts`). Unit and integration suites were not re-run: the review changed only comments, a markdown note and a ticket, and the implement gate is recorded above.

### Found and fixed (minor)

- **Release notes left out #44.** The issue is closed with this release and a human is to reply on it, but the notes did not mention it. Added a Fixes entry, stated as observed: on 1.20.0 a write made with the other member stopped lists it under `unconfirmed` and reaches it on restart; on 1.17.0 the same arm reported no owed member; which Optimystic change brought it is not established.
- **Release notes overstated the 1.19.0 fresh-install break.** "its control writes then fail on their first attempt" read as every control write; narrowed to a control write whose read no member answered, which is what the Fixes entry and the prereq describe.
- **`strand-workload-on-a-phone-link` comment overclaimed.** It said the solo-commit divergence there was "fixed by Optimystic 1.20.0". That divergence came from FRET marking a still-connected member `dead`, and whether such a member is named as owed was not measured (the FRET ticket says so). Reworded to say the completed ticket covered a stopped member and point at `blocked/fret-maintenance-deadlines-below-the-declared-link`. The phrase was also inaccurate on its own terms: upstream's owed-member change is in every tag from `v1.13.0`.
- **Stale NOTE in `edge-node/strands.ts`.** `SUPER_MAJORITY_FAILURE`'s NOTE said to switch to a typed error "if it gains" one; its condition has tripped (1.20.0 has `PromiseShortfallError`). The NOTE now says so and points at the backlog ticket's second arm.
- **The completed `optimystic-write-made-alone-owes-no-one` still read "Blocked on … Unblocks when".** Put it in the past tense and named the upstream ticket and the tag it landed in.

### Not done, left for a human

- **The reply on gotchoices/sereus#44** (posting to GitHub). Recorded in the completed ticket and the garden report.
- **A whole-file run** of `control-write-degraded-cohort-member` and `joiner-first-commit-over-slow-relay` (each was split by `-t` to fit a 10-minute command), so cross-case interactions in those two files were not exercised in one process on 1.20.0.

### Empty categories

- **Major findings / new tickets:** none. Nothing found reaches past a comment or a note.
- **New tripwires:** none; the one relevant tripwire (vacuous `[block:` guard) was added by the implementer at its site.
- **Resource cleanup, error handling, type safety, performance:** no runtime code changed in this ticket, so there was nothing new to review on these axes.
