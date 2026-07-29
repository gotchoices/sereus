description: Tests that check whether data written on one node reaches a second connected node fail every time, because a new safety check in the underlying peer-to-peer networking library refuses to accept a two-node group as a legitimate cluster; a human needs to decide whether we shrink the cluster size we ask for or push the fix upstream.
blocked-reason: human-decision (cluster-size configuration vs. upstream ../optimystic fix) — see "Update 2026-07-27"
files:
  - packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts
  - packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
  - packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
  - packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts
  - packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts
  - packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
  - packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts
  - packages/integration-tests/src/scenarios/websocket-chat.integration.ts
  - packages/integration-tests/src/scenarios/convergence-stress.integration.ts
  - packages/integration-tests/src/harness/test-party.ts (clusterSize: 3, line 48)
  - packages/cadre-core/src/cadre-node.ts (clusterSize: 3, line 643)
  - packages/cadre-core/src/strand-instance-manager.ts (clusterSize: 3, line 260)
  - ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts (admitMembership, lines 893-911 — emits low-confidence-downsize)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (consensusConfig.clusterSize, line 649)
  - ../optimystic/packages/db-core/src/cluster/structs.ts (allowUnvalidatedSmallCluster, line 135 — not plumbed)
  - ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts
  - ../optimystic/packages/db-core/src/transactor/network-transactor.ts
  - docs/STATUS.md
difficulty: hard
----

**Category (b): dependency outside this repo.** The failure originates entirely in the
linked sibling workspace `../optimystic` (the peer-to-peer database substrate), not in
any Sereus code. **What unblocks it:** an optimystic-side fix to two-node control-network
convergence — the cluster membership-admission decision and the transport stream-reset —
after which this test goes green. There is no Sereus change that resolves it (see
"Ruled-out" below).

## Update 2026-07-27 — re-verified, still failing; and it is no longer "intermittent"

Re-checked because `docs/STATUS.md` (~lines 517-542) records both previously-suspected upstream
root causes as fixed. **They did not close this.** Re-ran at Sereus `master` (dirty tree, HEAD
`9ca0d1d`) against `../optimystic` HEAD `9f3cc24` (clean tree; `db-p2p/dist/` dated 2026-07-27 vs
`src/` 2026-07-08, so deps are freshly built — still not build drift).

Commands and results:

| command (cwd) | runs | result |
| --- | --- | --- |
| `yarn vitest run control-db-two-node-convergence` (`packages/integration-tests`) | 3 | **3 failed / 0 passed** — `Test Files 1 failed (1)`, `Tests 1 failed (1)` each run |
| `yarn vitest run strand-membership-closed-strand-e2e` (`packages/integration-tests`) | 1 | **failed** — `Test Files 1 failed (1)`, `Tests 1 failed (1)` |
| `yarn vitest run networked.e2e` (`packages/quereus-plugin-sereus`) | 2 | **failed** — `Test Files 1 failed (1)`, `Tests 4 failed | 1 todo (5)` |

Every failure carries `membership-not-admitted:low-confidence-downsize`, 2/2 rejected, from
`ClusterCoordinator.executeTransaction` (`../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts:337`)
via `NetworkTransactor.pend:502`. The `StreamResetError` now appears as the *other* peer's
concurrent symptom in the same message rather than as a separate failure mode.

Excerpt (convergence run 2 of 3):
```
Some peers did not complete:
  <peerA>[block:XV8Ti...](in-flight) cause=Transaction rejected by validators (2/2 rejected):
    <peerA>: membership-not-admitted:low-confidence-downsize;
    <peerB>: membership-not-admitted:low-confidence-downsize,
  <peerB>[block:XV8Ti...](in-flight) cause=The stream has been reset
 ❯ ClusterCoordinator.executeTransaction ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts:337:10
```

**Not intermittent any more — 6/6 runs across 3 suites failed.** The earlier run-to-run variation
was only in *which* of the two peers reported the reset first.

### New finding: a Sereus-side config mismatch is at least partly responsible

The rejection is emitted by the **cluster membership admission gate** that landed upstream in
optimystic ticket `cluster-membership-admission-gate` (commits `1d732df`/`e285cdb` implement,
`4a991f3`/`f568454` review; `optimystic/tickets/complete/2-cluster-membership-admission-gate.md`).
That gate is *new work*, not one of the two fixes STATUS.md credits — so the ticket's premise that
"the upstream fixes will make this green" is wrong; a later upstream change re-broke it differently.

