description: When one machine in a group is connected but slow or unresponsive, shared-settings changes made on another machine can be blocked by it. The measurement test now exists and has produced real numbers, but the outcome turned out to depend on which machine happens to coordinate the write — the remaining work is to make the test deterministic, finalize the measured timing bounds, and finish the handoff.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/index.ts, docs/architecture.md
difficulty: hard
----

# Coverage: control writes with a connected-but-degraded party member

The control database (shared settings + membership) replicates every block to the whole party
(`CONTROL_REPLICATION_BREADTH` = 16, effectively "everyone"). A control write commits only when a
super-majority of the **cohort** — the peers the block was offered to — approves. Because the
cohort is now the whole party, a member that is *connected but degraded* (slow, packet-losing,
mid-relay-reconnect) sits inside the cohort and counts against the bar. This ticket is the
measurement.

**Not the same as `debt-control-db-offline-peer-no-hang-coverage` (complete).** That covers members
that are *unreachable* — they never enter the cohort. This one is about members that *do* enter it.

## What the write path does (established by reading it — do not re-derive)

Paths below live in the sibling reference workspace `../optimystic` unless prefixed `packages/`.

1. **No phase-level timeout in the coordinator.** `ClusterCoordinator.collectPromises`
   (`packages/db-p2p/src/repo/cluster-coordinator.ts:460`) does a bare `Promise.all` over the
   cohort; per-peer failures become `null`.
2. **The per-RPC deadline bounds a silent peer:** `DEFAULT_DIAL_TIMEOUT_MS` = 3000,
   `DEFAULT_RESPONSE_TIMEOUT_MS` = 10000 (`packages/db-p2p/src/rpc-deadline.ts`).
3. **Two attempts per remote peer** (`promiseImmediateRetries` default 1); local peer invoked once.
4. **The bar at three nodes is unanimity:** `ceil(3 × 0.75) = 3`; failure message is exactly
   `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`.
5. **30 s transaction budget above it**, with batch-coordinator re-coordination retry excluding the
   failed coordinator.
6. **Caller sees** `Some peers did not complete: …` — assert by flattening the message text plus
   the `.cause` chain (the super-majority text appears INLINE in the per-peer list, root cause is
   `The stream has been reset` when a held stream is aborted).

<!-- resume-note -->
## State after run 3 (2026-07-30): code complete, MEASURED — but outcome is coordinator-dependent

Two prior runs wrote the suite; this run executed it repeatedly. All code is committed at
`590ada2` except the CURRENT WORKING TREE which additionally contains (uncommitted):

- `forced-cluster.ts`: new `pinCoordinator(nodes, candidates)` helper — patches `findCoordinator`
  (own-property, same seam as `forceFullCohort`'s `findCluster` patch), picks the first candidate
  not in the caller's `excludedPeers`, throws when all excluded (transactor treats that as
  candidates-exhausted). Header comment documents why. Exported via `harness/index.ts` (`export *`).
- Scenario: imports + wires `pinCoordinator([A, B, C], [A, B])` after `forceFullCohort` in
  `beforeAll`, `pinned?.restore()` in `afterAll`; header comment updated.
- Scenario constants TEMPORARILY raised for measurement (must be tightened to final values):
  `WRITE_TIMEOUT_MS` 60_000→240_000, `STALLED_WRITE_TIMEOUT_MS` 90_000→240_000,
  `FAILURE_CEILING_MS` 45_000→200_000, `DELAYED_COMMIT_CEILING_MS` 30_000→200_000, several per-`it`
  timeouts →300_000.

`yarn lint`: 0 errors. (6 warnings exist in `zz-scratch-delete-alone.integration.ts` — that file
belongs to ticket `control-delete-while-alone-tombstone`, commit `4548349`, NOT this ticket.)

### Measured results (the deliverable numbers so far — all single-machine, localhost websockets)

| Run | Setup | Outcome |
| --- | --- | --- |
| 1 full suite, unpinned | healthy case | commit, 359 ms ✓ |
| 2 isolated, unpinned | 2 s-delayed member | **commits, 55.0 s and 55.1 s per write** — the 2 s delay is paid serially by ~27 cluster RPCs per write |
| 3 isolated, unpinned | never-answering member | **clean failure at 42.1 s**, message contains the exact super-majority text, root cause `The stream has been reset`; rollback + not-queued assertions passed |
| 5 isolated, unpinned | SAME never-answering case | **committed in 504 ms** |
| 4 isolated, unpinned | reads-during-stall | write committed in 2.6 s (degradation never engaged), reads trivially fine |
| 6 full suite, pinned to [A, B] | all degraded cases | degradation NEVER engages: zero streams hit the delay/stall wrapper, every write commits in ~250–500 ms; the three "must fail / must be delayed" cases fail their assertions |

