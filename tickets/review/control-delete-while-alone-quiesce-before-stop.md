description: The delete-while-alone convergence test used to shut its two nodes down while background replication and background writes were still running, so under load it sometimes restarted a node from half-finished storage; the test now waits for that work to finish first, and the investigation found a second, smaller-rate cause that still needs an upstream fix.
files: packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/cadre-core/src/control-write-retry.ts (NOTE on isFinalTornWrite, amended), tickets/blocked/forked-control-collection-sync-livelocks.md (Second trigger, 2026-09-18 update appended), tickets/.pre-existing-known.md (new Open delta)
difficulty: easy
----

# What changed

`removeWhileAlone` in `control-delete-while-alone-convergence.integration.ts` (shared setup for both tests in the file) now does two things it did not before, between the `isMember(X)` assertion that ends phase 1 and the phase-2 stops:

1. **Waits for the peer-join catch-up to physically land on B** before stopping anything: `await awaitBlockCoverage(storeA, storeB, {...})`, then asserts `default/cadrecontrol/CadrePeer` is in `readBlockIndex(storeB)`. This is the same gate `control-offline-read-after-restart.integration.ts` uses at its own phase 3. Without it, B could be stopped inside the 1 s debounce on the catch-up push (`peer-join-backfill.ts`), before its raw store held the blocks that the network-level `isMember` check does not prove are physically present (see the header comment on `harness/block-store-probe.ts` for why a cross-node read is not a storage proof).
2. **Stops A before B**, not B before A. `CadreNode.stop()`'s `cleanup()` stops the record-refresh/reconcile triggers and then closes the control database — which drains its write queue — before the control node's libp2p stops. Stopping A first means any control write A has in its commit phase (the observed case: its own `self-record-update`) finishes normally while B can still answer, instead of being torn when B leaves mid-commit.
3. Added (optional per the ticket, kept after measuring clean): after both stops, `compareBlockCoverage(storeA, storeB)` must still be complete — proving the write A drained during its own `stop()` actually reached B before B went down.

The file's header comment and the `removeWhileAlone` docstring were updated to describe the new order. `packages/cadre-core/src/control-write-retry.ts`'s `NOTE` on `isFinalTornWrite` was amended: it used to say "if control writes are seen abandoned on [`CoordinatorStaleLossError`], claim it here by type" — they have been now (see below), and the amended note explains why it is still not claimed (the failing attempt already outlasts the 10 s retry budget, and the refusal comes from the node's own storage, which retrying can't change).

Nothing in `cadre-core` production code changed besides that one comment.

# Validation performed

- `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/cadre-core build`, `yarn lint` — all clean.
- **Parallel load** (the reproducer for the original bug): 2 rounds of 6 concurrent processes running `control-delete-while-alone-convergence.integration.ts` alone (`npx vitest run …` × 6, backgrounded, `wait`) — **round 1: 5/6 passed** (one failure, see "Known gap" below); **round 2: 6/6 passed**. Logs: `tickets/.logs/quiesce-round{1,2}-run{1..6}.log`.
- **Isolated** (this repo's five-round bar): 5 separate single-process runs — **5/5 passed**. Logs: `tickets/.logs/quiesce-isolated-run{1..5}.log`.
- Total: **16 of 17 post-fix runs green**, versus the roughly 50% failure rate the investigation measured before the fix (the prior `fix/control-delete-while-alone-flakes-under-full-suite-load` ticket's own numbers: 6 of 12 failed under the same parallel load).
- An 8-way-parallel run with `DEBUG=sereus:cadre:*,optimystic:db-core:*,optimystic:db-p2p:storage-repo,optimystic:quereus-plugin:txn-bridge` (attempting to catch the one residual failure with detail) came back 8/8 green — the window is narrow enough that this did not help pin the exact interleaving.
- Note: mid-session, `../optimystic`'s own concurrent ticket runner was editing `packages/db-p2p/src/cluster/cluster-repo.ts` and briefly left it non-compiling; the stale-build guard caught it and a re-run of `yarn workspace @optimystic/db-p2p build` (in `../optimystic`, after their edit settled) cleared it. Not this ticket's concern, but worth knowing if the reviewer re-runs and hits the same guard.

# Known gap — a second, distinct cause of the same symptom, not fixed here

One of the 17 post-fix runs (round 1, run 1) failed with `CoordinatorStaleLossError: Multi-collection commit lost a stale race for [default/cadrecontrol/CadrePeer, default/cadrecontrol/CadrePeer/index/_uniq_7.stampid, default/cadrecontrol/Revocation] — Pend failed for collection default/cadrecontrol/CadrePeer: stale conflict`, thrown out of `A.removePeer(xPeerId)` in phase 3, ~21 s.

This is the **same fingerprint** as the "Second trigger" already tracked in `tickets/blocked/forked-control-collection-sync-livelocks.md`, but B was already fully stopped when this happened — which rules out that section's specific mechanism (a peer leaving while A's commit is in its commit phase). This fix closes that specific path; it does not close the underlying class (a lone node whose revision view disagrees with its own storage, with no way to move forward alone). I've appended a dated update to that ticket's "Second trigger" section with the measured data and a working hypothesis: `CadreNode.start()` unconditionally arms a ~1000 ms deferred self-registration timer (`scheduleSelfRegistration` → `registerSelf()`, a self-signed `CadrePeer` UPDATE) regardless of connectivity, and `removeWhileAlone` calls `A.removePeer(xPeerId)` within a few synchronous `await`s of the restart — under parallel-process CPU contention that gap can exceed 1000 ms, giving the deferred write a chance to land close to the foreground removal. Both go through `ControlDatabase.withWriteLock`, which is supposed to make this safe (a queued body re-reads fresh state), so if the hypothesis is right the bug is in that guarantee, not in call ordering — I did not confirm it directly (8 further DEBUG-enabled runs didn't reproduce it) and did not attempt a fix, since the mechanism is unconfirmed and any fix likely touches `cadre-core` or upstream `optimystic`, both out of this ticket's scope (test-choreography only).

Treat this as this repo's known intermittent for the scenario going forward — **do not re-file it**, it's already an arm on `forked-control-collection-sync-livelocks`. A recurrence of the OLD fingerprints (`isMember` false after restart, `Missing block … CadrePeer`) would be a genuine regression of this fix and should go through `tickets/.pre-existing-error.md`.

# Also updated

- `tickets/.pre-existing-known.md`: added a new dated entry in the "Open" section (top of file) describing the fix and the honest 16/17 rate, pointing at the blocked ticket's arm for the residual.

# Suggested review focus

- Confirm the phase-2 reordering (`await A.stop(); await B.stop();`) reads correctly against `CadreNode.stop()`'s actual teardown order in `cadre-core/src/cadre-node.ts` (`cleanup()`, ~line 4131 onward: record-refresh/reconcile stopped, then `controlBackfill.stop()`, then `controlDatabase.close()` — which drains the write queue — then `controlNode.stop()`). I read this in `cadre-core/src/cadre-node.ts:1188-1198` and `:4131-4260`; nothing there changed.
- Decide whether the optional post-stop `compareBlockCoverage` assertion (added per the ticket's "measure before keeping") is worth its cost — it passed cleanly in all 17 runs, so I kept it, but it is new coverage the ticket flagged as optional.
- Judge whether the residual self-registration-timer hypothesis is worth a deeper trace now, or should wait for whoever next re-measures the blocked ticket (I left explicit next-step guidance there: capture `DEBUG=sereus:cadre:node` under load and watch for a `registerSelf: refreshed own CadrePeer record` line landing within milliseconds of the `removePeer` call).
