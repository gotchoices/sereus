description: The cadre-host test suites used to leave three fake node processes running after every run. Every test file that starts child processes now stops them through one shared teardown that fails the test if any process survives.
files:
  - packages/cadre-host/src/__tests__/orchestrator-teardown.ts (shared teardown helper `removeAllNodes`)
  - packages/cadre-host/src/__tests__/orchestrator.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-push.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-owner.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts
repro: verified
difficulty: easy
----

# cadre-host tests leave their fake child processes behind — complete

## What was built

Test code only; no product change. Implemented in `ticket(implement): debt-cadre-host-tests-leak-child-processes`.

- `packages/cadre-host/src/__tests__/orchestrator-teardown.ts` exports `removeAllNodes(orchestrators)`. For each orchestrator it walks `listNodes()` (the in-memory list, owner node included), records each node's container id and pid, and calls `removeContainer`, continuing past a throw. Any recorded pid still alive afterwards is killed with `SIGKILL` and the helper throws, naming the surviving container ids and pids and any `removeContainer` errors. The array is emptied in a `finally`.
- The six test files that start child processes share the same `afterEach`: `removeAllNodes(orchestrators)` in a `try`, with the 50 ms sleep, temp-directory removal and (env-scrub only) environment restore in the `finally`.
- The two leaks fixed: `orchestrator-push.test.ts` stopped only the owner node and never the two other nodes its last test starts; `orchestrator.test.ts` chose what to remove by reading `state.json`, which omits a node when two orchestrators share one root directory.

## Review findings

**Checked**

- Read the implement diff before the handoff. Read `listNodes`, `stopContainer`, `removeContainer`, `isHandleLive`, `isPidAlive` and `decodeDockerId` in the product code to confirm the helper's assumptions: `listNodes()` returns a copy, so removing while iterating is safe; `removeContainer` waits for the pid to die (SIGTERM, then SIGKILL with a 2 s wait) before returning, so the liveness check straight after it is not racing a normal shutdown; the owner node's id is a normal `pid:token`, so `decodeDockerId` does not throw on it.
- Every `new HostProcessOrchestrator` in the six files goes through a `makeOrchestrator` that pushes onto the `orchestrators` array, except the helper script in `child survives orchestrator exit`, which kills its own child in a `finally` (commented at the site).
- No other cadre-host test file starts orchestrator children (searched for `spawn(` and `HostProcessOrchestrator(` under `packages/cadre-host/src`).
- Removed helpers (`listDockerIds`) have no remaining references; the `StateStore`, `isPidAlive` and `decodeDockerId` imports left in the test files are all still used.
- **The failing path, which the implementer had not exercised.** Temporarily made the helper skip `removeContainer` and ran `orchestrator-push.test.ts`: all 6 tests failed with `test teardown left child processes running (now force-killed): storage-1 (pid …), txn-1 (pid …)` (and `owner (pid …)` for the owner tests), and no stray process remained afterwards. This also demonstrates that the original push-test leak (two non-owner nodes never stopped) is now caught. Edit reverted.
- `yarn workspace @serfab/cadre-host test`: 70 files passed, 667 tests passed, 4 skipped. `yarn workspace @serfab/cadre-host typecheck`: exit 0. `yarn lint`: exit 0. Node processes with a `Temp\cadre-host-` command line after the run: 0.
- Docs: `docs/testing.md` and `docs/cadre-host.md` do not describe these tests' teardown, so nothing there is out of date and nothing was added.

**Found and fixed in this pass (minor)**

- The plan-stage ticket `debt-host-process-orchestrator-untested` touches the same test files and did not mention the shared teardown. Appended a short section telling it to use `removeAllNodes` for any new test file.

**Tripwires**

- The survivor check is by pid alone, not by the startup token. If the operating system reuses a dead child's pid for an unrelated process before the check, that process is reported and killed. Parked as a `NOTE:` in `orchestrator-teardown.ts` at the survivor check.
- The helper only sees nodes the orchestrator still holds in memory. A child whose record the orchestrator has dropped (a re-spawn over a stale record) would not be seen. No current test leaves one — the stray count after a full run is 0 — so no change; the stray count is the check to repeat if leaks reappear.
- A `removeContainer` error with no surviving process is dropped, so a regression that made `removeContainer` throw for an already-removed node (the two-orchestrators-over-one-directory case) would not fail these teardowns. Deliberate per the original ticket; tests of `removeContainer` itself are the place for that, not teardown.
- No `afterEach` came near vitest's 10 s hook timeout here. On a slower machine the file to watch is `orchestrator.test.ts` (up to three nodes removed in sequence).

**Major findings / new tickets**

None. The change is small, test-only, and the one unverified claim (the failing path) held when exercised.

**Not reproduced**

- The implementer's one-off import failure (`UNKNOWN: unknown error, open …\cadre-core\dist\canonical-datetime.js` in three files on the first of three runs) did not occur in this pass's full run. Not filed as a pre-existing failure: still not reproducible, cause unknown.

**Tests added or cut**

None added: the assertion inside the shared `afterEach` runs after every test in the six files, and its failing path was confirmed by hand above. None cut: the diff added no tests.