The exact reject path is `admitMembership` in
`../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts:893-911`: when a member cannot derive a
confident view of the cluster, it fails closed against its **configured** full size —
`declared.length < configuredClusterSize` ⇒ `low-confidence-downsize`.

Sereus hardcodes that configured size to **3** while these tests boot only **2** nodes:
- `packages/integration-tests/src/harness/test-party.ts:48` — `clusterSize: 3`
- `packages/cadre-core/src/cadre-node.ts:643` — `clusterSize: 3`
- `packages/cadre-core/src/strand-instance-manager.ts:260` — `clusterSize: 3`

`createLibp2pNode` threads that straight into `consensusConfig.clusterSize`
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:649`), so 2 declared < 3 configured ⇒ reject.
Note the existing `clusterPolicy.allowDownsize: true` we pass is a *coordinator*-side knob and the
new *member*-side gate does not consult it. The upstream escape hatch
`allowUnvalidatedSmallCluster` exists in `ClusterConsensusConfig`
(`../optimystic/packages/db-core/src/cluster/structs.ts:135`) but is **not** plumbed through
`createLibp2pNode`, so it is not reachable from Sereus today.

**This contradicts the "Not a test-harness misconfiguration" bullet below** — that bullet predates
the admission gate and should be treated as stale. There now plausibly *is* a Sereus-side lever.

### Decision needed from a human

Which way should this go? Neither option is obviously right, and it is a product call, not a
mechanical one:

- **(A) Make the configured cluster size match reality.** Two-node topologies are a real supported
  deployment (a phone + one host), so arguably `clusterSize` should be derived from the party's
  actual cohort rather than pinned at 3. Cheap to try in the test harness; but the same constant is
  in two *production* paths (`cadre-node.ts`, `strand-instance-manager.ts`), so this is a real
  durability/safety change, not a test tweak — a 2-node cluster genuinely has weaker
  self-shrink protection, which is exactly what the upstream gate was built to prevent.
- **(B) Treat it as upstream, as originally filed.** Ask optimystic to make the gate admit a
  legitimate small cluster (or to plumb `allowUnvalidatedSmallCluster` through `createLibp2pNode`
  so an operator can opt in knowingly).

**Recommended default: (A), scoped to the test harness first** — flip
`test-party.ts` to `clusterSize: 2` for two-node scenarios and re-run, purely as a diagnostic to
confirm the mechanism. That experiment is fully reversible and settles whether the admission gate
is the whole story or whether the `StreamResetError` leg is an independent second defect. Do not
change the two production call sites without a deliberate durability decision.

**If we do nothing:** these 6 test cases stay red and two-node control-network writes stay broken,
which is the primary product topology for a phone pairing with a single host.

## Failing test

```
cd packages/integration-tests
yarn vitest run control-db-two-node-convergence
```
(package: `@serfab/integration-tests`)

- File: `packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts`
- Name: `Two-node control-DB convergence > replicates an owner-written CadrePeer row
  from node A to node B over the live control network` (was "authority-written"; renamed since filing)

Reproduces at HEAD against **freshly-built** deps (the `../optimystic` `dist/` is newer than
its `src/`, so this is not stale-portal-dist build drift). It is **flaky / non-deterministic**:
consecutive runs fail with different p2p-layer signatures.

## Error output (differs run-to-run)

Reproduced this pass:
```
Error: Some peers did not complete:
  <peerB>[block:...](in-flight) cause=The stream has been reset,
  <peerA>[block:...](in-flight) cause=Transaction rejected by validators (2/2 rejected):
    <peerA>: membership-not-admitted:low-confidence-downsize;
    <peerB>: membership-not-admitted:low-confidence-downsize;
  root: The stream has been reset
 ❯ NetworkTransactor.pend        ../optimystic/packages/db-core/src/transactor/network-transactor.ts:502:22
 ❯ TransactorSource.transact     ../optimystic/packages/db-core/src/transactor/transactor-source.ts:96:22
 ❯ Collection.syncInternal/updateAndSync ../optimystic/packages/db-core/src/collection/collection.ts
 ...
