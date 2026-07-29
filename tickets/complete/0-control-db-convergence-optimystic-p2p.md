----
description: Data written on one node never reached a second connected node, failing about eighteen tests. Four separate defects in the underlying peer-to-peer library, plus one configuration bug here, all had to be fixed; the integration suite now goes from eighteen failures to three unrelated ones.
----

# Complete: two-node control-DB convergence

Resolved 2026-07-29. `control-db-two-node-convergence` converges in **1.3 s**, where it
previously timed out at 30 s. The `packages/integration-tests` suite went from ~18 failures to
**3 failed / 113 passed** (24 of 27 files green), and the three survivors are unrelated —
filed as `bug-control-cohort-no-auto-dial` and `bug-strand-three-party-replication`.

## What was actually wrong — five defects, found one behind the other

| # | Defect | Where | Fix |
|---|--------|-------|-----|
| 1 | `clusterSize: 3` hardcoded while real cadres run 1–2 nodes, so members refused to vote on writes (`membership-not-admitted`) | this repo | `bug-cluster-size-exceeds-cadre-size` |
| 2 | `selectQuorumRev`'s absolute `Math.max(2, …)` floor made a revision held by exactly one peer unselectable at any cluster size; its lone-responder fallback let a reader corroborate its own stale revision | optimystic | `50af693` |
| 3 | A member could commit revision N holding no base revision — `applyTransform` returned undefined so nothing materialized, but `setLatest` advanced anyway, leaving the block unreadable, unservable, and poisoned against later writes | optimystic | `d6a22d2` |
| 4 | `reconcileBlock` declined at *two* gates: it never passed `corroboratorCapacity` to `selectQuorumRev` at all, and `selectQuorumBlock`'s content gate stayed on the strict floor | optimystic | `07cb230` |
| 5 | A node with no local metadata could never acquire a block by reading, even having just established which revision the cohort held — `getBlock` returned before `ensureRevision`, and restore is only reachable from there | optimystic | `559df6a` |

Defect 5 was the one that mattered downstream: the stranded block was the **collection header**,
so the reader could not open the collection at all — and `Collection.createOrOpen` treats an
unfetchable header as "does not exist" and silently invents an empty collection, which is why
this presented as "no members" rather than an error.

## Two wrong diagnoses on the way, both recorded in the history below

`txn-perf-authoritative-notfound` and, later, read-repair revision selection were each named as
the root cause with confidence and each was wrong. Both were derailed by the same artifact:
`cluster-fetch:synced` was logged **unconditionally**, whether or not anything was restored, so
222 lines that read as successful syncs were noise. That log line now reports the outcome
(`cluster-fetch:not-restored` when nothing moved), which is what finally made the real fault
legible in one grep.

Two methodology notes worth keeping: `packages/integration-tests` consumes `cadre-core` from
`dist/`, so two early experiments silently tested unmodified code — now guarded by
`debt-integration-tests-detect-stale-build`. And `quorum-restore.ts` contained a literal NUL
byte, so git classified it as binary and showed no diff or blame across two prior fixes to that
same file.

## Left open upstream

Filed in `../optimystic`, none blocking this repo:
`clustersize-conflates-replication-factor-and-admission-yardstick`,
`collection-open-silently-invents-empty-collection`,
`feat-inbound-stream-authorization-hook` (which unblocks
`control-repo-protocol-stream-authz-optimystic` here).

Also unresolved, and worth understanding: FRET reported `fretCohort=1` while `connected=1`,
which is the race that made the creating revision commit solo in the first place. The fixes make
that race harmless rather than preventing it.

---

# Original investigation record


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

---

## Update 2026-07-28 — read-side root cause identified; the previous suspect is wrong

Two independent code audits of `../optimystic` (one per suspect commit) both landed on the same
mechanism, and both **exonerate** the commit named in the 2026-07-27 update.

### `txn-perf-authoritative-notfound` is not the cause — retract that suspicion

Verified by reading the code, not inferred:

- The change is one predicate in `NetworkTransactor.get` (`packages/db-core/src/transactor/network-transactor.ts:151-161`),
  swapping `.some(entry has a block)` for `.every(id has an entry)` when deciding whether to retry.
- It alters behavior **only for responses that carry no block at all** (a genuine not-found,
  shape `{ state: {} }`). Our symptom is a block that exists at revision 1 — that response
  carries a materialized block, so old and new predicates both decline to retry identically.
  The changed line is never reached differently.
