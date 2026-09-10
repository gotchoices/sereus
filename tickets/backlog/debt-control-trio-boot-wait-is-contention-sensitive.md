----
description: Two integration files go red or lose their whole suite depending on which neighbour vitest schedules them beside, because a shared harness helper waits a fixed 45 seconds for control-peer replication. The failure moves between runs, which makes every full-suite result harder to read than it should be.
files: packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/wait-utils.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/testing.md
difficulty: medium
tradeoffs: the honest fixes cost either wall-clock (serializing the heavy files) or harness complexity (waiting on an event instead of a clock); the cheap fix — a bigger timeout — destroys the measurement the wait exists to make
likelihood: certain
----

# `bootControlTrio`'s fixed wait makes results depend on scheduling

## What was measured (2026-09-10, `tickets/.logs/rel2-check.log` and `rel2-trio-solo-{1,2}.log`)

`bootControlTrio` (`packages/integration-tests/src/harness/control-trio.ts:249`) waits up to 45s
for `B resolves C's signed CadrePeer address record`. Under full-suite load that wait expires, and
it takes two files down with it:

| run | `control-cohort-three-node-isolation` | `control-write-degraded-cohort-member` | test time |
| --- | --- | --- | --- |
| full suite | fails at `:65` | dies in setup — **all 7 tests reported skipped** | — |
| just the two together | fails at `:110` (a *different* test) | passes 8/9 | 333s |
| isolation file alone | **2/2 pass** | — | 25s |
| isolation file alone again | **2/2 pass** | — | 20s |

The same work takes 20-25s alone and 333s beside `control-write-degraded-cohort-member`, which
forces a 3-peer cohort and injects stalls. The throw site is stable; the test that happens to be
holding the boot when the clock runs out is not.

## Why this is worth fixing rather than tolerating

1. **A dead suite reports as skipped, not failed.** When the degraded-cohort file dies in setup,
   vitest reports its 7 tests as *skipped*. A summary line reading `276 passed | 7 skipped` invites
   the reader to treat those 7 as fine. They did not run at all. That is a reporting trap in the one
   artifact a release decision is made from.
2. **It manufactures false regressions.** `control-cohort-three-node-isolation` passed on one full
   run and failed on the next against the same sibling build, on a night that had touched
   `membership-connection-gater.ts` — so it read as a regression in connection gating and cost a
   bisect-shaped investigation to clear. It will do that again.

## What NOT to do

**Do not raise the 45s timeout.** The wait is the measurement — how long a signed `CadrePeer` row
takes to reach a third node is exactly what `blocked/control-peer-row-refresh-invisible-to-third-node`
exists to characterize. A longer timeout hides the propagation delay instead of recording it, and
turns a load-sensitive red into a load-sensitive slow-green that nobody notices.

Equally, do not mark either file `skip`, `concurrent: false` by reflex, or `retry`. A retry would
paper over the same signal.

## Options

- **Give the wait a budget in work, not wall-clock.** Wait on the replication event or on a poll
  count, so a machine under load takes longer without failing. Most faithful; needs a signal the
  harness can actually observe.
- **Serialize the heavy control files** into their own vitest pool/file-group so a stall-injecting
  scenario is never co-scheduled with one that measures propagation latency. Cheap and honest; costs
  wall-clock on every full run, and `docs/testing.md` should then say why the grouping exists.
- **Make setup failure loud.** Independently of the above: a suite that dies in `beforeAll` should
  not summarize as `skipped`. Either assert the boot separately so it surfaces as a failure, or add
  a check to the run report that treats "skipped tests in a failed file" as red. This one is worth
  doing regardless of which option above is chosen.

Recommended default: **serialize the heavy files, and make setup failure loud.** The event-driven
wait is better but larger, and the reporting trap is the part that actually misleads a release
decision.

## Edge cases & interactions

- Whatever lands must keep the wait's *diagnostic value* — the timeout message names which node
  failed to resolve which record, and that text is cited by the blocked ticket.
- CI and a developer laptop have different core counts; a fix that works by luck of parallelism on
  one will not hold on the other.
- `wait-utils.ts:53` is shared by many scenarios. A change to `waitUntil` itself is a blast radius
  well beyond these two files — prefer changing the caller or the scheduling.

## TODO

- [ ] Decide between the work-budgeted wait and file-group serialization.
- [ ] Make a suite that dies in setup report red rather than skipped.
- [ ] Re-run the full suite three times and confirm the two files are stable regardless of order.
- [ ] Record the chosen grouping and its reason in `docs/testing.md`.
