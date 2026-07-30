----
description: Small parties need every member to approve each control write, so one dropped connection can fail a write — and our test harness quietly uses a looser rule than production, hiding the problem.
files: packages/integration-tests/src/harness/test-party.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts
----
Two facets of one setting, `superMajorityThreshold` — the fraction of a block's
replication cluster that must approve an Optimystic commit:

**Production fragility.** `CadreNode` leaves Optimystic's default of 0.75. The
control database replicates each block to up to 16 peers
(`CONTROL_REPLICATION_BREADTH`), but the cluster downsizes to the peers actually
present — in a three-member party that is 3, and `ceil(0.75 × 3) = 3`: every
control write needs **unanimous** approval. A single transient stream reset
during connection churn fails the whole commit. Observed for real while
validating `control-cohort-three-node-isolation.integration.ts`: a
`registerSelf()` issued while the third connection was forming failed with
`Some peers did not complete: … cause=The stream has been reset` /
`Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)`. The
record heartbeat retries the identical call every ~7.5 min, so production
self-heals eventually — but any one-shot control write in a small party can
fail outright, and callers are not uniformly written to retry.

**Harness divergence.** `createTestParty` (test-party.ts:62) overrides the
threshold to 0.51 precisely to dodge the above, with a comment pointing at this
ticket's slug — which did not exist until now. Consequence: a
commit-availability regression can pass every harness-built integration test
and still fail in a real party. Scenarios that construct `CadreNode` directly
(the three-node isolation scenario does) run the production threshold and had
to poll their control writes to stay stable.

Expected outcome — decide and implement one of:

- Small-party threshold semantics in the product (e.g. cap required approvals
  below cluster size once the cluster is ≥3, or an explicit `n-1` floor), so a
  lone flaky stream cannot veto a commit; or
- A product-level retry policy for control writes (beyond the heartbeat), so
  one-shot callers survive transient resets; or
- A deliberate, documented decision that unanimity-at-3 is correct — in which
  case the harness override should be removed so tests exercise what
  production runs.

Whichever way, the harness and production should stop diverging silently.
