description: When one machine in a group is connected but slow or unresponsive, shared-settings changes made on another machine can be blocked by it. The measurement test exists and has produced real numbers, and the cause of the run-to-run flakiness is now fully understood — the remaining work is to re-point the test's coordinator pin at the seam the write path actually uses, finalize the measured timing bounds, and finish the handoff.
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
## State after run 4 (2026-07-30): MYSTERY RESOLVED — the pin patches the wrong instance

All suite code is committed (`f0a2140`); run 4's working tree touched nothing but this ticket
file. Runs 1–3 (commits `590ada2` + `f0a2140`) wrote the suite and produced the measured table
below. Run 4 was pure code-reading in `../optimystic` and closed the open mystery. **No
consistency defect exists — do not file the fix/blocked ticket the previous note conditionally
asked for.**

### The resolved root cause (read this before touching the harness)

There are TWO `Libp2pKeyPeerNetwork` instances per node, and the harness patches only one:

- `createLibp2pNode` builds the node's instance at `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:695`
  and exposes it as `(node as any).keyNetwork` at `:1301`. This instance serves the
  **coordinatedRepo** (`coordinatorRepo(keyNetwork, …)` at `:823`, applied `:868`) and
  `createClusterClient` (`:697`). `forceFullCohort` and `pinCoordinator` patch THIS instance —
  which is why forced 3-peer cohorts and consensus work at all.
