----
description: When two machines in a three-machine party change the same record at the same moment, one of the changes can be refused as if it were invalid, when it only needed to wait its turn. If one machine in the party is also slow, the refused change is not retried and is lost. The rule that turns "not right now" into "rejected" is in the networking library this project depends on but does not edit.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-retry.ts, ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts
repro: verified
----

# Blocked: a control write that meets another in-flight write is refused as "rejected by validators"

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
