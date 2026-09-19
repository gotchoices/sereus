description: The delete-while-alone convergence test shuts its two nodes down while background replication and background writes are still running, so under load it sometimes restarts a node from half-finished storage. Make the test wait for that work to finish before shutting down, and record what the investigation found.
prereq:
files: packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts (the pattern to copy), packages/integration-tests/src/harness/block-store-probe.ts (awaitBlockCoverage, readBlockIndex, compareBlockCoverage), packages/cadre-core/src/control-write-retry.ts (the NOTE on isFinalTornWrite), packages/cadre-core/src/cadre-node.ts (cleanup, ~line 1300: stop drains the control write queue before stopping libp2p), tickets/.pre-existing-known.md, tickets/blocked/forked-control-collection-sync-livelocks.md
difficulty: easy
repro: verified
----

# Quiesce before stopping in the delete-while-alone scenario

## What was measured

The full-suite failures reproduce without the full suite. Running the file 6 times in parallel, twice (12 runs, with `DEBUG=sereus:cadre:*,optimystic:db-core:*,optimystic:db-p2p:storage-repo,optimystic:quereus-plugin:txn-bridge`), failed 6 of 12. Every failure was in whichever test ran first in its process. There were three fingerprints, from two causes. Both causes are the test stopping nodes while background work is still running. Neither is a product regression.

| runs | fingerprint | cause |
| --- | --- | --- |
| 3 | `expect(await B.isMember(X)).toBe(true)` false after B restarts alone (the optimystic `6d43b9f4` gate failure) | 1 |
| 1 | `Missing block (…)` reading `CadrePeer` on B | 1 |
| 2 | `CoordinatorStaleLossError … stale conflict` from A's `removePeer` after about 20 s (the sereus `2d46e55e` `yarn check` failure, there on `Revocation`) | 2 |

**Cause 1: B is stopped before A's peer-join catch-up reaches it.** The catch-up push (`peer-join-backfill.ts`) is debounced 1 s after `connection:open`. Phase 1 can reach `B.stop()` in under a second, because `waitForCadrePeerConverged` passes on reads B makes through A over the network, which say nothing about what B's own store holds (see the header comment in `block-store-probe.ts`). In 4 of the 5 runs where the catch-up line (`catch-up peer=… offered=15 accepted=15 … done=true`) did not appear before the first stop, test 1 failed with `isMember` false or a missing block. The fifth passed, because B happened to hold the blocks as a cohort member. In all 7 runs where it did appear, this fingerprint never occurred. This is the 2026-09-03 root cause (B never holds the `CadrePeer` header). The catch-up fixed it, and this test was never changed to wait for the catch-up.

**Cause 2: B is stopped while A has a control write in its commit phase.** A starts background writes after connecting: `self-record-update` from `registerSelf` on `self:peer:update`, and the ledger marker from the reconcile pass. In both stale-loss runs, A's `self-record-update` had pended on both stores and was committing when the test stopped B. The cancel could not reach B (`WARN: cancel after failed commit did not discharge`), so A's storage kept part of that write. When A restarted alone, its `removePeer` pended CadrePeer at rev 5, and its own storage refused it with `stale conflict` on every re-drive for about 14 s. The upstream half of this (a node alone cannot get past a torn commit in its own storage) is now an arm of `blocked/forked-control-collection-sync-livelocks`, "Second trigger".

**The retry question in the fix ticket.** Should `control-write-retry` claim `CoordinatorStaleLossError`? Not on this evidence. The one failing attempt ran about 14 s, which is past the 10 s `CONTROL_WRITE_RETRY_BUDGET_MS`, so the loop would not have retried. The refusal also comes from A's own storage, which does not change while A is alone. The `NOTE:` on `isFinalTornWrite` says to claim it "if control writes are seen abandoned on it". They now have been, so amend that NOTE to say why it is still not claimed.

## The change

In `removeWhileAlone`, between the `isMember(X)` assertion at the end of phase 1 and the stops in phase 2:

- Wait for B's raw store to cover A's: `await awaitBlockCoverage(storeA, storeB, { description: "peer-join catch-up covers B's raw control store" })`. `storeA` and `storeB` are already the raw `MemoryRawStorage` instances. This is the gate `control-offline-read-after-restart.integration.ts` uses at its phase 3. Also assert the `default/cadrecontrol/CadrePeer` header is in `readBlockIndex(storeB)`, as that file does, so a regression names the block this test depends on.
- Stop **A first, then B**. `CadreNode.stop()` → `cleanup()` stops the record-refresh and reconcile triggers and then `ControlDatabase.close()` drains the write queue, all before libp2p stops. So any write A has in flight finishes while B can still answer, instead of being torn. B (a `transaction`-profile node with no owner key) issues no control writes, so it has nothing to tear when it stops second. A still restarts with B down, which is all phases 2 and 3 need. Update the phase comments and the file header ("B goes DOWN, then A restarts…") to match the new order.
- Optional, measure before keeping: after both stops, assert `compareBlockCoverage(storeA, storeB)` is complete once more. A write that A drained on stop commits to both stores, so this should hold. If it flakes, that is a replication finding and should not be loosened.

Nothing in cadre-core changes except the comment. This does not loosen the test (see "Do not" in the blocked ticket): what it asserts is unchanged, and it stops creating a state the test never meant to cover. The torn-commit shape is recorded upstream with a reproduction recipe.

## Validation

- Before the change: the parallel load harness reproduces at about 50%. From `packages/integration-tests`, run 6 copies of `npx vitest run src/scenarios/control-delete-while-alone-convergence.integration.ts` concurrently, each to its own `tickets/.logs/` file, then `wait`. Two such rounds is enough.
- After the change: the same two rounds must be 12 of 12 green. Then run 5 isolated rounds, per this repo's five-round bar.
- `yarn workspace @serfab/integration-tests typecheck` and `yarn lint`.

## TODO

- Add the coverage gate and header-block assertion before the stops in `removeWhileAlone`, reusing `awaitBlockCoverage` / `readBlockIndex` from the harness.
- Reorder phase 2 to stop A before B; update the phase comments and the file's header comment.
- Measure the optional post-stop coverage assertion; keep it if the load rounds stay green.
- Amend the `NOTE:` on `isFinalTornWrite` in `packages/cadre-core/src/control-write-retry.ts`: `CoordinatorStaleLossError` was seen abandoning a control write (2026-09-18, delete-while-alone); not claimed because the failing attempt outlasted the budget, and the cause (a torn commit in the node's own storage while alone) is not something a re-drive fixes. Point at the blocked ticket's "Second trigger".
- Run the parallel load rounds and the five isolated rounds; record the counts in the review handoff.
- Update `tickets/.pre-existing-known.md`: the 2026-09-18 delta line about `control-delete-while-alone-convergence` ("load-sensitive, not a regression"), and the open entry that points this file at `forked-control-collection-sync-livelocks`. Both causes are now identified as test choreography and fixed here; the upstream torn-commit shape lives in the blocked ticket's "Second trigger" arm.