Caused by: StreamResetError: The stream has been reset
 ❯ YamuxStream.onRemoteReset     @libp2p/utils/.../abstract-message-stream.js:253:21
```

Prior triage also observed a run that failed *only* with `StreamResetError` (no
validator rejection), and a run that failed *only* with the 2/2
`membership-not-admitted:low-confidence-downsize` rejection — two distinct p2p-layer
failure modes for the same test.

## Also-affected tests (same external root cause)

Later triage (2026-07-16, HEAD `7fbbb0c`) reproduced the *identical* validator rejection
(`membership-not-admitted:low-confidence-downsize`, 2/2, from optimystic
`ClusterCoordinator.executeTransaction` → `NetworkTransactor.pend:502`) in two more suites,
so they attach here rather than getting fresh tickets:

- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
  > Closed-strand membership lifecycle (real two-node strand) > founds a closed strand, admits
  a second member, and gates writes by membership
- `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` > `connectToStrand (networked e2e)`
  (4 cases: late-joining peer catch-up, peer A keeps serving reads after B shuts down, plus 2 more)

### Second attachment wave (2026-07-27, HEAD `157c684`) — 15 more cases

Triage of a later pre-existing-failure report reproduced the identical
`membership-not-admitted:low-confidence-downsize` (2/2 rejected, from
`ClusterCoordinator.executeTransaction`, often paired with the concurrent
`StreamResetError` on the other peer) across six more suites. Deps verified freshly built
(every `../optimystic` and `../quereus` package's `dist/` mtime newer than its `src/`), so
this is not build drift. All are two-node cohort commits; the 3-party and single-node cases
in the same files pass, which is the fingerprint of the `clusterSize: 3` mismatch above.

`packages/integration-tests/src/scenarios/` unless noted:

- `push-wake-e2e.integration.ts` > E2E push-wake over the control network >
  - `wakes a hibernating member over a real direct control dial`
  - `delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial`
  - (scenarios 3 and 4 in the same file pass — neither commits a 2-node cohort)
- `control-cohort-auto-convergence.integration.ts` > Control-cohort auto-convergence (no manual dial) >
  - `B converges on an owner-written CadrePeer row via in-node reconcile (production cold-start only)`
    — surfaces as `Timeout waiting for B observes the X CadrePeer row … after 45000ms`
- `control-write-while-alone-convergence.integration.ts` > Control-DB write-while-alone re-replication >
  - `re-replicates an owner CadrePeer row written while alone, once the cohort forms` (30s timeout)
  - `converges a DeviceToken self-registered while alone, once the cohort forms` (30s timeout)
- `strand-formation-e2e.integration.ts` > E2E Strand Formation > Phase 2: Strand instance lifecycle >
  - `should form strand, start instances, and replicate data`
  - `should support multiple independent strands between same parties`
  - (`should form a strand with three parties` passes — 3-node cohort meets `clusterSize: 3`)
- `multi-party-workflows.integration.ts` > Multi-Party Strand Workflows >
  - Phase 1 > `should form a closed strand and exchange messages bidirectionally`
  - Phase 1 > `should allow two parties to join an open strand and exchange data`
  - Phase 2 > `should converge after interleaved writes from both parties`
  - Phase 2 > `should converge across multiple rounds of bidirectional writes`
- `websocket-chat.integration.ts` > WebSocket Chat (server-to-server) >
  - `should replicate a chat message over WebSocket`
- `convergence-stress.integration.ts` > Convergence Stress Tests >
  - `should converge after rapid burst inserts from both nodes`
  - `should converge with interleaved inserts and random delays`
  - `should retain converged data after disconnect and reconnect`

Repro (from `packages/integration-tests`):
```
yarn vitest run --reporter=verbose src/scenarios/push-wake-e2e.integration.ts
yarn vitest run --reporter=verbose src/scenarios/control-cohort-auto-convergence.integration.ts src/scenarios/control-write-while-alone-convergence.integration.ts
yarn vitest run src/scenarios/strand-creation.integration.ts src/scenarios/strand-formation-e2e.integration.ts src/scenarios/multi-party-sync.integration.ts src/scenarios/multi-party-workflows.integration.ts src/scenarios/websocket-chat.integration.ts src/scenarios/convergence-stress.integration.ts
```
Last of those: `Test Files 4 failed | 2 passed (6)`, `Tests 10 failed | 19 passed (29)`.

The blast radius is now 21 test cases across 9 files, all one decision away from green —
which raises the stakes on the (A)/(B) call above rather than changing its terms.

The `networked.e2e.spec.ts` cases do **not** exercise the strand Authority/Manager RBAC role at
all yet fail with the same cluster-admission rejection — confirming a systemic two-node p2p
convergence defect, independent of any Sereus strand/role code. The emitter is optimystic
`db-p2p/src/cluster/cluster-repo.ts` (the only source of that string; no Sereus source emits it).
All three go green together once the optimystic-side fix below lands.

## Root cause (external)

Every failing frame is inside `../optimystic`:
- `db-core` `NetworkTransactor` / `TransactorSource` / `Collection` (the write/sync path),
- `db-p2p` `ClusterCoordinator` membership admission (`membership-not-admitted:low-confidence-downsize`),
- `@libp2p` / `@chainsafe/libp2p-yamux` transport (`StreamResetError: The stream has been reset`).

`membership-not-admitted:low-confidence-downsize` is an optimystic **cluster-node**
sizing/confidence decision: forming a two-node cluster, the coordinator can't admit
membership because confidence is too low, so the write's validators reject 2/2. The
stream-reset variant is transport-level. Neither touches `CadreControl` / `CadrePeer` or
any cadre-core code.

`docs/STATUS.md` already characterizes this exact behavior as external:
- The "Optimystic blocker (root cause — sibling repo `../optimystic`, HEAD past v0.14.1)"
  section (~line 484): multi-coordinator control-network **writes** can't reach a
  super-majority.
- The Option-B membership section (~line 552): "**Not** a super-majority-threshold
  rounding bug … The defect is upstream of the count (peer selection / protocol
  negotiation), and is optimystic-side networking work, not a one-line sereus change."

## Ruled-out (why this is not a Sereus-side fix)

- **Not stale portal-dist:** `../optimystic` `dist/` timestamps are newer than its `src/`
  — deps are freshly built; the failure is genuine runtime behavior, not build drift.
- ~~**Not a test-harness misconfiguration:**~~ **STALE — superseded by the 2026-07-27 update above.**
  Written before the upstream `cluster-membership-admission-gate` landed; the hardcoded
  `clusterSize: 3` vs. two booted nodes is now a candidate Sereus-side cause. Original text: the Sereus test wires a normal two-node control
  cohort (`bootPair` → `connectControlNodes`, both sides confirm the connection before the
  write) exactly as the passing strand convergence scenarios do. There is no Sereus knob
  that raises the optimystic cluster's admission confidence for a 2-node cluster.
- **The single-node authority write path is green:** `cadre-host-authority-node`
  "accept-phone authorizes a peer, then removePeer deletes it" passes, as do the cadre-core
  unit/constraint specs — so the voucher insert/delete through the schema predicates works;
  only the multi-node p2p convergence leg is flaky.

## What unblocks / next step (in ../optimystic, not here)

The fix belongs in the `../optimystic` workspace: make two-node control-network convergence
reliable — (a) the `ClusterCoordinator` membership admission must admit a legitimate
two-node cluster rather than emitting `low-confidence-downsize`, and (b) the Yamux/libp2p
transport stream-reset during the promise/commit phase must be handled (retry / prefer
direct connection) so a two-node write completes. This intersects the already-tracked
optimystic work referenced in `docs/STATUS.md` (multi-coordinator write super-majority /
cross-network coordinator selection). Once landed and the built `dist/` is linked here,
re-run the command above to confirm green, then remove this ticket's entry from
`tickets/.pre-existing-known.md`.

## Update 2026-07-28 — `clusterSize: 2` diagnostic run (mechanism confirmed, but not sufficient)

Ran the experiment the 2026-07-27 update recommended but did not perform. Method: temporarily
set `packages/cadre-core/src/cadre-node.ts` `clusterSize: 3` → `2` (the scenario boots
`CadreNode`s, so `harness/test-party.ts` is NOT the site this test uses), **rebuilt
`packages/cadre-core`**, ran `yarn vitest run control-db-two-node-convergence` from
`packages/integration-tests` three times, then reverted the edit and rebuilt again. Tree is
back to `clusterSize: 3` in both `src/` and `dist/`.

### Result

| config | runs | write phase | outcome |
|---|---|---|---|
| `clusterSize: 3` (baseline) | 1 | **rejected** — `2/2 rejected: membership-not-admitted:low-confidence-downsize` at `ClusterCoordinator.executeTransaction` | fail |
| `clusterSize: 2` (rebuilt) | 3 | **commits** — zero occurrences of `membership-not-admitted` across all three logs | fail, but later: `Timeout waiting for B observes the X CadrePeer row written on A after 30000ms` |

**The admission-gate mechanism is confirmed.** `declared.length < configuredClusterSize` is
what rejects the write; matching the configured size to the real cohort clears it completely
and deterministically.

**Lowering `clusterSize` is not by itself a fix.** With the write committing, the test still
fails one step later: node B never observes A's row within 30s. That is a *second*, distinct
problem (convergence/pull-on-read on a 2-node cohort where B is `transaction`-profile),
previously masked by the write rejection. Whoever takes the A/B decision should assume
option (A) alone does not turn this suite green — it exchanges one red for another, further
along.

### Methodology warning for the next investigator

`packages/integration-tests` imports `@serfab/cadre-core` through its **`dist/`** exports, not
`src/`. My first two "diagnostic" runs edited `src/` only and reproduced the baseline failure
exactly — they were silently still running `clusterSize: 3`. Rebuild the edited package before
believing any integration-test result. This is a live instance of
`backlog/debt-integration-tests-detect-stale-build`, which is worth doing before the next
person burns runs on it.

## Update 2026-07-29 — read-side failure isolated; two distinct upstream regressions

Attempt to get the suite green before an overnight run. Did not succeed. What the attempt
established (all diagnostics reverted; `packages/` is clean, `dist/` rebuilt to match `src/`):

### There are TWO regressions here, not one

1. **Write side — the admission gate** (already documented above). `clusterSize: 2` clears it
   completely: no `membership-not-admitted` in any run.
2. **Read side — B never converges**, and this is *not* a Sereus configuration issue. With the
   write committing, the reader still fails `Timeout waiting for B observes the X CadrePeer row
   after 30000ms`.

### Read-side evidence (`DEBUG='optimystic:*,cadre:*'`, full log analysed)

- B repeatedly runs `cluster-fetch:synced { blockId: 'default/CadrePeer', rev: 1 }` — **235
  times**, always `rev: 1`. It is syncing the right block and never sees a newer revision.
- Exactly **one** `rev: 2` appears in the entire 16k-line log, and it is a *data* block
  (`7f0hiXoMe4nekMhimS5R9y15OMoshpPWaAhfZssEK2M`), not the `default/CadrePeer` collection block.
- The 26 `cluster-fetch:no-quorum` entries are a red herring: all are `{ blockId:
  'default/Strand', responders: 0 }` — a table neither node has written.
- **Not a node-profile issue.** Re-ran with B as `storage` instead of `transaction` (both nodes
  storage): identical failure. The edge/transaction profile is not what breaks it.

### Prime suspects (dated, not yet proven)

The failures start ~2026-07-15; two upstream commits land just before, both touching exactly
these paths:

- `cluster-membership-admission-gate` — `e285cdb` (implement) / `f568454` (review), 2026-07-07.
  Confirmed cause of the write-side rejection.
- `txn-perf-authoritative-notfound` — `1de2e3a`, 2026-07-07. Suspected cause of the read side.
  Its own NOTE in `coordinator-repo.ts` says `NetworkTransactor.get` now treats an authoritative
  "absent" (`{ state: {} }`) as **final and no longer retries it**, "relying on this cluster
  reconciliation to have already run." A reader that gets an authoritative-absent for a row that
  exists on the writer, and never retries, matches the observed symptom exactly. **Verify before
  acting** — this is a reasoned suspect from log shape + timing, not a proven root cause.

### What this means for the decision above

Option (A) — lowering `clusterSize` — is now clearly **not sufficient**: it buys the write and
stops at the read. Whoever takes this should expect upstream work in `../optimystic` regardless,
and should probably start by testing the `txn-perf-authoritative-notfound` hypothesis (revert it
locally in the linked workspace and re-run this scenario) before designing anything.
