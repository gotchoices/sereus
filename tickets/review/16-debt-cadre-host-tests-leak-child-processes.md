description: The cadre-host test suites used to leave three fake node processes running after every run. Every test file that starts child processes now stops them through one shared teardown that fails the test if any process survives.
files:
  - packages/cadre-host/src/__tests__/orchestrator-teardown.ts (new — shared teardown helper `removeAllNodes`)
  - packages/cadre-host/src/__tests__/orchestrator.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-push.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-owner.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (read only — `listNodes`, `removeContainer`; no product change)
repro: verified
difficulty: easy
----

# cadre-host tests leave their fake child processes behind — implemented

## What changed

Test code only; no product change.

- New `packages/cadre-host/src/__tests__/orchestrator-teardown.ts` exports `removeAllNodes(orchestrators)`. For each orchestrator it walks `orch.listNodes()` (the in-memory list, which includes the owner node), records each node's container id and pid, and calls `removeContainer`. A throw from `removeContainer` is kept and the sweep continues. Afterwards, any recorded pid that `isPidAlive` still reports alive is killed with `SIGKILL` (ignoring `ESRCH`) and the helper throws an error naming the surviving container ids and pids plus any kept `removeContainer` errors. A `removeContainer` error with no surviving process does not fail the test. The array is emptied in a `finally`.
- All six test files that start child processes now have the same `afterEach`: `removeAllNodes(orchestrators)` in a `try`, with the existing `sleep(50)`, temp-directory `rmSync`, and (env-scrub only) environment restore in the `finally`.
- The two leaks this fixes: `orchestrator-push.test.ts` only called `stopOwnerNode()` and never stopped the two non-owner nodes its last test starts; `orchestrator.test.ts` chose what to remove by reading `state.json`, which omits a node when two orchestrators share one root directory.
- Removed the `listDockerIds` helpers from `orchestrator.test.ts` and `orchestrator-owner.test.ts`. Both files still use `StateStore` in test bodies, so that import stays.
- Added a one-line comment at the `finally` of `child survives orchestrator exit`: that child is started by a separate helper process, so no orchestrator in the test holds it and the shared teardown cannot see it.

## Tests added

None. The assertion inside the shared `afterEach` runs after every existing test in the six files and is the guard.

## Validation performed

- Stray count before any change (node processes whose command line matches `Temp\cadre-host-(orch|push)-<rand>\fake-(child|cli).mjs`): 117. No strays under any other `Temp\cadre-host-` prefix.
- `yarn workspace @serfab/cadre-host test` run three times. Stray count after the runs: 117, and no process outside the recorded pid list — the runs added none.
  - Runs 2 and 3: 70 files passed, 667 tests passed, 4 skipped.
  - Run 1: 3 files failed at import, before any test ran (`orchestrator-env-scrub.test.ts`, `orchestrator-pin-keys.test.ts`, `server/__tests__/grants-route.test.ts`), all with `Error: UNKNOWN: unknown error, open 'C:\projects\sereus\packages\cadre-core\dist\canonical-datetime.js'`. It did not recur in the next two runs. I did not find the cause; a file being briefly locked or rewritten by another process is a guess, not a finding. Not filed as a pre-existing failure because it was not reproducible. `grants-route.test.ts` is not touched by this ticket.
- `yarn workspace @serfab/cadre-host typecheck`: exit 0. `yarn lint`: exit 0.
- One-off cleanup: killed all 117 of the recorded pre-existing strays (matched again by pid and command line at kill time); 0 remain. Their temp directories were left in place.

## Things for the reviewer to check

- **The failing path of the helper was never exercised.** No test makes a child survive `removeContainer`, so the force-kill and the error message are verified by reading only. A quick manual check: temporarily revert one file's `afterEach` to not remove a node, or make the helper skip `removeContainer`, and confirm the test fails with the container id and pid and that the process is gone afterwards.
- **Whether the old leaks would have been caught** was likewise not demonstrated by a failing run; the evidence is that the stray count no longer grows (it grew by three per run before).
- **Hook timeout.** No `afterEach` came near vitest's 10 s hook timeout on this Windows machine in three runs, so no explicit timeout was added. On a slower machine, the file to watch is `orchestrator.test.ts` (up to three nodes removed in sequence).
- **Two orchestrators over one root directory.** The second orchestrator's `removeContainer` runs for nodes the first already removed (dead pid, missing working directory) and succeeds; the two-orchestrator tests pass. If `removeContainer` ever starts throwing for that case, the helper still passes as long as no process survives, and the error is dropped — deliberate per the ticket, but it does mean such a regression would be silent here.
- The ticket `debt-host-process-orchestrator-untested` (plan stage, same test files) should use `removeAllNodes` rather than a new teardown.
