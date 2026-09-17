----
description: When two machines in a three-machine party change the same record at the same moment, one change can still be lost if a machine in the party is also slow. The old symptom — the change being refused as invalid — is fixed upstream and verified gone. What remains is that the change is now retried, gives up, and is still lost, silently; and in one run of five the whole party stopped settling writes for two minutes at a time.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-retry.ts, ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts
repro: verified for the old symptom (now gone); the residual loss reproduced in 2 of 5 isolated runs at optimystic 03ffadc4
----

# Unblocked 2026-09-17 — the fingerprint is gone; the write is still lost

**`Transaction rejected by validators (N/M rejected)` did not appear once in five isolated runs.**
Neither did the `pending conflict: block … held by unresolved action(s)` reason string that used to
sit inside it. The upstream fix is confirmed: contention is no longer voted as a rejection.

`../optimystic` was quiet and clean at HEAD `987c45cf` — `03ffadc4` plus one commit touching
`tickets/.garden-report.md` only — so the `dist` under measurement was exactly `03ffadc4`. The fix
is `ebc5483c` (implement) / `03ffadc4` (review), `a-contended-pend-refusal-is-permanent-on-a-small-cohort`.

## Five isolated runs of `control-write-degraded-cohort-member.integration.ts`

| run | result | `rejected by validators` | a control write permanently lost to contention |
| --- | --- | --- | --- |
| 1 | **1 passed / 6 failed** | 0 | yes |
| 2 | 7 passed | 0 | no |
| 3 | 7 passed | 0 | no |
| 4 | 7 passed | 0 | **yes — in a run that passed** |
| 5 | 7 passed | 0 | no |

Fresh process each time, one suite at a time, stale-build guard green on every run.

## What contention looks like now

It reaches this repo as upstream's own sync layer giving up, not as a vote:

```
Control write [self-record-update] failed non-transiently on attempt 1/3, not retried here:
SyncRetryExhaustedError: sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries:
  pending conflict: block(s) held by unresolved rival action(s) pkM1HAKGOKmJUc2aCK8NXA
```

and, in the same family:

```
SyncRetryExhaustedError: sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries:
  Pend blocks held: 2/3 member(s) hold an unresolved rival action (1/3 approvals)
```

This is the good half of the change working: the write is retryable, and upstream retries it ten
times by itself. Runs 2, 3 and 5 show contention absorbed silently, which is what a fix looks like.

**The bad half.** When the rival holder is the *delayed* member, ten retries are not enough, and
what this repo then receives is a `SyncRetryExhaustedError` — which its classifier treats as
non-transient and does not re-present (`failed non-transiently on attempt 1/3, not retried here`).
The write is lost exactly as this ticket originally described; only the words changed. In run 4 the
lost write was a node's background `[self-record-update]`, so **no test failed and nothing
surfaced** — the file went green over a dropped write.

**Run 1's cascade.** One write met the contention at 21:43 and the file did not recover: five of the
six remaining tests failed, three of them by timing out at the scenario's own 120 s ceiling
(`degraded-cohort control op authorizePeer(…) delayed timed out after 120000ms`), where the same
class of failure used to come back in about 10 s. The same rival action id,
`P6DsRqE3Mj2-escNG0gTvw`, was still named as the holder five minutes later at 21:48 — one pend
record that no one discharged, blocking every later write to that block. Before this change the
refusal was fast and the block cleared by itself within seconds (see "What was observed" below);
now the failure mode is slow and, in that run, durable.

## What is left

- [ ] **Take this to `../optimystic` first.** Both halves are theirs: a pend record that stands for
      minutes (run 1) and a retry budget of ten that a delayed member outlasts. The verbatim strings
      above are what to quote. Nothing here can discharge another machine's pend.
- [ ] **A lost write must not be silent.** Run 4 is the finding that matters most locally: a
      permanently failed `[self-record-update]` passed unnoticed because no assertion covers the
      background self-registration. Whatever upstream does, this repo should notice a control write
      it gave up on — a log line at warn, a counter, or a scenario assertion.
