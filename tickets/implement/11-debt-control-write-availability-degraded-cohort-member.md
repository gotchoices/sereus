description: When one machine in a group is connected but slow or unresponsive, shared-settings changes made on another machine can be blocked by it. The measurement suite now runs deterministically with real timing numbers; remaining work is finalizing the assertion bounds, a confirmation re-run, docs, and the review handoff.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, docs/architecture.md
difficulty: medium
----

# Coverage: control writes with a connected-but-degraded party member

The control database (shared settings + membership) replicates every block to the whole party;
a control write commits only when a super-majority of the cohort approves, so one connected-but-
degraded member counts against the bar (at three nodes, `ceil(3 × 0.75) = 3` = unanimity). This
ticket is the measurement suite. See git history of this file for the full background and the
resolved two-key-network-instances root cause; the summary below is what the next agent needs.

<!-- resume-note -->
## State after run 5 (2026-07-30): pin is EFFECTIVE, suite is deterministic, 5/6 cases pass

A BUDGET_WARNING ended run 5 mid-ticket. All code changes below are in the working tree
(uncommitted at time of writing; the runner commits them with this ticket update). Typecheck
clean. One full suite execution under the new pin completed; its log is NOT retained — the
measured numbers are recorded below.

### What run 5 changed (all in the tree, working as measured)

- **`harness/forced-cluster.ts` rewritten around the prototype seam.** Root cause recap: every
  node has TWO `Libp2pKeyPeerNetwork` instances — the node-attached one (consensus cohort,
  admission) and a fresh default-args one the quereus-plugin collection factory builds for the
  `NetworkTransactor` (ALL transactor-level `findCluster`/`findCoordinator` calls). Instance
  patches only ever covered the first. Both helpers now patch
  `Libp2pKeyPeerNetwork.prototype`, covering every instance on every node:
  - `forceFullCohort(nodes)` — prototype `findCluster` returns the forced trio (keys in
    `nodes` order). Counters unchanged.
  - `pinCoordinator(candidates)` — SIGNATURE CHANGED (no `nodes` arg). Pins TWO seams, because
    `NetworkTransactor.consolidateCoordinators` (the write path's coordinator assignment,
    `../optimystic/packages/db-core/src/transactor/network-transactor.ts:361`) does greedy set
    cover over per-block `findCluster` results and only falls back to `findCoordinator` when
    those throw: (1) prototype `findCoordinator` → first non-excluded candidate, throws when
    all excluded (preserves re-coordination semantics); (2) prototype `findCluster` → wraps the
    impl in place at pin time (apply `forceFullCohort` FIRST) and re-keys its result
    candidates-first — the set cover keeps the first-inserted peer among coverage ties, which
    is what actually assigns the pend coordinator. Membership untouched, order only. Restore
    order: unpin before un-forcing (afterAll already does).
