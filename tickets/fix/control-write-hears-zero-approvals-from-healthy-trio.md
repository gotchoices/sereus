---
description: On a three-machine party where nothing is broken, a control write sometimes gets no votes at all from the other machines and fails, and retrying it right away fails the same way.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, tickets/.pre-existing-known.md, docs/architecture.md
repro: verified
difficulty: hard
---

# A healthy trio's control write hears zero approvals

## What happens

A control write on a three-node party must be approved by all three machines
(`ceil(3 × 0.75) = 3`). In this failure the write is refused with

```
Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)
```

— **zero** approvals and **zero** rejections. Nobody voted either way, including the
two machines that are perfectly healthy and including the writer's own coordinator.
Retrying the write immediately (the control-write retry does, up to 3 attempts inside a
10 s budget) fails identically, so the write is lost and the caller sees the failure.

This is not the degraded-member case: it strikes the cases in
`control-write-degraded-cohort-member.integration.ts` where **nothing is degraded** (the
healthy trio) or where the third machine only answers 2 s late — cases that otherwise
commit in ~1 s and ~55 s respectively.

## What has been measured

- **Frequency.** 3 of 5 full-file runs on 2026-08-12 (that scenario's implement pass),
  then **2 of 2** on the same day's review pass. It is the dominant reason the scenario
  is red.
- **Every attempt fails, and the concurrent self-refresh writes fail with it.** Captured
  funnel log, review-pass run 2 — all three attempts of the test's own `[peer-insert]`
  write report `0/3`, interleaved with B's and C's *organic* background
  `[self-record-update]` writes failing on `The stream has been reset`, **all against the
  same block id**:

  ```
  [peer-insert]        attempt 1/3 → 0/3 approvals … [block:trhggk7f…]
  [self-record-update] attempt 2/3 → The stream has been reset … [block:trhggk7f…]
  [peer-insert]        attempt 2/3 → 0/3 approvals … [block:trhggk7f…]
  [self-record-update] failed after 3/3 … [block:trhggk7f…]
  [peer-insert]        failed after 3/3 … [block:trhggk7f…]
  ```

- **The earlier "progressive starvation" reading is not confirmed.** The implement pass
  saw approvals decline 2/3 → 1/3 → 0/3 across three attempts and proposed that a failed
  cluster promise round leaves an abandoned pend that starves later rounds until its
  cancel lands. The review-pass run above reports `0/3` from the **first** attempt, so
  the decline is one observation, not the mechanism. Both readings are consistent with a
  simpler one worth testing first: **several machines writing the same block at the same
  time knock each other out** rather than serialising.
- **Cost of the retry on this class.** Because this failure is fast, all three attempts
  and their backoffs fit inside the 10 s budget, so the retry runs to exhaustion and adds
  a measured ~11 s to a write that was never going to commit. That is the retry working
  as specified, not a second defect — but it is why this class is now more visible.

## Why it matters beyond the test

The interleaving above is **not** something the scenario stages. B's and C's
`[self-record-update]` writes are the ordinary self-registration refresh every node runs
on a timer, and they collide with the owner's write on the same control block. A real
party does exactly this. If concurrent control writes from different machines can knock
each other's votes out, then a party under any write concurrency loses writes.

## What would settle it

- Whether any peer received and evaluated the write at all (optimystic's cluster-member
  side logging) — `0 approvals, 0 rejections` says the coordinator counted no answers,
  which does not distinguish "never asked" from "asked, no reply" from "replied, reply
  lost".
- Whether the collision is with the *concurrent writers* or with a *prior failed round on
  the same block*: quiescing the two drones' self-refresh timers for the duration of one
  write is the cheap experiment.
- Whether it reproduces without the scenario's forced cohort / pinned coordinator
  (`harness/forced-cluster.ts`), i.e. whether the harness is a participant.

## Ownership note

`tickets/.pre-existing-known.md` lists this fingerprint against the
`control-write-degraded-cohort-member` scenario; that entry now points here. The
root cause is plausibly in `../optimystic` (cluster coordinator / pend lifecycle), which
this repo does not edit — if the investigation lands there, this ticket moves to
`blocked/` naming the upstream site, as `offline-node-cannot-serve-its-own-data` did.
Do not "fix" it by loosening the scenario's assertions.
