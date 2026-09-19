description: The delete-while-alone convergence test used to shut its two nodes down while background replication and background writes were still running, so under load it sometimes restarted a node from half-finished storage; the test now waits for that work to finish first. A second, rarer cause of the same failure remains and is tracked on an existing blocked ticket.
files: packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/cadre-core/src/control-write-retry.ts, tickets/blocked/forked-control-collection-sync-livelocks.md, tickets/.pre-existing-known.md
----

# What landed

`removeWhileAlone` in `control-delete-while-alone-convergence.integration.ts` (setup shared by both tests) now:

- Waits for the peer-join catch-up to physically land on B's raw store (`awaitBlockCoverage(storeA, storeB)` plus an explicit `default/cadrecontrol/CadrePeer` presence check) before anything stops. This is the same gate `control-offline-read-after-restart` uses.
- Stops A before B. `CadreNode.stop()` → `cleanup()` closes the control database, which drains its write queue, before the control node's libp2p stops. So A's in-flight control writes finish while B can still answer, instead of being torn when B leaves.
- After both stops, asserts B's raw store still covers A's (`compareBlockCoverage`). This proves that whatever A drained during its stop reached B.

The only production-code change is a comment: the `NOTE` on `isFinalTornWrite` in `control-write-retry.ts` now explains why `CoordinatorStaleLossError` is still not claimed there.

Implement-pass validation: 16 of 17 runs passed (12 six-way-parallel, 5 isolated). Before the fix, about 50% of runs failed. The one failure had the `CoordinatorStaleLossError … stale conflict` fingerprint at `A.removePeer` while B was already down. That is a different path to the class already tracked in `tickets/blocked/forked-control-collection-sync-livelocks.md` → "Second trigger", and the implement pass added a dated update there with a hypothesis: the deferred self-registration timer races the foreground removal.

# Review findings

- **Diff read first, against the code it depends on.** I checked the teardown order the fix relies on against `cadre-core/src/cadre-node.ts` `cleanup()` (~4131–4262): `stopRecordRefresh()` → … → `controlBackfill.stop()` → `controlDatabase.close()` → `controlNode.stop()`. The handoff describes it correctly. `stop()` is idempotent (it early-returns when not running), so the `catch` path's `A.stop()` on an already-stopped A is safe. The assertion failing between `B.stop()` and `B = undefined` is also safe, because `finally`'s `B?.stop()` is a no-op there.
- **Correctness / resource cleanup:** nothing found. Every early exit still stops both nodes (see above).
- **Source hygiene (fixed inline):** the phase-2 inline comment repeated, in more words, the stop-order explanation that the function docstring and the file header already give. I cut it to the one reason that cannot be read from the code: `cleanup()` drains the write queue before libp2p stops.
- **DRY:** the catch-up gate duplicates the 5-line block in `control-offline-read-after-restart`. Only two call sites, each with a different list of required blocks, so I left it as is. Extracting a helper is not worth it yet.
- **Optional post-stop coverage assertion:** kept. It passed in all 17 implement runs and all 3 review runs. It also directly checks the claim the reorder depends on (A's drained write reached B). It costs one extra read of both in-memory stores.
- **Type safety / error handling / performance:** nothing found. There is no new `any`. Helpers come from the harness barrel. The added wait is bounded by `awaitBlockCoverage`'s default of 30 s.
- **Docs:** `docs/architecture.md` (the peer-join catch-up paragraph, and the delete-while-alone durability entry) still describes things accurately; neither mentions the test's stop order, and neither needs to. `docs/testing.md` does not mention this scenario. The blocked ticket and `.pre-existing-known.md` updates are accurate, and they point to where the residual cause is tracked.
- **Residual failure (self-registration timer hypothesis):** already tracked as an arm on `forked-control-collection-sync-livelocks`. I filed no new ticket. A deeper trace belongs to that ticket's next re-measure, and the next steps are written down there.
- **Tests run:** `yarn workspace @serfab/integration-tests typecheck` (exit 0), `yarn lint` (exit 0), and the scenario file three times as parallel processes: 3/3 passed, 2/2 tests each.
- **Tripwires / new tickets:** none.