- **Scenario pins to `[A]`, NOT `[B]` as the previous plan said.** Measured hard blocker:
  `findCoordinator` is also the READ path's routing seam (`batchesForPayload`), and only A
  (owner/storage, wrote genesis solo) holds the genesis-era control blocks — pinning to B made
  every case fail instantly with `Query failed: Missing block (YferBRMcQ…)`. Pin [A] keeps
  reads served from the node that has the data while still forcing writes down the
  degradation-biting branch (coordinator A must dial INTO C's degraded cluster handler).
  Documented in the scenario header ("Why A and not B").

### Measured under the effective pin (one run, single-machine localhost websockets)

| Case | Outcome |
| --- | --- |
| healthy trio (authorize+remove) | ✓ 777 ms total |
| 2 s-delayed member | ✓ authorize 54.6 s, remove 54.8 s (matches old run 2's ~55 s) |
| never-answering member (authorize) | ✓ fails 20.2 s, exact super-majority text, block `dE8W…` in-flight |
| reads during stalled write | ✗ `hasOwnerKey (during stall) timed out after 15000ms` — REAL DEFECT, see below |
| recovery after restore | ✓ 794 ms |
| failed DELETE not queued | ✓ fails 20.4 s, exact text, rollback + not-queued assertions pass |

Failure cases now settle ~20 s, not the old ~42 s: the pin removes the second-coordinator
re-coordination retry (all candidates excluded → original error stays authoritative), leaving
two 10 s response-deadline attempts. This is the intended deterministic branch.

**Red flag #1 REPRODUCED → filed as `fix/control-reads-blocked-by-stalled-write`** (control
reads block behind an in-flight stalled write until it settles; not cadre-core's write lock —
reads are deliberately unlocked there). **Red flag #2 (failed write poisons later writes) did
NOT reproduce**: recovery committed in 794 ms right after a failed write — record it as a
tripwire line in the review handoff, not a ticket.

## TODO (remaining)

- Mark the reads-while-stalled case as an expected-failure reproducer so the suite is green
  while the fix ticket is open: `it.fails(...)` with a comment naming
  `fix/control-reads-blocked-by-stalled-write` and stating it must be promoted back to plain
  `it` when the fix lands (vitest flags an `it.fails` that passes). Do NOT skip or weaken its
  assertions.
- Finalize the TEMPORARY constants from measurements (proposed; sanity-check against the
  confirmation run): `WRITE_TIMEOUT_MS` 240_000 → 150_000; `STALLED_WRITE_TIMEOUT_MS` 240_000
  → 90_000; `FAILURE_CEILING_MS` 200_000 → 60_000; `DELAYED_COMMIT_CEILING_MS` 200_000 →
  120_000; keep `FAILURE_FLOOR_MS` 15_000 and `READ_TIMEOUT_MS` 15_000. Per-`it` timeouts:
  delayed case measured 109.5 s total → 240_000; the two stall cases and the reads case →
  120_000; healthy/recovery keep 120_000. (The old note "commit-case ceiling below
  failure-case floor" is impossible — delayed commits ~55 s exceed the ~20 s failures —
  ignore it.)
- One confirmation run of the full suite (from `packages/integration-tests`:
  `yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
  --reporter=verbose 2>&1 | tee <scratch>/run.log` — stream, never silent-redirect). Expect
  5 pass + 1 expected-fail; confirm timings sit inside the finalized bounds.
- `yarn lint` over the two touched files. (Known: warnings in
  `zz-scratch-delete-alone.integration.ts` belong to ticket
  `control-delete-while-alone-tombstone`, not this one.)
- Update `docs/architecture.md` → "Replication cluster size": one degraded member turns a
  sub-second control write into ~55 s (slow member — its 2 s delay is paid serially across
  ~27 cluster RPCs) or a ~20–42 s failure (silent member; ~20 s with a fixed coordinator, up
  to ~42 s when re-coordination retries through a second coordinator), EXCEPT when the
  degraded node itself coordinates — then the write commits fast (its own vote is in-process
  and its inbound cluster handler is never dialled). Also worth one line: reads currently
  block behind a stalled write (open fix ticket).
- Write the review/ handoff and delete this ticket. Be honest about: single-machine timings;
  forced cohort replaces discovery; pinned coordinator replaces the production draw (and pins
  READS to A — the `Missing block` constraint above); the two-key-network-instances discovery
  (reviewer should weigh whether production wants the collection factory to reuse
  `node.keyNetwork` instead of a fresh default-args instance — the fresh one also skips the
  node's clusterSize and network-scoping `protocolPrefix` configuration, so it is a real
  production question, not only a test seam); the set-cover tie-break dependency documented in
  `pinCoordinator`'s header (drift fails loudly — the must-fail cases start committing fast);
  prototype patches are process-wide (vitest per-file workers contain them — noted in harness
  header); the red flag #2 tripwire (one clean non-reproduction, keep an eye out); and that
  `forced.callCount()` alone does not prove consensus fan-out (pair with
  `interceptedStreams()`/elapsed bounds, which the cases already do).
