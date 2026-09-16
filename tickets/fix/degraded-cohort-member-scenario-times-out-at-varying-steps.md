---
description: An integration scenario that checks control writes still commit when one cohort member is slow fails on both of two runs, but at a different step each time and with different deadlines — so either the scenario's time limits are too tight for a busy machine, or something in that path is genuinely slow. Until it is settled the suite cannot be read as green or red, which is worse than either.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/wait-utils.ts
repro: verified
---

# Degraded-cohort scenario fails at a different step on each run

Measured 2026-09-15 23:12 and again 23:26, against optimystic `c56c2bd4` with typecheck green.
Failed both runs, **at different steps**:

| Run | Step that timed out | Deadline |
|---|---|---|
| 23:12 (full suite) | "B resolves C's signed address record" (`waitUntil`, `wait-utils.ts:53`, called from line 606) | 45 000 ms |
| 23:26 (three files only) | "isMember (post-authorize, delayed)" (the scenario's own `withTimeout` at line 202) | 15 000 ms |

Both runs overlapped two SiteCAD ticket agents on the same machine (`SiteCAD_branch` from 22:44,
`SiteCAD` a fresh ticket from 23:11), so neither is a quiet-machine measurement.

## Why this is filed rather than retried

A moving failure and a fixed failure mean different things, and this one moves. Compare the
scenario that failed alongside it on both runs
(`control-cohort-edge-carries-data-fails-cohort-unreachable`): identical error at an identical
frame twice, which is what a defect looks like. This one failed at two unrelated steps with two
different deadlines, which is what contention looks like.

But "probably contention" is not a finding, and re-running until it goes green is not either. The
scenario deliberately degrades one cohort member — it *is* a timing test — so its deadlines encode
a claim about how slow a degraded member may be before a write should be considered broken. Either:

- **the deadlines are the claim and they are right**, in which case a machine running two other
  agents genuinely violates them and the scenario cannot be part of a suite that runs on a shared
  machine without being marked as needing exclusivity; or
- **the deadlines are incidental** — numbers picked to be comfortably large on an idle laptop — in
  which case they should be derived from the degradation the scenario injects (the delay it imposes
  on the member, plus the response deadline under test) rather than being round constants, so that
  a slow machine slows the whole scenario proportionally instead of breaking it.

The second is more likely, given 45 000 and 15 000 are both round numbers. Establish which before
changing a number, and if a deadline is raised, say in a comment what the new figure is derived
from — otherwise the next person on a busier machine raises it again.

## Do not confuse this with the vacuity fix

The third failure in the same two runs, `control-bring-up-quiet-period`, was a different problem
with an opposite shape: a scenario that had become too FAST to test anything, caught by its own
anti-vacuity assertion, and fixed in this pass by raising the per-operation storage delay from
12 ms to 50 ms (verified: bring-up 3037 ms against the 1000 ms bootstrap fuse). That one is closed.
The lesson worth carrying into this ticket is the same though: a timing constant should be derived
from the thing it is meant to outlast, and should fail loudly when it stops doing so.