- It caches nothing. `isAuthoritative` is a closure over batch objects rebuilt inside each
  `get()` call; the only cache on `NetworkTransactor` stores coordinator peer ids, not results.
  Every subsequent read re-asks the network from scratch, so it cannot produce a *permanent* miss.
- Wrong layer entirely: `cluster-fetch:synced` is emitted server-side by `CoordinatorRepo` in
  `db-p2p`; this change is in the `db-core` client-side retry loop and cannot influence it. The
  only `db-p2p` delta in those commits is a comment.

### The actual cause: quorum-corroborated revision selection cannot work at two nodes

`packages/db-p2p/src/cluster/quorum-restore.ts` — `selectQuorumRev`, introduced 2026-07-03 by
`42765d8` / `6ad29d9` (`p2p-read-repair-verify-peer-claims`). That commit's own message states it
**replaced "max rev any single peer reports"** with a rule requiring peer corroboration.

```ts
quorumSize = Math.max(2, Math.floor(0.51 * responderCount))   // quorum-restore.ts:41-43
```

The `Math.max(2, …)` floor is absolute. Consequences, both verified:

- **A revision held by exactly one peer can never be selected, at any cluster size.** In our
  two-node cohort only A ever reaches rev 2, so rev 2 is permanently unselectable. The cohort
  re-selects rev 1 on every read, forever. Under the pre-`42765d8` max-wins rule a single peer at
  rev 2 was sufficient to drive restoration. This is a behavioral regression of exactly the
  observed shape.
- **The lone-responder fallback lets a node corroborate itself.** At `quorum-restore.ts:98-101`,
  when `responderCount < quorum` and there is a single distinct claim, that claim is returned as
  the quorum result. `clusterLatestCallback` self-short-circuits to local storage
  (`libp2p-node-base.ts:800-807`), so the reader's *own* revision is one of the claims. If A's
  `SyncClient.requestBlock` misses the hard 1 s per-peer timeout (`coordinator-repo.ts:354`), B is
  left holding only its own stale claim, accepts it, and logs it as a successful sync. This is the
  exact origin of our 235 × `cluster-fetch:synced { blockId: 'default/CadrePeer', rev: 1 }`.

Corroborating detail, also verified: **`cluster-fetch:synced` does not mean data moved.** The
"restoration" at `coordinator-repo.ts:318` calls `StorageRepo.get` with a commit context, which
only promotes a pending transaction the node *already holds locally* (`storage-repo.ts:167-198`).
It never fetches bytes from a peer. If the node has no pending for that `actionId` the call is a
silent no-op and the success line is logged regardless. So even fixing revision selection may not
be sufficient on its own — the block-transferring path (`reconcileBlock` → `fetchArchiveFromPeer`)
runs only on commit.

### Adjacent upstream defect found while looking

`libp2p-node-base.ts:649` now defaults `clusterSize` to **10** when the embedder does not set one,
and (since `cluster-membership-admission-gate`) feeds it to the member-side admission gate. Any
Optimystic consumer that never configured `clusterSize` is therefore gated against a ten-node
reference and will refuse to vote on writes under low FRET confidence. We are insulated only
because we happen to set a value; other consumers are not.

### Status of the human decision

The original question — shrink `clusterSize` or push upstream — is now answered: **both, and they
are separate pieces of work.**

- The sereus-side half is no longer a decision. It is filed as `bug-cluster-size-exceeds-cadre-size`
  in `tickets/fix/` and is in the pipeline. It fixes the write side only.
- The read side is genuinely upstream in `../optimystic` and cannot be fixed from this repo. It
  needs `selectQuorumRev` to stop requiring two corroborators for a revision at small cluster
  sizes, and to stop counting the reader itself as a corroborator.

This ticket stays blocked on the upstream change landing.

## Update 2026-07-29 — write side landed; this ticket is now purely upstream

`bug-cluster-size-exceeds-cadre-size` shipped. `clusterSize` is now one party-wide value
(`DEFAULT_CLUSTER_SIZE = 2` in `packages/cadre-core/src/types.ts`, overridable via
`CadreNodeConfig.clusterSize`) used by the control network, every strand network, the
integration harness, and the plugin e2e spec. The stale line references in the `files:`
header above (`clusterSize: 3` at `cadre-node.ts:643`, `strand-instance-manager.ts:260`,
`test-party.ts:48`) no longer apply.

Verified after the change, with `DEBUG='optimystic:db-p2p:cluster*'`:

