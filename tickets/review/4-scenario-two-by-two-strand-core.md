description: Review the new test where two people, each with two machines, share one workspace across all four machines — writes replicate everywhere, a write still commits with one machine switched off, and the returning machine catches up.
files: packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts, packages/integration-tests/src/harness/strand-join.ts, docs/testing.md, packages/quereus-plugin-sereus/src/cluster-size.ts
----

# Review: two parties × two machines, one strand across all four

Implemented per the implement-stage ticket's settled design (one narrative `it`, phased,
one topology). This is the first test to run a strand at four machines — the designed
operating point of `DEFAULT_STRAND_CLUSTER_SIZE = 4` — and the first that can assert a
commit with a machine off (3-of-4 approvals).

## What was built

- **New scenario** `packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts`:
  one `it` (explicit 420 s timeout; `vitest.config.ts` untouched), phases:
  1. Founder-party write on a[0] → raw-store coverage gated on a[1], b[0], b[1]
     (`awaitBlockCoverage`, probe rule: stores before any cross-machine DB read) →
     visibility on all four databases.
  2. Write from b[1] — a non-founding machine of the non-founding party, a writer path
     nothing else exercises — same coverage-then-visibility gating.
  3. 20 rapid-sequential interleaved writes (5 rounds × 4 machines taking turns,
     read-then-write per iteration, UUID keys, never `Promise.all` across writers) →
     identical row sets on all four databases.
  4. `a1.node.stop()` (whole machine off), live strand nodes observed dropping the dead
     peer, then a write on b[0] commits — wrapped in a bounded retry (90 s budget) that
     distinguishes the upstream lost-conflict flake from a genuine
     cannot-commit-degraded regression. Visibility gated on the three live machines.
  5. New `CadreNode` with a[1]'s SAME key and SAME `captureRawStorage` capture
     (memoized per scope — same durable backend), control reconnect to a[0], same
     `addStrand`, re-dial of the three live strand nodes via `connectStrandNodes`,
     then the physical catch-up gate `awaitBlockCoverage(b0Store, a1Store)` BEFORE the
     read-back of the missed row (and the full row set) through the restarted node.
  Teardown: `finally` stops the restarted node explicitly (it is outside the topology's
  started list) then `topology.stop()`; the original a[1]'s early stop repeats safely.
- **Harness change**: `harness/strand-join.ts` now exports `connectStrandNodes`
  (no behaviour change) and the `StrandLibp2p` type alias — the latter because the
  package emits declarations and an exported signature cannot use a private name.
- **Docs**: `docs/testing.md` → Topology coverage map: the four-machine cross-party
  shape now points at the scenario file; a new **Uncovered** line keeps the membership
  variant pointing at ticket `scenario-two-by-two-strand-membership` (sibling, still in
  implement/).

## Validation performed

- `yarn lint` and repo-root `yarn typecheck`: clean.
- Scenario run twice in the foreground, both green; logs kept at
  `tickets/.logs/4-scenario-two-by-two-strand-core.test1.log` / `.test2.log`.
  Wall-clock (run 1 / run 2): bring-up 6.6 s / 6.6 s, phase 3 total 6.3 s / 7.1 s,
  degraded write 0.22 s / 0.27 s (attempt 1 both runs), phase 5 4.0 s / 7.8 s, whole
  test 18.8 s / 23.6 s — the 420 s timeout is ~18× headroom.

## Honest gaps a reviewer should weigh

- **The degraded-write slow path never fired.** The design budgeted ~90 s for the write
  possibly paying ~2 × 10 s ClusterClient deadlines while the cohort still lists the
  dead peer; in both runs the live nodes dropped the peer first and the write committed
  in ~250 ms on attempt 1. So `insertWithRetry`'s retry and read-back branches are
  UNEXECUTED code paths — correct by reading, not by observation. The budget stands as
  headroom for slower machines/cohort states, not as measured need.
- **Two green runs only.** The suite's physical-replication tests have a flakiness
  history; two runs is the ticket's floor, not statistical evidence. Cheap to re-run
  (~40 s per invocation).
- **Phase 5's physical claim is scoped to `b0Store ⊆ a1Store`.** The subsequent
  full-row-set read through the restarted node is a visibility claim layered on top,
  not an additional physical proof — deliberate, per the probe rule (coverage first),
  and b[0]'s store holds everything at steady state so the scope suffices.
- **Delivery mechanism not distinguished in phase 5**: whether the missed blocks
  arrived by peer-join backfill or ordinary replication after the re-dial is not (and
  per the ticket, should not be) asserted — the backfill only helps a coverage claim.
- **Additions beyond the ticket's literal recipe**: a `hasOutboundTo` gate on the
  restarted node's control reconnection to a[0] (determinism before `addStrand`), and
  the `StrandLibp2p` type export noted above.

## Out of scope (unchanged, per ticket)

NAT/relay strand reachability, >4-machine networks, block-count assertions
(`debt-replication-proof-above-cohort-size`,
`debt-strand-write-breadth-observed-end-to-end`), membership actions from a second
machine (`scenario-two-by-two-strand-membership`).
