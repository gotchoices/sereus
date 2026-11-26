description: One machine in a party is meant to keep a full copy of every strand the party runs. That copy can be left one version behind on some of the data for good, because the only thing that would deliver the newer version runs when a machine connects and never again while it stays connected.
architecture: docs/cadre/control-replication.md#catching-up-a-new-machine
files: packages/cadre-core/src/peer-join-backfill.ts (the trigger set — `peer:identify`, `scheduleConnectedPeers()`, `forceCatchUpPeer`; the per-peer `PeerMemo` and the `done` mark that drops identify churn for a connected peer), packages/cadre-core/src/strand-instance-manager.ts (~930-945 `backfillArms`; ~1118-1135 turns Optimystic's rebalance reaction off wherever the catch-up is armed), packages/integration-tests/src/scenarios/strand-moves-between-cadres.integration.ts (`expectReplicaOnM` ~line 366-395 — the failing wait, now instrumented), packages/integration-tests/src/harness/block-store-probe.ts (`awaitBlockCoverage`, `onGap`), ../optimystic/packages/db-p2p/src/repo/under-replication-drain.ts and owed-copies.ts (read-only: why a shortfall may never be recorded), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (read-only: read repair, the one path that would fix a stale replica — and a replica never reads)
difficulty: hard
----

## The failing test

`packages/integration-tests/src/scenarios/strand-moves-between-cadres.integration.ts` → "E2E an app's strands move between cadres > the other member keeps syncing and the new cadre's always-on machine hosts them".

The wait that failed is the block-coverage gate inside `expectReplicaOnM`, called at the scenario's step 5 for strand S: M, party A's always-on machine, must physically hold every block N holds for the strand it adopted.

```
Error: Timeout waiting for every block N holds for strand-move-s-1795718530582 lands in M's store after 60000ms
  — last coverage gap: behind: [H6XHLQQ2Lal9TcYqyK8NzSgGgBdeU2nCyO1Co03iH5k (source rev 5 > target rev 4),
                                pqxK2Zmy2-KedyxtCkaqyDxshJVAudeN6UyUo448KPE (source rev 5 > target rev 4)]
 ❯ src/harness/block-store-probe.ts:343:9
 ❯ awaitBlockCoverage src/harness/block-store-probe.ts:337:2
 ❯ expectReplicaOnM src/scenarios/strand-moves-between-cadres.integration.ts:375:2
```

The test reached 82 782 ms. Reported by the implement run of `optimystic-1-30-release-notes-and-fold`, whose diff is Markdown only.

## What the deadline measurement says

`tickets/.pre-existing-known.md` carried a 2026-10-15 `one-off` for the same scenario at a different wait — `rowArrives` at ~line 441, `Timeout waiting for P's new row on S reaches N in A after 90000ms` — and its confirm protocol asked that a recurrence be **measured** before any wait was raised. This triage did that. `expectReplicaOnM` now logs each change of gap shape with its elapsed time, and the total, which is the third bullet of `docs/contributing/testing.md` → "Asserting a quantity that has to travel between machines".

Measured at HEAD with freshly built deps (the suite's own `globalSetup` guard passed, so no sibling `dist` was stale):

| run | coverage closed in |
|---|---|
| the file alone | S 3 ms, T 2 ms, on the first poll |
| inside `--shard=4/6`, 14 files ahead of it | S 5 ms, T 3 ms, on the first poll |

Both closed on the **first poll** at a gap shape of "no gap": M already covered N before the test looked. So the 60 000 ms budget is not slightly short of what the step costs, it is four orders of magnitude clear of it. **Raising the wait is the wrong fix, and this measurement rules it out.** Per `docs/contributing/testing.md` → "A per-step deadline is a hang detector, not a budget", a 60 s wait on a 3 ms step is a hang detector doing its job: convergence genuinely did not happen.

## It is stuck, not slow — and there is a reproduction

**Reproduction.** Run the scenario file on its own while a second Vitest shard of the same suite runs concurrently, so the two runs contend:

```
# terminal 1, the load
yarn workspace @serfab/integration-tests run test --shard=5/6
# terminal 2, in a loop
yarn workspace @serfab/integration-tests run test src/scenarios/strand-moves-between-cadres.integration.ts
```

It is the contention that matters, not the file count: the suite sets `fileParallelism: false`, so 14 files ahead of this one in a shard put no load on it, and `--shard=4/6` in full stayed green (14 passed, 1 skipped) with coverage closing on the first poll. Against one concurrent shard, **2 of 6 attempts failed** (84 497 ms and 89 426 ms), each with the same two-blocks-behind-by-one gap as the report.

**The gap never moves.** In the failing run the instrumentation logged exactly one gap shape, at 4 ms — `behind: [… (source rev 5 > target rev 4), … (source rev 5 > target rev 4)]` — and never logged another in the remaining 59 996 ms. The replica is not catching up slowly; nothing is delivering rev 5 to it at all.

**What the same gap costs when it is delivered.** The next attempt passed, and strand T in it went through the identical shape — `behind: [… (source rev 4 > target rev 3), …]` at 1 ms — and closed at **529 ms**. So a behind-by-one replica normally converges in about half a second. The two outcomes are "half a second" and "never", with nothing in between, which is what a missed one-shot delivery looks like and not what a slow one looks like.

## Root cause

The catch-up's trigger set is keyed on the **connection**, never on the store. Nothing re-offers a block whose revision advances while the peer stays connected and is already marked caught up.

`peer-join-backfill.ts` is what fills the cohort-join catch-up Optimystic does not have ("Optimystic has no catch-up for a peer that joins a cluster after blocks were committed"). It runs on `peer:identify`, marks the peer `done`, and from then on **drops identify churn for a connected, caught-up peer before any work**. Its per-block skip rule is already correct for this case — a peer memoized at rev 4 is NOT skipped once the local block reaches rev 5 — so the push would carry the missing revision. Nothing schedules the run that would carry it.

Two DEBUG lines from a passing run (`DEBUG=sereus:cadre:peer-join-backfill,optimystic:db-p2p:under-replication-drain`) show the whole mechanism. The same peer, N's view of M's strand peer on S, early and late:

```
19:32:50.368 [strand-move-s-…] catch-up peer=…44RY offered=0 alreadyHeld=42 accepted=0 … done=true
19:33:15.781 [strand-move-s-…] catch-up peer=…44RY offered=2 alreadyHeld=42 accepted=2 … done=true
```

The second run is what delivers the two blocks the failing runs are missing — `offered=2`, exactly the pair whose revision advanced, accepted immediately. It happened only because connection churn scheduled another run for a peer that was already `done`. Remove that churn and nothing else offers those two blocks, which is the failing case: 42 blocks held at the right revision, two frozen one revision behind, no further gap change for 60 s.

The gap shapes on a healthy run say the same thing from the test's side. One passing attempt caught the whole sequence on strand T: `absent` for the entire store at 0 ms, then `behind` on exactly two blocks at 263 ms, then closed at 516 ms. Two pushes, not one — the store-wide catch-up, and then a second run carrying the pair the first was too early for. The two blocks are the app table's collection: `default/app/Data` and its content block, which is the collection the scenario's last write (`s-p-a`, `t-p-a`) advances.

**Nothing else covers the window on a replica.** Optimystic's rebalance reaction is off on every node where the catch-up is armed (`strand-instance-manager.ts` ~1131, `cadre-node.ts` ~2737). The under-replication drain pushes only what its ledger records as owed, and in the same run it reports an empty ledger:

```
19:33:13.261 under-replication-drain pass:done trigger=identify entries=0 examined=0 … pushed=0
```

`resolveOwedPeers` resolves owed peers from the commit's own cluster view, so a cohort member that was not in the cluster the writer resolved is never recorded as missing and there is no entry to drain. Read repair is the last path, and a storage replica runs no app and never reads. So the catch-up is the only delivery mechanism for this case, and its trigger set has a hole.

**Where the fix goes.** The change feed already carries what a targeted re-offer needs: `CollectionChangeEvent` (db-core `transactor/change-notifier.ts`) has `blockIds` and `rev`, and `CadreNodeConfig`'s `storageRepo.onAnyCollectionChange` is already wired for the first-sync gate and fires for every block that lands in the node's store, push or commit (`types.ts` ~line 63). Two shapes are worth weighing:

- **Targeted.** On a change event, offer exactly `event.blockIds` to each connected peer whose memo sits below `event.rev`. Cheapest and most precise, but it is a new offer path in a module whose only offer path today is store-wide (`runCatchUp` → `readOffer`).
- **Re-run the existing path.** Clear the `done` mark for connected peers and re-enter `scheduleConnectedPeers()`, or call the existing `forceCatchUpPeer`, which already runs past `done` and skips every block the peer is known to hold. Far smaller diff, but it lists the whole store and reads per-block metadata once per commit per peer — on the control network that is 110 blocks per commit in this scenario — so it needs real coalescing before it is acceptable.

Prefer the targeted shape unless measurement says the simpler one is free. Either way `done` must not be mutated directly: `forgetCaughtUp` owns the `inFlight` bookkeeping that goes with it.

**Also settle whether the assertion's source is a moving target.** `expectReplicaOnM` compares N's raw store against M's. N may hold rev 5 because it signed the commit, or because its own read of `s-p-a` pulled it in through `CoordinatorRepo.restoreCorroborated` — the confound `block-store-probe.ts`'s header warns every caller about. That does not explain the failure on its own, since the two outcomes are 529 ms and never, but it decides whether the scenario should also gate on M being in the strand's cohort before the final write. Settle it while the reproduction is in front of you.

## Expected

An always-on machine hosting a strand as a storage replica ends up physically holding every block the party's other machines hold for it, within a bounded time, whether or not it was in a block's resolved cluster when that block was committed. That is the promise in `docs/strands/lifecycle.md` → "No config, on a node that hosts unclaimed strands": an always-on machine keeps a copy of every strand its party runs. The scenario's 60 s wait then passes for the right reason.

## Design constraints

- **Sibling repos are read-only** (`tickets/rules/sibling-repos.md`). If the fix belongs in Optimystic — a cohort-join catch-up of its own, or recording a shortfall for a connected same-network peer outside the resolved cluster — this ticket's outcome is a `report-*` ticket in `tickets/blocked/` naming it, not an edit under `../optimystic`.
- **Do not raise the wait.** The measurement above is the reason: a 3 ms step behind a 60 s hang detector has no budget problem.
- **Do not weaken the assertion.** Coverage is physical-store evidence on purpose (`block-store-probe.ts` header, "WHY THIS EXISTS"): a cross-node `select` passes through the author's storage and proves nothing about the replica.
- **A new trigger must not reintroduce double-pushing.** The rebalance reaction is off precisely because the catch-up already pushes every block to every peer it serves, so a store-change trigger has to stay inside the existing per-peer memo, debounce and backoff rather than adding a second pusher — see `peer-join-backfill.ts` → "RETRY, and why it backs off", and its `maxBlocks` and `maxChunkBytes` budgets.
- **Both deadlines in that module are derived from the declared link round trip** rather than fixed milliseconds (`link-budget.ts`). Any new scheduling constant follows the same rule or it breaks relayed links.
- **The signal already exists.** `CadreNodeConfig`'s `storageRepo.onAnyCollectionChange` is wired for the first-sync gate and fires for every block that lands in the node's store, push or commit (`types.ts` ~line 63). Prefer it to a poll.
- **One home per fact.** The catch-up's trigger set is described in `docs/cadre/control-replication.md` → "Catching up a new machine" and in the module header; update both, and do not retell this diagnosis in the doc (`AGENTS.md` → Docs).

## Cross-cutting obligations

- None triggered: no determinism edition bump, byte-format vector, golden fixture or migration. Nothing here changes a persisted format, a signed payload or a schema, and a new `PeerJoinBackfillConfig` field would be additive config with a default.
- Validate against the reproduction above, not against one green run. It failed 2 of 6 contended attempts, so a fix needs a series — roughly fifteen contended runs with no failure — before it is believed. Uncontended runs prove nothing: the file alone and a full `--shard=4/6` were green throughout.
- The hole is in the catch-up's trigger set, which serves the CONTROL network as well as strands (`cadre-node.ts` arms the same module). A fix has to be right for both, and the control network's gate (`authorizePeer`) is consulted at push time on every run the new trigger adds.
- `tickets/.pre-existing-known.md` carries this signature as `in-flight` against this slug. Clear it when the fix lands.
