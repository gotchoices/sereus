----
description: The integration tests let a write succeed with fewer machines approving it than a real deployment requires, so a change that breaks writes in the field can still pass the test suite.
prereq:
files: packages/integration-tests/src/harness/test-party.ts, packages/cadre-core/src/cadre-node.ts
difficulty: medium
----

# Integration harness approves writes on a weaker threshold than production

## What is wrong

A write to the shared control database commits only once a **super-majority** of the machines it
was offered to approve it. How large a fraction counts as a super-majority is configurable.

- Production (`CadreNode`) leaves the storage layer's default: **0.75**.
- The integration-test harness overrides it to **0.51**
  (`packages/integration-tests/src/harness/test-party.ts`, `clusterPolicy.superMajorityThreshold`).

In a three-machine group that is the difference between needing 2 approvals (harness) and needing
3 (production). So a change that makes one machine stop approving writes keeps the whole suite
green and breaks every real party.

## Why now

The divergence is pre-existing — the override was there before — but it used to matter much less.
Each block was replicated to two machines, so the group being voted over was tiny and usually
just the writer plus one. Since `control-db-replicates-to-whole-party` landed, the group is the
**entire party**, which is exactly the situation where a stricter threshold starts refusing writes
the harness would have accepted. The false-green window is now wide.

## What resolving this looks like

Either is acceptable; the point is that the suite measures what ships.

- **Drop the override** so the harness inherits 0.75 like production. Most honest, and most likely
  to surface real failures — expect some scenarios to start failing, and treat those failures as
  findings rather than reasons to put the override back.
- **Keep a deliberate override but make it explicit and narrow** — per-scenario rather than
  harness-wide, with the reason stated at each site, so the default path is production-faithful.

Whichever is chosen, the `NOTE:` comment currently at the override site should be replaced by the
outcome.

## Related

`debt-control-write-availability-degraded-cohort-member` is the coverage gap this masks. Fixing
the threshold first makes that coverage meaningful.