- The control DB's writes, however, run through the quereus-plugin collection factory's
  `NetworkTransactor` (`ControlDatabase.initialize` registers the node via
  `registerLibp2pNode`, `packages/cadre-core/src/control-database.ts:296`). That transactor is
  built by `createNetworkTransactor`
  (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:141-200`),
  whose key network comes from `resolveKeyNetwork('libp2p', node)` at `:180` → **`new
  Libp2pKeyPeerNetwork(libp2pNode)` — a FRESH instance** (`:309-312`, default-args, cached with
  the transactor by `getOrCreateTransactor`). Every transactor-level `findCoordinator` (and
  `findCluster`) call goes through this UNPATCHED instance.

Consequences, which explain every measured run:

- `pinCoordinator` as committed is a **no-op for coordinator selection**. Run 6's "pinned to
  [A, B]" behavior was not A-self-coordination — the pin simply never applied.
- The unpatched instance has a per-key **coordinator cache**
  (`../optimystic/packages/db-p2p/src/libp2p-key-network.ts:399`, `source=cache`), and the hot
  control-tree block ids are stable, so ONE cold-FRET draw at the start of a suite sticks for the
  whole run. Draw lands on the degraded node C → the writer reaches C over the (healthy) repo
  protocol, C runs consensus and dials cluster RPCs **outbound** to A and B, C's own vote is
  in-process, and C's INBOUND cluster-handler wrapper never sees a stream → fast commit, zero
  intercepted streams (runs 5 and 6). Draw lands on A or B → the coordinator must dial INTO C's
  degraded cluster handler → 55 s delayed commit / 42 s named failure (runs 2 and 3).
- The "self path skips consensus" hypothesis is dead. `CoordinatorRepo.pend` does short-circuit
  to bare `storageRepo.pend` when `getClusterSize() <= 1`
  (`../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:649-652`), but `getClusterSize`
  uses the coordinatedRepo's (patched) instance, which returns 3 in this suite. That
  short-circuit only fires for genuinely self-only cohorts — by design for solo nodes.
- **Anti-vacuity caveat worth keeping:** `forced.callCount()` also increments from
  `CoordinatorRepo.verifyResponsibility` → `isResponsibleForBlock` → `findCluster`
  (`coordinator-repo.ts:249`, 60 s-cached per block). So the counter alone does not prove
  consensus fan-out ran — pair it with `interceptedStreams()` (already done in the degraded
  cases) or with an elapsed-time bound.

### Measured results (single-machine, localhost websockets — carried forward from run 3)

| Run | Setup | Outcome |
| --- | --- | --- |
| 1 full suite, unpinned | healthy case | commit, 359 ms ✓ |
| 2 isolated, unpinned | 2 s-delayed member | commits, **55.0 s / 55.1 s per write** — 2 s delay paid serially by ~27 cluster RPCs per write (coordinator = healthy node) |
| 3 isolated, unpinned | never-answering member | clean failure at **42.1 s**, exact super-majority text, root cause `The stream has been reset`; rollback + not-queued assertions passed |
| 5 isolated, unpinned | same never-answering case | committed in 504 ms (coordinator draw = degraded C — see root cause) |
| 4 isolated, unpinned | reads-during-stall | write committed in 2.6 s (degradation never engaged), reads fine |
| 6 full suite, "pinned [A,B]" | all degraded cases | pin ineffective (wrong instance); cached draw = C → all writes ~250–500 ms, zero intercepted streams, must-fail cases fail assertions |

## TODO (remaining)

- Re-point the pin at the seam the transactor actually uses. Two viable shapes — pick one and
  document why in the harness header:
  - **Prototype patch (recommended for simplicity):** override
    `Libp2pKeyPeerNetwork.prototype.findCoordinator` for the suite's lifetime (import the class
    from `@optimystic/db-p2p`), restore the original in `restore()`. Covers every instance —
    node-attached AND factory-created — on all three nodes. Bypasses the coordinator cache
    (the override replaces the method that consults it).
  - **Instance patch:** reach each node's factory transactor —
    `node.getControlDatabase()` → private `collectionFactory` → private `transactors` map →
    `(transactor as any).keyNetwork` — and own-property-patch `findCoordinator` there (transactor
    exists by pin time; control writes already ran in `beforeAll`). Fragile double-private access;
    only prefer it if the prototype patch proves too broad in practice.
- Audit `forceFullCohort` for the same two-instance issue: check whether `NetworkTransactor`
  calls `findCluster` on ITS instance anywhere on the write path (`batchesForPayload` /
  cluster-nominees / replication fan-out, `../optimystic/packages/db-core/src/transactor/network-transactor.ts:401-407`).
  Consensus cohort provably comes from the patched node instance (runs 2/3), so this may be
  fine — but confirm and note it in the harness header either way.
- Pin candidates to **[B]** (healthy REMOTE node) — the branch where degradation provably bites.
  Keep the fast-commit-via-degraded-coordinator branch documented in the scenario header (it is
  real availability, not a defect; the header text at scenario lines ~36-45 is already right,
  update its mechanism description to match the resolved root cause: cache + wrong-instance, not
  a fresh FRET draw per block).
- Re-run the full suite (twice+) under the effective pin; set FINAL constants with honest slack
  around measured values (delayed commit ~55 s; stall failure ~42 s; commit-case ceiling below
  failure-case floor). The committed file still carries TEMPORARY measurement constants that MUST
  be tightened: `WRITE_TIMEOUT_MS` 240_000, `STALLED_WRITE_TIMEOUT_MS` 240_000,
  `FAILURE_CEILING_MS` 200_000, `DELAYED_COMMIT_CEILING_MS` 200_000, per-`it` timeouts 300_000.
- Re-check the two run-1 red flags under the deterministic setup (contaminated by an abandoned
  in-flight write in run 1, never cleanly reproduced):
  - control READS hung ≥ 15 s while a write was stalled (`hasOwnerKey` timeout);
  - after a failed write, LATER writes failed instantly still naming the failed write's block id
    (`in-flight` + stream reset) — one failed control write may poison subsequent ones.
  Each, if cleanly reproduced, is a real defect: keep the test as reproducer, file a `fix/`
  ticket.
- `yarn lint` over touched files. (Known: 6 warnings in `zz-scratch-delete-alone.integration.ts`
  belong to ticket `control-delete-while-alone-tombstone`, NOT this one.)
- Update `docs/architecture.md` → "Replication cluster size": one degraded member turns a
  sub-second control write into ~55 s (slow member) or ~42 s failure (silent member), EXCEPT when
  the degraded node itself coordinates, in which case the write commits fast.
- Write the review/ handoff (honest: single-machine timings; forced cohort replaces discovery;
  pinned coordinator replaces the production draw; note the two-key-network-instances discovery —
  a reviewer may reasonably ask whether production wants the factory transactor to reuse
  `node.keyNetwork` instead of a fresh default-args instance; that is a question for review, not
  a defect proven here) and delete this ticket.