- [ ] **The classifier follow-up below was NOT done, deliberately.** Its premise is now confirmed
      — contention no longer arrives as a validator rejection at the promise phase — but its own
      closing caution turns out to be the actual answer: *"if contention arrives as a retryable
      stale-failure that optimystic's own layers retry, this repo may never see it at all."* It does,
      as a `SyncRetryExhaustedError`. So the change worth making is probably not "decline a chain
      that reports a validator rejection" but "decide whether a `SyncRetryExhaustedError` naming a
      rival action is worth re-presenting here", which is a different question and wants the
      upstream answer first. Also, 4 of 5 runs green is not green enough to flip a retry rule on.
- [ ] The accepted-tradeoff `NOTE:` in `packages/cadre-core/src/control-write-retry.ts` (≈line 195)
      states its own revisit condition as "when `a-contended-pend-refusal-is-permanent-on-a-small-cohort`
      lands". It has landed. The NOTE is now describing a shape that no longer arrives and must be
      rewritten or removed — do that in the same pass as the decision above, not before it.
- [ ] Update `tickets/.pre-existing-known.md`: its 2026-09-17 entry attributing this file's red to
      `Transaction rejected by validators (1/3 rejected)` is superseded, and a recurrence of that
      exact text is now a regression. The new fingerprint above needs an entry of its own.

---

# Original report (blocked): a control write that meets another in-flight write is refused as "rejected by validators"

**Why this is in `blocked/`.** The cause is in `@optimystic/db-p2p`, a dependency outside this repo. It is tracked there as `a-contended-pend-refusal-is-permanent-on-a-small-cohort`, filed on 2026-09-17 and promoted the same day to `../optimystic/tickets/fix/` (optimystic `8cadd6da`), so it is in that repo's pipeline and needs no promotion. Nothing in this repo can change how a cohort member votes.

**Unblock condition.** That upstream ticket lands and this repo is rebuilt against it. Then run `control-write-degraded-cohort-member.integration.ts` five times in isolation with `../optimystic` quiet, confirm this fingerprint is gone, and do the classifier follow-up at the bottom of this ticket.

## What was observed

2026-09-17, round 1 of 2 isolated runs of `control-write-degraded-cohort-member.integration.ts`, against optimystic `e46e7d6f`. The case "commits with a member delayed under the response deadline" failed; the other six tests passed. Machine A's `authorizePeer` was refused after 10117 ms with:

```
Some peers did not complete: <A>[block:BWDONTuA…](in-flight)
  cause=Transaction rejected by validators (1/3 rejected):
    <B>: pending conflict: block BWDONTuA… held by unresolved action(s) Iw7_hcvHMj5jXg0VRx3xDA
```

and this repo's retry logged `Control write [peer-insert] failed after 1/3 attempt(s)`. Log: `tickets/.logs/control-write-hears-zero.gate-r1.log`.

This is a different failure from the two that share its `pending conflict` text:

| | this ticket | `control-write-retry-does-not-absorb-a-transient-stream-reset` (closed 2026-09-17 — fixed upstream, verified over five rounds; kept here only to tell the shapes apart) | the 2026-09-03 half-applied-commit wedge (fixed) |
| --- | --- | --- | --- |
| a stream reset or `cancelError` precedes it | no | yes | no |
| the blocking record clears by itself | **yes** — the next test's write, seconds later, was not refused by it | no | no |
| tests lost in the file | 1 | 2 | 5 of 7 |

## The cause, and how much of it is established

