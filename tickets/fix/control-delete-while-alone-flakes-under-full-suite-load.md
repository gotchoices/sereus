description: `control-delete-while-alone-convergence` failed in 2 of the last 4 full-suite runs, each time on a different test, and passed every isolated run (10 of 10). Find out which write loses its race, and whether a node that restarts alone can have a control write refused while nobody else is online.
files: packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core (removePeer, re-replication sweep on first cohort growth)
repro: full `yarn check` only. Isolated runs are 10 of 10 green (5 at optimystic 6d43b9f4, 5 at 1.0.0 / sereus 2d46e55e). Logs are in the tending session scratchpad (`gate-6d43b9f4.log`, `yarn-check-2d46e55e.log`).
----

# Delete-while-alone flakes under full-suite load

## Two failures, two fingerprints

**1. Full gate at optimystic `6d43b9f4` (2026-09-18 02:06).** The test was "converges a removePeer committed while alone, once the sibling reconnects". It failed at the precondition in `expectRemovalConverges` (line ~151):

```
expect(await B.isMember(ctx.xPeerId)).toBe(true)  → received false
```

B restarted alone and read a row it had converged before stopping as absent. This is the 2026-09-03 fingerprint (`.pre-existing-known.md`), which `control-network-peer-join-block-catch-up` was believed to have closed.

**2. `yarn check` at sereus `2d46e55e`, optimystic 1.0.0 (2026-09-18 ~15:00).** The test was "survives ANOTHER restart of the remover before any connection (first-growth sweep)". It took 18.4 s and failed with:

```
CoordinatorStaleLossError: Multi-collection commit lost a stale race for [default/cadrecontrol/CadrePeer, default/cadrecontrol/CadrePeer/index/_uniq_7.stampid, default/cadrecontrol/Revocation] — Pend failed for collection default/cadrecontrol/Revocation: stale conflict
 ❯ TransactionCoordinator.commitOnceLatched coordinator.ts:849 … TransactionBridge.commitBatchLegacy txn-bridge.ts:969 … Database._commitTransaction database.ts:831
```

The stack in the log is cut off above `Database._commitTransaction`, so the sereus call site (the test's `removePeer`, a sweep, or a self-record write) is not known.

## Questions

- In failure 2, A has no connections. Which rival makes `Revocation` stale? Candidates are A's own earlier write from before the restart, or two local writes racing: the first-growth sweep against the removal or a self-record update.
- Should a `CoordinatorStaleLossError` from a control write be retried by `control-write-retry`? A clean stale loss commits nothing, so it is safe to retry. Or does the retry exist and this call site bypass it?
- Does failure 1 share a cause with failure 2, or is the restart-alone read (the catch-up path) intermittently broken again?

## TODO

- Reproduce under load, for example by running this file alongside the control-write-degraded-cohort file or under CPU stress, with `DEBUG=sereus:cadre:control-db*,optimystic:db-p2p:storage-repo,optimystic:quereus-plugin:txn-bridge`, and capture the full stack of failure 2.
- Fix the cause. If the fix is a retry, add a unit test in `control-write-retry.spec.ts`.
- Update the 2026-09-18 delta in `tickets/.pre-existing-known.md`.
