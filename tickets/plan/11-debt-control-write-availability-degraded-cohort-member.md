----
description: A group member whose machine is connected but slow or flaky can now block the group's shared-settings writes, where before it would have been ignored. Nothing tests what actually happens.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/harness/test-party.ts, docs/architecture.md
difficulty: hard
----

# Coverage: control writes with a connected-but-degraded party member

## What changed and why it matters

The control (shared settings / membership) database used to send each block to two machines.
It now sends every block to **every** machine in the party (`CONTROL_REPLICATION_BREADTH`,
shipped by `control-db-replicates-to-whole-party`). That was done for convergence: at two
copies, a machine that missed a write could never catch up.

The cost is on the write side, and it is untested. A write commits only when a super-majority
of the group it was offered to approves. That group is now the whole party. So a member that is
**connected but degraded** — slow, packet-losing, mid-relay-reconnect, thrashing — is inside the
group and counts against the approval threshold. At two copies the same member would usually
have been outside the group entirely and simply ignored.

Nobody has measured what that does. The plausible outcomes span a wide range: the write
succeeds after a delay, the write fails with a clear error, or the write hangs. All three want
different handling, and today we do not know which one happens.

## What to cover

- A party of three or more where one member is reachable but degraded, not absent. Latency
  injection, a throttled/lossy link, or a peer that accepts the stream and then stalls — the
  point is that it stays in the cohort.
- Assert an explicit outcome per operation under a per-operation deadline, so a freeze reports
  as a named failure rather than a bare test timeout (`control-stream.ts`'s `withTimeout`;
  `packages/cadre-core/test/control-database-solo.spec.ts` shows the pattern).
- Include the boundary where the degraded member is the difference between meeting and missing
  the super-majority — a party of three at Optimystic's default threshold of 0.75 needs all
  three, so one degraded member is decisive.
- If the finding is "writes hang", that is a defect this ticket has found, not a test bug.

## Explicitly distinct from three neighbouring tickets

- `debt-control-db-offline-peer-no-hang-coverage` covers members that are **unreachable**. Those
  never enter the cohort at all, and the write commits self-only under `allowDownsize`. This
  ticket is about members that *do* enter the cohort. Do not merge the two.
- `control-cohort-three-node-reconcile-isolation-test` is about whether the nodes form dials
  with each other in the first place, not about approving a write.
- `debt-harness-supermajority-threshold-diverges-from-production` is the reason a regression here
  can pass CI today; it should land first or alongside, or this coverage measures the wrong
  threshold.