**Established upstream, by their own measurement.** When a cohort member checks a new write and finds the block held by a *different* write's unresolved pending record, it votes **reject**. That condition is transient — the record goes away when the other write commits or cancels — but a reject vote is the permanent kind. The coordinator tolerates `peerCount − ceil(peerCount × threshold)` rejections. For this repo's control cohort that is `3 − ceil(3 × 0.75) = 0`, so a single "not right now" from one member is reported as `Transaction rejected by validators`. Upstream already has a vote kind that means "lost a race, try again" (`conflict`, added for the 2026-08-12 fix and deliberately never counted as a rejection); this path does not use it. Upstream reproduced the identical error text on a two-member cohort at the same commit.

**Established here.** The error text and the cohort arithmetic match exactly. The refusal was classed as retriable by this repo's retry — `failed after N/3 attempt(s)` is printed only on that path — and was not retried because the single attempt took 10.117 s and the retry's elapsed budget is 10 s (`CONTROL_WRITE_RETRY_BUDGET_MS` in `control-write-retry.ts`, checked in `control-retry.ts` before sleeping). The attempt was slow because the scenario delays every inbound cluster request to machine C by 2 s.

**Not established.** Whose write `Iw7_hcvHMj5jXg0VRx3xDA` was. The run had no upstream tracing on. The likely owner is machine C's routine refresh of its own address record: the log shows `Self peer record updated` for C at 18:11:58.982, within 100 ms of A's write starting, on the same table, and C's own write is slowed by the same 2 s delay so its pending record stands for longer than usual. That is an inference from timing. A run of the failing case under `DEBUG='optimystic:db-p2p:*'` (the trailing star is required; the channels carry a peer-id suffix) would name the action's author and show how long its record stood.

**Rate: unknown.** One occurrence in two rounds. The five-round series was stopped by the stale-build guard because `../optimystic`'s ticket runner was editing cluster code at the time, and both completed rounds ran under that runner's machine load. Do not quote 1-in-2 as a rate.

## Why it matters outside the test

The colliding write is the address-record refresh every machine runs by itself, so any real party produces this contention. On a healthy party this repo's retry gets past it: the refusal comes back fast, the retry re-presents the write 250 ms and then about 1 s later, and the other write has usually finished by then. A write is lost only when the party also has a slow member, because then one attempt can use up the whole 10 s budget. The user sees "rejected by validators", which reads as a verdict on the write rather than as contention.

## Decision for a human

**Option A — wait for the upstream fix (recommended).** The defect is a vote being cast as the wrong kind, and that is the only place it can be fixed properly. The upstream ticket is already being worked, and this repo already absorbs the common case.

**Option B — also let the retry ignore its elapsed budget for this one refusal.** In round 1 the next write to the same block, started within a second of the refusal, was not blocked, so a single immediate re-presentation would probably have committed. Against it: the 10 s budget is what guarantees the retry adds no latency to a write against a genuinely silent member, and an exception keyed on the words `pending conflict` is one more place this repo decides what to retry by reading another repo's error prose — upstream tracks that habit as a problem in `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`. It would also be removed again once upstream lands.

## Follow-up here once upstream lands

The retry classifier's stated rule is that a write somebody actually rejected is never re-presented. For a rejection raised while the cohort is still collecting promises, that rule does not hold today: such a rejection arrives inside a `Some peers did not complete: …[block:…]` wrapper, and `isUncommittedTransactorAggregate` matches the wrapper whatever the cause inside says. That is harmless (nothing has committed) and currently helpful, because `pending conflict` is the only rejection recorded at that phase and a retry is the right answer to it. `implement/control-write-hears-zero-approvals-from-healthy-trio` documents this as an accepted tradeoff with exactly this revisit condition.

Once upstream stops reporting contention as a rejection, the remaining promise-phase rejections are real refusals, and the rule can be made true: have `matchesRetriableMessage` decline a chain that reports a validator rejection or a non-zero rejection count, the same way `reportsIndeterminateCommit` already vetoes commit-phase chains, and flip the spec case that ticket adds. Check first how upstream's new answer reaches this repo — if contention arrives as a retryable stale-failure that optimystic's own layers retry, this repo may never see it at all.