| Scenario | `admission-reject` | cluster transactions | test |
| --- | --- | --- | --- |
| `control-write-while-alone-convergence` | 0 (was 6) | 3 start → 3 complete | still fails |
| `control-db-two-node-convergence` | 0 | 11 start → 11 complete | still fails |
| `quereus-plugin-sereus` `networked.e2e` | 0 | 30 start → 30 complete | still fails |

So every cluster write now commits and `membership-not-admitted` is gone everywhere. The
remaining failures are the read side described above — `Failed to find materialized block
… for revision N`, then a `waitUntil` timeout. Nothing further can be done from this repo;
the ticket stays blocked on `selectQuorumRev`.

---

## Update 2026-07-29 — root cause found; it is neither of the earlier suspects

Traced end to end from a full `DEBUG='optimystic:*'` run with both earlier fixes active. The
mechanism is now known, with log evidence rather than inference.

### What was wrong with the earlier updates

- The 2026-07-27 update blamed `txn-perf-authoritative-notfound`. Retracted 2026-07-28.
- The 2026-07-28 update blamed read-repair revision selection. That defect was real and is now
  fixed upstream (`50af693`), but it was **not** why convergence failed. Read-repair was never on
  the critical path here.
- `cluster-fetch:synced { rev: 1 }` × 222, which drove both wrong diagnoses, turns out to be a
  **false positive**: `coordinator-repo.ts` logs that line unconditionally, whether or not
  anything was restored. It is not evidence of a sync, and never was.
- `default/CadrePeer` sitting at rev 1 is **correct**, not a symptom. It is the collection *header*
  block; it is only rewritten when the tree's root node id changes. Rows live in separate
  content-hashed tree blocks, and those did advance (rev 2–7).

### The actual mechanism

1. Node A creates the collection. `findCluster` reports `fretCohort=1 connected=1` — the peer
   connection is already up, but FRET's cohort for that key has not caught up. **Revision 1
   commits solo, on A only.** `block-storage commit blockId=default/CadrePeer` appears exactly
   once in 16,336 lines.
2. ~300 ms later FRET catches up (`fretCohort=2`).
3. A writes the row. Revision 2 is consensus-committed on **both** nodes.
4. B now holds revision 2 with **no revision 1 to apply it to**. `applyTransform(undefined, …)`
   returns `undefined`, so nothing is materialized — but `setLatest({rev: 2})` runs anyway.

B is now wedged on that block, three ways, all observed in the trace:

- **Cannot read it** — `Failed to find materialized block … for revision 2`.
- **Cannot serve it** — `buildArchive` returns undefined, so B contributes no claim. The
  `responders: 0` entries are B answering in 5 ms to say it has nothing, not a timeout.
- **Rejects later writes to it** — the throw happens inside `validatePendOperations`, producing
  `supermajority-failed { approvals: 1, superMajority: 2 }`.

And the reason this looked like "no rows" rather than an error: `Collection.createOrOpen` treats
a header it cannot fetch as a collection that does not exist, and **silently constructs a fresh
empty collection on every query**. The membership check returned "no members" indefinitely, with
no error and no log line.

### Where the work now sits

All upstream, all filed in `../optimystic` with the sereus trace attached:

- `bug-member-commits-unmaterializable-revision` (`implement/`) — the root cause. A member must
  obtain the base revision before committing, or refuse; `setLatest` must never advance past what
  the node can materialize. **In progress.**
- `collection-open-silently-invents-empty-collection` (`plan/`) — the silent-empty-table
  behavior that masked it.
- `bug-read-repair-unrepairable-small-cluster` — **fixed**, `50af693`.
- `clustersize-conflates-replication-factor-and-admission-yardstick` (`plan/`) — the dual-role
  `clusterSize` and its default of 10, filed from `optimystic-cluster-size-gate-defaults`.

The sereus-side half is done and shipped (`bug-cluster-size-exceeds-cadre-size`);
`membership-not-admitted` no longer appears. Nothing further is actionable in this repo until the
root-cause fix lands upstream.

### Open question, not yet answered

Why FRET reported `fretCohort=1` for the collection's key while `connected=1` and
`network-hwm-updated mark=2` had already been logged ~100 ms earlier. That is the race that
creates the solo revision 1 in the first place. Closing it would be defense in depth — the
upstream fix makes the race harmless rather than preventing it — but it is worth understanding,
since a solo creating-revision also means that revision briefly exists on exactly one node.