**Interpretation so far:** the outcome depends on which node the transactor's `findCoordinator`
draw picks per block (cold FRET ≈ proximity to block id ≈ uniform across the trio):

- Coordinator = the DEGRADED node C → writer reaches C over the repo protocol (healthy), C's own
  cluster vote is in-process → fast commit. Real availability, matches the ticket's "known hole".
- Coordinator = healthy remote (B) → B's cluster fan-out must RPC C's degraded cluster-protocol
  handler → degradation bites (55 s delayed commit / 42 s failure).
- Coordinator = the WRITER ITSELF (A, what the pin forces) → **open mystery**: writes commit fast
  and C's cluster handler never receives a stream, yet the healthy case's forced-cohort
  anti-vacuity assertions pass (cohort of 3 consulted). Budget ran out mid-code-read here.

### Where the mystery investigation stopped (continue here, don't restart)

Verified: `getRepo(selfPeer)` returns the node's `coordinatedRepo` (a `CoordinatorRepo` wrapping
`StorageRepo`) — see `../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:183`
and node wiring in `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:868`. So self-coordination
is SUPPOSED to run cluster consensus. Next read was `CoordinatorRepo.pend`
(`../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:644`) to find where the A-self path
avoids dialing C. Candidate explanations to check in code, in order:
- a policy/size trim (`clusterSize`, `clusterSizeTolerance`, `allowDownsize`) shrinking the
  effective consensus set on the self path;
- `ClusterClient` reusing an existing open stream to C (handler swap only affects NEW inbound
  streams) — note run 2 contradicts naive stream-reuse: every RPC there paid the 2 s delay;
- the anti-vacuity `findCluster` counter being satisfied by the REPLICATION path (breadth-16
  fan-out) rather than by consensus, letting consensus quietly run against a smaller set.

If the self path genuinely commits without consulting the cohort, that is a CONSISTENCY question
(one node can commit a control write alone whenever it self-coordinates) — file a `fix/` or
`blocked/` ticket for it with the evidence above; do not silently absorb it into this coverage
ticket.

## TODO (remaining)

- Resolve the self-coordination mystery above (code reading in `../optimystic`, then targeted runs).
- Make the suite deterministic. Likely correct pin: `pinCoordinator([A, B, C], [B])` — forcing the
  healthy REMOTE node to coordinate is the branch where degradation provably bites (runs 2 and 3).
  Keep the pin-to-writer branch's fast-commit observation documented in the scenario header either
  way.
- Re-run the full suite (twice+) under the deterministic pin; set FINAL constants with honest slack
  around the measured values (delayed commit ~55 s; stall failure ~42 s; keep the commit-case
  ceiling below the failure-case floor) and restore tight `within` deadlines and per-`it` timeouts.
- Re-check the two run-1 red flags under the deterministic setup (they were contaminated by an
  abandoned in-flight write in run 1 and have NOT been cleanly reproduced):
  - control READS hung ≥ 15 s while a write was stalled (`hasOwnerKey` timeout);
  - after a failed write, LATER writes failed instantly still naming the failed write's block id
    (`in-flight` + stream reset) — i.e. one failed control write may poison all subsequent ones.
  Each, if cleanly reproduced, is a real defect: keep the test as reproducer, file a `fix/` ticket.
- Run `yarn lint` again over the touched files.
- Update `docs/architecture.md` → "Replication cluster size" with one or two sentences on the
  measured cost: one degraded member turns a sub-second control write into ~55 s (slow member) or a
  ~42 s failure (silent member), EXCEPT when the degraded node itself coordinates, in which case the
  write commits fast.
- Write the review/ handoff (honest: single-machine timings; forced cohort replaces discovery;
  pinned coordinator replaces FRET's draw; the fast-commit-via-degraded-coordinator branch is
  documented, not asserted) and delete this ticket.

Measurement logs from this run (may not survive the session):
`C:\Users\n8ers\AppData\Local\Temp\claude\C--projects-sereus\d7bc0f30-411c-4187-9f66-8ad4c594d4ef\scratchpad\degraded-run*.log`
— all `[measured]` lines are reproduced in the table above.
